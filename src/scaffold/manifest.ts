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
 * Read an existing scaffold manifest from disk.
 * Returns `null` if the manifest does not exist or cannot be parsed.
 */
export function readManifest(
  basePath: string,
  target: string,
): ScaffoldManifest | null {
  const manifestPath = join(basePath, getManifestPath(target));
  if (!existsSync(manifestPath)) return null;

  try {
    const raw = readFileSync(manifestPath, "utf-8");
    return JSON.parse(raw) as ScaffoldManifest;
  } catch {
    return null;
  }
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
