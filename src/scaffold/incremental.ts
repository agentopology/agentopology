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

/** One path segment a binding may produce. Junk like `E;`, `fail:`, `x)` fails. */
const SAFE_SEGMENT = /^[A-Za-z0-9_.@+-]+$/;

/**
 * Why a generated relative path is unsafe to write, or null when it is fine.
 *
 * @param relPath - Path relative to the project root, as a binding emits it
 */
export function unsafePathReason(relPath: string): string | null {
  if (relPath.trim() === "") return "empty path";
  if (relPath.endsWith("/")) return "ends in '/' (no file name)";
  if (relPath.startsWith("/")) return "absolute path";
  const segments = relPath.split("/");
  for (const seg of segments) {
    if (seg === "") return "empty path segment";
    if (seg === "..") return "climbs out of the project ('..')";
    if (!SAFE_SEGMENT.test(seg)) return `unsafe name "${seg}"`;
  }
  return null;
}

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
 * @returns Array of file actions to execute
 */
export function computeIncrementalPlan(
  basePath: string,
  target: string,
  generatedFiles: GeneratedFile[],
  manifest: ScaffoldManifest | null,
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
      actions.push({
        type: "create",
        path: file.path,
        content: file.content,
        ...(file.executable ? { executable: true } : {}),
      });
      continue;
    }

    const existingContent = readFileSync(absPath, "utf-8");
    const manifestEntry = manifest?.files[file.path] ?? null;

    if (existingContent === file.content) {
      actions.push({ type: "unchanged", path: file.path });
      continue;
    }

    // Config files merge whether or not scaffold made them: the merge keeps
    // every key, hook and rule the user wrote.
    if (category === "shared-config") {
      const isSettings = /(^|\/)settings\.json$/.test(file.path);
      const merged = isSettings
        ? deepMergeSettingsJson(existingContent, file.content, ownedPaths)
        : deepMergeJson(existingContent, file.content);
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
    for (const [manifestPath, entry] of Object.entries(manifest.files)) {
      if (generatedMap.has(manifestPath)) continue;
      if (unsafePathReason(manifestPath)) continue;
      const absPath = join(basePath, manifestPath);
      if (!existsSync(absPath)) continue;
      if (symlinkOnPath(basePath, manifestPath)) {
        actions.push({ type: "blocked", path: manifestPath, detail: "symlink — never deleted through" });
        continue;
      }
      if (hashContent(readFileSync(absPath, "utf-8")) !== entry.hash) {
        actions.push({ type: "blocked", path: manifestPath, detail: "no longer generated, but edited — kept" });
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
        if (options.prune && existsSync(absPath)) {
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
    const prev = previous?.files[action.path];
    const category = categoryOf.get(action.path) ?? prev?.category ?? "machine";
    const written = result.written.get(action.path);

    if (written !== undefined) {
      files[action.path] = { hash: hashContent(written), category };
    } else if (action.type === "unchanged") {
      const onDisk = readFileSync(join(basePath, action.path), "utf-8");
      files[action.path] = { hash: hashContent(onDisk), category };
    } else if (prev && !removed.has(action.path)) {
      files[action.path] = prev;
    }
  }

  return files;
}
