/**
 * Hybrid seam — the SINGLE SOURCE OF TRUTH shared by the `claude-workflow` and
 * `claude-code` bindings so they cannot silently drift.
 *
 * The hybrid model: a topology compiles to a claude-code HOST (.claude/ — agents,
 * hooks, Blackboard, the event-driven layer) PLUS embedded deterministic Workflow
 * rungs (the phases marked `execution: workflow`). The two bindings must agree on:
 *   - the seam namespace + the `execution: workflow` marker
 *   - the generated artifact filenames (workflow.js, SEAM/README/LOSSY docs)
 *   - the Blackboard workspace root
 * Both bindings import from here; neither hardcodes these independently.
 *
 * @module
 */

import type { AgentNode, TopologyAST } from "../../parser/ast.js";

/** The extensions namespace carrying the hybrid seam marker. */
export const SEAM_NS = "claude-workflow";

/** An agent is owned by the embedded Workflow rung when marked `execution: workflow`. */
export function isWorkflowSeamAgent(agent: AgentNode): boolean {
  const ext = agent.extensions?.[SEAM_NS];
  return !!ext && (ext as Record<string, unknown>).execution === "workflow";
}

/** True when the topology has at least one `execution: workflow` agent (i.e. it is a hybrid). */
export function isHybridTopology(ast: TopologyAST): boolean {
  return ast.nodes.some((n) => n.type === "agent" && isWorkflowSeamAgent(n as AgentNode));
}

/** Canonical generated-artifact filenames. Both bindings derive names ONLY from here. */
export const seamFiles = {
  /** The embedded deterministic Workflow rung (emitted by claude-workflow). */
  workflowScript: (name: string) => `${name}.workflow.js`,
  /** The Blackboard hand-off contract both sides honor. */
  seamDoc: (name: string) => `${name}-SEAM.md`,
  /** The human-split / downstream-handoff doc. */
  readmeDoc: (name: string) => `${name}-README.md`,
  /** The fail-loud translation-loss report. */
  lossyDoc: (name: string) => `${name}-LOSSY-REPORT.md`,
};

/** The Blackboard root path (shared substrate), or null when the topology declares no workspace. */
export function workspaceRoot(ast: TopologyAST): string | null {
  const ws = (ast.memory as Record<string, unknown> | undefined)?.workspace as
    | { path?: string }
    | undefined;
  return ws?.path ?? null;
}
