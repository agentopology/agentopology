/**
 * Mermaid exporter — converts a TopologyAST into a Mermaid flowchart diagram.
 *
 * Produces a `.mmd` file with proper node shapes, edge labels, and styling
 * per node type.
 *
 * @module
 */

import type { TopologyAST, NodeDef, EdgeDef, AgentNode } from "../parser/ast.js";
import type { GeneratedFile } from "../bindings/types.js";
import type { Exporter } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Sanitize a node ID for Mermaid (no hyphens allowed in IDs). */
function mermaidId(id: string): string {
  return id.replace(/-/g, "_");
}

/** Escape special Mermaid characters in label text. */
function escapeLabel(text: string): string {
  return text.replace(/"/g, "#quot;");
}

/** Build the display label for a node. */
function nodeLabel(node: NodeDef): string {
  const parts: string[] = [node.id];

  if (node.type === "agent") {
    const agent = node as AgentNode;
    if (agent.model) parts.push(`Model: ${agent.model}`);
    if (agent.phase != null) parts.push(`Phase: ${agent.phase}`);
  } else if (node.type === "orchestrator") {
    parts.push(`Model: ${node.model}`);
  }

  return escapeLabel(parts.join("<br/>"));
}

/**
 * Wrap a label in the correct Mermaid shape delimiters per node type.
 *
 * - orchestrator: stadium shape (([...]))
 * - agent: rounded rect ([...])
 * - action: subroutine ([[...]])
 * - gate: diamond {...}
 * - human: hexagon {{...}}
 * - group: trapezoid [/...\]
 */
function nodeShape(id: string, label: string, type: string): string {
  const mid = mermaidId(id);
  switch (type) {
    case "orchestrator": return `${mid}(["${label}"])`;
    case "agent":        return `${mid}["${label}"]`;
    case "action":       return `${mid}[["${label}"]]`;
    case "gate":         return `${mid}{"${label}"}`;
    case "human":        return `${mid}{{"${label}"}}`;
    case "group":        return `${mid}[/"${label}"\\]`;
    default:             return `${mid}["${label}"]`;
  }
}

/** Build the edge label string from an EdgeDef. */
function edgeAnnotation(edge: EdgeDef): string {
  const parts: string[] = [];
  if (edge.condition) parts.push(edge.condition);
  if (edge.maxIterations) parts.push(`max ${edge.maxIterations}`);
  if (edge.race) parts.push("race");
  if (edge.tolerance != null) parts.push(`tolerance: ${edge.tolerance}`);
  if (edge.wait) parts.push(`wait ${edge.wait}`);
  if (edge.weight != null) parts.push(`weight ${edge.weight}`);
  if (edge.isError) {
    parts.unshift(edge.errorType ? `error: ${edge.errorType}` : "error");
  }
  if (edge.reflection) parts.push("reflection");
  return parts.length > 0 ? escapeLabel(parts.join(", ")) : "";
}

// ---------------------------------------------------------------------------
// Mermaid generation
// ---------------------------------------------------------------------------

function generateMermaid(ast: TopologyAST): string {
  const lines: string[] = [];

  // Header
  lines.push(`%% ${ast.topology.name} v${ast.topology.version}`);
  if (ast.topology.description) {
    lines.push(`%% ${ast.topology.description}`);
  }
  lines.push("");
  lines.push("flowchart TD");

  // Style classes
  lines.push("    classDef orchestrator fill:#6366F1,stroke:#4F46E5,color:#fff,stroke-width:2px");
  lines.push("    classDef agent fill:#3B82F6,stroke:#2563EB,color:#fff,stroke-width:2px");
  lines.push("    classDef action fill:#8B5CF6,stroke:#7C3AED,color:#fff,stroke-width:2px");
  lines.push("    classDef gate fill:#F59E0B,stroke:#D97706,color:#fff,stroke-width:2px");
  lines.push("    classDef human fill:#10B981,stroke:#059669,color:#fff,stroke-width:2px");
  lines.push("    classDef group fill:#EC4899,stroke:#DB2777,color:#fff,stroke-width:2px");
  lines.push("");

  // Group nodes by phase for subgraphs
  const agents = ast.nodes.filter((n): n is AgentNode => n.type === "agent");
  const phases = new Map<number, AgentNode[]>();
  for (const agent of agents) {
    const phase = agent.phase ?? 0;
    if (!phases.has(phase)) phases.set(phase, []);
    phases.get(phase)!.push(agent);
  }

  const nonAgentNodes = ast.nodes.filter((n) => n.type !== "agent");

  // Render non-agent nodes first
  for (const node of nonAgentNodes) {
    const label = nodeLabel(node);
    lines.push(`    ${nodeShape(node.id, label, node.type)}:::${node.type}`);
  }

  // Render agents grouped by phase
  if (phases.size > 0) {
    const sortedPhases = [...phases.entries()].sort((a, b) => a[0] - b[0]);
    for (const [phase, phaseAgents] of sortedPhases) {
      lines.push("");
      lines.push(`    subgraph Phase_${String(phase).replace(".", "_")}["Phase ${phase}"]`);
      for (const agent of phaseAgents) {
        const label = nodeLabel(agent);
        lines.push(`        ${nodeShape(agent.id, label, "agent")}:::agent`);
      }
      lines.push("    end");
    }
  }

  // Render edges
  lines.push("");
  for (const edge of ast.edges) {
    const from = mermaidId(edge.from);
    const to = mermaidId(edge.to);
    const annotation = edgeAnnotation(edge);
    const arrowStyle = edge.isError ? "-.->" : "-->";

    if (annotation) {
      lines.push(`    ${from} ${arrowStyle}|"${annotation}"| ${to}`);
    } else {
      lines.push(`    ${from} ${arrowStyle} ${to}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Export function
// ---------------------------------------------------------------------------

function exportMermaid(ast: TopologyAST): GeneratedFile[] {
  const mermaidContent = generateMermaid(ast);
  const stem = ast.topology.name;

  return [{ path: `${stem}.mmd`, content: mermaidContent }];
}

// ---------------------------------------------------------------------------
// Exporter instance
// ---------------------------------------------------------------------------

export const mermaidExporter: Exporter = {
  name: "mermaid",
  description: "Mermaid flowchart diagram — visual topology graph",
  extension: ".mmd",
  export: exportMermaid,
};
