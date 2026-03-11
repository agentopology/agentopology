/**
 * OpenAI Codex CLI binding (stub).
 *
 * Codex CLI uses a `.codex/` directory structure. This stub provides the
 * skeleton — each section has TODO comments explaining what needs to be mapped.
 *
 * @module
 */

import type { TopologyAST, AgentNode } from "../parser/ast.js";
import type { BindingTarget, GeneratedFile } from "./types.js";

/** Convert a kebab-case id to Title Case. */
function toTitle(id: string): string {
  return id
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** OpenAI Codex CLI binding. */
export const codexBinding: BindingTarget = {
  name: "codex",
  description: "OpenAI Codex CLI — generates .codex/ directory structure.",

  scaffold(ast: TopologyAST): GeneratedFile[] {
    const files: GeneratedFile[] = [];

    // --- Agent files ---
    // TODO: Map agent model names to OpenAI model identifiers (e.g. "opus" -> "gpt-4o")
    // TODO: Map permissions to Codex approval modes
    // TODO: Map tools to Codex tool configuration format
    for (const node of ast.nodes) {
      if (node.type !== "agent") continue;
      const agent = node as AgentNode;

      const lines: string[] = [];
      lines.push(`# ${toTitle(agent.id)} Agent`);
      lines.push("");
      if (agent.role) {
        lines.push(`Role: ${agent.role}`);
        lines.push("");
      }
      // TODO: Add Codex-specific agent configuration
      // TODO: Map agent.tools to Codex tool allowlist format
      // TODO: Map agent.permissions to Codex sandbox/approval mode
      lines.push(`Model: ${agent.model ?? "gpt-4o"}`);
      lines.push("");

      files.push({
        path: `.codex/agents/${agent.id}.md`,
        content: lines.join("\n"),
      });
    }

    // --- Config ---
    // TODO: Map settings (allow/deny/ask) to Codex approval policy
    // TODO: Map hooks to Codex event handlers (if supported)
    // TODO: Map mcp-servers to Codex tool server configuration
    // TODO: Map metering configuration to Codex cost tracking
    const config: Record<string, unknown> = {
      // TODO: Map topology.name and version
      name: ast.topology.name,
      version: ast.topology.version,
      // TODO: Map agent models to OpenAI model identifiers
      // TODO: Map flow to Codex orchestration config (if supported)
      // TODO: Map triggers to Codex command patterns
    };

    files.push({
      path: ".codex/config.json",
      content: JSON.stringify(config, null, 2) + "\n",
    });

    return files;
  },
};
