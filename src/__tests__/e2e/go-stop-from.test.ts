/**
 * `human <id> { stop-from: any }` (0.13.3, opt-in; the only value).
 *
 * With it, a stop word in a prompt the person did NOT type (a message from another session, a background
 * report, a scheduled prompt) still halts: it writes the halt row. A go word in a prompt not typed NEVER
 * counts, with or without the field.
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

function src(human = '    word: "go release"\n    stop-word: "stop"\n    stop-from: any\n'): string {
  return `topology fromer : [pipeline, human-gate] {
  meta {
    version: "0.1.0"
    description: "A stop word that halts from a relayed prompt"
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

const WITHOUT = '    word: "go release"\n    stop-word: "stop"\n';
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
const type = (text: string) => run(hookCmd("UserPromptSubmit", "go-owner-go.sh"), prompt(text));
const rows = () => {
  const p = at("logs/go.jsonl");
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};
function kind(text: string): string {
  const before = rows().length;
  const r = type(text);
  expect(r.status, `${text}: ${r.stderr}`).toBe(0);
  const l = rows();
  if (l.length === before) return "none";
  return l[l.length - 1].halt === true ? "halt" : "go";
}
const RELAYED = [
  '<cross-session-message from="lane-build">stop</cross-session-message>',
  '<cross-session-message from="lane-build">Stop, the build is wrong</cross-session-message>',
  '  \n<cross-session-message from="x">STOP.</cross-session-message>',
  "<task-notification><summary>done</summary></task-notification>\nstop",
];
const RELAYED_GO = [
  '<cross-session-message from="lane-build">go release</cross-session-message>',
  "<task-notification><summary>done</summary></task-notification>\ngo release",
];

beforeEach(() => { root = fs.mkdtempSync(join(os.tmpdir(), "at-stop-from-")); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("[stop-from] grammar and validation", () => {
  it("stop-from: any reads, round-trips and validates", () => {
    const ast = parse(src());
    expect((ast.nodes.find((n) => n.id === "owner-go") as any).stopFrom).toBe("any");
    const r = validate(ast);
    expect(r.filter((x) => x.level === "error"), JSON.stringify(r)).toEqual([]);
    expect(r.filter((x) => x.rule === "V102")).toEqual([]);
    expect((parse(serialize(ast)).nodes.find((n) => n.id === "owner-go") as any).stopFrom).toBe("any");
  });
  it("any other value is refused, and the message names the one value", () => {
    for (const v of ["typed", "all", "none", '""']) {
      const r = validate(parse(src(`    word: "go release"\n    stop-word: "stop"\n    stop-from: ${v}\n`))).filter((x) => x.rule === "V169" && x.level === "error");
      expect(r.length, v).toBe(1);
      expect(r[0].message).toContain("any");
    }
  });
  it("stop-from with no stop-word is refused", () => {
    const r = validate(parse(src('    word: "go release"\n    stop-from: any\n'))).filter((x) => x.rule === "V169" && x.level === "error");
    expect(r.length).toBe(1);
    expect(r[0].message).toContain("stop-word");
  });
});

describe.skipIf(!hasJq)("[stop-from] with stop-from: any a relayed stop halts; a relayed go never counts", () => {
  for (const text of RELAYED) {
    it(`halts: ${JSON.stringify(text)}`, () => {
      scaffold();
      expect(kind(text)).toBe("halt");
    });
  }
  for (const text of RELAYED_GO) {
    it(`a relayed go does not count: ${JSON.stringify(text)}`, () => {
      scaffold();
      expect(kind(text)).toBe("none");
    });
  }
  it("a typed stop and a typed go still work", () => {
    scaffold();
    expect(kind("Stop")).toBe("halt");
    expect(kind("go release")).toBe("go");
  });
  it("a relayed prompt that merely mentions the stop word, not first, does not halt", () => {
    scaffold();
    expect(kind('<cross-session-message from="x">please do not stop</cross-session-message>')).toBe("none");
    expect(kind("<task-notification><summary>stop</summary></task-notification>\nall done")).toBe("none");
  });
  it("a relayed stop then a typed go: the go ends the halt (the last row is the go)", () => {
    scaffold();
    kind(RELAYED[0]);
    kind("go release");
    expect(rows().map((r) => r.ok)).toEqual([false, true]);
  });
});

describe.skipIf(!hasJq)("[stop-from] without the field a relayed stop does not halt, and a relayed go does not count", () => {
  for (const text of RELAYED) {
    it(`does not halt: ${JSON.stringify(text)}`, () => {
      scaffold(src(WITHOUT));
      expect(kind(text)).toBe("none");
    });
  }
  for (const text of RELAYED_GO) {
    it(`a relayed go does not count: ${JSON.stringify(text)}`, () => {
      scaffold(src(WITHOUT));
      expect(kind(text)).toBe("none");
    });
  }
  it("the go hook of a topology without the field is the same text as before", () => {
    const text = claudeCodeBinding.scaffold(parse(src(WITHOUT))).find((f) => f.path.endsWith("go-owner-go.sh"))!.content;
    expect(text).toContain('[ "$KIND" = typed ] || exit 0');
  });
});
