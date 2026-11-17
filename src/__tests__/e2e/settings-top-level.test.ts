/**
 * Warn only: agentopology 0.11.4 and earlier scaffolded an extension's
 * `deny` / `allow` into the top level of .claude/settings.json as JSON
 * strings, and hand-written files put `allow` / `deny` / `ask` lists there
 * too. Claude Code reads permission rules only under `permissions`, so those
 * rules refuse nothing. `validate --inventory`, `guard --check` and
 * `scaffold` now say so and print the move. Nothing is rewritten and no exit
 * code changes.
 *
 * Runs the built CLI in temp dirs.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, "../../../dist/cli/index.js");
const FIX = resolve(here, "fixtures/top-level-perms");
/** settings.json exactly as `agentopology@0.11.4 scaffold ext-0114.at --target claude-code` wrote it. */
const SETTINGS_0114 = fs.readFileSync(join(FIX, "settings-0114.json"), "utf8");
const EXT_AT = join(FIX, "ext-0114.at");

const topo = (settings: string) => `topology tl : [pipeline] {
  meta {
    version: "1.0.0"
    description: "tl"
  }
  agent a {
    model: sonnet
    description: "a"
  }
  agent b {
    model: sonnet
    description: "b"
  }
${settings}
  flow { a -> b }
}
`;

let root: string;

function cli(args: string[], cwd = root) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
function writeSettings(name: string, text: string): void {
  fs.mkdirSync(join(root, ".claude"), { recursive: true });
  fs.writeFileSync(join(root, ".claude", name), text);
}
/** The warning lines, trimmed, in print order. */
function warnings(out: { stdout: string; stderr: string }): string[] {
  return (out.stdout + out.stderr).split("\n").map((l) => l.trim()).filter((l) => l.includes("at the top level"));
}
const warn = (file: string, key: string, rules: string) =>
  `! ${file}: "${key}" at the top level is not read by Claude Code; move ${rules} into "permissions": { "${key}": [...] }`;

const guardCheck = (file: string) => cli(["guard", file, "--check", "--dir", root]);
const inventory = (file: string) => cli(["validate", file, "--inventory", root]);

beforeEach(() => { root = fs.mkdtempSync(join(os.tmpdir(), "at-toplevel-")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe("settings.json: allow, deny or ask at the top level", () => {
  it("the 0.11.4 string shape: guard --check and validate --inventory print the rules parsed from the string and the move", () => {
    writeSettings("settings.json", SETTINGS_0114);
    const expected = [
      warn(".claude/settings.json", "deny", `["Read(./.env)", "Bash(rm -rf *)"]`),
      warn(".claude/settings.json", "allow", `["Bash(npm test)"]`),
    ];
    const g = guardCheck(EXT_AT);
    const v = inventory(EXT_AT);
    expect(warnings(g)).toEqual(expected);
    expect(warnings(v)).toEqual(expected);

    // A warning alone changes no exit code: the same project without the top-level keys exits the same.
    writeSettings("settings.json", "{}\n");
    expect(guardCheck(EXT_AT).status).toBe(g.status);
    expect(inventory(EXT_AT).status).toBe(v.status);
    // And the file is not touched by either command.
    writeSettings("settings.json", SETTINGS_0114);
    guardCheck(EXT_AT);
    inventory(EXT_AT);
    expect(fs.readFileSync(join(root, ".claude/settings.json"), "utf8")).toBe(SETTINGS_0114);
  });

  it("a hand-written list shape: one line per key, in the file's order; a key already under permissions is not named", () => {
    writeSettings("settings.json", JSON.stringify({ allow: ["Bash(ls *)"], deny: ["Bash(rm -rf *)", "Read(./.env)"], permissions: { ask: ["Bash(git push *)"] } }, null, 2) + "\n");
    const at = join(root, "tl.at");
    fs.writeFileSync(at, topo(""));
    const expected = [
      warn(".claude/settings.json", "allow", `["Bash(ls *)"]`),
      warn(".claude/settings.json", "deny", `["Bash(rm -rf *)", "Read(./.env)"]`),
    ];
    expect(warnings(guardCheck(at))).toEqual(expected);
    expect(warnings(inventory(at))).toEqual(expected);
  });

  it("settings.local.json: the line names that file", () => {
    writeSettings("settings.json", "{}\n");
    writeSettings("settings.local.json", JSON.stringify({ ask: ["Bash(git push *)"] }) + "\n");
    const at = join(root, "tl.at");
    fs.writeFileSync(at, topo(""));
    const expected = [warn(".claude/settings.local.json", "ask", `["Bash(git push *)"]`)];
    expect(warnings(guardCheck(at))).toEqual(expected);
    expect(warnings(inventory(at))).toEqual(expected);
  });

  it("no top-level allow, deny or ask (rules under permissions, or a string that holds no list): no warning", () => {
    writeSettings("settings.json", JSON.stringify({ permissions: { allow: ["Bash(ls *)"], deny: ["Bash(rm -rf *)"], ask: ["Bash(git push *)"] }, hooks: {} }, null, 2) + "\n");
    writeSettings("settings.local.json", JSON.stringify({ deny: "not a list" }) + "\n");
    const at = join(root, "tl.at");
    fs.writeFileSync(at, topo(""));
    const g = guardCheck(at);
    const v = inventory(at);
    expect(warnings(g)).toEqual([]);
    expect(warnings(v)).toEqual([]);
    expect(g.stdout + g.stderr).not.toContain("! .claude/");
    expect(v.stdout + v.stderr).not.toContain("! .claude/");
  });

  it("a rule the .at declares that sits only at the top level: today's missing-rule note stays, the move is printed", () => {
    writeSettings("settings.json", JSON.stringify({ deny: ["Bash(rm -rf *)"] }) + "\n");
    const at = join(root, "tl.at");
    fs.writeFileSync(at, topo(`  settings {\n    deny: ["Bash(rm -rf *)"]\n  }`));
    const g = guardCheck(at);
    expect(g.stdout).toContain(".claude/settings.json has no deny rule Bash(rm -rf *)");
    expect(warnings(g)).toEqual([warn(".claude/settings.json", "deny", `["Bash(rm -rf *)"]`)]);
    expect(g.status).toBe(1);
  });

  it("scaffold over the 0.11.4 file keeps the top-level keys where they are and prints the move", () => {
    writeSettings("settings.json", SETTINGS_0114);
    const s = cli(["scaffold", EXT_AT, "--target", "claude-code", "--output", root]);
    expect(s.status).toBe(0);
    const after = JSON.parse(fs.readFileSync(join(root, ".claude/settings.json"), "utf8"));
    const before = JSON.parse(SETTINGS_0114);
    expect(after.deny).toBe(before.deny);
    expect(after.allow).toBe(before.allow);
    expect(warnings(s)).toEqual([
      warn(".claude/settings.json", "deny", `["Read(./.env)", "Bash(rm -rf *)"]`),
      warn(".claude/settings.json", "allow", `["Bash(npm test)"]`),
    ]);
  });
});
