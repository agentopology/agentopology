/**
 * The stub changes ruled in after 0.12.4, applied when output frozen from
 * v0.11.2 is compared with today's, so every other byte is still held to
 * 0.11.2:
 *
 *   1. scaffold's stub summary (stderr) counts stubs by kind and no longer
 *      lists a path that holds the user's own file, and validate prints the
 *      count too. stub-count.test.ts asserts both; here they are taken out
 *      of both sides.
 *   2. guard --check grades a gate whose check script is still a stub
 *      `none` (it checks nothing), not refuse; the refuse-only notes go, the
 *      stub note is reworded, the enforcement count drops by one per gate,
 *      and one line after the counts says how many. Not counted missing, so
 *      exit codes are unchanged. regradeStubbedGates rewrites the frozen
 *      side exactly so; the report's column padding then differs, so runs of
 *      padding spaces compare as one.
 */

const OLD_STUB_NOTE = /^(\s+)⚠ its check script (\S+) is still a stub, so it blocks every run until it is written$/;
/** Notes only the refuse branch writes (check.ts): a stop event's, and a missing onFailure: block. */
const REFUSE_ONLY_NOTES = [
  "exit 2 keeps the agent working until the gate passes; a call it already made is not undone",
  'the entry has no onFailure: "block", so the step goes through if the hook cannot start',
];
const ITEM = /^  \S/;
const NOTE = /^\s+[⚠✗] /;
const MARK = / · installed \S+: \S+$/;
/** A line of scaffold's stub summary between its header and its "Search for" line. */
const SUMMARY_BODY = /^\s+(by kind: |· )/;
const SUMMARY_HEAD = /^\s+\d+ stub\(s\) need implementation before this topology can run:$/;
const SUMMARY_TAIL = /^\s+Search for "# AGENTOPOLOGY_STUB/;

/** validate's stub lines (new): the count, and the paths that hold the user's own files. */
const VALIDATE_STUB_LINE = /^  (stubs \([^)]+\): \d+ of \d+ generated files are stubs: |1 stub path already holds your own file: |\d+ stub paths already hold your own files: )/;

/**
 * Ruling 1: scaffold's stub summary, from the blank line before it through its
 * "Search for" line, taken out; and validate's stub lines (new, with the blank
 * line after them), taken out.
 */
export function stubless(text) {
  const lines = text.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (VALIDATE_STUB_LINE.test(lines[i])) {
      while (i + 1 < lines.length && VALIDATE_STUB_LINE.test(lines[i + 1])) i++;
      if (lines[i + 1] === "") i++;
      continue;
    }
    if (SUMMARY_HEAD.test(lines[i])) {
      // Only a whole summary goes: header, by-kind and path lines, the "Search for" line.
      let j = i + 1;
      while (j < lines.length && SUMMARY_BODY.test(lines[j])) j++;
      if (j < lines.length && SUMMARY_TAIL.test(lines[j])) {
        if (out.length && out[out.length - 1] === "") out.pop();
        i = j;
        continue;
      }
    }
    out.push(lines[i]);
  }
  return out.join("\n");
}

/** Ruling 2, on output frozen before it: each gate whose check script was a stub, regraded none. */
export function regradeStubbedGates(text) {
  const lines = text.split("\n");
  const out = [];
  let regraded = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!(ITEM.test(lines[i]) && lines[i].startsWith("  gate "))) { out.push(lines[i]); continue; }
    let j = i + 1;
    while (j < lines.length && NOTE.test(lines[j])) j++;
    const notes = lines.slice(i + 1, j);
    const stub = notes.map((n) => OLD_STUB_NOTE.exec(n)).find(Boolean);
    // Only a gate graded refuse (the only grade the stub note came with) is regraded.
    const m = /^(  gate \S+\s+)(refuse\b.*?)(\s+by: .*)$/.exec(lines[i].replace(MARK, ""));
    if (!stub || !m) { out.push(...lines.slice(i, j)); i = j - 1; continue; }
    out.push(`${m[1]}none${m[3]}`);
    // Every note stays in place, except the refuse-only ones; the stub note is reworded.
    for (const n of notes) {
      if (REFUSE_ONLY_NOTES.some((r) => n.trim() === `⚠ ${r}`)) continue;
      out.push(n === stub[0] ? `${stub[1]}⚠ its check script ${stub[2]} is still a stub: it checks nothing and blocks every run until it is written` : n);
    }
    regraded++;
    i = j - 1;
  }
  if (regraded === 0) return text;
  const e = out.findIndex((l) => /^enforcement: \d+ of \d+ steps refuse/.test(l));
  if (e < 0) return text;
  out[e] = out[e].replace(/^enforcement: (\d+)/, (_, n) => `enforcement: ${Number(n) - regraded}`);
  // Where the report puts it: after the enforcement line, the unattributed-hook block and the missing line.
  let k = e + 1;
  if (k < out.length && /^\d+ hook\(s\) in \S+ are not tied to any step here/.test(out[k])) {
    k++;
    while (k < out.length && /^  \S/.test(out[k])) k++;
  }
  if (k < out.length && /^\d+ item\(s\) are missing or their citation no longer holds/.test(out[k])) k++;
  out.splice(k, 0, `${regraded} gate(s) graded none because their check script is still a stub: it checks nothing and blocks every run; write it and remove its AGENTOPOLOGY_STUB line`);
  return out.join("\n");
}

/** Column padding (two or more spaces after text) compared as one space, on the report's item lines only. */
export function unpadded(text) {
  return text.split("\n").map((l) => (ITEM.test(l) && /\s by: /.test(l) ? l.replace(/(\S) {2,}/g, "$1 ") : l)).join("\n");
}

/**
 * [frozen, today] as the comparison sees them: both without the stub summary,
 * the frozen side regraded. Padding compares as one space only on item lines
 * of an output where a regrade happened (it changes the report's column
 * width); elsewhere every byte still counts.
 */
export function ruledSides(was, now) {
  const regraded = regradeStubbedGates(was);
  const pad = regraded !== was ? unpadded : (s) => s;
  return [pad(stubless(regraded)), pad(stubless(now))];
}
