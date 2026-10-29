/**
 * What a config merge changes, key by key, for `scaffold --dry-run`.
 *
 * The dry run used to say only "config merged" for settings.json and
 * .mcp.json, so the one file a user most needs to review before a write was
 * the one it did not show (content session, 2026-10-29).
 *
 * @module
 */

const MAX_VALUE = 120;

function show(value: unknown): string {
  const text = JSON.stringify(value);
  return text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE - 1)}…` : text;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Lines describing how `after` differs from `before`: `+ path: value` for an
 * addition, `~ path: old → new` for a change, `- path` for a removal. Arrays
 * are compared by element (an element present in only one side is added or
 * removed), which is how the merge treats permission and hook lists.
 */
export function jsonChanges(beforeText: string, afterText: string): string[] {
  let before: unknown;
  let after: unknown;
  try {
    before = JSON.parse(beforeText);
    after = JSON.parse(afterText);
  } catch {
    return ["(not JSON: shown whole on write)"];
  }
  const out: string[] = [];
  const walk = (a: unknown, b: unknown, path: string) => {
    if (isObject(a) && isObject(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        const p = path ? `${path}.${key}` : key;
        if (!(key in a)) out.push(`+ ${p}: ${show(b[key])}`);
        else if (!(key in b)) out.push(`- ${p}`);
        else walk(a[key], b[key], p);
      }
      return;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      const keyOf = (v: unknown) => JSON.stringify(v);
      const had = new Set(a.map(keyOf));
      const has = new Set(b.map(keyOf));
      for (const v of b) if (!had.has(keyOf(v))) out.push(`+ ${path}[]: ${show(v)}`);
      for (const v of a) if (!has.has(keyOf(v))) out.push(`- ${path}[]: ${show(v)}`);
      return;
    }
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push(`~ ${path}: ${show(a)} → ${show(b)}`);
  };
  walk(before, after, "");
  return out;
}
