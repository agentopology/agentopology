/**
 * Review findings R-1..R-12 on the Codex binding (and the guards it shares
 * with Claude Code). Each test plants the case the review named and runs the
 * generated script the way the host runs it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import { codexBinding } from "../../bindings/codex.js";
import { isVerifiedVersion, verifiedListProblems } from "../../conformance/claude-code.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "fixtures/codex-gates.at");
const hasJq = spawnSync("/bin/sh", ["-c", "command -v jq"]).status === 0;

let root: string;
const at = (p: string) => join(root, p);

function quiet<T>(fn: () => T): T {
  const w = vi.spyOn(console, "warn").mockImplementation(() => {});
  try { return fn(); } finally { w.mockRestore(); }
}

/** Scaffold a source for Codex into `dir` (default: root). */
function scaffoldInto(src: string, dir = root) {
  const files = quiet(() => codexBinding.scaffold(parse(src)));
  for (const f of files) {
    const p = join(dir, f.path);
    fs.mkdirSync(dirname(p), { recursive: true });
    fs.writeFileSync(p, f.content);
    if (f.executable) fs.chmodSync(p, 0o755);
  }
  return files;
}

beforeEach(() => { root = fs.mkdtempSync(join(os.tmpdir(), "at-rfix-")); spawnSync("git", ["init", "-q", root]); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("[R-10] a verified-list entry counts only with a clean suite", () => {
  const list = (entry: object) => {
    const f = join(root, "verified.json");
    fs.writeFileSync(f, JSON.stringify({ versions: [entry] }));
    return f;
  };
  const withList = <T>(file: string, fn: () => T): T => {
    const old = process.env.AGENTOPOLOGY_VERIFIED_LIST;
    process.env.AGENTOPOLOGY_VERIFIED_LIST = file;
    try { return fn(); } finally { if (old === undefined) delete process.env.AGENTOPOLOGY_VERIFIED_LIST; else process.env.AGENTOPOLOGY_VERIFIED_LIST = old; }
  };

  it("[R-10] an entry whose suite failed 12 tests is a problem and the version reads unverified", () => {
    const entry = { version: "9.9.1", proof: { run: "X", date: "2026-11-13", suite: { passed: 3, failed: 12, skipped: 0 } } };
    expect(verifiedListProblems({ versions: [entry] }).length).toBe(1);
    expect(withList(list(entry), () => isVerifiedVersion("9.9.1"))).toBe(false);
  });

  it("[R-10] an entry with no suite is a problem and the version reads unverified", () => {
    const entry = { version: "9.9.2", proof: { run: "X", date: "2026-11-13" } };
    expect(verifiedListProblems({ versions: [entry] }).length).toBe(1);
    expect(withList(list(entry), () => isVerifiedVersion("9.9.2"))).toBe(false);
  });

  it("[R-10] an entry with a clean suite still counts", () => {
    const entry = { version: "9.9.3", proof: { run: "X", date: "2026-11-13", suite: { passed: 3, failed: 0, skipped: 0 } } };
    expect(verifiedListProblems({ versions: [entry] })).toEqual([]);
    expect(withList(list(entry), () => isVerifiedVersion("9.9.3"))).toBe(true);
  });
});
