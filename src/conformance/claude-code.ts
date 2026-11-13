/**
 * Claude Code's hook contract, as its docs state it, and a check of a
 * generated settings.json against it.
 *
 * Each fact below was checked against https://code.claude.com/docs/en/hooks.md
 * on 2026-11-13 (Claude Code 2.1.323). When the contract moves,
 * this file moves with it, and the conformance tests say which generated
 * output stopped matching. spec/claude-code/hooks-contract.json is the same
 * page as a snapshot: e2e/contract-drift.test.ts holds these constants to it,
 * and `npm run drift` holds it to the live page.
 *
 * @module
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { AgentNode, GateNode, TopologyAST } from "../parser/ast.js";

/** The Claude Code version this contract was last checked against. */
export const VERIFIED_ON = "2.1.323";

/** The oldest Claude Code the generated output supports (`onFailure` needs it). */
export const MINIMUM_VERSION = "2.1.295";

/**
 * The one line the CLI prints about what the output was checked against.
 * Built from the two constants above so the number a user reads can never be
 * a copy that went stale (N40).
 */
export function verifiedOnLine(): string {
  return `checked against Claude Code ${VERIFIED_ON} (supports ${MINIMUM_VERSION} and later)`;
}

/** One version the output was checked on, and the proof (RW-7). */
export interface VerifiedEntry {
  version: string;
  proof: { run: string; date: string; suite: { passed: number; failed: number; skipped: number }; note?: string };
}

/** What is wrong with a verified list; empty when every entry names a version and carries a proof whose suite has failed: 0. */
export function verifiedListProblems(doc: unknown): string[] {
  const versions = (doc as { versions?: unknown })?.versions;
  if (!Array.isArray(versions)) return ["the list has no `versions` array"];
  const out: string[] = [];
  for (const e of versions as Array<Record<string, any>>) {
    const v = typeof e?.version === "string" ? e.version : "";
    const label = v || JSON.stringify(e);
    if (!/^\d+\.\d+\.\d+$/.test(v)) out.push(`entry ${label}: version is not x.y.z`);
    else if (!e.proof || typeof e.proof !== "object") out.push(`entry ${label}: no proof field`);
    else if (typeof e.proof.run !== "string" || !e.proof.run) out.push(`entry ${label}: proof has no run id`);
    else if (typeof e.proof.date !== "string" || !e.proof.date) out.push(`entry ${label}: proof has no date`);
    else if (!e.proof.suite || typeof e.proof.suite !== "object") out.push(`entry ${label}: proof has no suite, so nothing shows the checks passed`);
    else if (!["passed", "failed", "skipped"].every((k) => Number.isInteger(e.proof.suite[k]))) out.push(`entry ${label}: proof.suite needs passed, failed and skipped counts`);
    // R-10: a proof whose suite failed proves nothing; the version stays unverified.
    else if (e.proof.suite.failed !== 0) out.push(`entry ${label}: proof.suite has ${e.proof.suite.failed} failed test(s); only a suite with failed: 0 verifies a version`);
  }
  return out;
}

/**
 * spec/claude-code/verified.json: the versions checked, each with its proof.
 * Only entries that pass the check above count. An unreadable file gives an
 * empty list, so VERIFIED_ON alone stays verified (the one-version behavior).
 * AGENTOPOLOGY_VERIFIED_LIST=<file> stands in for the file; tests set it.
 */
export function loadVerifiedList(): VerifiedEntry[] {
  const file = process.env.AGENTOPOLOGY_VERIFIED_LIST || fileURLToPath(new URL("../../spec/claude-code/verified.json", import.meta.url));
  try {
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    return (doc.versions as VerifiedEntry[]).filter((e) => verifiedListProblems({ versions: [e] }).length === 0);
  } catch {
    return [];
  }
}

/** True for VERIFIED_ON and for any version on the proven list. */
export function isVerifiedVersion(v: string): boolean {
  return v === VERIFIED_ON || loadVerifiedList().some((e) => e.version === v);
}

export type InstalledStatus =
  | { state: "verified"; version: string }
  | { state: "different"; version: string }
  | { state: "unknown" }
  | { state: "not-installed" };

let installedCache: InstalledStatus | undefined;

/**
 * What `claude --version` says (first x.y.z in stdout, 3 s timeout), read at
 * most once per process. A timeout or unparsable output is "unknown", never
 * an error. No `claude` on PATH is "not-installed".
 *
 * Env override: AGENTOPOLOGY_CLAUDE_VERSION=<x.y.z> stands in for the
 * installed version, and AGENTOPOLOGY_CLAUDE_VERSION=none for "not installed",
 * without running `claude`. Tests set it so output does not depend on PATH.
 */
export function installedStatus(): InstalledStatus {
  if (installedCache) return installedCache;
  const forced = process.env.AGENTOPOLOGY_CLAUDE_VERSION;
  if (forced !== undefined && forced !== "") {
    if (forced === "none") return (installedCache = { state: "not-installed" });
    const v = /^\d+\.\d+\.\d+$/.exec(forced)?.[0];
    return (installedCache = !v ? { state: "unknown" } : isVerifiedVersion(v) ? { state: "verified", version: v } : { state: "different", version: v });
  }
  const r = spawnSync("claude", ["--version"], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });
  let status: InstalledStatus;
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") status = { state: "not-installed" };
  else {
    const m = r.error || r.status !== 0 ? null : /\b(\d+\.\d+\.\d+)\b/.exec(r.stdout ?? "");
    status = !m ? { state: "unknown" } : isVerifiedVersion(m[1]) ? { state: "verified", version: m[1] } : { state: "different", version: m[1] };
  }
  return (installedCache = status);
}

/** The version stamp as data: what the output was checked against, and what is installed. */
export interface VersionStamp {
  verifiedOn: string;
  minimum: string;
  /** The same sentence validate prints. */
  line: string;
  installed: InstalledStatus;
  /** The mark validate and guard --check add; null when the installed version is on the verified list. */
  mark: string | null;
}

export function versionStamp(): VersionStamp {
  return { verifiedOn: VERIFIED_ON, minimum: MINIMUM_VERSION, line: verifiedOnLine(), installed: installedStatus(), mark: installedMark() };
}

/** The line validate and guard --check add about the installed Claude Code; null when it is on the verified list. */
export function installedMark(): string | null {
  const s = installedStatus();
  switch (s.state) {
    case "verified": return null;
    case "different": return `installed ${s.version}: unverified`;
    case "unknown": return "unknown version: unverified";
    case "not-installed": return "Claude Code not installed";
  }
}

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
  "CwdChanged", // in the per-event matcher table; missed until the snapshot test (N37)
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

/** Tool events: the ones a handler's `if` is read on, and whose matcher is a tool name. */
export const TOOL_EVENTS: ReadonlySet<string> = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "PermissionDenied"]);

/** The characters that keep a matcher an exact name or list (FileChanged and StopFailure allow fewer). */
function exactPath(event: string, matcher: string): boolean {
  return event === "FileChanged" || event === "StopFailure" ? /^[A-Za-z0-9_|]*$/.test(matcher) : /^[A-Za-z0-9_\- ,|]*$/.test(matcher);
}

/**
 * Whether `matcher` on `event` matches `value` (a tool name, an agent type, a
 * path), as the hooks docs state it: `*`, "" and no matcher match all; only
 * letters, digits, `_`, `-`, spaces, `,` and `|` mean an exact name or a list
 * split on `|` or `,`; anything else is a JavaScript regex tested unanchored.
 */
export function matcherMatches(event: string, matcher: string | undefined, value: string): boolean {
  const m = matcher ?? "";
  if (m === "" || m === "*") return true;
  if (exactPath(event, m)) return m.split(/[|,]/).map((x) => x.trim()).includes(value);
  try { return new RegExp(m).test(value); } catch { return false; }
}

/** Why a matcher can never match what it seems meant to, or null. */
export function matcherProblem(event: string, matcher: string | undefined): string | null {
  const m = matcher ?? "";
  if (m === "" || m === "*") return null;
  const rule = m.match(/^([A-Za-z][A-Za-z0-9_]*)\((.*)\)$/);
  if (rule) return `"${m}" is permission-rule syntax, but a matcher is tested against the tool name alone, so it never matches; write matcher: "${rule[1]}" and if: "${m}"`;
  if (/^mcp\./.test(m)) {
    const [server, ...tool] = m.slice(4).split(".");
    const t = tool.join(".");
    const fix = !t || t === "*" ? `mcp__${server}__.*` : `mcp__${server}__${t}`;
    return `"${m}" is the .at's dotted form, but a hook sees mcp__<server>__<tool>, so it never matches; write matcher: "${fix}"`;
  }
  if (/^mcp__[A-Za-z0-9_-]+$/.test(m) && !/^mcp__[^_].*__/.test(m) && exactPath(event, m)) {
    return `"${m}" names a server, not a tool, and is compared as an exact name, so it matches no tool; write matcher: "${m}__.*"`;
  }
  if (!exactPath(event, m)) {
    try { new RegExp(m); } catch (err) { return `"${m}" is read as a regex and does not compile (${(err as Error).message}), so it never matches`; }
  }
  return null;
}

export interface MatcherGap {
  /** The refuse hook whose matcher misses the tool. */
  hook: string;
  server: string;
  /** The tool's name as a hook sees it, mcp__<server>__<tool>. */
  tool: string;
}

interface GapHook { name: string; on: string; matcher?: string; strength?: string }
interface GapSource { hooks?: GapHook[]; nodes: Array<{ type: string; tools?: string[]; hooks?: GapHook[] }> }

/** `mcp.server.tool` as a hook sees it; null for wildcards and non-MCP tools. */
function concreteMcp(tool: string): string | null {
  const m = /^mcp\.([^.]+)\.(.+)$/.exec(tool);
  if (!m || m[2].includes("*")) return null;
  return `mcp__${m[1]}__${m[2]}`;
}

/**
 * Tools a refuse hook leaves open on a server it guards. A PreToolUse or
 * PermissionRequest hook that declares `strength: refuse` and matches at least
 * one tool of a server is held to every tool of that server the topology names
 * (an agent's `tools:`) or `extra` lists (the inventory's tool names). A tool
 * it does not match is a gap: the lock is on the door but not on this window.
 */
export function matcherGaps(ast: GapSource, extra: string[] = []): MatcherGap[] {
  const named = ast.nodes.flatMap((n) => (n.type === "agent" ? n.tools ?? [] : [])).map(concreteMcp).filter((t): t is string => !!t);
  const tools = [...new Set([...named, ...extra.filter((t) => t.startsWith("mcp__"))])].sort();
  const server = (t: string) => t.slice(5, t.indexOf("__", 5));
  const hooks = [...(ast.hooks ?? []), ...ast.nodes.flatMap((n) => n.hooks ?? [])]
    .filter((h) => h.strength === "refuse" && (h.on === "PreToolUse" || h.on === "PermissionRequest"));
  const gaps: MatcherGap[] = [];
  for (const h of hooks) {
    const guarded = new Set(tools.filter((t) => matcherMatches(h.on, h.matcher, t)).map(server));
    for (const t of tools) if (guarded.has(server(t)) && !matcherMatches(h.on, h.matcher, t)) gaps.push({ hook: h.name, server: server(t), tool: t });
  }
  return gaps;
}

/**
 * Live checks: what was measured on a real Claude Code, per version (N44b,
 * VO-323). A guard is graded `refuse` only on a version listed here.
 */
export const LIVE_CHECKS: ReadonlyArray<{ version: string; date: string; facts: readonly string[] }> = [
  {
    version: "2.1.323",
    date: "2026-11-13",
    facts: [
      "PreToolUse fires on the SendMessage tool, and exit code 2 blocks the call.",
      "`claude --agent X` resolves `.claude/agents/X/AGENT.md`.",
      "The SendMessage tool input carries the target as both `to` and `recipient`.",
    ],
  },
];

/**
 * Whether a PreToolUse hook on these tools is proven to refuse a call in the
 * installed Claude Code (N44b). Proven only on a version with a live check
 * (LIVE_CHECKS); on any other version, or none installed, `guard --check`
 * grades the talk and spawn guards `unverified`, never `refuse`.
 */
export function sessionHooksProven(): { sendMessage: boolean; agent: boolean } {
  const s = installedStatus();
  const ok = (s.state === "verified" || s.state === "different") && LIVE_CHECKS.some((c) => c.version === s.version);
  return { sendMessage: ok, agent: ok };
}

/** True when version a is lower than version b (x.y.z, numeric per part). */
export function versionBelow(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0);
  return false;
}

/** The first Claude Code release that reads a hook's `onFailure` field. */
export const ON_FAILURE_SINCE = "2.1.295";

/**
 * F-14: the scaffold marks every refusing PreToolUse hook (a `strength: refuse`
 * hook, the gate and approval guards, the session guards) `onFailure: "block"`.
 * A Claude Code older than 2.1.295 ignores the field, so such a hook that cannot
 * start or times out lets the call run. One warning when the Claude Code this
 * runs against (the installed one, or AGENTOPOLOGY_CLAUDE_VERSION) is older.
 */
export function onFailureWarnings(ast: TopologyAST): Array<{ rule: string; level: "warning"; message: string }> {
  const s = installedStatus();
  if (s.state !== "different" || !versionBelow(s.version, ON_FAILURE_SINCE)) return [];
  const hooks = [...(ast.hooks ?? []), ...ast.nodes.flatMap((n) => (n.type === "agent" ? (n as AgentNode).hooks ?? [] : []))];
  const refusing = hooks.filter((h) => h.strength === "refuse" && (h.on === "PreToolUse")).map((h) => `hook ${h.name}`);
  const guarded = ast.nodes.some((n) => (n.type === "gate" && (n as GateNode).behavior !== "advisory") || n.type === "human");
  if (refusing.length === 0 && !guarded) return [];
  const what = [...refusing, ...(guarded ? ["the gate and approval guards"] : [])].join(", ");
  return [{
    rule: "CC-onfailure",
    level: "warning",
    message: `Claude Code ${s.version} is older than ${ON_FAILURE_SINCE}, which ignores onFailure: "block", so ${what} let the call run when the hook cannot start or times out. Update Claude Code to ${ON_FAILURE_SINCE} or later.`,
  }];
}

/**
 * The tools that write a file, as a PreToolUse hook sees their names. The
 * record guards and the record rules read this list; no binding types its own
 * (Spec B). Whether the installed Claude Code still has `MultiEdit` is not
 * checked: a hook that matches a tool that no longer exists costs nothing,
 * one that misses a tool that does leaves a way in.
 */
export const FILE_WRITING_TOOLS: readonly string[] = ["Write", "Edit", "MultiEdit", "NotebookEdit"];
