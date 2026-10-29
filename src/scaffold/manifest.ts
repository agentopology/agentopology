/**
 * Manifest I/O for the incremental scaffold system.
 *
 * Reads and writes `.scaffold-manifest.json` files that track what was
 * generated, enabling intelligent re-scaffolding.
 *
 * @module
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ScaffoldManifest } from "./types.js";

const MANIFEST_FILENAME = ".scaffold-manifest.json";

/**
 * Return the platform-specific manifest path (relative to project root).
 *
 * Each binding stores the manifest inside its own config directory so it
 * doesn't collide with other bindings scaffolded into the same project.
 */
export function getManifestPath(target: string): string {
  switch (target) {
    case "claude-code":
      return join(".claude", MANIFEST_FILENAME);
    case "codex":
      return join(".codex", MANIFEST_FILENAME);
    case "gemini-cli":
      return join(".gemini", MANIFEST_FILENAME);
    case "copilot-cli":
      return join(".github", MANIFEST_FILENAME);
    case "openclaw":
      return join(".openclaw", MANIFEST_FILENAME);
    case "kiro":
      return join(".kiro", MANIFEST_FILENAME);
    default:
      // SDK bindings and unknown targets use root
      return MANIFEST_FILENAME;
  }
}

/**
 * Where one topology's manifest lives when the shared one belongs to another
 * topology: `.scaffold-manifest.<source>.json` beside it.
 */
function perSourcePath(target: string, source: string): string {
  return getManifestPath(target).replace(/\.json$/, `.${source.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
}

function readJson(path: string): ScaffoldManifest | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as ScaffoldManifest;
  } catch {
    return null;
  }
}

/**
 * Read an existing scaffold manifest from disk.
 * Returns `null` if the manifest does not exist or cannot be parsed.
 *
 * With `source` (the .at file name), returns only that topology's manifest:
 * two topologies scaffolded into one project used to share one manifest, so
 * the second treated the first one's files as its own — overwriting its
 * crontab and, with --prune, deleting its scripts.
 */
export function readManifest(
  basePath: string,
  target: string,
  source?: string,
): ScaffoldManifest | null {
  const shared = readJson(join(basePath, getManifestPath(target)));
  if (!source) return shared;
  const own = readJson(join(basePath, perSourcePath(target, source)));
  if (own) return own;
  return shared && shared.source === source ? shared : null;
}

/**
 * Write a scaffold manifest to disk, creating parent directories as needed.
 * Never replaces another topology's manifest: when the shared file belongs to
 * a different source, this one goes beside it.
 */
export function writeManifest(
  basePath: string,
  target: string,
  manifest: ScaffoldManifest,
): void {
  const sharedPath = join(basePath, getManifestPath(target));
  const shared = readJson(sharedPath);
  const ownPath = join(basePath, perSourcePath(target, manifest.source));
  const manifestPath =
    existsSync(ownPath) || (shared && shared.source !== manifest.source) ? ownPath : sharedPath;
  const dir = dirname(manifestPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
}

/**
 * Compute a SHA-256 hex digest of a string.
 */
export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}
