/**
 * Whether a declared hook can refuse a call, per platform, and whether one
 * runs a gate's own command (V135, the claude-code scaffold warning).
 *
 * The blocking events come from the conformance files, the same lists
 * guard --check (Claude Code) and the Codex hook checks (CX8) read. A
 * universal event name (AgentStart, AgentStop, ToolUse, Error) maps to an
 * event that never blocks on either platform, so `on:` is read as written.
 *
 * @module
 */

import type { GateNode, HookDef, TopologyAST } from "../../parser/ast.js";
import { BLOCKING_EVENTS as CLAUDE_BLOCKING_EVENTS } from "../../conformance/claude-code.js";
import { BLOCKING_EVENTS as CODEX_BLOCKING_EVENTS } from "../../conformance/codex.js";

/**
 * A hook that declares strength: refuse and can hold to it on platform `p`
 * (`claude-code` or `codex`): a command hook, not async, on an event whose
 * exit 2 stops the call.
 */
export function hookCanRefuse(hook: HookDef, p: string): boolean {
  if (hook.strength !== "refuse" || (hook.type ?? "command") !== "command" || hook.async) return false;
  return (p === "codex" ? CODEX_BLOCKING_EVENTS : CLAUDE_BLOCKING_EVENTS).has(hook.on);
}

/** A command with runs of whitespace made one space, ends trimmed. */
const words = (command: string) => command.trim().replace(/\s+/g, " ");

/**
 * A declared hook that refuses on platform `p` and runs exactly the gate's
 * `run:` command (whitespace aside): the gate's check runs from that hook
 * even though no hook of the gate's own is emitted.
 */
export function sameCommandHook(ast: TopologyAST, gate: GateNode, p: string): HookDef | undefined {
  if (!gate.run) return undefined;
  const want = words(gate.run);
  return (ast.hooks ?? []).find((h) => !!h.run && words(h.run) === want && hookCanRefuse(h, p));
}
