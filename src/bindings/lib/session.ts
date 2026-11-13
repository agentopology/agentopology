/**
 * Session agents for the claude-code binding (N44b, T-04).
 *
 * A session agent (`runs: session`) is its own named Claude Code session. Its
 * id is its agent file, its `claude -n` name, its SendMessage address and what
 * talk edges point at. This module writes what the binding adds for them:
 *
 * - `.claude/sessions.md`: one start line per session, `AT_SESSION=<id> claude
 *   --agent <id> -n <id>`. The AT_SESSION export is how the hooks know who is
 *   sending.
 * - `scripts/start-sessions.sh`: starts those lines in herdr tabs and panes,
 *   or prints them when herdr is not installed. Plain POSIX sh.
 * - A spawn guard (PreToolUse on Agent|Task) that refuses to launch a session
 *   agent as a subagent.
 * - A talk guard (PreToolUse on SendMessage) that refuses a send the talk
 *   edges do not allow, and logs every send to `.claude/state/talk.jsonl`.
 * - For an agent with `decides:` and an incoming talk edge, a UserPromptSubmit
 *   hook that logs whether each prompt was typed or arrived as a message from
 *   another session. It never blocks.
 *
 * @module
 */

import type { AgentNode, EdgeDef, TopologyAST } from "../../parser/ast.js";
import { sessionAgentsOf, talkEdgesOf } from "../../parser/session-graph.js";
import type { GeneratedFile } from "../types.js";
import { FAIL_CLOSED, FAIL_CLOSED_DONE } from "./stub.js";

/** The line other targets print when a topology has session agents. */
export const SESSION_NOTICE = "session agents: experimental, not compiled";

export { sessionAgentsOf, talkEdgesOf };

/** Session agents that hold a decision seat and can receive a message. */
export function decidersWithIncomingTalk(ast: TopologyAST): AgentNode[] {
  const incoming = new Set(talkEdgesOf(ast).map((e) => e.to));
  return sessionAgentsOf(ast).filter((a) => (a.decides?.length ?? 0) > 0 && incoming.has(a.id));
}

/** Warn once that another target does not compile session agents. */
export function warnSessionsNotCompiled(ast: TopologyAST, target: string): void {
  if (sessionAgentsOf(ast).length > 0) console.warn(`[${target}] ${SESSION_NOTICE}`);
}

/** Characters a permission mode may hold when it is put in a shell line (acceptEdits, bypassPermissions, ...). */
const SAFE_MODE = /^[A-Za-z0-9-]+$/;
/** A flow target id that is safe to put in a shell `case` pattern. */
const SAFE_TARGET = /^[A-Za-z0-9_-]{1,64}$/;

/** True when the id, place and permission mode are safe to write into a start line or script. */
export function sessionIsSafe(agent: AgentNode): boolean {
  const mode = agent.permissionMode;
  return SAFE_NAME.test(agent.id) && SAFE_NAME.test(agent.place ?? DEFAULT_PLACE) && (mode === undefined || (typeof mode === "string" && SAFE_MODE.test(mode)));
}

export function startLine(agent: AgentNode): string {
  const mode = agent.permissionMode ? ` --permission-mode ${agent.permissionMode}` : "";
  return `AT_SESSION=${agent.id} claude --agent ${agent.id} -n ${agent.id}${mode}`;
}

const DEFAULT_PLACE = "sessions";
const SAFE_NAME = /^[a-z0-9-]+$/;

function placesOf(agents: AgentNode[]): Map<string, AgentNode[]> {
  const places = new Map<string, AgentNode[]>();
  for (const a of agents) {
    const p = a.place ?? DEFAULT_PLACE;
    places.set(p, [...(places.get(p) ?? []), a]);
  }
  return places;
}

export function sessionScriptPath(topology: string, file: string): string {
  return `.claude/skills/${topology}/scripts/${file}`;
}

function sessionsMd(allAgents: AgentNode[]): GeneratedFile {
  const agents = allAgents.filter((a) => {
    if (sessionIsSafe(a)) return true;
    console.warn(`[claude-code] .claude/sessions.md: no start line for a session whose id, place or permission-mode has characters outside a-z, 0-9 and "-" (permission-mode also allows A-Z); validate reports an unsafe id or place as V113`);
    return false;
  });
  const lines = [
    "# Sessions",
    "",
    "Start each session with its line below, from the project root. The AT_SESSION",
    "export tells the hooks which session is sending a message; a session started",
    "any other way is not guarded. `scripts/start-sessions.sh` runs these lines in herdr.",
    "",
  ];
  for (const [place, members] of placesOf(agents)) {
    const heading = SAFE_NAME.test(place) ? place : "(place name not shown: unsafe characters)";
    lines.push(`## ${heading}`, "", "```sh", ...members.map(startLine), "```", "");
  }
  return { path: ".claude/sessions.md", content: lines.join("\n"), category: "machine" };
}

/** Single-quote a value for a POSIX shell, escaping embedded single quotes. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The launcher, or null (with a warning) when a place or id is not safe to put in a shell script. */
function launcher(agents: AgentNode[]): GeneratedFile | null {
  for (const a of agents) {
    if (!sessionIsSafe(a)) {
      console.warn(`[claude-code] scripts/start-sessions.sh not written: a session id, place or permission-mode has characters outside a-z, 0-9 and "-" (permission-mode also allows A-Z)`);
      return null;
    }
  }
  const lines = [
    "#!/bin/sh",
    "# Starts every session agent from .claude/sessions.md.",
    "# Auto-generated by agentopology scaffold. With herdr on PATH it opens one tab",
    "# per place and one pane per session; without it, it prints the start lines.",
    "# UNPROVEN: the herdr subcommands used here (tab create, pane split, pane run,",
    "# pane list) have not been run against a real herdr. Check them before relying on this.",
    "# A rerun skips a session herdr already lists; if herdr cannot list, a rerun duplicates.",
    "set -eu",
    'cd "$(dirname "$0")/.."',
    "",
    `trap 'rc=$?; [ "$rc" = 0 ] || echo "start-sessions: stopped early (exit $rc); some sessions may already be running, and a rerun starts them again" >&2' EXIT`,
    "",
    "if command -v herdr >/dev/null 2>&1; then",
    "  # Drop error/usage banners, then match whole whitespace-separated names.",
    `  listed=$(herdr pane list 2>/dev/null | grep -viE '^ *(error|warn|warning|usage|fatal)' || true) || listed=""`,
    '  if [ -z "$listed" ]; then',
    '    echo "start-sessions: cannot list running sessions, so a rerun duplicates the ones already running" >&2',
    "  fi",
  ];
  for (const [place, members] of placesOf(agents)) {
    lines.push("  pane=");
    for (const a of members) {
      lines.push(
        `  if printf '%s\\n' "$listed" | awk -v n=${shellQuote(a.id)} '{ for (i = 1; i <= NF; i++) if ($i == n) f = 1 } END { exit !f }'; then`,
        `    echo ${shellQuote(`skipping ${a.id}: already listed`)}`,
        "  else",
        '    if [ -z "$pane" ]; then',
        `      pane=$(herdr tab create ${shellQuote(place)})`,
        "    else",
        '      pane=$(herdr pane split "$pane")',
        "    fi",
        `    herdr pane run "$pane" ${shellQuote(startLine(a))}`,
        "  fi",
      );
    }
  }
  lines.push("else", '  echo "herdr is not on PATH. Start each session in its own terminal:"');
  for (const [place, members] of placesOf(agents)) {
    lines.push(`  echo ${shellQuote(`# ${place}`)}`);
    for (const a of members) lines.push(`  echo ${shellQuote(startLine(a))}`);
  }
  lines.push("fi", "");
  return { path: "scripts/start-sessions.sh", content: lines.join("\n"), category: "script", executable: true };
}

/** jq: trim, lowercase, drop a "<prefix>:" namespace. */
const JQ_NORM = String.raw`gsub("\\A\\s+|\\s+\\z"; "") | ascii_downcase | sub("\\A.*:"; "") | gsub("\\A\\s+|\\s+\\z"; "")`;

/** Lines every session script runs to find the project root and append to the log. */
const ROOT_LINES = [
  'ROOT="${CLAUDE_PROJECT_DIR:-}"',
  'if [ -z "$ROOT" ]; then ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd); fi',
  'cd "$ROOT"',
];

const APPEND_LINES = [
  "append() { # one JSON line on stdin; never writes through a symlink",
  "  if [ -L .claude/state ] || [ -L .claude/state/talk.jsonl ]; then",
  '    echo "guard: .claude/state/talk.jsonl or its folder is a symlink; not writing the log" >&2',
  "    return 1",
  "  fi",
  "  if [ -n \"$(find .claude/state/talk.jsonl -type f -links +1 2>/dev/null)\" ]; then",
  '    echo "guard: .claude/state/talk.jsonl has more than one hard link; not writing the log" >&2',
  "    return 1",
  "  fi",
  "  mkdir -p .claude/state && cat >> .claude/state/talk.jsonl",
  "}",
];

function spawnGuard(topology: string, agents: AgentNode[]): GeneratedFile {
  const ids = agents.map((a) => a.id).join("|");
  const lines = [
    "#!/usr/bin/env bash",
    `# Spawn guard for topology "${topology}": a session agent is started from`,
    "# .claude/sessions.md, never launched as a subagent.",
    "# Auto-generated by agentopology scaffold. PreToolUse hook on Agent|Task;",
    "# exit 2 blocks the launch and shows the reason to Claude. A missing or",
    "# non-object tool_input, or a non-string subagent_type or name, also blocks.",
    "set -euo pipefail",
    ...FAIL_CLOSED,
    "INPUT=$(cat)",
    `AGENT=$(printf '%s' "$INPUT" | jq -er '.tool_input | objects | (if .subagent_type == null then "" else .subagent_type end) | strings | ${JQ_NORM}')`,
    `NAME=$(printf '%s' "$INPUT" | jq -er '.tool_input | objects | (if .name == null then "" else .name end) | strings | ${JQ_NORM}')`,
    'for CAND in "$AGENT" "$NAME"; do',
    '  case "$CAND" in',
    `    ${ids})`,
    '      echo "spawn guard: $CAND runs as its own session; start it from .claude/sessions.md and message it, do not launch it as a subagent" >&2',
    "      exit 2",
    "      ;;",
    "  esac",
    "done",
    FAIL_CLOSED_DONE,
    "exit 0",
    "",
  ];
  return { path: sessionScriptPath(topology, "spawn-guard.sh"), content: lines.join("\n"), category: "script", executable: true };
}

function talkGuard(topology: string, ast: TopologyAST): GeneratedFile {
  const sessions = sessionAgentsOf(ast);
  const sessionIds = new Set(sessions.map((a) => a.id));
  const known = new Set(ast.nodes.map((n) => n.id));
  const allowed = new Map<string, string[]>();
  for (const a of sessions) allowed.set(a.id, []);
  for (const e of ast.edges) {
    if (e.isError || !sessionIds.has(e.from) || !known.has(e.to)) continue;
    if (e.from === e.to) continue;
    allowed.set(e.from, [...new Set([...(allowed.get(e.from) ?? []), e.to])]);
  }
  const lines = [
    "#!/usr/bin/env bash",
    `# Talk guard for topology "${topology}": a session may message only the`,
    "# sessions its talk edges name, its own flow targets (such as its subagents)",
    "# and main.",
    "# Auto-generated by agentopology scaffold. PreToolUse hook on SendMessage;",
    "# exit 2 refuses the send. The current session is $AT_SESSION, exported by the",
    "# start line in .claude/sessions.md. Every send is appended to",
    "# .claude/state/talk.jsonl, a trail and not evidence: whoever can write files can edit it.",
    "set -euo pipefail",
    ...FAIL_CLOSED,
    ...ROOT_LINES,
    "PAYLOAD=$(cat)",
    "",
    ...APPEND_LINES,
    "log() { # from to result",
    '  jq -nc --arg from "$1" --arg to "$2" --arg result "$3" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \'{ts: $ts, kind: "send", from: $from, to: $to, result: $result}\' | append',
    "}",
    "",
    'if [ -z "${AT_SESSION:-}" ]; then',
    "  # Not started from sessions.md: allow, and say so.",
    `  TO=$(printf '%s' "$PAYLOAD" | jq -r '((.tool_input | objects | .to | strings | .[0:64]) // "")' 2>/dev/null || true)`,
    '  echo "talk guard: session not started from sessions.md, unguarded" >&2',
    '  log "" "$TO" unguarded || echo "talk log not written" >&2',
    `  ${FAIL_CLOSED_DONE}`,
    "  exit 0",
    "fi",
    "",
    "# From here the guard is fail-closed: a payload it cannot read blocks the send,",
    "# and the refusal is logged. A trailing ' [ref]' (ListAgents' mark for a",
    "# duplicate name) is stripped; anything but A-Z, a-z, 0-9, _ and - is refused.",
    "# Session ids are kebab-case (V113) and, like other flow targets such as subagents, match exactly as declared.",
    'FROM="$AT_SESSION"',
    "# Claude Code delivers the target twice, as `to` and `recipient`; which one it",
    "# routes by is not documented. Use `to`, else `recipient`; if both are present",
    "# and differ after ref strip, trim and lowercase, refuse.",
    String.raw`DISAGREE=$(printf '%s' "$PAYLOAD" | jq -r 'def norm: sub(" \\[[A-Za-z0-9_-]+\\]\\z"; "") | gsub("^\\s+|\\s+$"; "") | ascii_downcase; (.tool_input | objects) as $i | if ($i.to != null and $i.recipient != null) then (if (($i.to | type) == "string") and (($i.recipient | type) == "string") then (($i.to | norm) != ($i.recipient | norm)) else true end) else false end' 2>/dev/null || echo true)`,
    String.raw`TO=$(printf '%s' "$PAYLOAD" | jq -er '.tool_input | objects | (.to // .recipient) | strings | sub(" \\[[A-Za-z0-9_-]+\\]\\z"; "") | if test("\\A[A-Za-z0-9_-]{1,64}\\z") then . else "?" + (.[0:64] | @json) end') || TO="?unreadable"`,
    'if [ "$DISAGREE" != "false" ]; then',
    '  log "$FROM" "$TO" refused || echo "talk log not written" >&2',
    '  echo "talk guard: to and recipient disagree" >&2',
    "  exit 2",
    "fi",
    "OK=0",
    "ALLOWED=",
    'case "$FROM" in',
  ];
  for (const [from, tos] of allowed) {
    const safe = tos.filter((t) => SAFE_TARGET.test(t));
    const sess = [...safe.filter((t) => sessionIds.has(t)), "main"];
    const other = safe.filter((t) => !sessionIds.has(t));
    lines.push(`  ${from})`, `    ALLOWED="${[...safe, "main"].join(" ")}"`, `    case "$TO" in ${sess.join("|")}) OK=1 ;; esac`);
    if (other.length > 0) lines.push(`    case "$TO" in ${other.join("|")}) OK=1 ;; esac`);
    lines.push("    ;;");
  }
  lines.push(
    "esac",
    'if [ "$OK" = 1 ]; then',
    '  log "$FROM" "$TO" allowed || echo "talk log not written" >&2',
    `  ${FAIL_CLOSED_DONE}`,
    "  exit 0",
    "fi",
    'log "$FROM" "$TO" refused || echo "talk log not written" >&2',
    'echo "talk guard: $FROM may not message $TO; its talk edges allow: ${ALLOWED:-none}" >&2',
    "exit 2",
    "",
  );
  return { path: sessionScriptPath(topology, "talk-guard.sh"), content: lines.join("\n"), category: "script", executable: true };
}

/** The file name of the prompt-log script for a deciding session. */
export function promptLogScript(id: string): string {
  return `session-prompt-${id}.sh`;
}

function promptLog(topology: string, agent: AgentNode): GeneratedFile {
  const lines = [
    "#!/usr/bin/env bash",
    `# Prompt log for session "${agent.id}", which holds ${agent.decides!.join(", ")}.`,
    "# Auto-generated by agentopology scaffold. UserPromptSubmit hook. A decision",
    "# can arrive here as a message from another session; this records, for each",
    "# prompt, whether it was typed or arrived, in .claude/state/talk.jsonl (a trail,",
    "# not evidence), so a human-gate script can tell the two apart. kind is unknown",
    "# unless a non-empty prompt was read. It never blocks (always exit 0).",
    `[ "\${AT_SESSION:-}" = "${agent.id}" ] || exit 0`,
    "PAYLOAD=$(cat 2>/dev/null || true)",
    "KIND=unknown",
    String.raw`PROMPT=$(printf '%s' "$PAYLOAD" | jq -er '.prompt | strings | sub("\\A\\s+"; "") | select(length > 0)' 2>/dev/null) || PROMPT=`,
    'if [ -n "$PROMPT" ]; then',
    '  case "$PROMPT" in',
    '    "<cross-session-message"*) KIND=arrived ;;',
    "    *) KIND=typed ;;",
    "  esac",
    "fi",
    ...ROOT_LINES.map((l, i) => (i === 2 ? 'cd "$ROOT" 2>/dev/null || exit 0' : l)),
    ...APPEND_LINES,
    `jq -nc --arg kind "$KIND" --arg session "${agent.id}" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{ts: $ts, kind: $kind, session: $session}' 2>/dev/null | append 2>/dev/null || true`,
    "exit 0",
    "",
  ];
  return { path: sessionScriptPath(topology, promptLogScript(agent.id)), content: lines.join("\n"), category: "script", executable: true };
}

/** The files the binding adds for the topology's session agents; empty with none. */
export function generateSessionFiles(ast: TopologyAST): GeneratedFile[] {
  const agents = sessionAgentsOf(ast);
  if (agents.length === 0) return [];
  const name = ast.topology.name;
  const files = [sessionsMd(agents), spawnGuard(name, agents)];
  const sh = launcher(agents);
  if (sh) files.splice(1, 0, sh);
  if (talkEdgesOf(ast).length > 0) files.push(talkGuard(name, ast));
  for (const a of decidersWithIncomingTalk(ast)) files.push(promptLog(name, a));
  return files;
}

/** The settings.json hook entries for those files, by event. */
export function sessionSettingsHooks(ast: TopologyAST, command: (file: string) => string): Record<string, unknown[]> {
  const agents = sessionAgentsOf(ast);
  if (agents.length === 0) return {};
  const out: Record<string, unknown[]> = {
    PreToolUse: [{ matcher: "Agent|Task", hooks: [{ type: "command", command: command("spawn-guard.sh"), onFailure: "block" }] }],
  };
  if (talkEdgesOf(ast).length > 0) {
    out.PreToolUse.push({ matcher: "SendMessage", hooks: [{ type: "command", command: command("talk-guard.sh"), onFailure: "block" }] });
  }
  const deciders = decidersWithIncomingTalk(ast);
  if (deciders.length > 0) {
    out.UserPromptSubmit = deciders.map((a) => ({ hooks: [{ type: "command", command: command(promptLogScript(a.id)) }] }));
  }
  return out;
}

