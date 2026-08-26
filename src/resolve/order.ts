/**
 * Execution order resolver.
 *
 * WHY THIS EXISTS
 * ---------------
 * `computeLayers` in `../analyzer` is a correct Kahn topological rank, but it
 * cannot be used directly for execution order. Gates bind to the graph through
 * `after:` / `before:` fields, never through edges, so they have in-degree 0
 * and Kahn ranks them as SOURCES. Measured on `examples/code-review.at`, the
 * gate `human-approval` lands in layer 0 next to the entry action.
 *
 * So: rank the flow-participating nodes only, then splice gates back in at the
 * position their `after` / `before` actually names.
 *
 * The orchestrator is deliberately NOT a step. In interpreted mode the host
 * coding agent IS the orchestrator — it does not spawn one.
 *
 * @module
 */

import type { TopologyAST, EdgeDef, GateNode, NodeDef } from "../parser/ast.js";
import { computeLayers } from "../analyzer/index.js";

/** What the host does at one step. */
export type StepKind = "spawn" | "gate" | "action" | "human" | "group";

/** One step of the resolved execution order. */
export interface OrderStep {
  /** 1-based position. */
  index: number;
  kind: StepKind;
  /** Node ids. More than one means they run in parallel, mutually blind. */
  ids: string[];
  /** Graph rank, or `null` for a gate (spliced by position, never ranked). */
  depth: number | null;
  /**
   * True when the ids are mutually EXCLUSIVE branches, not a parallel fan-out:
   * every one is reached only by a conditional edge from the same source.
   * Exactly one runs.
   *
   * Without this the renderer called them "parallel" and the brief marked them
   * mutually blind and told the host to dispatch all of them in one message —
   * running every branch of a decision instead of taking one.
   */
  exclusive: boolean;
  /** For an exclusive step, the condition that selects each id. */
  branchOn?: Array<{ id: string; condition: string }>;
}

/** A back-edge with its iteration budget. */
export interface LoopInfo {
  from: string;
  to: string;
  condition: string | null;
  /** `[max N]` — the number of TRAVERSALS allowed, so the target runs N+1 times. */
  budget: number | null;
}

export interface ResolvedOrder {
  steps: OrderStep[];
  loops: LoopInfo[];
  /** Nodes Kahn could not reach — cycle members. `computeLayers` gives depth -1. */
  unreachable: string[];
  /** The orchestrator's id, if declared. It is the host, not a step. */
  orchestrator: string | null;
}

/**
 * True back-edges, found by DFS over the FULL edge set.
 *
 * `findBackEdges` in the validator cannot be reused here: it strips every edge
 * carrying `[max N]` first, because its job is to find loops the author has NOT
 * acknowledged (that is V6). We need the opposite — the acknowledged ones too.
 *
 * And `computeLayers` strips them as well, so a plain FORWARD edge that happens
 * to carry a bound both corrupts the ranking and gets reported as a loop.
 * Classifying first, then ranking with only the real back-edges removed, fixes
 * both.
 */
function trueBackEdges(edges: EdgeDef[], nodeIds: Set<string>): Set<string> {
  const out = new Map<string, string[]>();
  for (const e of edges) {
    if (e.isError) continue;
    if (!nodeIds.has(e.from) || !nodeIds.has(e.to)) continue;
    if (!out.has(e.from)) out.set(e.from, []);
    out.get(e.from)!.push(e.to);
  }

  const WHITE = 0, GREY = 1, BLACK = 2;
  const colour = new Map<string, number>([...nodeIds].map((id) => [id, WHITE]));
  const back = new Set<string>();

  const visit = (id: string): void => {
    colour.set(id, GREY);
    for (const to of out.get(id) ?? []) {
      const c = colour.get(to) ?? WHITE;
      // An edge into a node still on the DFS stack closes a cycle.
      if (c === GREY) back.add(`${id} ${to}`);
      else if (c === WHITE) visit(to);
    }
    colour.set(id, BLACK);
  };

  for (const id of nodeIds) if (colour.get(id) === WHITE) visit(id);
  return back;
}

const KIND_BY_TYPE: Record<string, StepKind> = {
  agent: "spawn",
  action: "action",
  human: "human",
  group: "group",
  gate: "gate",
};

/**
 * Resolve the order in which a host agent should enact a topology.
 *
 * @param ast - A parsed topology. Order does not depend on defaults resolution.
 * @returns Ordered steps, loop budgets, unreachable nodes, and the orchestrator id.
 */
export function resolveOrder(ast: TopologyAST): ResolvedOrder {
  const byId = new Map<string, NodeDef>(ast.nodes.map((n) => [n.id, n]));
  const orchestrator = ast.nodes.find((n) => n.type === "orchestrator")?.id ?? null;

  const gates = ast.nodes.filter((n): n is GateNode => n.type === "gate");
  const gateIds = new Set(gates.map((g) => g.id));

  // Rank only what actually participates in the flow graph. Gates are excluded
  // because they have no edges; the orchestrator because it is the host.
  const flowIds = new Set(
    ast.nodes.filter((n) => !gateIds.has(n.id) && n.type !== "orchestrator").map((n) => n.id)
  );

  // Classify first: rank with only the REAL back-edges removed, so a forward
  // edge carrying `[max N]` still advances the depth of its target.
  const backKeys = trueBackEdges(ast.edges, flowIds);
  const forwardEdges = ast.edges.filter((e) => !backKeys.has(`${e.from} ${e.to}`));
  const layers = computeLayers(
    // computeLayers strips `maxIterations` itself, so clear it on the edges we
    // have already established are forward — otherwise they vanish again.
    forwardEdges.map((e) => (e.maxIterations ? { ...e, maxIterations: null } : e)),
    flowIds
  );

  // Build the ranked spine, splitting each layer by node kind so a step is
  // never a mix of "spawn three agents" and "run a shell action".
  const spine: Array<{ kind: StepKind; ids: string[]; depth: number }> = [];
  const unreachable: string[] = [];

  for (const layer of layers) {
    if (layer.depth === -1) {
      unreachable.push(...layer.nodes);
      continue;
    }
    const grouped = new Map<StepKind, string[]>();
    for (const id of layer.nodes) {
      const node = byId.get(id);
      if (!node) continue;
      const kind = KIND_BY_TYPE[node.type] ?? "spawn";
      if (!grouped.has(kind)) grouped.set(kind, []);
      grouped.get(kind)!.push(id);
    }
    // Deterministic kind order within a layer: work first, then human gates.
    for (const kind of ["action", "spawn", "group", "human"] as StepKind[]) {
      const ids = grouped.get(kind);
      if (ids && ids.length) spine.push({ kind, ids, depth: layer.depth });
    }
  }

  // Splice gates. `after: X` inserts immediately after the step containing X.
  // `before: Y` inserts immediately before the step containing Y. A gate with
  // both prefers `after`, since that is when its check can actually run.
  const withGates: Array<{ kind: StepKind; ids: string[]; depth: number | null }> = [...spine];

  for (const gate of gates) {
    let at = -1;
    if (gate.after) {
      const i = withGates.findIndex((s) => s.ids.includes(gate.after!));
      if (i >= 0) at = i + 1;
    }
    if (at === -1 && gate.before) {
      const i = withGates.findIndex((s) => s.ids.includes(gate.before!));
      if (i >= 0) at = i;
    }
    // A gate anchored to nothing resolvable runs last — visible, not dropped.
    if (at === -1) at = withGates.length;

    withGates.splice(at, 0, { kind: "gate", ids: [gate.id], depth: null });
  }

  // Classify each multi-node step: parallel fan-out, or exclusive branch?
  const steps: OrderStep[] = withGates.map((s, i) => {
    const base = { index: i + 1, ...s, exclusive: false } as OrderStep;
    if (s.ids.length < 2) return base;

    const inbound = s.ids.map((id) => ast.edges.filter((e) => e.to === id && !e.isError));
    // Every id reached ONLY by conditional edges, and every one of those edges
    // from the same single source → this is one decision, not a fan-out.
    const allConditional = inbound.every((es) => es.length > 0 && es.every((e) => !!e.condition));
    const sources = new Set(inbound.flat().map((e) => e.from));
    if (!allConditional || sources.size !== 1) return base;

    base.exclusive = true;
    base.branchOn = s.ids.map((id) => ({
      id,
      condition: ast.edges.find((e) => e.to === id && e.condition)?.condition ?? "",
    }));
    return base;
  });

  const loops: LoopInfo[] = ast.edges
    .filter((e) => backKeys.has(`${e.from} ${e.to}`))
    .map((e) => ({
      from: e.from,
      to: e.to,
      condition: e.condition,
      budget: e.maxIterations ?? null,
    }));

  return { steps, loops, unreachable, orchestrator };
}

/** All outbound edges from a node, in declaration order. */
export function edgesFrom(ast: TopologyAST, id: string): EdgeDef[] {
  return ast.edges.filter((e) => e.from === id);
}
