/**
 * The entry agent (`meta { entry: <agent-id> }`): the agent every session
 * starts as. Claude Code's settings.json `agent` key does this: "Start every
 * session as a named subagent with its prompt, tools, and model"
 * (code.claude.com/docs/en/settings-reference, `agent`), and "To make it the
 * default for every session in a project, set `agent` in
 * `.claude/settings.json`" (code.claude.com/docs/en/sub-agents). Claude Code
 * resolves the key by the agent file's frontmatter `name`.
 *
 * So the entry must be a subagent the claude-code binding writes as
 * `.claude/agents/<id>/AGENT.md`. One source of truth for V134, the binding,
 * the gate wiring and guard --check.
 *
 * This module imports nothing from guards.ts (guards.ts imports it).
 *
 * @module
 */

import type { AgentNode, NodeDef, TopologyAST } from "../../parser/ast.js";
import { isWorkflowSeamAgent } from "./seam.js";

/** One node id: no spaces, brackets or commas. */
const ONE_ID = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

const SUBAGENT_ONLY = "Claude Code starts a session only as a subagent (the settings.json agent key)";

/** "a" or "an" before a node type word. */
function article(word: string): string {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}

/**
 * Why Claude Code cannot start this declared node as its main thread, or
 * null when it can. The text completes `"<id>" ...`.
 */
export function agentProblem(node: NodeDef): string | null {
  if (node.type !== "agent") return `is ${article(node.type)} ${node.type}, not an agent; ${SUBAGENT_ONLY}`;
  const agent = node as AgentNode;
  if (agent.runs === "inline" || agent.runs === "fork") {
    return `has runs: ${agent.runs}, so it is written as a skill, not a subagent; ${SUBAGENT_ONLY}`;
  }
  if (isWorkflowSeamAgent(agent)) {
    return `is marked execution: workflow, so the workflow script runs it and no .claude/agents file is written for it; ${SUBAGENT_ONLY}`;
  }
  return null;
}

/**
 * Why Claude Code cannot start the declared entry as its main thread, or null
 * when it can (or no entry is declared). The text completes
 * `meta entry "<id>" ...`.
 */
export function entryProblem(ast: TopologyAST): string | null {
  const id = ast.topology.entry;
  if (id === undefined) return null;
  if (!ONE_ID.test(id)) return "is not one agent id; write entry: <agent-id>";
  const node = ast.nodes.find((n) => n.id === id);
  if (!node) return "is not a declared node";
  return agentProblem(node);
}

/**
 * The `name` the claude-code binding writes into this agent's file: its
 * `extensions { claude-code { name } }` when set, else its id. Claude Code
 * resolves the settings.json `agent` key by this name.
 */
export function agentFileName(agent: AgentNode): string {
  const name = agent.extensions?.["claude-code"]?.name;
  return typeof name === "string" && name !== "" ? name : agent.id;
}

/** The declared node a settings `agent` value names: by node id, or by an agent's file name. */
export function nodeForAgentName(ast: TopologyAST, value: string): NodeDef | undefined {
  return ast.nodes.find((n) => n.id === value)
    ?? ast.nodes.find((n) => n.type === "agent" && agentFileName(n as AgentNode) === value);
}

/** The `extensions { claude-code { agent } }` value, when it is a string. */
export function extensionAgent(ast: TopologyAST): string | undefined {
  const v = ast.extensions?.["claude-code"]?.agent;
  return typeof v === "string" ? v : undefined;
}

/**
 * The node id of the agent the Claude Code session runs as, given what the
 * claude-code binding writes to settings.json `agent`: the extension's value
 * when it names a declared agent Claude Code can start, else the entry when
 * it is one. Undefined when neither is (an unknown extension value names an
 * agent the topology does not declare, such as a plugin's).
 */
export function sessionAgentId(ast: TopologyAST): string | undefined {
  const ext = extensionAgent(ast);
  if (ext !== undefined) {
    const node = nodeForAgentName(ast, ext);
    return node && !agentProblem(node) ? node.id : undefined;
  }
  if (ast.topology.entry !== undefined && !entryProblem(ast)) return ast.topology.entry;
  return undefined;
}

/** True when a tools list lets the agent start other agents (Agent, Agent(...), or the older Task). */
export function toolsCanStartAgents(tools: string[]): boolean {
  return tools.some((t) => /^(Agent|Task)(\(|$)/.test(t.trim()));
}
