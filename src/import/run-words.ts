/**
 * How import reads a hook command from settings.json, to name the hook (S-02).
 *
 * This reads `$CLAUDE_PROJECT_DIR` in the forms Claude Code's docs give
 * (`"$CLAUDE_PROJECT_DIR"/x`, `"${CLAUDE_PROJECT_DIR}/x"`) so a hook running
 * `node "$CLAUDE_PROJECT_DIR/a.mjs"` is named `a`, not `a-mjs"`. The split is
 * parser/run.ts's runParts, the one every binding compiles a `run:` with, so
 * an interpreter's flags (`python3 -I -B x.py`) are read the same here.
 *
 * @module
 */

import { interpreterFor, isProjectPath, isShellCommand, projectWord, proseInRun, runParts } from "../parser/run.js";

/** What import says for a hook whose command 0.11.3 would compile to a stub (ruled text). */
export const UNFAITHFUL =
  "this hook can't be compiled faithfully; keep it as a hand-written hook or rewrite it as a topology script";

/**
 * Whether scaffold (0.11.2's resolution, which 0.11.3 keeps) would compile
 * this imported `run:` to a stub of the topology's own: its script word is
 * neither a builtin run as written, nor a path to the user's file, so it
 * becomes .claude/skills/<t>/scripts/<word>, a stub that exits 1. The source
 * harness ran a real program there: `python3 -u x.py` (a stub named python3),
 * `bash -c ...`, `bun run x.ts` (a stub named run), `prettier --write .`,
 * `scripts/x.sh` (the project's file, not the skill's). Prose is V96's.
 */
export function compilesToStub(run: string): boolean {
  if (!run.trim() || isShellCommand(run) || proseInRun(run)) return false;
  const { script } = runParts(run);
  return !!script && !script.startsWith("/") && !isProjectPath(script);
}

/**
 * Whether a script word opens a quote it does not close: the quoted path
 * holds a blank (`"$CLAUDE_PROJECT_DIR/tools/my a.py"`), which the run reader
 * splits into two words, so scaffold would write a broken command beside the
 * harness's own. A .at string's `\"` counts as the quote it stands for.
 */
function quotesABlank(script: string): boolean {
  const plain = script.replace(/\\"/g, '"');
  return (plain.split('"').length - 1) % 2 === 1 || (plain.split("'").length - 1) % 2 === 1;
}

/** A first line that runs the file with a shell: `#!/bin/bash`, `#!/usr/bin/env sh`, ... */
const SHELL_SHEBANG = /^#!\s*\S*\/(?:env\s+)?(?:ba|z|da|k)?sh(?:\s|$)/;

/**
 * Whether scaffold (0.11.2's resolution) would compile this imported `run:`
 * to something other than what the harness ran:
 *   - a stub of the topology's own (compilesToStub);
 *   - D1: the user's own executable by path, run by bash because it has no
 *     extension bash or another interpreter claims, when it is not a shell
 *     script: a non-shell shebang (node, python, ...), a binary, or a file
 *     import cannot read (`./node_modules/.bin/tool`, `.venv/bin/ruff`);
 *   - D2: an absolute first word that is not an interpreter (`/bin/false`,
 *     `/usr/bin/env python3 x.py`), which scaffold runs as `bash /bin/false`.
 * `read` gives the text of a project file import read, by project-relative path.
 */
export function compilesUnfaithfully(run: string, read: (path: string) => string | undefined): boolean {
  if (compilesToStub(run)) return true;
  if (!run.trim() || isShellCommand(run) || proseInRun(run)) return false;
  const { interpreter, script } = runParts(run);
  if (quotesABlank(script)) return true;
  if (interpreter || !script || interpreterFor(script) !== "bash" || /\.(?:sh|bash)$/.test(script)) return false;
  if (script.startsWith("/")) return true;
  if (!isProjectPath(script)) return false;
  const text = read(script.replace(/^\.\//, ""));
  if (text === undefined || text.includes("\u0000")) return true;
  const first = text.split("\n", 1)[0];
  return first.startsWith("#!") && !SHELL_SHEBANG.test(first);
}

/** A word that names a file through the project-dir variable, as the project-relative path it is (`./x`); now parser/run.ts's, kept here for import's callers. */
export { projectWord };

/**
 * A command split into the interpreter it names (if any), its flags, its
 * script, and the script's arguments, project-dir words read as paths. It is
 * runParts, so import names a hook by the same script a binding runs, with
 * one addition for naming: a first word through `$CLAUDE_PROJECT_DIR` is read
 * as its path too (`"$CLAUDE_PROJECT_DIR"/x.sh` is ./x.sh), which a `run:`
 * may not open with (V96).
 */
export function commandParts(command: string): { interpreter?: string; flags?: string[]; script: string; args: string[] } {
  const [first = "", ...rest] = command.trim().split(/\s+/);
  return runParts([projectWord(first), ...rest].join(" "));
}
