/**
 * [T08] [L4] coverage of what a run really reads, and state outside the repo.
 * HOME is always pointed at a temp dir; the real home is never read.
 * The CLI is the built one (global setup builds it).
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { resolve, dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { VERIFIED_ON } from "../../conformance/claude-code.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../../..");
const CLI = resolve(ROOT, "dist/cli/index.js");
const PIN = resolve(here, "fixtures/inv-pin");
const emptyBin = fs.mkdtempSync(join(os.tmpdir(), "at-g1-bin-"));
const fakeHome = fs.mkdtempSync(join(os.tmpdir(), "at-g1-home-"));

function cli(cwd: string, args: string[], home = fakeHome) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd, encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home, PATH: emptyBin, NO_COLOR: "1", AGENTOPOLOGY_CLAUDE_VERSION: VERIFIED_ON },
  });
  return { out: r.stdout, err: r.stderr, status: r.status, all: `${r.stdout}${r.stderr ? "--- stderr\n" + r.stderr : ""}--- exit ${r.status}\n` };
}

function project(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "at-g1-proj-"));
  for (const [p, c] of Object.entries(files)) {
    fs.mkdirSync(dirname(join(dir, p)), { recursive: true });
    fs.writeFileSync(join(dir, p), c);
  }
  return dir;
}

const examples = fs.readdirSync(join(ROOT, "examples")).filter((f) => f.endsWith(".at")).map((f) => join("examples", f));
describe("[T08] one file keeps today's validate --inventory output", () => {
  const proj = resolve(here, "fixtures/handbuilt");
  for (const f of examples) {
    it(`[T08] validate --inventory ${f}`, async () => {
      const abs = join(ROOT, f);
      const out = cli(ROOT, ["validate", f, "--inventory", proj]).all.replaceAll(abs, f).replaceAll(proj, "<proj>").replace(/^checked against Claude Code .*$/m, "<version line>");
      await expect(out).toMatchFileSnapshot(join(PIN, `${basename(f, ".at")}.txt`));
    });
  }
});
