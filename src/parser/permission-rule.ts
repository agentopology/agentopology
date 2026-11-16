/**
 * Permission rules, as written in `settings { allow ask deny }` and on an
 * agent. A rule string is the Claude Code syntax verbatim: "Permission rules
 * follow the format `Tool` or `Tool(specifier)`. Parentheses inside the
 * specifier are literal" (Claude Code permissions docs). The one form the
 * language adds is the dotted MCP name, `mcp.server.tool` / `mcp.server.*`.
 *
 * parsePermissionRule is pure: the AST keeps the raw strings, and validate
 * (V130-V135) and the bindings call this to read them.
 *
 * @module
 */

/** What a rule matches on. */
export type RuleForm =
  | "bare" // `Bash`: every use of the tool
  | "glob" // `*`, `B*`: a glob in the tool-name position
  | "command" // `Bash(npm run *)`: a command pattern
  | "path" // `Read(./.env)`: a gitignore-style path
  | "domain" // `WebFetch(domain:x.com)`
  | "param" // `Agent(model:opus)`: one top-level input parameter
  | "mcp" // `mcp__server__tool`, `mcp.server.*`
  | "agent" // `Agent(Explore)`: a subagent by name
  | "other"; // a specifier on a tool with no documented specifier form

export interface PermissionRule {
  /** The string as written in the .at. */
  raw: string;
  /** The tool name Claude Code matches (dotted MCP names converted). */
  tool: string;
  /** What is inside the parentheses, if any. */
  specifier?: string;
  form: RuleForm;
  /** Why the rule is malformed; empty when it is well formed (V130). */
  problems: string[];
}

/** Tools whose specifier is a command (`Bash(npm run *)`). */
export const COMMAND_TOOLS = new Set(["Bash", "PowerShell", "Monitor"]);
/** Tools whose specifier is a path. */
export const PATH_TOOLS = new Set(["Read", "Edit", "Write", "Glob", "Grep", "NotebookEdit", "MultiEdit"]);
/** Built-in tools that edit files: "`Edit` rules apply to all built-in tools that edit files." */
export const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);

/**
 * Input parameters of the command tools that a param rule can name. Only the
 * ones the permissions docs show (`command`, `Bash(run_in_background:true)`);
 * any other `word:rest` on Bash is read as a command pattern, as `Bash(ls:*)` is.
 */
const COMMAND_TOOL_PARAMS = new Set(["command", "run_in_background"]);

/**
 * The tool names the Claude Code docs in spec/claude-code name (permissions,
 * permission modes, subagents, settings). It is the list V135 checks a rule's
 * tool against. The docs' full tools reference is not in that set, so a real
 * tool missing here would warn; names holding `_` or `*` are exempt, as they
 * are in Claude Code. `TaskOutput` and `MultiEdit` are removed or legacy
 * tools the docs still name.
 */
export const KNOWN_TOOLS = new Set([
  "Agent", "Artifact", "AskUserQuestion", "Bash", "CronCreate", "CronDelete", "CronList",
  "Edit", "EndConversation", "EnterPlanMode", "EnterWorktree", "ExitPlanMode", "ExitWorktree",
  "Glob", "Grep", "ListAgents", "LSP", "Monitor", "MultiEdit", "NotebookEdit", "PowerShell",
  "Read", "ScheduleWakeup", "SendMessage", "Skill", "SubagentHandback", "TaskCreate", "TaskGet",
  "TaskList", "TaskOutput", "TaskStop", "TaskUpdate", "TodoWrite", "ToolSearch",
  "WaitForMcpServers", "WebFetch", "WebSearch", "Workflow", "Write",
]);

/** A tool name: letters, digits, `_`, `-` and `*` (a glob). */
const TOOL_NAME = /^[A-Za-z0-9_*-]+$/;
/** An MCP server name in the dotted form. */
const MCP_SEGMENT = /^[A-Za-z0-9_-]+$/;

/**
 * Convert the dotted MCP form to Claude Code's. `mcp.server` and `mcp.server.*`
 * mean every tool on the server; `mcp.server.tool` is one tool. Returns null
 * when the dotted form is not one of these.
 */
function dottedMcp(raw: string): string | null {
  const rest = raw.slice(4);
  const dot = rest.indexOf(".");
  const server = dot === -1 ? rest : rest.slice(0, dot);
  const tool = dot === -1 ? null : rest.slice(dot + 1);
  if (!MCP_SEGMENT.test(server)) return null;
  if (tool === null) return `mcp__${server}`;
  if (tool !== "*" && !/^[A-Za-z0-9_.*-]+$/.test(tool)) return null;
  return `mcp__${server}__${tool}`;
}

/** Read one rule string. Never throws; a malformed rule has `problems`. */
export function parsePermissionRule(raw: string): PermissionRule {
  const problems: string[] = [];
  const bad = (why: string): PermissionRule => ({ raw, tool: raw, form: "other", problems: [...problems, why] });

  if (raw.trim() === "") return bad("the rule is empty");
  // R13: a newline or a control character changes what a hook or a settings file reads.
  if (/[\u0000-\u001f\u007f]/.test(raw)) return bad("the rule holds a newline or a control character");
  if (raw !== raw.trim()) return bad("the rule has leading or trailing spaces");

  if (raw.startsWith("mcp.")) {
    if (raw.includes("(")) return bad("a dotted mcp. name takes no specifier");
    const tool = dottedMcp(raw);
    if (!tool) return bad("not mcp.<server>, mcp.<server>.* or mcp.<server>.<tool>");
    return { raw, tool, form: "mcp", problems };
  }

  const open = raw.indexOf("(");
  if (open === -1) {
    if (raw.includes(")")) return bad("a closing parenthesis with no opening one");
    if (!TOOL_NAME.test(raw)) return bad("the tool name holds characters a tool name cannot (a transcript label is not the tool's name)");
    const form: RuleForm = raw.startsWith("mcp__") ? "mcp" : raw.includes("*") ? "glob" : "bare";
    return { raw, tool: raw, form, problems };
  }

  const tool = raw.slice(0, open);
  if (tool === "") return bad("no tool name before the parenthesis");
  if (!TOOL_NAME.test(tool)) return bad("the tool name holds characters a tool name cannot");
  if (!raw.endsWith(")")) return bad("the specifier is not closed by a final parenthesis");
  const specifier = raw.slice(open + 1, -1);
  if (specifier === "") return bad("the parentheses are empty");

  return { raw, tool, specifier, form: specifierForm(tool, specifier), problems };
}

/**
 * A `name:value` specifier's name. Input parameter names are lower case
 * (`model`, `file_path`, `run_in_background`), so `Read(C:\x)` stays a path.
 * "Whitespace around the colon is ignored."
 */
const PARAM = /^\s*([a-z_][a-z0-9_]*)\s*:/;

/** The param a `name:value` specifier names, or null when it is not one. */
export function paramName(rule: PermissionRule): string | null {
  return rule.specifier === undefined ? null : PARAM.exec(rule.specifier)?.[1] ?? null;
}

function specifierForm(tool: string, spec: string): RuleForm {
  if (tool.startsWith("mcp__")) return "mcp";
  if (tool.includes("*")) return "glob";
  const param = PARAM.exec(spec)?.[1];
  if (tool === "WebFetch" && param === "domain") return "domain";
  if (param && (!COMMAND_TOOLS.has(tool) || COMMAND_TOOL_PARAMS.has(param))) return "param";
  if (COMMAND_TOOLS.has(tool)) return "command";
  if (PATH_TOOLS.has(tool)) return "path";
  if (tool === "Agent") return "agent";
  return "other";
}

/** Whether a rule covers every use of its tool: `Tool`, `Tool(*)`. */
export function matchesWholeTool(rule: PermissionRule): boolean {
  return rule.form === "bare" || (rule.specifier === "*" && rule.form !== "param");
}

/** Whether a tool-name glob (`*`, `Re*`) matches a tool name in full. */
export function globMatches(glob: string, tool: string): boolean {
  const re = new RegExp("^" + glob.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
  return re.test(tool);
}
