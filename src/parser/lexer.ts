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
/**
 * Find the index just past the `}` that closes a block opened before `startIdx`.
 *
 * Braces inside fenced code blocks (``` or ~~~) and inline code spans (`…`) are
 * ignored. Prompt blocks carry arbitrary markdown, so a single stray brace in a
 * code sample or quoted string would otherwise close the prompt, its agent, and
 * the topology itself — surfacing much later as unrelated "agent is not in flow"
 * errors that point nowhere near the real cause.
 *
 * @param src        - Source text.
 * @param startIdx   - Index of the first character after the opening `{`.
 * @param startDepth - Nesting depth at `startIdx` (1 when just inside a block).
 * @returns Index just past the matching `}`, or -1 when unbalanced.
 */
export function findMatchingBrace(
  src: string,
  startIdx: number,
  startDepth = 1,
): number {
  let depth = startDepth;
  let i = startIdx;
  let inFence = false;
  let fenceChar = "";
  let fenceLen = 0;
  let atLineStart = true;

  while (i < src.length) {
    const ch = src[i];

    if (ch === "\n") {
      atLineStart = true;
      i++;
      continue;
    }

    // A fence delimiter is only meaningful at the start of a line.
    if (atLineStart) {
      let lineEnd = src.indexOf("\n", i);
      if (lineEnd === -1) lineEnd = src.length;
      const fm = /^[ \t]*(`{3,}|~{3,})/.exec(src.slice(i, lineEnd));
      if (fm) {
        const marker = fm[1];
        if (!inFence) {
          inFence = true;
          fenceChar = marker[0];
          fenceLen = marker.length;
        } else if (marker[0] === fenceChar && marker.length >= fenceLen) {
          inFence = false;
        }
        i += fm[0].length;
        atLineStart = false;
        continue;
      }
      if (ch !== " " && ch !== "\t") atLineStart = false;
    }

    if (inFence) {
      i++;
      continue;
    }

    if (ch === "`") {
      let run = 0;
      while (i + run < src.length && src[i + run] === "`") run++;
      let lineEnd = src.indexOf("\n", i + run);
      if (lineEnd === -1) lineEnd = src.length;
      const closeIdx = src.indexOf("`".repeat(run), i + run);
      // Only a span that closes on the same line counts as inline code.
      i = closeIdx !== -1 && closeIdx < lineEnd ? closeIdx + run : i + run;
      continue;
    }

    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }

  return -1;
}

export function stripComments(src: string): string {
  const lines = src.split("\n");

  // Offset of the first character of each line, for mapping an index to a line.
  const lineStarts: number[] = [];
  {
    let off = 0;
    for (const line of lines) {
      lineStarts.push(off);
      off += line.length + 1;
    }
  }
  const lineOf = (offset: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  // Pre-scan: find the line ranges inside prompt { } blocks so their markdown
  // (notably `# headings`) survives comment stripping.
  const insidePrompt = new Set<number>();
  const promptRe = /(?:^|\n)[ \t]*prompt[ \t]*\{/g;
  let pm: RegExpExecArray | null;
  while ((pm = promptRe.exec(src)) !== null) {
    const openIdx = src.indexOf("{", pm.index);
    if (openIdx === -1) continue;
    const end = findMatchingBrace(src, openIdx + 1);
    if (end === -1) continue;
    const firstLine = lineOf(openIdx);
    const lastLine = lineOf(end - 1);
    for (let l = firstLine + 1; l <= lastLine; l++) insidePrompt.add(l);
    promptRe.lastIndex = end;
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
  const m = re.exec(src);
  if (!m) return null;

  const id = m[1] ?? null;
  const startIdx = m.index! + m[0].length;
  const end = findMatchingBrace(src, startIdx);
  if (end === -1) return null;
  return { id, body: src.slice(startIdx, end - 1) };
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
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const id = m[1] ?? null;
    const startIdx = m.index! + m[0].length;
    const end = findMatchingBrace(src, startIdx);
    if (end !== -1) {
      results.push({ id, body: src.slice(startIdx, end - 1) });
      // Deliberately do NOT advance lastIndex past the block: callers rely on
      // rescanning inside it. `extractAllBlocks(src, "skill")` first matches the
      // enclosing `skills {` (the regex reads its "s " as part of the header),
      // then finds each nested `skill <id> {` on the continued scan.
    }
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
  const m = raw.match(/^\[([^\]]*)\]$/);
  if (!m) return [raw.trim()];
  return m[1]
    .split(",")
    .map((s) => s.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

/**
 * Parse a multiline bracketed list that may span multiple lines.
 *
 * Searches for `key: [ ... ]` in the body (potentially spanning newlines)
 * and returns the items as a string array. Uses a word boundary before the
 * key to avoid partial matches (e.g. searching for "tools" will not match
 * "disallowed-tools").
 */
export function parseMultilineList(body: string, key: string): string[] {
  const re = new RegExp(
    `(?:^|(?<=\\s))${escapeRegex(key)}\\s*:\\s*\\[([^\\]]*(?:\\n[^\\]]*)*?)\\]`,
    "m"
  );
  const m = re.exec(body);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => s.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

/**
 * Remove surrounding double quotes from a string value.
 *
 * If the string is not quoted, returns it unchanged.
 */
export function unquote(s: string): string {
  return s.replace(/^"(.*)"$/, "$1");
}

/**
 * Parse all simple `key: value` lines from a block body into a record.
 *
 * Skips lines that are not valid KV pairs (blank lines, nested blocks, etc.).
 */
export function parseFields(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  let depth = 0;
  for (const line of body.split("\n")) {
    // Track brace depth so we only parse top-level KV pairs.
    for (const ch of line) {
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
      const kv = parseKV(line);
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
