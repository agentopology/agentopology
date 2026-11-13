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
import { CLAUDE_CODE_GUARDS, promptLog, promptLogScript, shellQuote, spawnGuard, talkGuard } from "./guards.js";

export { promptLogScript, shellQuote };

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

/** The files the binding adds for the topology's session agents; empty with none. */
export function generateSessionFiles(ast: TopologyAST): GeneratedFile[] {
  const agents = sessionAgentsOf(ast);
  if (agents.length === 0) return [];
  const name = ast.topology.name;
  const files = [sessionsMd(agents), spawnGuard(name, agents, CLAUDE_CODE_GUARDS)];
  const sh = launcher(agents);
  if (sh) files.splice(1, 0, sh);
  if (talkEdgesOf(ast).length > 0) files.push(talkGuard(name, ast, CLAUDE_CODE_GUARDS));
  for (const a of decidersWithIncomingTalk(ast)) files.push(promptLog(name, a, CLAUDE_CODE_GUARDS));
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

