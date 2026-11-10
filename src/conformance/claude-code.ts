/**
 * Claude Code's hook contract, as its docs state it, and a check of a
 * generated settings.json against it.
 *
 * Each fact below was checked against https://code.claude.com/docs/en/hooks.md
 * on 2026-11-10 (Claude Code 2.1.319 installed). When the contract moves,
 * this file moves with it, and the conformance tests say which generated
 * output stopped matching.
 *
 * @module
 */

/** The Claude Code version this contract was last checked against. */
export const VERIFIED_ON = "2.1.319";

/** The oldest Claude Code the generated output supports (`onFailure` needs it). */
export const MINIMUM_VERSION = "2.1.295";

/** Every hook event the docs list (33). A hook on any other name never fires. */
export const HOOK_EVENTS: ReadonlySet<string> = new Set([
  "SessionStart", "Setup", "UserPromptSubmit", "UserPromptExpansion",
  "PreToolUse", "PermissionRequest", "PermissionDenied", "PostToolUse",
  "PostToolUseFailure", "PostToolBatch", "Notification", "MessageDisplay",
  "SubagentStart", "SubagentStop", "TaskCreated", "TaskCompleted", "Stop",
  "StopFailure", "TeammateIdle", "InstructionsLoaded", "ConfigChange",
  "CwdChanged", "DirectoryAdded", "FileChanged", "WorktreeCreate",
  "WorktreeRemove", "PreCompact", "PostCompact", "PreModelSwitch",
  "PostModelSwitch", "Elicitation", "ElicitationResult", "SessionEnd",
]);

/** Events with no matcher support: a matcher on them is silently ignored. */
export const NO_MATCHER_EVENTS: ReadonlySet<string> = new Set([
  "UserPromptSubmit", "PostToolBatch", "Stop", "TeammateIdle", "TaskCreated",
  "TaskCompleted", "WorktreeCreate", "WorktreeRemove", "MessageDisplay",
]);

/** Handler types and the field each one requires. */
export const HANDLER_REQUIRED: Readonly<Record<string, readonly string[]>> = {
  command: ["command"],
  http: ["url"],
  mcp_tool: ["server", "tool"],
  prompt: ["prompt"],
  agent: ["prompt"],
};

/** `onFailure` exists on command and http handlers, as "continue" or "block". */
export const ON_FAILURE_TYPES: ReadonlySet<string> = new Set(["command", "http"]);
export const ON_FAILURE_VALUES: ReadonlySet<string> = new Set(["continue", "block"]);

/** The values PreToolUse's `hookSpecificOutput.permissionDecision` takes. */
export const PERMISSION_DECISIONS: ReadonlySet<string> = new Set(["allow", "deny", "ask", "defer"]);

export interface Violation {
  event: string;
  rule: string;
  detail: string;
}

/**
 * A command hook runs in the session's current directory, which moves when
 * Claude changes directory ("Handlers run in the current directory"). A
 * script named by a relative path is then not found, the shell exits 127, and
 * 127 does not block: the hook is skipped. A path is anchored when it starts
 * with the project-dir placeholder or is absolute.
 */
export function unanchoredScript(command: string): string | null {
  const script = command.trim().split(/\s+/).map((p) => p.replace(/^["']|["']$/g, "")).find((p) => /\.(sh|py|js|mjs|ts)$/.test(p));
  if (!script) return null;
  if (script.startsWith("$CLAUDE_PROJECT_DIR") || script.startsWith("${CLAUDE_PROJECT_DIR}") || script.startsWith("/")) return null;
  return script;
}

/** Check a settings.json `hooks` object against the contract. */
export function checkHooks(hooks: Record<string, unknown>): Violation[] {
  const out: Violation[] = [];
  for (const [event, entries] of Object.entries(hooks)) {
    if (!HOOK_EVENTS.has(event)) out.push({ event, rule: "event", detail: `"${event}" is not a Claude Code hook event, so it never fires` });
    if (!Array.isArray(entries)) { out.push({ event, rule: "shape", detail: "the event's value is not an array" }); continue; }
    for (const entry of entries as Array<Record<string, unknown>>) {
      if ("matcher" in entry && typeof entry.matcher !== "string") out.push({ event, rule: "matcher", detail: "a matcher is a string; any other value never matches" });
      if ("matcher" in entry && NO_MATCHER_EVENTS.has(event)) out.push({ event, rule: "matcher", detail: `${event} has no matcher support; the matcher is silently ignored` });
      for (const h of (entry.hooks ?? []) as Array<Record<string, unknown>>) {
        const type = String(h.type);
        const required = HANDLER_REQUIRED[type];
        if (!required) { out.push({ event, rule: "type", detail: `handler type "${type}" does not exist` }); continue; }
        for (const f of required) if (typeof h[f] !== "string" || h[f] === "") out.push({ event, rule: "type", detail: `a ${type} handler needs "${f}"` });
        if ("onFailure" in h) {
          if (!ON_FAILURE_TYPES.has(type)) out.push({ event, rule: "onFailure", detail: `onFailure is not read on a ${type} handler` });
          if (!ON_FAILURE_VALUES.has(String(h.onFailure))) out.push({ event, rule: "onFailure", detail: `onFailure is "continue" or "block", not "${h.onFailure}"` });
        }
        if (type === "command") {
          const loose = unanchoredScript(String(h.command));
          if (loose) out.push({ event, rule: "cwd", detail: `${loose} is relative; hooks run in the session's current directory, so it is skipped once Claude changes directory` });
        }
      }
    }
  }
  return out;
}

/** The stdin Claude Code hands a hook for an event: the common fields plus the event's own. */
export function payloadFor(event: string, cwd: string, matcher?: string): Record<string, unknown> {
  const common = { session_id: "conformance", transcript_path: "/dev/null", cwd, hook_event_name: event, permission_mode: "default" };
  const tool = matcher && !/[|*.()[\]]/.test(matcher) ? matcher : "Bash";
  switch (event) {
    case "PreToolUse":
    case "PermissionRequest":
      return { ...common, tool_name: tool, tool_input: tool === "Agent" || tool === "Task" ? { subagent_type: "conformance-agent" } : { command: "true" }, tool_use_id: "t1" };
    case "PostToolUse":
    case "PostToolUseFailure":
      return { ...common, tool_name: tool, tool_input: { command: "true", file_path: `${cwd}/x.md` }, tool_response: {}, tool_use_id: "t1" };
    case "SubagentStart":
    case "SubagentStop":
      return { ...common, agent_id: "a1", agent_type: matcher ?? "conformance-agent", stop_hook_active: false, agent_transcript_path: "/dev/null", last_assistant_message: "done" };
    case "Stop":
      return { ...common, stop_hook_active: false, last_assistant_message: "done" };
    case "UserPromptSubmit":
      return { ...common, prompt: "hello" };
    default:
      return common;
  }
}

/**
 * Check a hook's stdout on exit 0. Stdout is plain text unless it is one JSON
 * object; text that looks like JSON but does not parse is an error. On
 * PreToolUse a decision must sit in `hookSpecificOutput`.
 */
export function checkStdout(event: string, stdout: string): string | null {
  const s = stdout.trim();
  if (!(s.startsWith("{") && s.endsWith("}"))) return null;
  let json: Record<string, any>;
  try { json = JSON.parse(s); } catch { return "stdout looks like JSON but does not parse (a non-blocking error)"; }
  if (event === "PreToolUse" && json.hookSpecificOutput) {
    const o = json.hookSpecificOutput;
    if (o.hookEventName !== "PreToolUse") return `hookSpecificOutput.hookEventName is "${o.hookEventName}", not "PreToolUse"`;
    if (o.permissionDecision !== undefined && !PERMISSION_DECISIONS.has(o.permissionDecision)) return `permissionDecision "${o.permissionDecision}" is not allow, deny, ask or defer`;
  }
  if (event === "PreToolUse" && ("decision" in json)) return "top-level decision is deprecated on PreToolUse; use hookSpecificOutput.permissionDecision";
  return null;
}
