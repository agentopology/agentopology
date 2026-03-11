/**
 * Google Gemini CLI binding (stub).
 *
 * Gemini CLI uses a `GEMINI.md` file and potentially a `.gemini/` directory.
 * This stub provides the skeleton with TODO comments for each mapping.
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

/** Google Gemini CLI binding. */
export const geminiCliBinding: BindingTarget = {
  name: "gemini-cli",
  description: "Google Gemini CLI — generates GEMINI.md and .gemini/ directory structure.",

  scaffold(ast: TopologyAST): GeneratedFile[] {
    const files: GeneratedFile[] = [];

    // --- Main GEMINI.md ---
    // TODO: Map orchestrator instructions to GEMINI.md system prompt
    // TODO: Map flow to Gemini task orchestration instructions
    // TODO: Map roles to agent persona descriptions
    const sections: string[] = [];
    sections.push(`# ${toTitle(ast.topology.name)}`);
    sections.push("");
    if (ast.topology.description) {
      sections.push(ast.topology.description);
      sections.push("");
    }

    // Agent summaries
    for (const node of ast.nodes) {
      if (node.type !== "agent") continue;
      const agent = node as AgentNode;
      sections.push(`## ${toTitle(agent.id)}`);
      if (agent.role) sections.push(agent.role);
      // TODO: Map agent.model to Gemini model identifiers (e.g. "opus" -> "gemini-2.5-pro")
      // TODO: Map agent.tools to Gemini tool configuration
      // TODO: Map agent.permissions to Gemini sandbox settings
      sections.push("");
    }

    files.push({
      path: "GEMINI.md",
      content: sections.join("\n"),
    });

    // --- .gemini/ directory ---
    // TODO: Map settings (allow/deny) to .gemini/settings.json
    // TODO: Map hooks to Gemini event handlers (if supported)
    // TODO: Map mcp-servers to Gemini tool server configuration
    // TODO: Map triggers to Gemini command patterns
    // TODO: Map metering to Gemini cost tracking (if supported)
    // TODO: Map memory configuration to Gemini context/retrieval setup

    const config: Record<string, unknown> = {
      name: ast.topology.name,
      version: ast.topology.version,
      // TODO: Map agent definitions to Gemini agent config
      // TODO: Map flow edges to Gemini orchestration rules
      // TODO: Map skills to Gemini capability definitions
    };

    files.push({
      path: ".gemini/config.json",
      content: JSON.stringify(config, null, 2) + "\n",
    });

    return files;
  },
};
