/**
 * V130-V135 (S-19): checks of the permission rules a topology declares, on
 * `settings { }` and on agents. They read the declaration only: what a rule
 * says, against the tools, agents and modes the same .at declares.
 *
 * Every platform fact is quoted from the Claude Code docs (permissions,
 * permission modes, settings reference); spec/validation.md names the lines.
 *
 * Numbering: the S-19 spec calls these V134-V139. They are V130-V135 on this
 * branch because rule numbers must be contiguous (spec-sync.test.ts), and they
 * become V134-V139 if the branch holding V130-V133 merges first.
 *
 * @module
 */

import type { AgentNode, TopologyAST } from "./ast.js";
import type { ValidationResult } from "./validator.js";
import {
  EDIT_TOOLS,
  KNOWN_TOOLS,
  PATH_TOOLS,
  COMMAND_TOOLS,
  globMatches,
  matchesWholeTool,
  paramName,
  parsePermissionRule,
  type PermissionRule,
} from "./permission-rule.js";

type List = "allow" | "ask" | "deny";
const LISTS: readonly List[] = ["allow", "ask", "deny"];

/** One rule where it is written: the topology's settings, or an agent. */
interface Placed {
  rule: PermissionRule;
  list: List;
  /** The agent the rule is written on; null for `settings`. */
  agent: AgentNode | null;
}

const isAgent = (n: { type: string }): n is AgentNode => n.type === "agent";
const lineOf = (ast: TopologyAST, id: string) => (ast as { _sourceMap?: Record<string, number> })._sourceMap?.[id];
const where = (p: Placed) => (p.agent ? `agent "${p.agent.id}" ${p.list}` : `settings ${p.list}`);

function placed(ast: TopologyAST): Placed[] {
  const out: Placed[] = [];
  for (const list of LISTS) {
    for (const raw of ast.settings?.[list] ?? []) out.push({ rule: parsePermissionRule(raw), list, agent: null });
  }
  for (const n of ast.nodes) {
    if (!isAgent(n)) continue;
    for (const list of LISTS) for (const raw of n[list] ?? []) out.push({ rule: parsePermissionRule(raw), list, agent: n });
  }
  return out;
}

function result(ast: TopologyAST, rule: string, level: "error" | "warning", p: Placed | null, message: string, nodeId?: string): ValidationResult {
  const node = nodeId ?? p?.agent?.id;
  return { rule, level, message, ...(node ? { node, line: lineOf(ast, node) } : {}) };
}

// ---------------------------------------------------------------------------
// V130: malformed
// ---------------------------------------------------------------------------

/** The values `permissions.defaultMode` takes (settings reference). */
export const DEFAULT_MODES = ["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions", "manual"];

/**
 * V130 (spec V134): a rule that is not `Tool` or `Tool(specifier)`, or a
 * `default-mode` that is not a mode Claude Code has.
 */
export function v130PermissionRuleForm(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  for (const p of placed(ast)) {
    for (const why of p.rule.problems) {
      results.push(result(ast, "V130", "error", p,
        `${where(p)} "${p.rule.raw}" is not a permission rule: ${why}. ` +
        `"Permission rules follow the format \`Tool\` or \`Tool(specifier)\`"; the language adds mcp.<server>.<tool>.`));
    }
  }
  const mode = ast.settings?.defaultMode;
  if (mode !== undefined && !DEFAULT_MODES.includes(mode)) {
    results.push(result(ast, "V130", "error", null, `settings default-mode: ${mode} is not a permission mode. It must be one of ${DEFAULT_MODES.join(", ")}.`));
  }
  return results;
}

// ---------------------------------------------------------------------------
// V131: rules Claude Code skips or never matches
// ---------------------------------------------------------------------------

/** Each tool's primary content field, which a param rule cannot match. */
const PRIMARY_FIELD: Record<string, string> = {
  Bash: "command", PowerShell: "command", Read: "file_path", Edit: "file_path", Write: "file_path",
  Grep: "path", Glob: "path", NotebookEdit: "notebook_path", WebFetch: "url",
};

/** An allow glob is anchored when it starts with a literal `mcp__<server>__`. */
function anchoredAllowGlob(tool: string): boolean {
  if (!tool.startsWith("mcp__")) return false;
  const rest = tool.slice(5);
  const end = rest.indexOf("__");
  return end > 0 && !rest.slice(0, end).includes("*");
}

function skipReason(p: Placed): string | null {
  const { rule, list } = p;
  const { tool, specifier } = rule;
  if (tool.startsWith("mcp__") && specifier !== undefined) {
    return `"When Claude Code loads a settings file, it skips any \`mcp__\` rule that has parentheses."` +
      (list === "allow" ? ` For an allow rule on an MCP tool with a specifier, "the rule doesn't match any call."` : "");
  }
  const param = paramName(rule);
  if (rule.form === "param" && param && PRIMARY_FIELD[tool] === param) {
    return `${param} is ${tool}'s primary field: "A rule like \`Bash(command:rm *)\` would be bypassable by a compound command, so Claude Code ignores it and emits a startup warning."`;
  }
  if (rule.form === "param" && list === "allow") {
    return `a parameter rule works only as deny or ask: "allow rules continue to use each tool's own specifier syntax."`;
  }
  if (PATH_TOOLS.has(tool) && tool !== "Read" && tool !== "Edit" && specifier !== undefined && specifier !== "*" && rule.form === "path") {
    const use = tool === "Glob" || tool === "Grep" ? "Read" : "Edit";
    return `Claude Code "accepts a rule with a path other than \`*\` for one of the tools below but doesn't match a read, search, or edit against it." Write ${use}(${specifier}) instead.`;
  }
  if (list === "allow" && tool.includes("*") && !anchoredAllowGlob(tool)) {
    return `"An unanchored allow glob such as \`"*"\`, \`"B*"\`, or \`"mcp__*"\` is skipped and doesn't auto-approve anything."`;
  }
  if (COMMAND_TOOLS.has(tool) && specifier?.includes(":*") && !specifier.endsWith(":*")) {
    return `"The \`:*\` form is only recognized at the end of a pattern." Elsewhere the colon is a literal character.`;
  }
  return null;
}

/** V131 (spec V135): a rule Claude Code skips or never matches. */
export function v131PermissionRuleSkipped(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  for (const p of placed(ast)) {
    if (p.rule.problems.length) continue;
    const why = skipReason(p);
    if (why) results.push(result(ast, "V131", "error", p, `${where(p)} "${p.rule.raw}" never takes effect: ${why}`));
  }
  return results;
}

// ---------------------------------------------------------------------------
// V132: a deny makes a declared tool unusable, or a rule is dead
// ---------------------------------------------------------------------------

/** The tool names an agent declares, as Claude Code names them. */
function declaredTools(agent: AgentNode): string[] {
  return (agent.tools ?? []).map((t) => parsePermissionRule(t).tool);
}

/** Agents a flow edge names: the subagents the topology invokes. */
function flowAgents(ast: TopologyAST): Set<string> {
  const ids = new Set<string>();
  const agents = new Map(ast.nodes.filter(isAgent).map((a) => [a.id, a]));
  for (const e of ast.edges) {
    for (const id of [e.from, e.to]) {
      const a = agents.get(id);
      if (a && (a.runs === undefined || a.runs === "subagent")) ids.add(id);
    }
  }
  return ids;
}

/** Whether an agent-level rule can apply to a call this agent makes. */
function agentHasRuleTool(agent: AgentNode, rule: PermissionRule): boolean {
  if (!agent.tools?.length) return !(agent.disallowedTools ?? []).includes(rule.tool);
  const tools = declaredTools(agent);
  if (tools.includes(rule.tool)) return true;
  // "`Edit` rules apply to all built-in tools that edit files." Read rules are
  // applied, best effort, to Grep and Glob.
  if (rule.tool === "Edit") return tools.some((t) => EDIT_TOOLS.has(t));
  if (rule.tool === "Read") return tools.some((t) => t === "Grep" || t === "Glob");
  return false;
}

/** How to keep a tool and still deny part of it. */
function scopeHint(tool: string): string {
  if (EDIT_TOOLS.has(tool)) return `Scope the deny to a path, for example "Edit(/src/**)" (Edit rules cover ${tool}),`;
  if (tool === "Read" || tool === "Grep" || tool === "Glob") return `Scope the deny to a path, for example "Read(./secrets/**)",`;
  if (COMMAND_TOOLS.has(tool)) return `Scope the deny to commands, for example "${tool}(rm *)",`;
  return "Scope the rule";
}

/** V132 (spec V136): a deny makes a declared tool unusable, or a rule is dead. */
export function v132PermissionToolUnusable(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const rules = placed(ast).filter((p) => !p.rule.problems.length);
  const agents = ast.nodes.filter(isAgent);

  for (const agent of agents) {
    const tools = declaredTools(agent);
    if (!tools.length) continue;
    for (const p of rules) {
      if (p.list !== "deny" || (p.agent && p.agent !== agent)) continue;
      const { rule } = p;
      const glob = rule.specifier === undefined && rule.tool.includes("*");
      if (glob) {
        for (const t of tools.filter((t) => globMatches(rule.tool, t))) {
          results.push(result(ast, "V132", "warning", p,
            `agent "${agent.id}" lists "${t}" in tools, but ${where(p)} "${rule.raw}" removes it: "A tool matched by a bare-name glob deny rule is removed from Claude's context, the same as a bare tool name." Scope the rule or drop the tool.`, agent.id));
        }
        continue;
      }
      if (!matchesWholeTool(rule)) continue;
      if (tools.includes(rule.tool)) {
        results.push(result(ast, "V132", "warning", p,
          `agent "${agent.id}" lists "${rule.tool}" in tools, but ${where(p)} "${rule.raw}" removes it: "A bare tool name like \`Bash\` removes the tool from Claude's context entirely, so Claude never sees it." ` +
          `${scopeHint(rule.tool)} or drop the tool from tools.`, agent.id));
      }
      if (rule.tool === "Edit") {
        for (const t of tools.filter((t) => t !== "Edit" && EDIT_TOOLS.has(t))) {
          results.push(result(ast, "V132", "warning", p,
            `agent "${agent.id}" lists "${t}" in tools, but ${where(p)} "${rule.raw}" denies every file edit: "\`Edit\` rules apply to all built-in tools that edit files." Scope the rule to a path, for example "Edit(/src/**)".`, agent.id));
        }
      }
    }
  }

  const invoked = flowAgents(ast);
  for (const p of rules) {
    if (p.agent || p.list !== "deny" || p.rule.form !== "agent") continue;
    const target = p.rule.specifier!.trim();
    if (invoked.has(target)) {
      results.push(result(ast, "V132", "warning", p,
        `settings deny "${p.rule.raw}" stops Claude from using subagent "${target}", which the flow invokes: "Use \`Agent(AgentName)\` rules to control which subagents Claude can use."`, target));
    }
  }

  for (const p of rules) {
    if (!p.agent || p.rule.form === "glob" || p.rule.form === "mcp" || p.rule.tool.includes("*")) continue;
    if (!agentHasRuleTool(p.agent, p.rule)) {
      const has = p.agent.tools?.length ? `tools: ${p.agent.tools.join(", ")}` : `disallowed-tools: ${(p.agent.disallowedTools ?? []).join(", ")}`;
      results.push(result(ast, "V132", "warning", p,
        `${where(p)} "${p.rule.raw}" names ${p.rule.tool}, which agent "${p.agent.id}" does not have (${has}); the rule never applies.`));
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// V133: a rule another rule in the same .at always decides first
// ---------------------------------------------------------------------------

const ORDER = `"Rules are evaluated in order: deny, then ask, then allow."`;

/** A command pattern, `:*` written as its equivalent trailing ` *`. */
const normCommand = (s: string) => (s.endsWith(":*") ? s.slice(0, -2) + " *" : s);

/** Whether deny/ask rule `d` matches every call allow rule `a` matches. */
function covers(d: PermissionRule, a: PermissionRule): boolean {
  if (d.specifier === undefined && d.tool.includes("*")) return globMatches(d.tool, a.tool);
  if (d.tool !== a.tool) return false;
  if (matchesWholeTool(d)) return true;
  if (d.specifier === a.specifier) return true;
  if (d.form !== "command" || a.form !== "command" || a.specifier === undefined) return false;
  const ds = normCommand(d.specifier!);
  if (ds.indexOf("*") !== ds.length - 1) return false; // only a trailing wildcard is a plain prefix
  const prefix = ds.slice(0, -1);
  const as = normCommand(a.specifier);
  const literal = as.includes("*") ? as.slice(0, as.indexOf("*")) : as;
  return literal.startsWith(prefix);
}

/** V133 (spec V137): the same rule in two lists, or an allow a deny or ask always covers. */
export function v133PermissionRuleShadowed(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const rules = placed(ast).filter((p) => !p.rule.problems.length);
  const key = (r: PermissionRule) => r.tool + (r.specifier === undefined ? "" : `(${r.specifier})`);

  // The same rule in two lists of one owner.
  const owners = new Map<AgentNode | null, Placed[]>();
  for (const p of rules) owners.set(p.agent, [...(owners.get(p.agent) ?? []), p]);
  const dup = new Set<Placed>();
  for (const [, list] of owners) {
    const seen = new Map<string, Placed>();
    for (const l of ["deny", "ask", "allow"] as const) {
      for (const p of list.filter((x) => x.list === l)) {
        const first = seen.get(key(p.rule));
        if (first && first.list !== p.list) {
          dup.add(p);
          results.push(result(ast, "V133", "warning", p,
            `${where(p)} "${p.rule.raw}" is also in ${first.list}: ${ORDER} Only the ${first.list} rule takes effect; remove one.`));
        } else if (!first) seen.set(key(p.rule), p);
      }
    }
  }

  // An allow a deny or ask always decides first.
  for (const a of rules) {
    if (a.list !== "allow" || dup.has(a)) continue;
    const over = rules.find((d) => (d.list === "deny" || d.list === "ask") && (d.agent === null || d.agent === a.agent) && covers(d.rule, a.rule));
    if (!over) continue;
    const why = over.list === "deny"
      ? `"An allow rule can't carve an exception out of a deny rule."`
      : `"a matching ask rule prompts even when a more specific allow rule also matches the same call."`;
    results.push(result(ast, "V133", "warning", a,
      `${where(a)} "${a.rule.raw}" never applies: ${where(over)} "${over.rule.raw}" matches every call it matches. ${ORDER} ${why}`));
  }
  return results;
}

// ---------------------------------------------------------------------------
// V134: a mode makes a rule moot
// ---------------------------------------------------------------------------

/** The Claude Code mode an agent runs in, from `permission-mode:` or `permissions:`. */
function agentMode(a: AgentNode): string | undefined {
  if (a.permissionMode) return a.permissionMode;
  switch (a.permissions) {
    case "unrestricted": case "bypass": case "bypassPermissions": return "bypassPermissions";
    case "auto": return "auto";
    case "dontAsk": return "dontAsk";
    default: return undefined;
  }
}

/** An allow rule auto mode drops: blanket shell, wildcarded interpreter, Agent, Monitor. */
function droppedInAuto(r: PermissionRule): boolean {
  if (r.tool === "Bash" && matchesWholeTool(r)) return true;
  if (r.tool === "Bash" && r.form === "command" && /^(?:python\d*(?:\.\d+)?|node|ruby|perl|php|bash|sh|zsh)\s*\*/.test(r.specifier!)) return true;
  return r.tool === "Agent" || r.tool === "Monitor";
}

const BYPASS = `"Allow rules have no effect in \`bypassPermissions\`."`;
const AUTO = `"On entering auto mode, broad allow rules that grant arbitrary code execution are dropped"`;
const DONT_ASK = `"In \`dontAsk\` mode Claude Code denies a matching tool use instead of prompting."`;

/** V134 (spec V138): a permission mode the .at sets makes a rule it declares moot. */
export function v134PermissionModeMoot(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const rules = placed(ast).filter((p) => !p.rule.problems.length);
  const top = (l: List) => rules.filter((p) => p.agent === null && p.list === l);
  const own = (a: AgentNode, l: List) => rules.filter((p) => p.agent === a && p.list === l);
  const said = new Set<string>();
  const once = (k: string, r: ValidationResult) => { if (!said.has(k)) { said.add(k); results.push(r); } };
  const mode = ast.settings?.defaultMode;

  if (mode === "auto" || mode === "bypassPermissions") {
    results.push(result(ast, "V134", "warning", null,
      `settings default-mode: ${mode} is written to the project's .claude/settings.json, where it is ignored: "\`auto\` and \`bypassPermissions\` don't take effect from project or local settings, so set them in \`~/.claude/settings.json\` instead."`));
  }

  // Who runs in which mode: the topology default, then each agent's own.
  const scopes: Array<{ label: string; mode: string | undefined; rules: (l: List) => Placed[]; node?: string }> = [
    { label: `default-mode: ${mode}`, mode, rules: top },
    ...ast.nodes.filter(isAgent).map((a) => ({
      label: `agent "${a.id}" runs in ${agentMode(a)}`, mode: agentMode(a), node: a.id,
      rules: (l: List) => [...top(l), ...own(a, l)],
    })),
  ];
  for (const s of scopes) {
    if (s.mode === "bypassPermissions" && s.rules("allow").length) {
      const list = s.rules("allow").map((p) => `"${p.rule.raw}"`).join(", ");
      once(`bypass:${s.label}`, result(ast, "V134", "warning", null, `${s.label}, so the allow rules ${list} do nothing: ${BYPASS}`, s.node));
    }
    if (s.mode === "auto") {
      for (const p of s.rules("allow").filter((p) => droppedInAuto(p.rule))) {
        once(`auto:${s.node ?? ""}:${where(p)}:${p.rule.raw}`, result(ast, "V134", "warning", p,
          `${s.label}, so ${where(p)} "${p.rule.raw}" is dropped: ${AUTO} (blanket Bash, wildcarded interpreters, Agent and Monitor allow rules).`, s.node));
      }
    }
    if (s.mode === "dontAsk") {
      for (const p of s.rules("ask")) {
        once(`dontAsk:${s.node ?? ""}:${where(p)}:${p.rule.raw}`, result(ast, "V134", "warning", p,
          `${s.label}, so ${where(p)} "${p.rule.raw}" refuses instead of asking: ${DONT_ASK}`, s.node));
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// V135: suspect rules Claude Code warns about
// ---------------------------------------------------------------------------

/** V135 (spec V139): a `*` before the subcommand in an allow; a tool name no tool has. */
export function v135PermissionRuleSuspect(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  for (const p of placed(ast)) {
    const { rule } = p;
    if (rule.problems.length) continue;
    if (p.list === "allow" && COMMAND_TOOLS.has(rule.tool) && rule.form === "command" && /^\S+\s+\*\s+\S/.test(rule.specifier!)) {
      results.push(result(ast, "V135", "warning", p,
        `${where(p)} "${rule.raw}" has a \`*\` before the subcommand, so it allows far more than it reads: "Claude Code matches everything before the first \`*\` as written, so those words are what limit the rule". Claude Code warns at startup about this form. Put the \`*\` after the subcommand.`));
    }
    const name = rule.tool;
    if (rule.form === "mcp" || name.includes("_") || name.includes("*") || KNOWN_TOOLS.has(name)) continue;
    results.push(result(ast, "V135", "warning", p,
      `${where(p)} "${rule.raw}" names "${name}", which is not a tool name the Claude Code docs list. "Permission rules and hook matchers don't match the label"; use the tool's canonical name.` +
      (p.list === "allow" ? "" : ` "A deny or ask rule whose tool name matches no known tool produces a startup warning to catch typos."`)));
  }
  return results;
}
