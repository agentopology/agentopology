/**
 * A repo's own tool (`tools { tool <id> { ... } }`) on Claude Code.
 *
 * Claude Code's subagent `tools:` field takes tool names ("a comma-separated
 * string such as `Read, Grep, Bash`"), MCP entries (`mcp__github__*`) and
 * `Agent(type)` (code.claude.com/docs/en/sub-agents). A repo tool's id is none
 * of these, so it is never written there. A tool with a `command:` or a
 * `script:` is a Bash call: the agent gets `Bash`, and settings.json gets the
 * permission allow rule that runs the call without a prompt. `Bash(npm test *)`
 * matches `npm test` and `npm test <args>` ("A `*` at the end, with a space
 * before it, also matches the bare command", code.claude.com/docs/en/permissions).
 * A tool with neither compiles to nothing (V130 warns).
 *
 * One place, read by the binding (agent tools, skill allowed-tools,
 * settings.json) and by the validator (V14, V130).
 */

import type { ToolBlockDef, TopologyAST } from "../../parser/ast.js";
import { isProjectPath, runParts } from "../../parser/run.js";

/** The repo tool an agent or skill entry names, or undefined when the entry is not a declared tool. */
export function repoTool(ast: Pick<TopologyAST, "toolDefs">, entry: string): ToolBlockDef | undefined {
  return (ast.toolDefs ?? []).find((t) => t.id === entry);
}

/**
 * The path Claude Code runs a tool's script at, as the claude-code binding
 * writes its stub: a project path as written (without `./`), an absolute path
 * as is, a bare name or `scripts/...` in the topology skill's scripts folder.
 */
export function toolScriptPath(ast: Pick<TopologyAST, "topology">, tool: ToolBlockDef): string | null {
  if (!tool.script) return null;
  const script = runParts(tool.script).script;
  if (!script) return null;
  if (script.startsWith("/")) return script;
  if (isProjectPath(script)) return script.replace(/^\.\//, "");
  return `.claude/skills/${ast.topology.name}/scripts/${script.replace(/^.*\//, "")}`;
}

/**
 * The script paths whose allow rule the binding writes: every tool allowed by
 * its script (a script and no command). The generator never widens: an allow
 * rule on a file the agent could rewrite would run anything without a prompt,
 * so these paths are protected the way a gate's ledger is (lib/guards.ts:
 * before-edit.sh refuses an edit of one, before-action.sh a Bash write to it),
 * and the claude-code binding writes that protection whenever it writes the rule.
 */
export function protectedToolScriptPaths(ast: Pick<TopologyAST, "toolDefs" | "topology">): string[] {
  const paths: string[] = [];
  for (const t of ast.toolDefs ?? []) {
    if (t.command) continue;
    const p = toolScriptPath(ast, t);
    if (p && !paths.includes(p)) paths.push(p);
  }
  return paths;
}

/**
 * The permission rule that allows a tool's call, or null when the tool has
 * neither a command nor a script. A command wins over a script. A command that
 * already holds a `*` is a pattern and is written as is. A script's rule comes
 * with its protection (protectedToolScriptPaths).
 */
export function toolAllowRule(ast: Pick<TopologyAST, "topology">, tool: ToolBlockDef): string | null {
  if (tool.command) return tool.command.includes("*") ? `Bash(${tool.command})` : `Bash(${tool.command} *)`;
  const path = toolScriptPath(ast, tool);
  if (!path) return null;
  const parts = runParts(tool.script);
  const head = [parts.interpreter, ...(parts.flags ?? [])].filter(Boolean).join(" ");
  return `Bash(${head ? `${head} ${path}` : path} *)`;
}

/**
 * An agent's `tools:` with each repo tool compiled: a tool with a command or
 * a script becomes `Bash` (added once, where the first such tool stood, unless
 * the list already has `Bash`); a tool with neither is left out. When that
 * leaves nothing, the list is kept as written: an empty `tools:` would give the
 * agent every tool, and the agent must not get more than it asked for.
 */
export function compileAgentTools(ast: Pick<TopologyAST, "toolDefs" | "topology">, tools: string[], other: (t: string) => string): string[] {
  const out: string[] = [];
  const hasBash = tools.includes("Bash");
  for (const t of tools) {
    const tool = repoTool(ast, t);
    if (!tool) { out.push(other(t)); continue; }
    if (toolAllowRule(ast, tool) && !hasBash && !out.includes("Bash")) out.push("Bash");
  }
  return out.length > 0 ? out : tools.map(other);
}

/** A skill's (or an inline agent's) `allowed-tools:` with each repo tool compiled to its allow rule; a tool with neither is left out. */
export function compileAllowedTools(ast: Pick<TopologyAST, "toolDefs" | "topology">, tools: string[], other: (t: string) => string): string[] {
  const out: string[] = [];
  for (const t of tools) {
    const tool = repoTool(ast, t);
    const rule = tool ? toolAllowRule(ast, tool) : other(t);
    if (rule && !out.includes(rule)) out.push(rule);
  }
  return out;
}

/** The settings.json allow rules for every declared tool with a command or a script, in declaration order. */
export function toolAllowRules(ast: Pick<TopologyAST, "toolDefs" | "topology">): string[] {
  const rules: string[] = [];
  for (const t of ast.toolDefs ?? []) {
    const r = toolAllowRule(ast, t);
    if (r && !rules.includes(r)) rules.push(r);
  }
  return rules;
}
