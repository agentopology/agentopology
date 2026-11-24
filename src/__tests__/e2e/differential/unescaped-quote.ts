/**
 * A named exception to merge-differential-0112, unescaped-quote-warning
 * (approved for 0.13.0). A .at string keeps its backslashes as written, and
 * import writes a hand-written command's quotes as `\"`, so an rt harness
 * whose hook command holds a `"` on a path the run reader does not decode (an
 * inline echo or printf, another program, `bash -c`) imports to a run: whose
 * `\"` reaches the command with its backslash. validate now warns on it (V96).
 * That warning is the only difference allowed, in the two places it shows:
 *
 *   - validate: `All validation rules passed.` becomes the one V96 warning
 *     line, the `0 error(s), 1 warning(s)` line and V96's lesson;
 *   - import: its verdict line (`Generated file passes all validation rules.`,
 *     or, with a hook it cannot compile faithfully, `Generated .at passes
 *     validation, but N hook(s) ...`) becomes the `0 error(s), 1 warning(s) in
 *     generated file.` line and its `Run agentopology validate` line.
 *
 * Each function maps today's output back to the earlier form, or returns null
 * when the warning is not there exactly once. The caller compares the result
 * byte for byte with the frozen output, and compares exit codes and
 * settings.json as before, so any other difference stays red.
 */

const MESSAGE = '`\\"` reaches the command unescaped; this check may never pass or refuse as written';
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const WARN = new RegExp(`  WARN  \\[V96\\] Hook "[^"\\n]+" "run": ${esc(MESSAGE)}\\n\\n  0 error\\(s\\), 1 warning\\(s\\)\\n\\n`, "g");
const LESSON = /  ── how to write it ─+\n\n  \[V96\]\n(?: {4}.*\n)+?\n$/;

/** validate's output with the one V96 quote warning and its lesson put back as the pass line, or null. */
export function unescapedQuoteValidate(now: string): string | null {
  if ((now.match(WARN) ?? []).length !== 1 || !LESSON.test(now)) return null;
  return now.replace(LESSON, "").replace(WARN, "  All validation rules passed.\n\n");
}

const COUNT = /\n\n {2}0 error\(s\), 1 warning\(s\) in generated file\.\n {2}Run agentopology validate \S+ for details\.\n/;

/** import's output with the warning count put back as its verdict line, or null. `nowValidate` is the validate step's output, which must hold the warning. */
export function unescapedQuoteImport(now: string, nowValidate: string): string | null {
  if (!COUNT.test(now) || unescapedQuoteValidate(nowValidate) === null) return null;
  const unfaithful = (now.match(/^ {2}ERROR Hook "[^"\n]+": this hook can't be compiled faithfully/gm) ?? []).length;
  const verdict = unfaithful > 0
    ? `  Generated .at passes validation, but ${unfaithful} hook(s) can't be compiled faithfully (exit 2)`
    : "  Generated file passes all validation rules.";
  return now.replace(COUNT, `\n${verdict}\n`);
}
