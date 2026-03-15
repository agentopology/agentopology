/**
 * Incremental scaffold orchestrator.
 *
 * Computes a plan of file actions (create, update, delete, unchanged, conflict)
 * by comparing freshly generated files against what is on disk and what was
 * previously tracked in the scaffold manifest.
 *
 * @module
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { GeneratedFile } from "../bindings/types.js";
import type { FileAction, ScaffoldManifest } from "./types.js";
import { mergeAgentFile, shouldOverwriteScript, deepMergeJson } from "./merge.js";

/**
 * Compute an incremental scaffold plan.
 *
 * Compares generated files against what exists on disk and the previous
 * manifest to determine the minimal set of file operations needed.
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

  // Process each generated file
  for (const file of generatedFiles) {
    const absPath = join(basePath, file.path);
    const category = file.category ?? "machine";
    const onDisk = existsSync(absPath);

    if (!onDisk) {
      actions.push({ type: "create", path: file.path, content: file.content });
      continue;
    }

    const existingContent = readFileSync(absPath, "utf-8");
    const manifestEntry = manifest?.files[file.path] ?? null;

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

      case "script": {
        const manifestHash = manifestEntry?.hash ?? "";
        if (shouldOverwriteScript(existingContent, manifestHash)) {
          // User hasn't edited — safe to overwrite
          if (file.content === existingContent) {
            actions.push({ type: "unchanged", path: file.path });
          } else {
            actions.push({
              type: "update",
              path: file.path,
              content: file.content,
              detail: "script regenerated",
            });
          }
        } else {
          // User has edited — conflict
          actions.push({
            type: "conflict",
            path: file.path,
            content: file.content,
            detail: "user edited",
          });
        }
        break;
      }

      case "shared-config": {
        const merged = deepMergeJson(existingContent, file.content);
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
        break;
      }

      case "machine":
      default: {
        if (file.content === existingContent) {
          actions.push({ type: "unchanged", path: file.path });
        } else {
          actions.push({
            type: "update",
            path: file.path,
            content: file.content,
            detail: "config updated",
          });
        }
        break;
      }
    }
  }

  // Check for files in manifest that are no longer generated (deletions)
  if (manifest) {
    for (const manifestPath of Object.keys(manifest.files)) {
      if (!generatedMap.has(manifestPath)) {
        actions.push({ type: "delete", path: manifestPath });
      }
    }
  }

  return actions;
}

/**
 * Execute a set of file actions against the filesystem.
 *
 * @param basePath - Absolute path to the project root
 * @param actions - File actions computed by {@link computeIncrementalPlan}
 * @param options - Execution options
 * @returns Counts of each action type performed
 */
export function executeActions(
  basePath: string,
  actions: FileAction[],
  options: { prune: boolean; force: boolean },
): {
  created: number;
  updated: number;
  deleted: number;
  unchanged: number;
  conflicts: number;
} {
  const counts = { created: 0, updated: 0, deleted: 0, unchanged: 0, conflicts: 0 };

  for (const action of actions) {
    const absPath = join(basePath, action.path);

    switch (action.type) {
      case "create": {
        const dir = dirname(absPath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        writeFileSync(absPath, action.content, "utf-8");
        counts.created++;
        break;
      }

      case "update": {
        const dir = dirname(absPath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        writeFileSync(absPath, action.content, "utf-8");
        counts.updated++;
        break;
      }

      case "delete": {
        if (options.prune && existsSync(absPath)) {
          unlinkSync(absPath);
        }
        counts.deleted++;
        break;
      }

      case "conflict": {
        if (options.force) {
          const dir = dirname(absPath);
          if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
          }
          writeFileSync(absPath, action.content, "utf-8");
        }
        counts.conflicts++;
        break;
      }

      case "unchanged": {
        counts.unchanged++;
        break;
      }
    }
  }

  return counts;
}
