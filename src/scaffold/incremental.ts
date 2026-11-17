/**
 * Incremental scaffold orchestrator.
 *
 * Computes a plan of file actions (create, update, delete, unchanged, conflict,
 * blocked) by comparing freshly generated files against what is on disk and
 * what was previously tracked in the scaffold manifest.
 *
 * The rule the plan enforces: scaffold only changes what it owns. A file is
 * owned when the manifest records it and is still exactly as scaffold wrote
 * it. Anything else on disk — a hand-written skill, an edited rules file, a
 * symlink into another repo — gets its frontmatter patched (agent, skill and
 * command files), is merged (config files), or is kept whole, --force
 * included; a symlink is blocked (never touched). The first scaffold used to skip
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
import { isStubContent } from "../bindings/lib/stub.js";

import type { GeneratedFile, StructureSpec } from "../bindings/types.js";
import type { FileAction, ManifestEntry, ScaffoldManifest } from "./types.js";
import { planStructurePatch } from "./structure.js";
import type { FieldValue } from "./frontmatter-patch.js";
import { hashContent } from "./manifest.js";
import { editedRegions, markersIntact, regionHashes, regionsOf, staleBodyNotice } from "./regions.js";
import {
  hasManagedBlock,
  mergeAgentFile,
  shouldOverwriteScript,
  deepMergeJson,
  deepMergeSettingsJson,
  keptHookCommands,
} from "./merge.js";
import { InvalidSettingsJsonError, SETTINGS_KEPT_DETAIL, SETTINGS_PATH } from "./undeclared.js";

export { unsafePathReason } from "../parser/paths.js";
import { unsafePathReason } from "../parser/paths.js";

/** A file scaffold wrote and the user edited since, with nothing to patch: never replaced. */
export const USER_EDITED_KEPT = "user edited — kept";
/** A file at a generated path that scaffold did not write: never replaced. */
export const NOT_OURS_KEPT = "exists, not created by scaffold — kept";

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
  options: {
    force?: boolean;
    structure?: StructureSpec[];
    /** A file's frontmatter as the .at would state it (see echo.ts). */
    echo?: (spec: StructureSpec, text: string) => Record<string, FieldValue> | null;
  } = {},
): FileAction[] {
  const actions: FileAction[] = [];
  const force = !!options.force;
  const structure = options.structure ?? [];
  // Agent, skill and command files the user wrote or edited get the .at's
  // frontmatter keys patched in; their body is never written.
  const structureAt = new Map(structure.filter((s) => !s.authored).map((s) => [s.path, s]));
  const patch = (spec: StructureSpec, existing: string) =>
    planStructurePatch(spec, existing, manifest?.fields?.[spec.path], force, options.echo?.(spec, existing) ?? null);

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

    // A script the user fills in (a hook's or gate's stub), at a path they
    // named or at the generated one: once the user has written it, it is
    // theirs, and neither a plain run nor --force puts the stub back. The
    // stub at the generated path used to be overwritten by --force, and the
    // stub's exit 1 does not block on PreToolUse, so a guard the user built
    // was switched off. Only a file still exactly as scaffold wrote it is
    // regenerated.
    if (file.createOnly || isUserScriptStub(file)) {
      const untouched = manifestEntry !== null && shouldOverwriteScript(existingContent, manifestEntry.hash);
      if (!untouched) {
        actions.push({
          type: "kept",
          path: file.path,
          detail: manifestEntry ? "user edited" : "the user's own file; created only when missing",
        });
        continue;
      }
    }

    if (existingContent === file.content) {
      actions.push({ type: "unchanged", path: file.path });
      continue;
    }

    // A structured file scaffold wrote and nobody edited is regenerated as
    // before; one the user wrote or edited gets a frontmatter patch.
    const untouched = manifestEntry !== null && shouldOverwriteScript(existingContent, manifestEntry.hash);
    const spec = structureAt.get(file.path);
    // Which regions of a scaffolded agent file the edit touched (regions.ts).
    const edit = !untouched && manifestEntry ? editedRegions(existingContent, file.content, manifestEntry) : null;
    if (spec && !untouched) {
      const action = patch(spec, existingContent);
      if (action.type === "blocked") {
        const whose = manifestEntry ? "user edited" : "exists, not created by scaffold";
        action.detail = `${whose} — kept; ${action.detail}`;
      } else if (action.type === "patch" && edit && !edit.outside && markersIntact(existingContent)) {
        // Only the prompt (and maybe frontmatter) was edited: the generated
        // sections are scaffold's, so they are regenerated around the
        // user's prompt, as 0.11.4 did; the frontmatter is the patch's.
        const front = action.content ?? existingContent;
        const merged = mergeAgentFile(existingContent, file.content, target);
        const next = headOf(front) + merged.slice(headOf(merged).length);
        if (next !== front) {
          action.content = next;
          action.changes.push("sections outside the prompt markers regenerated, prompt kept");
        }
      } else if (action.type === "patch" && manifestEntry) {
        // The body is the user's (its text outside the prompt was edited, or
        // the markers are missing or altered, so where the prompt is is not
        // guessed): say what the .at changed that cannot reach it.
        const notice = staleBodyNotice(existingContent, file.content, manifestEntry);
        if (notice) action.body = notice;
      }
      actions.push(action);
      continue;
    }

    // Config files merge whether or not scaffold made them: the merge keeps
    // every key, hook and rule the user wrote.
    if (category === "shared-config") {
      const isSettings = isSettingsPath(file.path);
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
      const merged = isSettings
        ? deepMergeSettingsJson(existingContent, file.content, ownedPaths)
        : deepMergeJson(existingContent, file.content);
      // A hook command the .at does not generate is never removed; one that
      // sits with the topology's hooks or names its script is said.
      const notes = isSettings && existingContent.trim() !== ""
        ? keptHookCommands(existingContent, file.content, ownedPaths).map(
            (k) => `${file.path} hooks.${k.event}: kept a command the .at does not generate: ${k.command}`,
          )
        : [];
      const said = notes.length > 0 ? { notes } : {};
      if (merged === existingContent) {
        actions.push({ type: "unchanged", path: file.path, ...said });
      } else {
        actions.push({
          type: "update",
          path: file.path,
          content: merged,
          detail: "config merged",
          ...said,
        });
      }
      continue;
    }

    // A file the user wrote or edited, with no frontmatter for the .at to
    // patch: its text is theirs, so it is kept whole, with or without
    // --force, exactly like a user's script. The topology's own SKILL.md, a
    // group's skill and transcript, the rules file: these used to be
    // rewritten whole on a plain run (said as "prompt preserved") or by
    // --force. Only a managed block (AGENTS.md) is replaced inside a file
    // the user edited around it.
    if (!untouched) {
      // Only the text between the prompt markers was edited: the rest is
      // scaffold's, regenerated around the user's prompt.
      if (edit && !edit.outside && !edit.head && markersIntact(existingContent)) {
        const merged = mergeAgentFile(existingContent, file.content, target);
        actions.push(merged === existingContent
          ? { type: "unchanged", path: file.path }
          : { type: "update", path: file.path, content: merged, detail: "prompt preserved" });
        continue;
      }
      if (manifestEntry && category === "agent" && hasManagedBlock(existingContent, file.content)) {
        const merged = mergeAgentFile(existingContent, file.content, target);
        actions.push(merged === existingContent
          ? { type: "unchanged", path: file.path }
          : { type: "update", path: file.path, content: merged, detail: "managed block updated" });
        continue;
      }
      actions.push({
        type: "kept",
        path: file.path,
        detail: manifestEntry ? USER_EDITED_KEPT : NOT_OURS_KEPT,
      });
      continue;
    }

    // Still exactly as scaffold wrote it: regenerated (an agent file keeps
    // the text between its prompt markers, as it always did).
    if (category === "agent") {
      const merged = mergeAgentFile(existingContent, file.content, target);
      if (merged === existingContent) {
        actions.push({ type: "unchanged", path: file.path });
      } else {
        actions.push({
          type: "update",
          path: file.path,
          content: merged,
          // Nothing of the user's was in it to lose; the label is the one 0.11.x printed.
          detail: "prompt preserved",
        });
      }
      continue;
    }
    actions.push({
      type: "update",
      path: file.path,
      content: file.content,
      detail: category === "script" ? "script regenerated" : "config updated",
      ...(file.executable ? { executable: true } : {}),
    });
  }

  // Hand-written nodes (`file:`): never generated, only patched. A missing
  // one is not created (the CLI names it).
  for (const spec of structure) {
    if (!spec.authored || generatedMap.has(spec.path)) continue;
    if (unsafePathReason(spec.path)) continue;
    const absPath = join(basePath, spec.path);
    if (!existsSync(absPath) || isDirectory(absPath)) continue;
    const link = symlinkOnPath(basePath, spec.path);
    if (link) {
      actions.push({ type: "blocked", path: spec.path, detail: `symlink at ${link} — never written through` });
      continue;
    }
    actions.push(patch(spec, readFileSync(absPath, "utf-8")));
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

/**
 * A manifest entry with the region hashes of a file with prompt markers: a
 * region is recorded when the file holds it as the .at generates it now (so
 * it is scaffold's), and keeps its earlier hash otherwise.
 */
function withRegions(entry: ManifestEntry, onDisk: string | null, generated: string | undefined): ManifestEntry {
  if (onDisk === null || generated === undefined) return entry;
  const mine = regionsOf(onDisk);
  const theirs = regionsOf(generated);
  if (!mine || !theirs) return entry;
  const hashes = regionHashes(onDisk)!;
  const next: ManifestEntry = { ...entry };
  if (mine.head === theirs.head) next.head = hashes.head;
  if (mine.outside === theirs.outside) next.outside = hashes.outside;
  return next;
}

/** A config file whose hooks are merged by owner. */
function isSettingsPath(path: string): boolean {
  return /(^|\/)settings\.json$/.test(path) || path === ".codex/hooks.json";
}

function readText(absPath: string): string | null {
  try {
    return readFileSync(absPath, "utf-8");
  } catch {
    return null;
  }
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

      case "patch": {
        // Frontmatter only; --force was already applied when the patch was planned.
        // A file left as it is stays out of the counts, as a hand-written
        // node's file always was.
        if (action.content !== null && write(action.path, action.content)) result.updated++;
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
  const generatedOf = new Map(generatedFiles.map((f) => [f.path, f.content] as const));
  const files: Record<string, ManifestEntry> = {};
  const removed = new Set(result.removed);

  for (const action of actions) {
    const prev = previous?.files[action.path];
    const category = categoryOf.get(action.path) ?? prev?.category ?? "machine";
    const written = result.written.get(action.path);

    // A patched file stays the user's: never claimed, and an earlier entry
    // keeps its old hash (so the file still counts as edited).
    if (action.type === "patch") {
      if (prev) files[action.path] = withRegions(prev, written ?? readText(join(basePath, action.path)), generatedOf.get(action.path));
      continue;
    }

    if (written !== undefined) {
      files[action.path] = withRegions({ hash: hashContent(written), category }, written, generatedOf.get(action.path));
    } else if (action.type === "unchanged") {
      const onDisk = readFileSync(join(basePath, action.path), "utf-8");
      files[action.path] = withRegions({ hash: hashContent(onDisk), category }, onDisk, generatedOf.get(action.path));
    } else if (prev && !removed.has(action.path)) {
      files[action.path] = prev;
    }
  }

  return files;
}

/** The frontmatter block of a file, fences included ("" when there is none). */
function headOf(content: string): string {
  return regionsOf(content)?.head ?? /^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(content)?.[0] ?? "";
}

/** A generated stub for a script the user writes (see GeneratedFile.userScript). */
export function isUserScriptStub(file: GeneratedFile): boolean {
  return !!file.createOnly || !!file.userScript || ((file.category ?? "machine") === "script" && isStubContent(file.content));
}
