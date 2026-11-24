/**
 * S-206: `wall-time: <duration>` on the ENTRY agent only (`meta { entry }`).
 *
 * A SessionStart hook (wall-start.sh) records the session's start time in a state file; a PreToolUse guard
 * (wall-time.sh, every tool) refuses every tool call once the elapsed time passes the cap, with a reason
 * naming the cap. V159 refuses the field on any agent but the entry (`timeout` stays the subagents' field).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import { serializeAST as serialize } from "../../import/serializer.js";

const hasJq = spawnSync("/bin/sh", ["-c", "command -v jq"]).status === 0;

function src(lead = '    wall-time: 4h\n', worker = "", entry = "lead"): string {
  return `topology walled : [pipeline] {
  meta {
    version: "0.1.0"
    description: "A wall-time cap on the entry agent"
${entry ? `    entry: ${entry}\n` : ""}  }
  agent lead {
    model: opus
    description: "Leads"
${lead}  }
  agent worker {
    model: sonnet
    description: "Works"
${worker}  }
  flow {
    lead -> worker
  }
}
`;
}

const SCRIPTS = ".claude/skills/walled/scripts";
let root: string;
const at = (p: string) => join(root, p);

function scaffold(s = src()) {
  const files = claudeCodeBinding.scaffold(parse(s));
  for (const f of files) {
    fs.mkdirSync(dirname(at(f.path)), { recursive: true });
    fs.writeFileSync(at(f.path), f.content);
    if (f.executable || f.path.endsWith(".sh")) fs.chmodSync(at(f.path), 0o755);
  }
  fs.mkdirSync(at("work/deep"), { recursive: true });
  return files;
}

const T0 = 1_800_000_000;
function run(command: string, stdin: string, now = T0) {
  const base: Record<string, string | undefined> = { ...process.env, CLAUDE_PROJECT_DIR: root, AGENTOPOLOGY_TEST: "1", AT_NOW: String(now) };
  delete base.AT_SESSION;
  return spawnSync("/bin/sh", ["-c", command], { cwd: at("work/deep"), input: stdin, env: base as NodeJS.ProcessEnv, encoding: "utf8", timeout: 20_000 });
}
function hookCmd(event: string, script: string): string {
  const settings = JSON.parse(fs.readFileSync(at(".claude/settings.json"), "utf8"));
  const e = (settings.hooks?.[event] ?? []).find((x: any) => x.hooks.some((h: any) => h.command.includes(script)));
  expect(e, `a ${event} entry for ${script}`).toBeTruthy();
  return e.hooks.find((h: any) => h.command.includes(script)).command;
}
const start = (now = T0, sid = "s1", source = "startup") => run(hookCmd("SessionStart", "wall-start.sh"), JSON.stringify({ session_id: sid, hook_event_name: "SessionStart", source }), now);
const tool = (tool_name: string, tool_input: Record<string, unknown>, sid = "s1", extra: Record<string, unknown> = {}) =>
  JSON.stringify({ session_id: sid, hook_event_name: "PreToolUse", tool_name, tool_input, ...extra });
const bash = (command: string, sid = "s1") => tool("Bash", { command }, sid);
const guard = (input: string, now = T0) => run(hookCmd("PreToolUse", "wall-time.sh"), input, now);

beforeEach(() => { root = fs.mkdtempSync(join(os.tmpdir(), "at-wall-time-")); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("[wall-time] grammar and validation", () => {
  it("wall-time: is an agent field, reads, round-trips and validates on the entry agent", () => {
    const ast = parse(src());
    const lead = ast.nodes.find((n) => n.id === "lead") as any;
    expect(lead.wallTime).toBe("4h");
    const r = validate(ast);
    expect(r.filter((x) => x.rule === "V159"), JSON.stringify(r)).toEqual([]);
    expect(r.filter((x) => x.rule === "V102")).toEqual([]);
    expect((parse(serialize(ast)).nodes.find((n) => n.id === "lead") as any).wallTime).toBe("4h");
  });

  it("90m and 2d are durations; 4 hours, 0h, soon and 1.5h are not", () => {
    for (const ok of ["90m", "2d", "30s", "4h"]) {
      expect(validate(parse(src(`    wall-time: ${ok}\n`))).filter((x) => x.rule === "V159"), ok).toEqual([]);
    }
    for (const bad of ['"4 hours"', "0h", "soon", "1.5h"]) {
      const r = validate(parse(src(`    wall-time: ${bad}\n`))).filter((x) => x.rule === "V159" && x.level === "error");
      expect(r.length, bad).toBe(1);
    }
  });

  it("wall-time on any agent but the entry is an error that names timeout", () => {
    const r = validate(parse(src("", "    wall-time: 1h\n")));
    const e = r.find((x) => x.rule === "V159" && x.level === "error");
    expect(e).toBeTruthy();
    expect(e!.node).toBe("worker");
    expect(e!.message).toContain("timeout");
    expect(e!.message).toContain("lead");
  });

  it("with no meta entry, wall-time is an error that says to name the entry", () => {
    const r = validate(parse(src('    wall-time: 4h\n', "", "")));
    const e = r.find((x) => x.rule === "V159" && x.level === "error");
    expect(e).toBeTruthy();
    expect(e!.message).toContain("entry");
  });
});

describe("[wall-time] a topology without wall-time is unchanged", () => {
  it("writes no wall-start.sh, no wall-time.sh and no hook for them", () => {
    const files = scaffold(src(""));
    expect(files.map((f) => f.path).filter((p) => p.includes("wall-"))).toEqual([]);
    expect(fs.readFileSync(at(".claude/settings.json"), "utf8")).not.toContain("wall-");
  });
});

const MUST_PASS: Array<[string, string]> = [
  ["git status", "git status"],
  ["npm test", "npm test"],
  ["ls", "ls"],
  ["grep x src", "grep x src"],
  ["claude -p --agent x summarize", 'claude -p --agent x "summarize the logs"'],
  ["gh pr create --body", 'gh pr create --body "Adds a wall-time cap"'],
  ["a for loop", "for f in a b c; do echo $f; done"],
  ["a heredoc to cat", "cat <<EOF\nhello\nEOF"],
];

describe.skipIf(!hasJq)("[wall-time] before the cap, ordinary commands pass", () => {
  for (const [name, command] of MUST_PASS) {
    it(`passes ${name} at the start, just under the cap, and exactly at it`, () => {
      scaffold();
      expect(start().status).toBe(0);
      for (const dt of [0, 3600, 4 * 3600 - 1, 4 * 3600]) {
        const r = guard(bash(command), T0 + dt);
        expect(r.status, `+${dt}s: ${r.stderr}`).toBe(0);
      }
    });
  }

  it("passes the other tools before the cap: Read, Write, WebFetch, Agent, an MCP tool", () => {
    scaffold();
    start();
    for (const [t, i] of [["Read", { file_path: "a.md" }], ["Write", { file_path: "a.md", content: "x" }], ["WebFetch", { url: "https://example.com" }], ["Agent", { prompt: "x" }], ["mcp__x__y", {}]] as const) {
      const r = guard(tool(t, i), T0 + 60);
      expect(r.status, `${t}: ${r.stderr}`).toBe(0);
    }
  });

  it("a 90m cap passes at 89 minutes and refuses at 91", () => {
    scaffold(src("    wall-time: 90m\n"));
    start();
    expect(guard(bash("ls"), T0 + 89 * 60).status).toBe(0);
    expect(guard(bash("ls"), T0 + 91 * 60).status).toBe(2);
  });

  it("the start hook never blocks and writes the start time once: a resume or compact does not move it", () => {
    scaffold();
    expect(start(T0, "s1", "startup").status).toBe(0);
    expect(start(T0 + 3 * 3600, "s1", "resume").status).toBe(0);
    expect(start(T0 + 3.5 * 3600, "s1", "compact").status).toBe(0);
    expect(guard(bash("ls"), T0 + 4 * 3600 + 1).status).toBe(2);
  });

  it("each session has its own clock: a second session starting later does not reset the first", () => {
    scaffold();
    start(T0, "s1");
    start(T0 + 3 * 3600, "s2");
    expect(guard(bash("ls", "s1"), T0 + 5 * 3600).status).toBe(2);
    expect(guard(bash("ls", "s2"), T0 + 5 * 3600).status).toBe(0);
  });
});

describe.skipIf(!hasJq)("[wall-time] past the cap, every tool is refused and the reason names the cap", () => {
  it("refuses Bash, Read, Write, WebFetch, Agent and an MCP tool, naming wall-time: 4h", () => {
    scaffold();
    start();
    for (const [t, i] of [["Bash", { command: "ls" }], ["Bash", { command: "git status" }], ["Read", { file_path: "a.md" }], ["Write", { file_path: "a.md", content: "x" }], ["WebFetch", { url: "https://example.com" }], ["Agent", { prompt: "x" }], ["mcp__x__y", {}]] as const) {
      const r = guard(tool(t, i), T0 + 4 * 3600 + 1);
      expect(r.status, t).toBe(2);
      expect(r.stderr).toContain("wall-time");
      expect(r.stderr).toContain("4h");
    }
  });

  it("refuses a subagent's tool call too (the cap is the session's)", () => {
    scaffold();
    start();
    const r = guard(tool("Bash", { command: "ls" }, "s1", { agent_id: "a1", agent_type: "worker" }), T0 + 5 * 3600);
    expect(r.status).toBe(2);
  });

  it("refuses when no start was recorded (the state file is gone), and on a session id that is not a plain id", () => {
    scaffold();
    const r = guard(bash("ls"));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("wall-time");
    start();
    expect(guard(bash("ls", "../x")).status).toBe(2);
    expect(guard(bash("ls", "")).status).toBe(2);
  });

  it("refuses when the state file holds no number", () => {
    scaffold();
    start();
    const dir = at(".claude/state");
    const f = fs.readdirSync(dir, { recursive: true, withFileTypes: true }).find((e) => e.isFile() && e.name.includes("s1"));
    expect(f).toBeTruthy();
    fs.writeFileSync(join(f!.parentPath, f!.name), "later\n");
    expect(guard(bash("ls")).status).toBe(2);
  });
});

describe("[wall-time] wiring", () => {
  it("SessionStart runs wall-start.sh; PreToolUse runs wall-time.sh on every tool with block on failure", () => {
    scaffold();
    const s = JSON.parse(fs.readFileSync(at(".claude/settings.json"), "utf8"));
    const ss = s.hooks.SessionStart.filter((x: any) => x.hooks.some((h: any) => h.command.includes("wall-start.sh")));
    expect(ss).toHaveLength(1);
    const pre = s.hooks.PreToolUse.filter((x: any) => x.hooks.some((h: any) => h.command.includes("wall-time.sh")));
    expect(pre).toHaveLength(1);
    expect(pre[0].matcher).toBe("*");
    expect(pre[0].hooks[0].onFailure).toBe("block");
    expect(fs.existsSync(at(`${SCRIPTS}/wall-time.sh`))).toBe(true);
  });
});
