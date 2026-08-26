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
import { existsSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";

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
    const label =
      step.ids.length === 1
        ? "agent"
        : step.exclusive
          ? `branch ×${step.ids.length}, exactly one runs`
          : `agent ×${step.ids.length}, parallel`;
    return uniq.length ? `${label} · ${uniq.join(", ")}` : label;
  }
  return step.kind;
}

/**
 * What the filesystem says about a step. Mirrors `plan/brief.ts` stepEvidence —
 * kept local so the renderer stays a pure function of the AST plus disk, with no
 * dependency on the brief.
 */
function evidenceMark(step: OrderStep, byId: Map<string, NodeDef>): string {
  const declared: string[] = [];
  for (const id of step.ids) {
    const n = byId.get(id);
    if (n?.type !== "agent") continue;
    declared.push(...((n as AgentNode).writes ?? []));
  }
  if (declared.length === 0) return " ";
  const root = process.cwd();
  const all = declared.every((p) =>
    existsSync(isAbsolute(p) ? p : resolvePath(root, p))
  );
  return all ? "✓" : "·";
}

function renderSpine(ast: TopologyAST): string[] {
  const byId = new Map<string, NodeDef>(ast.nodes.map((n) => [n.id, n]));
  const { steps, loops, unreachable, orchestrator } = resolveOrder(ast);
  const out: string[] = [];

  // Nodes with no edge at all are not a parallel step — they are declared and
  // never wired in. Kahn ranks them all at depth 0, so they used to render as
  // one big "agent ×N, parallel" line that read like real concurrent work.
  const wired = new Set(ast.edges.flatMap((e) => [e.from, e.to]));
  const orphans = ast.nodes
    .filter((n) => {
      if (n.type === "orchestrator") return false;
      // A GATE never appears in an edge — it binds through `after`/`before`.
      // Treating "no edge" as "not in the flow" dropped every gate from the
      // spine, which is the whole reason `resolve/order.ts` splices them.
      if (n.type === "gate") return false;
      return !wired.has(n.id);
    })
    .map((n) => n.id);
  const orphanSet = new Set(orphans);

  const spineSteps = steps
    .map((s) => ({ ...s, ids: s.ids.filter((id) => !orphanSet.has(id)) }))
    .filter((s) => s.ids.length > 0)
    // Renumber: dropping an unwired step must not leave a gap in the column.
    .map((s, i) => ({ ...s, index: i + 1 }));

  if (spineSteps.length === 0) {
    out.push("  (no flow declared)");
    if (orphans.length) {
      out.push("");
      out.push(`  declared but not in the flow: ${orphans.join(", ")}`);
    }
    return out;
  }

  // Width of the widest node column, so annotations line up.
  // `∥` is concurrency. An exclusive branch is not concurrent — exactly one of
  // its ids runs — so it gets a different separator and a different glyph.
  const bodies = spineSteps.map((s) => s.ids.join(s.exclusive ? "  |  " : "  ∥  "));
  const width = Math.max(...bodies.map((b) => b.length), 20);

  // Pad the step number to the widest index, not a fixed 2 — at step 100 the
  // column shifted and the whole spine lost alignment.
  const numWidth = String(spineSteps.length).length;

  spineSteps.forEach((step, i) => {
    const glyph = step.exclusive ? "⑂" : (GLYPH[step.kind] ?? "▸");
    const num = String(step.index).padStart(numWidth, " ");
    const mark = evidenceMark(step, byId);
    out.push(
      `  ${num} ${mark} ${glyph} ${pad(bodies[i], width)}   ${stepAnnotation(step, byId)}`
    );
    if (step.exclusive && step.branchOn) {
      for (const b of step.branchOn) {
        out.push(`  ${" ".repeat(numWidth)}   ├─ ${b.id}  when ${b.condition}`);
      }
    }
    if (i < spineSteps.length - 1) out.push(`  ${" ".repeat(numWidth)}   │`);
  });

  if (loops.length) {
    out.push("");
    for (const l of loops) {
      const edge = ast.edges.find((e) => e.from === l.from && e.to === l.to);
      const label = edge ? edgeLabel(edge) : "";
      out.push(`  ↩  ${l.from} → ${l.to}${label ? `   ${label}` : ""}`);
    }
  }

  if (orphans.length) {
    out.push("");
    out.push(`  ⚠  declared but not in the flow: ${orphans.join(", ")}`);
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
