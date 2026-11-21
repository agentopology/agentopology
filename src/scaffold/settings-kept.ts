/**
 * settings.json values the .at states that the merge does not apply.
 *
 * The settings merge is union-only: it adds what the file lacks and never
 * replaces a value the file holds (a key, or a whole object such as
 * `sandbox`), so the user's settings survive every run. A value the .at
 * states then stays as the file has it; this module names each one, so the
 * run says so (one line per key, dry run included) and `validate
 * --inventory` lists it as drift, instead of leaving it out silently.
 *
 * @module
 */

import { deepMergeSettingsJson } from "./merge.js";

export interface KeptSetting {
  /** The dotted key, as Claude Code's settings reference writes it. */
  key: string;
  /** The value the .at states. */
  at: unknown;
  /** The file's value at the key; undefined when it has none. */
  file: unknown;
  /** The file's own key above it that the merge kept whole, when the file has no value at the key. */
  parent?: { key: string; isObject: boolean };
  /** One line saying it. */
  line: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The value at a dotted path, and the deepest key on the way the object holds. */
function lookup(root: Record<string, unknown>, path: string[]): { value: unknown; deepest?: { key: string; value: unknown } } {
  let cur: unknown = root;
  let deepest: { key: string; value: unknown } | undefined;
  for (let i = 0; i < path.length; i++) {
    if (!isObject(cur) || !(path[i] in cur)) return { value: undefined, deepest };
    cur = cur[path[i]];
    if (i < path.length - 1) deepest = { key: path.slice(0, i + 1).join("."), value: cur };
  }
  return { value: cur, deepest };
}

/**
 * Each value the generated settings state that the merged file does not hold
 * as stated. `hooks` (merged by owner) and `env` (the .at's value wins) are
 * not compared. `fileName` begins each line (`.claude/settings.json`).
 */
export function keptSettings(existingRaw: string, generatedRaw: string, fileName: string, ownedPaths: string[] = []): KeptSetting[] {
  if (existingRaw.trim() === "") return [];
  let existing: unknown;
  let generated: unknown;
  let merged: unknown;
  try {
    existing = JSON.parse(existingRaw);
    generated = JSON.parse(generatedRaw);
    merged = JSON.parse(deepMergeSettingsJson(existingRaw, generatedRaw, ownedPaths));
  } catch {
    return [];
  }
  if (!isObject(existing) || !isObject(generated) || !isObject(merged)) return [];
  const out: KeptSetting[] = [];
  const show = (v: unknown) => JSON.stringify(v);

  const walk = (value: unknown, path: string[]): void => {
    if (isObject(value)) {
      for (const [k, v] of Object.entries(value)) walk(v, [...path, k]);
      return;
    }
    const now = lookup(merged as Record<string, unknown>, path).value;
    const held = Array.isArray(value) && Array.isArray(now)
      ? value.every((item) => now.some((x) => same(x, item)))
      : same(now, value);
    if (held) return;
    const key = path.join(".");
    const mine = lookup(existing as Record<string, unknown>, path);
    if (mine.value !== undefined) {
      out.push({ key, at: value, file: mine.value, line: `${fileName} ${key}: file has ${show(mine.value)}, the .at states ${show(value)} — not changed` });
      return;
    }
    const parent = mine.deepest ? { key: mine.deepest.key, isObject: isObject(mine.deepest.value) } : undefined;
    const why = parent ? ` (its "${parent.key}" ${parent.isObject ? "object" : "value"} is kept as it is)` : "";
    out.push({ key, at: value, file: undefined, ...(parent ? { parent } : {}), line: `${fileName} ${key}: file has no value${why}, the .at states ${show(value)} — not changed` });
  };

  for (const [k, v] of Object.entries(generated)) {
    if (k === "hooks" || k === "env") continue;
    walk(v, [k]);
  }
  // `agent` (meta { entry }) decides which agent every session starts as, so
  // a value the file holds while the .at states none (an entry removed, or
  // one the user set) is said too: the session still starts as it.
  if (existing.agent !== undefined && generated.agent === undefined) {
    out.push({ key: "agent", at: null, file: existing.agent, line: `${fileName} agent: file has ${show(existing.agent)}, the .at states none — not changed (every session still starts as it; delete the key to stop that)` });
  }
  return out;
}
