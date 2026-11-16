/**
 * T6 (S-37, S-48): which permission rules in `.claude/settings.json` a
 * topology owns, and removing the owned ones its .at no longer declares.
 *
 * The rule: scaffold owns a rule only when it added it. A rule already in
 * the file when scaffold would add it (the user's, or another topology's) is
 * never owned, so it is never removed; the undeclared notice still names it.
 * The manifest entry of settings.json records what is owned
 * (`rulesOwned`, `defaultModeOwned`). A manifest without them (0.11.2, or
 * spoiled) owns nothing, so the first run after an upgrade removes nothing.
 *
 * Known loss (case c): an owned rule the user also wrote by hand with the same
 * text cannot be told apart from ours. When the .at drops it, it is removed,
 * and the removal is printed.
 *
 * Only the allow, ask and deny lists and the defaultMode scalar are read here;
 * hooks and every other key are left as the merge made them.
 *
 * @module
 */

import type { ManifestEntry } from "./types.js";

export const RULE_LISTS = ["allow", "ask", "deny"] as const;
export type RuleList = (typeof RULE_LISTS)[number];

/** What a topology owns in settings.json. */
export interface Owned {
  allow: string[];
  ask: string[];
  deny: string[];
  defaultMode?: string;
}

/** One change the ownership pass made, for the printed line. */
export interface RuleRemoval {
  /** `allow`, `ask`, `deny` or `defaultMode`. */
  list: RuleList | "defaultMode";
  rule: string;
  /** For defaultMode: the value it was replaced with. Absent when removed. */
  replacedBy?: string;
}

/** The ownership result attached to a settings.json action. */
export interface RuleOwnership {
  owned: Owned;
  removed: RuleRemoval[];
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : [];

/** The ownership a manifest entry records; malformed or missing parts own nothing. */
export function ownedOf(entry: ManifestEntry | undefined | null): Owned {
  const r = entry?.rulesOwned as unknown;
  const obj = r !== null && typeof r === "object" && !Array.isArray(r) ? (r as Record<string, unknown>) : {};
  const mode = entry?.defaultModeOwned as unknown;
  return {
    allow: strings(obj.allow),
    ask: strings(obj.ask),
    deny: strings(obj.deny),
    ...(typeof mode === "string" ? { defaultMode: mode } : {}),
  };
}

/** Set (or clear) the ownership fields on a manifest entry, in place. */
export function recordOwnership(entry: ManifestEntry, owned: Owned): void {
  delete entry.rulesOwned;
  delete entry.defaultModeOwned;
  const lists: Partial<Record<RuleList, string[]>> = {};
  for (const l of RULE_LISTS) if (owned[l].length > 0) lists[l] = owned[l];
  if (Object.keys(lists).length > 0) entry.rulesOwned = lists;
  if (owned.defaultMode !== undefined) entry.defaultModeOwned = owned.defaultMode;
}

function parseObject(raw: string | null): Record<string, unknown> | null {
  if (raw === null || raw.trim() === "") return {};
  try {
    const v = JSON.parse(raw);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function permsOf(o: Record<string, unknown>): Record<string, unknown> {
  const p = o.permissions;
  return p !== null && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
}

/**
 * Apply ownership to the merged settings.json.
 *
 * @param existingRaw - settings.json on disk before this run, or null when absent
 * @param mergedRaw - what the 0.11.2 merge would write (the union), or existingRaw when settings.json is not generated
 * @param generatedRaw - what the .at declares (the generated settings.json), or null when it generates none
 * @param previous - what this topology owned before this run
 * @param keep - `"<list> <rule>"` items never removed, whoever owns them (another topology declares them)
 * @returns the content to write (mergedRaw byte for byte when nothing is removed), what is owned now, and what was removed
 */
export function applyOwnership(
  existingRaw: string | null,
  mergedRaw: string,
  generatedRaw: string | null,
  previous: Owned,
  keep: ReadonlySet<string> = new Set(),
): RuleOwnership & { content: string } {
  const existing = parseObject(existingRaw);
  const merged = parseObject(mergedRaw);
  const generated = parseObject(generatedRaw);
  // Anything unreadable: own nothing new, remove nothing (the plan reports the file).
  if (!existing || !merged || !generated) {
    return { content: mergedRaw, owned: { allow: [], ask: [], deny: [] }, removed: [] };
  }
  const exP = permsOf(existing);
  const genP = permsOf(generated);
  const out = JSON.parse(JSON.stringify(merged)) as Record<string, unknown>;
  const outP = permsOf(out);
  const removed: RuleRemoval[] = [];
  const owned: Owned = { allow: [], ask: [], deny: [] };

  for (const list of RULE_LISTS) {
    const before = strings(exP[list]);
    const declared = strings(genP[list]);
    const prev = previous[list];
    let now = strings(outP[list]);
    // An owned rule the .at no longer declares: removed.
    const drop = prev.filter((r) => !declared.includes(r) && now.includes(r) && !keep.has(`${list} ${r}`));
    if (drop.length > 0) {
      now = now.filter((r) => !drop.includes(r));
      for (const r of drop) removed.push({ list, rule: r });
      if (now.length > 0) outP[list] = now;
      else delete outP[list];
    }
    // Owned now: what we owned and still declare and is still there, plus
    // what this run added (declared, and not in the file before it).
    for (const r of declared) {
      if (!now.includes(r)) continue;
      if (prev.includes(r) || !before.includes(r)) if (!owned[list].includes(r)) owned[list].push(r);
    }
  }

  // defaultMode: ours only while the file still holds the value we wrote.
  const exMode = typeof exP.defaultMode === "string" ? exP.defaultMode : undefined;
  const decMode = typeof genP.defaultMode === "string" ? genP.defaultMode : undefined;
  const prevMode = previous.defaultMode;
  if (prevMode !== undefined && exMode === prevMode) {
    if (decMode === undefined) {
      if (!keep.has(`defaultMode ${prevMode}`)) {
        delete outP.defaultMode;
        removed.push({ list: "defaultMode", rule: prevMode });
      }
    } else if (decMode !== prevMode) {
      outP.defaultMode = decMode;
      removed.push({ list: "defaultMode", rule: prevMode, replacedBy: decMode });
      owned.defaultMode = decMode;
    } else {
      owned.defaultMode = decMode;
    }
  } else if (exMode === undefined && decMode !== undefined && outP.defaultMode === decMode) {
    owned.defaultMode = decMode; // added by this run
  }

  if (removed.length === 0) return { content: mergedRaw, owned, removed };
  if (Object.keys(outP).length > 0) out.permissions = outP;
  else delete out.permissions;
  return { content: JSON.stringify(out, null, 2) + "\n", owned, removed };
}

/** The printed line for one removal (the rule as a JSON string, as in 0.11.2). */
export function removalLine(r: RuleRemoval): string {
  if (r.list === "defaultMode") {
    return r.replacedBy !== undefined
      ? `.claude/settings.json defaultMode ${JSON.stringify(r.rule)}: replaced by ${JSON.stringify(r.replacedBy)}; the .at changed it`
      : `.claude/settings.json defaultMode ${JSON.stringify(r.rule)}: removed; the .at no longer declares it`;
  }
  return `.claude/settings.json ${r.list} ${JSON.stringify(r.rule)}: removed; the .at no longer declares it`;
}
