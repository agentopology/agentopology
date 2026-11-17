/**
 * Types for the incremental scaffold system.
 *
 * The scaffold manifest tracks generated files so re-scaffolding can
 * intelligently merge, overwrite, or preserve content on disk.
 *
 * @module
 */

import type { FieldValue } from "./frontmatter-patch.js";

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
   * A file with prompt markers: the hash of its frontmatter block (`head`)
   * and of its body outside the prompt (`outside`), each as scaffold last
   * wrote or found it. They tell an edit of the prompt (the generated
   * sections stay scaffold's) from an edit of the rest (the body is the
   * user's). Optional; an entry from before them compares each region with
   * what the .at generates.
   */
  head?: string;
  outside?: string;
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
  /**
   * Per agent, skill and command file: the frontmatter value scaffold last
   * applied (or found equal) for each key the .at owns. The base of the
   * three-way rule: a key the file changed since is the file's. Optional; a
   * manifest from before it has no base, and the .at value then wins.
   */
  fields?: Record<string, Record<string, FieldValue>>;
}

/** An action to perform on a single file during incremental scaffold. */
export type FileAction =
  | { type: "create"; path: string; content: string; executable?: boolean }
  /** `notes`: lines to print about the file (a settings file: each user hook command kept). */
  | { type: "update"; path: string; content: string; detail: string; executable?: boolean; notes?: string[] }
  | { type: "delete"; path: string }
  | { type: "unchanged"; path: string; notes?: string[] }
  | { type: "conflict"; path: string; content: string; detail: string }
  /**
   * Never written or deleted, even with --force. `unsafe` marks a path that
   * must abort the whole run before anything is written (an empty or
   * malformed file name — the EISDIR class).
   */
  | { type: "blocked"; path: string; detail: string; unsafe?: boolean; key?: string }
  /** A create-only file already there: the user's. Never written or claimed. */
  | { type: "kept"; path: string; detail: string }
  /**
   * An agent, skill or command file that is the user's (hand-written, or
   * scaffolded and then edited): only frontmatter keys the .at owns change,
   * the body never. `content` is null when no byte changes. Never claimed.
   */
  | {
      type: "patch";
      path: string;
      content: string | null;
      /** One line per key written: `model sonnet → haiku`. */
      changes: string[];
      /** Keys kept as the file has them: drift, conflicts, released keys. */
      notes: string[];
      /** The base to record for this file. */
      fields: Record<string, FieldValue>;
      /** One row per owned key that is not in sync (the drift report). */
      rows?: DriftRow[];
      /** A scaffolded agent file whose body is the user's: what of the .at's could not reach it. */
      body?: string;
    };

/** A key where the .at and an agent, skill or command file disagree. */
export interface DriftRow {
  path: string;
  /** `settings`: a settings.json value (its key dotted; `at` and `file` as JSON text). */
  kind: "agent" | "skill" | "command" | "settings";
  id: string;
  /** null for a file whose frontmatter could not be read (`blocked`) when no one key is to blame. */
  key: string | null;
  /**
   * `at-ahead`: the .at changed it (or nothing was recorded); scaffold writes it.
   * `file-ahead`: the file changed a value scaffold applied; kept.
   * `conflict`: both changed; kept. `at-removed`: the .at stopped stating it
   * and the file holds what was applied; scaffold removes it. `released`: the
   * .at stopped stating it and the file changed it; kept. `blocked`: the
   * frontmatter cannot be read safely. `kept`: a settings.json value the
   * file holds otherwise; the merge never replaces it, --force included. With
   * `key` null, `kept` is a scaffolded agent file whose body is the user's
   * and holds generated sections the .at changed (`detail` names them).
   */
  state: "at-ahead" | "file-ahead" | "conflict" | "at-removed" | "released" | "blocked" | "kept";
  at: FieldValue | null;
  file: FieldValue | null;
  base: FieldValue | null;
  detail?: string;
}
