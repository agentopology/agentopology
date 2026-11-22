/**
 * `agentopology fix <file.at> [--target <binding>] [--write]`, end to end on
 * the built CLI.
 *
 * Exit codes: 0 nothing (left) to fix; 2 a dry run found gates to fix
 * (nothing written); 1 an error (no file, a parse error, an unknown target, a
 * gate it cannot edit in place, or a V135 error left after --write).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const CLI = resolve(root, "dist/cli/index.js");
const FIXTURE = resolve(root, "src/fix/__tests__/fixtures/v135-fix.at");

function run(args: string[], cwd = root): { out: string; code: number } {
  try {
    const out = execFileSync("node", [CLI, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], cwd, env: { ...process.env, NO_COLOR: "1" } });
    return { out, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { out: `${e.stdout ?? ""}${e.stderr ?? ""}`, code: e.status ?? 1 };
  }
}

const V135_GATES = ["needs-source", "after-approval", "cited", "orphan-check"];
const FINE_GATES = ["lint-gate", "draft-ok", "deploy-ok", "style", "by-hand"];

let dir: string;
let file: string;
let original: Buffer;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "at-fix-"));
  file = join(dir, "harness.at");
  copyFileSync(FIXTURE, file);
  original = readFileSync(file);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** The output's lines that name a gate to fix. */
const listed = (out: string) => [...out.matchAll(/^\s*gate "([^"]+)"/gm)].map((m) => m[1]);

describe("agentopology fix (dry run)", () => {
  it("lists exactly the V135 gates, exits 2, and changes nothing", () => {
    const { out, code } = run(["fix", file]);
    expect(code).toBe(2);
    expect(listed(out)).toEqual(V135_GATES);
    for (const g of FINE_GATES) expect(out).not.toContain(`gate "${g}"`);
    expect(readFileSync(file).equals(original)).toBe(true);
    expect(out).toContain("Nothing written");
    expect(out).toContain("--write");
  });

  it("says why no hook runs each gate, the fix, and the anchor as a suggestion only", () => {
    const { out } = run(["fix", file]);
    expect(out).toContain('no after: target and before: "finish" (an action with no commands:), not a subagent or a script step');
    expect(out).toContain("strength: hope");
    expect(out).toMatch(/after: reviewer/);
    expect(out).toMatch(/before: deploy/);
    expect(out).toMatch(/not applied/);
  });

  it("exits 0 on a topology with nothing to fix", () => {
    const { out, code } = run(["fix", resolve(root, "examples/simple-pipeline.at")]);
    expect(code).toBe(0);
    expect(out).toContain("Nothing to fix");
  });

  it("--target cursor: V135 does not apply, exit 0, nothing written", () => {
    const { out, code } = run(["fix", file, "--target", "cursor"]);
    expect(code).toBe(0);
    expect(out).toContain("V135 does not apply");
    expect(readFileSync(file).equals(original)).toBe(true);
  });

  it("an unknown target, a missing file and no file argument exit 1", () => {
    expect(run(["fix", file, "--target", "nope"]).code).toBe(1);
    expect(run(["fix", join(dir, "missing.at")]).code).toBe(1);
    expect(run(["fix"]).code).toBe(1);
  });

  it("is listed in --help", () => {
    expect(run(["--help"]).out).toMatch(/agentopology fix <file\.at>/);
  });
});

describe("agentopology fix --write", () => {
  it("inserts only the strength: hope lines; the rest of the file is byte-identical", () => {
    const { out, code } = run(["fix", file, "--write"]);
    expect(code).toBe(0);
    const before = original.toString("utf8").split("\n");
    const after = readFileSync(file, "utf8").split("\n");
    // Three inserted lines; one line where refuse became hope.
    expect(after.length).toBe(before.length + 3);
    const inserted: string[] = [];
    let i = 0;
    for (const line of after) {
      if (i < before.length && line === before[i]) { i++; continue; }
      if (i < before.length && before[i] === "      strength: refuse   # we thought so" && line === "      strength: hope   # we thought so") { i++; continue; }
      inserted.push(line);
    }
    expect(i).toBe(before.length);
    expect(inserted).toEqual(["      strength: hope", "      strength: hope", "      strength: hope"]);
    expect(listed(out)).toEqual(V135_GATES);
    expect(out).toContain("no V135 error left");
  });

  it("validate then has no V135 error", () => {
    run(["fix", file, "--write"]);
    const v = run(["validate", file]);
    expect(v.out).not.toContain("ERROR [V135]");
    expect(v.code).toBe(0);
  });

  it("running it twice is a no-op: exit 0, nothing to fix, file unchanged", () => {
    run(["fix", file, "--write"]);
    const once = readFileSync(file);
    const second = run(["fix", file, "--write"]);
    expect(second.code).toBe(0);
    expect(second.out).toContain("Nothing to fix");
    expect(readFileSync(file).equals(once)).toBe(true);
    const dry = run(["fix", file]);
    expect(dry.code).toBe(0);
  });

  it("a gate it cannot edit in place is left as written and exits 1", () => {
    const src = original.toString("utf8").replace(
      `    gate orphan-check {\n      run: "scripts/orphan.sh"\n    }`,
      `    gate orphan-check { run: "scripts/orphan.sh" }`,
    );
    writeFileSync(file, src);
    const { out, code } = run(["fix", file, "--write"]);
    expect(code).toBe(1);
    expect(out).toContain("by hand");
    const now = readFileSync(file, "utf8");
    expect(now).toContain(`    gate orphan-check { run: "scripts/orphan.sh" }`);
    expect(now.split("\n").filter((l) => l === "      strength: hope")).toHaveLength(2);
  });
});
