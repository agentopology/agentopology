/**
 * A repo's own tool (`tools { tool <id> { ... } }`) on Claude Code.
 *
 * Claude Code's subagent `tools:` field takes tool names ("a comma-separated
 * string such as `Read, Grep, Bash`"), MCP entries (`mcp__github__*`) and
 * `Agent(type)` (code.claude.com/docs/en/sub-agents). A repo tool's id is none
 * of these, so it is never written there. A tool with a `command:` or a
 * `script:` is a Bash call: the agent gets `Bash`.
 *
 * Only a `command:` tool also gets a permission allow rule, which runs the
 * call without a prompt: `Bash(npm test *)` matches `npm test` and
 * `npm test <args>` ("A `*` at the end, with a space before it, also matches
 * the bare command", code.claude.com/docs/en/permissions). A `script:` tool
 * gets no rule and prompts as Bash does: the agent can edit the script, so an
 * allow rule on it would let it run anything without a prompt, and the
 * generator never widens a capability. A tool with neither compiles to nothing
 * (V130 warns).
 *
 * One place, read by the binding (agent tools, skill allowed-tools,
 * settings.json) and by the validator (V14, V130).
 */

import type { ToolBlockDef, TopologyAST } from "../../parser/ast.js";

/** The repo tool an agent or skill entry names, or undefined when the entry is not a declared tool. */
export function repoTool(ast: Pick<TopologyAST, "toolDefs">, entry: string): ToolBlockDef | undefined {
  return (ast.toolDefs ?? []).find((t) => t.id === entry);
}

/** A tool with a command or a script runs through Bash; one with neither compiles to nothing. */
export function runsThroughBash(tool: ToolBlockDef): boolean {
  return !!tool.command || !!tool.script.trim();
}

/**
 * The permission rule that allows a tool's call without a prompt: only a
 * command tool has one (a script tool's script is editable, so a rule on it
 * would widen). A command that already holds a `*` is a pattern and is
 * written as is.
 */
export function toolAllowRule(tool: ToolBlockDef): string | null {
  if (!tool.command) return null;
  return tool.command.includes("*") ? `Bash(${tool.command})` : `Bash(${tool.command} *)`;
}

/**
 * An agent's `tools:` with each repo tool compiled: a tool with a command or
 * a script becomes `Bash` (added once, where the first such tool stood, unless
 * the list already has `Bash`); a tool with neither is left out. When that
 * leaves nothing, the list is kept as written: an empty `tools:` would give the
 * agent every tool, and the agent must not get more than it asked for.
 */
export function compileAgentTools(ast: Pick<TopologyAST, "toolDefs">, tools: string[], other: (t: string) => string): string[] {
  const out: string[] = [];
  const hasBash = tools.includes("Bash");
  for (const t of tools) {
    const tool = repoTool(ast, t);
    if (!tool) { out.push(other(t)); continue; }
    if (runsThroughBash(tool) && !hasBash && !out.includes("Bash")) out.push("Bash");
  }
  return out.length > 0 ? out : tools.map(other);
}

/**
 * A skill's (or an inline agent's) `allowed-tools:` with each repo tool
 * compiled: a command tool becomes its allow rule; a script tool or one with
 * neither is left out (allowed-tools pre-approves, and a script tool is not
 * pre-approved).
 */
export function compileAllowedTools(ast: Pick<TopologyAST, "toolDefs">, tools: string[], other: (t: string) => string): string[] {
  const out: string[] = [];
  for (const t of tools) {
    const tool = repoTool(ast, t);
    const rule = tool ? toolAllowRule(tool) : other(t);
    if (rule && !out.includes(rule)) out.push(rule);
  }
  return out;
}

/** The settings.json allow rules for every declared command tool, in declaration order. */
export function toolAllowRules(ast: Pick<TopologyAST, "toolDefs">): string[] {
  const rules: string[] = [];
  for (const t of ast.toolDefs ?? []) {
    const r = toolAllowRule(t);
    if (r && !rules.includes(r)) rules.push(r);
  }
  return rules;
}
