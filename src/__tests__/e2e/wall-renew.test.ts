/**
 * `wall-time: <duration>` with `renew-on: <human-id>` on the entry agent (0.13.3).
 *
 * Past the cap, the TYPED go of that human (the same typed test as every go) starts a fresh window: the
 * session's start is reset and a renewal row {ts, human, previous_start} is appended to the go ledger. A
 * relayed go does not renew, another human's go does not renew, a session with no recorded start is not
 * renewed (strict), and without renew-on nothing changes.
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

function src(lead = "    wall-time: 1h\n    renew-on: owner-go\n", ownerGo = '    word: "go on"\n'): string {
  return `topology renewing : [pipeline, human-gate] {
  meta {
    version: "0.1.0"
    description: "A wall-time cap the owner can renew"
    entry: lead
  }
  person owner {
  }
  agent lead {
    model: opus
    description: "Leads"
${lead}  }
  action draft {
    kind: inline
    description: "Draft"
    commands: ["./tool draft"]
  }
  human owner-go {
    description: "The owner types go"
    who: owner
${ownerGo}  }
  human other-go {
    description: "Another person types go"
    who: owner
    word: "other go"
  }
  action release {
    kind: external
    description: "Release"
    commands: ["./tool release"]
  }
  action publish {
    kind: external
    description: "Publish"
    commands: ["./tool publish"]
  }
  records {
    record go-ledger { path: "logs/go.jsonl" }
    record other-ledger { path: "logs/other.jsonl" }
  }
  gates {
    gate go-given {
      after: owner-go
      before: release
      ledger: go-ledger
      strength: refuse
    }
    gate other-given {
      after: other-go
      before: publish
      ledger: other-ledger
      strength: refuse
    }
  }
  flow {
    lead -> draft
    draft -> owner-go
    owner-go -> release
    draft -> other-go
    other-go -> publish
  }
}
`;
}

let root: string;
const at = (p: string) => join(root, p);
const T0 = 1_800_000_000;
const CAP = 3600;

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
const start = (now = T0, sid = "s1") => run(hookCmd("SessionStart", "wall-start.sh"), JSON.stringify({ session_id: sid, hook_event_name: "SessionStart", source: "startup" }), now);
const prompt = (text: string, sid = "s1") => JSON.stringify({ session_id: sid, hook_event_name: "UserPromptSubmit", cwd: root, prompt: text });
const typeGo = (text: string, now: number, script = "go-owner-go.sh", sid = "s1") => run(hookCmd("UserPromptSubmit", script), prompt(text, sid), now);
const guard = (now: number, sid = "s1") =>
  run(hookCmd("PreToolUse", "wall-time.sh"), JSON.stringify({ session_id: sid, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } }), now);
const rowsOf = (f: string) => {
  const p = at(f);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const startFile = (sid = "s1") => fs.readFileSync(at(`.claude/state/wall-time/${sid}`), "utf8").trim();

beforeEach(() => { root = fs.mkdtempSync(join(os.tmpdir(), "at-wall-renew-")); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("[renew] grammar and validation", () => {
  it("renew-on: is an agent field, reads, round-trips and validates", () => {
    const ast = parse(src());
    const lead = ast.nodes.find((n) => n.id === "lead") as any;
    expect(lead.renewOn).toBe("owner-go");
    const r = validate(ast);
    expect(r.filter((x) => x.level === "error"), JSON.stringify(r)).toEqual([]);
    expect(r.filter((x) => x.rule === "V102")).toEqual([]);
    expect((parse(serialize(ast)).nodes.find((n) => n.id === "lead") as any).renewOn).toBe("owner-go");
  });
  it("renew-on naming no human is refused", () => {
    const r = validate(parse(src("    wall-time: 1h\n    renew-on: nobody\n"))).filter((x) => x.rule === "V161" && x.level === "error");
    expect(r.length).toBe(1);
    expect(r[0].message).toContain("nobody");
  });
  it("renew-on naming a human with no go word is refused", () => {
    const text = src().replace('    who: owner\n    word: "go on"\n', "    who: owner\n");
    const r = validate(parse(text)).filter((x) => x.rule === "V161" && x.level === "error");
    expect(r.length).toBe(1);
    expect(r[0].message).toContain("word");
  });
  it("renew-on naming something that is not a human is refused", () => {
    const r = validate(parse(src("    wall-time: 1h\n    renew-on: draft\n"))).filter((x) => x.rule === "V161" && x.level === "error");
    expect(r.length).toBe(1);
  });
  it("renew-on with no wall-time is refused", () => {
    const r = validate(parse(src("    renew-on: owner-go\n"))).filter((x) => x.rule === "V161" && x.level === "error");
    expect(r.length).toBe(1);
    expect(r[0].message).toContain("wall-time");
  });
});

describe.skipIf(!hasJq)("[renew] the typed go renews a session past its cap", () => {
  it("past the cap the tool call is refused", () => {
    scaffold();
    start();
    expect(guard(T0 + CAP - 1).status).toBe(0);
    expect(guard(T0 + CAP + 1).status).toBe(2);
  });

  it("after the typed go past the cap the call is allowed, the start is reset and a renewal row is written", () => {
    scaffold();
    start();
    const now = T0 + CAP + 5;
    expect(guard(now).status).toBe(2);
    const r = typeGo("go on", now);
    expect(r.status, r.stderr).toBe(0);
    expect(startFile()).toBe(String(now));
    expect(guard(now + 10).status).toBe(0);
    expect(guard(now + CAP - 1).status).toBe(0);
    expect(guard(now + CAP + 1).status).toBe(2);
    const l = rowsOf("logs/go.jsonl");
    expect(l).toHaveLength(2);
    expect(l[0]).toMatchObject({ step: "owner-go", ok: true, word: "go on" });
    expect(l[1]).toMatchObject({ human: "owner-go", previous_start: T0 });
    expect(l[1].ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it("a second renewal after a second window records the earlier renewal's start", () => {
    scaffold();
    start();
    const t1 = T0 + CAP + 5;
    typeGo("go on", t1);
    const t2 = t1 + CAP + 5;
    expect(guard(t2).status).toBe(2);
    typeGo("go on", t2);
    expect(guard(t2 + 1).status).toBe(0);
    const renewals = rowsOf("logs/go.jsonl").filter((x) => x.human === "owner-go");
    expect(renewals.map((x) => x.previous_start)).toEqual([T0, t1]);
  });

  it("a go before the cap passes writes its go row and does not renew", () => {
    scaffold();
    start();
    typeGo("go on", T0 + 100);
    expect(startFile()).toBe(String(T0));
    expect(rowsOf("logs/go.jsonl").filter((x) => x.human !== undefined)).toEqual([]);
  });

  it("a relayed (not typed) go does not renew", () => {
    scaffold();
    start();
    const now = T0 + CAP + 5;
    typeGo('<cross-session-message from="lane">go on</cross-session-message>', now);
    typeGo("<task-notification><summary>x</summary></task-notification>\ngo on", now);
    expect(startFile()).toBe(String(T0));
    expect(guard(now).status).toBe(2);
    expect(rowsOf("logs/go.jsonl")).toEqual([]);
  });

  it("another human's go does not renew", () => {
    scaffold();
    start();
    const now = T0 + CAP + 5;
    const r = typeGo("other go", now, "go-other-go.sh");
    expect(r.status, r.stderr).toBe(0);
    expect(rowsOf("logs/other.jsonl")).toHaveLength(1);
    expect(startFile()).toBe(String(T0));
    expect(guard(now).status).toBe(2);
  });

  it("a prompt that is not the go word does not renew", () => {
    scaffold();
    start();
    const now = T0 + CAP + 5;
    typeGo("go on, please", now);
    expect(guard(now).status).toBe(2);
  });

  it("with no recorded start nothing is renewed: the cap stays strict and no renewal row is written", () => {
    scaffold();
    const now = T0 + CAP + 5;
    expect(guard(now).status).toBe(2);
    typeGo("go on", now);
    expect(fs.existsSync(at(".claude/state/wall-time/s1"))).toBe(false);
    expect(guard(now + 1).status).toBe(2);
    expect(rowsOf("logs/go.jsonl").filter((x) => x.human !== undefined)).toEqual([]);
  });

  it("a renewal changes only the session that typed it", () => {
    scaffold();
    start(T0, "s1");
    start(T0, "s2");
    const now = T0 + CAP + 5;
    typeGo("go on", now, "go-owner-go.sh", "s1");
    expect(guard(now + 1, "s1").status).toBe(0);
    expect(guard(now + 1, "s2").status).toBe(2);
  });

  it("without renew-on the typed go past the cap changes nothing", () => {
    scaffold(src("    wall-time: 1h\n"));
    start();
    const now = T0 + CAP + 5;
    typeGo("go on", now);
    expect(startFile()).toBe(String(T0));
    expect(guard(now).status).toBe(2);
    expect(rowsOf("logs/go.jsonl").filter((x) => x.human !== undefined)).toEqual([]);
  });

  it("a topology without renew-on writes the same go hook text as one with no wall-time at all", () => {
    const withCap = scaffold(src("    wall-time: 1h\n")).find((f) => f.path.endsWith("go-owner-go.sh"))!.content;
    const noCap = claudeCodeBinding.scaffold(parse(src(""))).find((f) => f.path.endsWith("go-owner-go.sh"))!.content;
    expect(withCap).toBe(noCap);
    expect(withCap).not.toContain("wall-time");
  });
});
