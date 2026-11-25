/**
 * How the go word and the stop word are read (0.13.3).
 *
 * The stop word is read without regard to case (ASCII), as the first word of the message, after the
 * whitespace and punctuation around that word are trimmed; a trailing clause is allowed. `stop-word:` may be
 * one string or a list, and a word in another script is matched exactly. The go word must be the WHOLE
 * message, without regard to case (ASCII) and surrounding punctuation.
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

function src(human = '    word: "go release"\n    stop-word: "stop"\n'): string {
  return `topology wording : [pipeline, human-gate] {
  meta {
    version: "0.1.0"
    description: "How a go word and a stop word are read"
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
/** What one typed message writes: "go", "halt" or "none". */
function kind(text: string): string {
  const before = rows().length;
  const r = type(text);
  expect(r.status, `${text}: ${r.stderr}`).toBe(0);
  const l = rows();
  if (l.length === before) return "none";
  return l[l.length - 1].halt === true ? "halt" : "go";
}

beforeEach(() => { root = fs.mkdtempSync(join(os.tmpdir(), "at-go-words-")); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe.skipIf(!hasJq)("[words] the stop word: the first word, any case, punctuation trimmed, a clause allowed", () => {
  const HALTS = ["Stop, the build is wrong", "STOP", "stop.", " stop, x", "stop…", "stop—now", "stop–now", "Stop-", "stop)", "'stop'", '"stop"', "**stop**", "/stop", "stop", "Stop!", "  stop\n", "(stop)", "stop_"];
  for (const text of HALTS) {
    it(`halts: ${JSON.stringify(text)}`, () => {
      scaffold();
      expect(kind(text)).toBe("halt");
    });
  }
  for (const text of ["please stop", "stopwatch", "don't stop", "stopped", "stop-word", "nonstop", "the stop"]) {
    it(`does not halt: ${JSON.stringify(text)}`, () => {
      scaffold();
      expect(kind(text)).toBe("none");
    });
  }
  it("the halt row names the stop word as the topology wrote it", () => {
    scaffold();
    type("STOP now");
    expect(rows()[0]).toMatchObject({ step: "owner-go", ok: false, halt: true, word: "stop" });
  });
  it("a two-word stop word is read the same way: its words in order, first, a clause after", () => {
    scaffold(src('    word: "go release"\n    stop-word: "stop release"\n'));
    expect(kind("Stop Release, now")).toBe("halt");
    expect(kind("stop release!")).toBe("halt");
    expect(kind("stop")).toBe("none");
    expect(kind("stop released")).toBe("none");
    expect(kind("please stop release")).toBe("none");
  });
});

describe.skipIf(!hasJq)("[words] stop-word: may be a list; a word in another script is matched exactly", () => {
  const LIST = '    word: "go release"\n    stop-word: [stop, עצור]\n';
  it("parses a list, keeps it through a round trip and validates", () => {
    const ast = parse(src(LIST));
    const human = ast.nodes.find((n) => n.id === "owner-go") as any;
    expect(human.stopWords).toEqual(["stop", "עצור"]);
    const r = validate(ast);
    expect(r.filter((x) => x.level === "error"), JSON.stringify(r)).toEqual([]);
    const again = parse(serialize(ast)).nodes.find((n) => n.id === "owner-go") as any;
    expect(again.stopWords).toEqual(["stop", "עצור"]);
  });
  for (const text of ["עצור", "עצור.", "עצור, משהו שבור", "stop", "STOP, x"]) {
    it(`halts: ${text}`, () => {
      scaffold(src(LIST));
      expect(kind(text)).toBe("halt");
    });
  }
  it("does not halt: לא עצור", () => {
    scaffold(src(LIST));
    expect(kind("לא עצור")).toBe("none");
  });
  it("the halt row holds the word that matched", () => {
    scaffold(src(LIST));
    type("עצור, עכשיו");
    expect(rows()[0]).toMatchObject({ ok: false, halt: true, word: "עצור" });
  });
  it("the go word still counts on a topology with a list of stop words", () => {
    scaffold(src(LIST));
    expect(kind("go release")).toBe("go");
  });
});

describe("[words] V169: the stop words", () => {
  const rule = (human: string) => validate(parse(src(human))).filter((x) => x.rule === "V169" && x.level === "error");
  it("an empty stop word in a list is refused", () => {
    expect(rule('    word: "go release"\n    stop-word: [stop, ""]\n').length).toBe(1);
  });
  it("a duplicate is refused, ignoring case", () => {
    expect(rule('    word: "go release"\n    stop-word: [stop, Stop]\n').length).toBe(1);
  });
  it("a stop word equal to a go word is refused, ignoring case and punctuation", () => {
    expect(rule('    word: "go"\n    stop-word: [halt, "GO!"]\n').length).toBe(1);
  });
  it("a stop word holding a character the reader cuts at (it could never match) is refused", () => {
    expect(rule('    word: "go release"\n    stop-word: "stop, now"\n').length).toBe(1);
  });
  it("a list of good words is accepted", () => {
    expect(rule('    word: "go release"\n    stop-word: [stop, halt, עצור]\n')).toEqual([]);
  });
});

describe.skipIf(!hasJq)("[words] the go word: the whole message, any case, punctuation trimmed", () => {
  const GO = '    word: "go"\n    stop-word: "stop"\n';
  for (const text of ["Go", "go.", " GO ", "go!", "GO\n", "'go'", "go…"]) {
    it(`counts (one word): ${JSON.stringify(text)}`, () => {
      scaffold(src(GO));
      expect(kind(text)).toBe("go");
    });
  }
  for (const text of ["Go ahead and explain the plan", "go, but first read the notes", "go release", "go now", "ago", "going", "please go"]) {
    it(`does not count (one word): ${JSON.stringify(text)}`, () => {
      scaffold(src(GO));
      expect(kind(text)).toBe("none");
    });
  }
  for (const text of ["go release", "Go release.", "Go Release", "  GO   RELEASE  ", "go release!"]) {
    it(`counts (two words): ${JSON.stringify(text)}`, () => {
      scaffold();
      expect(kind(text)).toBe("go");
    });
  }
  for (const text of ["go release later", "go release, notes look right", "go release now", "go releases", "go", "please go release", "go release: ship it", "go release; thanks"]) {
    it(`does not count (two words): ${JSON.stringify(text)}`, () => {
      scaffold();
      expect(kind(text)).toBe("none");
    });
  }
  it("a go word with no stop word is read the same way", () => {
    scaffold(src('    word: "go release"\n'));
    expect(kind("GO RELEASE.")).toBe("go");
    expect(kind("go release now")).toBe("none");
  });
  it("the row holds the go word as the topology wrote it", () => {
    scaffold();
    type("GO release");
    expect(rows()[0]).toMatchObject({ step: "owner-go", ok: true, word: "go release" });
  });
});
