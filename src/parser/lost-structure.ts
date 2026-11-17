/**
 * What the source declares and the parse does not hold (V131).
 *
 * The parser finds where a block ends by counting braces on
 * {@link braceText}, where a brace inside a quoted string still counts. A
 * structural scan reads the same source with every string, prompt and
 * comment blanked ({@link maskProse}). When the two disagree, a block ends
 * somewhere other than where it is written, and whatever falls outside it is
 * dropped from the parse without a message: a whole topology could parse to
 * no agents and no settings and still validate clean. This compares the two
 * readings and reports every block the parse does not hold as written.
 *
 * @module
 */

import { maskProse, braceText, closingBrace, quotedStrings, escapeRegex } from "./lexer.js";
import { SINGLE_SECTIONS } from "./sections.js";

const SINGLE: ReadonlySet<string> = new Set(SINGLE_SECTIONS);

export interface LostStructure {
  rule: "V131";
  level: "error";
  message: string;
  line: number;
  node?: string;
}

const NODE_KEYWORDS = new Set(["agent", "action", "human", "group"]);

interface Header {
  /** Where the keyword starts. */
  at: number;
  /** Just past the opening `{`. */
  open: number;
  keyword: string;
  id: string | null;
}

/** Block headers (`word id? ... {`) that start a line within [from, to) of the mask. */
function headersIn(mask: string, from: number, to: number): Header[] {
  const re = /(?:^|\n)[ \t]*([a-zA-Z][a-zA-Z0-9_-]*)(?:[ \t]+([a-zA-Z][a-zA-Z0-9_-]*))?[^{}\n]*\{/g;
  re.lastIndex = from;
  const out: Header[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(mask)) !== null) {
    const open = m.index + m[0].length;
    if (open > to) break;
    const at = m.index + m[0].indexOf(m[1]);
    if (at < from) continue;
    // `key: {` is a value, not a block header with an id.
    const id = /^[a-zA-Z][a-zA-Z0-9_-]*\s*:/.test(m[0].trim()) ? null : (m[2] ?? null);
    out.push({ at, open, keyword: m[1], id });
  }
  return out;
}

/**
 * Every block of the topology (or fragment) the parse does not hold as
 * written. `nodeIds` are the node ids the parse produced.
 */
export function findLostStructure(source: string, root: "topology" | "fragment", nodeIds: ReadonlySet<string>): LostStructure[] {
  const mask = maskProse(source);
  const braces = braceText(source);
  const head = new RegExp(`(?:^|\\n)\\s*${escapeRegex(root)}(?:\\s+([a-zA-Z][a-zA-Z0-9_-]*))?[^{\\n]*\\{`).exec(mask);
  if (!head) return [];
  const start = head.index + head[0].length;
  const end = closingBrace(braces, start);
  // A root block that never closes is already a parse error.
  if (end < 0) return [];

  const lineAt = (i: number) => source.slice(0, i).split("\n").length;
  const label = (h: Header) => (h.id ? `${h.keyword} ${h.id}` : h.keyword);
  const results: LostStructure[] = [];

  // The first quoted string whose braces do not balance: the usual reason
  // the two readings disagree. Looked up only when something is lost.
  const unbalancedString = (): number | null => {
    for (const [a, b] of quotedStrings(source)) {
      let d = 0;
      for (let k = a; k < b; k++) {
        if (source[k] === "{") d++;
        else if (source[k] === "}") d--;
      }
      if (d !== 0) return a;
    }
    return null;
  };
  const why = () => {
    const a = unbalancedString();
    return a !== null ? `a brace inside the quoted string on line ${lineAt(a)} counts as structure` : "its braces do not balance";
  };
  const fix = () =>
    why().startsWith("a brace inside")
      ? "Balance the braces in that string or remove the brace."
      : "Remove the stray brace or add the missing one.";

  // 1. The root block ends before the source does: everything after it is unread.
  const restAt = mask.slice(end + 1).search(/[^\s}]/);
  if (restAt >= 0) {
    const from = end + 1 + restAt;
    const lost = headersIn(mask, end + 1, mask.length).filter((h) => {
      // Only blocks at the root's own level: count the mask's depth from the cut.
      let d = 0;
      for (let k = end + 1; k < h.at; k++) {
        if (mask[k] === "{") d++;
        else if (mask[k] === "}") d--;
      }
      return d <= 0;
    });
    const names = lost.map((h) => `${label(h)} (line ${lineAt(h.at)})`);
    results.push({
      rule: "V131",
      level: "error",
      line: lineAt(end),
      message:
        `Parsing stopped at line ${lineAt(end)}: the ${root} block closes there because ${why()}, ` +
        `so nothing from line ${lineAt(from)} on is read` +
        (names.length ? `: ${names.join(", ")}` : "") +
        `. ${fix()}`,
    });
  }

  // 2. Inside the root, every block must start and end where it is written.
  const depthMask: number[] = new Array(end - start + 1);
  const depthBrace: number[] = new Array(end - start + 1);
  let dm = 0;
  let db = 0;
  for (let k = start; k <= end; k++) {
    depthMask[k - start] = dm;
    depthBrace[k - start] = db;
    if (mask[k] === "{") dm++;
    else if (mask[k] === "}") dm--;
    if (braces[k] === "{") db++;
    else if (braces[k] === "}") db--;
  }
  const flagged = new Set<number>();
  const top = headersIn(mask, start, end).filter((h) => depthMask[h.at - start] === 0);
  for (const h of top) {
    const asWritten = closingBrace(mask, h.open);
    const asParsed = closingBrace(braces, h.open);
    if (depthBrace[h.at - start] === 0 && asWritten === asParsed) continue;
    flagged.add(h.at);
    results.push({
      rule: "V131",
      level: "error",
      line: lineAt(h.at),
      ...(h.id && NODE_KEYWORDS.has(h.keyword) ? { node: h.id } : {}),
      message:
        `The ${label(h)} block at line ${lineAt(h.at)} is not read as written: ${why()}, ` +
        `so the parse ${depthBrace[h.at - start] !== 0 ? "counts it inside an earlier block" : `ends it at line ${asParsed < 0 ? "?" : lineAt(asParsed)} instead of line ${lineAt(asWritten)}`}. ` +
        fix(),
    });
  }

  // 3. Every node declared in the root (and every gate in `gates { }`) is in the parse.
  // A second copy of a single section (sections.ts) is unused by design and
  // already a V23 warning: its nodes are not in the parse, and that is not a
  // brace problem, so they are not checked here.
  const seen = new Set<string>();
  const duplicate = new Set<number>();
  for (const h of top) {
    if (!SINGLE.has(h.keyword)) continue;
    if (seen.has(h.keyword)) duplicate.add(h.at);
    seen.add(h.keyword);
  }
  const declared: Header[] = top.filter((h) => NODE_KEYWORDS.has(h.keyword) && h.id);
  for (const g of top.filter((h) => h.keyword === "gates" && !duplicate.has(h.at))) {
    const close = closingBrace(mask, g.open);
    if (close < 0) continue;
    let d = 0;
    let k = g.open;
    for (const h of headersIn(mask, g.open, close)) {
      for (; k < h.at; k++) {
        if (mask[k] === "{") d++;
        else if (mask[k] === "}") d--;
      }
      if (d === 0 && h.keyword === "gate" && h.id) declared.push(h);
    }
  }
  // When the two readings agree on every top-level block and no quoted string
  // is unbalanced, the braces balance: a missing node then has some other
  // cause, and the message must not blame a brace.
  const bracesBalance = results.length === 0 && unbalancedString() === null;
  for (const h of declared) {
    if (flagged.has(h.at) || nodeIds.has(h.id as string)) continue;
    results.push({
      rule: "V131",
      level: "error",
      line: lineAt(h.at),
      node: h.id as string,
      message: bracesBalance
        ? `${label(h)} is declared at line ${lineAt(h.at)} but the parse holds no node "${h.id}", and every block ends where it is written. Check the block's header and where it is placed.`
        : `${label(h)} is declared at line ${lineAt(h.at)} but the parse holds no node "${h.id}": ${why()}. ${fix()}`,
    });
  }
  return results;
}
