/**
 * Fixes from an adversarial review of the generated session guards (N44b-fix).
 * Same harness as session-binding.test.ts: scaffold the fixture into a temp
 * dir and run the generated scripts the way Claude Code runs a hook.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import { generateSessionFiles, shellQuote } from "../../bindings/lib/session.js";
import { checkGuards, renderGuardReport } from "../../guard/check.js";

// Pin the installed version so these tests do not depend on the claude on PATH (a version with no live check grades unverified).
process.env.AGENTOPOLOGY_CLAUDE_VERSION = "2.1.999";
const here = dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(resolve(here, "fixtures/session-ops.at"), "utf8");
const SCRIPTS = ".claude/skills/session-ops/scripts";
const hasJq = spawnSync("/bin/sh", ["-c", "command -v jq"]).status === 0;

let root: string;
const at = (p: string) => join(root, p);

function scaffold() {
  const ast = parse(src);
  for (const f of claudeCodeBinding.scaffold(ast)) {
    fs.mkdirSync(dirname(at(f.path)), { recursive: true });
    fs.writeFileSync(at(f.path), f.content);
    if (f.executable || f.path.endsWith(".sh")) fs.chmodSync(at(f.path), 0o755);
  }
  fs.mkdirSync(at("work/deep"), { recursive: true });
  return ast;
}

function hookCmd(event: string, matcher: string | undefined, file: string): string {
  const settings = JSON.parse(fs.readFileSync(at(".claude/settings.json"), "utf8"));
  const e = (settings.hooks?.[event] ?? []).find((x: any) => x.matcher === matcher && x.hooks.some((h: any) => h.command.includes(file)));
  return e.hooks.find((h: any) => h.command.includes(file)).command;
}
const spawnCmd = () => hookCmd("PreToolUse", "Agent|Task", "spawn-guard.sh");
const talkCmd = () => hookCmd("PreToolUse", "SendMessage", "talk-guard.sh");
const promptCmd = () => {
  const settings = JSON.parse(fs.readFileSync(at(".claude/settings.json"), "utf8"));
  return settings.hooks.UserPromptSubmit[0].hooks[0].command as string;
};

function run(command: string, stdin: string, env: Record<string, string | undefined> = {}, cwd = "work/deep") {
  const base: Record<string, string | undefined> = { ...process.env, CLAUDE_PROJECT_DIR: root };
  delete base.AT_SESSION;
  const merged = { ...base, ...env };
  for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
  return spawnSync("/bin/sh", ["-c", command], { cwd: at(cwd), input: stdin, env: merged as NodeJS.ProcessEnv, encoding: "utf8" });
}

const lines = () => {
  const p = at(".claude/state/talk.jsonl");
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const send = (to: unknown) => JSON.stringify({ tool_name: "SendMessage", tool_input: { to, message: "hi" } });
const spawn = (input: unknown) => JSON.stringify({ tool_name: "Agent", tool_input: input });
const prompt = (text: unknown) => JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: text });

beforeEach(() => { root = fs.mkdtempSync(join(os.tmpdir(), "at-session-fix-")); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe.skipIf(!hasJq)("[N44b-fix] spawn guard", () => {
  it("[N44b-fix] F1 empty stdin, {} and a non-object tool_input block (exit 2)", () => {
    scaffold();
    expect(run(spawnCmd(), "").status).toBe(2);
    expect(run(spawnCmd(), "{}").status).toBe(2);
    expect(run(spawnCmd(), JSON.stringify({ tool_input: "x" })).status).toBe(2);
    expect(run(spawnCmd(), JSON.stringify({ tool_input: null })).status).toBe(2);
  });

  it("[N44b-fix] F1 a valid tool_input with no subagent_type is an ordinary spawn (exit 0)", () => {
    scaffold();
    expect(run(spawnCmd(), spawn({ prompt: "x" })).status).toBe(0);
    expect(run(spawnCmd(), spawn({})).status).toBe(0);
    expect(run(spawnCmd(), spawn({ subagent_type: "helper", prompt: "x" })).status).toBe(0);
  });

  it("[N44b-fix] F5 case, whitespace, an array, a topology: prefix and a non-string value are refused", () => {
    scaffold();
    for (const v of ["Lane-Build", "  lane-build ", "lane-build\n", "session-ops:lane-build", "SESSION-OPS:Lane-Build"]) {
      expect(run(spawnCmd(), spawn({ subagent_type: v })).status, JSON.stringify(v)).toBe(2);
    }
    for (const v of [["lane-build"], 5, true, { a: 1 }]) {
      expect(run(spawnCmd(), spawn({ subagent_type: v })).status, JSON.stringify(v)).toBe(2);
    }
  });

  it("[N44b-fix] F5 a .tool_input.name equal to a session id is refused; other names pass", () => {
    scaffold();
    expect(run(spawnCmd(), spawn({ subagent_type: "helper", name: "lane-video" })).status).toBe(2);
    expect(run(spawnCmd(), spawn({ name: " Lane-Video " })).status).toBe(2);
    expect(run(spawnCmd(), spawn({ subagent_type: "helper", name: 7 })).status).toBe(2);
    expect(run(spawnCmd(), spawn({ subagent_type: "helper", name: "worker-1" })).status).toBe(0);
  });

  it("[N44b-fix] pin: a session agent is still refused with a reason; extra fields are ignored", () => {
    scaffold();
    const r = run(spawnCmd(), spawn({ subagent_type: "lane-manager", prompt: "x", extra: [1, 2] }));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("lane-manager");
  });

  it("[N44b-fix] pin: jq missing blocks (exit 2)", () => {
    scaffold();
    const r = run(spawnCmd().replace(/^bash /, "/bin/bash "), spawn({ subagent_type: "helper" }), { PATH: "/nonexistent" });
    expect(r.status).toBe(2);
  });
});

describe.skipIf(!hasJq)("[N44b-fix] talk guard", () => {
  const as = (id: string) => ({ AT_SESSION: id });

  it("[N44b-fix] F3 a trailing ' [ref]' on to is stripped before matching", () => {
    scaffold();
    expect(run(talkCmd(), send("lane-manager [abc123]"), as("lane-build")).status).toBe(0);
    expect(lines()[0]).toMatchObject({ from: "lane-build", to: "lane-manager", result: "allowed" });
    expect(run(talkCmd(), send("lane-text [abc123]"), as("lane-video")).status).toBe(2);
  });

  it("[N44b-fix] F4 a session may message its own subagent and main, nobody else's", () => {
    scaffold();
    expect(run(talkCmd(), send("helper"), as("lane-build")).status).toBe(0);
    expect(run(talkCmd(), send("main"), as("lane-build")).status).toBe(0);
    expect(run(talkCmd(), send("main"), as("lane-video")).status).toBe(0);
    expect(run(talkCmd(), send("helper"), as("lane-video")).status).toBe(2);
    expect(run(talkCmd(), send("main"), as("lane-manager")).status).toBe(0);
  });

  it("[N44b-fix] F6 a NUL, newline, uppercase or space in to is refused and logged", () => {
    scaffold();
    const bad = ["lane-manager\nx", "lane-manager\u0000", "Lane-Manager", "lane manager", "MAIN", "lane-manager\n"];
    for (const v of bad) expect(run(talkCmd(), send(v), as("lane-build")).status, JSON.stringify(v)).toBe(2);
    const l = lines();
    expect(l).toHaveLength(bad.length);
    for (const x of l) expect(x.result).toBe("refused");
  });

  it("[N44b-fix] F8 an oversize to is refused and logged; so are an unparsable payload and a missing to", () => {
    scaffold();
    expect(run(talkCmd(), send("a".repeat(100000)), as("lane-build")).status).toBe(2);
    expect(run(talkCmd(), "not json{", as("lane-build")).status).toBe(2);
    expect(run(talkCmd(), "{}", as("lane-build")).status).toBe(2);
    expect(run(talkCmd(), JSON.stringify({ tool_input: { to: 5 } }), as("lane-build")).status).toBe(2);
    const l = lines();
    expect(l).toHaveLength(4);
    for (const x of l) expect(x).toMatchObject({ from: "lane-build", result: "refused" });
    expect(JSON.stringify(l[0]).length).toBeLessThan(500);
  });

  const both = (to: unknown, recipient: unknown) => JSON.stringify({ tool_name: "SendMessage", tool_input: { to, recipient, recipient_kind: "name", summary: "s", message: "hi", content: "hi", type: "message" } });
  const recOnly = (recipient: unknown) => JSON.stringify({ tool_name: "SendMessage", tool_input: { recipient, message: "hi" } });

  it("[N44d] to and recipient that disagree are refused and logged", () => {
    scaffold();
    const r = run(talkCmd(), both("lane-manager", "lane-text"), as("lane-video"));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("talk guard: to and recipient disagree");
    expect(lines()[0]).toMatchObject({ from: "lane-video", result: "refused" });
    expect(run(talkCmd(), both("lane-text", "lane-manager"), as("lane-video")).status).toBe(2);
  });

  it("[N44d] recipient alone on a declared edge is allowed", () => {
    scaffold();
    expect(run(talkCmd(), recOnly("lane-manager"), as("lane-video")).status).toBe(0);
    expect(lines()[0]).toMatchObject({ to: "lane-manager", result: "allowed" });
  });

  it("[N44d] recipient alone off the edges is refused", () => {
    scaffold();
    expect(run(talkCmd(), recOnly("lane-text"), as("lane-video")).status).toBe(2);
    expect(run(talkCmd(), recOnly(5), as("lane-video")).status).toBe(2);
  });

  it("[N44d] to and recipient that agree are allowed (also after ref strip and case)", () => {
    scaffold();
    expect(run(talkCmd(), both("lane-manager", "lane-manager"), as("lane-video")).status).toBe(0);
    expect(run(talkCmd(), both("lane-manager", "lane-manager [abc123]"), as("lane-video")).status).toBe(0);
    expect(run(talkCmd(), both("lane-manager", "Lane-Manager "), as("lane-video")).status).toBe(0);
  });

  it("[N44b-fix] F9 with CLAUDE_PROJECT_DIR unset the log goes to the script's own project root", () => {
    scaffold();
    const r = run(`bash ${at(`${SCRIPTS}/talk-guard.sh`)}`, send("lane-manager"), { AT_SESSION: "lane-video", CLAUDE_PROJECT_DIR: undefined }, "work/deep");
    expect(r.status).toBe(0);
    expect(lines()).toHaveLength(1);
    expect(fs.existsSync(at("work/deep/.claude"))).toBe(false);
  });

  it("[N44b-fix] F9 a symlinked talk.jsonl is not appended through (verdict unchanged)", () => {
    scaffold();
    fs.mkdirSync(at(".claude/state"), { recursive: true });
    fs.writeFileSync(at("victim.txt"), "keep\n");
    fs.symlinkSync(at("victim.txt"), at(".claude/state/talk.jsonl"));
    expect(run(talkCmd(), send("lane-text"), as("lane-video")).status).toBe(2);
    const ok = run(talkCmd(), send("lane-manager"), as("lane-video"));
    expect(ok.status).toBe(0);
    expect(ok.stderr).toContain("symlink");
    expect(fs.readFileSync(at("victim.txt"), "utf8")).toBe("keep\n");
  });

  it("[N44b-fix] F9 guard --check says talk.jsonl is a trail, not evidence", () => {
    const ast = scaffold();
    expect(renderGuardReport(checkGuards(ast, root)).join("\n")).toContain("talk.jsonl is a trail, not evidence");
  });

  it("[N44b-fix] pin: refusals on case, spaces, uds:, agentId, *, self and bad types", () => {
    scaffold();
    for (const v of ["Lane-Manager", " lane-manager", "uds:/tmp/x.sock", "a1b2c3d4@lane-manager", "*", "lane-video", 5, ["lane-manager"], null, {}]) {
      expect(run(talkCmd(), send(v), as("lane-video")).status, JSON.stringify(v)).toBe(2);
    }
  });

  it("[N44b-fix] pin: extra fields ignored; unset AT_SESSION unguarded; unparsable with it set blocks", () => {
    scaffold();
    const payload = JSON.stringify({ tool_name: "SendMessage", extra: 1, tool_input: { to: "lane-manager", message: { a: 1 }, summary: "s" } });
    expect(run(talkCmd(), payload, as("lane-video")).status).toBe(0);
    const r = run(talkCmd(), send("lane-text"));
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("unguarded");
    expect(run(talkCmd(), "x{", as("lane-video")).status).toBe(2);
  });

  it("[N44b-fix] pin: jq missing blocks (exit 2) when AT_SESSION is set", () => {
    scaffold();
    const r = run(talkCmd().replace(/^bash /, "/bin/bash "), send("lane-manager"), { AT_SESSION: "lane-video", PATH: "/nonexistent" });
    expect(r.status).toBe(2);
  });

  it("[N44b-fix] pin: onFailure block on both guards", () => {
    scaffold();
    const settings = JSON.parse(fs.readFileSync(at(".claude/settings.json"), "utf8"));
    for (const f of ["spawn-guard.sh", "talk-guard.sh"]) {
      const e = settings.hooks.PreToolUse.find((x: any) => x.hooks.some((h: any) => h.command.includes(f)));
      expect(e.hooks[0].onFailure).toBe("block");
    }
  });
});

describe.skipIf(!hasJq)("[N44b-fix] prompt log", () => {
  const kinds = () => lines().map((l) => l.kind);
  const as = { AT_SESSION: "lane-manager" };

  it("[N44b-fix] F2 empty or malformed input writes unknown, never typed", () => {
    scaffold();
    expect(run(promptCmd(), "", as).status).toBe(0);
    expect(run(promptCmd(), "{}", as).status).toBe(0);
    expect(run(promptCmd(), "garbage{", as).status).toBe(0);
    expect(run(promptCmd(), prompt(""), as).status).toBe(0);
    expect(run(promptCmd(), prompt("  \n "), as).status).toBe(0);
    expect(run(promptCmd(), prompt(5), as).status).toBe(0);
    expect(kinds()).toEqual(["unknown", "unknown", "unknown", "unknown", "unknown", "unknown"]);
  });

  it("[N44b-fix] F2 leading whitespace before the wrapper still reads as arrived; a plain prompt as typed", () => {
    scaffold();
    run(promptCmd(), prompt('  \n\t<cross-session-message from="x">y</cross-session-message>'), as);
    run(promptCmd(), prompt("ship it"), as);
    run(promptCmd(), prompt("look at <cross-session-message in the middle"), as);
    expect(kinds()).toEqual(["arrived", "typed", "typed"]);
  });

  it("[N44b-fix] pin: jq missing exits 0", () => {
    scaffold();
    const r = run(promptCmd().replace(/^bash /, "/bin/bash "), prompt("x"), { ...as, PATH: "/nonexistent" });
    expect(r.status).toBe(0);
  });

  it("[N44b-fix] F9 a symlinked log is not written through", () => {
    scaffold();
    fs.mkdirSync(at(".claude/state"), { recursive: true });
    fs.writeFileSync(at("victim.txt"), "keep\n");
    fs.symlinkSync(at("victim.txt"), at(".claude/state/talk.jsonl"));
    expect(run(promptCmd(), prompt("x"), as).status).toBe(0);
    expect(fs.readFileSync(at("victim.txt"), "utf8")).toBe("keep\n");
  });
});

describe("[N44b-fix] guard --check on a gutted guard", () => {
  it("[N44b-fix] F10 a guard that lost its exit 2 path or its jq read grades none", () => {
    for (const file of ["spawn-guard.sh", "talk-guard.sh"]) {
      for (const gut of ["#!/usr/bin/env bash\nexit 0\n", "#!/usr/bin/env bash\n# exit 2\n# jq -er\nexit 0\n"]) {
        const ast = scaffold();
        fs.writeFileSync(at(`${SCRIPTS}/${file}`), gut);
        const id = file === "spawn-guard.sh" ? "spawn guard" : "talk guard";
        const item = checkGuards(ast, root).items.find((i) => i.kind === "session" && i.id === id)!;
        expect(item.strength, `${file} ${JSON.stringify(gut)}`).toBe("none");
        expect(item.notes.join("\n")).toMatch(/generated|marker/);
        fs.rmSync(root, { recursive: true, force: true });
        root = fs.mkdtempSync(join(os.tmpdir(), "at-session-fix-"));
      }
    }
  });

  it("[N44b-fix] F10 the untouched guards still grade unverified", () => {
    const ast = scaffold();
    for (const i of checkGuards(ast, root).items.filter((x) => x.kind === "session")) expect(i.strength).toBe("unverified");
  });
});

describe("[N44b-fix] launcher", () => {
  const launcher = (ast = parse(src)) => generateSessionFiles(ast).find((f) => f.path === "scripts/start-sessions.sh");

  it("[N44b-fix] F7 shellQuote single-quotes and escapes embedded single quotes", () => {
    expect(shellQuote("ops")).toBe("'ops'");
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
    expect(shellQuote("$(id)")).toBe("'$(id)'");
  });

  it("[N44b-fix] F7 every interpolated value in the launcher is single-quoted", () => {
    const sh = launcher()!.content;
    expect(sh).toContain("herdr tab create 'ops'");
    expect(sh).toContain("herdr pane run \"$pane\" 'AT_SESSION=lane-video claude --agent lane-video -n lane-video'");
    expect(sh).not.toMatch(/herdr tab create [^']/);
    expect(spawnSync("/bin/sh", ["-n", "-c", sh]).status).toBe(0);
  });

  it("[N44b-fix] F7 a hostile place or id is not emitted into a launcher", () => {
    for (const bad of ["x$(touch /tmp/at-pwn)", "a b", "Ops", "a;b", "", "a'b"]) {
      const ast = parse(src);
      const a = ast.nodes.find((n: any) => n.id === "lane-video") as any;
      a.place = bad;
      const warn = console.warn; console.warn = () => {};
      try { expect(launcher(ast), JSON.stringify(bad)).toBeUndefined(); } finally { console.warn = warn; }
    }
    const ast = parse(src);
    (ast.nodes.find((n: any) => n.id === "lane-video") as any).id = "lane;video";
    const warn = console.warn; console.warn = () => {};
    try { expect(launcher(ast)).toBeUndefined(); } finally { console.warn = warn; }
  });

  function fakeHerdr(listOutput: string | null) {
    const bin = at("bin"); fs.mkdirSync(bin, { recursive: true });
    const log = at("herdr.log");
    fs.writeFileSync(join(bin, "herdr"), [
      "#!/bin/sh",
      'echo "$*" >> "$HERDR_LOG"',
      listOutput === null ? 'case "$1 $2" in "pane list"|"tab list") exit 1;; esac' : `case "$1 $2" in "pane list"|"tab list") printf '%s\\n' "${listOutput}"; exit 0;; esac`,
      'case "$1 $2" in "tab create"|"pane split") echo "pane-$$-$RANDOM";; esac',
      "exit 0",
    ].join("\n"));
    fs.chmodSync(join(bin, "herdr"), 0o755);
    return { bin, log };
  }
  const runLauncher = (listOutput: string | null) => {
    const sh = launcher()!.content;
    fs.mkdirSync(at("scripts"), { recursive: true });
    fs.writeFileSync(at("scripts/start-sessions.sh"), sh);
    const { bin, log } = fakeHerdr(listOutput);
    const r = spawnSync("/bin/sh", [at("scripts/start-sessions.sh")], { env: { PATH: `${bin}:/usr/bin:/bin`, HERDR_LOG: log }, encoding: "utf8" });
    return { r, calls: fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "" };
  };

  it("[N44b-fix] F11 a session already listed is skipped on rerun", () => {
    const { r, calls } = runLauncher("lane-manager\nlane-build");
    expect(r.status).toBe(0);
    expect(calls).not.toContain("AT_SESSION=lane-manager");
    expect(calls).not.toContain("AT_SESSION=lane-build");
    expect(calls).toContain("AT_SESSION=lane-video");
    expect(calls).toContain("AT_SESSION=lane-text");
  });

  it("[N44b-fix] F11 with no usable list command it warns that a rerun duplicates, and still starts", () => {
    const { r, calls } = runLauncher(null);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/rerun.*duplicate/i);
    expect(calls).toContain("AT_SESSION=lane-text");
  });

  it("[N44b-fix] F11 the header marks the herdr subcommands as unproven", () => {
    expect(launcher()!.content.split("\n").slice(0, 12).join("\n")).toMatch(/unproven/i);
  });
});
