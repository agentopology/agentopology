/**
 * The merge's hook identity reads `$CLAUDE_PROJECT_DIR` in the same shapes
 * the run reader does (run.ts PROJECT_DIR): a hand-built hook written as
 * `"$CLAUDE_PROJECT_DIR"/x`, `"${CLAUDE_PROJECT_DIR}/x"` or
 * `"${CLAUDE_PROJECT_DIR:-.}/x"` imports, and the scaffold that follows
 * compiles it to `"$CLAUDE_PROJECT_DIR/x"`. Both are one hook: settings.json
 * keeps exactly one entry, not two that both run.
 */

import { describe, it, expect } from "vitest";
import { parse } from "../../parser/index.js";
import { importClaudeCodeWithReport } from "../../import/index.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import { deepMergeSettingsJson, keptHookCommands } from "../merge.js";
import type { PlatformFile } from "../../sync/index.js";
// @ts-expect-error plain JavaScript module
import { RT_PROJECT_DIR_FORMS } from "../../__tests__/e2e/differential/fable-sequences.mjs";

/** A hand-built harness with one PreToolUse hook running `command`. */
const settingsWith = (...commands: string[]): string =>
  JSON.stringify({ hooks: { PreToolUse: commands.map((command) => ({ matcher: "Bash", hooks: [{ type: "command", command }] })) } }, null, 2);

const harness = (command: string): PlatformFile[] => [
  { path: ".claude/agents/a.md", content: "---\nname: a\ndescription: An agent\n---\n\nBody.\n" } as PlatformFile,
  { path: ".claude/settings.json", content: settingsWith(command) } as PlatformFile,
];

const commandsOf = (raw: string): string[] =>
  Object.values((JSON.parse(raw).hooks ?? {}) as Record<string, Array<{ hooks?: Array<{ command?: string }> }>>)
    .flat()
    .flatMap((g) => (g.hooks ?? []).map((h) => String(h.command ?? "")));

/** Import the harness, scaffold the .at, merge into the harness's settings.json: the merged file and the lines scaffold prints. */
function importThenScaffold(command: string): { generated: string[]; merged: string[]; kept: string[] } {
  const { source, report } = importClaudeCodeWithReport(harness(command), "t");
  expect((report as { errors?: unknown[] }).errors ?? [], command).toEqual([]);
  const files = claudeCodeBinding.scaffold(parse(source));
  const settings = files.find((f) => f.path === ".claude/settings.json");
  expect(settings, command).toBeDefined();
  const owned = files.map((f) => f.path);
  const existing = settingsWith(command);
  return {
    generated: commandsOf(settings!.content),
    merged: commandsOf(deepMergeSettingsJson(existing, settings!.content, owned)),
    kept: keptHookCommands(existing, settings!.content, owned).map((k) => k.command),
  };
}

/** The project-dir shapes the run reader reads as a path, after an interpreter. */
export const PROJECT_DIR_FORMS: Array<[string, string]> = [
  ['python3 "$CLAUDE_PROJECT_DIR"/tools/a.py hook', 'python3 "$CLAUDE_PROJECT_DIR/tools/a.py" hook'],
  ['python3 -I -B "${CLAUDE_PROJECT_DIR}/tools/b.py" hook', 'python3 -I -B "$CLAUDE_PROJECT_DIR/tools/b.py" hook'],
  ['python3 "${CLAUDE_PROJECT_DIR:-.}/tools/c.py"', 'python3 "$CLAUDE_PROJECT_DIR/tools/c.py"'],
  ["python3 ${CLAUDE_PROJECT_DIR}/tools/d.py", 'python3 "$CLAUDE_PROJECT_DIR/tools/d.py"'],
];

describe("import then scaffold leaves exactly one entry for a project-dir hook, in every shape the run reader reads", () => {
  it.each(PROJECT_DIR_FORMS)("%s", (command, canonical) => {
    const { generated, merged } = importThenScaffold(command);
    // the scaffold compiles it to the canonical text (what used to land as a second entry)
    expect(generated).toContain(canonical);
    // ... and the merge reads both as one hook: the harness's entry stays, alone
    expect(merged).toEqual([command]);
  });
});

describe("the round-trip corpus's project-dir forms keep one entry", () => {
  it("covers every form listed here", () => {
    expect(RT_PROJECT_DIR_FORMS as string[]).toEqual(PROJECT_DIR_FORMS.map(([command]) => command));
  });
});

describe("the merge never makes one hook of two different commands", () => {
  const merge = (user: string, at: string): string[] => commandsOf(deepMergeSettingsJson(settingsWith(user), settingsWith(at)));
  it.each([
    ['python3 "$CLAUDE_PROJECT_DIR"/tools/a.py', 'python3 "$CLAUDE_PROJECT_DIR/tools/b.py"'],
    ['python3 "${CLAUDE_PROJECT_DIR}/tools/a.py" hook', 'python3 "$CLAUDE_PROJECT_DIR/tools/a.py" other'],
    ['python3 "${CLAUDE_PROJECT_DIR:-.}/tools/a.py"', 'python3 -I "$CLAUDE_PROJECT_DIR/tools/a.py"'],
    // another variable is another folder
    ['python3 "$HOME"/tools/a.py', 'python3 "$CLAUDE_PROJECT_DIR/tools/a.py"'],
    ['python3 "${HOME}/tools/a.py"', 'python3 "$CLAUDE_PROJECT_DIR/tools/a.py"'],
    // a longer variable name is another variable
    ['bash "$CLAUDE_PROJECT_DIR_OLD/x.sh"', 'bash "_OLD/x.sh"'],
    ['bash "${CLAUDE_PROJECT_DIR_OLD}/x.sh"', 'bash "$CLAUDE_PROJECT_DIR/x.sh"'],
    // the variable not followed by a path is not a path
    ['cd "$CLAUDE_PROJECT_DIR"/web && make', "cd web && make lint"],
  ])("%s  vs  %s", (user, at) => {
    expect(merge(user, at)).toEqual([user, at]);
  });

  // the variable followed by a bare slash names the folder itself, not a file in it: an argument, kept as written
  it.each([
    ['bash x.sh "${CLAUDE_PROJECT_DIR}"/', "bash x.sh"],
    ['bash x.sh "$CLAUDE_PROJECT_DIR"/', "bash x.sh"],
    ['rsync -a "${CLAUDE_PROJECT_DIR}/" /b', "rsync -a /b"],
    ['rsync -a "${CLAUDE_PROJECT_DIR:-.}/" /b', "rsync -a /b"],
    // a doubled slash after the variable is still a path in the project, never the filesystem root
    ['bash "$CLAUDE_PROJECT_DIR"//x.sh', "bash /x.sh"],
    ['ls "${CLAUDE_PROJECT_DIR}//"', "ls /"],
  ])("two user hooks %s  and  %s stay two when a generated hook changes the file", (first, second) => {
    const user = settingsWith(first, second);
    const at = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "bash .claude/hooks/stop.sh" }] }] } }, null, 2);
    expect(commandsOf(deepMergeSettingsJson(user, at))).toEqual([first, second, "bash .claude/hooks/stop.sh"]);
  });

  // a word that is only the variable, with or without a trailing slash, in any spelling, is an argument
  it.each([
    ['rsync -a "$CLAUDE_PROJECT_DIR/" /b', "rsync -a /b"],
    ["rsync -a $CLAUDE_PROJECT_DIR/ /b", "rsync -a /b"],
    ['bash x.sh "$CLAUDE_PROJECT_DIR"', "bash x.sh"],
    ["bash x.sh $CLAUDE_PROJECT_DIR", "bash x.sh"],
    ['bash x.sh "${CLAUDE_PROJECT_DIR}"', "bash x.sh"],
    ['bash x.sh "${CLAUDE_PROJECT_DIR:-.}"', "bash x.sh"],
    ['ls "$CLAUDE_PROJECT_DIR"/', "ls /"],
    // the folder with and without its trailing slash are two arguments (rsync reads them apart)
    ['rsync -a "$CLAUDE_PROJECT_DIR/" /b', 'rsync -a "$CLAUDE_PROJECT_DIR" /b'],
  ])("two user hooks %s  and  %s (only the variable as a word) stay two", (first, second) => {
    const user = settingsWith(first, second);
    const at = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "bash .claude/hooks/stop.sh" }] }] } }, null, 2);
    expect(commandsOf(deepMergeSettingsJson(user, at))).toEqual([first, second, "bash .claude/hooks/stop.sh"]);
  });

  it("a generated `ls /` under another matcher leaves the user's `ls \"$CLAUDE_PROJECT_DIR\"/` alone", () => {
    const user = settingsWith('ls "$CLAUDE_PROJECT_DIR"/');
    const at = JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "ls /" }] }] } }, null, 2);
    expect(commandsOf(deepMergeSettingsJson(user, at))).toEqual(['ls "$CLAUDE_PROJECT_DIR"/', "ls /"]);
  });

  // every spelling of the variable as a word reads as one argument
  it.each([
    ['bash x.sh "$CLAUDE_PROJECT_DIR"', "bash x.sh ${CLAUDE_PROJECT_DIR}"],
    ['rsync -a "$CLAUDE_PROJECT_DIR"/ /b', 'rsync -a "${CLAUDE_PROJECT_DIR:-.}/" /b'],
  ])("%s  and  %s are one hook", (user, at) => {
    expect(commandsOf(deepMergeSettingsJson(settingsWith(user), settingsWith(at)))).toEqual([user]);
  });
});

describe("import refuses a quoted script word holding a blank, so scaffold never writes a broken second entry", () => {
  it.each([
    'python3 "$CLAUDE_PROJECT_DIR/tools/my a.py"',
    'bash "$CLAUDE_PROJECT_DIR/tools/my tool.sh" --check',
    'python3 "tools/my a.py"',
  ])("%s", (command) => {
    const { report } = importClaudeCodeWithReport(harness(command), "t");
    const errors = (report as { errors?: Array<{ command: string }> }).errors ?? [];
    expect(errors.map((e) => e.command)).toEqual([command]);
  });

  it("a quoted script word without a blank still imports clean", () => {
    const { report } = importClaudeCodeWithReport(harness('python3 "$CLAUDE_PROJECT_DIR/tools/a.py"'), "t");
    expect((report as { errors?: unknown[] }).errors ?? []).toEqual([]);
  });
});
