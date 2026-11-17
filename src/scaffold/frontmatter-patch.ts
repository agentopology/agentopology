/**
 * Byte-preserving edits to a Markdown file's YAML frontmatter.
 *
 * Sets or removes top-level keys and leaves every other byte as the author
 * wrote it: other keys, comments, key order, quoting, line endings, a
 * byte-order mark, and the whole body after the closing fence (copied by
 * offset, never parsed). The package has no YAML library, and a parse and
 * re-serialize would lose all of that.
 *
 * What it cannot edit safely it refuses with a typed reason and writes
 * nothing: a file with text but no frontmatter, a block with no closing
 * fence, anchors and aliases, more than one document, a duplicate key, a
 * value whose extent it cannot bound, or a line that is not a key. After an
 * edit it re-reads its own output and refuses if the body or any untouched
 * key changed (a bug guard, not an expected path).
 *
 * @module
 */

/** A frontmatter value as compared: a scalar, a list of scalars, or a block kept as text. */
export type FieldValue = string | string[] | { block: string };

/** Why an edit was refused. Nothing is written on a refusal. */
export type RefusalCode =
  | "no-frontmatter"
  | "unterminated"
  | "multi-document"
  | "anchor-or-alias"
  | "duplicate-key"
  | "unbounded-value"
  | "unparseable-line"
  | "bad-edit"
  | "body-changed";

export interface PatchRefusal {
  ok: false;
  code: RefusalCode;
  message: string;
  key?: string;
}

export interface FrontmatterField {
  key: string;
  value: FieldValue;
  /** The key's lines as written in the file, without line endings. */
  lines: string[];
}

export interface ReadResult {
  ok: true;
  /** False when the file has no frontmatter block at all. */
  present: boolean;
  fields: Map<string, FrontmatterField>;
}

/** Set a key to these lines (the first one is `key: ...`), or remove it. */
export type FrontmatterEdit = { key: string; lines: string[] } | { key: string; remove: true };

export interface PatchResult {
  ok: true;
  text: string;
  changed: boolean;
}

/**
 * Keys whose value is a set: order and spelling do not matter. Claude Code
 * takes a tool list as a comma string or a YAML list; a skill's allowed-tools
 * also as a space-separated string.
 */
export const SET_KEYS: ReadonlySet<string> = new Set([
  "tools",
  "disallowedTools",
  "disallowed-tools",
  "allowed-tools",
  "skills",
  "paths",
]);

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

interface Line {
  text: string;
  eol: string;
}

function splitLines(s: string): Line[] {
  const out: Line[] = [];
  let i = 0;
  while (i < s.length) {
    const j = s.indexOf("\n", i);
    if (j === -1) {
      out.push({ text: s.slice(i), eol: "" });
      break;
    }
    let text = s.slice(i, j);
    let eol = "\n";
    if (text.endsWith("\r")) {
      text = text.slice(0, -1);
      eol = "\r\n";
    }
    out.push({ text, eol });
    i = j + 1;
  }
  return out;
}

const joinLines = (lines: Line[]) => lines.map((l) => l.text + l.eol).join("");

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

interface Span {
  key: string;
  /** Index of the key line. */
  start: number;
  /** One past the last line of its value. */
  end: number;
  inline: string;
}

interface Scan {
  bom: string;
  lines: Line[];
  present: boolean;
  /** Index of the closing fence (present only). */
  close: number;
  spans: Span[];
}

const FENCE = /^---[ \t]*$/;
const KEY_LINE =
  /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#"'\-?:[\]{},&*!|>%@`][^:]*?|-[^\s:][^:]*?)[ \t]*:(?:[ \t]+(.*)|[ \t]*)$/;

const refuse = (code: RefusalCode, message: string, key?: string): PatchRefusal => ({
  ok: false,
  code,
  message,
  ...(key ? { key } : {}),
});

function unquoteKey(raw: string): string {
  if (raw.startsWith('"')) {
    try {
      return JSON.parse(raw) as string;
    } catch {
      return raw.slice(1, -1);
    }
  }
  if (raw.startsWith("'")) return raw.slice(1, -1).replace(/''/g, "'");
  return raw;
}

function scan(text: string): Scan | PatchRefusal {
  const bom = text.startsWith("﻿") ? "﻿" : "";
  const lines = splitLines(text.slice(bom.length));
  if (lines.length === 0 || !FENCE.test(lines[0].text)) {
    return { bom, lines, present: false, close: -1, spans: [] };
  }
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].text;
    if (FENCE.test(t)) {
      close = i;
      break;
    }
    if (/^\.\.\.[ \t]*$/.test(t) || /^---[ \t]/.test(t) || t.startsWith("%")) {
      return refuse("multi-document", `line ${i + 1} starts another YAML document; only one frontmatter block is edited`);
    }
  }
  if (close === -1) return refuse("unterminated", "the frontmatter has no closing --- line");

  const spans: Span[] = [];
  const seen = new Set<string>();
  let cur: Span | null = null;
  for (let i = 1; i < close; i++) {
    const t = lines[i].text;
    if (t.trim() === "") continue;
    if (/^[ \t]/.test(t)) {
      if (!cur) return refuse("unparseable-line", `line ${i + 1} is indented but follows no key`);
      cur.end = i + 1;
      continue;
    }
    if (t.startsWith("#")) continue;
    if (/^-([ \t]|$)/.test(t)) {
      if (!cur || cur.inline !== "") {
        return refuse("unparseable-line", `line ${i + 1} is a list item that belongs to no key`);
      }
      cur.end = i + 1;
      continue;
    }
    const m = KEY_LINE.exec(t);
    if (!m) return refuse("unparseable-line", `line ${i + 1} is not a "key: value" line`);
    const key = unquoteKey(m[1]);
    if (key === "<<") return refuse("anchor-or-alias", `line ${i + 1} is a YAML merge key`, key);
    if (seen.has(key)) return refuse("duplicate-key", `"${key}" appears twice in the frontmatter`, key);
    seen.add(key);
    cur = { key, start: i, end: i + 1, inline: stripComment(m[2] ?? "") };
    spans.push(cur);
  }

  for (const span of spans) {
    const bad = checkSpan(lines, span);
    if (bad) return bad;
  }
  return { bom, lines, present: true, close, spans };
}

/** A plain value's trailing ` # comment` is not part of it. */
function stripComment(value: string): string {
  const v = value.trim();
  if (v.startsWith('"') || v.startsWith("'") || v.startsWith("[") || v.startsWith("{")) return v;
  const hash = v.search(/[ \t]#/);
  return (hash === -1 ? v : v.slice(0, hash)).trim();
}

const isBlockScalar = (inline: string) => /^[|>][-+0-9]*[ \t]*(#.*)?$/.test(inline);

function startsAnchorOrAlias(v: string): boolean {
  return /^[&*][^\s,\]}]/.test(v.trim());
}

/** Anchors, aliases and values whose end cannot be found. */
function checkSpan(lines: Line[], span: Span): PatchRefusal | null {
  const { key, inline } = span;
  if (startsAnchorOrAlias(inline)) return refuse("anchor-or-alias", `"${key}" uses a YAML anchor or alias`, key);
  if (/^![^\s]*/.test(inline)) return refuse("unparseable-line", `"${key}" carries a YAML tag`, key);
  const rest = lines.slice(span.start + 1, span.end).map((l) => l.text);
  if (!isBlockScalar(inline)) {
    for (const r of rest) {
      const t = r.trim();
      if (t.startsWith("#")) continue;
      const item = t.startsWith("- ") ? t.slice(2) : t === "-" ? "" : null;
      if (item !== null && startsAnchorOrAlias(item)) {
        return refuse("anchor-or-alias", `"${key}" uses a YAML anchor or alias`, key);
      }
      if (/(^|[ \t])<<[ \t]*:/.test(t) || /:[ \t]+[&*][^\s,\]}]/.test(t)) {
        return refuse("anchor-or-alias", `"${key}" uses a YAML anchor or alias`, key);
      }
    }
  }
  const full = [inline, ...rest.map((r) => r.trim())].join(" ");
  if (inline.startsWith('"') && closingQuote(full, '"') === -1) {
    return refuse("unbounded-value", `the quoted value of "${key}" does not close`, key);
  }
  if (inline.startsWith("'") && closingQuote(full, "'") === -1) {
    return refuse("unbounded-value", `the quoted value of "${key}" does not close`, key);
  }
  if ((inline.startsWith("[") || inline.startsWith("{")) && !balanced(full)) {
    return refuse("unbounded-value", `the flow value of "${key}" does not close`, key);
  }
  return null;
}

/** Index of the quote that closes a string opening at 0, or -1. */
function closingQuote(s: string, q: '"' | "'"): number {
  for (let i = 1; i < s.length; i++) {
    if (q === '"' && s[i] === "\\") {
      i++;
      continue;
    }
    if (s[i] === q) {
      if (q === "'" && s[i + 1] === "'") {
        i++;
        continue;
      }
      return i;
    }
  }
  return -1;
}

function balanced(s: string): boolean {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' || ch === "'") {
      const end = closingQuote(s.slice(i), ch);
      if (end === -1) return false;
      i += end;
      continue;
    }
    if (ch === "[" || ch === "{") depth++;
    if (ch === "]" || ch === "}") depth--;
  }
  return depth === 0;
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

function unquoteScalar(v: string): string {
  const t = v.trim();
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    try {
      return JSON.parse(t) as string;
    } catch {
      return t.slice(1, -1);
    }
  }
  if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) return t.slice(1, -1).replace(/''/g, "'");
  return t;
}

/** Split at top-level commas (outside brackets and quotes). */
function splitFlow(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' || ch === "'") {
      const end = closingQuote(s.slice(i), ch);
      if (end !== -1) i += end;
      continue;
    }
    if (ch === "[" || ch === "{" || ch === "(") depth++;
    else if (ch === "]" || ch === "}" || ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out.map((x) => x.trim()).filter((x) => x !== "");
}

function dedent(rows: string[]): string {
  const live = rows.filter((r) => r.trim() !== "");
  const indent = Math.min(...live.map((r) => /^[ \t]*/.exec(r)![0].length));
  return rows
    .map((r) => (r.trim() === "" ? "" : r.slice(indent).trimEnd()))
    .join("\n")
    .trim();
}

function valueOf(lines: Line[], span: Span): FieldValue {
  const { inline } = span;
  const rest = lines.slice(span.start + 1, span.end).map((l) => l.text);
  if (isBlockScalar(inline)) return { block: `${inline.replace(/[ \t]*#.*$/, "")}\n${dedent(rest)}` };
  if (inline === "") {
    const items = rest.filter((r) => r.trim() !== "" && !r.trim().startsWith("#"));
    if (items.length === 0) return "";
    const indent = /^[ \t]*/.exec(items[0])![0].length;
    const isMapping = (item: string) => !/^["'[{]/.test(item) && /^[^:]*:([ \t]|$)/.test(item);
    const scalarList = items.every(
      (r) =>
        /^[ \t]*-([ \t]|$)/.test(r) &&
        /^[ \t]*/.exec(r)![0].length === indent &&
        !isMapping(r.trim().slice(1).trim()),
    );
    if (scalarList) return items.map((r) => unquoteScalar(stripComment(r.trim().slice(1))));
    return { block: dedent(rest) };
  }
  if (inline.startsWith("[")) {
    const full = [inline, ...rest.map((r) => r.trim())].join(" ").trim();
    return splitFlow(full.slice(1, full.lastIndexOf("]"))).map(unquoteScalar);
  }
  if (inline.startsWith("{")) return { block: [inline, ...rest.map((r) => r.trim())].join(" ").trim() };
  const parts = [inline, ...rest.map((r) => r.trim()).filter((r) => r !== "" && !r.startsWith("#"))];
  return unquoteScalar(parts.join(" "));
}

function fieldsOf(s: Scan): Map<string, FrontmatterField> {
  const fields = new Map<string, FrontmatterField>();
  for (const span of s.spans) {
    fields.set(span.key, {
      key: span.key,
      value: valueOf(s.lines, span),
      lines: s.lines.slice(span.start, span.end).map((l) => l.text),
    });
  }
  return fields;
}

/** Read the top-level keys of a file's frontmatter. */
export function readFrontmatter(text: string): ReadResult | PatchRefusal {
  const s = scan(text);
  if ("ok" in s) return s;
  return { ok: true, present: s.present, fields: fieldsOf(s) };
}

// ---------------------------------------------------------------------------
// Compare and show
// ---------------------------------------------------------------------------

/** Split a tool string at commas and spaces outside parentheses. */
function splitTools(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (depth === 0 && (ch === "," || /\s/.test(ch))) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function asSet(v: FieldValue): string[] | null {
  if (typeof v === "string") return [...new Set(splitTools(v))].sort();
  if (Array.isArray(v)) return [...new Set(v.map((x) => x.trim()).filter(Boolean))].sort();
  return null;
}

/**
 * Whether two values mean the same. For a set-typed key (SET_KEYS) order and
 * spelling do not matter: `Read, Grep` equals `[Grep, Read]`.
 */
export function sameFieldValue(key: string, a: FieldValue | undefined, b: FieldValue | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (SET_KEYS.has(key)) {
    const x = asSet(a);
    const y = asSet(b);
    if (x && y) return x.length === y.length && x.every((v, i) => v === y[i]);
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * A value the way a person reads it in one line. With a set-typed key, a
 * comma string prints as the list it is: `[Read, Grep]`.
 */
export function showFieldValue(value: FieldValue | undefined, key?: string): string {
  if (value === undefined) return "(absent)";
  if (typeof value === "string" && key && SET_KEYS.has(key)) return `[${splitTools(value).join(", ")}]`;
  if (typeof value === "string") return value === "" ? '""' : value;
  if (Array.isArray(value)) return `[${value.join(", ")}]`;
  const first = value.block.split("\n")[0];
  return value.block.includes("\n") ? `${first} …` : first;
}

// ---------------------------------------------------------------------------
// Patch
// ---------------------------------------------------------------------------

function checkEdit(edit: FrontmatterEdit): PatchRefusal | null {
  if ("remove" in edit) return null;
  const [first, ...rest] = edit.lines;
  const m = first === undefined ? null : KEY_LINE.exec(first);
  if (!m || unquoteKey(m[1]) !== edit.key) {
    return refuse("bad-edit", `the new lines for "${edit.key}" do not start with that key`, edit.key);
  }
  if (edit.lines.some((l) => /[\r\n]/.test(l)) || rest.some((l) => !/^([ \t]|-([ \t]|$))/.test(l))) {
    return refuse("bad-edit", `the new lines for "${edit.key}" are not one key's value`, edit.key);
  }
  return null;
}

/**
 * Set or remove top-level frontmatter keys. Untouched lines and the body stay
 * byte-identical. Refuses (and writes nothing) what it cannot edit safely.
 */
export function patchFrontmatter(text: string, edits: FrontmatterEdit[]): PatchResult | PatchRefusal {
  for (const e of edits) {
    const bad = checkEdit(e);
    if (bad) return bad;
  }
  const s = scan(text);
  if ("ok" in s) return s;
  const sets = edits.filter((e): e is { key: string; lines: string[] } => !("remove" in e));

  if (!s.present) {
    if (sets.length === 0) return { ok: true, text, changed: false };
    if (text.slice(s.bom.length).trim() !== "") {
      return refuse("no-frontmatter", "the file has text but no frontmatter block to add keys to");
    }
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const block = ["---", ...sets.flatMap((e) => e.lines), "---"].join(eol) + eol;
    return { ok: true, text: s.bom + block, changed: true };
  }

  const eol = s.lines[0].eol || "\n";
  const byKey = new Map(s.spans.map((sp) => [sp.key, sp]));
  const replaceAt = new Map<number, { end: number; lines: string[] }>();
  const append: string[] = [];
  for (const e of edits) {
    const span = byKey.get(e.key);
    const lines = "remove" in e ? [] : e.lines;
    if (span) replaceAt.set(span.start, { end: span.end, lines });
    else append.push(...lines);
  }

  const out: Line[] = [];
  for (let i = 0; i < s.lines.length; ) {
    if (i === s.close) for (const l of append) out.push({ text: l, eol });
    const r = replaceAt.get(i);
    if (r) {
      for (const l of r.lines) out.push({ text: l, eol });
      i = r.end;
      continue;
    }
    out.push(s.lines[i]);
    i++;
  }
  const next = s.bom + joinLines(out);
  if (next === text) return { ok: true, text, changed: false };

  // Bug guard: the body and every key not edited must be exactly as before.
  const after = scan(next);
  if ("ok" in after || !after.present) return refuse("body-changed", "the edit did not re-read cleanly; nothing written");
  const bodyBefore = joinLines(s.lines.slice(s.close));
  const bodyAfter = joinLines(after.lines.slice(after.close));
  if (bodyBefore !== bodyAfter) return refuse("body-changed", "the edit would change the body; nothing written");
  const touched = new Set(edits.map((e) => e.key));
  const linesOf = (sc: Scan, sp: Span) => joinLines(sc.lines.slice(sp.start, sp.end));
  const afterByKey = new Map(after.spans.map((sp) => [sp.key, sp]));
  for (const sp of s.spans) {
    if (touched.has(sp.key)) continue;
    const a = afterByKey.get(sp.key);
    if (!a || linesOf(after, a) !== linesOf(s, sp)) {
      return refuse("body-changed", `the edit would change "${sp.key}", which it was not asked to; nothing written`, sp.key);
    }
  }
  return { ok: true, text: next, changed: true };
}
