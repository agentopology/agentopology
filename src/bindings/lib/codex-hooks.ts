/**
 * Codex hooks: `.codex/hooks.json` and the scripts behind it (CX-8).
 *
 * A Codex hook file is `{"hooks": {"<Event>": [{"matcher"?, "hooks": [handler]}]}}`
 * (docs read 2026-11-13). Only `command` and `mcp_tool` handlers run; `prompt`
 * and `agent` handlers are parsed and skipped. Fourteen events exist, five of
 * them ignore a matcher, and a `timeout` is in seconds.
 *
 * Nothing is registered that would not fire: a hook on an event Codex lacks,
 * a handler type it skips, or a hook it cannot narrow the way the .at asked
 * gets no entry and one warning (rule ids CX8-*, shared with `validate`).
 *
 * @module
 */

import type { AgentNode, HookDef, TopologyAST } from "../../parser/ast.js";
import { isProjectPath, isShellCommand, proseInRun, runParts, scriptNameFromRun } from "../../parser/run.js";
import { HOOK_EVENTS, NO_MATCHER_EVENTS, RUNNING_HANDLERS } from "../../conformance/codex.js";
import type { GeneratedFile } from "../types.js";
import { shellStub } from "./stub.js";

/** Codex events for the language's universal names; `Error` has no Codex event. */
const UNIVERSAL_EVENTS: Record<string, string | null> = {
  AgentStart: "SubagentStart",
  AgentStop: "SubagentStop",
  ToolUse: "PostToolUse",
  Error: null,
};

/** The Codex event for a hook's `on:`, or null when Codex has none. */
export function codexHookEvent(on: string): string | null {
  const mapped = on in UNIVERSAL_EVENTS ? UNIVERSAL_EVENTS[on] : on;
  return mapped !== null && HOOK_EVENTS.has(mapped) ? mapped : null;
}

/** The repository root, found at run time: a hook's cwd is wherever the session is, not the root. */
export const REPO_ROOT = '"$(git rev-parse --show-toplevel 2>/dev/null || pwd)"';

/** Where the `if:` filter script is written. */
export const IF_FILTER_PATH = ".codex/scripts/at-if.sh";

/** One thing that stops a hook from being registered as written. */
export interface CodexHookProblem {
  rule: "CX8-event" | "CX8-handler" | "CX8-matcher" | "CX8-if" | "CX8-async" | "CX8-run";
  hook: string;
  message: string;
  /** True when the hook gets no entry at all. */
  skipped: boolean;
}

/** `Tool(glob)` parsed from an `if:`, or null. */
export function parseIf(filter: string): { tool: string; glob: string } | null {
  const m = /^([A-Za-z][A-Za-z0-9_]*)\((.*)\)$/s.exec(filter.trim());
  return m ? { tool: m[1], glob: m[2] } : null;
}

/** Everything wrong with one hook on Codex. */
export function codexHookProblems(hook: HookDef): CodexHookProblem[] {
  const out: CodexHookProblem[] = [];
  const add = (rule: CodexHookProblem["rule"], message: string, skipped: boolean) => out.push({ rule, hook: hook.name, message, skipped });
  const type = hook.type ?? "command";
  const event = codexHookEvent(hook.on);
  if (!event) {
    add("CX8-event", `hook "${hook.name}" is on "${hook.on}", which is not a Codex hook event, so it would never fire and gets no entry`, true);
  }
  if (!RUNNING_HANDLERS.has(type)) {
    add("CX8-handler", `hook "${hook.name}" is type: ${type}; Codex runs only command and mcp_tool handlers and skips the rest, so it gets no entry`, true);
  } else if (type === "command" && !isShellCommand(hook.run) && proseInRun(hook.run)) {
    add("CX8-run", `hook "${hook.name}" has a run: that reads as prose, not a command, so it gets no entry`, true);
  }
  if (event && NO_MATCHER_EVENTS.has(event) && hook.matcher) {
    add("CX8-matcher", `hook "${hook.name}" has a matcher on ${event}, which ignores it; the hook fires on every ${event}`, false);
  }
  if (hook.if) {
    if (parseIf(hook.if)) {
      /* expressed through the if-filter script */
    } else {
      add("CX8-if", `hook "${hook.name}" has if: "${hook.if}", which is not Tool(pattern); Codex has no such filter, so it gets no entry rather than firing on every call`, true);
    }
  }
  if (hook.async) {
    add("CX8-async", `hook "${hook.name}" is async; Codex has no async hooks, so it runs in the foreground`, false);
  }
  return out;
}

/** True when the hook gets an entry in hooks.json. */
export function hookIsRegistered(hook: HookDef): boolean {
  return !codexHookProblems(hook).some((p) => p.skipped);
}

/** The script file a command hook runs: `.codex/scripts/<name>`, or the user's own path. */
interface ScriptPlan { command: string; file?: GeneratedFile }

/** Shell-quote one word for a command line. */
function q(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`;
}

function planCommand(hook: HookDef, used: Map<string, string>): ScriptPlan {
  const run = hook.run.trim();
  if (isShellCommand(run)) return { command: run };
  const { interpreter, script, args } = runParts(run);
  const interp = interpreter ?? (script.endsWith(".py") ? "python3" : "bash");
  if (script.startsWith("/")) return { command: [interp, script, ...args].join(" ") };
  if (isProjectPath(script)) {
    const rel = script.replace(/^\.\//, "");
    const stub: GeneratedFile = {
      path: rel,
      content: shellStub(`Hook: ${hook.name} — fires on ${hook.on}`, { fail: hook.strength === "refuse" }),
      category: "script",
      executable: true,
      createOnly: true,
    };
    return { command: `${interp} "$(git rev-parse --show-toplevel 2>/dev/null || pwd)/${rel}"${args.length ? " " + args.join(" ") : ""}`, file: stub };
  }
  let name = scriptNameFromRun(script) ?? "hook.sh";
  // Two hooks whose scripts share a basename must not share a file.
  const prior = used.get(name);
  if (prior !== undefined && prior !== script) name = `${hook.name}-${name}`;
  used.set(name, script);
  const file: GeneratedFile = {
    path: `.codex/scripts/${name}`,
    content: shellStub(`Hook: ${hook.name} — fires on ${hook.on}`, { fail: hook.strength === "refuse" }),
    category: "script",
    executable: true,
  };
  return { command: `${interp} "$(git rev-parse --show-toplevel 2>/dev/null || pwd)/.codex/scripts/${name}"${args.length ? " " + args.join(" ") : ""}`, file };
}

/** The filter script that runs a hook's command only when the tool call matches its `if:`. */
export function ifFilterScript(): GeneratedFile {
  return {
    path: IF_FILTER_PATH,
    category: "script",
    executable: true,
    content: [
      "#!/usr/bin/env bash",
      "# Runs a hook command only when the tool call matches an `if:` pattern, Tool(glob).",
      "# usage: at-if.sh <Tool> <glob> <command...>   (the hook payload arrives on stdin)",
      "# Auto-generated by agentopology scaffold. Without jq it cannot tell, so it blocks (exit 2).",
      "set -u",
      'tool="$1"; glob="$2"; shift 2',
      'payload="$(cat)"',
      'if ! command -v jq >/dev/null 2>&1; then echo "agentopology: jq is missing, so the if: filter cannot run; blocking" >&2; exit 2; fi',
      "name=\"$(printf '%s' \"$payload\" | jq -r '.tool_name // empty')\"",
      'case "$name" in',
      '  "$tool") ;;',
      '  apply_patch) case "$tool" in Edit|Write) ;; *) exit 0 ;; esac ;;',
      "  *) exit 0 ;;",
      "esac",
      'if [ "$tool" = Bash ]; then',
      "  value=\"$(printf '%s' \"$payload\" | jq -r '.tool_input.command // empty')\"",
      "else",
      "  value=\"$(printf '%s' \"$payload\" | jq -r '.tool_input.file_path // .tool_input.path // empty')\"",
      "fi",
      'case "$value" in',
      '  $glob) printf \'%s\' "$payload" | sh -c "$*"; exit $? ;;',
      "esac",
      "exit 0",
      "",
    ].join("\n"),
  };
}

/** What the Codex binding writes for the topology's hooks. */
export interface CodexHooksOutput {
  /** The `.codex/hooks.json` file, or null when no hook is registered. */
  hooksJson: GeneratedFile | null;
  /** Script stubs and the if-filter. */
  scripts: GeneratedFile[];
  /** Every problem, for the binding to print. */
  problems: CodexHookProblem[];
}

/** Compile the topology's own `hooks {}` block. A per-agent hook is not compiled (see not-expressible.ts). */
export function buildCodexHooks(ast: TopologyAST): CodexHooksOutput {
  const hooks: Record<string, unknown[]> = {};
  const scripts: GeneratedFile[] = [];
  const problems: CodexHookProblem[] = [];
  const used = new Map<string, string>();
  let usesFilter = false;

  for (const hook of ast.hooks) {
    const found = codexHookProblems(hook);
    problems.push(...found);
    if (found.some((p) => p.skipped)) continue;
    const event = codexHookEvent(hook.on)!;
    const type = hook.type ?? "command";
    const timeout = hook.timeout ? { timeout: hook.timeout } : {};
    let handler: Record<string, unknown>;
    if (type === "mcp_tool") {
      handler = { type: "mcp_tool", server: hook.server, tool: hook.tool, ...timeout };
    } else {
      const plan = planCommand(hook, used);
      if (plan.file) scripts.push(plan.file);
      let command = plan.command;
      const cond = hook.if ? parseIf(hook.if) : null;
      if (cond) {
        usesFilter = true;
        command = `bash "$(git rev-parse --show-toplevel 2>/dev/null || pwd)/${IF_FILTER_PATH}" ${q(cond.tool)} ${q(cond.glob)} ${command}`;
      }
      handler = { type: "command", command, ...timeout };
    }
    const entry: Record<string, unknown> = { hooks: [handler] };
    if (hook.matcher && !NO_MATCHER_EVENTS.has(event)) entry.matcher = hook.matcher;
    (hooks[event] ??= []).push(entry);
  }
  if (usesFilter) scripts.push(ifFilterScript());

  const hooksJson = Object.keys(hooks).length > 0
    ? { path: ".codex/hooks.json", content: JSON.stringify({ hooks }, null, 2) + "\n", category: "machine" as const }
    : null;
  return { hooksJson, scripts, problems };
}

/** Agents whose own `hooks:` Codex cannot scope (hooks are project-wide). */
export function agentsWithHooks(ast: TopologyAST): AgentNode[] {
  return ast.nodes.filter((n) => n.type === "agent" && ((n as AgentNode).hooks?.length ?? 0) > 0) as AgentNode[];
}
