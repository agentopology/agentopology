/**
 * A small TOML writer for the Codex binding.
 *
 * Writes only what the binding needs: strings, numbers, booleans, string
 * arrays, inline arrays of scalars and nested tables. Every string is
 * escaped, every key that is not a bare key is quoted, and tables come after
 * scalars so a key can never land inside the wrong table.
 *
 * @module
 */

/** A value this writer can put in a TOML file. */
export type TomlValue = string | number | boolean | TomlValue[] | { [key: string]: TomlValue };

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

/** A TOML key: bare when it can be, quoted otherwise. */
export function tomlKey(key: string): string {
  return BARE_KEY.test(key) ? key : tomlString(key);
}

/** A dotted key path, each part quoted when needed. */
export function tomlPath(parts: string[]): string {
  return parts.map(tomlKey).join(".");
}

/** A basic string on one line: backslash, quote and control characters escaped. */
export function tomlString(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return `"${out}"`;
}

/**
 * A multi-line string for free text such as a prompt.
 *
 * A literal string (`'''`) holds backslashes, quotes and `"""` exactly as
 * written, so the text reads back unchanged. It cannot hold `'''` or a
 * control character other than a tab; for those the text is written as an
 * escaped basic string instead (`"""` with `\\`, `\"` and `\uXXXX`).
 */
export function tomlMultiline(value: string): string {
  const text = value.replace(/\r\n/g, "\n");
  // eslint-disable-next-line no-control-regex
  const plainLiteral = !text.includes("'''") && !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text) && !text.endsWith("'");
  if (plainLiteral) return `'''\n${text}\n'''`;
  const body = text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return `"""\n${body}\n"""`;
}

/** A TOML array of strings on one line. */
export function tomlStringArray(values: string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

function isTable(v: unknown): v is { [key: string]: TomlValue } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** An inline value (scalar or array); a table has no inline form here and gives null. */
export function tomlInline(v: unknown): string | null {
  if (typeof v === "string") return tomlString(v);
  if (typeof v === "boolean") return String(v);
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : null;
  if (Array.isArray(v)) {
    const items = v.map(tomlInline);
    return items.every((i) => i !== null) ? `[${items.join(", ")}]` : null;
  }
  if (isTable(v)) {
    const parts: string[] = [];
    for (const [k, x] of Object.entries(v)) {
      const s = tomlInline(x);
      if (s !== null) parts.push(`${tomlKey(k)} = ${s}`);
    }
    return `{ ${parts.join(", ")} }`;
  }
  return null;
}

/**
 * The lines of one table: its scalar keys first, then each nested table as
 * its own `[a.b]` section. `skip` names keys to leave out.
 */
export function tomlTable(path: string[], table: { [key: string]: unknown }, skip: ReadonlySet<string> = new Set()): string[] {
  const scalars: string[] = [];
  const subs: string[] = [];
  for (const [k, v] of Object.entries(table)) {
    if (skip.has(k) || v === undefined || v === null) continue;
    if (isTable(v)) {
      subs.push(...tomlTable([...path, k], v));
    } else {
      const s = tomlInline(v);
      if (s !== null) scalars.push(`${tomlKey(k)} = ${s}`);
    }
  }
  const out: string[] = [];
  if (path.length > 0 && (scalars.length > 0 || subs.length === 0)) out.push(`[${tomlPath(path)}]`);
  out.push(...scalars);
  if (path.length > 0 || scalars.length > 0) out.push("");
  out.push(...subs);
  return out;
}
