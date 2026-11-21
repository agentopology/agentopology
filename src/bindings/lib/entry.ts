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
 * What the claude-code binding writes to settings.json `agent`, and the
 * declared agent it names. The one rule the binding, V134, the gate wiring
 * and guard --check all read:
 *
 * - `extensions { claude-code { agent } }` (a string) is the more specific:
 *   written as is when it names no declared node (a plugin's agent, say: no
 *   node id), or when it names a declared agent Claude Code can start.
 * - When it names a declared node Claude Code cannot start, it is not
 *   written, and the entry is (if valid).
 * - Else the entry, when V134 accepts it, under the name its agent file
 *   carries.
 */
export function settingsAgent(ast: TopologyAST): { value: string; nodeId?: string } | undefined {
  const ext = extensionAgent(ast);
  if (ext !== undefined) {
    const node = nodeForAgentName(ast, ext);
    if (!node) return { value: ext };
    if (!agentProblem(node)) return { value: ext, nodeId: node.id };
  }
  const entry = ast.topology.entry;
  if (entry !== undefined && !entryProblem(ast)) {
    const node = ast.nodes.find((n) => n.id === entry) as AgentNode;
    return { value: agentFileName(node), nodeId: entry };
  }
  return undefined;
}

/**
 * The node id of the agent the Claude Code session runs as, from what the
 * binding writes (settingsAgent). Undefined when nothing is written or the
 * value names no declared agent.
 */
export function sessionAgentId(ast: TopologyAST): string | undefined {
  return settingsAgent(ast)?.nodeId;
}

/**
 * The declared agent a settings.json `agent` value on disk names, when
 * Claude Code can start it as the session; else undefined.
 */
export function sessionAgentFromFile(ast: TopologyAST, value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  const node = nodeForAgentName(ast, value);
  return node && !agentProblem(node) ? node.id : undefined;
}

/** True when a tools list lets the agent start other agents (Agent, Agent(...), or the older Task). */
export function toolsCanStartAgents(tools: string[]): boolean {
  return tools.some((t) => /^(Agent|Task)(\(|$)/.test(t.trim()));
}
