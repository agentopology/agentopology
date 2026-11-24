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
 * The flags each interpreter family is known to take before its script, so
 * the script can be found after them. Anything not listed here stops the
 * search, and the run then names no script, as before flags were read: a flag
 * that takes inline code or a module (`bash -c`, `python -c`, `python -m`,
 * `node -e`, `perl -e`) on purpose, and a flag nobody listed by default.
 */
interface FlagTable {
  /** Flags that take no value (`-I`). */
  bare: ReadonlySet<string>;
  /** Flags whose value is the next word (`-X utf8`, `-o pipefail`, `-r ts-node/register`). */
  value: ReadonlySet<string>;
  /** Flags after which no script file is run (inline code, a module, stdin). */
  inline: ReadonlySet<string>;
  /** Single letters that may be combined after one dash (`-IB`, `-eu`); empty when the family does not combine. */
  letters?: string;
  /** Letters that, combined, take inline code (`-ec '...'`): the run names no script. */
  inlineLetters?: string;
  /** A combined group ending in this letter takes the next word as its value (`-eo pipefail`). */
  valueLetter?: string;
  /** Flags whose value is written attached (`-Xdev`, `-Wignore`, `-Ilib`). */
  attached?: readonly string[];
  /**
   * Any other `--long=value` is skipped. An unlisted `--long` with no `=` may
   * take the next word as its value (`--unhandled-rejections strict`), so it
   * stops the search: the run names no script there, as before flags were read.
   */
  long?: boolean;
}

const set = (...words: string[]): ReadonlySet<string> => new Set(words);

const PYTHON: FlagTable = {
  bare: set("-I", "-B", "-u", "-E", "-s", "-S", "-O", "-OO", "-q", "-v", "-b", "-bb", "-d", "-R", "-P"),
  value: set("-X", "-W"),
  inline: set("-c", "-m", "-"),
  letters: "IBuEsSOqvbdRP",
  inlineLetters: "cm",
  attached: ["-X", "-W"],
};

/**
 * node, and tsx, which takes node's flags. `-r` / `--require`, `--import`,
 * `--loader` / `--experimental-loader`, `-C` / `--conditions`, `--env-file`
 * and `--input-type` take the next word as their value; the listed bare
 * flags take none; any other `--flag=value` is one word. Any other `--flag`
 * stops the search (see FlagTable.long).
 */
const NODE: FlagTable = {
  bare: set(
    "--no-warnings", "--no-deprecation", "--trace-warnings", "--trace-deprecation", "--trace-uncaught",
    "--throw-deprecation", "--pending-deprecation", "--enable-source-maps", "--experimental-strip-types",
    "--experimental-transform-types", "--experimental-vm-modules", "--expose-gc", "--preserve-symlinks",
    "--preserve-symlinks-main", "--abort-on-uncaught-exception", "--inspect", "--inspect-brk", "--watch",
  ),
  value: set("-r", "--require", "--import", "--loader", "--experimental-loader", "-C", "--conditions", "--env-file", "--input-type"),
  inline: set("-e", "--eval", "-p", "--print", "--run", "-"),
  long: true,
};

const BUN: FlagTable = {
  bare: set("--smol", "--hot", "--watch", "--bun", "--silent", "--no-install"),
  value: set("-r", "--preload", "--cwd", "--env-file", "--tsconfig-override"),
  inline: set("-e", "--eval", "-p", "--print"),
  long: true,
};

/** deno: `--allow-*` and `--deny-*` take a value only after `=`. */
const DENO: FlagTable = {
  bare: set("-A", "-q", "--quiet", "--no-check", "--reload", "--unstable", "--allow-all"),
  value: set("--config", "--import-map"),
  inline: set("--eval"),
  long: true,
};

/** Permission flags a family takes with no separate value (`--allow-read`, `--allow-env=HOME`). */
const BARE_PREFIX: ReadonlyMap<FlagTable, RegExp> = new Map([[DENO, /^--(?:allow|deny)-[a-z-]+$/]]);

const SHELL: FlagTable = {
  bare: set("--norc", "--noprofile", "--posix", "--login", "--verbose", "--noediting", "--restricted"),
  value: set("-o", "+o", "--rcfile", "--init-file"),
  inline: set("-c", "-s", "-i", "-"),
  letters: "euxvnfabhkmptlBCEHPT",
  inlineLetters: "csi",
  valueLetter: "o",
};

const PERL: FlagTable = {
  bare: set("-w", "-W", "-X", "-T", "-t"),
  value: set(),
  inline: set("-e", "-E", "-"),
  attached: ["-I", "-M", "-m"],
};

const RUBY: FlagTable = {
  bare: set("-w", "-W", "-v", "-d"),
  value: set("-r", "-I"),
  inline: set("-e", "-"),
  attached: ["-I", "-r"],
};

function flagTable(interpreter: string): FlagTable | null {
  const name = interpreter.replace(/^.*\//, "");
  if (/^python[0-9.]*$/.test(name)) return PYTHON;
  if (name === "node" || name === "tsx") return NODE;
  if (name === "bun") return BUN;
  if (name === "deno") return DENO;
  if (name === "bash" || name === "sh" || name === "zsh") return SHELL;
  if (name === "perl") return PERL;
  if (name === "ruby") return RUBY;
  return null;
}

/**
 * How many words after the interpreter are its flags, or null when the run
 * names no script there: a flag that takes inline code, an unknown flag, or
 * nothing left after the flags.
 */
function flagCount(table: FlagTable, words: string[]): number | null {
  let i = 1;
  while (i < words.length) {
    const w = words[i];
    if (w === "--") return words.length > i + 1 ? i : null; // the end of the flags; counted as one
    if (!/^[-+]/.test(w)) return i - 1;
    const name = /^--[^=]+=/.test(w) ? w.slice(0, w.indexOf("=")) : w; // `--eval=code` is `--eval`
    if (table.inline.has(name)) return null;
    if (table.bare.has(w) || BARE_PREFIX.get(table)?.test(w)) { i += 1; continue; }
    if (table.value.has(w)) { i += 2; continue; }
    if (table.long && /^--[A-Za-z0-9][A-Za-z0-9-]*=.*$/.test(w)) { i += 1; continue; }
    if (table.attached?.some((f) => w.startsWith(f) && w.length > f.length)) { i += 1; continue; }
    const group = /^[-+]([A-Za-z]+)$/.exec(w)?.[1];
    if (group && table.letters) {
      if (table.inlineLetters && [...group].some((c) => table.inlineLetters!.includes(c))) return null;
      const last = group[group.length - 1];
      const body = table.valueLetter && last === table.valueLetter ? group.slice(0, -1) : group;
      if ([...body].every((c) => table.letters!.includes(c))) { i += body === group ? 1 : 2; continue; }
    }
    return null;
  }
  return null;
}

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
  // `"$CLAUDE_PROJECT_DIR"/` alone names the folder itself, not a file in it: an argument, kept as written
  if (/^\/+$/.test(path)) return word;
  // `"$CLAUDE_PROJECT_DIR"//x.sh` is `./x.sh`, never the root's `/x.sh`
  return path.includes('"') ? word : `.${path.replace(/^\/+/, "/")}`;
}

/**
 * The script word as a path: a backslash before a quote is dropped (a .at
 * string keeps `\"` as written) and a `$CLAUDE_PROJECT_DIR` path becomes the
 * project-relative `./x` it names. Any other word, a path through any other
 * variable (`"$HOME/x.sh"`) included, is unchanged, as before.
 */
function scriptWord(word: string): string {
  const plain = word.replace(/\\"/g, '"');
  const project = projectWord(plain);
  return project !== plain ? project : word;
}

/**
 * A `run:` split into the interpreter it names (if any), the interpreter's
 * flags (if any), its script, and the script's arguments. The script is the
 * first word, or the word after the interpreter and its flags
 * (`python3 x.py`, `/opt/homebrew/bin/python3 ./y.py`, `python3 -I -B x.py`).
 * The flags an interpreter may take are listed per interpreter (FlagTable);
 * after a flag that takes inline code (`bash -c '...'`, `python -m pkg`) or
 * one not listed, the run names no interpreter, and its first word is read as
 * the script, as before flags were read. `flags` is present only when there
 * are some, so a run without flags splits as it always did.
 *
 * A script word through `$CLAUDE_PROJECT_DIR` after an interpreter is read
 * as the project path it names (see scriptWord): `./x`; a word through any
 * other variable is left as written. When that word names a file, the
 * arguments' `\"` (a .at string's form) are read as `"`, so the command is
 * the one the harness ran (see decodedArgs).
 * A first word through a variable, and a word after anything but an
 * interpreter (`cd "$CLAUDE_PROJECT_DIR/web"`), are left as written, as
 * before: V96 refuses the first, and the second is an argument.
 *
 * The script name used to be the text after the LAST slash of the whole line,
 * so an argument became the script: `python3 tool.py check show/SLUG` planned
 * a stub named `SLUG`, and `pxframes.py gate OUT/frames-critic.json` one named
 * `frames-critic.json`.
 */
export function runParts(run: string): { interpreter?: string; flags?: string[]; script: string; args: string[] } {
  const words = run.trim().split(/\s+/);
  const first = words[0] ?? "";
  const table = INTERPRETER.test(first.replace(/^.*\//, "")) ? flagTable(first) : null;
  const flags = table && words.length > 1 && /^[-+]/.test(words[1]) ? flagCount(table, words) : 0;
  const at = (flags ?? 0) + 1;
  const named =
    flags !== null &&
    words.length > at &&
    !(flags === 0 && words[1].startsWith("-")) && // a flag no table reads: `mytool -x y`
    !SCRIPT_EXT.test(first) &&
    (table !== null || isProjectPath(words[1]));
  if (!named) {
    // The first word is the script, as written (V96 refuses a first word through a variable).
    const [script = "", ...args] = words;
    return { script, args };
  }
  const [script, ...args] = words.slice(at);
  const flagWords = at > 1 ? { flags: words.slice(1, at) } : {};
  // Only an interpreter's script word is read as a path; after `cd` or a program, the word is an argument.
  if (!table) return { interpreter: first, ...flagWords, script, args };
  return { interpreter: first, ...flagWords, script: scriptWord(script), args: decodedArgs(script, args) };
}

/**
 * An interpreter's arguments as the harness passed them: in a .at string's
 * form every `"` is `\"`, so they are read as `"` whenever the script word
 * names a file, quoted or not (`bash .claude/hooks/x.sh \"a b\"` passes one
 * argument, `a b`). It used to be only when the script word was quoted, so
 * import → scaffold wrote `\"a b\"` and the script got two. A run whose
 * script names no file (`bun run ...`, a stub import flags) keeps its
 * arguments as written, as 0.11.2 did.
 */
function decodedArgs(script: string, args: string[]): string[] {
  return isProjectPath(scriptWord(script)) ? args.map((a) => a.replace(/\\"/g, '"')) : args;
}

/**
 * Whether the run reader turns a run's `\"` into `"`: only when an
 * interpreter (one with a flag table) runs a script word that names a
 * project file (decodedArgs, the 0.12.6 path). Everywhere else, an inline
 * command, a direct script run, another program, the `\"` reaches the
 * command with its backslash (strings are not unescaped in 0.13.0).
 */
export function runDecodesQuotes(run: string): boolean {
  const first = run.trim().split(/\s+/)[0] ?? "";
  if (!INTERPRETER.test(first.replace(/^.*\//, "")) || !flagTable(first)) return false;
  const p = runParts(run);
  return !!p.interpreter && isProjectPath(p.script);
}

/**
 * Whether a script word names a file in the project (run where it is) rather
 * than one in the topology skill's scripts/ folder (scaffolded by basename).
 * `./x`, `/x` and any path with a folder count (a path through a variable,
 * `$CLAUDE_PROJECT_DIR/x` or `"${HOME}/x"`, among them), except the historical
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

/** Shell builtins a `run:` may be written as directly (`exit 2`, `true`). */
const SHELL_BUILTIN = /^(?:exit|true|false|echo|printf|test|\[|:)$/;

/**
 * Whether `run` is a shell command to run as written rather than a script:
 * its first word is a builtin. `run: "exit 2"` used to scaffold a stub script
 * named `exit` that exited 0, so a hook meant to block let everything through.
 */
export function isShellCommand(run: string | undefined): boolean {
  return !!run && SHELL_BUILTIN.test(run.trim().split(/\s+/)[0] ?? "");
}

/**
 * The interpreter a binding runs a script with (F-25): the one `run:` names,
 * else the one its extension names (`.py` python3, `.js` / `.mjs` / `.cjs`
 * node), else bash.
 */
export function interpreterFor(script: string, named?: string): string {
  if (named) return named;
  if (script.endsWith(".py")) return "python3";
  if (/\.(?:m|c)?js$/.test(script)) return "node";
  return "bash";
}
