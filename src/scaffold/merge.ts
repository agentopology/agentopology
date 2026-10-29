/**
 * Merge logic for incremental scaffold.
 *
 * Handles preserving user-edited content (HUMAN zone) in agent files
 * while updating machine-generated sections, and hash-based overwrite
 * decisions for script files.
 *
 * @module
 */

import {
  extractSectionUntilKnownHeading,
  CLAUDE_CODE_STRUCTURAL_HEADINGS,
  COPILOT_STRUCTURAL_HEADINGS,
} from "../sync/index.js";
import { hashContent } from "./manifest.js";

/**
 * Return the list of known structural headings for a binding.
 * Falls back to the Claude Code list for unknown bindings.
 */
function getStructuralHeadings(binding: string): string[] {
  switch (binding) {
    case "copilot-cli":
      return COPILOT_STRUCTURAL_HEADINGS;
    case "claude-code":
    default:
      return CLAUDE_CODE_STRUCTURAL_HEADINGS;
  }
}

/**
 * Merge an existing agent file with a freshly generated one.
 *
 * Preserves the HUMAN zone (everything under `## Instructions` until the next
 * structural heading) from the existing file, while taking all machine-generated
 * sections from the generated file.
 *
 * If the existing file has no `## Instructions` section, returns the generated
 * file as-is.
 *
 * @param existing - Current file content on disk
 * @param generated - Freshly generated file content
 * @param binding - Target binding name (e.g. "claude-code")
 * @returns Merged file content
 */
export function mergeAgentFile(
  existing: string,
  generated: string,
  binding: string,
): string {
  const structuralHeadings = getStructuralHeadings(binding);

  // Extract the HUMAN zone from the existing file
  const humanContent = extractSectionUntilKnownHeading(
    existing,
    "## Instructions",
    structuralHeadings,
  );

  // If no Instructions section exists in existing, return generated as-is
  if (humanContent === null) {
    return generated;
  }

  // Find the ## Instructions section in the generated file
  const instructionsPattern = /^## Instructions\s*$/m;
  const instrMatch = instructionsPattern.exec(generated);
  if (!instrMatch) {
    // Generated file has no Instructions section — return it as-is
    return generated;
  }

  // Find where the generated instructions content ends (next structural heading or EOF)
  const afterHeading = instrMatch.index + instrMatch[0].length;
  const rest = generated.slice(afterHeading);

  let endPos = rest.length;
  for (const kh of structuralHeadings) {
    const khPattern = new RegExp(
      `^${kh.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`,
      "m",
    );
    const khMatch = khPattern.exec(rest);
    if (khMatch && khMatch.index < endPos) {
      endPos = khMatch.index;
    }
  }

  // Build merged file: everything before instructions content + human content + everything after
  const beforeContent = generated.slice(0, afterHeading);
  const afterContent = rest.slice(endPos);

  return beforeContent + "\n\n" + humanContent + "\n\n" + afterContent;
}

/**
 * Determine whether a script file should be overwritten.
 *
 * Compares the hash of the existing file content against the hash stored
 * in the manifest. If they match, the user has not edited the file and
 * it is safe to overwrite.
 *
 * @param existingContent - Current file content on disk
 * @param manifestHash - Hash from the scaffold manifest
 * @returns `true` if the file is unmodified and safe to overwrite
 */
export function shouldOverwriteScript(
  existingContent: string,
  manifestHash: string,
): boolean {
  return hashContent(existingContent) === manifestHash;
}

/**
 * Deep-merge two JSON config files.
 *
 * Scaffold-generated keys are added/updated into the existing config,
 * but user-only keys (not present in generated) are preserved.
 *
 * For nested objects (like mcpServers), merges by key — scaffold stubs
 * don't overwrite existing entries that have real config.
 *
 * @param existingRaw - Current file content on disk (JSON string)
 * @param generatedRaw - Freshly generated file content (JSON string)
 * @returns Merged JSON string, or existingRaw if parse fails
 */
export function deepMergeJson(existingRaw: string, generatedRaw: string): string {
  let existing: Record<string, unknown>;
  let generated: Record<string, unknown>;

  try {
    existing = JSON.parse(existingRaw);
    generated = JSON.parse(generatedRaw);
  } catch {
    // If either file isn't valid JSON, return existing unchanged
    return existingRaw;
  }

  const merged = mergeObjects(existing, generated);
  return JSON.stringify(merged, null, 2) + "\n";
}

/**
 * Merge settings.json files with domain-aware logic for Claude Code settings.
 *
 * The user's file is the base; scaffold only adds or replaces what it owns.
 *
 * Rules:
 *   - permissions: every existing key is kept (ask, defaultMode,
 *     additionalDirectories, ...); allow, deny and ask arrays are
 *     union-merged; a generated scalar is added only where none exists
 *   - env: shallow-merge (generated wins on key conflict)
 *   - hooks: a hook group is the topology's when one of its commands names a
 *     path in `ownedPaths`; those are replaced by the generated hooks, and
 *     every other group — the user's — is kept. Without `ownedPaths`, nothing
 *     existing is treated as owned, so nothing is removed
 *   - All other top-level keys: existing wins (user-only keys preserved)
 *
 * This used to rebuild permissions from allow/deny alone and replace hooks
 * wholesale, so a re-scaffold deleted the user's own hooks, ask rules and
 * defaultMode, and two topologies in one repo deleted each other's hooks.
 *
 * @param existingRaw - Current settings.json content on disk (JSON string, or empty string)
 * @param generatedRaw - Freshly generated settings.json content (JSON string)
 * @param ownedPaths - Paths this topology writes or wrote (generated + manifest)
 * @returns Merged JSON string
 * @throws {Error} if existingRaw is non-empty and is invalid JSON
 */
export function deepMergeSettingsJson(
  existingRaw: string,
  generatedRaw: string,
  ownedPaths: string[] = [],
): string {
  // Empty existing means first scaffold — return generated unchanged
  if (existingRaw.trim() === "") {
    return generatedRaw;
  }

  let existing: Record<string, unknown>;
  let generated: Record<string, unknown>;

  try {
    existing = JSON.parse(existingRaw);
  } catch (err) {
    throw new Error(`invalid JSON in existing settings.json: ${(err as Error).message}`);
  }

  try {
    generated = JSON.parse(generatedRaw);
  } catch (err) {
    throw new Error(`invalid JSON in generated settings.json: ${(err as Error).message}`);
  }

  // Start with existing (preserves all user-only top-level keys)
  const merged: Record<string, unknown> = { ...existing };

  // --- permissions: keep every existing key; union the rule arrays ---
  if (isPlainObject(generated.permissions) || isPlainObject(existing.permissions)) {
    const ex = isPlainObject(existing.permissions) ? existing.permissions : {};
    const gen = isPlainObject(generated.permissions) ? generated.permissions : {};
    const mergedPerms: Record<string, unknown> = { ...ex };
    for (const [key, value] of Object.entries(gen)) {
      const current = mergedPerms[key];
      if (Array.isArray(value) || Array.isArray(current)) {
        const union = Array.from(new Set([
          ...(Array.isArray(current) ? current : []),
          ...(Array.isArray(value) ? value : []),
        ]));
        mergedPerms[key] = union;
      } else if (current === undefined) {
        mergedPerms[key] = value;
      }
    }
    for (const key of Object.keys(mergedPerms)) {
      if (Array.isArray(mergedPerms[key]) && (mergedPerms[key] as unknown[]).length === 0) {
        delete mergedPerms[key];
      }
    }
    if (Object.keys(mergedPerms).length > 0) {
      merged.permissions = mergedPerms;
    } else {
      delete merged.permissions;
    }
  }

  // --- env: shallow-merge, generated wins on conflict ---
  if (generated.env !== undefined) {
    const existingEnv = (existing.env ?? {}) as Record<string, string>;
    const generatedEnv = generated.env as Record<string, string>;
    merged.env = { ...existingEnv, ...generatedEnv };
  }

  // --- hooks: replace the topology's own groups, keep the user's ---
  const mergedHooks = mergeHooks(existing.hooks, generated.hooks, ownedPaths);
  if (mergedHooks) {
    merged.hooks = mergedHooks;
  } else {
    delete merged.hooks;
  }

  // --- all other generated keys: add if missing, do NOT overwrite existing ---
  for (const [key, value] of Object.entries(generated)) {
    if (key === "permissions" || key === "env" || key === "hooks") continue;
    if (merged[key] === undefined) {
      merged[key] = value;
    }
  }

  return JSON.stringify(merged, null, 2) + "\n";
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Whether a hook group runs a script this topology owns. */
function isOwnedHookGroup(group: unknown, scripts: string[]): boolean {
  if (!isPlainObject(group) || !Array.isArray(group.hooks)) return false;
  return group.hooks.some((h) => {
    if (!isPlainObject(h) || typeof h.command !== "string") return false;
    const tokens = h.command.split(/\s+/).map((t) => t.replace(/^\.\//, ""));
    return tokens.some((t) => scripts.includes(t));
  });
}

/**
 * Per event: the user's groups first, then the generated ones, deduplicated.
 * Returns undefined when no event keeps any group.
 */
function mergeHooks(
  existingHooks: unknown,
  generatedHooks: unknown,
  ownedPaths: string[],
): Record<string, unknown[]> | undefined {
  // Config files are never hook scripts; matching them would claim a user hook
  // that merely mentions CLAUDE.md.
  const scripts = ownedPaths
    .filter((p) => !/\.(md|json)$/.test(p))
    .map((p) => p.replace(/^\.\//, ""));
  const ex = isPlainObject(existingHooks) ? existingHooks : {};
  const gen = isPlainObject(generatedHooks) ? generatedHooks : {};
  const out: Record<string, unknown[]> = {};

  for (const event of new Set([...Object.keys(ex), ...Object.keys(gen)])) {
    // A group generated again stays where it is, so reruns (and two
    // topologies taking turns) do not reorder the file.
    const regenerated = new Set((Array.isArray(gen[event]) ? gen[event] : []).map((g) => JSON.stringify(g)));
    const kept = (Array.isArray(ex[event]) ? ex[event] : []).filter(
      (g) => regenerated.has(JSON.stringify(g)) || !isOwnedHookGroup(g, scripts),
    );
    const seen = new Set<string>();
    const groups: unknown[] = [];
    for (const g of [...kept, ...(Array.isArray(gen[event]) ? gen[event] : [])]) {
      const key = JSON.stringify(g);
      if (seen.has(key)) continue;
      seen.add(key);
      groups.push(g);
    }
    if (groups.length > 0) out[event] = groups;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function mergeObjects(
  existing: Record<string, unknown>,
  generated: Record<string, unknown>,
): Record<string, unknown> {
  // Start with a copy of existing (preserves user-only keys)
  const result: Record<string, unknown> = { ...existing };

  for (const [key, genValue] of Object.entries(generated)) {
    const exValue = existing[key];

    if (
      genValue !== null &&
      typeof genValue === "object" &&
      !Array.isArray(genValue) &&
      exValue !== null &&
      typeof exValue === "object" &&
      !Array.isArray(exValue)
    ) {
      // Both are objects — recurse
      result[key] = mergeObjects(
        exValue as Record<string, unknown>,
        genValue as Record<string, unknown>,
      );
    } else if (exValue === undefined) {
      // Key only in generated — add it
      result[key] = genValue;
    }
    // else: key exists in both and at least one is not an object — keep existing value
  }

  return result;
}
