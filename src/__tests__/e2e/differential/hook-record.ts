/**
 * The named exception to merge-differential-0112 for hook ownership by
 * record (approved): scaffold records each hook entry it writes, removes a
 * recorded entry the .at no longer generates (saying so), and never removes
 * an entry it did not write. A sequence that differs from 0.11.2 for that
 * reason alone is in exactly one class; any other difference stays red.
 *
 * - removed-line: settings.json is byte-identical to 0.11.2 after every
 *   step; the output differs only by added `- removed generated hook
 *   <event> <matcher> <command>` lines (0.11.2 took the same entries out
 *   without a word).
 * - generated-removed: an entry 0.11.2 left in settings.json, which scaffold
 *   wrote and the .at no longer generates, is gone, each with its `- removed
 *   generated hook` line; no entry is added. The output differs only by those
 *   lines, `~ .claude/settings.json (config merged)` for the kept or blocked
 *   line it replaces, and the counts.
 * - user-kept: an entry the user wrote, which 0.11.2 removed or replaced, is
 *   still in settings.json, and the output names it (`kept a command the .at
 *   does not generate: <command>`, `kept your hook …`, or `kept your edited
 *   copy of <event> <matcher>`, whose generated original is then not written
 *   again). Any entry 0.11.2 had that is gone has its `- removed generated
 *   hook` line or is the original of a kept edited copy.
 */

export type HookRecordKind = "removed-line" | "generated-removed" | "user-kept";

interface Step { code: number | null; output: string; settings: string | null }

type Hooks = Record<string, Array<{ matcher?: string; hooks?: Array<Record<string, unknown>> }>>;

/** Each hook entry as `<event>\t<matcher>\t<entry JSON>`. */
function entries(settings: string | null): string[] {
  const hooks = ((settings ? JSON.parse(settings) : {}) as { hooks?: Hooks }).hooks ?? {};
  const out: string[] = [];
  for (const [event, groups] of Object.entries(hooks)) {
    for (const g of groups ?? []) for (const h of g.hooks ?? []) out.push(`${event}\t${g.matcher ?? "(no matcher)"}\t${JSON.stringify(h)}`);
  }
  return out;
}

/** `a` less `b`, as multisets. */
function less(a: string[], b: string[]): string[] {
  const left = [...b];
  return a.filter((x) => {
    const i = left.indexOf(x);
    if (i === -1) return true;
    left.splice(i, 1);
    return false;
  });
}

const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter((l) => l !== "");
const REMOVED = /^- removed generated hook (\S+) (.+)$/;
const COUNTS = /^\d+ created, /;
const SETTINGS_LINE = /^(~ \.claude\/settings\.json \(config merged\)|= \.claude\/settings\.json \(kept: .*\)|⊘ \.claude\/settings\.json \(no longer generated, but edited — kept\))$/;
const KEPT = /^! \.claude\/settings\.json hooks\.\S+: kept /;

const commandOf = (entry: string) => (JSON.parse(entry.split("\t")[2]) as { command?: string }).command ?? "";
const removedLineFor = (entry: string, added: string[]) => {
  const [event, matcher] = entry.split("\t");
  return added.includes(`- removed generated hook ${event} ${matcher} ${commandOf(entry)}`);
};
const keptLineFor = (entry: string, added: string[]) => {
  const [event, matcher] = entry.split("\t");
  const command = commandOf(entry);
  return added.some(
    (l) =>
      KEPT.test(l) &&
      (l.endsWith(`kept a command the .at does not generate: ${command}`) ||
        l.includes(`kept your hook ${matcher} ${command}:`) ||
        l.includes(`kept your edited copy of ${event} ${matcher};`)),
  );
};
const editedCopyOf = (entry: string, added: string[]) => {
  const [event, matcher] = entry.split("\t");
  return added.some((l) => l.includes(`kept your edited copy of ${event} ${matcher};`));
};

/**
 * The class of a sequence whose steps (`was`: 0.11.2's, `now`: this build's,
 * outputs already compared out by the stub rulings) differ, or null when a
 * difference is outside every class.
 */
export function hookRecordKind(was: Step[], now: Array<Step & { output: string }>, outputs: Array<[string, string]>): HookRecordKind | null {
  if (was.length !== now.length) return null;
  let settingsDiffer = false;
  let userAdded = false;
  for (let n = 0; n < now.length; n++) {
    if (was[n].code !== now[n].code) return null;
    const [wasOut, nowOut] = outputs[n];
    const added = less(lines(nowOut), lines(wasOut));
    const gone = less(lines(wasOut), lines(nowOut));
    const extra = less(entries(now[n].settings), entries(was[n].settings));
    const missing = less(entries(was[n].settings), entries(now[n].settings));
    if (was[n].settings !== now[n].settings) settingsDiffer = true;
    if (extra.length > 0) userAdded = true;
    // Every output line that changed is one the record explains.
    if (!added.every((l) => REMOVED.test(l) || COUNTS.test(l) || SETTINGS_LINE.test(l) || KEPT.test(l))) return null;
    if (!gone.every((l) => COUNTS.test(l) || SETTINGS_LINE.test(l))) return null;
    // Every entry that changed is named.
    if (!missing.every((e) => removedLineFor(e, added) || editedCopyOf(e, added))) return null;
    if (!extra.every((e) => keptLineFor(e, added))) return null;
    // Same entries, different bytes (order, an edited field): not explained.
    if (was[n].settings !== now[n].settings && extra.length === 0 && missing.length === 0) return null;
  }
  if (userAdded) return "user-kept";
  if (settingsDiffer) return "generated-removed";
  // removed-line: nothing but `- removed generated hook` lines added.
  for (let n = 0; n < now.length; n++) {
    const [wasOut, nowOut] = outputs[n];
    if (less(lines(wasOut), lines(nowOut)).length > 0) return null;
    if (!less(lines(nowOut), lines(wasOut)).every((l) => REMOVED.test(l))) return null;
  }
  return "removed-line";
}
