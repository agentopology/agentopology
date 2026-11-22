/**
 * The one named exception to the 0.11.2 differentials (differential-0112 and
 * merge-differential-0112), read as a path: after an interpreter, a script
 * word through `$CLAUDE_PROJECT_DIR` (quoted or not) is the project path it
 * names, and the interpreter's flags (`python3 -u x.py`) are skipped to find
 * its script. 0.11.2 refused such a run (V96: its basename kept a quote) or
 * compiled it to a stub named after the interpreter.
 */
import { projectWord, runParts } from "../../../parser/run.js";

/**
 * The twin of a run read as a path: the interpreter, its script word written as
 * the `./path` it names, and the arguments, with the interpreter's flags left
 * out; null when the run has neither such a word nor flags.
 */
export function twinOf(run: string): string | null {
  const parts = runParts(run);
  if (!parts.interpreter) return null;
  const words = run.trim().split(/\s+/);
  const at = 1 + (parts.flags?.length ?? 0);
  if (at === 1 && parts.script === words[at]) return null;
  return [parts.interpreter, projectWord(words[at]), ...words.slice(at + 1)].join(" ");
}
