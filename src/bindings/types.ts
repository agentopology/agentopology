/**
 * Binding system type definitions.
 *
 * A binding transforms a parsed {@link TopologyAST} into a set of files
 * targeting a specific AI coding tool (Claude Code, Codex, Gemini CLI, etc.).
 *
 * @module
 */

import type { TopologyAST } from "../parser/ast.js";

/** A file to be written to disk by a binding's scaffold function. */
export interface GeneratedFile {
  /** Relative path from the project root (e.g. ".claude/agents/planner/AGENT.md"). */
  path: string;
  /** Full file content. */
  content: string;
}

/** A binding target that can scaffold project structure from a TopologyAST. */
export interface BindingTarget {
  /** Machine-readable name (e.g. "claude-code", "codex", "gemini-cli"). */
  name: string;
  /** Human-readable description of the target platform. */
  description: string;
  /** Generate all files for the target platform from a parsed topology. */
  scaffold(ast: TopologyAST): GeneratedFile[];
}
