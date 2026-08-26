/**
 * Terminal renderer — the human-facing view of a topology.
 *
 * Nothing like this existed in the package. The nearest prior art was
 * `exporters/markdown.ts` `renderFlow()`, a flat edge list with no layout.
 * This ranks by resolved execution order (`../resolve/order`), so what you read
 * is the order the host agent will actually enact — including gates spliced at
 * the position their `after` / `before` names, rather than at Kahn's depth 0.
 *
 * Pure: returns a string, prints nothing, applies no colour. The CLI adds
 * colour; keeping this pure is what makes it testable, which the CLI is not.
 *
 * @module
 */

import type { TopologyAST, NodeDef, AgentNode, GateNode, EdgeDef } from "../parser/ast.js";
import { resolveOrder, type OrderStep } from "../resolve/order.js";

/** Glyph per node kind. Mirrors the shape vocabulary in `exporters/mermaid.ts`. */
const GLYPH: Record<string, string> = {
  spawn: "▸",
  action: "▪",
  gate: "◆",
  human: "☰",
  group: "▤",
};

/**
 * Edge annotation string. Same field order and spelling as
 * `exporters/markdown.ts` `edgeLabel`, so an edge is never described two
 * different ways across two outputs.
 */
function edgeLabel(edge: EdgeDef): string {
  const parts: string[] = [];
  if (edge.isError) parts.push(edge.errorType ? `error(${edge.errorType})` : "error");
  if (edge.condition) parts.push(`when ${edge.condition}`);
  if (edge.maxIterations) parts.push(`max ${edge.maxIterations}`);
  if (edge.race) parts.push("race");
  if (edge.tolerance != null) parts.push(`tolerance: ${edge.tolerance}`);
  if (edge.wait) parts.push(`wait ${edge.wait}`);
  if (edge.weight != null) parts.push(`weight ${edge.weight}`);
  if (edge.reflection) parts.push("reflection");
  return parts.join(", ");
}

/** Right-pad to a column width, without truncating content that overflows. */
function pad(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

function stepAnnotation(step: OrderStep, byId: Map<string, NodeDef>): string {
  if (step.kind === "gate") {
    const g = byId.get(step.ids[0]) as GateNode | undefined;
    const bits = ["gate"];
    if (g?.behavior) bits.push(g.behavior);
    else bits.push("blocking");
    if (g?.onFail) bits.push(`on-fail: ${g.onFail}`);
    return bits.join(" · ");
  }
  if (step.kind === "spawn") {
    const models = step.ids
      .map((id) => (byId.get(id) as AgentNode | undefined)?.model)
      .filter((m): m is string => !!m);
    const uniq = [...new Set(models)];
    const label = step.ids.length > 1 ? `agent ×${step.ids.length}, parallel` : "agent";
    return uniq.length ? `${label} · ${uniq.join(", ")}` : label;
  }
  return step.kind;
}

function renderSpine(ast: TopologyAST): string[] {
  const byId = new Map<string, NodeDef>(ast.nodes.map((n) => [n.id, n]));
  const { steps, loops, unreachable, orchestrator } = resolveOrder(ast);
  const out: string[] = [];

  if (steps.length === 0) {
    out.push("  (no flow declared)");
    return out;
  }

  // Width of the widest node column, so annotations line up.
  const bodies = steps.map((s) => s.ids.join("  ∥  "));
  const width = Math.max(...bodies.map((b) => b.length), 20);

  steps.forEach((step, i) => {
    const glyph = GLYPH[step.kind] ?? "▸";
    const num = String(step.index).padStart(2, " ");
    out.push(`  ${num}  ${glyph} ${pad(bodies[i], width)}   ${stepAnnotation(step, byId)}`);
    if (i < steps.length - 1) out.push(`         │`);
  });

  if (loops.length) {
    out.push("");
    for (const l of loops) {
      const edge = ast.edges.find((e) => e.from === l.from && e.to === l.to);
      const label = edge ? edgeLabel(edge) : "";
      out.push(`  ↩  ${l.from} → ${l.to}${label ? `   ${label}` : ""}`);
    }
  }

  if (unreachable.length) {
    out.push("");
    out.push(`  ⚠  unreachable from the entry point: ${unreachable.join(", ")}`);
  }

  if (orchestrator) {
    out.push("");
    out.push(`  orchestrator "${orchestrator}" is the host agent — it is not a step.`);
  }

  return out;
}

function renderRoles(ast: TopologyAST): string[] {
  const agents = ast.nodes.filter((n): n is AgentNode => n.type === "agent");
  if (!agents.length) return [];

  const rows = agents.map((a) => ({
    id: a.id,
    model: a.model ?? "—",
    reads: a.reads?.length ? String(a.reads.length) : "—",
    writes: a.writes?.length ? String(a.writes.length) : "—",
    role: a.role ?? a.description ?? "—",
  }));

  const wId = Math.max(4, ...rows.map((r) => r.id.length));
  const wModel = Math.max(5, ...rows.map((r) => r.model.length));

  const out: string[] = ["", "  Roles", ""];
  out.push(`  ${pad("id", wId)}  ${pad("model", wModel)}  in  out  role`);
  out.push(`  ${"─".repeat(wId)}  ${"─".repeat(wModel)}  ──  ───  ${"─".repeat(28)}`);
  for (const r of rows) {
    out.push(
      `  ${pad(r.id, wId)}  ${pad(r.model, wModel)}  ${pad(r.reads, 2)}  ${pad(r.writes, 3)}  ${r.role}`
    );
  }
  return out;
}

/**
 * Render a topology as a terminal flow graph plus a roles table.
 *
 * @param ast - A parsed topology.
 * @returns A plain string. No ANSI codes, no trailing newline.
 */
export function renderAscii(ast: TopologyAST): string {
  const header = `${ast.topology.name} v${ast.topology.version ?? "0.0.0"}`;
  const patterns = ast.topology.patterns?.length ? `  ·  ${ast.topology.patterns.join(", ")}` : "";

  return [`  ${header}${patterns}`, "", ...renderSpine(ast), ...renderRoles(ast)].join("\n");
}
