/**
 * The one named exception to the 0.11.2 differentials (differential-0112 and
 * merge-differential-0112), read as a path: after an interpreter, a script
 * word through `$CLAUDE_PROJECT_DIR` (quoted or not) is the project path it
 * names, and the interpreter's flags (`python3 -u x.py`) are skipped to find
 * its script. 0.11.2 refused such a run (V96: its basename kept a quote) or
 * compiled it to a stub named after the interpreter. Only these two kinds
 * qualify; a run through any other variable (`$HOME/x.sh`) does not.
 */
import { projectWord, runParts } from "../../../parser/run.js";

/** Why a run is read as a path: a project-dir script word, interpreter flags, or both. */
export type ReadAsPathKind = "project-dir" | "flags" | "both";

/**
 * A run read as a path: its twin (the interpreter, its script word written as
 * the `./path` it names, and the arguments, with the interpreter's flags left
 * out) and the kind that qualifies it; null when it has neither a
 * `$CLAUDE_PROJECT_DIR` script word after an interpreter nor interpreter flags.
 */
export function readAsPath(run: string): { twin: string; kind: ReadAsPathKind } | null {
  const parts = runParts(run);
  if (!parts.interpreter) return null;
  const words = run.trim().split(/\s+/);
  const at = 1 + (parts.flags?.length ?? 0);
  const word = words[at] ?? "";
  // only a word runParts reads as a path (after an interpreter) and projectWord rewrites
  const project = parts.script !== word && projectWord(word) !== word;
  const flags = at > 1;
  if (!project && !flags) return null;
  return {
    twin: [parts.interpreter, projectWord(word), ...words.slice(at + 1)].join(" "),
    kind: project && flags ? "both" : project ? "project-dir" : "flags",
  };
}

/** The twin of a run read as a path; null when the run does not qualify. */
export function twinOf(run: string): string | null {
  return readAsPath(run)?.twin ?? null;
}
