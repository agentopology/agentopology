/**
 * [RW-3] The tick: new versions from the npm registry.
 * Fixtures are saved cuts of the real registry documents (fetched 2026-11-13);
 * nothing here touches the network.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { newVersions, isStableCodex, compareVersions, tickExitCode } from "../../watch/versions.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const fx = (n: string) => JSON.parse(fs.readFileSync(resolve(here, "fixtures", n), "utf8"));
const claude = fx("claude-code.registry.json");
const codex = fx("codex.registry.json");

describe("[RW-3] the tick", () => {
  it("[RW-3] Claude Code: state 2.1.319 gives exactly 2.1.321, 2.1.322, 2.1.323 (2.1.320 was never published)", () => {
    const r = newVersions("claude-code", claude, "2.1.319");
    expect(r.versions).toEqual(["2.1.321", "2.1.322", "2.1.323"]);
    expect(r.latest).toBe("2.1.323");
    expect(r.stable).toBe("2.1.311");
  });

  it("[RW-3] Claude Code: skips 2.1.313, which was never published, and does not count '+1'", () => {
    const r = newVersions("claude-code", claude, "2.1.312");
    expect(r.versions.slice(0, 2)).toEqual(["2.1.314", "2.1.315"]);
    expect(r.versions).not.toContain("2.1.313");
  });

  it("[RW-3] Claude Code: no change when state is latest", () => {
    expect(newVersions("claude-code", claude, "2.1.323").versions).toEqual([]);
  });

  it("[RW-3] Codex: state 0.167.2 gives exactly 0.168.0, dropping 0.171.0-alpha.1 and 0.168.0-darwin-arm64", () => {
    expect(newVersions("codex", codex, "0.167.2").versions).toEqual(["0.168.0"]);
    expect(Object.keys(codex.time)).toContain("0.171.0-alpha.1");
    expect(Object.keys(codex.time)).toContain("0.168.0-darwin-arm64");
  });

  it("[RW-3] Codex filter: stable only", () => {
    expect(isStableCodex("0.168.0")).toBe(true);
    expect(isStableCodex("0.168.0-darwin-arm64")).toBe(false);
    expect(isStableCodex("0.171.0-alpha.1")).toBe(false);
    expect(isStableCodex("0.1.2505172116")).toBe(true);
  });

  it("[RW-3] versions compare numerically, not as text", () => {
    expect(compareVersions("2.1.99", "2.1.100")).toBeLessThan(0);
    expect(compareVersions("0.168.0", "0.167.2")).toBeGreaterThan(0);
  });

  it("[RW-3] an unknown last-seen version gives only versions published after its time, or all when absent", () => {
    const r = newVersions("claude-code", claude, "2.1.100");
    expect(r.versions[0]).toBe("2.1.295");
    expect(r.versions.at(-1)).toBe("2.1.323");
  });

  it("[RW-3] exit code: 0 on no change, 10 on new versions", () => {
    expect(tickExitCode([])).toBe(0);
    expect(tickExitCode(["2.1.321"])).toBe(10);
  });
});

describe("[RW-3] scripts/release-watch/tick.mjs", () => {
  const script = resolve(root, "scripts/release-watch/tick.mjs");
  const run = (platform: string, fixture: string, since: string) =>
    spawnSync(process.execPath, [script, "--platform", platform, "--registry-file", resolve(here, "fixtures", fixture), "--since", since],
      { encoding: "utf8", env: { ...process.env, HOME: fs.mkdtempSync(join(os.tmpdir(), "at-rw3-")) } });

  it("[RW-3] exits 10 and prints the new versions as JSON", () => {
    const r = run("claude-code", "claude-code.registry.json", "2.1.319");
    expect(r.status).toBe(10);
    expect(JSON.parse(r.stdout).versions).toEqual(["2.1.321", "2.1.322", "2.1.323"]);
  });

  it("[RW-3] exits 0 on no change", () => {
    const r = run("codex", "codex.registry.json", "0.168.0");
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).versions).toEqual([]);
  });

  it("[RW-3] a registry file with no time list exits 2 (the watch is broken, not quiet)", () => {
    const dir = fs.mkdtempSync(join(os.tmpdir(), "at-rw3-"));
    const f = join(dir, "bad.json");
    fs.writeFileSync(f, JSON.stringify({ name: "x", "dist-tags": {} }));
    const r = spawnSync(process.execPath, [script, "--platform", "codex", "--registry-file", f, "--since", "0.1.0"], { encoding: "utf8" });
    expect(r.status).toBe(2);
  });
});
