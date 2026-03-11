/**
 * GitHub Copilot CLI binding (stub).
 *
 * Copilot uses `.github/copilot-instructions.md` and agent definitions in
 * `.github/agents/`. This stub provides the skeleton with TODO comments.
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

/** GitHub Copilot CLI binding. */
export const copilotCliBinding: BindingTarget = {
  name: "copilot-cli",
  description:
    "GitHub Copilot CLI — generates .github/copilot-instructions.md and agent files.",

  scaffold(ast: TopologyAST): GeneratedFile[] {
    const files: GeneratedFile[] = [];

    // --- Main instructions file ---
    // TODO: Map orchestrator config to Copilot system instructions
    // TODO: Map flow to task orchestration instructions
    // TODO: Map roles to persona descriptions in instructions
    const sections: string[] = [];
    sections.push(`# ${toTitle(ast.topology.name)}`);
    sections.push("");
    if (ast.topology.description) {
      sections.push(ast.topology.description);
      sections.push("");
    }
    sections.push("## Agents");
    sections.push("");

    for (const node of ast.nodes) {
      if (node.type !== "agent") continue;
      const agent = node as AgentNode;
      sections.push(`### ${toTitle(agent.id)}`);
      if (agent.role) sections.push(agent.role);
      // TODO: Map agent.model to Copilot model config
      // TODO: Map agent.tools to Copilot tool allowlist
      // TODO: Map agent.permissions to Copilot permission model
      sections.push("");
    }

    files.push({
      path: ".github/copilot-instructions.md",
      content: sections.join("\n"),
    });

    // --- Agent files ---
    // TODO: Determine if Copilot supports per-agent config files
    // TODO: Map agent skills to Copilot agent capabilities
    // TODO: Map triggers to Copilot slash command definitions
    // TODO: Map hooks to Copilot event handlers (if supported)
    // TODO: Map mcp-servers to Copilot tool server config (if supported)
    // TODO: Map settings (allow/deny) to Copilot permission settings
    // TODO: Map metering to Copilot usage tracking (if supported)
    // TODO: Map memory configuration to Copilot context management

    return files;
  },
};
