/**
 * The forms a scan of 12 public Claude Code repos found the importer could not
 * carry: each one made `import` write an .at that `validate` refused. Every
 * fixture here is synthetic: a small settings.json or agent file written for
 * the test that reproduces one failing FORM, not any repo's file.
 */
import { describe, it, expect } from "vitest";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { serializeAST } from "../serializer.js";
import { importFromPlatform, importClaudeCodeWithReport } from "../index.js";
import type { PlatformFile } from "../../sync/index.js";
import { isShellCommand, proseInRun } from "../../parser/run.js";
import { hookCommand, claudeCodeBinding } from "../../bindings/claude-code.js";

type Entry = [event: string, matcher: string | undefined, command: string];

/** A settings.json whose hooks are one handler per entry, in order. */
function settingsWith(entries: Entry[]): PlatformFile {
  const hooks: Record<string, unknown[]> = {};
  for (const [event, matcher, command] of entries) {
    (hooks[event] ??= []).push({
      ...(matcher !== undefined ? { matcher } : {}),
      hooks: [{ type: "command", command }],
    });
  }
  return { path: ".claude/settings.json", content: JSON.stringify({ hooks }) } as PlatformFile;
}

function importAt(files: PlatformFile[]): string {
  return importFromPlatform(files, "claude-code", "pilot");
}

/**
 * A command as the .at gives it back in 0.11.3, as in 0.11.2: the serializer
 * writes a `"` as `\"` and the parser does not decode it (S-01's decode is 0.12).
 */
const as0112 = (command: string) => command.replace(/"/g, '\\"');

function errors(source: string): string[] {
  return validate(parse(source))
    .filter((r) => r.level === "error")
    .map((r) => `${r.rule}: ${r.message}`);
}

describe("S-02: an imported hook's id is a valid identifier", () => {
  const entries: Entry[] = [
    // a pipeline with no script in it: the id used to be `null` plus its tail
    ["PostToolUse", "Write|Edit", "jq -r '.tool_input.file_path' | { read -r f; echo \"$f\"; } >/dev/null 2>&1 || true"],
    // a tool run by a launcher: the id used to be the whole command, quotes included
    ["PostToolUse", "Bash|Task", 'uv run --no-sync --project "$CLAUDE_PROJECT_DIR" progress-hook'],
    ["PostToolUse", "Bash|Task", 'uv run --no-sync --project "$CLAUDE_PROJECT_DIR" progress-hook'],
    // a variable with a default and an && chain
    ["PreToolUse", "Bash", "cd ${CLAUDE_PROJECT_DIR:-.} && npm test"],
    // a folder is not a script
    ["PreToolUse", "Edit", 'cd "$CLAUDE_PROJECT_DIR/web" && npm run lint'],
    // no matcher at all
    ["SessionStart", undefined, "uv run session-start"],
    ["SessionStart", "startup", "make status 2>/dev/null || true"],
    // a clean script name is still used
    ["PreToolUse", "Bash", ".claude/hooks/check-review.sh"],
    // a regex matcher
    ["PreToolUse", "mcp__github__.*", "echo ok"],
  ];

  it("derives ids from event and matcher, de-duplicated, never null", () => {
    const ast = parse(importAt([settingsWith(entries)]));
    const names = ast.hooks.map((h) => h.name);
    expect(names).toEqual([
      "post-tool-use-write-edit",
      "post-tool-use-bash-task",
      "post-tool-use-bash-task-2",
      "pre-tool-use-bash",
      "pre-tool-use-edit",
      "check-review",
      "pre-tool-use-mcp-github",
      "session-start",
      "session-start-startup",
    ]);
    for (const n of names) expect(n).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it("validates with no hooks-block errors (V95, V98, V100, V102)", () => {
    const errs = errors(importAt([settingsWith(entries)]));
    expect(errs.filter((e) => /^V(95|98|100|102):/.test(e))).toEqual([]);
  });

  it("round-trips: import, parse, serialize, parse gives the same hook ids", () => {
    const first = parse(importAt([settingsWith(entries)]));
    const second = parse(serializeAST(first));
    const ids = (hs: typeof first.hooks) => hs.map((h) => [h.name, h.on, h.matcher]);
    expect(ids(second.hooks)).toEqual(ids(first.hooks));
    expect(first.hooks).toHaveLength(entries.length);
  });
});

describe("S-01: hook commands with quotes and variables survive import exactly", () => {
  const commands = [
    'node "$CLAUDE_PROJECT_DIR/.claude/hooks/guard.mjs"',
    '"$CLAUDE_PROJECT_DIR"/.claude/hooks/guard-main.sh',
    '"${CLAUDE_PROJECT_DIR}/.claude/hooks/pre-commit.sh"',
    'bash "$CLAUDE_PROJECT_DIR/.claude/hooks/check.sh" --strict',
    'python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/guard_edit.py" --protect-lockfiles',
    '/bin/sh "${CLAUDE_PROJECT_DIR:-.}/scripts/tooling/dispatch.sh"',
    "cd ${CLAUDE_PROJECT_DIR:-.} && npm test",
    // a backslash, and a backslash before a quote, are data too
    "jq -r '.tool_input.file_path' | { read -r f; echo \"$f\" | grep -qE '(^|/)\\.env$' && printf '{\\\"deny\\\":true}'; } || true",
  ];
  const entries: Entry[] = commands.map((c) => ["PreToolUse", "Bash", c]);

  it("parses back as 0.11.2 does: a `\"` inside a command keeps its backslash (decoding it is 0.12's, with S-11)", () => {
    const first = parse(importAt([settingsWith(entries)]));
    expect(first.hooks.map((h) => h.run)).toEqual(commands.map(as0112));
  });

  it("0.11.3 resolves runs as 0.11.2 did, so V96 refuses the project-dir forms as 0.11.2 did (S-11 is 0.12)", () => {
    // The import keeps each command exactly (above); a binding that compiles a
    // quoted project-dir path is 0.12's, with S-11. validate says so, and
    // `import` exits 2, instead of scaffold writing a broken command.
    const refused = errors(importAt([settingsWith(entries)])).filter((e) => e.startsWith("V96"));
    expect(refused).toHaveLength(6);
  });
});

describe("S-09: an agent's output-format is never a markdown fence", () => {
  const agent = (id: string, body: string): PlatformFile =>
    ({ path: `.claude/agents/${id}.md`, content: `---\nname: ${id}\ndescription: Reviews a diff.\nmodel: opus\n---\n\n${body}\n` }) as PlatformFile;

  const fenced = agent("fenced", "Review the diff.\n\nOutput format:\n```\n## Findings\n- one per line\n```\n");
  const prose = agent("prose", "Review the diff.\n\nOutput format: markdown with a findings table\n");
  const real = agent("real", "Review the diff.\n\nOutput format: json\n");

  it("does not read the next line's code fence as the value", () => {
    const ast = parse(importAt([fenced, prose, real]));
    const fmt = (id: string) => (ast.nodes.find((n) => n.id === id) as { outputFormat?: string }).outputFormat;
    expect(fmt("fenced")).toBeUndefined();
    expect(fmt("prose")).toBeUndefined();
    expect(fmt("real")).toBe("json");
  });

  it("validates with 0 errors (V36)", () => {
    expect(errors(importAt([fenced, prose, real]))).toEqual([]);
  });

  it("drops a value it cannot map with an import warning", () => {
    const { report } = importClaudeCodeWithReport([fenced, prose, real], "pilot");
    expect(report.warnings).toEqual([
      'agent prose: "Output format: markdown" is not text, json or json-schema; dropped',
    ]);
    expect(importAt([prose])).toContain('# Import warning: agent prose: "Output format: markdown"');
  });
});

describe("S-10: a hook one-liner that starts with a shell variable assignment", () => {
  const commands = [
    "branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true); if [ \"$branch\" = \"main\" ]; then echo 'on main' >&2; fi",
    "files=$(echo \"$CLAUDE_FILE_PATHS\" | tr ' ' '\\n' | grep '\\.py$' || true); [ -z \"$files\" ] || ruff format $files",
  ];
  const entries: Entry[] = commands.map((c) => ["PostToolUse", "Edit|Write", c]);

  it("imports each one and V96 refuses it, as 0.11.2 did (emit-as-written and the quote decode are 0.12, S-11)", () => {
    const source = importAt([settingsWith(entries)]);
    expect(errors(source).filter((e) => e.startsWith("V96"))).toHaveLength(2);
    expect(parse(source).hooks.map((h) => h.run)).toEqual(commands.map(as0112));
  });

  it("still refuses prose", () => {
    expect(proseInRun("x=1 → then retry")).not.toBeNull();
  });
});

describe("S-11: emit-as-written is not in 0.11.3", () => {
  it.todo("S-11 (0.12): a run holding a shell operator, a keyword or a package runner scaffolds as written; 0.11.3 resolves it as 0.11.2 did (differential-0112.test.ts)");

  it("a script run is still a script, and an operator inside quotes is data", () => {
    expect(isShellCommand("scripts/check.sh")).toBe(false);
    expect(isShellCommand("check-review")).toBe(false);
    expect(isShellCommand('scripts/check.sh "a|b"')).toBe(false);
    expect(isShellCommand("python3 scripts/x.py --mode 'a;b'")).toBe(false);
  });

  it("import writes a bare PATH tool exactly as settings.json has it (no `command` prefix in 0.11.3)", () => {
    const ast = parse(importAt([settingsWith([["Stop", undefined, "chunk validate"]])]));
    expect(ast.hooks[0].run).toBe("chunk validate");
  });
});

describe("S-12: a hook running the user's script inside an authored skill folder stays wired", () => {
  it("import then scaffold keeps the hook in settings.json", () => {
    const skill = {
      path: ".claude/skills/auto/SKILL.md",
      content: "---\nname: auto\ndescription: Runs the release.\n---\n\nDo the release.\n",
    } as PlatformFile;
    // A run 0.11.2's resolution compiles (a project-relative path), so 0.11.3 does too.
    const run = "python3 .claude/skills/auto/references/guard.py --strict";
    const ast = parse(importAt([settingsWith([["PreToolUse", "Edit|Write", run]]), skill]));
    const files = claudeCodeBinding.scaffold(ast);
    const settings = JSON.parse(files.find((f) => f.path === ".claude/settings.json")!.content);
    const commands = Object.values(settings.hooks ?? {}).flat().flatMap((h: any) => h.hooks.map((x: any) => x.command));
    expect(commands).toContain('python3 "$CLAUDE_PROJECT_DIR/.claude/skills/auto/references/guard.py" --strict');
    // the user's script is never written over: no stub inside their folder
    expect(files.some((f) => f.path.includes("skills/auto/references"))).toBe(false);
  });
});
