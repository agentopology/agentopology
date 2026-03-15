/**
 * Types for the incremental scaffold system.
 *
 * The scaffold manifest tracks generated files so re-scaffolding can
 * intelligently merge, overwrite, or preserve content on disk.
 *
 * @module
 */

/** A single entry in the scaffold manifest. */
export interface ManifestEntry {
  /** SHA-256 hash of the file content at generation time. */
  hash: string;
  /** Merge category that determines how the file is handled on re-scaffold. */
  category: "machine" | "agent" | "script" | "shared-config";
}

/** Manifest written to disk after each scaffold run. */
export interface ScaffoldManifest {
  /** Source .at file name. */
  source: string;
  /** SHA-256 hash of the source .at file at generation time. */
  sourceHash: string;
  /** Target binding name (e.g. "claude-code"). */
  target: string;
  /** ISO 8601 timestamp of when the scaffold was generated. */
  generatedAt: string;
  /** Map of relative file paths to their manifest entries. */
  files: Record<string, ManifestEntry>;
}

/** An action to perform on a single file during incremental scaffold. */
export type FileAction =
  | { type: "create"; path: string; content: string }
  | { type: "update"; path: string; content: string; detail: string }
  | { type: "delete"; path: string }
  | { type: "unchanged"; path: string }
  | { type: "conflict"; path: string; content: string; detail: string };
