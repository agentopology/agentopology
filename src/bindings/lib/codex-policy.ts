/**
 * The project's Codex approval policy and sandbox mode, as the binding writes
 * them to `.codex/config.toml`. Shared by the binding and by `validate`
 * (R-11 needs to know whether the model can write `.codex/`).
 *
 * @module
 */

import type { AgentNode, HumanNode, TopologyAST } from "../../parser/ast.js";
import { approvalTargets } from "./guards.js";

/** Permission words that mean "never ask": Codex `never`. */
export const NEVER_ASK = new Set(["never", "unrestricted", "full-auto", "bypassPermissions"]);

/**
 * Map topology permission strings to Codex approval_policy values.
 *
 * Codex 0.156.1 takes `on-request` and `never` (and a `granular` table).
 * `untrusted` is unsupported and `on-failure` is deprecated, so every word
 * that is not "never ask" becomes `on-request`, the policy that still asks.
 */
export function mapApprovalPolicy(perm: string): string {
  return NEVER_ASK.has(perm) ? "never" : "on-request";
}

/**
 * One approval policy for the whole project: Codex has one per config, not
 * one per agent. The strictest agent wins (`on-request` over `never`).
 */
export function projectApprovalPolicy(agents: AgentNode[]): string {
  const policies = agents.map((a) => mapApprovalPolicy(a.permissions ?? "autonomous"));
  if (policies.length === 0) return "on-request";
  return policies.includes("on-request") ? "on-request" : "never";
}

/**
 * Map generic sandbox mode strings to Codex sandbox values.
 * Codex supports: "read-only", "workspace-write", "danger-full-access"
 */
export function mapSandboxMode(mode: string): string {
  // Pass through native Codex values
  const nativeValues = ["read-only", "workspace-write", "danger-full-access"];
  if (nativeValues.includes(mode)) return mode;

  switch (mode) {
    case "docker":
    case "container":
    case "strict":
      return "read-only";
    case "write":
    case "workspace":
      return "workspace-write";
    case "none":
    case "disabled":
    case "off":
      return "danger-full-access";
    default:
      return "read-only"; // safe default
  }
}

/**
 * Derive sandbox type from topology permissions.
 * More restrictive permissions suggest sandboxing.
 */
export function deriveSandboxType(ast: TopologyAST): string | null {
  const agents = ast.nodes.filter((n) => n.type === "agent") as AgentNode[];
  const hasUnrestricted = agents.some(
    (a) =>
      a.permissions === "unrestricted" ||
      a.permissions === "full-auto" ||
      a.permissions === "bypassPermissions"
  );
  // If any agent is unrestricted, no sandbox (user opted out of restrictions)
  if (hasUnrestricted) return "danger-full-access";
  // Default: no explicit sandbox section needed
  return null;
}

/**
 * Extract codex-specific extension fields from the topology level.
 * Checks settings.extensions["codex"] and any top-level extension block.
 */
export function getTopologyExtensions(
  ast: TopologyAST
): Record<string, unknown> | null {
  const settingsExt = ast.settings?.extensions as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (settingsExt?.codex) return settingsExt.codex;
  // Also check top-level ast.extensions["codex"]
  if (ast.extensions?.codex) return ast.extensions.codex as Record<string, unknown>;
  return null;
}

/** The project sandbox_mode the binding writes: the settings field, then the extension, then derived (null: none written). */
export function projectSandboxMode(ast: TopologyAST): string | null {
  const ext = getTopologyExtensions(ast);
  const top = ast.settings?.sandbox;
  if (top != null) return typeof top === "boolean" ? (top ? "read-only" : "danger-full-access") : mapSandboxMode(String(top));
  const fromExt = ext?.sandbox_type ?? ext?.["sandbox-type"];
  return fromExt != null ? String(fromExt) : deriveSandboxType(ast);
}

/**
 * R-11: why a human approval step cannot hold on Codex, or null. The approval
 * is a line in `.codex/state/approvals.jsonl`. Under `workspace-write` Codex
 * keeps `.codex/` read-only for the agent (measured on 0.156.1); under
 * `danger-full-access`, or with no sandbox written and `approval_policy =
 * "never"`, nothing stops the model from writing that line itself.
 */
export function humanGateForgeable(ast: TopologyAST): string | null {
  const humans = ast.nodes.filter((n) => n.type === "human" && approvalTargets(ast, n as HumanNode).length > 0);
  if (humans.length === 0) return null;
  const agents = ast.nodes.filter((n) => n.type === "agent") as AgentNode[];
  const sandbox = projectSandboxMode(ast);
  const policy = projectApprovalPolicy(agents);
  if (sandbox === "danger-full-access") return `sandbox_mode is "danger-full-access"`;
  if (sandbox === null && policy === "never") return `no sandbox_mode is written and approval_policy is "never"`;
  return null;
}
