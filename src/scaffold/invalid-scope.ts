/**
 * What `scaffold --allow-invalid` may write while validation errors are open.
 *
 * Each error is attributed to the node it names. A file is written only when
 * an agent with no error owns it: its agent file (or the file its `file:`
 * names, patched as usual), its skill when it runs as one, and its own hook
 * scripts. Every other file is shared by the topology (settings.json,
 * settings.local.json, .mcp.json, .codex/hooks.json, the topology skill,
 * rules, gate and hook scripts) and waits until the topology validates: a
 * half-built guard set is worse than none (a missing deny, or a hook entry
 * pointing at a script that was not written).
 *
 * An error naming no node, or a name that cannot be traced to agents (the
 * orchestrator, which reaches every agent; an undeclared name), is topology
 * level: nothing is written at all.
 *
 * Unknown paths default to "not written", so a binding that adds a file this
 * map does not know only ever writes less.
 */

import type { AgentNode, GateNode, GroupNode, TopologyAST } from "../parser/ast.js";
import type { ValidationResult } from "../parser/validator.js";
import { isShellCommand, scriptNameFromRun } from "../parser/run.js";
import { runsAsSkill } from "../bindings/lib/guards.js";
import type { FileAction } from "./types.js";

/** The config files never written while an error is open (named so the report can say so). */
export const GUARD_CONFIG_FILES = [".claude/settings.json", ".claude/settings.local.json", ".mcp.json", ".codex/hooks.json"];

/** The reason printed for a file of the topology as a whole. */
export const WHILE_ERRORS_OPEN = "not written while validation errors are open";

export interface InvalidScope {
  /** Errors that cannot be scoped to agents: when any, nothing is written. */
  topologyLevel: ValidationResult[];
  /** Agents with an error attributed to them. */
  erroredAgents: Set<string>;
}

const asList = (v: string | string[] | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const norm = (p: string): string => p.replace(/\\/g, "/").replace(/^(\.\/)+/, "");

/** Attribute every error to the agents it reaches. */
export function scopeErrors(ast: TopologyAST, errors: ValidationResult[]): InvalidScope {
  const agents = ast.nodes.filter((n): n is AgentNode => n.type === "agent");
  const agentIds = new Set(agents.map((a) => a.id));
  const otherNodes = new Map(ast.nodes.filter((n) => n.type !== "agent" && n.type !== "orchestrator").map((n) => [n.id, n]));
  const topologyHooks = new Set((ast.hooks ?? []).map((h) => h.name));
  const skills = new Set((ast.skills ?? []).map((s) => s.id));
  const triggers = new Set((ast.triggers ?? []).map((t) => t.name));

  /** The agents an error naming `name` reaches; null when it cannot be scoped. */
  const reach = (name: string): string[] | null => {
    if (agentIds.has(name)) return [name];
    const dot = name.indexOf(".");
    if (dot > 0 && agentIds.has(name.slice(0, dot))) return [name.slice(0, dot)];
    const hookOwners = agents.filter((a) => (a.hooks ?? []).some((h) => h.name === name)).map((a) => a.id);
    if (hookOwners.length > 0) return hookOwners;
    const node = otherNodes.get(name);
    if (node?.type === "gate") {
      const g = node as GateNode;
      return [...asList(g.after), ...asList(g.before)].filter((id) => agentIds.has(id));
    }
    if (node?.type === "group") return (node as GroupNode).members.filter((id) => agentIds.has(id));
    if (node) return []; // an action or another node: its files are shared, never written while errors are open
    if (skills.has(name)) return agents.filter((a) => (a.skills ?? []).includes(name)).map((a) => a.id);
    if (topologyHooks.has(name) || triggers.has(name)) return [];
    return null;
  };

  const topologyLevel: ValidationResult[] = [];
  const erroredAgents = new Set<string>();
  for (const e of errors) {
    const reached = e.node ? reach(e.node) : null;
    if (reached === null) topologyLevel.push(e);
    else for (const id of reached) erroredAgents.add(id);
  }
  return { topologyLevel, erroredAgents };
}

/** path -> the agent that owns it, for the files a binding writes per agent. */
export function agentOwnedPaths(ast: TopologyAST, target: string): Map<string, string> {
  const owned = new Map<string, string>();
  const topology = ast.topology.name;
  for (const node of ast.nodes) {
    if (node.type !== "agent") continue;
    const agent = node as AgentNode;
    const own = (p: string) => owned.set(norm(p), agent.id);
    if (agent.file) own(agent.file);
    if (target === "claude-code") {
      own(`.claude/agents/${agent.id}/AGENT.md`);
      own(`.claude/agents/${agent.id}.md`);
      if (runsAsSkill(agent)) own(`.claude/skills/${agent.id}/SKILL.md`);
      for (const hook of agent.hooks ?? []) {
        if (!hook.run || isShellCommand(hook.run)) continue;
        const script = scriptNameFromRun(hook.run);
        if (script) own(`.claude/skills/${topology}/scripts/${agent.id}-${script}`);
      }
    } else if (target === "codex") {
      own(`.codex/agents/${agent.id}.toml`);
    } else if (target === "cursor") {
      own(`.cursor/rules/${agent.id}.mdc`);
    }
  }
  return owned;
}

/** True when the action would change the disk. */
function writes(action: FileAction, prune: boolean): boolean {
  switch (action.type) {
    case "create":
    case "update":
    case "conflict": // replaced with --force, kept without it: either way reported as not written
      return true;
    case "patch":
      return action.content !== null;
    case "delete":
      return prune;
    default:
      return false;
  }
}

/**
 * The plan with every write the errors touch turned into a skip (`blocked`,
 * so it is printed as `⊘ path (reason)` and never executed).
 */
export function scopePlan(
  actions: FileAction[],
  owners: Map<string, string>,
  erroredAgents: Set<string>,
  prune: boolean,
): { actions: FileAction[]; skipped: string[] } {
  const skipped: string[] = [];
  const out = actions.map((action): FileAction => {
    if (!writes(action, prune)) return action;
    const owner = owners.get(norm(action.path));
    if (owner !== undefined && !erroredAgents.has(owner)) return action;
    skipped.push(action.path);
    const detail = owner !== undefined ? `not written: node ${owner} has validation errors` : WHILE_ERRORS_OPEN;
    return { type: "blocked", path: action.path, detail };
  });
  return { actions: out, skipped };
}
