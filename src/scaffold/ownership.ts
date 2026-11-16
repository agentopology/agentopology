/**
 * T6 (S-37, S-48): which permission rules in `.claude/settings.json` a
 * topology owns, and removing the owned ones its .at no longer declares.
 *
 * The rule: scaffold owns a rule only when it added it. A rule already in
 * the file when scaffold would add it (the user's, or another topology's) is
 * never owned, so it is never removed; the undeclared notice still names it.
 * The manifest entry of settings.json records what is owned (`rulesOwned`,
 * `defaultModeOwned`), what the .at declares (`rulesDeclared`,
 * `defaultModeDeclared`) and the .at's path (`sourcePath`). A manifest without
 * ownership (0.11.2, or spoiled) owns nothing, so the first run after an
 * upgrade removes nothing.
 *
 * OWN2: a removal skips a rule another topology's manifest in the project
 * declares (printed "kept"); the rule stays owned, so a later run removes it
 * once nobody declares it. Another topology's settings entry without
 * `rulesDeclared` (written before it) holds every removal until it is
 * re-scaffolded.
 *
 * OWN3: manifests are keyed by the .at basename, so `a/t.at` and `b/t.at`
 * share one. When the entry records another `sourcePath` (or owns rules and
 * records none), the run owns nothing new, removes nothing, and leaves the
 * entry's ownership as it was. Rekeying by path is a separate change.
 *
 * Known gaps, not fixed here: a renamed .at leaves its old manifest behind,
 * and that stale manifest's owned rules count as owned elsewhere, so the new
 * name never names them as undeclared (nothing is deleted; a notice is lost).
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

/** Rules per list, and the defaultMode: what a topology owns, or declares. */
export interface Owned {
  allow: string[];
  ask: string[];
  deny: string[];
  defaultMode?: string;
}

/** One printed change (or non-change) to an owned rule. */
export interface RuleRemoval {
  kind: "removed" | "replaced" | "kept";
  /** `allow`, `ask`, `deny` or `defaultMode`. */
  list: RuleList | "defaultMode";
  rule: string;
  /** replaced: the new defaultMode. */
  replacedBy?: string;
  /** kept: the other topology's .at that declares it. */
  by?: string;
  /** kept: why, when not because another topology declares it (F1). */
  why?: string;
}

/** What other topologies in the project say about the rules (OWN2). */
export interface Others {
  /** `"<list> <rule>"` or `"defaultMode <value>"` -> the .at that declares it. */
  keptBy: ReadonlyMap<string, string>;
  /** The line to print when a manifest without `rulesDeclared` holds every removal; null when none does. */
  heldBy: string | null;
}

export const NO_OTHERS: Others = { keptBy: new Map(), heldBy: null };

/** The ownership result attached to a settings.json action. */
export interface RuleOwnership {
  owned: Owned;
  /** What the .at declares; recorded in the manifest. */
  declared: Owned;
  /** The .at path relative to the project, when known. */
  sourcePath?: string;
  removed: RuleRemoval[];
  /** `"<list> <rule>"` owned rules this run did not remove (kept or held): not undeclared notices. */
  retained: string[];
  /** One-line notes (a held removal, a skipped ownership). */
  notes: string[];
  /** OWN3: leave the entry exactly as it was, but for the shared mark. */
  preserve?: boolean;
  /** OWN3 (F2): this run's .at path, added to the entry's `ownershipSharedWith`. */
  sharedWith?: string;
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : [];

const EMPTY = (): Owned => ({ allow: [], ask: [], deny: [] });

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** A manifest entry, or undefined when it is missing or not an object (F5: owns nothing, no crash). */
export function entryOf(v: unknown): ManifestEntry | undefined {
  return isObject(v) ? (v as unknown as ManifestEntry) : undefined;
}

/** Each list deduplicated (F9: a rule listed twice is one rule). */
function listsOf(r: unknown, mode: unknown): Owned {
  const obj = isObject(r) ? r : {};
  const uniq = (v: unknown) => [...new Set(strings(v))];
  return {
    allow: uniq(obj.allow),
    ask: uniq(obj.ask),
    deny: uniq(obj.deny),
    ...(typeof mode === "string" ? { defaultMode: mode } : {}),
  };
}

/** The ownership a manifest entry records; malformed or missing parts own nothing. */
export function ownedOf(entry: unknown): Owned {
  const e = entryOf(entry);
  return listsOf(e?.rulesOwned, e?.defaultModeOwned);
}

/**
 * What a manifest entry declares, or null when it records nothing (an entry
 * from before `rulesDeclared`) or records it malformed (F6): both hold every
 * other topology's removals.
 */
export function declaredOf(entry: unknown): Owned | null {
  const e = entryOf(entry);
  const r = e?.rulesDeclared as unknown;
  if (!isObject(r)) return null;
  for (const l of RULE_LISTS) {
    if (r[l] !== undefined && !(Array.isArray(r[l]) && (r[l] as unknown[]).every((x) => typeof x === "string"))) return null;
  }
  const mode = e?.defaultModeDeclared as unknown;
  if (mode !== undefined && typeof mode !== "string") return null;
  return listsOf(r, mode);
}

/** Whether a settings.json text is exactly what scaffold would write from its parsed content (F1). */
export function roundTrips(raw: string | null): boolean {
  if (raw === null || raw.trim() === "") return true;
  try {
    return raw === JSON.stringify(JSON.parse(raw), null, 2) + "\n";
  } catch {
    return false;
  }
}

/** Any rule or mode in the set. */
export const ownsAnything = (o: Owned) => o.allow.length + o.ask.length + o.deny.length > 0 || o.defaultMode !== undefined;

const FIELDS = ["rulesOwned", "defaultModeOwned", "rulesDeclared", "defaultModeDeclared", "sourcePath"] as const;

/**
 * OWN3 (F2, P2-3): the entry after a run that skipped ownership: exactly the
 * previous entry, plus this run's path in `ownershipSharedWith`. Nothing else
 * is written to it, not its hash, not undeclaredRulesNamed.
 */
export function sharedEntry(previous: ManifestEntry, rules: RuleOwnership): ManifestEntry {
  const marks = Array.isArray(previous.ownershipSharedWith) ? previous.ownershipSharedWith.filter((x) => typeof x === "string") : [];
  const add = rules.sharedWith ?? "an .at with no recorded path";
  return { ...previous, ownershipSharedWith: marks.includes(add) ? marks : [...marks, add] };
}

/**
 * F7 / N1: the entry written BEFORE settings.json. It owns what was owned
 * before (the rule this run removes included) and claims none it would add;
 * only the entry written after a successful write clears or claims. It
 * declares the union of before and after (so a neighbour keeps more, never less).
 */
export function interimEntry(previous: ManifestEntry | undefined, rules: RuleOwnership): ManifestEntry | undefined {
  if (!previous) return undefined;
  if (rules.preserve) return sharedEntry(previous, rules);
  // N1: keep owning what was owned (the rules this run removes included), so a
  // write that fails leaves them owned and the next run removes them; claim
  // nothing this run adds until the write succeeds.
  const owned: Owned = ownedOf(previous);
  const entry: ManifestEntry = { ...previous };
  const prevDeclared = declaredOf(previous);
  const declared: Owned = prevDeclared
    ? {
      allow: [...new Set([...prevDeclared.allow, ...rules.declared.allow])],
      ask: [...new Set([...prevDeclared.ask, ...rules.declared.ask])],
      deny: [...new Set([...prevDeclared.deny, ...rules.declared.deny])],
      ...(prevDeclared.defaultMode !== undefined ? { defaultMode: prevDeclared.defaultMode } : rules.declared.defaultMode !== undefined ? { defaultMode: rules.declared.defaultMode } : {}),
    }
    : rules.declared;
  recordOwnership(entry, { ...rules, owned, declared }, previous);
  // An entry that recorded no declared rules keeps holding the neighbours' removals until the real write.
  if (!prevDeclared) {
    delete entry.rulesDeclared;
    delete entry.defaultModeDeclared;
  }
  return entry;
}

/** Set the ownership fields of a manifest entry from a run's result, in place. */
export function recordOwnership(entry: ManifestEntry, rules: RuleOwnership, previous: ManifestEntry | undefined): void {
  if (rules.preserve) {
    if (previous) Object.assign(entry, sharedEntry(previous, rules));
    return;
  }
  for (const f of FIELDS) delete entry[f];
  if (Array.isArray(previous?.ownershipSharedWith)) entry.ownershipSharedWith = previous!.ownershipSharedWith;
  const lists = (o: Owned) => {
    const out: Partial<Record<RuleList, string[]>> = {};
    for (const l of RULE_LISTS) if (o[l].length > 0) out[l] = o[l];
    return out;
  };
  const owned = lists(rules.owned);
  if (Object.keys(owned).length > 0) entry.rulesOwned = owned;
  if (rules.owned.defaultMode !== undefined) entry.defaultModeOwned = rules.owned.defaultMode;
  // Always written (even empty): its presence says this entry records what it declares.
  entry.rulesDeclared = lists(rules.declared);
  if (rules.declared.defaultMode !== undefined) entry.defaultModeDeclared = rules.declared.defaultMode;
  const path = rules.sourcePath ?? previous?.sourcePath;
  if (path !== undefined) entry.sourcePath = path;
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

/** What a generated settings.json declares (empty when there is none). */
export function declaredIn(generatedRaw: string | null): Owned {
  const g = parseObject(generatedRaw);
  if (!g) return EMPTY();
  const p = permsOf(g);
  return listsOf({ allow: p.allow, ask: p.ask, deny: p.deny }, p.defaultMode);
}

/**
 * Apply ownership to the merged settings.json.
 *
 * @param existingRaw - settings.json on disk before this run, or null when absent
 * @param mergedRaw - what the 0.11.2 merge would write (the union), or existingRaw when settings.json is not generated
 * @param generatedRaw - what the .at declares (the generated settings.json), or null when it generates none
 * @param previous - what this topology owned before this run
 * @param others - what other topologies in the project declare (OWN2)
 * @returns the content to write (mergedRaw byte for byte when nothing is removed), what is owned now, and what was removed or kept
 */
export function applyOwnership(
  existingRaw: string | null,
  mergedRaw: string,
  generatedRaw: string | null,
  previous: Owned,
  others: Others = NO_OTHERS,
): RuleOwnership & { content: string } {
  const existing = parseObject(existingRaw);
  const merged = parseObject(mergedRaw);
  const generated = parseObject(generatedRaw);
  const declared = declaredIn(generatedRaw);
  const nothing = { removed: [], retained: [], notes: [] };
  // Anything unreadable: own nothing new, remove nothing (the plan reports the file).
  if (!existing || !merged || !generated) return { content: mergedRaw, owned: EMPTY(), declared, ...nothing };

  const exP = permsOf(existing);
  const out = JSON.parse(JSON.stringify(merged)) as Record<string, unknown>;
  const outP = permsOf(out);
  const removed: RuleRemoval[] = [];
  const retained: string[] = [];
  const owned = EMPTY();
  let changed = false;
  // N4: what a hold keeps, named in its line.
  const heldItems: string[] = [];
  // F1 (ruling a): remove only from a file that round-trips byte for byte;
  // otherwise writing it would also rewrite values the user wrote.
  const REWRITE = "removing it would rewrite the file's formatting or other values";
  const clean = roundTrips(existingRaw);

  for (const list of RULE_LISTS) {
    const before = strings(exP[list]);
    const prev = previous[list];
    let now = strings(outP[list]);
    // An owned rule the .at no longer declares: removed, unless another
    // topology declares it (kept, still ours) or a manifest holds removals.
    const drop: string[] = [];
    for (const r of prev.filter((x) => !declared[list].includes(x) && now.includes(x))) {
      const item = `${list} ${r}`;
      const by = others.keptBy.get(item);
      if (others.heldBy !== null) heldItems.push(`${list} ${JSON.stringify(r)}`);
      else if (by !== undefined) removed.push({ kind: "kept", list, rule: r, by });
      else if (!clean) removed.push({ kind: "kept", list, rule: r, why: REWRITE });
      else {
        drop.push(r);
        continue;
      }
      retained.push(item);
      owned[list].push(r);
    }
    if (drop.length > 0) {
      now = now.filter((r) => !drop.includes(r));
      for (const r of drop) removed.push({ kind: "removed", list, rule: r });
      if (now.length > 0) outP[list] = now;
      else delete outP[list];
      changed = true;
    }
    // Owned now, besides the retained ones: what we owned and still declare
    // and is still there, plus what this run added (not in the file before).
    for (const r of declared[list]) {
      if (!now.includes(r) || owned[list].includes(r)) continue;
      if (prev.includes(r) || !before.includes(r)) owned[list].push(r);
    }
  }

  // defaultMode: ours only while the file still holds the value we wrote.
  const exMode = typeof exP.defaultMode === "string" ? exP.defaultMode : undefined;
  const decMode = declared.defaultMode;
  const prevMode = previous.defaultMode;
  if (prevMode !== undefined && exMode === prevMode) {
    if (decMode === prevMode) {
      owned.defaultMode = prevMode;
    } else {
      const by = others.keptBy.get(`defaultMode ${prevMode}`);
      if (others.heldBy !== null || by !== undefined || !clean) {
        if (others.heldBy !== null) heldItems.push(`defaultMode ${JSON.stringify(prevMode)}`);
        else if (by !== undefined) removed.push({ kind: "kept", list: "defaultMode", rule: prevMode, by });
        else removed.push({ kind: "kept", list: "defaultMode", rule: prevMode, why: REWRITE });
        owned.defaultMode = prevMode;
      } else if (decMode === undefined) {
        delete outP.defaultMode;
        removed.push({ kind: "removed", list: "defaultMode", rule: prevMode });
        changed = true;
      } else {
        outP.defaultMode = decMode;
        removed.push({ kind: "replaced", list: "defaultMode", rule: prevMode, replacedBy: decMode });
        owned.defaultMode = decMode;
        changed = true;
      }
    }
  } else if (exMode === undefined && decMode !== undefined && outP.defaultMode === decMode) {
    owned.defaultMode = decMode; // added by this run
  }

  const notes = heldItems.length > 0 && others.heldBy !== null ? [`${others.heldBy}. Held: ${heldItems.join(", ")}`] : [];
  // P2-2: the user's own defaultMode differs from the .at's: kept, and said once per run.
  // N1: not when the value was scaffold's own (it is replaced, and that is said).
  if (exMode !== undefined && decMode !== undefined && exMode !== decMode && prevMode !== exMode && owned.defaultMode !== exMode) {
    notes.push(`.claude/settings.json defaultMode ${JSON.stringify(exMode)}: kept, yours; the .at says ${JSON.stringify(decMode)}`);
  }
  if (!changed) return { content: mergedRaw, owned, declared, removed, retained, notes };
  if (Object.keys(outP).length > 0) out.permissions = outP;
  else delete out.permissions;
  return { content: JSON.stringify(out, null, 2) + "\n", owned, declared, removed, retained, notes };
}

/** The printed line for one removal, replacement or kept rule (the rule as a JSON string, as in 0.11.2). */
export function removalLine(r: RuleRemoval): string {
  const head = `.claude/settings.json ${r.list} ${JSON.stringify(r.rule)}`;
  if (r.kind === "kept") return `${head}: kept; ${r.why ?? `${r.by} declares it`}`;
  if (r.kind === "replaced") return `${head}: replaced by ${JSON.stringify(r.replacedBy)}; the .at changed it`;
  return `${head}: removed; the .at no longer declares it`;
}

/** The note when a same-basename .at shares this manifest (OWN3). */
export function skippedLine(otherPath: string | undefined): string {
  return `.claude/settings.json: rule ownership skipped; the manifest also belongs to ${otherPath ?? "an .at scaffolded before paths were recorded"}`;
}
