/**
 * `agentopology --version` (and `-v`) prints the package's version and exits 0.
 * The built CLI is run (global setup builds dist/), so the version read is the
 * one a user's install reads.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const CLI = resolve(repo, "dist/cli/index.js");
const pkg = JSON.parse(fs.readFileSync(resolve(repo, "package.json"), "utf-8")) as { version: string };
const lock = JSON.parse(fs.readFileSync(resolve(repo, "package-lock.json"), "utf-8")) as { version: string; packages: Record<string, { version?: string }> };

describe("agentopology --version", () => {
  for (const flag of ["--version", "-v"]) {
    it(`${flag} prints the package.json version and exits 0`, () => {
      const r = spawnSync(process.execPath, [CLI, flag], { encoding: "utf-8" });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe(pkg.version);
    });
  }

  it("the package is 0.13.3, in package.json and package-lock.json", () => {
    expect(pkg.version).toBe("0.13.3");
    expect(lock.version).toBe("0.13.3");
    expect(lock.packages[""].version).toBe("0.13.3");
  });

  it("the help text names --version", () => {
    const r = spawnSync(process.execPath, [CLI, "--help"], { encoding: "utf-8" });
    expect(r.stdout).toContain("--version");
    expect(fs.readFileSync(resolve(repo, "README.md"), "utf-8")).toMatch(/agentopology --version/);
  });
});
