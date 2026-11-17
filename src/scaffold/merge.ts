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
} from "../sync/index.js";
import { hashContent } from "./manifest.js";
import { AGENTS_MD_BEGIN, AGENTS_MD_END } from "../bindings/codex.js";
import { fenceSpan } from "../bindings/lib/prompt-fence.js";

/**
 * Return the list of known structural headings for a binding.
 * Falls back to the Claude Code list for unknown bindings.
 */
function getStructuralHeadings(binding: string): string[] {
  switch (binding) {
    case "claude-code":
    default:
      return CLAUDE_CODE_STRUCTURAL_HEADINGS;
  }
}

/** Where the managed block (markers included) starts and ends, or null. */
function managedSpan(content: string): { start: number; end: number } | null {
  const open = content.indexOf(AGENTS_MD_BEGIN);
  if (open === -1) return null;
  const close = content.indexOf(AGENTS_MD_END, open);
  if (close === -1) return null;
  return { start: open, end: close + AGENTS_MD_END.length };
}

/** Both files hold a managed block (AGENTS.md): only the block is scaffold's. */
export function hasManagedBlock(existing: string, generated: string): boolean {
  return managedSpan(existing) !== null && managedSpan(generated) !== null;
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
  // A file with a managed block (AGENTS.md): only the block is ours; text
  // above and below it is the user's and stays.
  const myBlock = managedSpan(existing);
  const newBlock = managedSpan(generated);
  if (myBlock && newBlock) {
    return existing.slice(0, myBlock.start) + generated.slice(newBlock.start, newBlock.end) + existing.slice(myBlock.end);
  }

  // Files with prompt markers: keep the user's text between them, take
  // everything else from the generated file.
  const mine = fenceSpan(existing);
  const theirs = fenceSpan(generated);
  if (mine && theirs) {
    return generated.slice(0, theirs.start) + existing.slice(mine.start, mine.end) + generated.slice(theirs.end);
  }
  // A file from before the markers: its instructions move inside them once.
  if (theirs) {
    const legacy = extractSectionUntilKnownHeading(existing, "## Instructions", getStructuralHeadings(binding));
    if (legacy !== null) return generated.slice(0, theirs.start) + "\n" + legacy + "\n" + generated.slice(theirs.end);
  }

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
  // Nothing to add: keep the user's bytes, formatting included.
  if (JSON.stringify(merged) === JSON.stringify(existing)) return existingRaw;
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
 *   - hooks: per hook entry, never per group (see mergeHooks). The
 *     topology's entries (generated now, or naming a path in `ownedPaths`
 *     unless a program of the user's own runs it) are replaced by the
 *     generated hooks; every other entry, the user's, is kept where it is,
 *     also inside a group the topology wrote. Without `ownedPaths`, only
 *     what the .at generates now is the topology's
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

  // Nothing to add: keep the user's bytes, formatting included.
  if (JSON.stringify(merged) === JSON.stringify(existing)) return existingRaw;
  return JSON.stringify(merged, null, 2) + "\n";
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** A command with the project-dir prefix, quotes and "./" removed, blanks folded. */
function normalCommand(command: string): string {
  return command.replace(/"?\$CLAUDE_PROJECT_DIR\/?/g, "").replace(/["']/g, "").replace(/(^|\s)\.\//g, "$1").replace(/\s+/g, " ").trim();
}

/**
 * Identity of a hook entry: its command, normalized, so an imported hook
 * written as `bash .claude/hooks/x.sh` and the same hook compiled as
 * `bash "$CLAUDE_PROJECT_DIR/.claude/hooks/x.sh"` are one hook, not two that
 * both fire. Any other entry is itself.
 */
function hookId(h: unknown): string {
  return isPlainObject(h) && typeof h.command === "string" ? normalCommand(h.command) : JSON.stringify(h);
}

/**
 * Where a hook entry sits: its matcher and identity. Other fields (timeout,
 * if) are the file's once the entry is there, as in 0.11.x: an entry the
 * .at generates stays as the file has it.
 */
function hookPlace(matcher: unknown, h: unknown): string {
  return JSON.stringify([matcher ?? "", hookId(h)]);
}

/** Identity of a hook group for deduplication: matcher plus each entry's identity. */
function hookGroupKey(group: unknown): string {
  if (!isPlainObject(group) || !Array.isArray(group.hooks)) return JSON.stringify(group);
  return JSON.stringify([group.matcher ?? "", group.hooks.map(hookId)]);
}

/** Whether a hook entry's command runs (or names) a script this topology owns. */
function namesOwnedScript(h: unknown, scripts: string[]): boolean {
  if (!isPlainObject(h) || typeof h.command !== "string") return false;
  const tokens = h.command.split(/\s+/).map((t) => t.replace(/^\.\//, ""));
  if (tokens.some((t) => scripts.includes(t))) return true;
  // R-8: a Codex command names its script after a root expression,
  // `"$(git rev-parse …)/.codex/scripts/<t>/x.sh"` or `"$AT_ROOT/.codex/…"`, so no
  // whitespace token equals the path. Read every `.codex/scripts/…` path in it.
  for (const m of h.command.matchAll(/(?:^|[\s"'/])(\.codex\/scripts\/[^\s"'`;|&)]+)/g)) {
    if (scripts.includes(m[1])) return true;
  }
  // F-13: the Claude Code scaffold writes `bash "$CLAUDE_PROJECT_DIR/.claude/skills/<t>/scripts/x.sh"`,
  // which no whitespace token equals either. Only a path right after the variable counts, so a
  // user's `bash ./mine/.claude/skills/...` is still not claimed.
  for (const m of h.command.matchAll(/\$\{?CLAUDE_PROJECT_DIR\}?\/([^\s"'`;|&)]+)/g)) {
    if (scripts.includes(m[1].replace(/^\.\//, ""))) return true;
  }
  return false;
}

/** Whether a hook group runs a script this topology owns. */
function isOwnedHookGroup(group: unknown, scripts: string[]): boolean {
  if (!isPlainObject(group) || !Array.isArray(group.hooks)) return false;
  return group.hooks.some((h) => namesOwnedScript(h, scripts));
}

/** Words a binding writes before a script to run it (`bash <script>`), as `run:` names them. */
const RUNNER = /^(?:python[0-9.]*|bash|sh|zsh|node|bun|deno|ruby|perl|tsx)$/;

/** The folder a binding anchors a script path to: Claude Code's project dir, Codex's launcher root. */
const ANCHOR = /^\$\{?(?:CLAUDE_PROJECT_DIR|AT_ROOT)\}?\//;

/**
 * Whether a command that names one of the topology's scripts is the command
 * a binding writes for it, edited or not (as in 0.11.x): the script run by
 * an interpreter (`bash "$CLAUDE_PROJECT_DIR/<script>"`, the Codex launcher's
 * `bash "$AT_ROOT/<script>"`), or the script itself as the first word
 * (`<script> --flag`). An appended argument, a command chained before or
 * after it, still leaves it the topology's.
 *
 * Every other command naming a script is the user's, never removed: one
 * that starts with a program of the user's own (`./my-lint.sh <script>`), or
 * that only passes the script to one (`bash ./wrap.sh <script>`,
 * `STRICT=1 ./env.sh <script>`, `node tools/audit.js <script>`,
 * `cat <script> | ./audit.sh`). The first word's shape alone used to decide,
 * and the last four were removed with no line.
 */
function writesTopologyScript(command: string, scripts: string[]): boolean {
  const raw = command.replace(/["']/g, "").trim().split(/\s+/);
  const words = raw.map((w) => w.replace(ANCHOR, "").replace(/^\.\//, ""));
  const first = words[0] ?? "";
  if (scripts.includes(first)) return true;
  // A program of the user's own, by its path as written (`./name`,
  // `$CLAUDE_PROJECT_DIR/name`, `tools/name`), is the user's command (0.12.0).
  // Test the raw word: stripping `./` first made `./name` look bare.
  const firstRaw = raw[0] ?? "";
  if (firstRaw.includes("/") && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(firstRaw)) return false;
  return words.some(
    (w, i) =>
      (RUNNER.test(w) && scripts.includes(words[i + 1] ?? "")) ||
      (/^\$\{?AT_ROOT\}?\//.test(raw[i]) && scripts.includes(w)),
  );
}

/** A hook entry the merge kept although it sits with, or names, what the topology owns. */
export interface KeptHookCommand {
  event: string;
  command: string;
}

/**
 * The hook commands in `existingRaw` the merge keeps although their group
 * holds a hook the topology generates, or they name one of its scripts: one
 * line each, so a command the .at does not generate is never kept or
 * removed in silence. Empty when either file is not a JSON object.
 */
export function keptHookCommands(
  existingRaw: string,
  generatedRaw: string,
  ownedPaths: string[] = [],
): KeptHookCommand[] {
  let existing: unknown;
  let generated: unknown;
  try {
    existing = JSON.parse(existingRaw);
    generated = JSON.parse(generatedRaw);
  } catch {
    return [];
  }
  if (!isPlainObject(existing) || !isPlainObject(generated)) return [];
  const kept: KeptHookCommand[] = [];
  mergeHooks(existing.hooks, generated.hooks, ownedPaths, kept);
  return kept;
}

/**
 * Per event: the user's groups first, then the generated ones, deduplicated.
 * Returns undefined when no event keeps any group.
 *
 * Ownership is per hook entry, never per group. An entry is the topology's
 * when the .at generates it now, or when it is the command a binding writes
 * for one of the topology's scripts, edited or not (see
 * writesTopologyScript). The topology's entries that changed
 * are replaced by the generated ones; every other entry stays where it is,
 * and each one that sits in a group with the topology's hooks, or names one
 * of its scripts, is reported in `kept`.
 */
function mergeHooks(
  existingHooks: unknown,
  generatedHooks: unknown,
  ownedPaths: string[],
  kept: KeptHookCommand[] = [],
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
    const genGroups = (Array.isArray(gen[event]) ? gen[event] : []) as unknown[];
    const genIds = new Set<string>();
    // Each generated entry, by matcher and command: one already in the file
    // stays where it is and as it is, so reruns (and two topologies taking
    // turns) do not reorder the file.
    const free = new Map<string, number>();
    for (const g of genGroups) {
      if (!isPlainObject(g) || !Array.isArray(g.hooks)) continue;
      for (const h of g.hooks) {
        genIds.add(hookId(h));
        const k = hookPlace(g.matcher, h);
        free.set(k, (free.get(k) ?? 0) + 1);
      }
    }
    const placed = new Map<string, number>();
    // Only an entry naming one of the topology's scripts can be removed (a
    // hook on a project path the user owns stays, as in 0.11.x).
    const ours = (h: unknown) =>
      genIds.has(hookId(h)) ||
      (namesOwnedScript(h, scripts) && isPlainObject(h) && typeof h.command === "string" && writesTopologyScript(h.command, scripts));

    const groups: unknown[] = [];
    for (const g of (Array.isArray(ex[event]) ? ex[event] : []) as unknown[]) {
      if (!isPlainObject(g) || !Array.isArray(g.hooks)) {
        groups.push(g);
        continue;
      }
      const owned = g.hooks.some(ours);
      if (!owned && !isOwnedHookGroup(g, scripts)) {
        groups.push(g);
        continue;
      }
      const keep: unknown[] = [];
      for (const h of g.hooks) {
        if (genIds.has(hookId(h))) {
          // Generated now: kept in place under the same matcher; under
          // another matcher, or repeated, it gives way to the generated entry.
          const k = hookPlace(g.matcher, h);
          if ((free.get(k) ?? 0) > 0) {
            free.set(k, free.get(k)! - 1);
            placed.set(k, (placed.get(k) ?? 0) + 1);
            keep.push(h);
          }
          continue;
        }
        if (ours(h)) continue; // the topology's, no longer generated: removed
        keep.push(h);
        if (owned || namesOwnedScript(h, scripts)) {
          const command = isPlainObject(h) && typeof h.command === "string" ? h.command : JSON.stringify(h);
          kept.push({ event, command });
        }
      }
      if (keep.length === g.hooks.length) groups.push(g);
      else if (keep.length > 0) groups.push({ ...g, hooks: keep });
    }
    for (const g of genGroups) {
      if (!isPlainObject(g) || !Array.isArray(g.hooks)) {
        groups.push(g);
        continue;
      }
      const rest = g.hooks.filter((h) => {
        const k = hookPlace(g.matcher, h);
        if ((placed.get(k) ?? 0) === 0) return true;
        placed.set(k, placed.get(k)! - 1);
        return false;
      });
      if (rest.length === g.hooks.length) groups.push(g);
      else if (rest.length > 0) groups.push({ ...g, hooks: rest });
    }
    const seen = new Set<string>();
    const unique = groups.filter((g) => {
      const key = hookGroupKey(g);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (unique.length > 0) out[event] = unique;
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
