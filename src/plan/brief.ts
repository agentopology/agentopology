/**
 * The execution brief — what `agentopology plan` hands to a host coding agent.
 *
 * WHY MARKDOWN
 * ------------
 * The consumer is a language model, on three different vendors. Markdown is
 * what every binding already emits and what a model acts on without a parse
 * step; JSON costs more tokens for identical content and invites the model to
 * summarize the document rather than execute it. A machine format already
 * exists for programs: `agentopology export --format json`.
 *
 * TWO LAYERS
 * ----------
 * `buildExecutionBrief` computes a typed structure; `renderBriefMarkdown` is
 * the only renderer that ships. A `--json` twin, if one is ever needed, is
 * `JSON.stringify` of the same structure — so the two can never drift.
 *
 * WHAT IT IS NOT
 * --------------
 * Not a translation. `.at` is already agent-readable and `exporters/markdown`
 * already renders it for humans. This resolves what a host would otherwise
 * have to guess: order, handoffs, what must stay blind, gate tiers, loop
 * budgets, and which declarations cannot be honoured without files.
 *
 * @module
 */

import type {
  TopologyAST,
  AgentNode,
  GateNode,
  NodeDef,
  EdgeDef,
} from "../parser/ast.js";
import { resolveDefaults, type ResolvedDefault } from "../resolve/defaults.js";
import { resolveOrder, type OrderStep, type LoopInfo } from "../resolve/order.js";

/** Autonomy notch. Governs approval before the run and announcements during it. */
export type Autonomy = "plan" | "execute" | "auto";

/**
 * Gate enforcement tiers, strongest first. Tier is chosen by what the host
 * platform actually offers, not by preference.
 */
export type GateTier =
  | "preventive" // tool allowlist. Needs a file. Unavailable in interpreted mode.
  | "enforced" // hook, exit code 2. Needs a file. Unavailable in interpreted mode.
  | "fileless-verify" // Workflow script. Claude Code only.
  | "evidence-orchestrator" // the host runs the check and reads the exit code.
  | "evidence-agent" // the agent runs it and reports the exit code.
  | "advisory"; // declared advisory. Records, never blocks.

/** One resolved handoff across a flow edge. */
export interface Handoff {
  from: string;
  to: string;
  /** `writer.writes ∩ reader.reads` — what actually crosses. */
  passes: string[];
  /** The rest of the writer's `writes` — deliberately not offered to the reader. */
  withholds: string[];
}

/** Two roles in the same step with no edge between them. */
export interface BlindPair {
  step: number;
  a: string;
  b: string;
}

export interface GatePlan {
  id: string;
  after?: string;
  before?: string;
  tier: GateTier;
  /** The command, when the tier can run one. */
  run?: string;
  blocking: boolean;
  onFail: string;
}

export interface Unenforceable {
  node: string;
  field: string;
  declared: unknown;
}

/** An ambiguity the planner can detect before the run, so the guess is reviewable. */
export interface PreflaggedAmbiguity {
  kind: string;
  at: { section: string; node?: string; edge?: string };
  question: string;
  alternatives: string[];
  /** A concrete `.at` edit that removes the ambiguity. This is the payoff. */
  fix: string;
}

export interface RoleCard {
  id: string;
  model?: string;
  isolation?: string;
  /** Authored prompt, or null when the topology only gave a role/description. */
  prompt: string | null;
  role: string;
  reads: string[];
  writes: string[];
  /** Paths this role writes that its downstream readers must NOT be offered. */
  withheld: string[];
  /** Sibling ids in the same step it must stay blind to. */
  blindTo: string[];
  outputs: Record<string, string[]>;
  /** Declared tool restriction, which cannot be applied at runtime. */
  declaredTools?: string[];
  fileless: boolean;
}

export interface ExecutionBrief {
  topology: string;
  version: string;
  source: string;
  autonomy: Autonomy;
  ambiguityLog: string | null;
  /** Validation errors. A non-empty list means the brief must not be enacted. */
  errors: Array<{ rule: string; message: string; node?: string }>;
  steps: OrderStep[];
  /** `reads` paths no node produces. They must exist before step 1. */
  preconditions: string[];
  roles: RoleCard[];
  handoffs: Handoff[];
  blindPairs: BlindPair[];
  routes: Array<{ from: string; key: string; edges: EdgeDef[] }>;
  loops: LoopInfo[];
  gates: GatePlan[];
  unenforceable: Unenforceable[];
  /** Which of the five inherently-persistent features this topology declares. */
  persistent: Array<{ feature: string; count: number }>;
  preflagged: PreflaggedAmbiguity[];
  defaultsApplied: ResolvedDefault[];
  orchestrator: string | null;
}

export interface BriefOptions {
  autonomy?: Autonomy;
  source?: string;
  ambiguityLog?: string | null;
  /** Validation results, so the brief can refuse to be enacted on errors. */
  errors?: Array<{ rule: string; message: string; node?: string }>;
}

// ---------------------------------------------------------------------------
// Computation
// ---------------------------------------------------------------------------

function agentsOf(ast: TopologyAST): AgentNode[] {
  return ast.nodes.filter((n): n is AgentNode => n.type === "agent");
}

/** Choose the strongest gate tier available in interpreted mode. */
function gateTier(gate: GateNode): GateTier {
  // An advisory gate never blocks, whatever mechanism is available.
  if (gate.behavior === "advisory") return "advisory";
  // Tiers 1 and 2 (tool allowlist, hook exit 2) both require files, so they are
  // unreachable here by construction. Tier 3 needs a Workflow phase. That
  // leaves the evidence contract, which is the only portable fileless tier.
  if (gate.run) return "evidence-orchestrator";
  return "evidence-agent";
}

/** The five features that are platform registrations, not steps in a run. */
function persistentFeatures(ast: TopologyAST): Array<{ feature: string; count: number }> {
  const out: Array<{ feature: string; count: number }> = [];
  const push = (feature: string, count: number) => {
    if (count > 0) out.push({ feature, count });
  };

  push("triggers / slash commands", ast.triggers?.length ?? 0);
  push("schedules / cron", ast.schedules?.length ?? 0);
  push("mcp-servers", Object.keys(ast.mcpServers ?? {}).length);

  const agentHooks = agentsOf(ast).reduce((n, a) => n + (a.hooks?.length ?? 0), 0);
  push("hooks", (ast.hooks?.length ?? 0) + agentHooks);

  const restricted = agentsOf(ast).filter(
    (a) => a.tools?.length || a.disallowedTools?.length || a.mcpServers?.length
  ).length;
  push("per-agent tools / permissions", restricted);

  return out;
}

function computeHandoffs(ast: TopologyAST): Handoff[] {
  const byId = new Map<string, NodeDef>(ast.nodes.map((n) => [n.id, n]));
  const out: Handoff[] = [];

  // Deduped by pair: two conditional edges between the same roles are one
  // handoff, not two. The condition is control flow (§5), not information flow.
  const seen = new Set<string>();

  for (const edge of ast.edges) {
    if (edge.isError) continue;
    const key = `${edge.from} ${edge.to}`;
    if (seen.has(key)) continue;
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (from?.type !== "agent" || to?.type !== "agent") continue;
    seen.add(key);

    const writes = (from as AgentNode).writes ?? [];
    const reads = new Set((to as AgentNode).reads ?? []);
    const passes = writes.filter((w) => reads.has(w));
    const withholds = writes.filter((w) => !reads.has(w));
    out.push({ from: edge.from, to: edge.to, passes, withholds });
  }
  return out;
}

function computeBlindPairs(steps: OrderStep[], ast: TopologyAST): BlindPair[] {
  const linked = new Set(ast.edges.flatMap((e) => [`${e.from} ${e.to}`, `${e.to} ${e.from}`]));
  const out: BlindPair[] = [];
  for (const step of steps) {
    if (step.ids.length < 2) continue;
    for (let i = 0; i < step.ids.length; i++) {
      for (let j = i + 1; j < step.ids.length; j++) {
        const [a, b] = [step.ids[i], step.ids[j]];
        if (!linked.has(`${a} ${b}`)) out.push({ step: step.index, a, b });
      }
    }
  }
  return out;
}

function computePreconditions(ast: TopologyAST): string[] {
  const produced = new Set(agentsOf(ast).flatMap((a) => a.writes ?? []));
  const needed = new Set(agentsOf(ast).flatMap((a) => a.reads ?? []));
  return [...needed].filter((p) => !produced.has(p)).sort();
}

function computeRoutes(ast: TopologyAST): Array<{ from: string; key: string; edges: EdgeDef[] }> {
  const byFrom = new Map<string, EdgeDef[]>();
  for (const e of ast.edges) {
    if (!e.condition) continue;
    if (!byFrom.has(e.from)) byFrom.set(e.from, []);
    byFrom.get(e.from)!.push(e);
  }
  return [...byFrom.entries()].map(([from, edges]) => {
    // `[when x.y == v]` — the key is the output name after the dot.
    const m = /([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_-]+)/.exec(edges[0].condition ?? "");
    return { from, key: m?.[2] ?? "?", edges };
  });
}

function computeUnenforceable(ast: TopologyAST): Unenforceable[] {
  const out: Unenforceable[] = [];
  for (const a of agentsOf(ast)) {
    if (a.tools?.length) out.push({ node: a.id, field: "tools", declared: a.tools });
    if (a.disallowedTools?.length)
      out.push({ node: a.id, field: "disallowed-tools", declared: a.disallowedTools });
    if (a.mcpServers?.length)
      out.push({ node: a.id, field: "mcp-servers", declared: a.mcpServers });
  }
  return out;
}

function computePreflagged(
  ast: TopologyAST,
  handoffs: Handoff[],
  unenforceable: Unenforceable[],
  persistent: Array<{ feature: string; count: number }>
): PreflaggedAmbiguity[] {
  const out: PreflaggedAmbiguity[] = [];

  // An agent with no authored prompt: its whole instruction set is its role line.
  for (const a of agentsOf(ast)) {
    if (!a.prompt) {
      out.push({
        kind: "prompt-missing",
        at: { section: "3", node: a.id },
        question: `"${a.id}" declares no prompt block; its instructions are its role line alone.`,
        alternatives: ["compose from role + reads/writes", "ask the human for intent"],
        fix: `add a prompt { } block to agent ${a.id}`,
      });
    }
  }

  // A live edge across which nothing crosses: the host must invent the handoff.
  for (const h of handoffs) {
    if (h.passes.length === 0) {
      out.push({
        kind: "handoff-overlap-empty",
        at: { section: "4", edge: `${h.from}->${h.to}` },
        question: `${h.from}.writes and ${h.to}.reads do not overlap; nothing is declared to cross this edge.`,
        alternatives: [
          "pass the writer's output text inline",
          `add one of ${h.from}'s writes to ${h.to}.reads`,
        ],
        fix: `add a shared path to agent ${h.to} reads:`,
      });
    }
  }

  // A gate that is both advisory and asks to bounce back is self-contradictory.
  for (const g of ast.nodes.filter((n): n is GateNode => n.type === "gate")) {
    if (g.behavior === "advisory" && g.onFail && g.onFail !== "continue") {
      out.push({
        kind: "gate-conflict-resolved",
        at: { section: "7", node: g.id },
        question: `gate "${g.id}" is advisory but declares on-fail: ${g.onFail}. Advisory wins; on-fail is ignored.`,
        alternatives: ["treat as blocking", "treat as advisory"],
        fix: `remove behavior: advisory from gate ${g.id}, or set on-fail: continue`,
      });
    }
  }

  if (unenforceable.length) {
    const nodes = [...new Set(unenforceable.map((u) => u.node))];
    out.push({
      kind: "tool-restriction-unenforced",
      at: { section: "8" },
      question: `${nodes.length} role(s) declare tool or MCP restrictions the host cannot set inline.`,
      alternatives: ["spawn unrestricted and restate as a prompt contract", "scaffold instead"],
      fix: "agentopology scaffold <file> --target claude-code",
    });
  }

  if (persistent.length) {
    out.push({
      kind: "persistent-feature-ignored",
      at: { section: "9" },
      question: `${persistent.length} inherently-persistent feature(s) declared; they cannot run fileless.`,
      alternatives: ["run the rest and name them", "scaffold instead"],
      fix: "agentopology scaffold <file>",
    });
  }

  return out;
}

/**
 * Build the execution brief structure for a topology.
 *
 * @param rawAst - A parsed topology. Defaults are resolved internally.
 * @param opts - Autonomy notch, source path, log path, validation results.
 * @returns The typed brief. Render it with {@link renderBriefMarkdown}.
 */
export function buildExecutionBrief(rawAst: TopologyAST, opts: BriefOptions = {}): ExecutionBrief {
  const { ast, applied } = resolveDefaults(rawAst);
  const { steps, loops, orchestrator } = resolveOrder(ast);

  const handoffs = computeHandoffs(ast);
  const blindPairs = computeBlindPairs(steps, ast);
  const unenforceable = computeUnenforceable(ast);
  const persistent = persistentFeatures(ast);
  const preflagged = computePreflagged(ast, handoffs, unenforceable, persistent);

  const stepOf = new Map<string, OrderStep>();
  for (const s of steps) for (const id of s.ids) stepOf.set(id, s);

  const withheldByWriter = new Map<string, Set<string>>();
  for (const h of handoffs) {
    if (!withheldByWriter.has(h.from)) withheldByWriter.set(h.from, new Set());
    for (const w of h.withholds) withheldByWriter.get(h.from)!.add(w);
  }

  const roles: RoleCard[] = agentsOf(ast).map((a) => {
    const blindTo = blindPairs
      .filter((p) => p.a === a.id || p.b === a.id)
      .map((p) => (p.a === a.id ? p.b : p.a));
    return {
      id: a.id,
      model: a.model,
      isolation: a.isolation,
      prompt: a.prompt ?? null,
      role: a.role ?? a.description ?? a.id,
      reads: a.reads ?? [],
      writes: a.writes ?? [],
      withheld: [...(withheldByWriter.get(a.id) ?? [])],
      blindTo,
      outputs: a.outputs ?? {},
      declaredTools: a.tools,
      fileless: !(a.tools?.length || a.disallowedTools?.length || a.mcpServers?.length),
    };
  });

  return {
    topology: ast.topology.name,
    version: ast.topology.version ?? "0.0.0",
    source: opts.source ?? "<stdin>",
    autonomy: opts.autonomy ?? "execute",
    ambiguityLog: opts.ambiguityLog ?? null,
    errors: opts.errors ?? [],
    steps,
    preconditions: computePreconditions(ast),
    roles,
    handoffs,
    blindPairs,
    routes: computeRoutes(ast),
    loops,
    gates: ast.nodes
      .filter((n): n is GateNode => n.type === "gate")
      .map((g) => ({
        id: g.id,
        after: g.after,
        before: g.before,
        tier: gateTier(g),
        run: g.run,
        blocking: g.behavior !== "advisory",
        onFail: g.onFail ?? "halt",
      })),
    unenforceable,
    persistent,
    preflagged,
    defaultsApplied: applied,
    orchestrator,
  };
}
