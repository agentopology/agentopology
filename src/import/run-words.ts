/**
 * How import reads a hook command from settings.json, to name the hook (S-02).
 *
 * This reads `$CLAUDE_PROJECT_DIR` in the forms Claude Code's docs give
 * (`"$CLAUDE_PROJECT_DIR"/x`, `"${CLAUDE_PROJECT_DIR}/x"`) so a hook running
 * `node "$CLAUDE_PROJECT_DIR/a.mjs"` is named `a`, not `a-mjs"`. It is import's
 * own: what a binding compiles a `run:` to is parser/run.ts, which is 0.11.2's
 * resolution in 0.11.3 (S-11's emit-as-written moved to 0.12).
 *
 * @module
 */

import { interpreterFor, isProjectPath, isShellCommand, proseInRun, runParts } from "../parser/run.js";

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
  if (interpreter || !script || interpreterFor(script) !== "bash" || /\.(?:sh|bash)$/.test(script)) return false;
  if (script.startsWith("/")) return true;
  if (!isProjectPath(script)) return false;
  const text = read(script.replace(/^\.\//, ""));
  if (text === undefined || text.includes("\u0000")) return true;
  const first = text.split("\n", 1)[0];
  return first.startsWith("#!") && !SHELL_SHEBANG.test(first);
}

/** Words that run the script named after them. */
const INTERPRETER = /^(?:python[0-9.]*|bash|sh|zsh|node|bun|deno|ruby|perl|tsx)$/;
const SCRIPT_EXT = /\.(?:py|sh|ts|mjs|js)$/;

/** `$CLAUDE_PROJECT_DIR` opening a word, quoted or not, with or without braces or a default. */
const PROJECT_DIR = /^"?\$(?:CLAUDE_PROJECT_DIR\b|\{CLAUDE_PROJECT_DIR(?::-[^}"]*)?\})"?(?=\/)/;

/** A word that names a file through the project-dir variable, as the project-relative path it is (`./x`); any other word unchanged. */
export function projectWord(word: string): string {
  const m = word.match(PROJECT_DIR);
  if (!m) return word;
  let path = word.slice(m[0].length);
  // `"$CLAUDE_PROJECT_DIR/x.sh"`: the quote opened before the variable closes at the end
  const open = m[0].startsWith('"') && !m[0].endsWith('"');
  if (open) {
    if (!path.endsWith('"')) return word;
    path = path.slice(0, -1);
  }
  return path.includes('"') ? word : `.${path}`;
}

/** A command split into the interpreter it names (if any), its script, and the script's arguments, project-dir words read as paths. */
export function commandParts(command: string): { interpreter?: string; script: string; args: string[] } {
  const words = command.trim().split(/\s+/).map((w, i) => (i < 2 ? projectWord(w) : w));
  const first = words[0] ?? "";
  const named =
    words.length > 1 &&
    !words[1].startsWith("-") &&
    !SCRIPT_EXT.test(first) &&
    (INTERPRETER.test(first.replace(/^.*\//, "")) || isProjectPath(words[1]));
  const [script = "", ...args] = named ? words.slice(1) : words;
  return { ...(named ? { interpreter: first } : {}), script, args };
}
