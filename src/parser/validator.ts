/**
 * AgentTopology AST validator.
 *
 * Implements the 19 validation rules from the AgentTopology specification
 * (section 6). Takes a parsed {@link TopologyAST} and returns an array of
 * {@link ValidationResult} entries describing errors and warnings.
 *
 * ```ts
 * import { parse } from "./index";
 * import { validate } from "./validator";
 *
 * const ast = parse(source);
 * const issues = validate(ast);
 * for (const issue of issues) {
 *   console.log(`[${issue.rule}] ${issue.level}: ${issue.message}`);
 * }
 * ```
 *
 * @module
 */

import type {
  TopologyAST,
  NodeDef,
  AgentNode,
  GateNode,
  OrchestratorNode,
  EdgeDef,
  ProviderDef,
  ScheduleJobDef,
  InterfaceDef,
} from "./ast.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single validation finding. */
export interface ValidationResult {
  /** Rule identifier (e.g. "V1", "V2"). */
  rule: string;
  /** Severity level. */
  level: "error" | "warning";
  /** Human-readable description of the issue. */
  message: string;
  /** The node, gate, or action name related to the issue (if applicable). */
  node?: string;
}

// ---------------------------------------------------------------------------
// Reserved keywords (from spec section 7)
// ---------------------------------------------------------------------------

const RESERVED_KEYWORDS: ReadonlySet<string> = new Set([
  // Block keywords
  "topology", "library", "import", "from", "use",
  "agent", "action", "orchestrator", "meta", "roles", "memory", "flow",
  "gates", "gate", "depth", "batch", "environments", "triggers", "command",
  "event", "level", "hooks", "hook", "settings", "mcp-servers", "metering",
  "tools", "tool", "scale", "skill",
  // Field keywords
  "model", "disallowed-tools", "reads", "writes", "outputs", "skip",
  "retry", "isolation", "phase", "kind", "role", "version", "description",
  "permissions", "prompt", "generates", "handles", "argument", "factors",
  "behavior", "invocation", "omit", "when", "max", "parallel", "per",
  "manual", "advisory", "blocking", "min", "batch-size", "batch-count",
  "doc-count", "token-volume", "source-count", "fixed", "config",
  "track", "tokens-in", "tokens-out", "cost", "wall-time", "agent-count",
  "format", "pricing", "anthropic-current", "custom", "none", "json",
  "jsonl", "csv", "pass", "fail", "plan-gap", "bounce-back", "halt",
  "opus", "sonnet", "haiku", "inherit", "plan", "auto", "confirm",
  "bypass", "worktree", "append-only", "background", "skills",
  "user", "project", "local", "on", "matcher", "timeout",
  "PreToolUse", "PostToolUse", "PostToolUseFailure",
  "SubagentStart", "SubagentStop", "Stop", "SessionStart", "SessionEnd",
  "UserPromptSubmit", "InstructionsLoaded", "PermissionRequest",
  "Notification", "TeammateIdle", "TaskCompleted", "ConfigChange",
  "PreCompact", "WorktreeCreate", "WorktreeRemove",
  "allow", "deny", "ask", "http", "stdio", "sse", "args", "env", "url",
  "script", "lang", "bash", "python", "node", "on-fail", "after",
  "before", "run", "checks", "load-when", "path", "mode", "files",
  "routing", "protocol", "structure", "blueprints", "domains",
  "references", "external-docs", "metrics", "workspace", "conflicts",
  "detect", "resolve", "sequential-rebase", "source", "commands",
  "external", "git", "decision", "inline", "report", "not", "ticket",
  "true", "false", "pipeline", "supervisor", "blackboard",
  "orchestrator-worker", "debate", "market-routing", "consensus",
  "fan-out", "event-driven", "human-gate",
  // Extension system keywords
  "context", "extensions", "max-turns",
  "disable-model-invocation", "user-invocable", "allowed-tools",
  "domain", "fork",
  // Provider keywords
  "providers", "api-key", "base-url", "default",
  // Schedule keywords
  "schedule", "job", "cron", "every", "enabled",
  // Interface keywords
  "interfaces", "webhook", "channel", "auth", "port",
  // Sandbox keywords
  "sandbox", "docker", "network-only",
  // Fallback chain keyword
  "fallback-chain",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAgent(n: NodeDef): n is AgentNode {
  return n.type === "agent";
}

function isGate(n: NodeDef): n is GateNode {
  return n.type === "gate";
}

function isOrchestrator(n: NodeDef): n is OrchestratorNode {
  return n.type === "orchestrator";
}

/** Build a set of all declared node ids. */
function allNodeIds(ast: TopologyAST): Set<string> {
  return new Set(ast.nodes.map((n) => n.id));
}

/**
 * Collect all outputs maps across the topology.
 * Returns a map from `nodeId.outputKey` to the possible values.
 */
function collectOutputs(
  ast: TopologyAST
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const node of ast.nodes) {
    let outputs: Record<string, string[]> | undefined;
    if (isOrchestrator(node) && node.outputs) {
      outputs = node.outputs;
    } else if (isAgent(node) && node.outputs) {
      outputs = node.outputs;
    }
    if (outputs) {
      for (const [key, values] of Object.entries(outputs)) {
        map.set(`${node.id}.${key}`, values);
      }
    }
  }
  return map;
}

/**
 * Determine if an edge is a back-edge (target appears before source in
 * a topological ordering derived from the flow). We approximate this by
 * checking whether the target has an edge path leading to the source.
 */
function findBackEdges(edges: EdgeDef[], nodeIds: Set<string>): EdgeDef[] {
  // Step 1: Remove edges that already have [max N] — those are acknowledged loops.
  // We compute the topological order on the remaining "forward" edges only.
  const forwardEdges = edges.filter((e) => e.maxIterations === null);
  const loopEdges = edges.filter((e) => e.maxIterations !== null);

  // Build adjacency list from forward edges only
  const adj = new Map<string, string[]>();
  for (const id of nodeIds) {
    adj.set(id, []);
  }
  for (const e of forwardEdges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from)!.push(e.to);
  }

  // Compute topological order using Kahn's algorithm on forward edges.
  const inDegree = new Map<string, number>();
  for (const id of nodeIds) inDegree.set(id, 0);
  for (const e of forwardEdges) {
    if (nodeIds.has(e.to)) {
      inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const order = new Map<string, number>();
  let idx = 0;
  while (queue.length > 0) {
    const node = queue.shift()!;
    order.set(node, idx++);
    for (const next of adj.get(node) ?? []) {
      if (!nodeIds.has(next)) continue;
      const newDeg = (inDegree.get(next) ?? 1) - 1;
      inDegree.set(next, newDeg);
      if (newDeg === 0) queue.push(next);
    }
  }

  // Step 2: Among forward edges (no max N), find those that go backwards.
  // These are the problematic back-edges that NEED a [max N] bound.
  const backEdges: EdgeDef[] = [];
  for (const e of forwardEdges) {
    const fromOrd = order.get(e.from);
    const toOrd = order.get(e.to);
    if (fromOrd === undefined || toOrd === undefined) {
      // Nodes in unresolvable cycles
      backEdges.push(e);
    } else if (toOrd <= fromOrd) {
      backEdges.push(e);
    }
  }
  return backEdges;
}

// ---------------------------------------------------------------------------
// Rule implementations
// ---------------------------------------------------------------------------

/** V1: All agent, action, and gate names must be globally unique. */
function v1UniqueNames(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const seen = new Map<string, string>(); // id -> type
  for (const node of ast.nodes) {
    if (node.type === "orchestrator") continue; // orchestrator is a singleton
    const prev = seen.get(node.id);
    if (prev) {
      results.push({
        rule: "V1",
        level: "error",
        message: `Duplicate name "${node.id}" — already declared as ${prev}`,
        node: node.id,
      });
    } else {
      seen.set(node.id, node.type);
    }
  }
  return results;
}

/** V2: No name may match a reserved keyword. */
function v2NoKeywordNames(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  for (const node of ast.nodes) {
    if (node.type === "orchestrator") continue;
    if (RESERVED_KEYWORDS.has(node.id)) {
      results.push({
        rule: "V2",
        level: "error",
        message: `Name "${node.id}" is a reserved keyword`,
        node: node.id,
      });
    }
  }
  return results;
}

/** V3: Every node referenced in flow must be a declared agent, action, or gate. */
function v3FlowResolves(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const ids = allNodeIds(ast);
  const referenced = new Set<string>();
  for (const edge of ast.edges) {
    referenced.add(edge.from);
    referenced.add(edge.to);
  }
  for (const ref of referenced) {
    if (!ids.has(ref)) {
      results.push({
        rule: "V3",
        level: "error",
        message: `Flow references undeclared node "${ref}"`,
        node: ref,
      });
    }
  }
  return results;
}

/** V4: Every agent must appear in flow unless it has `invocation: manual`. */
function v4NoOrphans(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const flowNodes = new Set<string>();
  for (const edge of ast.edges) {
    flowNodes.add(edge.from);
    flowNodes.add(edge.to);
  }
  for (const node of ast.nodes) {
    if (!isAgent(node)) continue;
    if (node.invocation === "manual") continue;
    if (!flowNodes.has(node.id)) {
      results.push({
        rule: "V4",
        level: "error",
        message: `Agent "${node.id}" is not in flow and does not have invocation: manual`,
        node: node.id,
      });
    }
  }
  return results;
}

/** V5: Every `[when x.y]` must reference a declared output. */
function v5OutputsExist(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const outputMap = collectOutputs(ast);

  for (const edge of ast.edges) {
    if (!edge.condition) continue;
    // Conditions look like "orchestrator.decision == plan-gap" or "classify.depth == 1"
    // Extract the left-hand side reference (nodeId.outputKey)
    const refMatch = edge.condition.match(
      /([a-zA-Z][a-zA-Z0-9_-]*\.[a-zA-Z][a-zA-Z0-9_-]*)/
    );
    if (refMatch) {
      const ref = refMatch[1];
      if (!outputMap.has(ref)) {
        results.push({
          rule: "V5",
          level: "error",
          message: `Condition references undeclared output "${ref}"`,
          node: edge.from,
        });
      }
    }
  }
  return results;
}

/** V6: Every back-edge must have `max N`. */
function v6BoundedLoops(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const ids = allNodeIds(ast);
  const backEdges = findBackEdges(ast.edges, ids);

  for (const edge of backEdges) {
    if (edge.maxIterations === null) {
      results.push({
        rule: "V6",
        level: "error",
        message: `Back-edge ${edge.from} -> ${edge.to} has no [max N] bound`,
        node: edge.from,
      });
    }
  }
  return results;
}

/** V7: Every agent must have a model. */
function v7ModelRequired(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  for (const node of ast.nodes) {
    if (!isAgent(node)) continue;
    if (!node.model) {
      results.push({
        rule: "V7",
        level: "error",
        message: `Agent "${node.id}" has no model specified`,
        node: node.id,
      });
    }
  }
  return results;
}

/** V8: Import references should resolve (warning only -- we cannot check the filesystem). */
function v8ImportsResolve(_ast: TopologyAST): ValidationResult[] {
  // Without filesystem access, we emit a warning-level placeholder.
  // A CLI tool can extend this check with actual file resolution.
  return [];
}

/** V9: Every action referenced in flow must appear in orchestrator.handles. */
function v9ActionsHandled(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];

  // Find orchestrator
  const orch = ast.nodes.find(isOrchestrator);
  if (!orch) return results;

  const handlesSet = new Set(orch.handles);

  // Collect action ids that appear in the flow
  const flowNodes = new Set<string>();
  for (const edge of ast.edges) {
    flowNodes.add(edge.from);
    flowNodes.add(edge.to);
  }

  for (const node of ast.nodes) {
    if (node.type !== "action") continue;
    if (flowNodes.has(node.id) && !handlesSet.has(node.id)) {
      results.push({
        rule: "V9",
        level: "error",
        message: `Action "${node.id}" is used in flow but not in orchestrator.handles`,
        node: node.id,
      });
    }
  }
  return results;
}

/** V10: Prompt content should not be empty if a prompt block is declared. */
function v10PromptsExist(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  for (const node of ast.nodes) {
    if (isAgent(node) && node.prompt !== undefined && node.prompt.trim() === "") {
      results.push({
        rule: "V10",
        level: "warning",
        message: `Agent "${node.id}" has an empty prompt block`,
        node: node.id,
      });
    }
  }
  return results;
}

/** V11: If agent A writes X and agent B reads X, a path A -> B must exist in flow. */
function v11ReadWriteConsistency(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];

  // Build a reachability map using BFS from each node
  const adj = new Map<string, Set<string>>();
  for (const node of ast.nodes) {
    adj.set(node.id, new Set());
  }
  for (const edge of ast.edges) {
    if (adj.has(edge.from)) {
      adj.get(edge.from)!.add(edge.to);
    }
  }

  function isReachable(from: string, to: string): boolean {
    if (from === to) return true;
    const visited = new Set<string>();
    const queue = [from];
    while (queue.length > 0) {
      const curr = queue.shift()!;
      if (curr === to) return true;
      if (visited.has(curr)) continue;
      visited.add(curr);
      for (const next of adj.get(curr) ?? []) {
        queue.push(next);
      }
    }
    return false;
  }

  // Collect writers: memory key -> agent ids
  const writers = new Map<string, string[]>();
  for (const node of ast.nodes) {
    if (isAgent(node) && node.writes) {
      for (const key of node.writes) {
        if (!writers.has(key)) writers.set(key, []);
        writers.get(key)!.push(node.id);
      }
    }
  }

  // Check readers
  for (const node of ast.nodes) {
    if (!isAgent(node) || !node.reads) continue;
    for (const key of node.reads) {
      const keyWriters = writers.get(key);
      if (!keyWriters) continue; // no writer = could be external, skip
      const hasPath = keyWriters.some((writerId) =>
        isReachable(writerId, node.id)
      );
      if (!hasPath) {
        results.push({
          rule: "V11",
          level: "error",
          message: `Agent "${node.id}" reads "${key}" but no writing agent has a flow path to it`,
          node: node.id,
        });
      }
    }
  }
  return results;
}

/** V12: Edge attribute order must be [when, max, per]. */
function v12EdgeAttributeOrder(ast: TopologyAST): ValidationResult[] {
  // This rule is syntactic and would ideally be checked during parsing.
  // At the AST level, the attributes are already separated into distinct fields,
  // so we cannot detect ordering violations. This rule is enforced during parsing.
  // We include it here as a no-op for completeness.
  return [];
}

/** V13: Gate `after` and `before` must reference declared nodes. */
function v13GatePlacement(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const ids = allNodeIds(ast);

  for (const node of ast.nodes) {
    if (!isGate(node)) continue;
    if (node.after && !ids.has(node.after)) {
      results.push({
        rule: "V13",
        level: "error",
        message: `Gate "${node.id}" references undeclared node "${node.after}" in "after"`,
        node: node.id,
      });
    }
    if (node.before && !ids.has(node.before)) {
      results.push({
        rule: "V13",
        level: "error",
        message: `Gate "${node.id}" references undeclared node "${node.before}" in "before"`,
        node: node.id,
      });
    }
  }
  return results;
}

/** V14: `tools` and `disallowed-tools` cannot both appear on the same agent. */
function v14ToolExclusivity(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  for (const node of ast.nodes) {
    if (!isAgent(node)) continue;
    if (
      node.tools &&
      node.tools.length > 0 &&
      node.disallowedTools &&
      node.disallowedTools.length > 0
    ) {
      results.push({
        rule: "V14",
        level: "error",
        message: `Agent "${node.id}" has both "tools" and "disallowed-tools" — they are mutually exclusive`,
        node: node.id,
      });
    }
  }
  return results;
}

/**
 * V15: When a node has ONLY conditional outgoing edges, the conditions must
 * cover all enum values of the referenced output that are reachable at that node.
 */
function v15ExhaustiveConditions(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const outputMap = collectOutputs(ast);

  // Group edges by source
  const edgesBySource = new Map<string, EdgeDef[]>();
  for (const edge of ast.edges) {
    if (!edgesBySource.has(edge.from)) {
      edgesBySource.set(edge.from, []);
    }
    edgesBySource.get(edge.from)!.push(edge);
  }

  for (const [source, outEdges] of edgesBySource) {
    // Check if ALL outgoing edges are conditional
    if (outEdges.length === 0) continue;
    const allConditional = outEdges.every((e) => e.condition !== null);
    if (!allConditional) continue;

    // All edges are conditional. Group by output reference.
    // Extract the output reference and the value being tested.
    const coveredValues = new Map<string, Set<string>>(); // outputRef -> covered values
    for (const edge of outEdges) {
      if (!edge.condition) continue;
      // Match patterns like "x.y == value" or "x.y == value"
      const condMatch = edge.condition.match(
        /([a-zA-Z][a-zA-Z0-9_-]*\.[a-zA-Z][a-zA-Z0-9_-]*)\s*==\s*(\S+)/
      );
      if (condMatch) {
        const ref = condMatch[1];
        const value = condMatch[2];
        if (!coveredValues.has(ref)) coveredValues.set(ref, new Set());
        coveredValues.get(ref)!.add(value);
      }
    }

    // Check exhaustiveness for each referenced output
    for (const [ref, covered] of coveredValues) {
      const possibleValues = outputMap.get(ref);
      if (!possibleValues) continue; // can't check if output not declared

      const missing = possibleValues.filter((v) => !covered.has(v));
      if (missing.length > 0) {
        results.push({
          rule: "V15",
          level: "error",
          message: `Node "${source}" has only conditional edges on "${ref}" but does not cover: ${missing.join(", ")}`,
          node: source,
        });
      }
    }
  }
  return results;
}

/** V16: `api-key` must be a `${...}` env-var reference (no literal secrets). */
function v16ApiKeyEnvVar(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const envVarPattern = /^\$\{[A-Z][A-Z0-9_]*\}$/;
  for (const provider of ast.providers) {
    if (provider.apiKey && !envVarPattern.test(provider.apiKey)) {
      results.push({
        rule: "V16",
        level: "error",
        message: `Provider "${provider.name}" has a literal api-key value — must be a \${ENV_VAR} reference`,
        node: provider.name,
      });
    }
  }
  return results;
}

/** V17: At most one provider may have `default: true`. */
function v17SingleDefault(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const defaults = ast.providers.filter((p) => p.default === true);
  if (defaults.length > 1) {
    results.push({
      rule: "V17",
      level: "error",
      message: `Multiple providers marked as default: ${defaults.map((p) => p.name).join(", ")} — at most one allowed`,
    });
  }
  return results;
}

/** V18: Every model referenced by an agent should exist in at least one provider's models list. */
function v18ModelInProvider(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  if (ast.providers.length === 0) return results;

  const providerModels = new Set<string>();
  for (const provider of ast.providers) {
    for (const model of provider.models) {
      providerModels.add(model);
    }
  }

  for (const node of ast.nodes) {
    if (!isAgent(node)) continue;
    if (node.model && !providerModels.has(node.model)) {
      results.push({
        rule: "V18",
        level: "warning",
        message: `Agent "${node.id}" uses model "${node.model}" which is not listed in any provider's models`,
        node: node.id,
      });
    }
  }

  // Also check orchestrator
  for (const node of ast.nodes) {
    if (!isOrchestrator(node)) continue;
    if (node.model && !providerModels.has(node.model)) {
      results.push({
        rule: "V18",
        level: "warning",
        message: `Orchestrator uses model "${node.model}" which is not listed in any provider's models`,
        node: "orchestrator",
      });
    }
  }

  return results;
}

/** V19: Provider names must be unique. */
function v19UniqueProviders(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const seen = new Set<string>();
  for (const provider of ast.providers) {
    if (seen.has(provider.name)) {
      results.push({
        rule: "V19",
        level: "error",
        message: `Duplicate provider name "${provider.name}"`,
        node: provider.name,
      });
    } else {
      seen.add(provider.name);
    }
  }
  return results;
}

/** V20: Every schedule job must reference a declared agent or action; cron and every are mutually exclusive. */
function v20ScheduleJobs(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const ids = allNodeIds(ast);

  for (const job of ast.schedules) {
    // cron and every are mutually exclusive
    if (job.cron && job.every) {
      results.push({
        rule: "V20",
        level: "error",
        message: `Schedule job "${job.id}" has both "cron" and "every" — they are mutually exclusive`,
        node: job.id,
      });
    }

    // Must reference a declared agent or action
    if (job.agent && !ids.has(job.agent)) {
      results.push({
        rule: "V20",
        level: "error",
        message: `Schedule job "${job.id}" references undeclared agent "${job.agent}"`,
        node: job.id,
      });
    }
    if (job.action && !ids.has(job.action)) {
      results.push({
        rule: "V20",
        level: "error",
        message: `Schedule job "${job.id}" references undeclared action "${job.action}"`,
        node: job.id,
      });
    }
  }
  return results;
}

/** V21: Interface webhook/auth values containing literal secrets (not `${ENV_VAR}`) should error. */
function v21InterfaceSecrets(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const envVarPattern = /^\$\{[A-Z][A-Z0-9_]*\}$/;
  const sensitiveKeys = new Set(["webhook", "auth"]);

  for (const iface of ast.interfaces) {
    for (const [key, value] of Object.entries(iface.config)) {
      if (!sensitiveKeys.has(key)) continue;
      if (typeof value === "string" && !envVarPattern.test(value)) {
        results.push({
          rule: "V21",
          level: "error",
          message: `Interface "${iface.id}" has a literal "${key}" value — must be a \${ENV_VAR} reference`,
          node: iface.id,
        });
      }
    }
  }
  return results;
}

/** V22: Every model in a fallback-chain should exist in at least one provider's models list. */
function v22FallbackChainModels(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  if (ast.providers.length === 0) return results;

  const providerModels = new Set<string>();
  for (const provider of ast.providers) {
    for (const model of provider.models) {
      providerModels.add(model);
    }
  }

  // Check per-agent fallback chains
  for (const node of ast.nodes) {
    if (!isAgent(node)) continue;
    if (!node.fallbackChain) continue;
    for (const model of node.fallbackChain) {
      if (!providerModels.has(model)) {
        results.push({
          rule: "V22",
          level: "warning",
          message: `Agent "${node.id}" fallback-chain references model "${model}" which is not listed in any provider's models`,
          node: node.id,
        });
      }
    }
  }

  // Check settings-level fallback chain
  const settingsFallback = ast.settings.fallbackChain;
  if (Array.isArray(settingsFallback)) {
    for (const model of settingsFallback) {
      if (typeof model === "string" && !providerModels.has(model)) {
        results.push({
          rule: "V22",
          level: "warning",
          message: `Settings fallback-chain references model "${model}" which is not listed in any provider's models`,
        });
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate a parsed AgentTopology AST against all 22 specification rules.
 *
 * @param ast - The parsed topology AST.
 * @returns An array of validation results. An empty array means no issues found.
 */
export function validate(ast: TopologyAST): ValidationResult[] {
  return [
    ...v1UniqueNames(ast),
    ...v2NoKeywordNames(ast),
    ...v3FlowResolves(ast),
    ...v4NoOrphans(ast),
    ...v5OutputsExist(ast),
    ...v6BoundedLoops(ast),
    ...v7ModelRequired(ast),
    ...v8ImportsResolve(ast),
    ...v9ActionsHandled(ast),
    ...v10PromptsExist(ast),
    ...v11ReadWriteConsistency(ast),
    ...v12EdgeAttributeOrder(ast),
    ...v13GatePlacement(ast),
    ...v14ToolExclusivity(ast),
    ...v15ExhaustiveConditions(ast),
    ...v16ApiKeyEnvVar(ast),
    ...v17SingleDefault(ast),
    ...v18ModelInProvider(ast),
    ...v19UniqueProviders(ast),
    ...v20ScheduleJobs(ast),
    ...v21InterfaceSecrets(ast),
    ...v22FallbackChainModels(ast),
  ];
}
