/**
 * The visualizer projection: a pure function from the parsed AST to the data
 * the page draws.
 *
 * Every node kind has one row in {@link NODE_RULES}. A row lists the fields it
 * carries to the page and the fields it drops on purpose (with a reason). A
 * field that is on a parsed node but in neither list is a bug the zero-drop
 * test catches. A node kind with no row draws with {@link DEFAULT_RULE}, which
 * carries every field it has.
 *
 * @module
 */

import type { TopologyAST, NodeDef, EdgeDef } from "../parser/ast.js";
import { gateAnchors } from "../parser/ast.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** One row of the rules table. */
export interface NodeRule {
  /** Fields copied to the page under the same name. */
  carry: readonly string[];
  /**
   * Fields the page receives under other names or in another shape. Maps the
   * parsed field to the page keys that carry it.
   */
  reshape?: Readonly<Record<string, readonly string[]>>;
  /** Fields left off the page on purpose, each with the reason. */
  dropped?: Readonly<Record<string, string>>;
  /** Take every field as it is (the default rule). */
  carryAll?: boolean;
}

/** Facts about the topology that are not in the AST (check results, stamps). */
export type ProjectFacts = Record<string, unknown>;

const BASE = ["id", "type", "label", "file"] as const;

export const NODE_RULES: Readonly<Record<string, NodeRule>> = {
  orchestrator: {
    carry: [...BASE, "model", "generates", "handles", "outputs", "delegation"],
  },
  agent: {
    carry: [
      ...BASE,
      "phase", "model", "permissions", "prompt", "tools", "skills", "reads", "writes",
      "disallowedTools", "skip", "behavior", "invocation", "runs", "independent", "color",
      "initialPrompt", "omitClaudeMd", "retry", "isolation", "background", "mcpServers",
      "memory", "retrieval", "custodianOf", "custodianDoes", "outputs", "scale", "hooks",
      "role", "description", "maxTurns", "sandbox", "fallbackChain", "timeout", "onFail",
      "temperature", "maxTokens", "topP", "topK", "stop", "seed", "thinking",
      "thinkingBudget", "outputFormat", "logLevel", "join", "circuitBreaker", "compensates",
      "inputSchema", "outputSchema", "produces", "consumes", "variants", "rateLimit",
      "extensions",
    ],
  },
  gate: {
    carry: [
      ...BASE,
      "run", "checks", "retry", "onFail", "behavior", "timeout", "description", "strength",
      "by", "at", "match", "bypass", "ledger", "extensions",
    ],
    // The page does string lookups on `after`/`before`, so a list is split into
    // the first anchor plus the full list (see gateAnchors).
    reshape: { after: ["after", "afterAll"], before: ["before", "beforeAll"] },
  },
  action: {
    carry: [
      ...BASE, "kind", "source", "description", "commands", "timeout", "onFail", "join",
      "unitFrom",
    ],
  },
  human: {
    carry: [...BASE, "description", "timeout", "onTimeout"],
  },
  group: {
    carry: [
      ...BASE, "members", "speakerSelection", "maxRounds", "termination", "description",
      "timeout",
    ],
  },
};

export const DEFAULT_RULE: NodeRule = { carry: BASE, carryAll: true };

/** Edge fields every edge carries, even when null (as the page always had). */
const EDGE_ALWAYS = ["from", "to", "condition", "maxIterations"] as const;
export const EDGE_RULE: NodeRule = {
  carry: [
    ...EDGE_ALWAYS, "per", "isError", "errorType", "tolerance", "race", "wait", "weight",
    "reflection", "strength", "at", "guard",
  ],
};

export function ruleFor(kind: string): NodeRule {
  return Object.prototype.hasOwnProperty.call(NODE_RULES, kind) ? NODE_RULES[kind] : DEFAULT_RULE;
}

/** A value that is information: set, and not an empty list. */
export function isPresent(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (Array.isArray(v) && v.length === 0) return false;
  return true;
}

function projectWith(rule: NodeRule, item: Record<string, any>, always: readonly string[] = []): Record<string, any> {
  const out: Record<string, any> = {};
  for (const k of always) out[k] = item[k];
  const keys = rule.carryAll ? Object.keys(item) : rule.carry;
  for (const k of keys) {
    if (isPresent(item[k])) out[k] = item[k];
  }
  return out;
}

export function projectNode(n: NodeDef): Record<string, any> {
  const item = n as unknown as Record<string, any>;
  const rule = ruleFor(item.type);
  const out = projectWith(rule, item, ["id", "type", "label"]);
  if (item.type === "gate") {
    // NORMALISE AT THE BOUNDARY. The page is browser JS that TypeScript never
    // checks: it looks gates up by `positions[gate.after]` and compares
    // `g.after === nodeId`. An array would coerce to "a,b" and the gate would
    // vanish. So the page gets a STRING, plus the full list separately.
    const afters = gateAnchors(n as any, "after");
    const befores = gateAnchors(n as any, "before");
    if (afters.length) out.after = afters[0];
    if (befores.length) out.before = befores[0];
    if (afters.length > 1) out.afterAll = afters;
    if (befores.length > 1) out.beforeAll = befores;
  }
  return out;
}

export function projectEdge(e: EdgeDef): Record<string, any> {
  return projectWith(EDGE_RULE, e as unknown as Record<string, any>, EDGE_ALWAYS);
}

/**
 * Fields present on a parsed node that the page data neither carries nor the
 * rules table claims as dropped. Empty when nothing is lost.
 */
export function unclaimedFields(node: Record<string, any>, projected: Record<string, any>): string[] {
  const rule = ruleFor(node.type);
  const lost: string[] = [];
  for (const k of Object.keys(node)) {
    if (!isPresent(node[k])) continue;
    if (rule.carryAll) continue;
    if (rule.dropped && k in rule.dropped) continue;
    const keys = rule.reshape?.[k] ?? [k];
    if (keys.some((pk) => projected[pk] !== undefined)) continue;
    lost.push(k);
  }
  return lost;
}

/** Same check for edges. */
export function unclaimedEdgeFields(edge: Record<string, any>, projected: Record<string, any>): string[] {
  return Object.keys(edge).filter((k) => isPresent(edge[k]) && projected[k] === undefined);
}

export function project(ast: TopologyAST, facts?: ProjectFacts): Record<string, any> {
  const data: Record<string, any> = {
    topology: {
      name: ast.topology.name,
      version: ast.topology.version,
      description: ast.topology.description,
      patterns: ast.topology.patterns,
      foundations: ast.topology.foundations || [],
      advanced: ast.topology.advanced || [],
    },
    nodes: ast.nodes.map(projectNode),
    edges: ast.edges.map(projectEdge),
    depth: ast.depth,
    memory: ast.memory,
    stores: ast.stores,
    retrievals: ast.retrievals,
    batch: ast.batch,
    environments: ast.environments,
    triggers: ast.triggers,
    hooks: ast.hooks,
    settings: ast.settings,
    mcpServers: ast.mcpServers,
    metering: ast.metering,
    skills: ast.skills,
    toolDefs: ast.toolDefs,
    runs: [],
  };
  if (facts) data.facts = facts;
  return data;
}
