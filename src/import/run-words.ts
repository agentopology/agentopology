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

import { isProjectPath } from "../parser/run.js";

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
