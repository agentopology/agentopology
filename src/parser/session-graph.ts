/**
 * Who the session agents are and who may talk to whom. Shared by the validator
 * (V113 - V118) and the claude-code binding's session files, so the two never
 * disagree about what counts as a talk edge.
 *
 * @module
 */

import type { AgentNode, EdgeDef, TopologyAST } from "./ast.js";

/** Agents declared `runs: session`. */
export function sessionAgentsOf(ast: TopologyAST): AgentNode[] {
  return ast.nodes.filter((n): n is AgentNode => n.type === "agent" && (n as AgentNode).runs === "session");
}

/** Talk edges: flow edges with a session agent at both ends. */
export function talkEdgesOf(ast: TopologyAST): EdgeDef[] {
  const ids = new Set(sessionAgentsOf(ast).map((a) => a.id));
  return ast.edges.filter((e) => !e.isError && ids.has(e.from) && ids.has(e.to));
}
