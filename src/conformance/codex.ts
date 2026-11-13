/**
 * Codex CLI's hook and config contract, as its docs state it.
 *
 * Facts measured on Codex CLI 0.156.1 and on learn.chatgpt.com/docs (read
 * 2026-11-13). spec/codex/*.json are the same facts as snapshots:
 * e2e/codex-contract.test.ts holds these constants to them, and
 * scripts/codex-drift.mjs holds the snapshot to the live page.
 *
 * @module
 */

import { spawnSync } from "node:child_process";

/** The Codex CLI version this contract was last checked against. */
export const VERIFIED_ON = "0.156.1";

/** The oldest Codex the output supports. Equal to VERIFIED_ON until the first version with stable, default-on hooks is looked up. */
export const MINIMUM_VERSION = "0.156.1";

/** The one line the CLI prints about what the output was checked against. */
export function verifiedOnLine(): string {
  return `checked against Codex CLI ${VERIFIED_ON} (supports ${MINIMUM_VERSION} and later)`;
}

export type InstalledStatus =
  | { state: "verified"; version: string }
  | { state: "different"; version: string }
  | { state: "unknown" }
  | { state: "not-installed" };

let installedCache: InstalledStatus | undefined;

/** Classify the text `codex --version` prints. */
export function parseInstalled(stdout: string): InstalledStatus {
  const m = /codex-cli (\d+\.\d+\.\d+)/.exec(stdout);
  if (!m) return { state: "unknown" };
  return m[1] === VERIFIED_ON ? { state: "verified", version: m[1] } : { state: "different", version: m[1] };
}

/**
 * What `codex --version` says (3 s timeout), read at most once per process.
 * A timeout or unparsable output is "unknown"; no `codex` on PATH is
 * "not-installed". AGENTOPOLOGY_CODEX_VERSION=<x.y.z> or `none` stands in
 * for the installed version without running `codex`.
 */
export function installedStatus(): InstalledStatus {
  if (installedCache) return installedCache;
  const forced = process.env.AGENTOPOLOGY_CODEX_VERSION;
  if (forced !== undefined && forced !== "") {
    if (forced === "none") return (installedCache = { state: "not-installed" });
    return (installedCache = parseInstalled(`codex-cli ${forced}`));
  }
  const r = spawnSync("codex", ["--version"], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return (installedCache = { state: "not-installed" });
  return (installedCache = r.error || r.status !== 0 ? { state: "unknown" } : parseInstalled(r.stdout ?? ""));
}

/** The mark added about the installed Codex; null when it is VERIFIED_ON. */
export function installedMark(): string | null {
  const s = installedStatus();
  switch (s.state) {
    case "verified": return null;
    case "different": return `installed ${s.version}: unverified`;
    case "unknown": return "unknown version: unverified";
    case "not-installed": return "Codex CLI not installed";
  }
}

/** Every hook event the docs list (14). A hook on any other name never fires. */
export const HOOK_EVENTS: ReadonlySet<string> = new Set([
  "PreToolUse", "PermissionRequest", "PostToolUse", "PreCompact", "PostCompact",
  "UserPromptSubmit", "SubagentStop", "Stop", "PreModelRequest", "PostModelRequest",
  "Interrupt", "SessionStart", "SubagentStart", "SessionEnd",
]);

/** Events whose matcher is ignored. */
export const NO_MATCHER_EVENTS: ReadonlySet<string> = new Set([
  "UserPromptSubmit", "Stop", "Interrupt", "PreModelRequest", "PostModelRequest",
]);

/** Handler types that run. */
export const RUNNING_HANDLERS: ReadonlySet<string> = new Set(["command", "mcp_tool"]);

/** Handler types that are parsed and skipped. */
export const SKIPPED_HANDLERS: ReadonlySet<string> = new Set(["prompt", "agent"]);

/** Events where exit 2 blocks. */
export const BLOCKING_EVENTS: ReadonlySet<string> = new Set(["PreToolUse", "UserPromptSubmit"]);

/** `permissionDecision` values a PreToolUse hook may give; `ask` is unsupported and fails the hook run. */
export const PRE_TOOL_DECISIONS: ReadonlySet<string> = new Set(["allow", "deny"]);

/** `approval_policy` values Codex 0.156.1 takes (also `{ granular = {...} }`). */
export const APPROVAL_POLICIES: ReadonlySet<string> = new Set(["on-request", "never"]);

/** `sandbox_mode` values. */
export const SANDBOX_MODES: ReadonlySet<string> = new Set(["read-only", "workspace-write", "danger-full-access"]);

/**
 * Keys a project `.codex/config.toml` cannot set; Codex ignores them with a warning.
 * TODO: the 4 URL keys are named on learn.chatgpt.com/docs/config-file/config-advanced.md,
 * which was unreachable when this was written. Add them from that page.
 */
export const PROJECT_FORBIDDEN_KEYS: readonly string[] = [
  "model_provider", "model_providers", "notify", "profile", "profiles", "otel",
];

/** True for a Claude model name: opus, sonnet, haiku, fable or anything starting `claude-`. Codex runs none of them. */
export function isClaudeModelName(model: string): boolean {
  return /^(opus|sonnet|haiku|fable)(\b|[-_.\d])/i.test(model) || /^claude[-_]/i.test(model);
}

/** What a live run has proven. All false until tier E records a dated run. */
export const CODEX_HOOKS_PROVEN = {
  bash: false, applyPatch: false, mcp: false, spawn: false, queue: false, subagentStop: false,
} as const;

/**
 * Why a hook matcher can never match what it seems meant to, or null.
 * A Codex hook sees an MCP tool as `mcp__<server>__<tool>`; the .at's dotted
 * `mcp.server.tool` never matches. On the events that ignore a matcher, any
 * matcher is dead text. Otherwise a matcher is a regex.
 */
export function matcherProblem(event: string, matcher: string | undefined): string | null {
  const m = matcher ?? "";
  if (m === "" || m === "*") return null;
  if (NO_MATCHER_EVENTS.has(event)) return `${event} ignores its matcher "${m}", so it narrows nothing`;
  if (/^mcp\./.test(m)) {
    const [server, ...tool] = m.slice(4).split(".");
    const t = tool.join(".");
    const fix = !t || t === "*" ? `mcp__${server}__.*` : `mcp__${server}__${t}`;
    return `"${m}" is the .at's dotted form, but a Codex hook sees mcp__<server>__<tool>, so it never matches; write matcher: "${fix}"`;
  }
  try { new RegExp(m); } catch (err) { return `"${m}" is read as a regex and does not compile (${(err as Error).message}), so it never matches`; }
  return null;
}

/** What an anchored repository-root expression looks like in a hook command. */
const ROOT_EXPR = /["']?\$\(git rev-parse --show-toplevel[^)]*\)["']?/g;

/**
 * The script a command hook runs by a path that does not start at the
 * repository root or at `/`, or null. A hook runs in the session's current
 * directory (a subfolder, once Codex has moved), so a relative path is not
 * found; exit 127 does not block on PreToolUse (probe P10).
 */
export function unanchoredScript(command: string): string | null {
  const text = command.replace(ROOT_EXPR, "/ROOT");
  const script = text.trim().split(/\s+/).map((p) => p.replace(/^["']|["']$/g, "")).find((p) => /\.(sh|py|js|mjs|ts)$/.test(p));
  if (!script) return null;
  if (script.startsWith("/") || script.startsWith("$HOME") || script.startsWith("~/")) return null;
  return script;
}

/** A planted-check finding. */
export interface Violation { check: string; where: string; message: string }

/**
 * Check a hooks.json (parsed) against the contract: unknown event, matcher
 * on a no-matcher event, handler type that does not run.
 */
export function checkHooks(hooksJson: unknown): Violation[] {
  const out: Violation[] = [];
  const hooks = (hooksJson as { hooks?: Record<string, unknown> } | null)?.hooks;
  if (!hooks || typeof hooks !== "object") return out;
  for (const [event, entries] of Object.entries(hooks)) {
    if (!HOOK_EVENTS.has(event)) {
      out.push({ check: "unknown-event", where: event, message: `"${event}" is not a Codex hook event; it never fires` });
    }
    if (!Array.isArray(entries)) continue;
    entries.forEach((entry: any, i: number) => {
      const where = `${event}[${i}]`;
      if (entry?.matcher !== undefined && entry.matcher !== "" && NO_MATCHER_EVENTS.has(event)) {
        out.push({ check: "matcher-ignored", where, message: `${event} ignores its matcher` });
      }
      for (const h of Array.isArray(entry?.hooks) ? entry.hooks : []) {
        if (typeof h?.type === "string" && !RUNNING_HANDLERS.has(h.type)) {
          out.push({
            check: "handler-not-run", where,
            message: SKIPPED_HANDLERS.has(h.type) ? `a "${h.type}" handler is parsed and skipped` : `unknown handler type "${h.type}"`,
          });
        }
        if (h && "timeout" in h) {
          const t = h.timeout;
          if (typeof t !== "number" || !Number.isFinite(t) || t <= 0) {
            out.push({ check: "timeout", where, message: `timeout is a number of seconds above 0 (the default is 600) (got ${JSON.stringify(t)})` });
          }
        }
        if (h?.type === "command" && typeof h.command === "string") {
          const loose = unanchoredScript(h.command);
          if (loose) {
            out.push({ check: "unanchored-script", where, message: `the script "${loose}" is a relative path; a hook runs in the session's directory, which moves, so it is not found (exit 127 lets the command run)` });
          }
        }
      }
    });
  }
  return out;
}


/**
 * The JSON a Codex hook gets on stdin for an event (docs read 2026-11-13).
 * Common: session_id, transcript_path, cwd, hook_event_name, model.
 * PreToolUse adds turn_id, tool_name, tool_use_id, tool_input, permission_mode.
 * Tool names as measured (probes P2, P3): Bash, apply_patch (patch text in
 * tool_input.command), collaborationspawn_agent (task_name, agent_type, message, fork_turns).
 */
export function payloadFor(event: string, cwd: string, matcher?: string): Record<string, unknown> {
  const common = { session_id: "conformance", transcript_path: "/dev/null", cwd, hook_event_name: event, model: "gpt-5.2" };
  const tool = matcher && !/[|*.()[\]^$+?\\]/.test(matcher) ? matcher : "Bash";
  const toolInput = tool === "collaborationspawn_agent"
    ? { task_name: "conformance", agent_type: "conformance-agent", message: "gAAAAA", fork_turns: "none" }
    : tool === "apply_patch"
      ? { command: `*** Begin Patch\n*** Add File: ${cwd}/x.md\n+x\n*** End Patch` }
      : { command: "true" };
  switch (event) {
    case "PreToolUse":
    case "PermissionRequest":
      return { ...common, turn_id: "u1", tool_name: tool, tool_use_id: "t1", tool_input: toolInput, permission_mode: "default" };
    case "PostToolUse":
      return { ...common, turn_id: "u1", tool_name: tool, tool_use_id: "t1", tool_input: toolInput, tool_response: "Exit code: 0", permission_mode: "default" };
    case "SubagentStart":
    case "SubagentStop":
      return { ...common, agent_id: "a1", agent_type: matcher && !/[|*.()[\]^$+?\\]/.test(matcher) ? matcher : "conformance-agent", stop_hook_active: false, agent_transcript_path: "/dev/null", last_assistant_message: "done" };
    case "Stop":
      return { ...common, stop_hook_active: false, last_assistant_message: "done" };
    case "UserPromptSubmit":
      return { ...common, prompt: "hello" };
    case "SessionStart":
      return { ...common, source: "startup" };
    default:
      return common;
  }
}

/**
 * Check a hook's stdout on exit 0. Plain text is fine. JSON must parse; on
 * PreToolUse a permissionDecision may be allow or deny, and "ask" is
 * unsupported (it makes the hook run fail).
 */
export function checkStdout(event: string, stdout: string): string | null {
  const s = stdout.trim();
  if (event === "PreToolUse" && /["']?permissionDecision["']?\s*[:=]\s*["']ask["']/.test(s)) {
    return 'permissionDecision "ask" is unsupported on a Codex PreToolUse hook; the hook run fails';
  }
  if (!(s.startsWith("{") && s.endsWith("}"))) return null;
  let json: Record<string, any>;
  try { json = JSON.parse(s); } catch { return "stdout looks like JSON but does not parse"; }
  if (event === "PreToolUse") {
    const d = json.hookSpecificOutput?.permissionDecision ?? json.permissionDecision;
    if (d !== undefined && !PRE_TOOL_DECISIONS.has(d)) return `permissionDecision "${d}" is not allow or deny`;
  }
  return null;
}

/** The shape of spec/codex/config-keys.json that the checks read. */
export interface ConfigKeySnapshot {
  keys: string[];
  projectForbidden: string[];
  approvalPolicies: string[];
  sandboxModes: string[];
  agentFileKeys: { required: string[]; optional: string[]; ignoredInAgentFile: string[] };
}

type Toml = Record<string, unknown>;
const isTable = (v: unknown): v is Toml => v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date);

/** Tables whose children are user-chosen names or free text, so the walk stops at them. */
const OPAQUE = [/^mcp_servers\.[^.]+\.env$/, /^mcp_servers\.[^.]+\.http_headers$/, /^model_providers\.[^.]+$/, /^profiles\.[^.]+$/, /^hooks$/, /^projects$/, /^otel$/, /^features$/];

/** Every key of a parsed config as a dotted path, stopping at opaque tables. */
export function configKeyPaths(parsed: Toml, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(parsed)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (isTable(v) && !OPAQUE.some((re) => re.test(path))) {
      const inner = configKeyPaths(v, path);
      out.push(...(inner.length ? inner : [path]));
    } else out.push(path);
  }
  return out;
}

/** True when `path` fits a snapshot pattern (`<id>` stands for any one segment). */
function matchesPattern(path: string, patterns: string[]): boolean {
  const p = path.split(".");
  return patterns.some((pat) => {
    const q = pat.split(".");
    return q.length === p.length && q.every((seg, i) => (seg.startsWith("<") && seg.endsWith(">")) || seg === p[i]);
  });
}

/**
 * Tier A: a generated `.codex/config.toml` against the key snapshot. Unknown
 * key, a key that sits in the wrong table, a key a project config may not
 * set, an approval policy or sandbox mode Codex does not take.
 */
export function checkConfigToml(parsed: Toml, snap: ConfigKeySnapshot): Violation[] {
  const out: Violation[] = [];
  const top = new Set(snap.keys.filter((k) => !k.includes(".")));
  for (const path of configKeyPaths(parsed)) {
    const root = path.split(".")[0];
    if (snap.projectForbidden.includes(root)) {
      out.push({ check: "project-forbidden-key", where: path, message: `a project .codex/config.toml may not set ${root}; Codex ignores it with a warning` });
      continue;
    }
    if (matchesPattern(path, snap.keys) || (root === "features" && path === "features")) continue;
    const leaf = path.split(".").pop()!;
    if (path.includes(".") && top.has(leaf)) {
      out.push({ check: "wrong-table", where: path, message: `${leaf} is a top-level key, but it sits inside [${path.slice(0, path.length - leaf.length - 1)}]` });
    } else {
      out.push({ check: "unknown-key", where: path, message: `${path} is not a key of the Codex 0.156.1 config reference` });
    }
  }
  if (typeof parsed.approval_policy === "string" && !snap.approvalPolicies.includes(parsed.approval_policy)) {
    out.push({ check: "approval-policy", where: "approval_policy", message: `"${parsed.approval_policy}" is not one of ${snap.approvalPolicies.join(", ")}` });
  }
  if (typeof parsed.sandbox_mode === "string" && !snap.sandboxModes.includes(parsed.sandbox_mode)) {
    out.push({ check: "sandbox-mode", where: "sandbox_mode", message: `"${parsed.sandbox_mode}" is not one of ${snap.sandboxModes.join(", ")}` });
  }
  return out;
}

/** Tier A: a generated `.codex/agents/<name>.toml` against the agent-file key list. */
export function checkAgentToml(parsed: Toml, snap: ConfigKeySnapshot): Violation[] {
  const out: Violation[] = [];
  const { required, optional, ignoredInAgentFile } = snap.agentFileKeys;
  for (const k of required) if (parsed[k] === undefined) out.push({ check: "agent-required-key", where: k, message: `an agent file needs ${k}` });
  const allowed = new Set([...required, ...optional]);
  const paths = configKeyPaths(parsed).flatMap((p) => (p === "features" && isTable(parsed.features) ? Object.keys(parsed.features).map((f) => `features.${f}`) : [p]));
  for (const path of paths) {
    const root = path.split(".")[0];
    if (ignoredInAgentFile.includes(root)) {
      out.push({ check: "agent-ignored-key", where: path, message: `${root} does not override the parent configuration inside an agent file, so it does nothing` });
    } else if (!allowed.has(path)) {
      out.push({ check: "agent-unknown-key", where: path, message: `${path} is not a key of an agent file` });
    }
  }
  return out;
}
