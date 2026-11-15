/**
 * Types for the incremental scaffold system.
 *
 * The scaffold manifest tracks generated files so re-scaffolding can
 * intelligently merge, overwrite, or preserve content on disk.
 *
 * @module
 */

/** Permission rule strings per list, as settings.json holds them. */
export type PermissionRules = Partial<Record<"allow" | "ask" | "deny", string[]>>;

/** A single entry in the scaffold manifest. */
export interface ManifestEntry {
  /** SHA-256 hash of the file content at generation time. */
  hash: string;
  /** Merge category that determines how the file is handled on re-scaffold. */
  category: "machine" | "agent" | "script" | "shared-config";
  /**
   * settings.json only: the permission rules this topology wrote and owns.
   * A re-scaffold removes an owned rule the .at no longer declares and never
   * touches any other rule. Absent in a manifest from 0.11.1 or earlier: the
   * next run then owns what the .at generates at that point and removes nothing.
   */
  permissions?: PermissionRules;
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
  | { type: "create"; path: string; content: string; executable?: boolean; permissions?: PermissionRules }
  | { type: "update"; path: string; content: string; detail: string; executable?: boolean; permissions?: PermissionRules }
  | { type: "delete"; path: string }
  | { type: "unchanged"; path: string; permissions?: PermissionRules }
  | { type: "conflict"; path: string; content: string; detail: string }
  /**
   * Never written or deleted, even with --force. `unsafe` marks a path that
   * must abort the whole run before anything is written (an empty or
   * malformed file name — the EISDIR class).
   */
  | { type: "blocked"; path: string; detail: string; unsafe?: boolean }
  /** A create-only file already there: the user's. Never written or claimed. */
  | { type: "kept"; path: string; detail: string };
