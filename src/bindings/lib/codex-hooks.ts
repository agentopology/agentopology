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

import type { AgentNode, GateNode, HookDef, TopologyAST } from "../../parser/ast.js";
import { gateAnchors } from "../../parser/ast.js";
import { isProjectPath, isShellCommand, proseInRun, runParts, scriptNameFromRun } from "../../parser/run.js";
import { HOOK_EVENTS, NO_MATCHER_EVENTS, RUNNING_HANDLERS } from "../../conformance/codex.js";
import type { GeneratedFile } from "../types.js";
import { shellStub } from "./stub.js";
import {
  CODEX_GUARDS,
  checkableActionGate,
  gateWiring,
  generateBeforeActionScript,
  generateBeforeAgentScript,
  generateGateWrapperScripts,
  getDelegationMode,
  spawnHeldAgents,
} from "./guards.js";

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

/**
 * The shell that finds a generated script and runs it (R-2). A hook runs in the
 * session's current directory; `git rev-parse --show-toplevel` from a nested
 * repository, or `pwd` outside git, is not the project root, and a path that is
 * not found exits 127, which lets the call run (probe P10). So the launcher
 * starts at the repository root (else the current directory) and climbs until
 * the script is there. With `guard`, a script that is not found, or any
 * non-zero exit of the run itself, comes out as exit 2: the call is blocked.
 */
export function launchCommand(interp: string, rel: string, args: string[], guard: boolean, deadline?: number): string {
  const tail = args.length ? " " + args.join(" ") : "";
  if (deadline !== undefined) {
    // R-3: the run is cut a few seconds before Codex's own hook timeout, which would let the call through.
    // GNU `timeout` (or Homebrew's `gtimeout`) kills the whole group and exits 124; with neither, no deadline.
    return [
      `AT_ROOT=${REPO_ROOT}`,
      `while [ ! -f "$AT_ROOT/${rel}" ] && [ "$AT_ROOT" != / ]; do AT_ROOT="$(dirname "$AT_ROOT")"; done`,
      `[ -f "$AT_ROOT/${rel}" ] || { echo "agentopology: ${rel} is not found from $PWD or any folder above it, so this call is blocked" >&2; exit 2; }`,
      `AT_T="$(command -v timeout || command -v gtimeout || true)"`,
      `\${AT_T:+"$AT_T" -k ${DEADLINE_KILL} ${deadline} }${interp} "$AT_ROOT/${rel}"${tail} || { AT_RC=$?; [ "$AT_RC" != 124 ] || echo "agentopology: ${rel} ran past its ${deadline}s deadline, so this call is blocked" >&2; exit 2; }`,
    ].join("; ");
  }
  const missing = guard
    ? `{ echo "agentopology: ${rel} is not found from $PWD or any folder above it, so this call is blocked" >&2; exit 2; }`
    : `{ echo "agentopology: ${rel} is not found from $PWD or any folder above it" >&2; exit 1; }`;
  return [
    `AT_ROOT=${REPO_ROOT}`,
    `while [ ! -f "$AT_ROOT/${rel}" ] && [ "$AT_ROOT" != / ]; do AT_ROOT="$(dirname "$AT_ROOT")"; done`,
    `[ -f "$AT_ROOT/${rel}" ] || ${missing}`,
    `${interp} "$AT_ROOT/${rel}"${tail}${guard ? " || exit 2" : ""}`,
  ].join("; ");
}

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

/**
 * Hook timeout for the generated guards, in seconds. A guard that is cut off
 * lets the command run (probe P10), so this stays well above what a guard
 * needs: jq, a ledger read, and a gate's own check script.
 */
export const GUARD_TIMEOUT = 120;

/** Seconds between the guard's own deadline and the hook timeout Codex enforces (R-3). */
export const DEADLINE_MARGIN = 10;
/** Seconds `timeout` waits after TERM before it sends KILL. */
export const DEADLINE_KILL = 2;
/** Seconds added to a gate's worst case for jq, the ledger read and process start-up. */
export const HOOK_MARGIN = 30;

/** A gate duration (`30s`, `5m`, `2h`, `1d`) in seconds, or null. */
export function durationSeconds(d: string | undefined): number | null {
  const m = /^(\d+)([smhd])$/.exec(d ?? "");
  return m ? Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2] as "s" | "m" | "h" | "d"] : null;
}

/**
 * The longest a gate's check can run: its timeout once per attempt, plus a
 * one-second pause between attempts. Null when the gate has no timeout (the
 * guard's deadline is then the only bound).
 */
export function gateWorstCase(gate: GateNode): number | null {
  const t = durationSeconds(gate.timeout);
  if (t === null) return null;
  const retry = gate.retry != null && gate.retry > 0 ? gate.retry : 0;
  return t * (retry + 1) + retry;
}

/** The hook timeout for a guard that may run these gates: never below GUARD_TIMEOUT, always above their worst case. */
export function guardHookTimeout(gates: GateNode[]): number {
  const worst = gates.reduce((sum, g) => sum + (gateWorstCase(g) ?? 0), 0);
  return Math.max(GUARD_TIMEOUT, worst + HOOK_MARGIN + DEADLINE_MARGIN);
}

/** The command a guard script is registered with: anchored at the repository root. */
function guardCommand(ast: TopologyAST, file: string, timeout: number): string {
  return launchCommand("bash", `${CODEX_GUARDS.scriptsDir(ast.topology.name)}/${file}`, [], true, timeout - DEADLINE_MARGIN);
}

/** A guard handler: the command, with a deadline under the hook timeout, and that timeout. */
function guardHandler(ast: TopologyAST, file: string, gates: GateNode[]): Record<string, unknown> {
  const timeout = guardHookTimeout(gates);
  return { type: "command", command: guardCommand(ast, file, timeout), timeout };
}

/** The gates with a `run:` script that a guard may run. */
function runGates(ast: TopologyAST, keep: (g: GateNode) => boolean): GateNode[] {
  return ast.nodes.filter((n): n is GateNode => n.type === "gate").filter((g) => g.behavior !== "advisory" && !!scriptNameFromRun(g.run) && keep(g));
}

/** The shell command that runs a gate's `run:`; the guard scripts have changed to the project root first. */
export function codexGateCommand(run: string, _topology: string): string {
  if (isShellCommand(run)) return run.trim();
  const { interpreter, script, args } = runParts(run);
  const interp = interpreter ?? (script.endsWith(".py") ? "python3" : "bash");
  const where = script.startsWith("/") ? script : isProjectPath(script) ? script.replace(/^\.\//, "") : `.codex/scripts/${scriptNameFromRun(run) ?? script}`;
  return [interp, where, ...args].join(" ");
}

/** The guard scripts and their `hooks.json` entries (CX-9, CX-11). */
export function buildCodexGuards(ast: TopologyAST): { scripts: GeneratedFile[]; entries: Array<{ event: string; entry: Record<string, unknown> }> } {
  const scripts: GeneratedFile[] = [...generateGateWrapperScripts(ast, CODEX_GUARDS, codexGateCommand)];
  for (const s of scripts) s.executable = true;
  const entries: Array<{ event: string; entry: Record<string, unknown> }> = [];
  const beforeAgent = generateBeforeAgentScript(ast, CODEX_GUARDS);
  if (beforeAgent) {
    scripts.push(beforeAgent);
    // Probe P3: a subagent spawn is the tool collaborationspawn_agent.
    const gates = runGates(ast, (g) => spawnHeldAgents(ast, g, CODEX_GUARDS).length > 0);
    entries.push({ event: "PreToolUse", entry: { matcher: "collaborationspawn_agent", hooks: [guardHandler(ast, "before-agent.sh", gates)] } });
  }
  const beforeAction = generateBeforeActionScript(ast, CODEX_GUARDS);
  if (beforeAction) {
    scripts.push(beforeAction);
    const gates = runGates(ast, (g) => checkableActionGate(ast, g));
    entries.push({ event: "PreToolUse", entry: { matcher: "Bash", hooks: [guardHandler(ast, "before-action.sh", gates)] } });
  }
  // A gate after an agent also runs when that agent stops (SubagentStop; the matcher is the agent type,
  // probe P4). That hook cannot block on Codex; what holds is before-agent.sh at the next agent's spawn (R-1).
  if (getDelegationMode(ast) !== "inline") {
    for (const node of ast.nodes) {
      if (node.type !== "gate") continue;
      const gate = node as GateNode;
      if (!scriptNameFromRun(gate.run) || gate.behavior === "advisory") continue;
      if (checkableActionGate(ast, gate) || gateWiring(ast, gate).kind !== "subagent-stop") continue;
      for (const anchor of gateAnchors(gate, "after")) {
        entries.push({ event: "SubagentStop", entry: { matcher: anchor, hooks: [guardHandler(ast, `gate-${gate.id}.sh`, [gate])] } });
      }
    }
  }
  return { scripts, entries };
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

  const guards = buildCodexGuards(ast);
  scripts.push(...guards.scripts);
  for (const { event, entry } of guards.entries) (hooks[event] ??= []).push(entry);

  const hooksJson = Object.keys(hooks).length > 0
    ? { path: ".codex/hooks.json", content: JSON.stringify({ hooks }, null, 2) + "\n", category: "shared-config" as const }
    : null;
  return { hooksJson, scripts, problems };
}

/** Agents whose own `hooks:` Codex cannot scope (hooks are project-wide). */
export function agentsWithHooks(ast: TopologyAST): AgentNode[] {
  return ast.nodes.filter((n) => n.type === "agent" && ((n as AgentNode).hooks?.length ?? 0) > 0) as AgentNode[];
}
