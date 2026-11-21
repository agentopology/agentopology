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
/** Notes the none branch keeps for a gate before a script step (before-action.sh). */
const KEPT_NOTES = /⚠ (refuses in Claude Code sessions only|a step named through a variable)/;
const ITEM = /^  \S/;
const NOTE = /^\s+[⚠✗] /;
const MARK = / · installed \S+: \S+$/;

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
    if (/^\s+\d+ stub\(s\) need implementation before this topology can run:$/.test(lines[i])) {
      if (out.length && out[out.length - 1] === "") out.pop();
      while (i < lines.length && !/^\s+Search for "# AGENTOPOLOGY_STUB/.test(lines[i])) i++;
      continue;
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
    if (!stub) { out.push(...lines.slice(i, j)); i = j - 1; continue; }
    const m = /^(  gate \S+\s+)(.*?)(\s+by: .*)$/.exec(lines[i].replace(MARK, ""));
    out.push(`${m[1]}none${m[3]}`);
    out.push(`${stub[1]}⚠ its check script ${stub[2]} is still a stub: it checks nothing and blocks every run until it is written`);
    out.push(...notes.filter((n) => KEPT_NOTES.test(n)));
    regraded++;
    i = j - 1;
  }
  if (regraded === 0) return text;
  const e = out.findIndex((l) => /^enforcement: \d+ of \d+ steps refuse/.test(l));
  out[e] = out[e].replace(/^enforcement: (\d+)/, (_, n) => `enforcement: ${Number(n) - regraded}`);
  // After the counts: the enforcement line, any unattributed-hook block, the missing line.
  let k = e + 1;
  while (k < out.length && out[k] !== "" && !/^\d+ gate\(s\) cite code/.test(out[k]) && !/^\S.*top level/.test(out[k])) k++;
  out.splice(k, 0, `${regraded} gate(s) graded none because their check script is still a stub: it checks nothing and blocks every run; write it and remove its AGENTOPOLOGY_STUB line`);
  return out.join("\n");
}

/** Column padding (two or more spaces after text) compared as one space. */
export function unpadded(text) {
  return text.replace(/(\S) {2,}/g, "$1 ");
}

/**
 * [frozen, today] as the comparison sees them: both without the stub summary,
 * the frozen side regraded. Padding compares as one space only where a
 * regrade happened (it changes the report's column width); elsewhere every
 * byte still counts.
 */
export function ruledSides(was, now) {
  const regraded = regradeStubbedGates(was);
  const pad = regraded !== was ? unpadded : (s) => s;
  return [pad(stubless(regraded)), pad(stubless(now))];
}
