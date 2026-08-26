/**
 * Defaults resolver — the first code in the package that reads the spec's
 * defaults table (`spec/grammar.md` §7).
 *
 * WHY THIS EXISTS
 * ---------------
 * The parser writes a field only when it is present in the source, so every
 * optional field on a node arrives `undefined`. Until now each binding filled
 * the blanks itself, and they disagree: `agent.permissions` defaults to
 * `"supervised"` in `bindings/codex.ts`, `"auto"` in `bindings/openclaw.ts`,
 * while the spec says `autonomous`. Interpreted mode cannot tolerate that —
 * an execution brief must state one resolved value and be able to name where
 * it came from.
 *
 * WHAT THIS DOES NOT DO
 * ---------------------
 * It does not mutate the input and no binding consumes it. Wiring it into the
 * bindings would silently change their output for three targets, which is a
 * separate, deliberate change. This resolver serves `agentopology plan`.
 *
 * Only defaults that are a CONCRETE VALUE are applied. Table rows whose default
 * is "-- (none)" stay `undefined`, because absence is their meaning.
 *
 * @module
 */

import type { TopologyAST, NodeDef, AgentNode, GateNode, ActionNode } from "../parser/ast.js";

/** One resolved field, and the fact that it was not authored. */
export interface ResolvedDefault {
  /** Node id, or `"<topology>"` for topology-level fields. */
  node: string;
  /** Field name as it appears in the grammar (kebab-case). */
  field: string;
  /** The value the spec says to use. */
  value: unknown;
}

/** Result of resolving defaults: a new AST plus the list of what was filled. */
export interface DefaultsResolution {
  ast: TopologyAST;
  applied: ResolvedDefault[];
}

/**
 * Concrete agent defaults from `spec/grammar.md` §7. Keys are AST field names;
 * `grammarName` is the kebab-case spelling used in `.at` source and in reports.
 */
const AGENT_DEFAULTS: Array<{ key: keyof AgentNode; grammarName: string; value: unknown }> = [
  { key: "permissions", grammarName: "permissions", value: "autonomous" },
  { key: "disallowedTools", grammarName: "disallowed-tools", value: [] },
  { key: "reads", grammarName: "reads", value: [] },
  { key: "writes", grammarName: "writes", value: [] },
  { key: "outputs", grammarName: "outputs", value: {} },
  { key: "retry", grammarName: "retry", value: 0 },
  { key: "invocation", grammarName: "invocation", value: "auto" },
  { key: "behavior", grammarName: "behavior", value: "blocking" },
  { key: "memory", grammarName: "memory", value: [] },
  { key: "skills", grammarName: "skills", value: [] },
  { key: "mcpServers", grammarName: "mcp-servers", value: [] },
  { key: "background", grammarName: "background", value: false },
  { key: "fallbackChain", grammarName: "fallback-chain", value: [] },
];

const GATE_DEFAULTS: Array<{ key: keyof GateNode; grammarName: string; value: unknown }> = [
  { key: "checks", grammarName: "checks", value: [] },
  { key: "retry", grammarName: "retry", value: 0 },
  { key: "onFail", grammarName: "on-fail", value: "halt" },
  { key: "behavior", grammarName: "behavior", value: "blocking" },
];

const ACTION_DEFAULTS: Array<{ key: keyof ActionNode; grammarName: string; value: unknown }> = [
  { key: "commands", grammarName: "commands", value: [] },
];

/** Deep-ish clone that is enough for an AST of plain data. */
function cloneValue<T>(v: T): T {
  if (Array.isArray(v)) return [...v] as unknown as T;
  if (v && typeof v === "object") return { ...(v as object) } as T;
  return v;
}

function applyTo(
  node: Record<string, unknown>,
  id: string,
  table: Array<{ key: string; grammarName: string; value: unknown }>,
  applied: ResolvedDefault[]
): void {
  for (const { key, grammarName, value } of table) {
    if (node[key] === undefined) {
      node[key] = cloneValue(value);
      // Clone for the REPORT too. Pushing `value` handed the caller a reference
      // to the module-level table, so one mutation of a reported value poisoned
      // the default for every later topology in the process.
      applied.push({ node: id, field: grammarName, value: cloneValue(value) });
    }
  }
}

/**
 * Fill every omitted optional field that the spec gives a concrete default.
 *
 * Returns a NEW ast — the input is not mutated — plus the list of fields that
 * were filled, so a caller can report which values the author never wrote.
 *
 * @param ast - A parsed topology.
 * @returns The resolved AST and the record of what was applied.
 */
export function resolveDefaults(ast: TopologyAST): DefaultsResolution {
  const applied: ResolvedDefault[] = [];

  const nodes: NodeDef[] = ast.nodes.map((n) => {
    const copy = { ...n } as unknown as Record<string, unknown>;
    switch (n.type) {
      case "agent":
        applyTo(copy, n.id, AGENT_DEFAULTS as never, applied);
        break;
      case "gate":
        applyTo(copy, n.id, GATE_DEFAULTS as never, applied);
        break;
      case "action":
        applyTo(copy, n.id, ACTION_DEFAULTS as never, applied);
        break;
      case "orchestrator":
        if (copy.outputs === undefined) {
          copy.outputs = {};
          applied.push({ node: n.id, field: "outputs", value: {} });
        }
        break;
      default:
        break;
    }
    return copy as unknown as NodeDef;
  });

  return { ast: { ...ast, nodes }, applied };
}
