/**
 * The block `context { file: ... }` writes into the project's context file
 * (CLAUDE.md for Claude Code): one stretch between two markers. Every line
 * outside the markers is the user's and is never touched.
 *
 * @module
 */

import type { TopologyAST } from "../../parser/ast.js";
import { settingsAgent } from "./entry.js";

export const CONTEXT_BEGIN = "<!-- agentopology:context:begin (generated; edit outside these markers) -->";
export const CONTEXT_END = "<!-- agentopology:context:end -->";

/** Where the block (markers included) starts and ends in a file, or null. */
export function contextSpan(content: string): { start: number; end: number } | null {
  const open = content.indexOf(CONTEXT_BEGIN);
  if (open === -1) return null;
  const close = content.indexOf(CONTEXT_END, open);
  if (close === -1) return null;
  return { start: open, end: close + CONTEXT_END.length };
}

/** The block for this topology, markers included, ending in a newline. */
export function contextBlock(ast: TopologyAST): string {
  const lines: string[] = [CONTEXT_BEGIN];
  const entry = settingsAgent(ast)?.value;
  if (entry) {
    lines.push(`Start every session as the \`${entry}\` agent (\`${ast.topology.name}\`).`);
    lines.push(`If no agent is named, start as ${entry}.`);
  }
  const includes = ast.context.includes ?? [];
  if (includes.length > 0) {
    lines.push("");
    for (const inc of includes) lines.push(`@${inc}`);
  }
  const glossary = ast.context.glossary ?? [];
  if (glossary.length > 0) {
    lines.push("");
    lines.push("Glossary:");
    for (const g of glossary) lines.push(`- ${g.term}: ${g.definition}`);
  }
  lines.push(CONTEXT_END);
  return lines.join("\n") + "\n";
}

/**
 * The file with the block in it: an existing block is replaced and every
 * other line kept as written; a file with no block gets it appended.
 */
export function mergeContextBlock(existing: string, block: string): string {
  const span = contextSpan(existing);
  const bare = block.replace(/\n$/, "");
  if (span) return existing.slice(0, span.start) + bare + existing.slice(span.end);
  if (existing === "") return block;
  const sep = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  return existing + sep + block;
}

/** Whether a path is a project CLAUDE.md-style file written through the block. */
export function contextFilePath(ast: TopologyAST): string | null {
  const f = ast.context.file;
  if (!f) return null;
  return f.replace(/^\.\//, "");
}
