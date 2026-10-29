/**
 * What a `run:` value is allowed to be: a command, not a sentence.
 *
 * A gate or hook `run` names something to execute. Bindings derive a script
 * file name from it, so prose there became files named `E;`, `fail:` and
 * `outputs.py)` — and a " / " in a sentence produced an empty name that
 * crashed scaffold with EISDIR. Both the validator (V96) and every binding go
 * through these two functions so they cannot disagree.
 *
 * @module
 */

/** One path-ish token: optional ./ ../ ~/ or / prefix, then safe characters (dotfolders such as .claude/ included). */
const EXECUTABLE = /^(?:\.{1,2}\/|~\/|\/)?[A-Za-z0-9_.][A-Za-z0-9_.\/@+-]*$/;

/** A file name a binding may write under its scripts/ directory. */
const SCRIPT_FILE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/** Words that run the script named after them. */
const INTERPRETER = /^(?:python[0-9.]*|bash|sh|zsh|node|bun|deno|ruby|perl|tsx)$/;
const SCRIPT_EXT = /\.(?:py|sh|ts|mjs|js)$/;

/**
 * A `run:` split into the interpreter it names (if any), its script, and the
 * script's arguments. The script is the first word, or the second when the
 * first is an interpreter (`python3 x.py`, `/opt/homebrew/bin/python3 ./y.py`).
 *
 * The script name used to be the text after the LAST slash of the whole line,
 * so an argument became the script: `python3 tool.py check show/SLUG` planned
 * a stub named `SLUG`, and `pxframes.py gate OUT/frames-critic.json` one named
 * `frames-critic.json`.
 */
export function runParts(run: string): { interpreter?: string; script: string; args: string[] } {
  const words = run.trim().split(/\s+/);
  const first = words[0] ?? "";
  const named =
    words.length > 1 &&
    !words[1].startsWith("-") && // `bash -c '...'` runs no script file
    !SCRIPT_EXT.test(first) &&
    (INTERPRETER.test(first.replace(/^.*\//, "")) || isProjectPath(words[1]));
  const [script = "", ...args] = named ? words.slice(1) : words;
  return { ...(named ? { interpreter: first } : {}), script, args };
}

/**
 * Whether a script word names a file in the project (run where it is) rather
 * than one in the topology skill's scripts/ folder (scaffolded by basename).
 * `./x`, `/x` and any path with a folder count, except the historical
 * `scripts/x.sh`, which has always meant the skill's own scripts folder.
 */
export function isProjectPath(script = ""): boolean {
  if (script.startsWith(".") || script.startsWith("/")) return true;
  return script.includes("/") && !script.startsWith("scripts/");
}

/**
 * The script file name a binding writes for `run`, or null when `run` does not
 * name one: the basename of the script word (see runParts).
 */
export function scriptNameFromRun(run: string | undefined): string | null {
  if (!run) return null;
  // A slash standing alone is prose ("0.0 / 0.5 / 3.0 s"), never a path.
  if (/\s\/\s/.test(run)) return null;
  const name = runParts(run).script.replace(/^.*\//, "");
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
