/**
 * Follow-ups from a second adversarial review of the session guards (N44c).
 * Same harness as session-guard-fixes.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import { generateSessionFiles } from "../../bindings/lib/session.js";

const here = dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(resolve(here, "fixtures/session-ops.at"), "utf8");
const hasJq = spawnSync("/bin/sh", ["-c", "command -v jq"]).status === 0;
const CLI = resolve(here, "../../../dist/cli/index.js");

let root: string;
const at = (p: string) => join(root, p);

function scaffold(source = src) {
  const ast = parse(source);
  for (const f of claudeCodeBinding.scaffold(ast)) {
    fs.mkdirSync(dirname(at(f.path)), { recursive: true });
    fs.writeFileSync(at(f.path), f.content);
    if (f.executable || f.path.endsWith(".sh")) fs.chmodSync(at(f.path), 0o755);
  }
  fs.mkdirSync(at("work/deep"), { recursive: true });
  return ast;
}
function hookCmd(file: string): string {
  const settings = JSON.parse(fs.readFileSync(at(".claude/settings.json"), "utf8"));
  for (const es of Object.values<any[]>(settings.hooks)) for (const e of es) for (const h of e.hooks) if (h.command.includes(file)) return h.command;
  throw new Error("no hook " + file);
}
function run(command: string, stdin: string, env: Record<string, string | undefined> = {}) {
  const base: Record<string, string | undefined> = { ...process.env, CLAUDE_PROJECT_DIR: root };
  delete base.AT_SESSION;
  const merged = { ...base, ...env };
  for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
  return spawnSync("/bin/sh", ["-c", command], { cwd: at("work/deep"), input: stdin, env: merged as NodeJS.ProcessEnv, encoding: "utf8" });
}
const send = (to: unknown) => JSON.stringify({ tool_name: "SendMessage", tool_input: { to, message: "hi" } });
const spawn = (input: unknown) => JSON.stringify({ tool_name: "Agent", tool_input: input });
const talkLines = () => {
  const p = at(".claude/state/talk.jsonl");
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};

beforeEach(() => { root = fs.mkdtempSync(join(os.tmpdir(), "at-session-n44c-")); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const quiet = <T>(fn: () => T): T => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };

describe("[N44c] N4 permission-mode is never emitted unescaped", () => {
  it("[N44c] N4 a hostile permission-mode is in neither sessions.md nor the launcher", () => {
    const ast = parse(src);
    (ast.nodes.find((n: any) => n.id === "lane-video") as any).permissionMode = "x$(echo INJECTED)";
    const files = quiet(() => generateSessionFiles(ast));
    for (const f of files) expect(f.content, f.path).not.toContain("INJECTED");
  });
  it("[N44c] N4 a declared safe permission-mode is still emitted", () => {
    const ast = parse(src);
    (ast.nodes.find((n: any) => n.id === "lane-video") as any).permissionMode = "acceptEdits";
    const files = generateSessionFiles(ast);
    expect(files.find((f) => f.path === ".claude/sessions.md")!.content).toContain("--permission-mode acceptEdits");
  });
});

describe("[N44c] N5 launcher matches exact names", () => {
  const launcherSh = () => generateSessionFiles(parse(src)).find((f) => f.path === "scripts/start-sessions.sh")!.content;
  function runLauncher(listOutput: string) {
    fs.mkdirSync(at("scripts"), { recursive: true });
    fs.writeFileSync(at("scripts/start-sessions.sh"), launcherSh());
    const bin = at("bin"); fs.mkdirSync(bin, { recursive: true });
    const log = at("herdr.log");
    fs.writeFileSync(join(bin, "herdr"), [
      "#!/bin/sh",
      'echo "$*" >> "$HERDR_LOG"',
      `case "$1 $2" in "pane list") printf '%s\\n' "$HERDR_LIST"; exit 0;; esac`,
      'case "$1 $2" in "tab create"|"pane split") echo "pane-$$-$RANDOM";; esac',
      "exit 0",
    ].join("\n"));
    fs.chmodSync(join(bin, "herdr"), 0o755);
    const r = spawnSync("/bin/sh", [at("scripts/start-sessions.sh")], { env: { PATH: `${bin}:/usr/bin:/bin`, HERDR_LOG: log, HERDR_LIST: listOutput }, encoding: "utf8" });
    return { r, calls: fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "" };
  }
  it("[N44c] N5 lane-build-old listed does not make lane-build listed", () => {
    const { r, calls } = runLauncher("lane-build-old");
    expect(r.status).toBe(0);
    expect(calls).toContain("AT_SESSION=lane-build claude");
  });
  it("[N44c] N5 an error banner naming the ids is not a listing", () => {
    const { calls } = runLauncher("error: cannot list lane-build lane-manager lane-video lane-text");
    expect(calls).toContain("AT_SESSION=lane-build claude");
    expect(calls).toContain("AT_SESSION=lane-manager claude");
  });
  it("[N44c] N5 an exactly listed name is still skipped", () => {
    const { calls } = runLauncher("lane-build  running\nlane-manager");
    expect(calls).not.toContain("AT_SESSION=lane-build claude");
    expect(calls).not.toContain("AT_SESSION=lane-manager claude");
    expect(calls).toContain("AT_SESSION=lane-text claude");
  });
});

describe.skipIf(!hasJq)("[N44c] talk log integrity", () => {
  const as = (id: string) => ({ AT_SESSION: id });
  it("[N44c] a hardlinked talk log is refused: not written through, send still passes with a notice", () => {
    scaffold();
    fs.mkdirSync(at(".claude/state"), { recursive: true });
    fs.writeFileSync(at("victim.txt"), "keep\n");
    fs.linkSync(at("victim.txt"), at(".claude/state/talk.jsonl"));
    const ok = run(hookCmd("talk-guard.sh"), send("lane-manager"), as("lane-video"));
    expect(ok.status).toBe(0);
    expect(ok.stderr).toContain("talk log not written");
    expect(fs.readFileSync(at("victim.txt"), "utf8")).toBe("keep\n");
    expect(run(hookCmd("talk-guard.sh"), send("lane-text"), as("lane-video")).status).toBe(2);
  });
  it("[N44c] an unwritable log: an allowed send passes and says 'talk log not written'", () => {
    scaffold();
    fs.writeFileSync(at(".claude/state"), "i am a file, not a folder\n");
    const ok = run(hookCmd("talk-guard.sh"), send("lane-manager"), as("lane-video"));
    expect(ok.status).toBe(0);
    expect(ok.stderr).toContain("talk log not written");
  });
  it("[N44c] a symlinked state dir: an allowed send passes and says 'talk log not written'", () => {
    scaffold();
    fs.mkdirSync(at("elsewhere"));
    fs.mkdirSync(at(".claude"), { recursive: true });
    fs.symlinkSync(at("elsewhere"), at(".claude/state"));
    const ok = run(hookCmd("talk-guard.sh"), send("lane-manager"), as("lane-video"));
    expect(ok.status).toBe(0);
    expect(ok.stderr).toContain("talk log not written");
    expect(fs.readdirSync(at("elsewhere"))).toEqual([]);
  });
});

describe.skipIf(!hasJq)("[N44c] P3 guard input checks", () => {
  const as = (id: string) => ({ AT_SESSION: id });
  it("[N44c] P3 a bracket suffix on to must be [A-Za-z0-9_-]+ or the send is refused", () => {
    scaffold();
    const talk = hookCmd("talk-guard.sh");
    expect(run(talk, send("lane-manager [ab_1-2]"), as("lane-video")).status).toBe(0);
    for (const bad of ["lane-manager [a b]", "lane-manager [$(id)]", "lane-manager []", "lane-manager [a;b]", "lane-manager [x] "]) {
      expect(run(talk, send(bad), as("lane-video")).status, JSON.stringify(bad)).toBe(2);
    }
    expect(talkLines().filter((l) => l.result === "refused")).toHaveLength(5);
  });
  it("[N44c] P3 subagent_type false and any non-string subagent_type is refused (exit 2)", () => {
    scaffold();
    const spawnCmd = hookCmd("spawn-guard.sh");
    for (const v of [false, 0, true, [], {}, ["lane-build"]]) {
      expect(run(spawnCmd, spawn({ subagent_type: v })).status, JSON.stringify(v)).toBe(2);
    }
    expect(run(spawnCmd, spawn({ subagent_type: "helper" })).status).toBe(0);
    expect(run(spawnCmd, spawn({ prompt: "x" })).status).toBe(0);
  });
  it("[N44c] P3 a hostile place is never printed raw in the sessions.md heading", () => {
    const ast = parse(src);
    (ast.nodes.find((n: any) => n.id === "lane-video") as any).place = "x\n# injected\n$(echo INJECTED)";
    const md = quiet(() => generateSessionFiles(ast)).find((f) => f.path === ".claude/sessions.md")!.content;
    expect(md).not.toContain("INJECTED");
    expect(md).not.toContain("# injected");
  });
});

describe("[N44c] P3 scaffold --prune removes a stale launcher", () => {
  it("[N44c] P3 when no session agents remain, --prune deletes scripts/start-sessions.sh", () => {
    if (!fs.existsSync(CLI)) execFileSync("npx", ["tsc"], { cwd: resolve(here, "../../.."), stdio: "ignore" });
    const file = at("s.at");
    fs.writeFileSync(file, src);
    const sc = (...x: string[]) => spawnSync(process.execPath, [CLI, "scaffold", file, "--target", "claude-code", "--output", at("proj"), ...x], { encoding: "utf8" });
    expect(sc().status).toBe(0);
    expect(fs.existsSync(at("proj/scripts/start-sessions.sh"))).toBe(true);
    fs.writeFileSync(file, src.replace(/^\s*runs: session$/gm, "").replace(/^\s*place: \w+$/gm, "").replace("talk: hub lane-manager", "lane-manager -> lane-video\n    lane-manager -> lane-text"));
    const r = sc("--prune");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(fs.existsSync(at("proj/scripts/start-sessions.sh"))).toBe(false);
  });
});
