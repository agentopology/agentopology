/**
 * Caps that stop: `max-subagents`, `timeout` and `max-cost`.
 *
 * - max-subagents: SubagentStart and SubagentStop hooks log, and a PreToolUse
 *   hook on Agent|Task refuses a launch when the agent already has N open.
 * - timeout: a PreToolUse hook in the agent's own frontmatter refuses every
 *   tool call once the agent has run longer than its timeout.
 * - max-cost: not enforced (a hook payload carries no spend). validate warns;
 *   the value is written to the metering output.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { claudeCodeBinding } from "../claude-code.js";

const topo = (agentFields: string, metering = "") => `topology t : [pipeline] {
  meta {
    version: "1.0.0"
    description: "x"
  }
  orchestrator {
    model: opus
    handles: [intake]
  }
  action intake {
    kind: inline
    description: "in"
  }
  agent lead {
    model: sonnet
    description: "Leads"
    ${agentFields}
    prompt { Lead. }
  }
  agent worker {
    model: sonnet
    description: "Works"
    prompt { Work. }
  }
  flow {
    intake -> lead
    lead -> worker
  }
  ${metering}
}`;

const SCRIPTS = ".claude/skills/t/scripts";
const meterBlock = (line: string) => `metering {
    track: [cost]
    per: [agent]
    output: "metrics.jsonl"
    format: jsonl
    pricing: anthropic-current
    ${line}
  }`;

let root: string;
const at = (p: string) => join(root, p);

function write(src: string) {
  const ast = parse(src);
  for (const f of claudeCodeBinding.scaffold(ast)) {
    fs.mkdirSync(dirname(at(f.path)), { recursive: true });
    fs.writeFileSync(at(f.path), f.content);
  }
  return ast;
}
function run(script: string, input: unknown) {
  return spawnSync("bash", [at(`${SCRIPTS}/${script}`)], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
  });
}
const start = (session: string, id: string, type = "worker") =>
  run("caps-log.sh", { session_id: session, hook_event_name: "SubagentStart", agent_id: id, agent_type: type });
const stop = (session: string, id: string, type = "worker") =>
  run("caps-log.sh", { session_id: session, hook_event_name: "SubagentStop", agent_id: id, agent_type: type });
const launch = (session: string, from = "lead") =>
  run("max-subagents.sh", { session_id: session, hook_event_name: "PreToolUse", agent_type: from, tool_name: "Agent", tool_input: { subagent_type: "worker" } });

beforeEach(() => { root = fs.mkdtempSync(join(os.tmpdir(), "at-caps-")); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("caps: parse", () => {
  it("reads max-subagents and max-cost on an agent, and max-cost or cap in metering", () => {
    const ast = parse(topo("max-subagents: 3\n    max-cost: 1.5", meterBlock("max-cost: 5")));
    const lead = ast.nodes.find((n) => n.id === "lead") as any;
    expect(lead.maxSubagents).toBe(3);
    expect(lead.maxCost).toBe(1.5);
    expect(ast.metering?.maxCost).toBe(5);
    expect(parse(topo("", meterBlock("cap: 7"))).metering?.maxCost).toBe(7);
  });
});

describe("caps: validate", () => {
  const v = (fields: string, m = "") => validate(parse(topo(fields, m)));
  it("max-subagents that is not a positive integer is an error", () => {
    for (const bad of ["0", "-1", "2.5", "many"]) {
      const r = v(`max-subagents: ${bad}`).filter((x) => x.rule === "V156" && x.level === "error");
      expect(r.length, bad).toBe(1);
      expect(r[0].message).toContain("max-subagents");
    }
    expect(v("max-subagents: 2").filter((x) => x.rule === "V156")).toEqual([]);
  });
  it("a timeout that is not a duration is an error", () => {
    expect(v('timeout: soon').some((x) => x.level === "error" && /timeout/.test(x.message))).toBe(true);
    expect(v('timeout: 5m').some((x) => x.level === "error")).toBe(false);
  });
  it("max-cost is a warning that says it is advisory, on an agent and in metering", () => {
    const a = v("max-cost: 2").filter((x) => x.rule === "V156" && x.level === "warning");
    expect(a).toHaveLength(1);
    expect(a[0].message).toContain("max-cost is advisory, not enforced: Claude Code hooks do not see spend; it is written to the metering output for reporting");
    const m = v("", meterBlock("max-cost: 5")).filter((x) => x.rule === "V156" && x.level === "warning");
    expect(m).toHaveLength(1);
    expect(v("", meterBlock("cap: 5")).filter((x) => x.rule === "V156" && x.level === "warning")).toHaveLength(1);
  });
  it("metering { cap: 5 } validates as the max-cost alias: no V102, and the advisory warning", () => {
    const r = v("", meterBlock("cap: 5"));
    expect(r.filter((x) => x.rule === "V102")).toEqual([]);
    expect(r.filter((x) => x.level === "error")).toEqual([]);
    const w = r.filter((x) => x.rule === "V156" && x.level === "warning");
    expect(w).toHaveLength(1);
    expect(w[0].message).toContain("max-cost is advisory, not enforced");
  });
  it("a max-cost that is not a positive number is an error", () => {
    expect(v("max-cost: lots").some((x) => x.rule === "V156" && x.level === "error")).toBe(true);
    expect(v("max-cost: 0").some((x) => x.rule === "V156" && x.level === "error")).toBe(true);
  });
  it("a topology with no caps gets no V156", () => {
    expect(v("").filter((x) => x.rule === "V156")).toEqual([]);
  });
});

describe("caps: generated hooks", () => {
  it("writes SubagentStart/SubagentStop log hooks and a PreToolUse hook on Agent|Task", () => {
    write(topo("max-subagents: 2"));
    const s = JSON.parse(fs.readFileSync(at(".claude/settings.json"), "utf8"));
    for (const ev of ["SubagentStart", "SubagentStop"]) {
      expect(JSON.stringify(s.hooks[ev])).toContain("caps-log.sh");
    }
    const pre = s.hooks.PreToolUse.find((e: any) => JSON.stringify(e).includes("max-subagents.sh"));
    expect(pre.matcher).toBe("Agent|Task");
    expect(pre.hooks[0].onFailure).toBe("block");
  });
  it("writes nothing for a topology with no caps", () => {
    const files = claudeCodeBinding.scaffold(parse(topo("")));
    expect(files.some((f) => /caps-log|max-subagents|timeout\.sh/.test(f.path))).toBe(false);
  });
  it("writes a PreToolUse timeout hook into the agent's own frontmatter", () => {
    const files = claudeCodeBinding.scaffold(parse(topo('timeout: 10m')));
    const agent = files.find((f) => f.path === ".claude/agents/lead/AGENT.md")!;
    expect(agent.content).toMatch(/hooks:\n\s+PreToolUse:/);
    expect(agent.content).toContain("lead-timeout.sh");
    expect(files.some((f) => f.path === `${SCRIPTS}/lead-timeout.sh`)).toBe(true);
    expect(files.some((f) => f.path === `${SCRIPTS}/caps-log.sh`)).toBe(true);
  });
  it("writes max-cost into the metering output and says it is advisory", () => {
    const files = claudeCodeBinding.scaffold(parse(topo("max-cost: 2", meterBlock("max-cost: 5"))));
    const m = files.find((f) => f.path === "scripts/collect-metrics.sh")!;
    expect(m.content).toContain("Max cost: 5");
    expect(m.content).toContain("lead=2");
    expect(m.content).toMatch(/advisory/);
    const all = files.map((f) => f.content).join("\n");
    expect(all).not.toMatch(/max-cost[^\n]*(enforced by|refuses)/);
  });
});

describe("caps: max-subagents.sh", () => {
  beforeEach(() => { write(topo("max-subagents: 2")); });
  it("allows a launch below the cap and refuses at the cap, naming it", () => {
    start("s1", "a1");
    expect(launch("s1").status).toBe(0);
    start("s1", "a2");
    const r = launch("s1");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("max-subagents");
    expect(r.stderr).toContain("2");
  });
  it("counts only open subagents: a stop frees a slot", () => {
    start("s1", "a1"); start("s1", "a2");
    expect(launch("s1").status).toBe(2);
    stop("s1", "a1");
    expect(launch("s1").status).toBe(0);
  });
  it("counts per session", () => {
    start("s1", "a1"); start("s1", "a2");
    expect(launch("s2").status).toBe(0);
  });
  it("does not limit an agent that has no cap", () => {
    start("s1", "a1"); start("s1", "a2"); start("s1", "a3");
    expect(launch("s1", "worker").status).toBe(0);
  });
  it("blocks on input that is not JSON", () => {
    const r = spawnSync("bash", [at(`${SCRIPTS}/max-subagents.sh`)], { input: "nope", encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
    expect(r.status).toBe(2);
  });
});

describe("caps: lead-timeout.sh", () => {
  beforeEach(() => { write(topo('timeout: 10m')); });
  const call = (id: string) => run("lead-timeout.sh", { session_id: "s1", agent_id: id, agent_type: "lead", hook_event_name: "PreToolUse", tool_name: "Read", tool_input: {} });
  const logStart = (id: string, ts: number) => {
    fs.mkdirSync(at(".claude/state"), { recursive: true });
    fs.appendFileSync(at(".claude/state/subagents.jsonl"), JSON.stringify({ event: "SubagentStart", session_id: "s1", agent_id: id, agent_type: "lead", ts }) + "\n");
  };
  const now = () => Math.floor(Date.now() / 1000);
  it("allows a call inside the timeout", () => {
    logStart("a1", now() - 60);
    expect(call("a1").status).toBe(0);
  });
  it("refuses every call after the timeout, naming it", () => {
    logStart("a1", now() - 601);
    const r = call("a1");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("lead");
    expect(r.stderr).toContain("10m");
  });
  it("times each agent run from its own start", () => {
    logStart("a1", now() - 601);
    logStart("a2", now() - 5);
    expect(call("a2").status).toBe(0);
  });
  it("lets a call with no recorded start through", () => {
    expect(call("zz").status).toBe(0);
  });
  it("end to end: the log script writes the start the timeout script reads", () => {
    run("caps-log.sh", { session_id: "s1", hook_event_name: "SubagentStart", agent_id: "a9", agent_type: "lead" });
    expect(call("a9").status).toBe(0);
  });
});
