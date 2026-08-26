/**
 * The single answer to "where does an agent with no declared `phase` go?"
 *
 * THE BUG THIS FIXES
 * ------------------
 * Six consumers each picked their own sentinel, so the same topology ordered
 * an unphased agent differently on every target:
 *
 *   claude-code, claude-workflow  →  Number.MAX_SAFE_INTEGER  →  runs LAST
 *   gemini-cli                    →  999                      →  runs near-last
 *   openclaw, kiro, mermaid       →  0                        →  runs FIRST
 *
 * An agent that runs first on three targets and last on three others is
 * precisely the failure "write once, deploy to any platform" exists to prevent.
 * Found by an audit topology run through `agentopology plan`.
 *
 * WHY TRAILING, NOT LEADING
 * -------------------------
 * `spec/grammar.md` §7 gives `agent.phase` the default "-- (none, unordered)",
 * so there is no declared answer — a sort simply needs one. Trailing is the
 * safer reading: an author who phases *some* agents is expressing "these come
 * first, in this order", and the ones they did not mention should not leap
 * ahead of them. A stable sort then preserves declaration order among the
 * unphased, which is the only ordering information they carry.
 *
 * When NO agent declares a phase, every agent takes the same sentinel and the
 * stable sort leaves declaration order intact — the same result all six
 * sentinels used to give, which is why this went unnoticed.
 *
 * @module
 */

import type { AgentNode } from "../parser/ast.js";

/**
 * Sort key for an agent with no declared `phase`.
 *
 * Deliberately `Number.MAX_SAFE_INTEGER` rather than a smaller magic number:
 * `999` collides with a legitimately declared `phase: 999`, and `0` collides
 * with `phase: 0`. This one cannot be reached by a real declaration, since
 * `phase` is parsed with `parseFloat` from a source literal.
 */
export const UNPHASED = Number.MAX_SAFE_INTEGER;

/**
 * The ordering value for an agent — its declared `phase`, or {@link UNPHASED}.
 *
 * Every consumer that sorts by phase must use this. Sorting by
 * `agent.phase ?? <anything else>` reintroduces the divergence.
 *
 * @param agent - Any agent node.
 * @returns The numeric sort key.
 */
export function phaseOf(agent: Pick<AgentNode, "phase">): number {
  return agent.phase ?? UNPHASED;
}

/**
 * Comparator for `Array.prototype.sort`, stable on ties so declaration order
 * survives among agents sharing a phase.
 */
export function byPhase(a: Pick<AgentNode, "phase">, b: Pick<AgentNode, "phase">): number {
  return phaseOf(a) - phaseOf(b);
}
