import type { AgentNode, GateNode, TopologyAST } from "./ast.js";
import { gateAnchors } from "./ast.js";

/** The words a gate's `by:` uses for the mechanism that refuses (V104). */
export const ENFORCED_BY_WORDS = ["code", "hook", "settings", "gate"];

/**
 * The agent that judges a gate: its `by:` when that is not a mechanism word.
 * (An agent whose id is a mechanism word cannot be named here; the word wins.)
 */
export function gateJudgeId(gate: GateNode): string | undefined {
  return gate.by && !ENFORCED_BY_WORDS.includes(gate.by) ? gate.by : undefined;
}

/** A gate whose judge is a declared agent: the judge and the agents whose work it judges. */
export function judgePairs(ast: TopologyAST): Array<{ gate: string; judge: string; judges: string[] }> {
  const out: Array<{ gate: string; judge: string; judges: string[] }> = [];
  for (const n of ast.nodes) {
    if (n.type !== "gate") continue;
    const gate = n as GateNode;
    const judge = gateJudgeId(gate);
    if (!judge || !ast.nodes.some((a) => a.type === "agent" && a.id === judge)) continue;
    const judges = gateAnchors(gate, "after").filter((a) => ast.nodes.some((x) => x.type === "agent" && x.id === a));
    out.push({ gate: gate.id, judge, judges });
  }
  return out;
}

export const independentAgentIds = (ast: TopologyAST): string[] =>
  ast.nodes.filter((n): n is AgentNode => n.type === "agent" && !!(n as AgentNode).independent).map((n) => n.id);
