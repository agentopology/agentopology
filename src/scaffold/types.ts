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
  /**
   * `.claude/settings.json` only: the permission rules (`"<list> <rule>"`)
   * last named as not declared by the .at: a set that gains a rule is listed
   * in full, any other run with undeclared rules prints one summary line.
   * Optional; a missing or malformed value counts as none.
   */
  undeclaredRulesNamed?: string[];
  /**
   * A settings file only: the hook groups this scaffold wrote, as
   * "<event>\0<group key>" (P-1). The next scaffold treats exactly these as
   * the topology's, so a hook the .at changed replaces its entry and a user's
   * hook on the same script is kept. Optional; older manifests have none.
   */
  hookKeys?: string[];
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
  | { type: "create"; path: string; content: string; executable?: boolean }
  | { type: "update"; path: string; content: string; detail: string; executable?: boolean }
  | { type: "delete"; path: string }
  | { type: "unchanged"; path: string }
  | { type: "conflict"; path: string; content: string; detail: string }
  /**
   * Never written or deleted, even with --force. `unsafe` marks a path that
   * must abort the whole run before anything is written (an empty or
   * malformed file name — the EISDIR class).
   */
  | { type: "blocked"; path: string; detail: string; unsafe?: boolean }
  /** A create-only file already there: the user's. Never written or claimed. */
  | { type: "kept"; path: string; detail: string };
