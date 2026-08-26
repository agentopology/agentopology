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
import { findBackEdges } from "../parser/validator.js";

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

  const layers = computeLayers(ast.edges, flowIds);

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

  const steps: OrderStep[] = withGates.map((s, i) => ({ index: i + 1, ...s }));

  const backEdges = findBackEdges(ast.edges, flowIds);
  const backKeys = new Set(backEdges.map((e) => `${e.from} ${e.to}`));
  const loops: LoopInfo[] = ast.edges
    .filter((e) => e.maxIterations != null || backKeys.has(`${e.from} ${e.to}`))
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
