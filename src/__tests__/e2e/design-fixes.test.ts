/**
 * [D-n] Design-review fixes (2026-11-13): findings from the design review of the
 * guards and of `guard --check`, each closed red-first.
 *
 * The scripts run the way each host runs a hook: a shell, the event's JSON on
 * stdin; CLAUDE_PROJECT_DIR set on Claude Code, no variable on Codex.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import { codexBinding } from "../../bindings/codex.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "fixtures/codex-gates.at");
const SRC = fs.readFileSync(FIXTURE, "utf8");
const hasJq = spawnSync("/bin/sh", ["-c", "command -v jq"]).status === 0;

type Target = "claude-code" | "codex";
const TARGETS: Target[] = ["claude-code", "codex"];
const DIR: Record<Target, string> = { "claude-code": ".claude/skills/ship/scripts", codex: ".codex/scripts/ship" };

let root: string;
const at = (p: string) => join(root, p);

function quiet<T>(fn: () => T): T {
  const w = vi.spyOn(console, "warn").mockImplementation(() => {});
  const l = vi.spyOn(console, "log").mockImplementation(() => {});
  try { return fn(); } finally { w.mockRestore(); l.mockRestore(); }
}

function scaffold(target: Target, src = SRC) {
  const ast = parse(src);
  const files = quiet(() => (target === "codex" ? codexBinding : claudeCodeBinding).scaffold(ast));
  for (const f of files) {
    fs.mkdirSync(dirname(at(f.path)), { recursive: true });
    fs.writeFileSync(at(f.path), f.content);
    if (f.executable) fs.chmodSync(at(f.path), 0o755);
  }
  return { ast, files };
}

/** Run a generated guard the way its host runs a hook. */
function hook(target: Target, file: string, stdin: string) {
  const env = { ...process.env } as Record<string, string>;
  if (target === "claude-code") env.CLAUDE_PROJECT_DIR = root;
  else delete env.CLAUDE_PROJECT_DIR;
  return spawnSync("/bin/sh", ["-c", `bash "${root}/${DIR[target]}/${file}"`], {
    cwd: root, input: stdin, env, encoding: "utf8", timeout: 20_000,
  });
}
const bash = (command: string) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
const okRecord = (path: string, unit: string) => {
  fs.mkdirSync(dirname(at(path)), { recursive: true });
  fs.appendFileSync(at(path), JSON.stringify({ step: "render", unit, ok: true }) + "\n");
};

beforeEach(() => { root = fs.mkdtempSync(join(os.tmpdir(), "at-design-")); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// D-1
// ---------------------------------------------------------------------------

describe.skipIf(!hasJq)("[D-1] Claude Code: the action script's gate check gets no usage exemption", () => {
  const run = (args: string[]) => {
    const e = { ...process.env } as Record<string, string>;
    delete e.CLAUDE_PROJECT_DIR;
    return spawnSync("bash", [".claude/skills/ship/scripts/action-publish.sh", ...args], { cwd: root, env: e, encoding: "utf8" });
  };
  const setup = () => {
    scaffold("claude-code");
    // the step's side effect: ./tool logs what it ran
    fs.writeFileSync(at("tool"), `#!/usr/bin/env bash\necho "$*" >> "${root}/ran.txt"\n`, { mode: 0o755 });
  };
  for (const arg of ["--help", "-h", "--version", "ep1"]) {
    it(`[D-1] with no ledger, bash action-publish.sh ${arg} exits non-zero and ./tool never runs`, () => {
      setup();
      const r = run([arg]);
      expect(r.status, r.stderr).not.toBe(0);
      expect(fs.existsSync(at("ran.txt"))).toBe(false);
    });
  }
  it("[D-1] with no argument it does not run either (no unit)", () => {
    setup();
    expect(run([]).status).not.toBe(0);
    expect(fs.existsSync(at("ran.txt"))).toBe(false);
  });
  it("[D-1] with an ok record for ep1, action-publish.sh ep1 runs; ep1 --help and two words do not", () => {
    setup();
    okRecord("logs/ep1/trace.jsonl", "ep1");
    expect(run(["ep1", "--help"]).status).not.toBe(0);
    expect(run(["ep1", "ep2"]).status).not.toBe(0);
    expect(fs.existsSync(at("ran.txt"))).toBe(false);
    const r = run(["ep1"]);
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readFileSync(at("ran.txt"), "utf8")).toContain("publish");
  });
  it("[D-1] before-action.sh honors AT_NO_USAGE=1: `./tool publish --help` is a step then", () => {
    setup();
    const env = { ...process.env, CLAUDE_PROJECT_DIR: root } as Record<string, string>;
    const sh = `${root}/${DIR["claude-code"]}/before-action.sh`;
    const plain = spawnSync("bash", [sh], { cwd: root, input: bash("./tool publish --help"), env, encoding: "utf8" });
    expect(plain.status, plain.stderr).toBe(0);
    const strict = spawnSync("bash", [sh], { cwd: root, input: bash("./tool publish --help"), env: { ...env, AT_NO_USAGE: "1" }, encoding: "utf8" });
    expect(strict.status).toBe(2);
  });
});
