/**
 * P-1: a hook's identity in settings.json is its event, matcher and command,
 * AND its `if`, timeout, onFailure (strength) and async.
 *
 * Measured on 0.11.2 and main: two .at hooks on one script and matcher with
 * different `if:` were written as two hooks by the first scaffold; after any
 * edit to settings.json the next scaffold merged them as one and deleted the
 * second (the merge keyed a hook by matcher and command only). And a timeout
 * changed in the .at never reached settings.json: the old entry was kept as
 * "the same hook".
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../../../dist/cli/index.js");

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(join(os.tmpdir(), "at-p1-"));
  fs.mkdirSync(join(root, ".claude/hooks"), { recursive: true });
  fs.writeFileSync(join(root, ".claude/hooks/x.sh"), "#!/bin/bash\nexit 0\n");
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const hook = (id: string, run: string, extra = "") =>
  `    hook ${id} {\n      on: PreToolUse\n      matcher: "Bash"\n      run: ${JSON.stringify(run)}\n      type: command\n${extra}    }`;
const at = (...hooks: string[]) => [
  "topology t : [pipeline] {",
  "  meta {", '    version: "1.0.0"', '    description: "t"', "  }",
  "  orchestrator {", "    model: sonnet", "  }",
  "  agent a {", "    model: sonnet", '    description: "a"', "  }",
  "  agent b {", "    model: sonnet", '    description: "b"', "  }",
  "  flow { a -> b }",
  "  hooks {", ...hooks, "  }",
  "}",
].join("\n");
const scaffold = () => spawnSync(process.execPath, [CLI, "scaffold", "t.at", "--target", "claude-code"], { cwd: root, encoding: "utf8" });
const settings = () => JSON.parse(fs.readFileSync(join(root, ".claude/settings.json"), "utf8"));
const handlers = (): Array<Record<string, unknown>> =>
  (settings().hooks?.PreToolUse ?? []).flatMap((g: { hooks: Array<Record<string, unknown>> }) => g.hooks);
const editSettings = () => {
  const s = settings();
  s.statusLine = { type: "command", command: "echo hi" };
  fs.writeFileSync(join(root, ".claude/settings.json"), JSON.stringify(s, null, 2));
};
const userSettings = (command: string, extra: Record<string, unknown> = {}) =>
  fs.writeFileSync(join(root, ".claude/settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command, ...extra }] }] } }, null, 2));

describe("P-1: two hooks on one script and matcher stay two", () => {
  it("[P-1] different if: survives an edit to settings.json and a second scaffold", () => {
    fs.writeFileSync(join(root, "t.at"), at(
      hook("g1", "scripts/guard.sh", '      if: "Bash(rm *)"\n'),
      hook("g2", "scripts/guard.sh", '      if: "Bash(git push *)"\n'),
    ));
    expect(scaffold().status).toBe(0);
    expect(handlers().map((h) => h.if).sort()).toEqual(["Bash(git push *)", "Bash(rm *)"]);
    editSettings();
    expect(scaffold().status).toBe(0);
    expect(handlers().map((h) => h.if).sort()).toEqual(["Bash(git push *)", "Bash(rm *)"]);
  });

  it("[P-1] a timeout changed in the .at is the same hook, updated (one entry, the new timeout)", () => {
    fs.writeFileSync(join(root, "t.at"), at(hook("g", "scripts/guard.sh", "      timeout: 5\n")));
    expect(scaffold().status).toBe(0);
    editSettings();
    fs.writeFileSync(join(root, "t.at"), at(hook("g", "scripts/guard.sh", "      timeout: 9\n")));
    expect(scaffold().status).toBe(0);
    expect(handlers().filter((h) => String(h.command).includes("guard.sh")).map((h) => h.timeout)).toEqual([9]);
  });

  it("[P-1] the same, on the user's own project script: the entry the last scaffold wrote is replaced", () => {
    fs.writeFileSync(join(root, "t.at"), at(hook("g", ".claude/hooks/x.sh", "      timeout: 5\n")));
    expect(scaffold().status).toBe(0);
    editSettings();
    fs.writeFileSync(join(root, "t.at"), at(hook("g", ".claude/hooks/x.sh", "      timeout: 9\n")));
    expect(scaffold().status).toBe(0);
    expect(handlers().filter((h) => String(h.command).includes("x.sh")).map((h) => h.timeout)).toEqual([9]);
  });

  it("[P-1] strength: refuse added in the .at reaches settings.json (onFailure: block), one entry", () => {
    fs.writeFileSync(join(root, "t.at"), at(hook("g", "scripts/guard.sh")));
    expect(scaffold().status).toBe(0);
    editSettings();
    fs.writeFileSync(join(root, "t.at"), at(hook("g", "scripts/guard.sh", "      strength: refuse\n")));
    expect(scaffold().status).toBe(0);
    expect(handlers().filter((h) => String(h.command).includes("guard.sh")).map((h) => h.onFailure)).toEqual(["block"]);
  });
});

describe("P-1: a user's hook and the .at's on the same script, with different fields, are both kept", () => {
  it("[P-1] user's if A, the .at's if B (f2 case 6)", () => {
    userSettings('bash "$CLAUDE_PROJECT_DIR/.claude/hooks/x.sh"', { if: "Bash(rm *)" });
    fs.writeFileSync(join(root, "t.at"), at(hook("g", ".claude/hooks/x.sh", '      if: "Bash(git push *)"\n')));
    expect(scaffold().status).toBe(0);
    expect(handlers().map((h) => h.if).sort()).toEqual(["Bash(git push *)", "Bash(rm *)"]);
  });

  it("[P-1] user's timeout 1, the .at's timeout 600000 (f2 case 14)", () => {
    userSettings('bash "$CLAUDE_PROJECT_DIR/.claude/hooks/x.sh"', { timeout: 1 });
    fs.writeFileSync(join(root, "t.at"), at(hook("g", ".claude/hooks/x.sh", "      timeout: 600000\n")));
    expect(scaffold().status).toBe(0);
    expect(handlers().map((h) => h.timeout).sort()).toEqual([1, 600000]);
  });

  it("[P-1] user's hook, the .at's adds strength: refuse (f2 case 5): the user's is kept", () => {
    userSettings('bash "$CLAUDE_PROJECT_DIR/.claude/hooks/x.sh"');
    fs.writeFileSync(join(root, "t.at"), at(hook("g", ".claude/hooks/x.sh", "      strength: refuse\n")));
    expect(scaffold().status).toBe(0);
    expect(handlers().map((h) => h.onFailure ?? "none").sort()).toEqual(["block", "none"]);
  });

  it("[P-1] two .at hooks, same script, different if, first scaffold (f2 case 7)", () => {
    fs.writeFileSync(join(root, "t.at"), at(
      hook("g1", "scripts/guard.sh", '      if: "Bash(rm *)"\n'),
      hook("g2", "scripts/guard.sh", '      if: "Bash(git push *)"\n'),
    ));
    expect(scaffold().status).toBe(0);
    expect(handlers()).toHaveLength(2);
  });
});
