/**
 * Recovering a project's flow on import, and saying how much was recovered.
 *
 * A hand-built Claude Code project has no flow on disk: subagents are invoked
 * on demand, so the wiring lives only in a .at file, if the project has one.
 * Import never opened those, so a 31-agent pipeline came back with 0 edges.
 * Now a .at that describes this project supplies its flow, and the agents no
 * source wires are reported as unknown. Nothing is guessed into the flow:
 * import once invented a linear chain, a flow the author never wrote.
 *
 * @module
 */

import { parse } from "../parser/index.js";
import type { AgentNode, EdgeDef, NodeDef, OrchestratorNode, TopologyAST } from "../parser/ast.js";
import type { PlatformFile } from "../sync/index.js";

/** A .at file counts as this project's when it shares this many agents, and this share of its own. */
const MIN_SHARED_AGENTS = 2;
const MIN_SHARED_RATIO = 0.5;

export interface FlowSource {
  path: string;
  edges: number;
  sharedAgents: number;
}

/** What import knows about the flow it wrote. */
export interface FlowReport {
  /** .at files whose flow was taken. */
  sources: FlowSource[];
  /** Topology skills whose ## Flow was taken. */
  skillEdges: number;
  /** .at files found but not used, with the reason. */
  skipped: Array<{ path: string; reason: string }>;
  /** Edges a source names that could not be kept, and why. */
  dropped: Array<{ edge: string; reason: string }>;
  /** Agents a .at declares with no file on disk (kept: the flow runs through them). */
  noFile: Array<{ id: string; source: string; workflow: boolean }>;
  /** Agents on disk in the flow, and those no source wires. */
  wired: string[];
  unwired: string[];
  /** Possible handoffs from reads/writes. Not in the flow: for a person to confirm. */
  suggested: Array<{ from: string; to: string; via: string }>;
}

const agentIds = (nodes: NodeDef[]) => nodes.filter((n) => n.type === "agent").map((n) => n.id);

/** Fill what an agent's own file cannot say; the file wins for everything else. */
function fillFromAt(agent: AgentNode, fromAt: AgentNode): void {
  for (const key of ["outputs", "phase", "reads", "writes"] as const) {
    if (agent[key] === undefined && fromAt[key] !== undefined) Object.assign(agent, { [key]: fromAt[key] });
  }
}

/**
 * Take the flow of every .at file that describes this project. Adds to `nodes`
 * and `edges` in place. An agent's file wins over the .at. An agent the .at
 * declares with no file stays in, because dropping it cuts the pipeline at
 * that node, and is reported: that gap is what a person needs to see.
 */
export function recoverFlowFromAt(
  files: PlatformFile[],
  nodes: NodeDef[],
  edges: EdgeDef[],
): Pick<FlowReport, "sources" | "skipped" | "dropped" | "noFile"> & { first: TopologyAST | null } {
  const onDisk = new Set(agentIds(nodes));
  const skipped: FlowReport["skipped"] = [];
  const dropped: FlowReport["dropped"] = [];
  const noFile: FlowReport["noFile"] = [];

  const candidates: Array<{ path: string; ast: TopologyAST; shared: number }> = [];
  for (const file of files) {
    if (!file.path.endsWith(".at")) continue;
    let ast: TopologyAST;
    try {
      ast = parse(file.content);
    } catch (err) {
      skipped.push({ path: file.path, reason: `does not parse: ${(err as Error).message.split("\n")[0]}` });
      continue;
    }
    const own = agentIds(ast.nodes);
    const shared = own.filter((id) => onDisk.has(id)).length;
    if (shared < MIN_SHARED_AGENTS || shared / own.length < MIN_SHARED_RATIO) {
      // The same names under a prefix may be the same system, but mapping them
      // is a guess, so it is said and not done.
      const bySuffix = own.filter((id) => !onDisk.has(id) && [...onDisk].some((d) => d.endsWith(`-${id}`))).length;
      const near = bySuffix >= MIN_SHARED_AGENTS ? `; ${bySuffix} more match only by suffix, so this may be the same system under other names, flow not taken` : "";
      skipped.push({ path: file.path, reason: `${shared} of its ${own.length} agents are here${near}` });
      continue;
    }
    candidates.push({ path: file.path, ast, shared });
  }

  // Most agents first, then the copy inside .claude, then the shortest path: a
  // second file of one topology is a copy, not more flow.
  const inConfig = (p: string) => (p.startsWith(".claude") ? 0 : 1);
  candidates.sort((a, b) => b.shared - a.shared || inConfig(a.path) - inConfig(b.path) || a.path.length - b.path.length);
  const sources: FlowSource[] = [];
  const names = new Set<string>();
  let first: TopologyAST | null = null;

  for (const { path, ast, shared } of candidates) {
    if (names.has(ast.topology.name)) {
      skipped.push({ path, reason: `another copy of topology "${ast.topology.name}"` });
      continue;
    }
    names.add(ast.topology.name);
    first ??= ast;

    for (const node of ast.nodes) {
      const here = nodes.find((n) => n.id === node.id);
      if (node.type === "orchestrator") {
        // One orchestrator handles every source's actions.
        const orchestrator = nodes.find((n): n is OrchestratorNode => n.type === "orchestrator");
        if (!orchestrator) nodes.unshift(node);
        else orchestrator.handles = [...new Set([...(orchestrator.handles ?? []), ...((node as OrchestratorNode).handles ?? [])])];
      } else if (here?.type === "agent" && node.type === "agent") {
        fillFromAt(here as AgentNode, node as AgentNode);
      } else if (here?.type === "gate" && node.type === "gate") {
        // The .at states a gate; a skill only describes it.
        nodes[nodes.indexOf(here)] = node;
      } else if (!here) {
        nodes.push(node);
        if (node.type === "agent") {
          const workflow = (node as AgentNode).extensions?.["claude-workflow"]?.execution === "workflow";
          noFile.push({ id: node.id, source: path, workflow });
        }
      }
    }

    let kept = 0;
    for (const edge of ast.edges) {
      const missing = [edge.from, edge.to].find((id) => !nodes.some((n) => n.id === id));
      if (missing) {
        dropped.push({ edge: `${edge.from} -> ${edge.to}`, reason: `${path} names "${missing}", which has no file here` });
        continue;
      }
      kept++;
      if (!edges.some((e) => e.from === edge.from && e.to === edge.to && e.condition === edge.condition)) edges.push(edge);
    }
    sources.push({ path, edges: kept, sharedAgents: shared });
  }
  return { sources, skipped, dropped, noFile, first };
}

/**
 * Possible handoffs touching an unwired agent: one writes the exact path the
 * other reads. A shared folder says nothing: an agent reading `workspace/`
 * would pair with every other agent.
 */
function suggestHandoffs(nodes: NodeDef[], unwired: Set<string>): FlowReport["suggested"] {
  const agents = nodes.filter((n): n is AgentNode => n.type === "agent");
  const out: FlowReport["suggested"] = [];
  for (const from of agents) {
    for (const to of agents) {
      if (from.id === to.id || !(unwired.has(from.id) || unwired.has(to.id))) continue;
      const via = (from.writes ?? []).find((w) => !w.endsWith("/") && (to.reads ?? []).includes(w));
      if (via) out.push({ from: from.id, to: to.id, via });
    }
  }
  return out;
}

export function buildFlowReport(
  nodes: NodeDef[],
  edges: EdgeDef[],
  skillEdges: number,
  recovered: Pick<FlowReport, "sources" | "skipped" | "dropped" | "noFile">,
): FlowReport {
  const inFlow = new Set(edges.flatMap((e) => [e.from, e.to]));
  const agents = agentIds(nodes);
  const unwired = agents.filter((id) => !inFlow.has(id));
  return {
    sources: recovered.sources,
    skipped: recovered.skipped,
    dropped: recovered.dropped,
    noFile: recovered.noFile,
    skillEdges,
    wired: agents.filter((id) => inFlow.has(id)),
    unwired,
    suggested: suggestHandoffs(nodes, new Set(unwired)),
  };
}

/** The report as plain lines: the CLI prints them and the .at opens with them. */
export function flowReportLines(report: FlowReport): string[] {
  const lines: string[] = [];
  const total = report.wired.length + report.unwired.length;
  for (const s of report.sources) lines.push(`Flow: ${s.edges} edges from ${s.path} (${s.sharedAgents} agents match)`);
  if (report.skillEdges > 0) lines.push(`Flow: ${report.skillEdges} edges from a topology skill`);
  if (report.sources.length === 0 && report.skillEdges === 0 && total > 0) {
    lines.push("Flow: none found. Nothing on disk records one, so none was invented.");
  }
  lines.push(`Flow: ${report.wired.length} of ${total} agents wired`);
  if (report.unwired.length > 0) {
    lines.push(`Flow unknown for: ${report.unwired.join(", ")} (imported as invocation: manual)`);
  }
  for (const n of report.noFile) {
    lines.push(n.workflow
      ? `No file, by design: ${n.id} runs in the workflow rung (${n.source})`
      : `No file here: ${n.id} is declared in ${n.source}; a scaffold of this .at would create it`);
  }
  for (const d of report.dropped) lines.push(`Edge dropped: ${d.edge} (${d.reason})`);
  for (const s of report.suggested) lines.push(`Possible handoff, not in the flow: ${s.from} -> ${s.to} (via ${s.via})`);
  for (const s of report.skipped) lines.push(`Not used: ${s.path} (${s.reason})`);
  return lines;
}
