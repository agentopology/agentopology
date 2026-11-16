/**
 * The permission rules in `.claude/settings.json` that the .at does not
 * declare.
 *
 * 0.11.x merges rules into settings.json as a union and never removes one, so
 * a rule dropped from the .at stays in effect. Scaffold and
 * `guard --target claude-code` both call {@link undeclaredRuleNotice} and
 * print its lines; it changes no file. settings.json is written exactly as
 * 0.11.1, and prune never deletes settings.json.
 *
 * The manifest entry of settings.json keeps the set last named
 * (`undeclaredRulesNamed`). When the set gains a rule, every rule is named on
 * its own line; on every other run while the set is not empty, one summary
 * line. Only an empty set is silent.
 *
 * @module
 */

import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { GeneratedFile } from "../bindings/types.js";
import type { FileAction, ManifestEntry, ScaffoldManifest } from "./types.js";

export const SETTINGS_PATH = ".claude/settings.json";
/** What prune (and --dry-run) says instead of deleting settings.json, which it never does. */
export const SETTINGS_KEPT_DETAIL = "kept: holds settings; delete it by hand if you want";
const LISTS = ["allow", "ask", "deny"] as const;

/** A settings file that is not valid JSON, or whose root is not an object; nothing is written when this is thrown. */
export class InvalidSettingsJsonError extends Error {
  constructor(readonly path: string, readonly parseMessage: string, problem = "is not valid JSON") {
    super(`${path} ${problem} (${parseMessage})`);
    this.name = "InvalidSettingsJsonError";
  }
}

/** The result of {@link undeclaredRuleNotice}. */
export interface RuleNotice {
  /** Lines to print: one per rule when the set gains one, else one summary line; empty only when no rule is undeclared. */
  lines: string[];
  /** The set to store in the manifest (`"<list> <rule>"`), or null to leave the stored set as it is. */
  named: string[] | null;
}

function rulesOf(raw: string): Record<(typeof LISTS)[number], string[]> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const perms = parsed !== null && typeof parsed === "object" ? (parsed as { permissions?: unknown }).permissions : undefined;
  const out = { allow: [] as string[], ask: [] as string[], deny: [] as string[] };
  if (perms === null || typeof perms !== "object" || Array.isArray(perms)) return out;
  for (const list of LISTS) {
    const v = (perms as Record<string, unknown>)[list];
    if (Array.isArray(v)) out[list] = v.filter((r): r is string => typeof r === "string");
  }
  return out;
}

/** The stored set, or empty when it is missing or not an array of strings. */
function storedSet(entry: ManifestEntry | undefined): string[] {
  const v = entry?.undeclaredRulesNamed as unknown;
  return Array.isArray(v) && v.every((r) => typeof r === "string") ? v : [];
}

/**
 * `"<list> <rule>"` as printed: the rule as a JSON string, so a newline or an
 * escape sequence in it can never forge or erase a line of output.
 */
function shown(item: string): string {
  const space = item.indexOf(" ");
  return `${item.slice(0, space)} ${JSON.stringify(item.slice(space + 1))}`;
}

/** One printed line per undeclared rule. */
export function undeclaredRuleLine(rule: string): string {
  return `${SETTINGS_PATH} ${shown(rule)}: still in effect; the .at does not declare it — remove it if you didn't add it by hand`;
}

/**
 * Name each allow, ask and deny rule that settings.json will hold after this
 * run and the .at does not declare in that same list.
 *
 * Only a settings.json this topology generates or recorded in its manifest is
 * read: one the topology never wrote is not its business. Reads the disk;
 * writes nothing.
 *
 * @param basePath - Project root
 * @param generatedFiles - The files this run generates (what the .at declares)
 * @param actions - The planned actions of this run
 * @param manifest - This topology's previous manifest, or null
 */
export function undeclaredRuleNotice(
  basePath: string,
  generatedFiles: GeneratedFile[],
  actions: FileAction[],
  manifest: ScaffoldManifest | null,
): RuleNotice {
  const generated = generatedFiles.find((f) => f.path === SETTINGS_PATH);
  const entry = manifest?.files?.[SETTINGS_PATH];
  if (!generated && !entry) return { lines: [], named: null };

  // What settings.json holds once this run is done (prune never deletes it).
  const action = actions.find((a) => a.path === SETTINGS_PATH);
  let finalRaw: string | null;
  if (action && (action.type === "create" || action.type === "update")) {
    finalRaw = action.content;
  } else {
    const abs = join(basePath, SETTINGS_PATH);
    try {
      // Never read through a link: that file belongs somewhere else.
      finalRaw = existsSync(abs) && !lstatSync(abs).isSymbolicLink() ? readFileSync(abs, "utf-8") : null;
    } catch {
      return { lines: [], named: null };
    }
  }

  const declared = generated ? rulesOf(generated.content) : { allow: [], ask: [], deny: [] };
  const present = finalRaw === null ? { allow: [], ask: [], deny: [] } : rulesOf(finalRaw);
  if (!declared || !present) return { lines: [], named: null };

  const current: string[] = [];
  for (const list of LISTS) {
    for (const rule of present[list]) {
      const item = `${list} ${rule}`;
      if (!declared[list].includes(rule) && !current.includes(item)) current.push(item);
    }
  }
  if (current.length === 0) return { lines: [], named: current };
  const stored = storedSet(entry);
  const gained = current.some((r) => !stored.includes(r));
  return { lines: gained ? current.map(undeclaredRuleLine) : [undeclaredRuleSummary(current)], named: current };
}

/** The one line printed on every run that adds no rule to a set that is not empty. */
export function undeclaredRuleSummary(rules: string[]): string {
  const n = rules.length;
  const list = rules.slice(0, 5).map(shown).join(", ") + (n > 5 ? ` and ${n - 5} more` : "");
  return n === 1
    ? `1 rule in ${SETTINGS_PATH} isn't declared in the .at: ${list}; declare it in the .at to keep it, or remove it`
    : `${n} rules in ${SETTINGS_PATH} aren't declared in the .at: ${list}; declare them in the .at to keep them, or remove them`;
}

/** Store the named set on the settings.json entry of a manifest's files (in place). */
export function recordNamedRules(files: Record<string, ManifestEntry>, named: string[] | null): void {
  if (named === null) return;
  const entry = files[SETTINGS_PATH];
  if (!entry) return;
  const { undeclaredRulesNamed: _old, ...rest } = entry;
  files[SETTINGS_PATH] = named.length > 0 ? { ...rest, undeclaredRulesNamed: named } : rest;
}
