/**
 * S-201: `human <id> { word: "..."; stop-word: "..." }`.
 *
 * When the person types the stop word (the same typed test and the same anchoring as the go word: the go
 * hook's UserPromptSubmit reading, never text an agent writes), the go hook appends a halt row
 * `{step, ok: false, halt: true, word, ts}` to the go ledger. go-halt.sh (PreToolUse, every tool) refuses
 * while the last row of that human in the ledger is a halt. The next typed go word writes a go row, which
 * ends the halt: a tool refusal never reaches the person's prompt.
 *
 * The scripts run the way Claude Code runs a hook: a shell, a subfolder as the current directory,
 * CLAUDE_PROJECT_DIR set, the event's JSON on stdin.
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

function src(human = '    word: "go release"\n    stop-word: "stop release"\n'): string {
  return `topology stopper : [pipeline, human-gate] {
  meta {
    version: "0.1.0"
    description: "A go word and a stop word"
  }
  person owner {
  }
  orchestrator {
    model: opus
    handles: [draft, release]
  }
  action draft {
    kind: inline
    description: "Draft the release"
    commands: ["./tool draft"]
  }
  human owner-go {
    description: "The owner types go for the release"
    who: owner
${human}  }
  action release {
    kind: external
    description: "Release"
    commands: ["./tool release"]
  }
  records {
    record go-ledger { path: "logs/go.jsonl" }
  }
  gates {
    gate go-given {
      after: owner-go
      before: release
      ledger: go-ledger
      strength: refuse
    }
  }
  flow {
    draft -> owner-go
    owner-go -> release
  }
}
`;
}

const SCRIPTS = ".claude/skills/stopper/scripts";
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

function run(command: string, stdin: string) {
  const base: Record<string, string | undefined> = { ...process.env, CLAUDE_PROJECT_DIR: root, AGENTOPOLOGY_TEST: "1" };
  delete base.AT_SESSION;
  return spawnSync("/bin/sh", ["-c", command], { cwd: at("work/deep"), input: stdin, env: base as NodeJS.ProcessEnv, encoding: "utf8", timeout: 20_000 });
}
function hookCmd(event: string, script: string): string {
  const settings = JSON.parse(fs.readFileSync(at(".claude/settings.json"), "utf8"));
  const e = (settings.hooks?.[event] ?? []).find((x: any) => x.hooks.some((h: any) => h.command.includes(script)));
  expect(e, `a ${event} entry for ${script}`).toBeTruthy();
  return e.hooks.find((h: any) => h.command.includes(script)).command;
}
const prompt = (text: string) => JSON.stringify({ session_id: "s1", hook_event_name: "UserPromptSubmit", cwd: root, prompt: text });
const tool = (tool_name: string, tool_input: Record<string, unknown>) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name, tool_input });
const bash = (command: string) => tool("Bash", { command });
const halt = (input: string) => run(hookCmd("PreToolUse", "go-halt.sh"), input);
const type = (text: string) => run(hookCmd("UserPromptSubmit", "go-owner-go.sh"), prompt(text));
const rows = () => {
  const p = at("logs/go.jsonl");
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};

beforeEach(() => { root = fs.mkdtempSync(join(os.tmpdir(), "at-stop-word-")); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("[stop] grammar and validation", () => {
  it("stop-word: is a human field, reads, round-trips and validates", () => {
    const ast = parse(src());
    const human = ast.nodes.find((n) => n.id === "owner-go") as any;
    expect(human.stopWord).toBe("stop release");
    const r = validate(ast);
    expect(r.filter((x) => x.level === "error"), JSON.stringify(r)).toEqual([]);
    expect(r.filter((x) => x.rule === "V102")).toEqual([]);
    const again = parse(serialize(ast)).nodes.find((n) => n.id === "owner-go") as any;
    expect(again.stopWord).toBe("stop release");
  });

  it("a stop word equal to the go word is refused (any case, any punctuation between words)", () => {
    for (const stop of ["go release", "GO  Release", "go-release"]) {
      const r = validate(parse(src(`    word: "go release"\n    stop-word: "${stop}"\n`)));
      const e = r.find((x) => x.rule === "V158" && x.level === "error");
      expect(e, stop).toBeTruthy();
      expect(e!.message).toContain("differ");
    }
  });

  it("a stop word that opens with the go word (or the reverse) is refused: one prompt would give both", () => {
    for (const [word, stop] of [["go", "go stop"], ["stop release", "stop"], ["go", "go, stop"]]) {
      const r = validate(parse(src(`    word: "${word}"\n    stop-word: "${stop}"\n`)));
      expect(r.some((x) => x.rule === "V158" && x.level === "error"), `${word} / ${stop}`).toBe(true);
    }
  });

  it("a stop word on a human with no word is refused", () => {
    const r = validate(parse(src('    stop-word: "stop release"\n')));
    const e = r.find((x) => x.rule === "V158" && x.level === "error");
    expect(e).toBeTruthy();
    expect(e!.message).toContain("word:");
  });

  it("an empty stop word, or one on two lines, is refused", () => {
    const r = validate(parse(src('    word: "go release"\n    stop-word: ""\n')));
    expect(r.some((x) => x.rule === "V158" && x.level === "error")).toBe(true);
  });

  it("a stop word that merely shares a first letter with the go word is fine", () => {
    const r = validate(parse(src('    word: "go release"\n    stop-word: "stop"\n')));
    expect(r.filter((x) => x.rule === "V158")).toEqual([]);
  });
});

describe("[stop] a topology without stop-word is unchanged", () => {
  it("writes no go-halt.sh, no halt hook and no halt branch in the go hook", () => {
    const files = scaffold(src('    word: "go release"\n'));
    expect(files.map((f) => f.path).filter((p) => p.includes("go-halt"))).toEqual([]);
    const settings = fs.readFileSync(at(".claude/settings.json"), "utf8");
    expect(settings).not.toContain("go-halt");
    const hook = files.find((f) => f.path.endsWith("go-owner-go.sh"))!.content;
    expect(hook).not.toContain("halt");
  });
});

describe.skipIf(!hasJq)("[stop] the typed stop word writes a halt row; nothing else does", () => {
  it("the typed stop word appends {step, ok: false, halt: true, word, ts} and exits 0", () => {
    scaffold();
    const r = type("stop release");
    expect(r.status, r.stderr).toBe(0);
    const l = rows();
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ step: "owner-go", ok: false, halt: true, word: "stop release" });
    expect(l[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it("the anchoring is the go word's: alone, or followed by a space or , . : ; ! ? and anything; never a longer word", () => {
    scaffold();
    expect(type("  stop release \n").status).toBe(0);
    expect(type("stop release, now").status).toBe(0);
    expect(type("stop release!").status).toBe(0);
    expect(rows()).toHaveLength(3);
    expect(type("stop released").status).toBe(0);
    expect(type("please stop release").status).toBe(0);
    expect(type("stop").status).toBe(0);
    expect(rows()).toHaveLength(3);
  });

  it("a prompt that arrived (another session, a task notification) writes no halt row", () => {
    scaffold();
    expect(type("<cross-session-message from=\"x\">stop release</cross-session-message>").status).toBe(0);
    expect(type("<task-notification><summary>done</summary></task-notification>\nstop release").status).toBe(0);
    expect(rows()).toEqual([]);
  });

  it("the go word still writes the go row, with its binds, on a topology with a stop word", () => {
    scaffold();
    expect(type("go release").status).toBe(0);
    const l = rows();
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ step: "owner-go", ok: true, word: "go release" });
    expect(l[0].halt).toBeUndefined();
  });

  it("a halt row refuses a release step even with an earlier go row (the gate reads the last row)", () => {
    scaffold();
    type("go release");
    type("stop release");
    const r = run(`bash "${root}/${SCRIPTS}/before-action.sh"`, bash("./tool release"));
    expect(r.status).toBe(2);
  });
});

const MUST_PASS: Array<[string, string]> = [
  ["git status", "git status"],
  ["npm test", "npm test"],
  ["ls", "ls"],
  ["grep x src", "grep x src"],
  ["claude -p --agent x summarize", 'claude -p --agent x "summarize the logs"'],
  ["gh pr create --body", 'gh pr create --body "Adds the stop word to the go hook"'],
  ["a for loop", "for f in a b c; do echo $f; done"],
  ["a heredoc to cat", "cat <<EOF\nhello\nEOF"],
];

describe.skipIf(!hasJq)("[stop] go-halt.sh: must-pass rows, before any stop and after the go that follows one", () => {
  for (const [name, command] of MUST_PASS) {
    it(`passes ${name} with no stop typed`, () => {
      scaffold();
      const r = halt(bash(command));
      expect(r.status, r.stderr).toBe(0);
    });
    it(`passes ${name} after stop, then go`, () => {
      scaffold();
      type("stop release");
      type("go release");
      const r = halt(bash(command));
      expect(r.status, r.stderr).toBe(0);
    });
  }

  it("passes the other tools too with no stop typed: Read, Write, WebFetch, an MCP tool", () => {
    scaffold();
    for (const [t, i] of [["Read", { file_path: "a.md" }], ["Write", { file_path: "a.md", content: "x" }], ["WebFetch", { url: "https://example.com" }], ["mcp__x__y", {}]] as const) {
      const r = halt(tool(t, i));
      expect(r.status, `${t}: ${r.stderr}`).toBe(0);
    }
  });

  it("passes with a ledger holding go rows and other steps' rows, and with no ledger at all", () => {
    scaffold();
    expect(halt(bash("git status")).status).toBe(0);
    fs.mkdirSync(at("logs"), { recursive: true });
    fs.writeFileSync(at("logs/go.jsonl"), '{"step":"owner-go","ok":true,"word":"go release","ts":"2026-11-24T10:00:00Z"}\n{"step":"draft","ok":true}\n');
    expect(halt(bash("git status")).status).toBe(0);
  });
});

describe.skipIf(!hasJq)("[stop] go-halt.sh: must-refuse rows", () => {
  it("after the stop word every tool is refused, and the reason names the stop and the way out", () => {
    scaffold();
    type("stop release");
    for (const [t, i] of [["Bash", { command: "ls" }], ["Bash", { command: "git status" }], ["Read", { file_path: "a.md" }], ["Write", { file_path: "a.md", content: "x" }], ["Edit", { file_path: "a.md" }], ["WebFetch", { url: "https://example.com" }], ["Agent", { prompt: "x" }], ["mcp__x__y", {}]] as const) {
      const r = halt(tool(t, i));
      expect(r.status, t).toBe(2);
      expect(r.stderr).toContain("stop release");
      expect(r.stderr).toContain("go release");
    }
  });

  it("another step's later row does not end the halt; the go word does, and a second stop halts again", () => {
    scaffold();
    type("stop release");
    fs.appendFileSync(at("logs/go.jsonl"), '{"step":"draft","ok":true}\n');
    expect(halt(bash("ls")).status).toBe(2);
    expect(type("go release").status).toBe(0);
    expect(halt(bash("ls")).status).toBe(0);
    type("stop release");
    expect(halt(bash("ls")).status).toBe(2);
  });

  it("an agent's Bash command that appends a go row to the ledger does not clear the halt (the ledger is protected)", () => {
    scaffold();
    type("stop release");
    const r = run(`bash "${root}/${SCRIPTS}/before-action.sh"`, bash(`echo '{"step":"owner-go","ok":true}' >> logs/go.jsonl`));
    expect(r.status).toBe(2);
  });

  it("a ledger that cannot be read refuses (fail closed)", () => {
    scaffold();
    fs.mkdirSync(at("logs"), { recursive: true });
    fs.writeFileSync(at("logs/go.jsonl"), "not json\n");
    expect(halt(bash("ls")).status).toBe(2);
  });
});

describe.skipIf(!hasJq)("[stop] the stop never blocks the person typing the next go", () => {
  it("while halted, the go hook still runs, exits 0 and writes the go row (it is a prompt hook, not a tool)", () => {
    scaffold();
    type("stop release");
    expect(halt(bash("ls")).status).toBe(2);
    const r = type("go release");
    expect(r.status, r.stderr).toBe(0);
    expect(rows().map((x) => x.ok)).toEqual([false, true]);
    expect(halt(bash("ls")).status).toBe(0);
  });

  it("the settings wire go-halt.sh on PreToolUse only, with block on failure, and the go hook on UserPromptSubmit with no block", () => {
    scaffold();
    const s = JSON.parse(fs.readFileSync(at(".claude/settings.json"), "utf8"));
    const pre = s.hooks.PreToolUse.filter((x: any) => x.hooks.some((h: any) => h.command.includes("go-halt.sh")));
    expect(pre).toHaveLength(1);
    expect(pre[0].hooks[0].onFailure).toBe("block");
    expect(JSON.stringify(s.hooks.UserPromptSubmit)).not.toContain("go-halt");
    const ups = s.hooks.UserPromptSubmit.find((x: any) => x.hooks.some((h: any) => h.command.includes("go-owner-go.sh")));
    expect(ups.hooks[0].onFailure).toBeUndefined();
  });
});
