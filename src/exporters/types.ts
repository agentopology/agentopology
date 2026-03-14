/**
 * Exporter system type definitions.
 *
 * An exporter transforms a parsed {@link TopologyAST} into one or more output
 * files (Markdown documentation, Mermaid diagrams, etc.).
 *
 * @module
 */

import type { TopologyAST } from "../parser/ast.js";
import type { GeneratedFile } from "../bindings/types.js";

/** An exporter that transforms a TopologyAST into output files. */
export interface Exporter {
  /** Machine-readable name (e.g. "markdown", "mermaid"). */
  name: string;
  /** Human-readable description. */
  description: string;
  /** File extension for the primary output (e.g. ".md", ".mmd"). */
  extension: string;
  /** Generate output files from a parsed topology. */
  export(ast: TopologyAST): GeneratedFile[];
}
