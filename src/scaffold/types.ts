/**
 * Types for the incremental scaffold system.
 *
 * The scaffold manifest tracks generated files so re-scaffolding can
 * intelligently merge, overwrite, or preserve content on disk.
 *
 * @module
 */

import type { RuleOwnership } from "./ownership.js";

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
   * `.claude/settings.json` only (T6): the rules this topology added, per
   * list. Only these are ever removed, when the .at no longer declares them.
   * Missing or malformed: owns nothing.
   */
  rulesOwned?: { allow?: string[]; ask?: string[]; deny?: string[] };
  /** `.claude/settings.json` only (T6): the `permissions.defaultMode` this topology wrote. */
  defaultModeOwned?: string;
  /**
   * `.claude/settings.json` only (OWN2): the rules this topology's .at declares.
   * Another topology never removes a rule listed here. An entry without it
   * (written before it) holds every other topology's removals.
   */
  rulesDeclared?: { allow?: string[]; ask?: string[]; deny?: string[] };
  /** `.claude/settings.json` only (OWN2): the `default-mode` the .at declares. */
  defaultModeDeclared?: string;
  /** `.claude/settings.json` only (OWN3): the .at path, relative to the project, that owns this entry's rules. */
  sourcePath?: string;
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
  | { type: "create"; path: string; content: string; executable?: boolean; rules?: RuleOwnership }
  | { type: "update"; path: string; content: string; detail: string; executable?: boolean; rules?: RuleOwnership }
  | { type: "delete"; path: string }
  | { type: "unchanged"; path: string; rules?: RuleOwnership }
  | { type: "conflict"; path: string; content: string; detail: string }
  /**
   * Never written or deleted, even with --force. `unsafe` marks a path that
   * must abort the whole run before anything is written (an empty or
   * malformed file name — the EISDIR class).
   */
  | { type: "blocked"; path: string; detail: string; unsafe?: boolean; rules?: RuleOwnership }
  /** A create-only file already there: the user's. Never written or claimed. */
  | { type: "kept"; path: string; detail: string; rules?: RuleOwnership };
