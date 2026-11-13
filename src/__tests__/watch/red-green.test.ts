/**
 * [RW-11] The red-green gate: a planted test must be seen failing at its own
 * commit and passing at HEAD. Two fixture repos, saved as git bundles.
 * Repo A: the test passes at its own commit. Repo B: it fails there, passes at HEAD.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = resolve(here, "../../../scripts/release-watch/red-green.mjs");
const bundle = (n: string) => resolve(here, "fixtures/red-green", n);

function gate(...args: string[]) {
  const home = fs.mkdtempSync(join(os.tmpdir(), "at-rw11-"));
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { ...process.env, HOME: home } });
}

describe("[RW-11] red-green gate", () => {
  it("[RW-11] repo A: the test passes at its own commit, so the gate exits 1 and says 'never red'", () => {
    const r = gate("--repo", bundle("never-red.bundle"), "--test-commit", "planted", "--cmd", "sh test.sh");
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain("never red");
  });

  it("[RW-11] repo B: red at the test commit, green at HEAD; exit 0 and both exit codes printed", () => {
    const r = gate("--repo", bundle("red-then-green.bundle"), "--test-commit", "planted", "--cmd", "sh test.sh");
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/test commit [0-9a-f]{7,}: exit 1/);
    expect(r.stdout).toMatch(/HEAD [0-9a-f]{7,}: exit 0/);
  });

  it("[RW-11] a test still red at HEAD exits 1 and says so", () => {
    const r = gate("--repo", bundle("red-then-green.bundle"), "--test-commit", "planted", "--head", "planted", "--cmd", "sh test.sh");
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain("still red");
  });

  it("[RW-11] --json prints both exit codes as data", () => {
    const r = gate("--repo", bundle("red-then-green.bundle"), "--test-commit", "planted", "--cmd", "sh test.sh", "--json");
    const j = JSON.parse(r.stdout);
    expect(j.testCommit.exit).toBe(1);
    expect(j.head.exit).toBe(0);
    expect(j.verdict).toBe("red-then-green");
  });

  it("[RW-11] a missing ref or missing argument exits 2, never 0", () => {
    expect(gate("--repo", bundle("red-then-green.bundle"), "--test-commit", "no-such-ref", "--cmd", "true").status).toBe(2);
    expect(gate("--repo", bundle("red-then-green.bundle")).status).toBe(2);
  });

  it("[RW-11] the repo under test is not touched: the gate works in a clone", () => {
    const before = fs.statSync(bundle("red-then-green.bundle")).mtimeMs;
    gate("--repo", bundle("red-then-green.bundle"), "--test-commit", "planted", "--cmd", "sh test.sh");
    expect(fs.statSync(bundle("red-then-green.bundle")).mtimeMs).toBe(before);
  });
});
