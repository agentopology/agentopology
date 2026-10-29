/**
 * What a `run:` value is allowed to be: a command, not a sentence.
 *
 * A gate or hook `run` names something to execute. Bindings derive a script
 * file name from it, so prose there became files named `E;`, `fail:` and
 * `outputs.py)` — and a " / " in a sentence produced an empty name that
 * crashed scaffold with EISDIR. Both the validator (V94) and every binding go
 * through these two functions so they cannot disagree.
 *
 * @module
 */

/** One path-ish token: optional ./ ../ ~/ or / prefix, then safe characters. */
const EXECUTABLE = /^(?:\.{1,2}\/|~\/|\/)?[A-Za-z0-9_][A-Za-z0-9_.\/@+-]*$/;

/** A file name a binding may write under its scripts/ directory. */
const SCRIPT_FILE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/**
 * The script file name a binding writes for `run`, or null when `run` does not
 * name one. Keeps the historical derivation (basename of the last path, first
 * word) so every valid topology compiles exactly as before.
 */
export function scriptNameFromRun(run: string | undefined): string | null {
  if (!run) return null;
  const name = run.trim().replace(/^.*\//, "").replace(/\s.*$/, "");
  return SCRIPT_FILE.test(name) ? name : null;
}

/**
 * Why `run` reads as prose rather than a command, or null when it looks like a
 * command. Deliberately conservative: it flags only what a shell would reject
 * or what no command contains, so real commands are never refused.
 */
export function proseInRun(run: string): string | null {
  const text = run.trim();
  if (text === "") return "it is empty";
  if (/\r|\n/.test(text)) return "it spans several lines";

  const first = text.split(/\s+/)[0];
  if (/[:;,]$/.test(first)) return `its first word "${first}" ends in punctuation`;
  if (!EXECUTABLE.test(first)) return `its first word "${first}" is not a command or path`;

  // Judge only what the shell would see unquoted.
  const bare = text.replace(/'[^']*'|"[^"]*"/g, "''");
  if (/[^\x00-\x7F]/.test(bare)) return "it contains non-ASCII text outside quotes";
  if (/\s->\s|\s=>\s|\s<=\s|\s>=\s/.test(bare)) return "it contains an arrow or comparison (->, >=, <=)";
  if (/(^|[^$])\(/.test(bare)) return "it contains an unquoted parenthesis";
  if (scriptNameFromRun(text) === null) return "no script file name can be derived from it";
  return null;
}
