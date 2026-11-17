/**
 * Permission rules at the top level of .claude/settings.json (or
 * settings.local.json), where Claude Code does not read them.
 *
 * agentopology 0.11.4 and earlier wrote an extension's `deny` / `allow` there
 * as a JSON string (`"deny": "[\"Read(./.env)\"]"`), and hand-written files
 * put `allow` / `deny` / `ask` lists there too. Claude Code reads permission
 * rules only under `permissions`, so these refuse nothing.
 *
 * Warn only: one line per key with the rules and where they go. Nothing here
 * writes a file or changes an exit code.
 */

import * as fs from "node:fs";
import { join } from "node:path";

const FILES = [".claude/settings.json", ".claude/settings.local.json"] as const;
const KEYS = new Set(["allow", "deny", "ask"]);

export interface TopLevelRules {
  file: string;
  key: string;
  rules: string[];
}

/** A list, or a string that holds a JSON list: its items as text. Anything else: null. */
function asRules(value: unknown): string[] | null {
  let list: unknown = value;
  if (typeof value === "string") {
    try { list = JSON.parse(value); } catch { return null; }
  }
  if (!Array.isArray(list)) return null;
  return list.map((r) => (typeof r === "string" ? r : JSON.stringify(r)));
}

/** Every top-level allow, deny or ask list in the project's settings files, in file then key order. */
export function topLevelPermissions(root: string): TopLevelRules[] {
  const out: TopLevelRules[] = [];
  for (const file of FILES) {
    let settings: unknown;
    try { settings = JSON.parse(fs.readFileSync(join(root, file), "utf8")); } catch { continue; }
    if (settings === null || typeof settings !== "object" || Array.isArray(settings)) continue;
    for (const [key, value] of Object.entries(settings as Record<string, unknown>)) {
      if (!KEYS.has(key)) continue;
      const rules = asRules(value);
      if (rules) out.push({ file, key, rules });
    }
  }
  return out;
}

/** One line per key: what is wrong and the exact move. */
export function renderTopLevelPermissions(found: TopLevelRules[]): string[] {
  return found.map(({ file, key, rules }) =>
    `! ${file}: "${key}" at the top level is not read by Claude Code; move [${rules.map((r) => JSON.stringify(r)).join(", ")}] into "permissions": { "${key}": [...] }`);
}

/** The lines for a project directory (none when nothing is misplaced). */
export function topLevelPermissionLines(root: string): string[] {
  return renderTopLevelPermissions(topLevelPermissions(root));
}
