/**
 * Incremental scaffold orchestrator.
 *
 * Computes a plan of file actions (create, update, delete, unchanged, conflict,
 * blocked) by comparing freshly generated files against what is on disk and
 * what was previously tracked in the scaffold manifest.
 *
 * The rule the plan enforces: scaffold only changes what it owns. A file is
 * owned when the manifest records it. Anything else on disk — a hand-written
 * skill, a settings file, a symlink into another repo — is a conflict (kept
 * unless --force) or blocked (never touched). The first scaffold used to skip
 * this plan and write everything; it overwrote real files and, following a
 * symlink, files in a second repository.
 *
 * @module
 */

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type { GeneratedFile } from "../bindings/types.js";
import type { FileAction, ManifestEntry, ScaffoldManifest } from "./types.js";
import { hashContent } from "./manifest.js";
import {
  mergeAgentFile,
  shouldOverwriteScript,
  deepMergeJson,
  deepMergeSettingsJson,
} from "./merge.js";
import { InvalidSettingsJsonError, SETTINGS_KEPT_DETAIL, SETTINGS_PATH } from "./undeclared.js";
import {
  applyOwnership,
  declaredIn,
  declaredOf,
  entryOf,
  interimEntry,
  ownedOf,
  ownsAnything,
  recordOwnership,
  skippedLine,
  NO_OTHERS,
  type Others,
  type RuleOwnership,
} from "./ownership.js";
import { manifestFiles } from "./manifest.js";

/** "a", "a and b", "a, b and c". */
function andList(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * What the other topologies in this project declare (OWN2): each rule they
 * declare is kept; an entry from before `rulesDeclared` holds every removal.
 */
function othersOf(basePath: string, target: string, source: string): Others {
  const keptBy = new Map<string, string>();
  let heldBy: string | null = null;
  const hold = (why: string) => { heldBy ??= `${SETTINGS_PATH}: owned rules kept, none removed; ${why}`; };
  for (const { file, manifest: m } of manifestFiles(basePath, target)) {
    // F6: a manifest that cannot be read could declare anything.
    if (!m || typeof m.source !== "string" || !m.files || typeof m.files !== "object") {
      hold(`${file} cannot be read; fix or delete it to release them`);
      continue;
    }
    if (m.source === source) continue;
    const raw = (m.files as Record<string, unknown>)[SETTINGS_PATH];
    if (raw === undefined) continue; // never wrote settings.json: declares no rule
    const declared = declaredOf(raw);
    if (!declared) {
      const missing = entryOf(raw)?.rulesDeclared === undefined;
      hold(missing
        ? `${file} records no declared rules (written before this version); re-scaffold ${m.source} to release them`
        : `${file} has a malformed rulesDeclared; re-scaffold ${m.source} to release them`);
      continue;
    }
    for (const l of ["allow", "ask", "deny"] as const) for (const r of declared[l]) if (!keptBy.has(`${l} ${r}`)) keptBy.set(`${l} ${r}`, m.source);
    if (declared.defaultMode !== undefined && !keptBy.has(`defaultMode ${declared.defaultMode}`)) keptBy.set(`defaultMode ${declared.defaultMode}`, m.source);
  }
  return { keptBy, heldBy };
}

export { unsafePathReason } from "../parser/paths.js";
import { unsafePathReason } from "../parser/paths.js";

/**
 * The first symlink between `basePath` and the file, or null. Scaffold never
 * writes through one: a linked skill folder belongs to somewhere else.
 */
function symlinkOnPath(basePath: string, relPath: string): string | null {
  let cur = basePath;
  for (const seg of relPath.split("/")) {
    cur = join(cur, seg);
    try {
      if (lstatSync(cur).isSymbolicLink()) return cur.slice(basePath.length + 1);
    } catch {
      return null; // does not exist yet — nothing further down can be a link
    }
  }
  return null;
}

function isDirectory(absPath: string): boolean {
  try {
    return lstatSync(absPath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Compute an incremental scaffold plan.
 *
 * Compares generated files against what exists on disk and the previous
 * manifest to determine the minimal set of file operations needed. Used for
 * the first scaffold too (manifest null): every existing file is then
 * unmanaged and therefore a conflict, never an overwrite.
 *
 * @param basePath - Absolute path to the project root
 * @param target - Binding target name (e.g. "claude-code")
 * @param generatedFiles - Files produced by the binding's scaffold function
 * @param manifest - Previous scaffold manifest (null if first scaffold)
 * @param sourcePath - The .at path relative to the project (OWN3); recorded on
 *   the settings.json entry and checked against it. Unknown when omitted.
 * @returns Array of file actions to execute
 */
export function computeIncrementalPlan(
  basePath: string,
  target: string,
  generatedFiles: GeneratedFile[],
  manifest: ScaffoldManifest | null,
  sourcePath?: string,
): FileAction[] {
  const actions: FileAction[] = [];

  // Build map of generated files by path
  const generatedMap = new Map<string, GeneratedFile>();
  for (const file of generatedFiles) {
    generatedMap.set(file.path, file);
  }

  // Everything this topology writes or wrote: hooks whose command names one of
  // these paths belong to it; every other hook in settings.json is the user's.
  const ownedPaths = [...generatedMap.keys(), ...Object.keys(manifest?.files ?? {})];

  // T6: the permission rules this topology added to settings.json before.
  const previousEntry = entryOf(manifest?.files?.[SETTINGS_PATH]);
  const previousRules = ownedOf(previousEntry);
  // OWN3: the manifest is keyed by the .at basename; an entry another path
  // owns (or one that owns rules and records no path) is not this run's.
  const skip = sourcePath !== undefined && previousEntry !== undefined &&
    (typeof previousEntry.sourcePath === "string"
      ? previousEntry.sourcePath !== sourcePath
      : ownsAnything(previousRules));
  // F2: an entry another .at of the same name has run on holds every removal, for good.
  const shared = Array.isArray(previousEntry?.ownershipSharedWith) ? previousEntry!.ownershipSharedWith.filter((x) => typeof x === "string") : [];
  const sharedLine = shared.length > 0
    ? `${SETTINGS_PATH}: owned rules kept, none removed; this manifest is shared by ${andList([previousEntry?.sourcePath ?? "an .at with no recorded path", ...shared])} (the same file name)`
    : null;
  // OWN2: only a run that may remove something reads the other manifests.
  const others: Others = !manifest || skip || !ownsAnything(previousRules)
    ? NO_OTHERS
    : sharedLine
      ? { keptBy: new Map(), heldBy: sharedLine }
      : othersOf(basePath, target, manifest.source);

  /** The ownership pass on settings.json: the content to write and what to record. */
  const own = (existingRaw: string | null, mergedRaw: string, generatedRaw: string | null): { content: string; rules: RuleOwnership } => {
    if (skip) {
      return {
        content: mergedRaw,
        rules: {
          owned: { allow: [], ask: [], deny: [] }, declared: declaredIn(generatedRaw), removed: [], retained: [],
          notes: [skippedLine(previousEntry?.sourcePath)], preserve: true, sharedWith: sourcePath,
        },
      };
    }
    const { content, ...rules } = applyOwnership(existingRaw, mergedRaw, generatedRaw, previousRules, others);
    return { content, rules: { ...rules, ...(sourcePath !== undefined ? { sourcePath } : {}) } };
  };

  // Process each generated file
  for (const file of generatedFiles) {
    const unsafe = unsafePathReason(file.path);
    if (unsafe) {
      actions.push({ type: "blocked", path: file.path, detail: unsafe, unsafe: true });
      continue;
    }

    const link = symlinkOnPath(basePath, file.path);
    if (link) {
      actions.push({ type: "blocked", path: file.path, detail: `symlink at ${link} — never written through` });
      continue;
    }

    const absPath = join(basePath, file.path);
    if (isDirectory(absPath)) {
      actions.push({ type: "blocked", path: file.path, detail: "a directory exists at this path" });
      continue;
    }

    const category = file.category ?? "machine";
    const onDisk = existsSync(absPath);

    if (!onDisk) {
      // A settings.json scaffold creates: every rule in it is one it added.
      const rules: RuleOwnership | undefined = file.path === SETTINGS_PATH ? own(null, file.content, file.content).rules : undefined;
      actions.push({
        type: "create",
        path: file.path,
        content: file.content,
        ...(file.executable ? { executable: true } : {}),
        ...(rules ? { rules } : {}),
      });
      continue;
    }

    if (file.createOnly) {
      actions.push({ type: "kept", path: file.path, detail: "the user's own file; created only when missing" });
      continue;
    }

    const existingContent = readFileSync(absPath, "utf-8");
    const manifestEntry = manifest?.files[file.path] ?? null;

    if (existingContent === file.content) {
      if (file.path === SETTINGS_PATH && category === "shared-config") {
        actions.push({ type: "unchanged", path: file.path, rules: own(existingContent, existingContent, file.content).rules });
      } else {
        actions.push({ type: "unchanged", path: file.path });
      }
      continue;
    }

    // Config files merge whether or not scaffold made them: the merge keeps
    // every key, hook and rule the user wrote.
    if (category === "shared-config") {
      const isSettings = /(^|\/)settings\.json$/.test(file.path) || file.path === ".codex/hooks.json";
      // An invalid file, or one whose root is not an object, stops the run
      // before anything is written, with the file's name and what is wrong
      // (it used to be a stack trace, or a silent overwrite).
      if (isSettings && existingContent.trim() !== "") {
        let root: unknown;
        try {
          root = JSON.parse(existingContent);
        } catch (err) {
          throw new InvalidSettingsJsonError(file.path, (err as Error).message);
        }
        if (root === null || typeof root !== "object" || Array.isArray(root)) {
          const kind = root === null ? "null" : Array.isArray(root) ? "an array" : `a ${typeof root}`;
          throw new InvalidSettingsJsonError(file.path, `its root is ${kind}`, "is not a JSON object");
        }
      }
      const union = isSettings
        ? deepMergeSettingsJson(existingContent, file.content, ownedPaths)
        : deepMergeJson(existingContent, file.content);
      // T6: on .claude/settings.json, remove the owned rules the .at dropped.
      // The union merge itself is unchanged; with nothing owned to remove,
      // this is its output byte for byte.
      if (file.path === SETTINGS_PATH) {
        const { content, rules } = own(existingContent, union, file.content);
        actions.push(content === existingContent
          ? { type: "unchanged", path: file.path, rules }
          : { type: "update", path: file.path, content, detail: "config merged", rules });
        continue;
      }
      const merged = union;
      if (merged === existingContent) {
        actions.push({ type: "unchanged", path: file.path });
      } else {
        actions.push({
          type: "update",
          path: file.path,
          content: merged,
          detail: "config merged",
        });
      }
      continue;
    }

    // Not in the manifest: a file scaffold did not create. Never overwrite it.
    if (!manifestEntry) {
      actions.push({
        type: "conflict",
        path: file.path,
        content: file.content,
        detail: "exists, not created by scaffold",
      });
      continue;
    }

    switch (category) {
      case "agent": {
        const merged = mergeAgentFile(existingContent, file.content, target);
        if (merged === existingContent) {
          actions.push({ type: "unchanged", path: file.path });
        } else {
          actions.push({
            type: "update",
            path: file.path,
            content: merged,
            detail: "prompt preserved",
          });
        }
        break;
      }

      case "script":
      case "machine":
      default: {
        // Overwrite only what is still exactly as scaffold left it. CLAUDE.md,
        // commands and crontab.fragment used to be overwritten on every run,
        // edits and all.
        if (shouldOverwriteScript(existingContent, manifestEntry.hash)) {
          actions.push({
            type: "update",
            path: file.path,
            content: file.content,
            detail: category === "script" ? "script regenerated" : "config updated",
            ...(file.executable ? { executable: true } : {}),
          });
        } else {
          actions.push({
            type: "conflict",
            path: file.path,
            content: file.content,
            detail: "user edited",
          });
        }
        break;
      }
    }
  }

  // Files in the manifest that are no longer generated
  if (manifest) {
    for (const [manifestPath, rawEntry] of Object.entries(manifest.files)) {
      // F5: an entry that is not an object records nothing: nothing to delete or own.
      const entry = entryOf(rawEntry);
      if (!entry) continue;
      if (generatedMap.has(manifestPath)) continue;
      if (unsafePathReason(manifestPath)) continue;
      const absPath = join(basePath, manifestPath);
      if (!existsSync(absPath)) continue;
      if (symlinkOnPath(basePath, manifestPath)) {
        actions.push({ type: "blocked", path: manifestPath, detail: "symlink — never deleted through" });
        continue;
      }
      // T6: settings.json is no longer generated (the .at declares no rule):
      // the owned rules go, everything else stays, and the file is never deleted.
      // It also records that the .at now declares nothing (OWN2).
      if (manifestPath === SETTINGS_PATH) {
        const existingContent = readFileSync(absPath, "utf-8");
        const { content, rules } = own(existingContent, existingContent, null);
        if (content !== existingContent) {
          actions.push({ type: "update", path: manifestPath, content, detail: "owned rules removed", rules });
        } else if (hashContent(existingContent) !== entry.hash) {
          actions.push({ type: "blocked", path: manifestPath, detail: "no longer generated, but edited — kept", rules });
        } else {
          actions.push({ type: "kept", path: manifestPath, detail: SETTINGS_KEPT_DETAIL, rules });
        }
        continue;
      }
      if (hashContent(readFileSync(absPath, "utf-8")) !== entry.hash) {
        actions.push({ type: "blocked", path: manifestPath, detail: "no longer generated, but edited — kept" });
        continue;
      }
      // settings.json is never deleted: it can hold rules, hooks and keys
      // that no manifest hash tells apart from scaffold's.
      if (manifestPath === SETTINGS_PATH) {
        actions.push({ type: "kept", path: manifestPath, detail: SETTINGS_KEPT_DETAIL });
        continue;
      }
      actions.push({ type: "delete", path: manifestPath });
    }
  }

  return actions;
}

/** Remove now-empty directories from `absDir` up to (not including) `basePath`. */
function removeEmptyDirs(basePath: string, absDir: string): void {
  let cur = absDir;
  while (cur.startsWith(basePath + "/") && cur !== basePath) {
    try {
      if (readdirSync(cur).length > 0) return;
      rmdirSync(cur);
    } catch {
      return;
    }
    cur = dirname(cur);
  }
}

/** Result of {@link executeActions}. */
export interface ExecuteResult {
  created: number;
  updated: number;
  deleted: number;
  unchanged: number;
  conflicts: number;
  blocked: number;
  /** Paths whose content on disk is now what this run wrote. */
  written: Map<string, string>;
  /** Paths removed from disk by this run. */
  removed: string[];
  /** Writes that failed; the run continues with the other files. */
  failures: Array<{ path: string; error: string }>;
}

/**
 * Execute a set of file actions against the filesystem.
 *
 * Refuses outright when the plan holds an unsafe path, so a bad plan writes
 * nothing at all. A single failed write is recorded and the rest proceed, so
 * the caller can still write a manifest that matches the disk.
 *
 * @param basePath - Absolute path to the project root
 * @param actions - File actions computed by {@link computeIncrementalPlan}
 * @param options - Execution options
 * @returns Counts of each action type performed, plus what was written
 */
export function executeActions(
  basePath: string,
  actions: FileAction[],
  options: { prune: boolean; force: boolean },
): ExecuteResult {
  const unsafe = actions.filter((a) => a.type === "blocked" && a.unsafe);
  if (unsafe.length > 0) {
    throw new Error(
      `refusing to write: ${unsafe.length} unsafe path(s): ` +
        unsafe.map((a) => `${a.path}`).join(", "),
    );
  }

  const result: ExecuteResult = {
    created: 0,
    updated: 0,
    deleted: 0,
    unchanged: 0,
    conflicts: 0,
    blocked: 0,
    written: new Map(),
    removed: [],
    failures: [],
  };

  const write = (path: string, content: string, executable?: boolean): boolean => {
    const absPath = join(basePath, path);
    try {
      mkdirSync(dirname(absPath), { recursive: true });
      writeFileSync(absPath, content, "utf-8");
      if (executable) chmodSync(absPath, 0o755);
      result.written.set(path, content);
      return true;
    } catch (err) {
      result.failures.push({ path, error: (err as Error).message });
      return false;
    }
  };

  for (const action of actions) {
    switch (action.type) {
      case "create": {
        if (write(action.path, action.content, action.executable)) result.created++;
        break;
      }

      case "update": {
        if (write(action.path, action.content, action.executable)) result.updated++;
        break;
      }

      case "delete": {
        const absPath = join(basePath, action.path);
        // A delete of settings.json from any plan is refused, as in computeIncrementalPlan.
        if (options.prune && action.path !== SETTINGS_PATH && existsSync(absPath)) {
          try {
            unlinkSync(absPath);
            result.removed.push(action.path);
            removeEmptyDirs(basePath, dirname(absPath));
          } catch (err) {
            result.failures.push({ path: action.path, error: (err as Error).message });
          }
        }
        result.deleted++;
        break;
      }

      case "conflict": {
        if (options.force) write(action.path, action.content);
        result.conflicts++;
        break;
      }

      case "blocked": {
        result.blocked++;
        break;
      }

      case "kept": {
        result.unchanged++;
        break;
      }

      case "unchanged": {
        result.unchanged++;
        break;
      }
    }
  }

  return result;
}

/**
 * The manifest after a run: exactly the files scaffold now owns, hashed as
 * they are on disk.
 *
 * Owned = written or unchanged this run, plus earlier entries for files the
 * run left alone (an edited file keeps its old hash, so it stays a conflict;
 * an unpruned leftover stays tracked, so a later --prune can still remove it).
 * A pre-existing file scaffold did not write is never claimed.
 */
export function nextManifestFiles(
  basePath: string,
  actions: FileAction[],
  generatedFiles: GeneratedFile[],
  previous: ScaffoldManifest | null,
  result: ExecuteResult,
): Record<string, ManifestEntry> {
  const categoryOf = new Map(generatedFiles.map((f) => [f.path, f.category ?? "machine"] as const));
  const files: Record<string, ManifestEntry> = {};
  const removed = new Set(result.removed);

  for (const action of actions) {
    const prev = entryOf(previous?.files?.[action.path]);
    const category = categoryOf.get(action.path) ?? prev?.category ?? "machine";
    const written = result.written.get(action.path);
    const rules = "rules" in action ? action.rules : undefined;

    // OWN3 (P2-3): a run that skipped ownership writes nothing to the entry
    // but the shared mark: not its hash, not undeclaredRulesNamed.
    if (rules?.preserve && prev) {
      files[action.path] = interimEntry(prev, rules)!;
      continue;
    }

    if (written !== undefined) {
      files[action.path] = { hash: hashContent(written), category };
    } else if (action.type === "unchanged") {
      const onDisk = readFileSync(join(basePath, action.path), "utf-8");
      files[action.path] = { hash: hashContent(onDisk), category };
    } else if (prev && !removed.has(action.path)) {
      files[action.path] = { ...prev };
    }

    // T6: the rules this topology owns once the run is done. F7: a
    // settings.json write that failed keeps the entry written before it
    // (what was owned before and after: the dropped rule unowned, the added
    // one not claimed).
    const entry = files[action.path];
    if (rules && entry) {
      const failed = (action.type === "create" || action.type === "update") && written === undefined;
      if (!failed) recordOwnership(entry, rules, prev);
      else files[action.path] = interimEntry(prev, rules) ?? entry;
    }
  }

  return files;
}

/** Whether two manifest file maps say the same, whatever their key order. */
export function sameManifestFiles(a: unknown, b: unknown): boolean {
  const canon = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(canon)
      : v !== null && typeof v === "object"
        ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]))
        : v;
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

/**
 * F7: the manifest files to write BEFORE settings.json: the previous ones,
 * with the settings.json entry owning only what it owns both before and after
 * this run. Null when this run carries no ownership change to protect.
 */
export function interimManifestFiles(previous: ScaffoldManifest | null, actions: FileAction[]): Record<string, ManifestEntry> | null {
  const action = actions.find((a) => a.path === SETTINGS_PATH && "rules" in a && a.rules);
  if (!action || !("rules" in action) || !action.rules) return null;
  const files: Record<string, ManifestEntry> = {};
  for (const [p, e] of Object.entries(previous?.files ?? {})) {
    const entry = entryOf(e);
    if (entry) files[p] = entry;
  }
  const entry = interimEntry(entryOf(previous?.files?.[SETTINGS_PATH]), action.rules);
  if (entry) files[SETTINGS_PATH] = entry;
  return files;
}
