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
 * A manifest scaffold cannot read: the run stops with one line naming it
 * (it used to be a TypeError stack, or a value read as something else).
 */
export class InvalidManifestError extends Error {
  constructor(readonly path: string, readonly problem: string) {
    super(`${path} is not a scaffold manifest this version can read: ${problem}`);
    this.name = "InvalidManifestError";
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** A recorded frontmatter value: a string, a list of strings, or a block kept as text. */
function isFieldValue(v: unknown): boolean {
  if (typeof v === "string") return true;
  if (Array.isArray(v)) return v.every((x) => typeof x === "string");
  return isObject(v) && typeof v.block === "string";
}

/**
 * What in a manifest scaffold cannot read, or null. A file whose JSON does
 * not parse, or whose root is not an object, is no manifest at all (read as
 * none, as before); one that is an object must hold what scaffold reads.
 */
function manifestProblem(m: Record<string, unknown>): string | null {
  if (!isObject(m.files)) return "files is not an object";
  for (const [p, e] of Object.entries(m.files)) {
    if (!isObject(e) || typeof e.hash !== "string") return `files[${JSON.stringify(p)}] is not an entry with a hash`;
  }
  if (m.fields === undefined) return null;
  if (!isObject(m.fields)) return "fields is not an object";
  for (const [p, entry] of Object.entries(m.fields)) {
    if (!isObject(entry)) return `fields[${JSON.stringify(p)}] is not an object`;
    for (const [k, v] of Object.entries(entry)) {
      if (!isFieldValue(v)) return `fields[${JSON.stringify(p)}].${k} is not a frontmatter value`;
    }
  }
  return null;
}

/** The manifest at `rel`, checked; null when there is none (or it is not JSON, as before). */
function readChecked(basePath: string, rel: string): ScaffoldManifest | null {
  const m = readJson(join(basePath, rel));
  if (!isObject(m)) return null;
  const problem = manifestProblem(m);
  if (problem) throw new InvalidManifestError(rel, problem);
  return m;
}

/**
 * Read an existing scaffold manifest from disk.
 * Returns `null` if the manifest does not exist or cannot be parsed.
 *
 * With `source` (the .at file name), returns only that topology's manifest:
 * two topologies scaffolded into one project used to share one manifest, so
 * the second treated the first one's files as its own — overwriting its
 * crontab and, with --prune, deleting its scripts.
 *
 * Throws {@link InvalidManifestError} for this topology's manifest when it is
 * a JSON object that does not hold what scaffold reads.
 */
export function readManifest(
  basePath: string,
  target: string,
  source?: string,
): ScaffoldManifest | null {
  const sharedRel = getManifestPath(target);
  const shared = readJson(join(basePath, sharedRel));
  if (!source) return readChecked(basePath, sharedRel);
  const ownRel = perSourcePath(target, source);
  const own = readChecked(basePath, ownRel);
  if (own) return own;
  // The shared manifest is checked only when it is this topology's.
  return isObject(shared) && shared.source === source ? readChecked(basePath, sharedRel) : null;
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
