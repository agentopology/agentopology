/**
 * Independence is flagged, not enforced. An agent with `independent: true` is
 * judged by a gate with `by: <agent id>`. The generated before-agent hook logs
 * every launch to logs/launches.jsonl, and when the judge is launched in a
 * session whose log also shows the agent whose work it judges, it warns on
 * stderr and appends a not-independent line to logs/independence.jsonl, but
 * exits 0. validate says so, and guard --check counts the flags.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { join, dirname } from "node:path";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import { checkGuards, renderGuardReport } from "../../guard/check.js";
import { independenceLines } from "../../guard/independence.js";

const hasJq = spawnSync("/bin/sh", ["-c", "command -v jq"]).status === 0;

const topo = (gate: string) => `topology review-flow : [pipeline] {
  meta {
    version: "1.0.0"
    description: "author then judge"
  }
  orchestrator {
    model: sonnet
    handles: [author, judge]
  }
  agent author {
    model: sonnet
    description: "Writes the draft"
    tools: [Read, Write]
  }
  agent judge {
    model: sonnet
    description: "Judges the draft"
    runs: subagent
    independent: true
    tools: [Read]
  }
  gates {
    gate judged {
      after: author
      before: judge
${gate}
    }
  }
  flow { author -> judge }
}
`;
const GOOD = `      by: judge
      run: "scripts/judged.sh"
      on-fail: halt`;

const rules = (src: string, rule: string) => validate(parse(src)).filter((r) => r.rule === rule);

describe("validation", () => {
  it("accepts by: naming a declared agent", () => {
    expect(validate(parse(topo(GOOD))).filter((r) => r.level === "error")).toEqual([]);
  });

  it("by: naming no declared agent is an error", () => {
    const r = validate(parse(topo(GOOD.replace("by: judge", "by: ghost")))).filter((x) => x.level === "error");
    expect(r.length).toBeGreaterThan(0);
    expect(r.map((x) => x.message).join("\n")).toContain("ghost");
  });

  it("by: equal to the gate's after: agent is an error (V137)", () => {
    const r = rules(topo(GOOD.replace("by: judge", "by: author")), "V137");
    expect(r).toHaveLength(1);
    expect(r[0].level).toBe("error");
    expect(r[0].message).toContain("author");
  });

  it("a mechanism word in by: is still fine and is not read as a judge", () => {
    const src = topo(GOOD.replace("by: judge", "by: hook"));
    expect(validate(parse(src)).filter((r) => r.level === "error")).toEqual([]);
  });
});

describe("validate prints one line per independent agent", () => {
  it("says independence is flagged, not enforced", () => {
    const lines = independenceLines(parse(topo(GOOD)));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("judge");
    expect(lines[0]).toContain("independence is flagged, not enforced");
  });
  it("prints nothing when no agent is independent", () => {
    expect(independenceLines(parse(topo(GOOD).replace("independent: true", "")))).toEqual([]);
  });
});

describe.skipIf(!hasJq)("the generated before-agent hook", () => {
  let root: string;
  const SCRIPT = ".claude/skills/review-flow/scripts/before-agent.sh";
  const ast = parse(topo(GOOD));
  beforeEach(() => {
    root = fs.mkdtempSync(join(os.tmpdir(), "at-indep-"));
    for (const f of claudeCodeBinding.scaffold(ast)) {
      fs.mkdirSync(dirname(join(root, f.path)), { recursive: true });
      fs.writeFileSync(join(root, f.path), f.content, { mode: f.executable ? 0o755 : 0o644 });
    }
    // the gate's own script passes, so only the independence flag is under test
    fs.writeFileSync(join(root, ".claude/skills/review-flow/scripts/judged.sh"), "#!/usr/bin/env bash\nexit 0\n");
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const launch = (agent: string, session: string) =>
    spawnSync("bash", [join(root, SCRIPT)], {
      cwd: root,
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
      input: JSON.stringify({ session_id: session, tool_name: "Agent", tool_input: { subagent_type: agent } }),
      encoding: "utf8",
    });
  const lines = (p: string) =>
    fs.existsSync(join(root, p)) ? fs.readFileSync(join(root, p), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];

  it("is registered, and logs every launch with session_id, agent and ts", () => {
    expect(claudeCodeBinding.scaffold(ast).some((f) => f.path.endsWith("settings.json") && f.content.includes("before-agent.sh"))).toBe(true);
    expect(launch("author", "s1").status).toBe(0);
    const log = lines("logs/launches.jsonl");
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ session_id: "s1", agent: "author" });
    expect(typeof log[0].ts).toBe("string");
  });

  it("launching the judge after the author in one session flags it, warns on stderr, and still exits 0", () => {
    launch("author", "s1");
    const r = launch("judge", "s1");
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("not-independent");
    const flags = lines("logs/independence.jsonl");
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ flag: "not-independent", session_id: "s1", agent: "judge", judges: "author" });
  });

  it("the judge in a different session from the author is not flagged", () => {
    launch("author", "s1");
    const r = launch("judge", "s2");
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("not-independent");
    expect(lines("logs/independence.jsonl")).toEqual([]);
  });

  it("the judge alone is not flagged", () => {
    expect(launch("judge", "s1").status).toBe(0);
    expect(lines("logs/independence.jsonl")).toEqual([]);
  });

  it("guard --check shows the flag count", () => {
    expect(renderGuardReport(checkGuards(ast, root)).join("\n")).toContain("0 independence flags");
    launch("author", "s1");
    launch("judge", "s1");
    const report = checkGuards(ast, root);
    expect((report as { independenceFlags?: number }).independenceFlags).toBe(1);
    expect(renderGuardReport(report).join("\n")).toContain("1 independence flag");
  });
});
