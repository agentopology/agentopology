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
    case "cursor":
      return join(".cursor", MANIFEST_FILENAME);
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
 * Read and parse a manifest file, returning `null` when it is absent or invalid.
 */
function loadManifestFile(manifestPath: string): ScaffoldManifest | null {
  if (!existsSync(manifestPath)) return null;

  try {
    const raw = readFileSync(manifestPath, "utf-8");
    return JSON.parse(raw) as ScaffoldManifest;
  } catch {
    return null;
  }
}

/**
 * Read an existing scaffold manifest from disk.
 * Returns `null` if the manifest does not exist or cannot be parsed.
 *
 * A manifest that names a *different* target is treated as absent. Targets
 * without a dedicated config directory all resolve to the same root path, so
 * without this check one binding would read another's file list and act on it.
 */
export function readManifest(
  basePath: string,
  target: string,
): ScaffoldManifest | null {
  const manifestPath = join(basePath, getManifestPath(target));
  const manifest = loadManifestFile(manifestPath);
  if (manifest) {
    // `target` is absent in manifests written before it was recorded; those
    // predate multi-binding projects, so accept them rather than discard them.
    return !manifest.target || manifest.target === target ? manifest : null;
  }

  // Legacy fallback: targets that have since gained a dedicated config
  // directory used to write their manifest to the project root. Adopt it only
  // when it names this target, so the first re-scaffold after an upgrade stays
  // incremental instead of being mistaken for a first run.
  const rootPath = join(basePath, MANIFEST_FILENAME);
  if (rootPath === manifestPath) return null;

  const rootManifest = loadManifestFile(rootPath);
  return rootManifest && rootManifest.target === target ? rootManifest : null;
}

/**
 * Write a scaffold manifest to disk, creating parent directories as needed.
 */
export function writeManifest(
  basePath: string,
  target: string,
  manifest: ScaffoldManifest,
): void {
  const manifestPath = join(basePath, getManifestPath(target));
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
