/**
 * F2: import then scaffold in one project left a hook in settings.json twice.
 *
 * Measured on 84bb938: the hook form Claude Code's docs give,
 * `"$CLAUDE_PROJECT_DIR"/.claude/hooks/x.sh`, came back from scaffold as
 * `bash "$CLAUDE_PROJECT_DIR/.claude/hooks/x.sh"`, and a PATH tool
 * `prettier --write .` as `command prettier --write .`. The merge saw two
 * hooks, kept the user's and added the twin, so both fired.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deepMergeSettingsJson } from "../../scaffold/merge.js";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../../../dist/cli/index.js");
const DOC_FORM = '"$CLAUDE_PROJECT_DIR"/.claude/hooks/x.sh';

const settings = (...commands: string[]) =>
  JSON.stringify({ hooks: { PostToolUse: [{ matcher: "Edit|Write", hooks: commands.map((command) => ({ type: "command", command })) }] } }, null, 2);
const settingsGroups = (...commands: string[]) =>
  JSON.stringify({ hooks: { PostToolUse: commands.map((command) => ({ matcher: "Edit|Write", hooks: [{ type: "command", command }] })) } }, null, 2);
const commandsOf = (raw: string): string[] =>
  (JSON.parse(raw).hooks.PostToolUse as Array<{ hooks: Array<{ command: string }> }>).flatMap((g) => g.hooks.map((h) => h.command));

describe("F2: the merge treats an equivalent hook as the same hook", () => {
  it("[F-2] the docs' project-dir form and scaffold's bash form are one hook; the user's is kept", () => {
    const merged = deepMergeSettingsJson(settings(DOC_FORM), settings('bash "$CLAUDE_PROJECT_DIR/.claude/hooks/x.sh"'), []);
    expect(commandsOf(merged)).toEqual([DOC_FORM]);
  });

  it("[F-2] a PATH tool and `command <tool>` are one hook; the user's is kept", () => {
    const merged = deepMergeSettingsJson(settings("prettier --write ."), settings("command prettier --write ."), []);
    expect(commandsOf(merged)).toEqual(["prettier --write ."]);
  });

  it("[F-2] a different matcher or a different command is still a second hook", () => {
    const other = JSON.stringify({ hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "command prettier --write ." }] }] } });
    expect(JSON.parse(deepMergeSettingsJson(settings("prettier --write ."), other, [])).hooks.PostToolUse).toHaveLength(2);
    expect(commandsOf(deepMergeSettingsJson(settings("prettier --write ."), settings("prettier --check ."), []))).toHaveLength(2);
  });
});

describe("F2: import then scaffold in place", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(join(os.tmpdir(), "at-f2-"));
    fs.mkdirSync(join(root, ".claude/agents"), { recursive: true });
    fs.mkdirSync(join(root, ".claude/hooks"), { recursive: true });
    fs.writeFileSync(join(root, ".claude/agents/a.md"), "---\nname: a\ndescription: An agent\n---\n\nBody.\n");
    fs.writeFileSync(join(root, ".claude/hooks/x.sh"), "#!/bin/bash\necho USER-SCRIPT\nexit 0\n");
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  const cli = (...args: string[]) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
    return { code: r.status, all: `${r.stdout}${r.stderr}` };
  };

  it.each([[DOC_FORM], ["prettier --write ."]])("[F-2] %s: one hook after scaffold, the user's, and one line names it", (cmd) => {
    fs.writeFileSync(join(root, ".claude/settings.json"), settings(cmd));
    expect(cli("import", "--target", "claude-code", "--dir", ".", "--name", "t").code).toBe(0);
    const sc = cli("scaffold", "t.at", "--target", "claude-code");
    expect(sc.code).toBe(0);
    expect(commandsOf(fs.readFileSync(join(root, ".claude/settings.json"), "utf8"))).toEqual([cmd]);
    const lines = sc.all.split("\n").filter((l) => l.includes("same hook"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(JSON.stringify(cmd));
  });

  it("[F-2] guard --check names a hook that is in settings.json twice in two forms", () => {
    fs.writeFileSync(join(root, ".claude/settings.json"), settingsGroups(DOC_FORM, 'bash "$CLAUDE_PROJECT_DIR/.claude/hooks/x.sh"'));
    cli("import", "--target", "claude-code", "--dir", ".", "--name", "t", "--force");
    const r = cli("guard", "t.at", "--check", "--dir", ".");
    const lines = r.all.split("\n").filter((l) => l.includes("same hook"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("PostToolUse");
    expect(lines[0]).toContain(JSON.stringify(DOC_FORM));
  });
});
