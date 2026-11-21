/**
 * The entry agent (`meta { entry: <agent-id> }`): the agent every session
 * starts as. Claude Code's settings.json `agent` key does this: "Start every
 * session as a named subagent with its prompt, tools, and model"
 * (code.claude.com/docs/en/settings-reference, `agent`), and "To make it the
 * default for every session in a project, set `agent` in
 * `.claude/settings.json`" (code.claude.com/docs/en/sub-agents).
 *
 * So the entry must be a subagent the claude-code binding writes as
 * `.claude/agents/<id>/AGENT.md`. One source of truth for V134 and the binding.
 *
 * @module
 */

import type { AgentNode, TopologyAST } from "../../parser/ast.js";
import { runsAsSkill } from "./guards.js";
import { isWorkflowSeamAgent } from "./seam.js";

/**
 * Why Claude Code cannot start the declared entry as its main thread, or null
 * when it can (or no entry is declared). The text completes
 * `meta entry "<id>" ...`.
 */
export function entryProblem(ast: TopologyAST): string | null {
  const id = ast.topology.entry;
  if (!id) return null;
  const node = ast.nodes.find((n) => n.id === id);
  if (!node) return "is not a declared node";
  if (node.type !== "agent") {
    return `is a ${node.type}, not an agent; Claude Code starts a session only as a subagent (the settings.json agent key)`;
  }
  const agent = node as AgentNode;
  if (runsAsSkill(agent)) {
    return `has runs: ${agent.runs}, so it is written as a skill, not a subagent; Claude Code starts a session only as a subagent (the settings.json agent key)`;
  }
  if (isWorkflowSeamAgent(agent)) {
    return "is marked execution: workflow, so the workflow script runs it and no .claude/agents file is written for it; Claude Code starts a session only as a subagent (the settings.json agent key)";
  }
  return null;
}
