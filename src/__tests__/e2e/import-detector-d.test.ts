/**
 * The import detector's last two misses (Fable's final pass on 91914d2), and
 * how import says it.
 *
 * D1: a hook whose first word is the user's own executable by path with no
 * .sh/.bash extension scaffolds as `bash "<path>"`. For a node or python
 * shebang, a binary, or a file import cannot read, that breaks it
 * (`./node_modules/.bin/tool`, `.venv/bin/ruff`, `./bin/guard`,
 * `./vendor/bin/phpstan`). D2: an absolute first word (`/usr/bin/env python3
 * ...`, `/bin/false`) scaffolds as `bash /usr/bin/env ...`. Import flags both.
 *
 * P2: one verdict (never "passes all validation rules" with a flagged hook),
 * the command printed as the harness wrote it, and the warning written into
 * the .at as a comment above the hook.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { importClaudeCodeWithReport } from "../../import/index.js";
import type { PlatformFile } from "../../sync/index.js";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../../../dist/cli/index.js");
const TEXT = "this hook can't be compiled faithfully; keep it as a hand-written hook or rewrite it as a topology script";
const PY = "#!/usr/bin/env python3\nimport sys\nsys.exit(0)\n";
const JS = "#!/usr/bin/env node\nprocess.exit(0);\n";
const SH = "#!/usr/bin/env bash\nexit 2\n";

const files = (command: string, extra: Record<string, string> = {}): PlatformFile[] => [
  { path: ".claude/agents/a.md", content: "---\nname: a\ndescription: An agent\n---\n\nBody.\n" },
  { path: ".claude/settings.json", content: JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command }] }] } }) },
  ...Object.entries(extra).map(([path, content]) => ({ path, content })),
] as PlatformFile[];
const flagged = (command: string, extra: Record<string, string> = {}) =>
  ((importClaudeCodeWithReport(files(command, extra), "t").report as { errors?: unknown[] }).errors ?? []).length > 0;

describe("D1: the user's own non-shell executable by path", () => {
  it.each([
    ["./bin/guard", { "bin/guard": PY }],
    ["bin/guard --x", { "bin/guard": PY }],
    ["./node_modules/.bin/tool --check", { "node_modules/.bin/tool": JS }],
    [".venv/bin/ruff check .", { ".venv/bin/ruff": PY }],
    ["./vendor/bin/phpstan analyse", { "vendor/bin/phpstan": JS }],
    ["tools/guard.pl", { "tools/guard.pl": "#!/usr/bin/env perl\nexit 0;\n" }],
    [".claude/hooks/guard", { ".claude/hooks/guard": PY }],
    [".claude/hooks/blob", { ".claude/hooks/blob": "\u0000\u0001ELF" }],
    ["./bin/absent", {}],
  ])("[D-1] %s is flagged", (command, extra) => {
    expect(flagged(command, extra)).toBe(true);
  });

  it.each([
    ["tools/guard.sh", { "tools/guard.sh": SH }],
    [".claude/hooks/guard.sh", { ".claude/hooks/guard.sh": SH }],
    [".claude/hooks/shguard", { ".claude/hooks/shguard": SH }],
    [".claude/hooks/plain", { ".claude/hooks/plain": "exit 2\n" }],
    ["tools/guard.py --strict", { "tools/guard.py": PY }],
    ["node bin/guard-node", { "bin/guard-node": JS }],
    ["python3 tools/guard.py", { "tools/guard.py": PY }],
  ])("[D-1] %s is not flagged (bash, or the interpreter it names, runs it as the harness did)", (command, extra) => {
    expect(flagged(command, extra)).toBe(false);
  });
});

describe("D2: an absolute first word", () => {
  it.each(["/usr/bin/env python3 tools/guard.py", "/bin/false", "/usr/bin/test -f nosuch"])("[D-2] %s is flagged", (command) => {
    expect(flagged(command)).toBe(true);
  });
  it.each(["/bin/sh tools/guard.sh", "/usr/bin/python3 tools/guard.py"])("[D-2] %s is not flagged (an interpreter it names)", (command) => {
    expect(flagged(command, { "tools/guard.sh": SH, "tools/guard.py": PY })).toBe(false);
  });
});

describe("P2: how import says it", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(join(os.tmpdir(), "at-p2-"));
    fs.mkdirSync(join(root, ".claude/agents"), { recursive: true });
    fs.writeFileSync(join(root, ".claude/agents/a.md"), "---\nname: a\ndescription: An agent\n---\n\nBody.\n");
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  const importCmd = (command: string) => {
    fs.writeFileSync(join(root, ".claude/settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command }] }] } }));
    const r = spawnSync(process.execPath, [CLI, "import", "--target", "claude-code", "--dir", ".", "--name", "t"], { cwd: root, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
    return { code: r.status, all: `${r.stdout}${r.stderr}` };
  };

  it("[P2-1] one verdict: never 'passes all validation rules' when a hook is flagged", () => {
    const r = importCmd("prettier --write .");
    expect(r.code).toBe(2);
    expect(r.all).not.toContain("passes all validation rules");
    expect(r.all).toContain("Generated .at passes validation, but 1 hook(s) can't be compiled faithfully (exit 2)");
  });

  it("[P2-2] the flagged command is printed exactly as the harness wrote it", () => {
    const command = 'python3 -u "$CLAUDE_PROJECT_DIR/tools/guard.py"';
    const r = importCmd(command);
    expect(r.code).toBe(2);
    expect(r.all.split("\n").some((l) => l.trim() === command)).toBe(true);
    expect(r.all).not.toContain('\\"$CLAUDE_PROJECT_DIR');
  });

  it("[P2-3] the .at holds the warning as a comment directly above the hook, and validates as without it", () => {
    importCmd("prettier --write .");
    const at = fs.readFileSync(join(root, "t.at"), "utf8");
    const lines = at.split("\n");
    const i = lines.findIndex((l) => /^\s*hook \S+ \{/.test(l));
    expect(lines[i - 1].trim()).toBe(`# ⚠ ${TEXT}`);
    const without = [...lines.slice(0, i - 1), ...lines.slice(i)].join("\n");
    const msgs = (src: string) => validate(parse(src)).map((r) => `${r.rule} ${r.level} ${r.message}`);
    expect(msgs(at)).toEqual(msgs(without));
    expect(parse(at).hooks).toEqual(parse(without).hooks);
  });
});
