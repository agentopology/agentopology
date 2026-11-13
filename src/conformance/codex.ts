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
      }
    });
  }
  return out;
}
