/**
 * Binding system type definitions.
 *
 * A binding transforms a parsed {@link TopologyAST} into a set of files
 * targeting a specific AI coding tool (Claude Code, Codex, Gemini CLI, etc.).
 *
 * @module
 */

import type { TopologyAST } from "../parser/ast.js";
import type { StubKind } from "./lib/stub.js";

/** A file to be written to disk by a binding's scaffold function. */
export interface GeneratedFile {
  /** Relative path from the project root (e.g. ".claude/agents/planner/AGENT.md"). */
  path: string;
  /** Full file content. */
  content: string;
  /** Merge category for incremental scaffold. Defaults to "machine". */
  category?: "machine" | "agent" | "script" | "shared-config";
  /**
   * When true, the file should be written with executable permission (chmod +x).
   * Used for generated shell script stubs.
   */
  executable?: boolean;
  /**
   * Write only when nothing is at this path. For a stub at a path the user
   * named (a hook's own script): if a file is there it is the user's, and
   * scaffold never overwrites or claims it — not even with --force.
   */
  createOnly?: boolean;
  /**
   * A stub for a script the user writes (a hook's or gate's `run:`), wherever
   * it lives. Once a file is there, scaffold replaces it only while it is
   * exactly what scaffold last wrote; a script the user wrote is never
   * overwritten, not even with --force. A file whose content carries the
   * stub marker is treated the same without this flag.
   */
  userScript?: boolean;
  /**
   * What this file stands in for when it is a stub (its content carries the
   * stub marker): set by the generator that decided to write a stub, read by
   * the stub count validate and scaffold print (src/scaffold/stubs.ts).
   */
  stub?: StubKind;
}

/**
 * Deduplicate generated files by path — when two generators emit the same path,
 * keep the one with the longer content (the more complete version).
 */
export function deduplicateFiles(files: GeneratedFile[]): GeneratedFile[] {
  const seen = new Map<string, GeneratedFile>();
  for (const file of files) {
    const existing = seen.get(file.path);
    if (!existing || file.content.length > existing.content.length) {
      seen.set(file.path, file);
    }
  }
  return Array.from(seen.values());
}

/**
 * A binding refuses a topology it cannot compile honestly (for example a
 * Claude model name on Codex). The CLI prints the message and exits 1;
 * nothing is written.
 */
export class BindingRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BindingRefusal";
  }
}

/** A binding target that can scaffold project structure from a TopologyAST. */
export interface BindingTarget {
  /** Machine-readable name (e.g. "claude-code", "codex"). */
  name: string;
  /** Human-readable description of the target platform. */
  description: string;
  /**
   * Not a supported target: kept, but not verified against the platform the way
   * claude-code is. `targets` labels it and scaffold warns.
   */
  experimental?: boolean;
  /** Generate all files for the target platform from a parsed topology. */
  scaffold(ast: TopologyAST): GeneratedFile[];
  /**
   * The same files, plus the structure the .at states for each agent, skill
   * and command file: what scaffold patches into a file that already exists
   * instead of replacing it.
   */
  scaffoldStructured?(ast: TopologyAST): { files: GeneratedFile[]; structure: StructureSpec[] };
}

/**
 * The structure the .at owns in one agent, skill or command file: the
 * frontmatter keys it states. The file owns everything else (its body and
 * every key the .at does not state).
 */
export interface StructureSpec {
  /** Where the file is: the `file:` path for a hand-written node, else the generated path. */
  path: string;
  kind: "agent" | "skill" | "command";
  /** The node's id (a command's name). */
  id: string;
  /** The file the .at implies; its frontmatter holds the owned values in the binding's style. */
  content: string;
  /** The frontmatter keys the .at states for this node. */
  owned: string[];
  /** A `file:` node: the file is the author's, so only its frontmatter is ever written. */
  authored: boolean;
  /** Keys whose absence means this value (an agent with no model runs on `inherit`). */
  defaults?: Record<string, string>;
}
