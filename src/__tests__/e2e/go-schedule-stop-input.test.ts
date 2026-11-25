/**
 * The go word, the scheduled prompt and the stop word read the same way (0.13.3).
 *
 * - before-schedule.sh reads a scheduled prompt with the go hook's own functions, so every prompt the go
 *   hook would count as the go is refused before it is scheduled (whole message, or its first words), also
 *   after `/loop` and its interval. Past the cap, such a prompt can no longer renew the window either.
 * - The go word is not trimmed of `?` or quotes: `go release?` and `"go release"` are not the go.
 * - The stop word is read through the input phones send: typographic quotes, guillemets, Hebrew
 *   punctuation, CJK and full-width punctuation, direction and zero-width marks, the stop-sign emoji,
 *   `#`, `>` and brackets, full-width letters, and Hebrew points (niqqud).
 * - A listed stop word that opens with the go word (or the reverse) is refused, any case.
 * - The renewal never writes through a planted symlink.
 * - With stop-from: any, a cross-session header holding `>` keeps its body's stop.
 *
 * Every hook row runs under both LC_ALL=C.UTF-8 and LC_ALL=C.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";

const hasJq = spawnSync("/bin/sh", ["-c", "command -v jq"]).status === 0;
const LOCALES = ["C.UTF-8", "C"];

function src(human = '    word: "go release"\n    stop-word: [stop, עצור]\n    stop-from: any\n'): string {
  return `topology probe : [pipeline, human-gate] {
  meta {
    version: "0.1.0"
    description: "probe"
    entry: lead
  }
  person owner {
  }
  agent lead {
    model: opus
    description: "Leads"
    wall-time: 1h
    renew-on: owner-go
  }
  action draft {
    kind: inline
    description: "Draft"
    commands: ["./tool draft"]
  }
  human owner-go {
    description: "The owner types go"
    who: owner
${human}  }
  human other-go {
    description: "Another"
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
const SCRIPTS = ".claude/skills/probe/scripts";
const T0 = 1_800_000_000;

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
function run(command: string, stdin: string, locale: string, now = T0) {
  const base: Record<string, string | undefined> = { ...process.env, CLAUDE_PROJECT_DIR: root, AGENTOPOLOGY_TEST: "1", AT_NOW: String(now), LC_ALL: locale, LANG: locale };
  delete base.AT_SESSION;
  return spawnSync("/bin/sh", ["-c", command], { cwd: at("work/deep"), input: stdin, env: base as NodeJS.ProcessEnv, encoding: "utf8", timeout: 20_000 });
}
function hookCmd(event: string, script: string): string {
  const settings = JSON.parse(fs.readFileSync(at(".claude/settings.json"), "utf8"));
  const e = (settings.hooks?.[event] ?? []).find((x: any) => x.hooks.some((h: any) => h.command.includes(script)));
  expect(e, `a ${event} entry for ${script}`).toBeTruthy();
  return e.hooks.find((h: any) => h.command.includes(script)).command;
}
const prompt = (text: string, sid = "s1") => JSON.stringify({ session_id: sid, hook_event_name: "UserPromptSubmit", cwd: root, prompt: text });
const type = (text: string, locale: string, now = T0) => run(hookCmd("UserPromptSubmit", "go-owner-go.sh"), prompt(text), locale, now);
const schedule = (tool_name: string, tool_input: Record<string, unknown>, locale: string) =>
  run(`bash "${at(`${SCRIPTS}/before-schedule.sh`)}"`, JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s1", tool_name, tool_input }), locale);
const rowsOf = (f = "logs/go.jsonl") => {
  const p = at(f);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};
function kind(text: string, locale: string): string {
  const before = rowsOf().length;
  const r = type(text, locale);
  expect(r.status, `${JSON.stringify(text)} ${locale}: ${r.stderr}`).toBe(0);
  const l = rowsOf();
  if (l.length === before) return "none";
  return l[l.length - 1].halt === true ? "halt" : "go";
}
const show = (s: string) => JSON.stringify(s).replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

beforeEach(() => { root = fs.mkdtempSync(join(os.tmpdir(), "at-go-sched-")); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

/** Prompts the go hook counts as the go today, or once did; each must be refused when scheduled. */
const GO_SHAPED = ["go release", "Go release", "GO RELEASE", "**go release**", '"go release"', "go  release", "- go release", "/loop 5m Go release", "go release, now", "  go release.", "/loop Go release"];

describe.skipIf(!hasJq)("before-schedule.sh reads a prompt the way the go hook does", () => {
  for (const locale of LOCALES) {
    it(`refuses every go-shaped prompt, in CronCreate and ScheduleWakeup (${locale})`, () => {
      scaffold();
      for (const p of GO_SHAPED) {
        for (const [tool, input] of [["CronCreate", { cron: "*/5 * * * *", prompt: p, recurring: true }], ["ScheduleWakeup", { delaySeconds: 60, prompt: p, reason: "x" }]] as const) {
          const r = schedule(tool, input, locale);
          expect.soft(r.status, `${tool} ${show(p)}: ${r.stderr}`).toBe(2);
        }
      }
    });

    it(`lets an ordinary scheduled prompt through (${locale})`, () => {
      scaffold();
      for (const p of ["check the deploy", "/loop 5m check the release notes", "please go release the notes later", "going release", "gone release", "stop"]) {
        const r = schedule("CronCreate", { cron: "*/5 * * * *", prompt: p, recurring: true }, locale);
        expect.soft(r.status, `${show(p)}: ${r.stderr}`).toBe(0);
      }
    });

    it(`every prompt the go hook counts is refused by the schedule gate (${locale})`, () => {
      scaffold();
      for (const p of [...GO_SHAPED, "go release!", "`go release`", "(go release)", "_go release_", "go release…", "GO release —"]) {
        if (kind(p, locale) !== "go") continue;
        const r = schedule("CronCreate", { cron: "*/5 * * * *", prompt: p, recurring: true }, locale);
        expect.soft(r.status, `counted as go, yet schedulable: ${show(p)}`).toBe(2);
      }
    });
  }
});

describe.skipIf(!hasJq)("the go word: no ? and no quotes around it", () => {
  for (const locale of LOCALES) {
    it(`go release? and a quoted go are not the go; the plain forms still are (${locale})`, () => {
      scaffold();
      for (const p of ["go release?", '"go release"', "'go release'", "“go release”"]) expect.soft(kind(p, locale), show(p)).toBe("none");
      for (const p of ["go release", "Go release.", " GO ", "**go release**", "go release!"].filter((x) => x !== " GO ")) expect.soft(kind(p, locale), show(p)).toBe("go");
    });

    it(`go release then U+3000 reads the same under every locale (${locale})`, () => {
      scaffold();
      expect(kind("go release　", locale)).toBe("none");
    });

    it(`look-alikes and trailing text after invisible separators never count (${locale})`, () => {
      scaffold();
      for (const p of ["go release now", "go release now", "go release​now", "go release‏now", "go release\r\nnow", "go release\u000bnow", "go release\u000cnow", "ｇｏ ｒｅｌｅａｓｅ", "gо release", "> go release"])
        expect.soft(kind(p, locale), show(p)).toBe("none");
    });
  }
});

describe.skipIf(!hasJq)("the stop word through phone input", () => {
  const HALT = ["“stop”", "‘stop’", "‏stop", "‏עצור", "עצור‏", "״עצור״", "׳עצור", "עֲצוֹר", "«stop»", "🛑 stop", "stop🛑", "ｓｔｏｐ", "stop。", "stop！", "stop？", "#stop", "> stop", "[stop]", "​stop", "﻿stop", "stop‎", "stop　now", "עצור־עכשיו"];
  const NONE = ["stopwatch", "stop-loss", "don't stop", "לא עצור", "please stop"];
  for (const locale of LOCALES) {
    it(`halts on each (${locale})`, () => {
      scaffold();
      for (const p of HALT) expect.soft(kind(p, locale), show(p)).toBe("halt");
    });
    it(`does not halt on these (${locale})`, () => {
      scaffold();
      for (const p of NONE) expect.soft(kind(p, locale), show(p)).toBe("none");
    });
  }
});

describe.skipIf(!hasJq)("stop-from: any reads the body of a message whose header holds >", () => {
  for (const locale of LOCALES) {
    it(`a header attribute with > keeps the body's stop (${locale})`, () => {
      scaffold();
      expect(kind('<cross-session-message from="uds:/x" from-name="a>b" from-mode="bypass">\nstop\n</cross-session-message>', locale)).toBe("halt");
      expect(kind('<cross-session-message from="a>b">stop</cross-session-message>', locale)).toBe("halt");
      expect(kind('<cross-session-message from="a>b">\ngo release\n</cross-session-message>', locale)).toBe("none");
    });
  }
});

describe("a listed stop word that overlaps the go word is refused", () => {
  for (const list of ['[stop, "go"]', '[stop, "Go"]', '[stop, "go release now"]', '[halt, "GO RELEASE NOW"]']) {
    it(`stop-word: ${list} with word "go release"`, () => {
      const r = validate(parse(src(`    word: "go release"\n    stop-word: ${list}\n`)));
      expect(r.some((x) => x.rule === "V160" && x.level === "error" && /overlap/.test(x.message)), JSON.stringify(r.filter((x) => x.level === "error"))).toBe(true);
    });
  }
  it("a list with no overlap validates", () => {
    const r = validate(parse(src('    word: "go release"\n    stop-word: [stop, עצור, "halt now"]\n')));
    expect(r.filter((x) => x.level === "error")).toEqual([]);
  });
});

describe.skipIf(!hasJq)("the renewal", () => {
  const startOf = (sid = "s1") => fs.readFileSync(at(`.claude/state/wall-time/${sid}`), "utf8").trim();
  const begin = (now: number, locale: string) => run(hookCmd("SessionStart", "wall-start.sh"), JSON.stringify({ session_id: "s1", hook_event_name: "SessionStart", source: "startup" }), locale, now);
  for (const locale of LOCALES) {
    it(`never writes through a symlink planted at the temporary name (${locale})`, () => {
      scaffold();
      begin(1000, locale);
      expect(startOf()).toBe("1000");
      const victim = at("victim.json");
      fs.writeFileSync(victim, '{"keep":true}\n');
      fs.symlinkSync(victim, at(".claude/state/wall-time/s1.new"));
      const r = type("go release", locale, 9000);
      expect(r.status, r.stderr).toBe(0);
      expect(fs.readFileSync(victim, "utf8")).toBe('{"keep":true}\n');
      expect(startOf()).toBe("9000");
      expect(rowsOf().some((x) => x.previous_start === 1000)).toBe(true);
    });

    it(`a go-shaped scheduled prompt is refused before it can fire and renew (${locale})`, () => {
      scaffold();
      const r = schedule("CronCreate", { cron: "*/5 * * * *", prompt: "Go release", recurring: true }, locale);
      expect(r.status).toBe(2);
    });
  }
});

describe("the go hook says what before-schedule.sh refuses", () => {
  it("its header no longer says a prompt that starts with the word counts", () => {
    const hook = claudeCodeBinding.scaffold(parse(src())).find((f) => f.path.endsWith("go-owner-go.sh"))!.content;
    expect(hook).not.toMatch(/starts with the word counts/);
  });
});
