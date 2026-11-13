/**
 * Findings F-6..F-29 (batch b): generated safety checks fail closed and their
 * reports say what holds. Each test plants the case the finding named and runs
 * the generated output the way the host runs it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { codexBinding } from "../../bindings/codex.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, "../../../dist/cli/index.js");
const FIXTURE = resolve(here, "fixtures/codex-gates.at");
const hasJq = spawnSync("/bin/sh", ["-c", "command -v jq"]).status === 0;
// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

let root: string;
const at = (p: string) => join(root, p);

function quiet<T>(fn: () => T): T {
  const w = vi.spyOn(console, "warn").mockImplementation(() => {});
  try { return fn(); } finally { w.mockRestore(); }
}

type Binding = { scaffold(ast: ReturnType<typeof parse>): Array<{ path: string; content: string; executable?: boolean }> };
function scaffoldInto(src: string, dir = root, binding: Binding = codexBinding) {
  const files = quiet(() => binding.scaffold(parse(src)));
  for (const f of files) {
    const p = join(dir, f.path);
    fs.mkdirSync(dirname(p), { recursive: true });
    fs.writeFileSync(p, f.content);
    if (f.executable) fs.chmodSync(p, 0o755);
  }
  return files;
}

const cli = (args: string[], cwd = root) => {
  const r = spawnSync("node", [CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  return { ...r, out: plain((r.stdout ?? "") + (r.stderr ?? "")) };
};

beforeEach(() => { root = fs.mkdtempSync(join(os.tmpdir(), "at-fb-")); spawnSync("git", ["init", "-q", root]); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("[F-20/F-27] validate --target codex prints the Codex version line", () => {
  it("[F-27] plain validate --target codex names Codex CLI, not Claude Code", () => {
    const r = cli(["validate", FIXTURE, "--target", "codex"]);
    expect(r.out).toContain("checked against Codex CLI");
    expect(r.out).not.toContain("checked against Claude Code");
  });
  it("[F-27] validate --target codex --inventory names Codex CLI, not Claude Code", () => {
    cli(["scaffold", FIXTURE, "--target", "codex", "--dir", root]);
    const r = cli(["validate", FIXTURE, "--target", "codex", "--inventory", root]);
    expect(r.out).toContain("checked against Codex CLI");
    expect(r.out).not.toContain("checked against Claude Code");
  });
  it("[F-27] validate with no target still names Claude Code", () => {
    expect(cli(["validate", FIXTURE]).out).toContain("checked against Claude Code");
  });
});

describe("[F-28] inventory on a Codex-only scaffold", () => {
  it("[F-28] the scaffold manifest is mapped and no Claude Code file is listed as not scaffolded", () => {
    cli(["scaffold", FIXTURE, "--target", "codex", "--dir", root]);
    expect(fs.existsSync(at(".codex/.scaffold-manifest.json"))).toBe(true);
    const r = cli(["validate", FIXTURE, "--target", "codex", "--inventory", root]);
    expect(r.out).not.toContain(".scaffold-manifest.json");
    expect(r.out).not.toMatch(/not scaffolded/);
    expect(r.out).toMatch(/coverage: (\d+) of \1 /);
  });
});
