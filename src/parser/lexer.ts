/**
 * Lexical utilities for the AgenTopology parser.
 *
 * These low-level functions handle comment stripping, block extraction,
 * key-value parsing, and list parsing. They operate on raw source strings
 * and know nothing about the AgenTopology grammar beyond brace-matched
 * blocks and `key: value` lines.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Comment handling
// ---------------------------------------------------------------------------

/**
 * Strip an inline `#` comment from a single line.
 *
 * Scans left-to-right, tracking whether we are inside a quoted string.
 * The first `#` preceded by whitespace (or at position 0) that is
 * outside quotes is treated as the start of a comment; everything from
 * that `#` to end-of-line is removed and trailing whitespace is trimmed.
 */
function stripInlineComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === "#" && !inSingle && !inDouble) {
      // Only treat as comment if preceded by whitespace (or at start of line)
      if (i === 0 || /\s/.test(line[i - 1])) {
        return line.slice(0, i).trimEnd();
      }
    }
  }
  return line;
}

/**
 * Strip single-line comments from source text.
 *
 * Lines whose first non-whitespace character is `#` are replaced with
 * empty lines (preserving line count for error reporting).
 * Lines inside `prompt { }` blocks are preserved as-is, so that
 * `# markdown headings` survive comment stripping.
 */
export function stripComments(src: string): string {
  const lines = src.split("\n");

  // Pre-scan: find line ranges that fall inside prompt { } blocks.
  // We use simple brace-counting starting from each `prompt {` occurrence.
  const insidePrompt = new Set<number>();
  for (let li = 0; li < lines.length; li++) {
    const trimmed = lines[li].trimStart();
    // Detect `prompt {` (optionally preceded by whitespace)
    if (/^prompt\s*\{/.test(trimmed)) {
      // Count braces starting from the opening `{`
      let depth = 0;
      const lineText = lines[li];
      // Find the first `{` on this line
      const braceIdx = lineText.indexOf("{");
      // Count braces from that point forward on this line
      for (let ci = braceIdx; ci < lineText.length; ci++) {
        if (lineText[ci] === "{") depth++;
        else if (lineText[ci] === "}") depth--;
      }
      // Mark subsequent lines as inside the prompt block
      let j = li + 1;
      while (j < lines.length && depth > 0) {
        insidePrompt.add(j);
        for (const ch of lines[j]) {
          if (ch === "{") depth++;
          else if (ch === "}") depth--;
        }
        j++;
      }
    }
  }

  return lines
    .map((line, idx) => {
      if (insidePrompt.has(idx)) return line; // preserve prompt block content
      const trimmed = line.trimStart();
      if (trimmed.startsWith("#")) return "";
      return stripInlineComment(line);
    })
    .join("\n");
}

/**
 * Dedent a block of text by removing the common leading whitespace.
 *
 * - Finds the minimum indentation (spaces/tabs) among non-empty lines
 * - Strips that common prefix from all lines
 * - Trims leading and trailing blank lines
 */
export function dedentBlock(text: string): string {
  const lines = text.split("\n");

  // Find minimum indentation among non-empty lines
  let minIndent = Infinity;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const match = line.match(/^(\s*)/);
    if (match && match[1].length < minIndent) {
      minIndent = match[1].length;
    }
  }

  if (minIndent === Infinity) minIndent = 0;

  // Strip the common prefix from all lines
  const dedented = lines.map((line) => {
    if (line.trim().length === 0) return "";
    return line.slice(minIndent);
  });

  // Trim leading and trailing blank lines
  while (dedented.length > 0 && dedented[0].trim() === "") dedented.shift();
  while (dedented.length > 0 && dedented[dedented.length - 1].trim() === "")
    dedented.pop();

  return dedented.join("\n");
}

// ---------------------------------------------------------------------------
// Regex helpers
// ---------------------------------------------------------------------------

/** Escape special regex characters in a string so it can be used as a literal pattern. */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Block extraction
// ---------------------------------------------------------------------------

/** Result of extracting a brace-delimited block. */
export interface BlockResult {
  /** The identifier token after the keyword, or null if none was present. */
  id: string | null;
  /** The content between the outermost `{` and `}`, exclusive. */
  body: string;
  /** Where the keyword starts in the searched string (extractTopLevelBlocks only). */
  at?: number;
}

/**
 * Extract the first top-level block matching `keyword identifier? { ... }`.
 *
 * Uses brace counting to handle arbitrarily nested blocks.
 * Returns the inner content (between the outermost braces) and the
 * identifier if one was present after the keyword.
 *
 * @param src    - The source string to search.
 * @param keyword - The keyword that introduces the block.
 * @returns The extracted block, or `null` if no match was found.
 */
export function extractBlock(
  src: string,
  keyword: string
): BlockResult | null {
  const re = new RegExp(
    `(?:^|\\n)\\s*${escapeRegex(keyword)}(?:\\s+([a-zA-Z][a-zA-Z0-9_-]*))?[^{\\n]*\\{`,
    "m"
  );
  const mask = maskProse(src);
  const m = re.exec(mask);
  if (!m) return null;

  const id = m[1] ?? null;
  const startIdx = m.index! + m[0].length;
  const end = closingBrace(braceText(src), startIdx);
  if (end < 0) return null;
  return { id, body: src.slice(startIdx, end) };
}

/**
 * The text block depth is counted on. Lookups (where a block or a field is)
 * read {@link maskProse}; depth (where a block ends) is counted as 0.11.4
 * counted it, on the source itself, except that a `#` comment's content is
 * blanked: a brace in a comment is text and never opens or closes a block.
 * A brace inside a quoted string still counts. A prompt's content balances
 * its own braces (that is where the prompt ends), so counting it changes no
 * depth outside it; a `#` inside a prompt or a quoted string is not a comment.
 */
export function braceText(src: string): string {
  return blankProse(src, false);
}

/**
 * The index of the `}` that closes a block whose content starts at `start`,
 * counted on {@link braceText}, or -1 when the block is not closed.
 */
export function closingBrace(text: string, start: number): number {
  let depth = 1;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return i;
  }
  return -1;
}

/**
 * Extract ALL blocks matching `keyword identifier? { ... }` within a source string.
 *
 * Similar to {@link extractBlock} but returns every match instead of just the first.
 *
 * @param src     - The source string to search.
 * @param keyword - The keyword (or regex fragment) that introduces each block.
 * @returns Array of extracted blocks.
 */
export function extractAllBlocks(
  src: string,
  keyword: string
): BlockResult[] {
  const results: BlockResult[] = [];
  const re = new RegExp(
    `(?:^|\\n)\\s*${escapeRegex(keyword)}(?:\\s+([a-zA-Z][a-zA-Z0-9_-]*))?[^{\\n]*\\{`,
    "gm"
  );
  const mask = maskProse(src);
  let m: RegExpExecArray | null;
  while ((m = re.exec(mask)) !== null) {
    const id = m[1] ?? null;
    const startIdx = m.index! + m[0].length;
    const end = closingBrace(braceText(src), startIdx);
    if (end >= 0) {
      results.push({ id, body: src.slice(startIdx, end) });
    }
  }
  return results;
}

/**
 * Like {@link extractAllBlocks}, but only blocks whose keyword sits at brace
 * depth 0 of `src`: `env { }` inside an MCP server is not a topology `env`.
 */
export function extractTopLevelBlocks(
  src: string,
  keyword: string
): BlockResult[] {
  const mask = maskProse(src);
  const braces = braceText(src);
  const depthAt: number[] = new Array(src.length);
  let depth = 0;
  for (let i = 0; i < src.length; i++) {
    depthAt[i] = depth;
    if (braces[i] === "{") depth++;
    else if (braces[i] === "}") depth--;
  }
  const results: BlockResult[] = [];
  const re = new RegExp(
    `(?:^|\\n)\\s*${escapeRegex(keyword)}(?![a-zA-Z0-9_-])(?:\\s+([a-zA-Z][a-zA-Z0-9_-]*))?[^{\\n]*\\{`,
    "gm"
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(mask)) !== null) {
    const at = m.index! + m[0].indexOf(keyword);
    const startIdx = m.index! + m[0].length;
    if (depthAt[at] !== 0) continue;
    const end = closingBrace(braces, startIdx);
    if (end >= 0) results.push({ id: m[1] ?? null, body: src.slice(startIdx, end), at });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Key-value & list parsing
// ---------------------------------------------------------------------------

/**
 * Parse a single `key: value` line.
 *
 * @returns A `[key, rawValue]` tuple, or `null` if the line is not a valid KV pair.
 */
export function parseKV(line: string): [string, string] | null {
  const m = line.match(/^\s*([a-zA-Z_-]+)\s*:\s*(.+?)\s*$/);
  if (!m) return null;
  return [m[1], m[2]];
}

/**
 * Parse a bracketed list `[a, b, c]` into a string array.
 *
 * If the input is not a bracketed list, returns an array containing the
 * trimmed input as a single element.
 */
export function parseList(raw: string): string[] {
  const text = raw.trim();
  if (text.startsWith("[")) {
    const scanned = scanList(text, 0);
    if (scanned.ok && scanned.end === text.length) return scanned.items;
  }
  return [raw.trim()];
}

/** The result of reading one `[ ... ]` list: its items, or why it is not a list. */
export type ScannedList =
  | { ok: true; items: string[]; end: number }
  | { ok: false; reason: string };

/**
 * Read the list that opens at `src[open]` (a `[`).
 *
 * A double-quoted item is one item whatever it holds: `]`, `[` and `,`
 * inside quotes are text, and `\"` does not close the quote. Outside quotes
 * brackets nest, so an unquoted `Bash(rm [a-z]*)` is one item too. Items are
 * split at top-level commas, trimmed, their outer quotes removed, and empty
 * items dropped. `end` is the index just past the closing `]`.
 *
 * Not a list: the closing `]` never comes, a quoted item runs past its line,
 * or a `{` / `}` appears outside quotes (a block, not a list item).
 */
export function scanList(src: string, open: number): ScannedList {
  const items: string[] = [];
  const push = (s: string) => {
    const t = s.trim();
    const item = /^".*"$/s.test(t) && t.length > 1 ? unescapeString(t.slice(1, -1)) : t.replace(/^"|"$/g, "");
    if (item) items.push(item);
  };
  let cur = "";
  let depth = 1;
  let inQuote = false;
  for (let i = open + 1; i < src.length; i++) {
    const ch = src[i];
    if (inQuote) {
      if (ch === "\n") return { ok: false, reason: "a quoted item is not closed on its line" };
      cur += ch;
      if (ch === "\\" && i + 1 < src.length && src[i + 1] !== "\n") cur += src[++i];
      else if (ch === '"') inQuote = false;
      continue;
    }
    if (ch === '"') inQuote = true;
    else if (ch === "[") depth++;
    else if (ch === "]" && --depth === 0) {
      push(cur);
      return { ok: true, items, end: i + 1 };
    } else if (ch === "{" || ch === "}") {
      return { ok: false, reason: "it is not closed with ] before the block ends" };
    } else if (ch === "," && depth === 1) {
      push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  return { ok: false, reason: inQuote ? "a quoted item is not closed" : "it is not closed with ]" };
}

/**
 * `src` with its prose blanked out: the content of every `prompt { }` block,
 * of every double-quoted string and of every `#` comment becomes spaces
 * (newlines stay, so offsets and line numbers are those of `src`).
 *
 * Prose is never structure: a block keyword, a field or a brace found only in
 * prose is text. Every structural lookup (block extraction, field lookup,
 * depth counting) runs on this mask and slices its result from `src`.
 *
 * A prompt block ends where it always did: at the `}` that balances every
 * brace in its content, quoted or not, so a code sample keeps parsing as
 * before. A quoted string ends at its closing quote (`\"` does not close it)
 * or at its line's end. A `#` starts a comment at a line's start or after
 * whitespace, as in {@link stripComments}.
 */
export function maskProse(src: string): string {
  return blankProse(src, true);
}

/**
 * The content ranges `[start, end)` of every double-quoted string outside a
 * prompt and a comment, as {@link maskProse} reads them.
 */
export function quotedStrings(src: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  blankProse(src, false, (a, b) => spans.push([a, b]));
  return spans;
}

/**
 * Scan `src` for prompts, quoted strings and `#` comments (in reading order:
 * a `#` inside a string or a prompt is not a comment) and blank every
 * comment's content; with `all`, also the content of every string and prompt.
 */
function blankProse(src: string, all: boolean, onString?: (start: number, end: number) => void): string {
  const out = src.split("");
  const blank = (a: number, b: number) => {
    for (let k = a; k < b; k++) if (out[k] !== "\n") out[k] = " ";
  };
  const n = src.length;
  const promptHead = /prompt\s*\{/y;
  let i = 0;
  while (i < n) {
    const ch = src[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < n && src[j] !== "\n" && src[j] !== '"') j += src[j] === "\\" && src[j + 1] !== "\n" ? 2 : 1;
      j = Math.min(j, n);
      onString?.(i + 1, j);
      if (all) blank(i + 1, j);
      i = j < n && src[j] === '"' ? j + 1 : j;
      continue;
    }
    if (ch === "#" && (i === 0 || /\s/.test(src[i - 1]))) {
      const j = src.indexOf("\n", i);
      blank(i, j < 0 ? n : j);
      i = j < 0 ? n : j;
      continue;
    }
    if (ch === "p" && (i === 0 || /[\s{;]/.test(src[i - 1]))) {
      promptHead.lastIndex = i;
      const m = promptHead.exec(src);
      if (m) {
        const start = i + m[0].length;
        let d = 1;
        let j = start;
        while (j < n) {
          if (src[j] === "{") d++;
          else if (src[j] === "}" && --d === 0) break;
          j++;
        }
        // The content is prose; the closing brace is structure.
        if (all) blank(start, j);
        i = j;
        continue;
      }
    }
    i++;
  }
  return out.join("");
}

/**
 * Parse a multiline bracketed list that may span multiple lines.
 *
 * Searches for `key: [ ... ]` in the body (potentially spanning newlines)
 * and returns the items as a string array. Uses a word boundary before the
 * key to avoid partial matches (e.g. searching for "tools" will not match
 * "disallowed-tools"). Quoted items may hold `]` and `,` (see {@link scanList}).
 *
 * @throws Error when the list is not closed, a quoted item is not closed, or
 *   text follows the closing `]` on its line: part of a list is never kept.
 */
export function parseMultilineList(body: string, key: string): string[] {
  // A `key: [` in prose (a prompt block, a quoted string, a comment) is
  // text, not a field: only the mask is searched. The first match is the list.
  const re = new RegExp(`(?:^|(?<=\\s))${escapeRegex(key)}\\s*:\\s*\\[`, "m");
  const m = re.exec(maskProse(body));
  if (!m) return [];
  const open = m.index + m[0].length - 1;
  const scanned = scanList(body, open);
  const shown = () => body.slice(m.index).split("\n")[0].trim();
  if (!scanned.ok) throw new Error(`The list for "${key}" is malformed: ${scanned.reason} (${shown()})`);
  const nl = body.indexOf("\n", scanned.end);
  const rest = body.slice(scanned.end, nl < 0 ? undefined : nl).trim();
  // Another field may share the line (`commands: [x] unit-from: "y"`); any
  // other text means the list ended early, at a `]` that belonged to an item.
  if (rest && !/^[}\s]*$/.test(rest) && !/^[a-zA-Z_][a-zA-Z0-9_-]*\s*:/.test(rest)) {
    throw new Error(
      `The list for "${key}" is malformed: text follows its closing ] ("${rest}"). ` +
        `Quote an item that holds [ or ]: ${shown()}`
    );
  }
  return scanned.items;
}

/**
 * Remove surrounding double quotes from a string value.
 *
 * A quoted string reads two escapes: `\"` is a quote and `\\` is a backslash.
 * Any other backslash stays as written (`\S`, `\d`, `\n`). If the string is
 * not quoted, returns it unchanged.
 */
export function unquote(s: string): string {
  const m = /^"(.*)"$/.exec(s);
  return m ? unescapeString(m[1]) : s;
}

/** Read the two escapes of a quoted .at string, in one left-to-right pass. */
export function unescapeString(s: string): string {
  return s.replace(/\\([\\"])/g, "$1");
}

/** The inverse of {@link unescapeString}, for writing a value as a quoted .at string. */
export function escapeString(s: string): string {
  return s.replace(/[\\"]/g, "\\$&");
}

/**
 * Parse all simple `key: value` lines from a block body into a record.
 *
 * Skips lines that are not valid KV pairs (blank lines, nested blocks, etc.).
 */
export function parseFields(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  let depth = 0;
  // Keys are read from the mask (prose is never a field), depth from
  // braceText; the value is the line's own text.
  const lines = body.split("\n");
  const masked = maskProse(body).split("\n");
  const braceLines = braceText(body).split("\n");
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    // Track brace depth so we only parse top-level KV pairs.
    for (const ch of braceLines[li]) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    // Only parse KV pairs at the top level (depth 0 or just entered depth 1
    // on this line — but we want lines *before* any nested block opens).
    // After processing braces for this line, if depth > 0 we are inside a
    // nested block. However, the line that *opens* a block (e.g. "variants {")
    // will have depth > 0 after processing — that line is a block header, not
    // a KV pair, so skipping it is correct.
    if (depth === 0) {
      const kv = parseKV(masked[li]) && parseKV(line);
      if (kv) {
        fields[kv[0]] = kv[1];
      }
    }
  }
  return fields;
}

/**
 * Parse an `outputs: { key: val | val | val }` sub-block.
 *
 * @returns A map of output names to their possible enum values, or `null`
 *          if no `outputs` block is found.
 */
export function parseOutputsBlock(body: string): Record<string, string[]> | null {
  const block = extractBlock(body, "outputs");
  if (!block) return null;
  const result: Record<string, string[]> = {};
  for (const line of block.body.split("\n")) {
    const kv = parseKV(line);
    if (kv) {
      result[kv[0]] = kv[1].split("|").map((s) => s.trim());
    }
  }
  return result;
}
