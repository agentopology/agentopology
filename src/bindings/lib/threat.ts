/**
 * The threat model's plain facts: which inputs are untrusted, what counts as a
 * path glob or a permission rule, which tools a rule covers. No script text
 * here, so the validator and the guards can both import it.
 *
 * @module
 */

import type { TopologyAST } from "../../parser/ast.js";

/** The shell tools: a `Bash(...)` rule covers all three, as before-action.sh's hook does. */
export const SHELL_TOOLS = ["Bash", "Monitor", "PowerShell"] as const;
/** The tools a `Read(...)` rule is checked on (Claude Code applies Read rules to Grep and Glob as well). */
export const READ_TOOLS = ["Read", "Grep", "Glob"] as const;
/** The tools an `Edit(...)` rule is checked on. */
export const EDIT_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"] as const;

/**
 * Every untrusted entry of the topology: the `threat-model { untrusted }`
 * list, then each MCP server written `trust: untrusted` as `mcp:<id>`, with no
 * entry twice.
 */
export function untrustedEntries(ast: Pick<TopologyAST, "threatModel" | "mcpServers">): string[] {
  const out = [...(ast.threatModel?.untrusted ?? [])];
  for (const [id, server] of Object.entries(ast.mcpServers ?? {})) {
    if (server.trust === "untrusted" && !out.includes(`mcp:${id}`)) out.push(`mcp:${id}`);
  }
  return out;
}

/** True when the topology marks sessions: something is untrusted. */
export function threatModelActive(ast: Pick<TopologyAST, "threatModel" | "mcpServers">): boolean {
  return untrustedEntries(ast).length > 0;
}

/** A quoted path glob: names a path (a `/`, a `*` or a `.`), has no line break or quote. */
export function isPathGlob(entry: string): boolean {
  return /[/*.]/.test(entry) && !/[\n"]/.test(entry) && entry !== "web" && !entry.startsWith("mcp:");
}

/**
 * A permission rule as `settings { deny }` writes it: a tool name (letters,
 * digits, `_ . : - *`), then an optional `(specifier)`. Prose with a space
 * before the parenthesis or no parenthesis is not one.
 */
const PERMISSION_RULE = /^[A-Za-z_][A-Za-z0-9_.:*-]*(?:\([^\n]*\))?$/;
export function isPermissionRule(rule: string): boolean {
  return PERMISSION_RULE.test(rule);
}

/** Split a permission rule into its tool and specifier (`Bash(git push *)` → Bash, `git push *`). */
export function splitRule(rule: string): { head: string; spec?: string } {
  const open = rule.indexOf("(");
  if (open === -1) return { head: rule };
  return { head: rule.slice(0, open), spec: rule.slice(open + 1, rule.endsWith(")") ? -1 : undefined) };
}

/** A sandbox entry that names a path (not a command): absolute, under home, a folder, or a glob. */
export function isSandboxPath(entry: string): boolean {
  return entry.startsWith("/") || entry.startsWith("~") || entry.endsWith("/") || entry.includes("*");
}
