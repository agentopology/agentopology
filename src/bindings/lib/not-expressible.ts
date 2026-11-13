/**
 * What the Codex binding cannot express (CX-23).
 *
 * A field on this list has no Codex config key and nothing in Codex enforces
 * it. The binding may still mention it in AGENTS.md as prose, but a prose line
 * is not a setting, so `validate` with a Codex target warns once per field.
 * The zero-drop test holds every field set in kitchen-sink.at to either
 * "found in the Codex output" or "on this list".
 *
 * @module
 */

import type { AgentNode, TopologyAST } from "../../parser/ast.js";

/** Where a field is set. */
export type NotExpressibleScope = "agent" | "defaults" | "topology";

export interface NotExpressible {
  scope: NotExpressibleScope;
  /** The AST field name. */
  field: string;
  /** Why Codex cannot take it. */
  reason: string;
}

const SAMPLING = "Codex config has no sampling or output-length key";

export const NOT_EXPRESSIBLE: readonly NotExpressible[] = [
  { scope: "agent", field: "temperature", reason: SAMPLING },
  { scope: "agent", field: "maxTokens", reason: SAMPLING },
  { scope: "agent", field: "topP", reason: SAMPLING },
  { scope: "agent", field: "topK", reason: SAMPLING },
  { scope: "agent", field: "stop", reason: SAMPLING },
  { scope: "agent", field: "seed", reason: SAMPLING },
  { scope: "agent", field: "thinkingBudget", reason: "Codex sets reasoning effort (low, medium, high, ...), not a token budget" },
  { scope: "agent", field: "outputFormat", reason: "Codex has no per-agent output format; `codex exec --output-schema` is a command flag" },
  { scope: "agent", field: "maxTurns", reason: "Codex has no per-agent turn limit" },
  { scope: "agent", field: "logLevel", reason: "Codex has no per-agent log level" },
  { scope: "agent", field: "fallbackChain", reason: "Codex has no model fallback chain" },
  { scope: "agent", field: "rateLimit", reason: "Codex has no rate-limit key" },
  { scope: "agent", field: "circuitBreaker", reason: "Codex has no circuit breaker" },
  { scope: "agent", field: "background", reason: "Codex has no background-agent switch" },
  { scope: "agent", field: "isolation", reason: "Codex agent files cannot set a sandbox or worktree per agent" },
  { scope: "defaults", field: "temperature", reason: SAMPLING },
  { scope: "defaults", field: "maxTokens", reason: SAMPLING },
  { scope: "defaults", field: "topP", reason: SAMPLING },
  { scope: "defaults", field: "topK", reason: SAMPLING },
  { scope: "defaults", field: "stop", reason: SAMPLING },
  { scope: "defaults", field: "seed", reason: SAMPLING },
  { scope: "defaults", field: "thinkingBudget", reason: "Codex sets reasoning effort, not a token budget" },
  { scope: "defaults", field: "outputFormat", reason: "Codex has no output format key" },
  { scope: "defaults", field: "logLevel", reason: "Codex has no log level key" },
  { scope: "topology", field: "providers", reason: "a project .codex/config.toml may not set model_providers; set them in your user config" },
  { scope: "topology", field: "fallback-chain", reason: "Codex has no model fallback chain" },
];

const isSet = (v: unknown): boolean => {
  if (v === undefined || v === null || v === false || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
};

/** One listed field that the topology sets, with where. */
export interface NotExpressibleHit extends NotExpressible { where: string[] }

/** The listed fields this topology sets, each with the nodes (or the topology) that set it. */
export function notExpressibleHits(ast: TopologyAST): NotExpressibleHit[] {
  const hits: NotExpressibleHit[] = [];
  for (const item of NOT_EXPRESSIBLE) {
    let where: string[] = [];
    if (item.scope === "agent") {
      where = ast.nodes
        .filter((n) => n.type === "agent" && isSet((n as unknown as Record<string, unknown>)[item.field]))
        .map((n) => (n as AgentNode).id);
    } else if (item.scope === "defaults") {
      if (isSet((ast.defaults as unknown as Record<string, unknown> | undefined)?.[item.field])) where = ["defaults"];
    } else if (item.field === "providers") {
      if (isSet(ast.providers)) where = ["topology"];
    } else if (isSet(ast.settings?.[item.field])) {
      where = ["topology"];
    }
    if (where.length > 0) hits.push({ ...item, where });
  }
  return hits;
}

/** True when the job's agent writes files (a `writes` list, or a Write/Edit tool). */
function agentWrites(agent: AgentNode | undefined): boolean {
  if (!agent) return false;
  return (agent.writes?.length ?? 0) > 0 || (agent.tools ?? []).some((t) => t === "Write" || t === "Edit");
}

/** True when the topology or the job's agent names a sandbox: `settings.sandbox`, the codex extension, or the agent's `sandbox`. */
export function hasSandboxWord(ast: TopologyAST, agent?: AgentNode): boolean {
  const ext = (ast.settings?.extensions as Record<string, Record<string, unknown>> | undefined)?.codex ?? (ast.extensions?.codex as Record<string, unknown> | undefined);
  return ast.settings?.sandbox != null || ext?.sandbox_type != null || ext?.["sandbox-type"] != null || agent?.sandbox != null;
}

/** Jobs Codex runs through `codex exec` (carrier cron or none, an agent target). */
export function execJobs(ast: TopologyAST): { id: string; agent: AgentNode }[] {
  const out: { id: string; agent: AgentNode }[] = [];
  for (const j of ast.schedules ?? []) {
    if (j.carrier !== undefined && j.carrier !== "cron") continue;
    const agent = ast.nodes.find((n) => n.type === "agent" && n.id === j.agent) as AgentNode | undefined;
    if (agent) out.push({ id: j.id, agent });
  }
  return out;
}

/** Exec jobs whose agent writes while no sandbox is named: `codex exec` is read-only by default. */
export function writingJobsWithoutSandbox(ast: TopologyAST): string[] {
  return execJobs(ast).filter((j) => agentWrites(j.agent) && !hasSandboxWord(ast, j.agent)).map((j) => j.id);
}
