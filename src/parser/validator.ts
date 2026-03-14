/**
 * AgentTopology AST validator.
 *
 * Implements the 29 validation rules from the AgentTopology specification
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
  RetryConfig,
  ActionNode,
  HumanNode,
  GroupNode,
  SchemaType,
  SchemaFieldDef,
  SensitiveValue,
  CircuitBreakerConfig,
  CheckpointDef,
  ArtifactDef,
  PromptVariant,
  AuthDef,
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
  /** Source line number where the issue was found (1-based), if available. */
  line?: number;
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
  // Hook event keywords
  "PreToolUse", "PostToolUse", "PostToolUseFailure",
  "SubagentStart", "SubagentStop", "Stop", "SessionStart", "SessionEnd",
  "UserPromptSubmit", "InstructionsLoaded", "PermissionRequest",
  "Notification", "TeammateIdle", "TaskCompleted", "ConfigChange",
  "PreCompact", "WorktreeCreate", "WorktreeRemove",
  // C18: Universal hook events missing from validator
  "AgentStart", "AgentStop", "ToolUse", "Error",
  // C18: Permission enum values missing from validator
  "autonomous", "supervised", "interactive", "unrestricted",
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
  // Wave 1: Error handling and retry keywords
  "backoff", "interval", "max-interval", "jitter",
  "non-retryable", "exponential", "linear",
  // Wave 1: Sampling parameter keywords
  "temperature", "max-tokens", "top-p", "top-k", "stop", "seed",
  // Wave 1: Defaults and thinking keywords
  "defaults", "thinking", "thinking-budget", "off", "low", "medium", "high",
  // Wave 1: Sensitive modifier
  "sensitive",
  // Wave 1: Logging keywords
  "log-level", "debug", "info", "warn", "error",
  // Wave 1: Output format keywords
  "output-format", "json-schema", "text",
  // Wave 2: Join semantics keywords
  "join", "all", "any", "all-done", "none-failed",
  // Wave 2: Edge attribute keywords
  "tolerance", "race", "wait", "weight",
  // Wave 2: Error handler keyword
  "error-handler",
  // Wave 3: Schema system keywords
  "schemas", "schema", "input-schema", "output-schema",
  "array", "of", "optional",
  // Wave 3: Observability keywords
  "observability", "exporter", "endpoint", "service",
  "sample-rate", "capture", "prompts", "completions", "tool-args",
  "tool-results", "spans", "agents",
  // Wave 3: Observability exporter values
  "otlp", "langsmith", "datadog", "stdout",
  // Wave 3: Secret reference keywords
  "secret", "vault", "op", "awssm", "ssm", "gcpsm", "azurekv",
  // Wave 4: Composition keywords
  "as", "with", "include", "fragment", "params", "interface",
  "entry", "exit", "sha256",
  // Wave 5: Advanced pattern keywords
  "circuit-breaker", "threshold", "window", "cooldown",
  "compensates", "human", "checkpoint", "durable",
  // Wave 6: Checkpoint, replay, and artifact keywords
  "backend", "connection", "strategy", "ttl", "replay",
  "max-history", "branch", "every-node", "on-error", "explicit",
  "memory", "sqlite", "postgres", "redis", "s3",
  "artifacts", "artifact", "produces", "consumes",
  "depends-on", "retention", "type",
  // Wave 7: Group chat, reflection, and rate limiting keywords
  "group", "members", "speaker-selection", "max-rounds", "termination",
  "round-robin", "random", "reflection", "rate-limit",
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

function isHuman(n: NodeDef): n is HumanNode {
  return n.type === "human";
}

function isGroup(n: NodeDef): n is GroupNode {
  return n.type === "group";
}

/** Build a set of all declared node ids. */
function allNodeIds(ast: TopologyAST): Set<string> {
  return new Set(ast.nodes.map((n) => n.id));
}

/** Build a set of agent ids that are members of any group node. */
function groupMemberIds(ast: TopologyAST): Set<string> {
  const members = new Set<string>();
  for (const node of ast.nodes) {
    if (isGroup(node)) {
      for (const m of node.members) {
        members.add(m);
      }
    }
  }
  return members;
}

/** Look up the source line number for a node ID from the AST's _sourceMap. */
function lookupLine(ast: TopologyAST, nodeId: string): number | undefined {
  return (ast as TopologyASTWithParseErrors)._sourceMap?.[nodeId];
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
        line: lookupLine(ast, node.id),
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
        line: lookupLine(ast, node.id),
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

/** V4: Every agent must appear in flow unless it has `invocation: manual` or is a group member. */
function v4NoOrphans(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const flowNodes = new Set<string>();
  for (const edge of ast.edges) {
    flowNodes.add(edge.from);
    flowNodes.add(edge.to);
  }
  const gMembers = groupMemberIds(ast);
  for (const node of ast.nodes) {
    if (!isAgent(node)) continue;
    if (node.invocation === "manual") continue;
    if (gMembers.has(node.id)) continue;
    if (!flowNodes.has(node.id)) {
      results.push({
        rule: "V4",
        level: "error",
        message: `Agent "${node.id}" is not in flow and does not have invocation: manual`,
        node: node.id,
        line: lookupLine(ast, node.id),
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

/** V7: Every agent and orchestrator must have a model. */
function v7ModelRequired(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  for (const node of ast.nodes) {
    if (isAgent(node)) {
      if (!node.model) {
        results.push({
          rule: "V7",
          level: "error",
          message: `Agent "${node.id}" has no model specified`,
          node: node.id,
          line: lookupLine(ast, node.id),
        });
      }
    } else if (isOrchestrator(node)) {
      if (!node.model) {
        results.push({
          rule: "V7",
          level: "error",
          message: `Orchestrator has no model specified`,
          node: node.id,
          line: lookupLine(ast, node.id),
        });
      }
    }
  }
  return results;
}

/**
 * V8: Import references should resolve (warning only -- we cannot check the filesystem).
 *
 * NOTE: This is a placeholder. The import system is not yet implemented in the
 * parser, so this rule always returns [] and is effectively skipped. It is
 * retained for completeness so the rule numbering stays consistent with the
 * spec. A future CLI extension can provide actual filesystem resolution.
 */
function v8ImportsResolve(_ast: TopologyAST): ValidationResult[] {
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
        line: lookupLine(ast, node.id),
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
        line: lookupLine(ast, node.id),
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

  // Build group co-membership lookup: if A and B are in the same group,
  // they communicate via group chat and don't need explicit flow paths.
  const coGroupMembers = new Map<string, Set<string>>();
  for (const node of ast.nodes) {
    if (isGroup(node)) {
      for (const m of node.members) {
        if (!coGroupMembers.has(m)) coGroupMembers.set(m, new Set());
        for (const other of node.members) {
          if (other !== m) coGroupMembers.get(m)!.add(other);
        }
      }
    }
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
        isReachable(writerId, node.id) ||
        (coGroupMembers.get(node.id)?.has(writerId) ?? false)
      );
      if (!hasPath) {
        results.push({
          rule: "V11",
          level: "error",
          message: `Agent "${node.id}" reads "${key}" but no writing agent has a flow path to it`,
          node: node.id,
          line: lookupLine(ast, node.id),
        });
      }
    }
  }
  return results;
}

/**
 * V12: Edge attribute order must be [when, max, per].
 *
 * This rule is syntactic — at the AST level the attributes are already
 * separated into distinct fields, so ordering violations cannot be detected
 * post-parse. The parser's {@link parseFlow} function enforces this: its
 * regex requires annotations to begin with `when` or `max` (not both in
 * reversed order). If `[max N, when ...]` is written, `parseFlow` will
 * still extract both values but the condition is silently mis-parsed.
 *
 * To catch mis-ordered annotations reliably, the parser emits a
 * V12 error via `edgeAttributeErrors` when `max` appears before `when`
 * in the same bracket annotation. Those errors are forwarded here.
 */
function v12EdgeAttributeOrder(ast: TopologyAST): ValidationResult[] {
  // Errors are collected during parsing and attached to the AST.
  // See parseFlow() in src/parser/index.ts.
  return (ast as TopologyASTWithParseErrors)._edgeAttributeErrors ?? [];
}

/** Extended AST type that may carry parse-time errors/warnings. */
interface TopologyASTWithParseErrors extends TopologyAST {
  _edgeAttributeErrors?: ValidationResult[];
  _duplicateSectionWarnings?: ValidationResult[];
  _unknownMemorySubBlockWarnings?: ValidationResult[];
  /** Maps node/block IDs to their source line numbers (1-based). */
  _sourceMap?: Record<string, number>;
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
        line: lookupLine(ast, node.id),
      });
    }
    if (node.before && !ids.has(node.before)) {
      results.push({
        rule: "V13",
        level: "error",
        message: `Gate "${node.id}" references undeclared node "${node.before}" in "before"`,
        node: node.id,
        line: lookupLine(ast, node.id),
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
        line: lookupLine(ast, node.id),
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
        line: lookupLine(ast, node.id),
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
        line: lookupLine(ast, "orchestrator"),
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
  const sensitiveKeys = new Set(["webhook", "auth", "token", "secret"]);

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
          line: lookupLine(ast, node.id),
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

/**
 * V23: Duplicate top-level singleton sections.
 *
 * Sections like `meta`, `flow`, `memory`, etc. should appear at most once.
 * When duplicates are found, only the first occurrence is used by the parser.
 * This rule surfaces warnings collected during parsing.
 */
function v23DuplicateSections(ast: TopologyAST): ValidationResult[] {
  return (ast as TopologyASTWithParseErrors)._duplicateSectionWarnings ?? [];
}

/**
 * V24: Unknown sub-blocks in the `memory` section.
 *
 * Only known sub-blocks (domains, references, external-docs, metrics,
 * workspace) are parsed. Any other named sub-block is flagged as a warning.
 */
function v24UnknownMemorySubBlocks(ast: TopologyAST): ValidationResult[] {
  return (ast as TopologyASTWithParseErrors)._unknownMemorySubBlockWarnings ?? [];
}

/** V26: `action.kind` must be one of the allowed values. */
function v26ActionKindEnum(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const VALID_KINDS = new Set(["external", "git", "decision", "inline", "report"]);
  for (const node of ast.nodes) {
    if (node.type !== "action") continue;
    const action = node as import("./ast.js").ActionNode;
    if (action.kind && !VALID_KINDS.has(action.kind)) {
      results.push({
        rule: "V26",
        level: "error",
        message: `Action "${action.id}" has invalid kind "${action.kind}" — must be one of: external, git, decision, inline, report`,
        node: action.id,
        line: lookupLine(ast, action.id),
      });
    }
  }
  return results;
}

/** V27: `agent.permissions` should be one of the known values. */
function v27AgentPermissionsEnum(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const VALID_PERMISSIONS = new Set([
    "autonomous", "supervised", "interactive", "unrestricted",
    "plan", "auto", "confirm", "bypass",
  ]);
  for (const node of ast.nodes) {
    if (!isAgent(node)) continue;
    if (node.permissions && !VALID_PERMISSIONS.has(node.permissions)) {
      results.push({
        rule: "V27",
        level: "warning",
        message: `Agent "${node.id}" has unrecognized permissions "${node.permissions}" — known values: autonomous, supervised, interactive, unrestricted, plan, auto, confirm, bypass`,
        node: node.id,
        line: lookupLine(ast, node.id),
      });
    }
  }
  return results;
}

/** V28: `metering.format` must be one of the allowed values. */
function v28MeteringFormatEnum(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const VALID_FORMATS = new Set(["json", "jsonl", "csv"]);
  if (ast.metering && !VALID_FORMATS.has(ast.metering.format)) {
    results.push({
      rule: "V28",
      level: "error",
      message: `Metering format "${ast.metering.format}" is invalid — must be one of: json, jsonl, csv`,
    });
  }
  return results;
}

/** V29: `metering.pricing` should be one of the known values. */
function v29MeteringPricingEnum(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const VALID_PRICING = new Set(["anthropic-current", "custom", "none"]);
  if (ast.metering && !VALID_PRICING.has(ast.metering.pricing)) {
    results.push({
      rule: "V29",
      level: "warning",
      message: `Metering pricing "${ast.metering.pricing}" is unrecognized — known values: anthropic-current, custom, none`,
    });
  }
  return results;
}

/** V25: `on-fail: bounce-back` is advisory on all CLI bindings. */
function v25BounceBackAdvisory(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  for (const node of ast.nodes) {
    if (node.type !== "gate") continue;
    const gate = node as GateNode;
    if (gate.onFail === "bounce-back") {
      results.push({
        rule: "V25",
        level: "warning",
        message: `Gate "${gate.id}" uses on-fail: bounce-back which is advisory on all CLI bindings — requires orchestrator cooperation or a framework binding for enforcement`,
        node: gate.id,
      });
    }
  }
  return results;
}

/** V30: Validate `timeout` format is a valid duration string (matches /^\d+[smhd]$/). */
function v30TimeoutFormat(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const durationRe = /^\d+[smhd]$/;

  for (const node of ast.nodes) {
    if (isAgent(node) && node.timeout) {
      if (!durationRe.test(node.timeout)) {
        results.push({
          rule: "V30",
          level: "error",
          message: `Agent "${node.id}" has invalid timeout "${node.timeout}" — must match format like "30s", "5m", "2h", "1d"`,
          node: node.id,
          line: lookupLine(ast, node.id),
        });
      }
    }
    if (node.type === "action") {
      const action = node as ActionNode;
      if (action.timeout && !durationRe.test(action.timeout)) {
        results.push({
          rule: "V30",
          level: "error",
          message: `Action "${action.id}" has invalid timeout "${action.timeout}" — must match format like "30s", "5m", "2h", "1d"`,
          node: action.id,
          line: lookupLine(ast, action.id),
        });
      }
    }
    if (isGate(node) && node.timeout) {
      if (!durationRe.test(node.timeout)) {
        results.push({
          rule: "V30",
          level: "error",
          message: `Gate "${node.id}" has invalid timeout "${node.timeout}" — must match format like "30s", "5m", "2h", "1d"`,
          node: node.id,
          line: lookupLine(ast, node.id),
        });
      }
    }
    if (isHuman(node) && node.timeout) {
      if (!durationRe.test(node.timeout)) {
        results.push({
          rule: "V30",
          level: "error",
          message: `Human node "${node.id}" has invalid timeout "${node.timeout}" — must match format like "30s", "5m", "2h", "1d"`,
          node: node.id,
          line: lookupLine(ast, node.id),
        });
      }
    }
    if (isGroup(node) && node.timeout) {
      if (!durationRe.test(node.timeout)) {
        results.push({
          rule: "V30",
          level: "error",
          message: `Group node "${node.id}" has invalid timeout "${node.timeout}" — must match format like "30s", "5m", "2h", "1d"`,
          node: node.id,
          line: lookupLine(ast, node.id),
        });
      }
    }
  }
  return results;
}

/** V59: Human node `on-timeout` must be one of: halt, skip, or start with "fallback ". */
function v59HumanOnTimeout(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const VALID_ON_TIMEOUT = new Set(["halt", "skip"]);

  for (const node of ast.nodes) {
    if (isHuman(node) && node.onTimeout) {
      if (!VALID_ON_TIMEOUT.has(node.onTimeout) && !node.onTimeout.startsWith("fallback ")) {
        results.push({
          rule: "V59",
          level: "error",
          message: `Human node "${node.id}" has invalid on-timeout "${node.onTimeout}" — must be "halt", "skip", or "fallback <id>"`,
          node: node.id,
          line: lookupLine(ast, node.id),
        });
      }
    }
  }
  return results;
}

/** V31: Validate `on-fail` is one of: halt, retry, skip, continue, or starts with "fallback ". */
function v31OnFailValue(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const VALID_ON_FAIL = new Set(["halt", "retry", "skip", "continue"]);

  function checkOnFail(nodeId: string, nodeType: string, onFail: string) {
    if (!VALID_ON_FAIL.has(onFail) && !onFail.startsWith("fallback ")) {
      results.push({
        rule: "V31",
        level: "error",
        message: `${nodeType} "${nodeId}" has invalid on-fail "${onFail}" — must be one of: halt, retry, skip, continue, or "fallback <agent-id>"`,
        node: nodeId,
        line: lookupLine(ast, nodeId),
      });
    }
  }

  for (const node of ast.nodes) {
    if (isAgent(node) && node.onFail) {
      checkOnFail(node.id, "Agent", node.onFail);
    }
    if (node.type === "action") {
      const action = node as ActionNode;
      if (action.onFail) {
        checkOnFail(action.id, "Action", action.onFail);
      }
    }
  }
  return results;
}

/** V32: If `on-fail: fallback <id>`, validate that the referenced agent exists. */
function v32FallbackTargetExists(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const ids = allNodeIds(ast);

  function checkFallback(nodeId: string, nodeType: string, onFail: string) {
    if (onFail.startsWith("fallback ")) {
      const targetId = onFail.slice("fallback ".length).trim();
      if (!ids.has(targetId)) {
        results.push({
          rule: "V32",
          level: "error",
          message: `${nodeType} "${nodeId}" references undeclared fallback agent "${targetId}"`,
          node: nodeId,
          line: lookupLine(ast, nodeId),
        });
      }
    }
  }

  for (const node of ast.nodes) {
    if (isAgent(node) && node.onFail) {
      checkFallback(node.id, "Agent", node.onFail);
    }
    if (node.type === "action") {
      const action = node as ActionNode;
      if (action.onFail) {
        checkFallback(action.id, "Action", action.onFail);
      }
    }
  }
  return results;
}

/** V33: Validate retry block fields (backoff enum, interval format, non-retryable is list). */
function v33RetryBlockFields(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const VALID_BACKOFF = new Set(["none", "linear", "exponential"]);
  const durationRe = /^\d+[smhd]$/;

  for (const node of ast.nodes) {
    if (!isAgent(node)) continue;
    if (!node.retry || typeof node.retry === "number") continue;

    const retryConfig = node.retry as RetryConfig;

    if (retryConfig.backoff && !VALID_BACKOFF.has(retryConfig.backoff)) {
      results.push({
        rule: "V33",
        level: "error",
        message: `Agent "${node.id}" retry block has invalid backoff "${retryConfig.backoff}" — must be one of: none, linear, exponential`,
        node: node.id,
        line: lookupLine(ast, node.id),
      });
    }

    if (retryConfig.interval && !durationRe.test(retryConfig.interval)) {
      results.push({
        rule: "V33",
        level: "error",
        message: `Agent "${node.id}" retry block has invalid interval "${retryConfig.interval}" — must match format like "1s", "5m"`,
        node: node.id,
        line: lookupLine(ast, node.id),
      });
    }

    if (retryConfig.maxInterval && !durationRe.test(retryConfig.maxInterval)) {
      results.push({
        rule: "V33",
        level: "error",
        message: `Agent "${node.id}" retry block has invalid max-interval "${retryConfig.maxInterval}" — must match format like "60s", "5m"`,
        node: node.id,
        line: lookupLine(ast, node.id),
      });
    }
  }
  return results;
}

/** V34: Validate `temperature` is between 0 and 2 (on agents and defaults). */
function v34TemperatureRange(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];

  for (const node of ast.nodes) {
    if (!isAgent(node)) continue;
    if (node.temperature !== undefined && (node.temperature < 0 || node.temperature > 2)) {
      results.push({
        rule: "V34",
        level: "error",
        message: `Agent "${node.id}" has temperature ${node.temperature} — must be between 0 and 2`,
        node: node.id,
        line: lookupLine(ast, node.id),
      });
    }
  }

  if (ast.defaults?.temperature !== undefined && (ast.defaults.temperature < 0 || ast.defaults.temperature > 2)) {
    results.push({
      rule: "V34",
      level: "error",
      message: `Defaults block has temperature ${ast.defaults.temperature} — must be between 0 and 2`,
    });
  }

  return results;
}

/** V35: Validate `thinking` is one of: off, low, medium, high, max. */
function v35ThinkingEnum(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const VALID_THINKING = new Set(["off", "low", "medium", "high", "max"]);

  for (const node of ast.nodes) {
    if (!isAgent(node)) continue;
    if (node.thinking && !VALID_THINKING.has(node.thinking)) {
      results.push({
        rule: "V35",
        level: "error",
        message: `Agent "${node.id}" has invalid thinking "${node.thinking}" — must be one of: off, low, medium, high, max`,
        node: node.id,
        line: lookupLine(ast, node.id),
      });
    }
  }

  if (ast.defaults?.thinking && !VALID_THINKING.has(ast.defaults.thinking)) {
    results.push({
      rule: "V35",
      level: "error",
      message: `Defaults block has invalid thinking "${ast.defaults.thinking}" — must be one of: off, low, medium, high, max`,
    });
  }

  return results;
}

/** V36: Validate `output-format` is one of: text, json, json-schema. */
function v36OutputFormatEnum(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const VALID_FORMATS = new Set(["text", "json", "json-schema"]);

  for (const node of ast.nodes) {
    if (!isAgent(node)) continue;
    if (node.outputFormat && !VALID_FORMATS.has(node.outputFormat)) {
      results.push({
        rule: "V36",
        level: "error",
        message: `Agent "${node.id}" has invalid output-format "${node.outputFormat}" — must be one of: text, json, json-schema`,
        node: node.id,
        line: lookupLine(ast, node.id),
      });
    }
  }

  if (ast.defaults?.outputFormat && !VALID_FORMATS.has(ast.defaults.outputFormat)) {
    results.push({
      rule: "V36",
      level: "error",
      message: `Defaults block has invalid output-format "${ast.defaults.outputFormat}" — must be one of: text, json, json-schema`,
    });
  }

  return results;
}

/** V37: Validate `log-level` is one of: debug, info, warn, error. */
function v37LogLevelEnum(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const VALID_LEVELS = new Set(["debug", "info", "warn", "error"]);

  for (const node of ast.nodes) {
    if (!isAgent(node)) continue;
    if (node.logLevel && !VALID_LEVELS.has(node.logLevel)) {
      results.push({
        rule: "V37",
        level: "error",
        message: `Agent "${node.id}" has invalid log-level "${node.logLevel}" — must be one of: debug, info, warn, error`,
        node: node.id,
        line: lookupLine(ast, node.id),
      });
    }
  }

  if (ast.defaults?.logLevel && !VALID_LEVELS.has(ast.defaults.logLevel)) {
    results.push({
      rule: "V37",
      level: "error",
      message: `Defaults block has invalid log-level "${ast.defaults.logLevel}" — must be one of: debug, info, warn, error`,
    });
  }

  return results;
}

/** V38: Validate `max-tokens` is a positive integer. */
function v38MaxTokensPositive(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];

  for (const node of ast.nodes) {
    if (!isAgent(node)) continue;
    if (node.maxTokens !== undefined && (!Number.isInteger(node.maxTokens) || node.maxTokens <= 0)) {
      results.push({
        rule: "V38",
        level: "error",
        message: `Agent "${node.id}" has invalid max-tokens ${node.maxTokens} — must be a positive integer`,
        node: node.id,
        line: lookupLine(ast, node.id),
      });
    }
  }

  if (ast.defaults?.maxTokens !== undefined && (!Number.isInteger(ast.defaults.maxTokens) || ast.defaults.maxTokens <= 0)) {
    results.push({
      rule: "V38",
      level: "error",
      message: `Defaults block has invalid max-tokens ${ast.defaults.maxTokens} — must be a positive integer`,
    });
  }

  return results;
}

/** Regex for N-of-M quorum join pattern. */
const QUORUM_RE = /^\d+-of-\d+$/;

/** Check whether a join value is valid (keyword or quorum pattern). */
function isValidJoin(value: string): boolean {
  const VALID_JOIN = new Set(["all", "any", "all-done", "none-failed"]);
  return VALID_JOIN.has(value) || QUORUM_RE.test(value);
}

/** V39: Validate `join` is one of: all, any, all-done, none-failed, or N-of-M. */
function v39JoinEnum(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];

  for (const node of ast.nodes) {
    if (isAgent(node) && node.join && !isValidJoin(node.join)) {
      results.push({
        rule: "V39",
        level: "error",
        message: `Agent "${node.id}" has invalid join "${node.join}" — must be one of: all, any, all-done, none-failed, or N-of-M (e.g. 2-of-3)`,
        node: node.id,
        line: lookupLine(ast, node.id),
      });
    }
    if (node.type === "action") {
      const action = node as ActionNode;
      if (action.join && !isValidJoin(action.join)) {
        results.push({
          rule: "V39",
          level: "error",
          message: `Action "${action.id}" has invalid join "${action.join}" — must be one of: all, any, all-done, none-failed, or N-of-M (e.g. 2-of-3)`,
          node: action.id,
          line: lookupLine(ast, action.id),
        });
      }
    }
  }
  return results;
}

/** V40: Error edge target must be a declared node. */
function v40ErrorEdgeTarget(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const ids = allNodeIds(ast);

  for (const edge of ast.edges) {
    if (edge.isError) {
      if (!ids.has(edge.to)) {
        results.push({
          rule: "V40",
          level: "error",
          message: `Error edge target "${edge.to}" is not a declared node`,
          node: edge.to,
        });
      }
    }
  }
  return results;
}

/** V41: `[race]` is only valid on fan-out edges (node has multiple outgoing edges). */
function v41RaceFanOut(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];

  // Count outgoing edges per source node
  const outgoing = new Map<string, number>();
  for (const edge of ast.edges) {
    outgoing.set(edge.from, (outgoing.get(edge.from) ?? 0) + 1);
  }

  for (const edge of ast.edges) {
    if (edge.race) {
      const count = outgoing.get(edge.from) ?? 0;
      if (count < 2) {
        results.push({
          rule: "V41",
          level: "error",
          message: `[race] on edge "${edge.from}" -> "${edge.to}" is only valid on fan-out edges (node must have multiple outgoing edges)`,
          node: edge.from,
        });
      }
    }
  }
  return results;
}

/** V42: `[tolerance]` format is valid (integer or percentage string matching /^\d+%?$/). */
function v42ToleranceFormat(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const toleranceRe = /^\d+%?$/;

  for (const edge of ast.edges) {
    if (edge.tolerance !== undefined) {
      const tolStr = String(edge.tolerance);
      if (!toleranceRe.test(tolStr)) {
        results.push({
          rule: "V42",
          level: "error",
          message: `Edge "${edge.from}" -> "${edge.to}" has invalid tolerance "${tolStr}" — must be an integer or a percentage (e.g. "2" or "33%")`,
          node: edge.from,
        });
      }
    }
  }
  return results;
}

/** V43: `[wait]` format is a valid duration string (reuse timeout validation pattern). */
function v43WaitFormat(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const durationRe = /^\d+[smhd]$/;

  for (const edge of ast.edges) {
    if (edge.wait) {
      if (!durationRe.test(edge.wait)) {
        results.push({
          rule: "V43",
          level: "error",
          message: `Edge "${edge.from}" -> "${edge.to}" has invalid wait duration "${edge.wait}" — must match format like "30s", "5m", "2h", "1d"`,
          node: edge.from,
        });
      }
    }
  }
  return results;
}

/** V44: Topology-level `error-handler` must reference a declared node. */
function v44ErrorHandlerExists(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  if (ast.topology.errorHandler) {
    const ids = allNodeIds(ast);
    if (!ids.has(ast.topology.errorHandler)) {
      results.push({
        rule: "V44",
        level: "error",
        message: `Topology error-handler "${ast.topology.errorHandler}" is not a declared node`,
      });
    }
  }
  return results;
}

/** V45: Topology-level `timeout` must be a valid duration string. */
function v45TopologyTimeout(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const durationRe = /^\d+[smhd]$/;
  if (ast.topology.timeout && !durationRe.test(ast.topology.timeout)) {
    results.push({
      rule: "V45",
      level: "error",
      message: `Topology timeout "${ast.topology.timeout}" is invalid — must match format like "30s", "5m", "2h", "1d"`,
    });
  }
  return results;
}

/** V46: Schema type names must be valid (primitive, array of X, enum, or ref). */
function v46SchemaTypeValid(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const VALID_PRIMITIVES = new Set(["string", "number", "integer", "boolean", "object"]);

  function validateSchemaType(t: SchemaType, context: string): void {
    switch (t.kind) {
      case "primitive":
        if (!VALID_PRIMITIVES.has(t.value)) {
          results.push({
            rule: "V46",
            level: "error",
            message: `Invalid schema type "${t.value}" in ${context} — must be string, number, integer, boolean, or object`,
          });
        }
        break;
      case "array":
        validateSchemaType(t.itemType, context);
        break;
      case "enum":
        // Enum values are always valid strings
        break;
      case "ref":
        // Ref validity is checked by V47
        break;
    }
  }

  function validateFields(fields: SchemaFieldDef[], context: string): void {
    for (const field of fields) {
      validateSchemaType(field.type, `${context} field "${field.name}"`);
    }
  }

  // Check top-level schemas
  for (const schema of ast.schemas) {
    validateFields(schema.fields, `schema "${schema.id}"`);
  }

  // Check agent input/output schemas
  for (const node of ast.nodes) {
    if (node.type === "agent") {
      if (node.inputSchema) {
        validateFields(node.inputSchema, `agent "${node.id}" input-schema`);
      }
      if (node.outputSchema) {
        validateFields(node.outputSchema, `agent "${node.id}" output-schema`);
      }
    }
  }

  return results;
}

/** V47: Schema `ref` names must resolve to a declared schema in the top-level `schemas` block. */
function v47SchemaRefResolves(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const declaredSchemas = new Set(ast.schemas.map((s) => s.id));

  function checkRefs(t: SchemaType, context: string): void {
    switch (t.kind) {
      case "ref":
        if (!declaredSchemas.has(t.name)) {
          results.push({
            rule: "V47",
            level: "error",
            message: `Schema reference "${t.name}" in ${context} does not resolve to any declared schema`,
          });
        }
        break;
      case "array":
        checkRefs(t.itemType, context);
        break;
      // primitive and enum have no refs
    }
  }

  function checkFields(fields: SchemaFieldDef[], context: string): void {
    for (const field of fields) {
      checkRefs(field.type, `${context} field "${field.name}"`);
    }
  }

  // Check top-level schemas (can reference each other)
  for (const schema of ast.schemas) {
    checkFields(schema.fields, `schema "${schema.id}"`);
  }

  // Check agent input/output schemas
  for (const node of ast.nodes) {
    if (node.type === "agent") {
      if (node.inputSchema) {
        checkFields(node.inputSchema, `agent "${node.id}" input-schema`);
      }
      if (node.outputSchema) {
        checkFields(node.outputSchema, `agent "${node.id}" output-schema`);
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// V48 – Observability level enum
// ---------------------------------------------------------------------------

const VALID_OBSERVABILITY_LEVELS: ReadonlySet<string> = new Set([
  "debug", "info", "warn", "error",
]);

/** V48: Validate `observability.level` is one of: debug, info, warn, error. */
function v48ObservabilityLevel(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  if (ast.observability && !VALID_OBSERVABILITY_LEVELS.has(ast.observability.level)) {
    results.push({
      rule: "V48",
      level: "error",
      message: `Observability level "${ast.observability.level}" is invalid — must be one of: ${[...VALID_OBSERVABILITY_LEVELS].join(", ")}`,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// V49 – Observability exporter enum
// ---------------------------------------------------------------------------

const VALID_OBSERVABILITY_EXPORTERS: ReadonlySet<string> = new Set([
  "otlp", "langsmith", "datadog", "stdout", "none",
]);

/** V49: Validate `observability.exporter` is one of: otlp, langsmith, datadog, stdout, none. */
function v49ObservabilityExporter(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  if (ast.observability && !VALID_OBSERVABILITY_EXPORTERS.has(ast.observability.exporter)) {
    results.push({
      rule: "V49",
      level: "error",
      message: `Observability exporter "${ast.observability.exporter}" is invalid — must be one of: ${[...VALID_OBSERVABILITY_EXPORTERS].join(", ")}`,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// V50 – Observability sample-rate range
// ---------------------------------------------------------------------------

/** V50: Validate `observability.sample-rate` is between 0 and 1 (inclusive). */
function v50ObservabilitySampleRate(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  if (ast.observability) {
    const rate = ast.observability.sampleRate;
    if (isNaN(rate) || rate < 0 || rate > 1) {
      results.push({
        rule: "V50",
        level: "error",
        message: `Observability sample-rate ${rate} is invalid — must be between 0 and 1`,
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// V51 – Sensitive literal warning
// ---------------------------------------------------------------------------

const SENSITIVE_ENV_VAR_RE = /\$\{[^}]+\}/;

/**
 * V51: When `sensitive` is used with a literal string (not a `${...}` env var
 * reference), emit a warning. Literal secrets should never appear in source.
 */
function v51SensitiveLiteral(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  for (const [key, val] of Object.entries(ast.env)) {
    if (typeof val === "object" && val !== null && val.sensitive && !val.secretRef) {
      // It's a sensitive value without a secret ref — check if it's a literal
      if (!SENSITIVE_ENV_VAR_RE.test(val.value)) {
        results.push({
          rule: "V51",
          level: "warning",
          message: `env "${key}": sensitive value should reference an environment variable, not a literal string`,
        });
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// V52 – Secret URI scheme validation
// ---------------------------------------------------------------------------

const VALID_SECRET_SCHEMES: ReadonlySet<string> = new Set([
  "vault", "op", "awssm", "ssm", "gcpsm", "azurekv",
]);

/**
 * V52: Validate that secret URI schemes are one of the supported providers.
 */
function v52SecretUriScheme(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  for (const [key, val] of Object.entries(ast.env)) {
    if (typeof val === "object" && val !== null && val.secretRef) {
      if (!VALID_SECRET_SCHEMES.has(val.secretRef.scheme)) {
        results.push({
          rule: "V52",
          level: "error",
          message: `env "${key}": unknown secret URI scheme "${val.secretRef.scheme}" — must be one of: ${[...VALID_SECRET_SCHEMES].join(", ")}`,
        });
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// V53 – Param type validation
// ---------------------------------------------------------------------------

/**
 * V53: Param type must be one of: `string`, `number`, `boolean`.
 */
function v53ParamType(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const VALID_PARAM_TYPES: ReadonlySet<string> = new Set(["string", "number", "boolean"]);
  for (const param of ast.params) {
    if (!VALID_PARAM_TYPES.has(param.type)) {
      results.push({
        rule: "V53",
        level: "error",
        message: `param "${param.name}": type "${param.type}" is invalid — must be one of: string, number, boolean`,
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// V54 – Interface entry/exit must reference declared nodes
// ---------------------------------------------------------------------------

/**
 * V54: Interface entry and exit must reference declared node ids.
 */
function v54InterfaceEndpoints(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  if (!ast.interfaceEndpoints) return results;

  const nodeIds = new Set(ast.nodes.map((n) => n.id));
  if (!nodeIds.has(ast.interfaceEndpoints.entry)) {
    results.push({
      rule: "V54",
      level: "error",
      message: `interface entry "${ast.interfaceEndpoints.entry}" does not reference a declared node`,
    });
  }
  if (!nodeIds.has(ast.interfaceEndpoints.exit)) {
    results.push({
      rule: "V54",
      level: "error",
      message: `interface exit "${ast.interfaceEndpoints.exit}" does not reference a declared node`,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// V55 – Import alias must be unique
// ---------------------------------------------------------------------------

/**
 * V55: No two imports may share the same alias.
 */
function v55UniqueImportAlias(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const seen = new Set<string>();
  for (const imp of ast.imports) {
    if (seen.has(imp.alias)) {
      results.push({
        rule: "V55",
        level: "error",
        message: `import alias "${imp.alias}" is used more than once — each import must have a unique alias`,
      });
    }
    seen.add(imp.alias);
  }
  return results;
}

// ---------------------------------------------------------------------------
// V56 – Import source path validation
// ---------------------------------------------------------------------------

/**
 * V56: Import source must be a syntactically valid path (starts with `./`,
 * `../`, or is a registry address containing `/`).
 */
function v56ImportSourcePath(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  for (const imp of ast.imports) {
    const src = imp.source;
    const isRelative = src.startsWith("./") || src.startsWith("../");
    const isRegistry = src.includes("/") && !src.startsWith("/");
    if (!isRelative && !isRegistry) {
      results.push({
        rule: "V56",
        level: "error",
        message: `import source "${src}" is not a valid path — must start with "./" or "../" or be a registry address`,
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// V57 – Circuit breaker fields validation
// ---------------------------------------------------------------------------

/**
 * V57: Validate circuit-breaker fields — threshold must be a positive integer,
 * window and cooldown must be valid duration strings matching /^\d+[smhd]$/.
 */
function v57CircuitBreakerFields(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const durationRe = /^\d+[smhd]$/;

  for (const node of ast.nodes) {
    if (!isAgent(node) || !node.circuitBreaker) continue;
    const cb = node.circuitBreaker;

    if (!Number.isInteger(cb.threshold) || cb.threshold < 1) {
      results.push({
        rule: "V57",
        level: "error",
        message: `Agent "${node.id}" circuit-breaker has invalid threshold "${cb.threshold}" — must be a positive integer`,
        node: node.id,
        line: lookupLine(ast, node.id),
      });
    }

    if (!durationRe.test(cb.window)) {
      results.push({
        rule: "V57",
        level: "error",
        message: `Agent "${node.id}" circuit-breaker has invalid window "${cb.window}" — must match format like "30s", "5m", "2h", "1d"`,
        node: node.id,
        line: lookupLine(ast, node.id),
      });
    }

    if (!durationRe.test(cb.cooldown)) {
      results.push({
        rule: "V57",
        level: "error",
        message: `Agent "${node.id}" circuit-breaker has invalid cooldown "${cb.cooldown}" — must match format like "30s", "5m", "2h", "1d"`,
        node: node.id,
        line: lookupLine(ast, node.id),
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// V58 – compensates must reference a declared agent
// ---------------------------------------------------------------------------

/**
 * V58: `compensates` must reference a declared agent node.
 */
function v58CompensatesTarget(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const nodeIds = allNodeIds(ast);

  for (const node of ast.nodes) {
    if (node.type === "agent" && node.compensates) {
      if (!nodeIds.has(node.compensates)) {
        results.push({
          rule: "V58",
          level: "error",
          message: `agent "${node.id}": compensates target "${node.compensates}" is not a declared node`,
          node: node.id,
        });
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// V60 – Quorum join validation
// ---------------------------------------------------------------------------

/**
 * V60: When `join` uses quorum syntax `N-of-M`, validate:
 * - N >= 1
 * - M >= 2
 * - N <= M
 */
function v60QuorumJoin(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];

  function checkQuorum(nodeId: string, join: string): void {
    if (!QUORUM_RE.test(join)) return;
    const [nStr, mStr] = join.split("-of-");
    const n = parseInt(nStr, 10);
    const m = parseInt(mStr, 10);

    if (n < 1) {
      results.push({
        rule: "V60",
        level: "error",
        message: `Node "${nodeId}" has invalid quorum join "${join}" — N must be >= 1`,
        node: nodeId,
        line: lookupLine(ast, nodeId),
      });
    }
    if (m < 2) {
      results.push({
        rule: "V60",
        level: "error",
        message: `Node "${nodeId}" has invalid quorum join "${join}" — M must be >= 2`,
        node: nodeId,
        line: lookupLine(ast, nodeId),
      });
    }
    if (n > m) {
      results.push({
        rule: "V60",
        level: "error",
        message: `Node "${nodeId}" has invalid quorum join "${join}" — N must be <= M`,
        node: nodeId,
        line: lookupLine(ast, nodeId),
      });
    }
  }

  for (const node of ast.nodes) {
    if (isAgent(node) && node.join) checkQuorum(node.id, node.join);
    if (node.type === "action") {
      const action = node as ActionNode;
      if (action.join) checkQuorum(action.id, action.join);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// V61 – Weight edge attribute validation
// ---------------------------------------------------------------------------

/**
 * V61: Validate `[weight N]` edge attributes:
 * - Weight must be > 0 and <= 1.
 * - Warning if weights from the same source don't sum to ~1.0 (within 0.01).
 */
function v61WeightRange(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];

  // Check individual weight values
  for (const edge of ast.edges) {
    if (edge.weight !== undefined) {
      if (edge.weight <= 0) {
        results.push({
          rule: "V61",
          level: "error",
          message: `Edge "${edge.from}" -> "${edge.to}" has invalid weight ${edge.weight} — must be > 0`,
          node: edge.from,
        });
      }
      if (edge.weight > 1) {
        results.push({
          rule: "V61",
          level: "error",
          message: `Edge "${edge.from}" -> "${edge.to}" has invalid weight ${edge.weight} — must be <= 1`,
          node: edge.from,
        });
      }
    }
  }

  // Check weight sums per source node
  const weightsBySource = new Map<string, number[]>();
  for (const edge of ast.edges) {
    if (edge.weight !== undefined) {
      if (!weightsBySource.has(edge.from)) weightsBySource.set(edge.from, []);
      weightsBySource.get(edge.from)!.push(edge.weight);
    }
  }

  for (const [source, weights] of weightsBySource) {
    const sum = weights.reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 1.0) > 0.01) {
      results.push({
        rule: "V61",
        level: "warning",
        message: `Edges from "${source}" have weights summing to ${sum.toFixed(4)} — expected ~1.0`,
        node: source,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// V67 – Checkpoint backend validation
// ---------------------------------------------------------------------------

/** Valid checkpoint backends. */
const VALID_CHECKPOINT_BACKENDS: ReadonlySet<string> = new Set([
  "memory", "sqlite", "postgres", "redis", "s3", "custom",
]);

/**
 * V67: checkpoint `backend` must be one of the known values.
 */
function v67CheckpointBackend(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  if (!ast.checkpoint) return results;

  if (!VALID_CHECKPOINT_BACKENDS.has(ast.checkpoint.backend)) {
    results.push({
      rule: "V67",
      level: "error",
      message: `checkpoint backend "${ast.checkpoint.backend}" is invalid — must be one of: ${[...VALID_CHECKPOINT_BACKENDS].join(", ")}`,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// V68 – Checkpoint strategy and TTL validation
// ---------------------------------------------------------------------------

/** Valid checkpoint strategies. */
const VALID_CHECKPOINT_STRATEGIES: ReadonlySet<string> = new Set([
  "every-node", "on-error", "explicit", "none",
]);

/**
 * V68: checkpoint `strategy` must be one of the known values,
 * and `ttl` must be a valid duration string if present.
 */
function v68CheckpointStrategy(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  if (!ast.checkpoint) return results;

  if (!VALID_CHECKPOINT_STRATEGIES.has(ast.checkpoint.strategy)) {
    results.push({
      rule: "V68",
      level: "error",
      message: `checkpoint strategy "${ast.checkpoint.strategy}" is invalid — must be one of: ${[...VALID_CHECKPOINT_STRATEGIES].join(", ")}`,
    });
  }

  if (ast.checkpoint.ttl) {
    const durationRe = /^\d+[smhd]$/;
    if (!durationRe.test(ast.checkpoint.ttl)) {
      results.push({
        rule: "V68",
        level: "error",
        message: `checkpoint ttl "${ast.checkpoint.ttl}" is invalid — must match format like "30s", "5m", "2h", "7d"`,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// V69 – Replay configuration validation
// ---------------------------------------------------------------------------

/**
 * V69: replay requires strategy "every-node"; max-history must be a positive
 * integer; warn if backend is "memory" with replay enabled.
 */
function v69ReplayConfig(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  if (!ast.checkpoint?.replay) return results;

  const replay = ast.checkpoint.replay;

  // replay requires strategy "every-node"
  if (ast.checkpoint.strategy !== "every-node") {
    results.push({
      rule: "V69",
      level: "error",
      message: `checkpoint replay requires strategy "every-node" but found "${ast.checkpoint.strategy}" — cannot replay without full checkpointing`,
    });
  }

  // max-history must be positive integer
  if (replay.maxHistory !== undefined) {
    if (!Number.isInteger(replay.maxHistory) || replay.maxHistory < 1) {
      results.push({
        rule: "V69",
        level: "error",
        message: `checkpoint replay max-history "${replay.maxHistory}" must be a positive integer`,
      });
    }
  }

  // warn if backend is "memory" with replay enabled
  if (replay.enabled && ast.checkpoint.backend === "memory") {
    results.push({
      rule: "V69",
      level: "warning",
      message: `checkpoint replay is enabled with backend "memory" — replay data will not survive restart`,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// V70 – Artifact IDs must be unique
// ---------------------------------------------------------------------------

/**
 * V70: All artifact IDs in the artifacts block must be unique.
 */
function v70UniqueArtifactIds(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const seen = new Set<string>();
  for (const artifact of ast.artifacts) {
    if (seen.has(artifact.id)) {
      results.push({
        rule: "V70",
        level: "error",
        message: `duplicate artifact id "${artifact.id}" — artifact ids must be unique`,
      });
    }
    seen.add(artifact.id);
  }
  return results;
}

// ---------------------------------------------------------------------------
// V71 – Artifact references must resolve
// ---------------------------------------------------------------------------

/**
 * V71: depends-on, produces, and consumes must reference declared artifact IDs.
 */
function v71ArtifactRefsResolve(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const artifactIds = new Set(ast.artifacts.map((a) => a.id));

  // Check depends-on within artifacts
  for (const artifact of ast.artifacts) {
    if (artifact.dependsOn) {
      for (const dep of artifact.dependsOn) {
        if (!artifactIds.has(dep)) {
          results.push({
            rule: "V71",
            level: "error",
            message: `artifact "${artifact.id}" depends-on undeclared artifact "${dep}"`,
          });
        }
      }
    }
  }

  // Check produces/consumes on agents
  for (const node of ast.nodes) {
    if (isAgent(node)) {
      if (node.produces) {
        for (const ref of node.produces) {
          if (!artifactIds.has(ref)) {
            results.push({
              rule: "V71",
              level: "error",
              message: `agent "${node.id}" produces undeclared artifact "${ref}"`,
              node: node.id,
              line: lookupLine(ast, node.id),
            });
          }
        }
      }
      if (node.consumes) {
        for (const ref of node.consumes) {
          if (!artifactIds.has(ref)) {
            results.push({
              rule: "V71",
              level: "error",
              message: `agent "${node.id}" consumes undeclared artifact "${ref}"`,
              node: node.id,
              line: lookupLine(ast, node.id),
            });
          }
        }
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// V72 – No circular artifact dependencies
// ---------------------------------------------------------------------------

/**
 * V72: Artifact dependency graph must be acyclic.
 */
function v72ArtifactCycles(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  if (ast.artifacts.length === 0) return results;

  // Build adjacency list
  const adj = new Map<string, string[]>();
  for (const artifact of ast.artifacts) {
    adj.set(artifact.id, artifact.dependsOn ?? []);
  }

  // DFS cycle detection
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const id of adj.keys()) color.set(id, WHITE);

  function dfs(node: string, path: string[]): boolean {
    color.set(node, GRAY);
    path.push(node);

    for (const dep of adj.get(node) ?? []) {
      if (!adj.has(dep)) continue; // undeclared — caught by V71
      if (color.get(dep) === GRAY) {
        const cycleStart = path.indexOf(dep);
        const cycle = path.slice(cycleStart).concat(dep);
        results.push({
          rule: "V72",
          level: "error",
          message: `circular artifact dependency detected: ${cycle.join(" -> ")}`,
        });
        return true;
      }
      if (color.get(dep) === WHITE) {
        if (dfs(dep, path)) return true;
      }
    }

    path.pop();
    color.set(node, BLACK);
    return false;
  }

  for (const id of adj.keys()) {
    if (color.get(id) === WHITE) {
      dfs(id, []);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// V73 – Registry package name validation
// ---------------------------------------------------------------------------

/** Valid registry package name pattern: lowercase kebab-case with optional namespace. */
const REGISTRY_PACKAGE_RE = /^[a-z0-9-]+(\/[a-z0-9-]+)*$/;

/**
 * V73: Registry package names must match `[a-z0-9-]+(/[a-z0-9-]+)*`.
 */
function v73RegistryPackageName(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  for (const imp of ast.imports) {
    if (!imp.registry || !imp.registryPackage) continue;
    if (!REGISTRY_PACKAGE_RE.test(imp.registryPackage)) {
      results.push({
        rule: "V73",
        level: "error",
        message: `import "${imp.source}": registry package name "${imp.registryPackage}" is invalid — must be lowercase kebab-case (a-z, 0-9, hyphens) with optional namespace separator "/"`,
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// V74 – Registry version validation (semver or "latest")
// ---------------------------------------------------------------------------

/** Simple semver pattern. */
const SEMVER_RE = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?(\+[a-zA-Z0-9.]+)?$/;

/**
 * V74: Registry package version must be valid semver or "latest".
 */
function v74RegistryVersion(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  for (const imp of ast.imports) {
    if (!imp.registry || !imp.registryVersion) continue;
    if (imp.registryVersion !== "latest" && !SEMVER_RE.test(imp.registryVersion)) {
      results.push({
        rule: "V74",
        level: "error",
        message: `import "${imp.source}": version "${imp.registryVersion}" is invalid — must be valid semver (e.g. "1.2.0") or "latest"`,
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// V75 – SHA-256 hash validation
// ---------------------------------------------------------------------------

/** Valid SHA-256: exactly 64 hex characters. */
const SHA256_RE = /^[0-9a-fA-F]{64}$/;

/**
 * V75: If sha256 is present on an import, it must be a valid 64-char hex string.
 */
function v75Sha256Format(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  for (const imp of ast.imports) {
    if (!imp.sha256) continue;
    if (!SHA256_RE.test(imp.sha256)) {
      results.push({
        rule: "V75",
        level: "error",
        message: `import "${imp.source}": sha256 "${imp.sha256}" is invalid — must be exactly 64 hexadecimal characters`,
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// V76 – Unique variant ids within agent
// ---------------------------------------------------------------------------

/**
 * V76: Variant ids must be unique within each agent.
 */
function v76UniqueVariantIds(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  for (const node of ast.nodes) {
    if (!isAgent(node) || !node.variants) continue;
    const seen = new Set<string>();
    for (const v of node.variants) {
      if (seen.has(v.id)) {
        results.push({
          rule: "V76",
          level: "error",
          message: `agent "${node.id}": duplicate variant id "${v.id}" — variant ids must be unique within an agent`,
          node: node.id,
          line: lookupLine(ast, node.id),
        });
      }
      seen.add(v.id);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// V77 – Variant weights must sum to ~1.0
// ---------------------------------------------------------------------------

/**
 * V77: Variant weights must sum to approximately 1.0 (within 0.01 tolerance).
 */
function v77VariantWeightSum(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  for (const node of ast.nodes) {
    if (!isAgent(node) || !node.variants || node.variants.length === 0) continue;
    const sum = node.variants.reduce((acc, v) => acc + v.weight, 0);
    if (Math.abs(sum - 1.0) > 0.01) {
      results.push({
        rule: "V77",
        level: "warning",
        message: `agent "${node.id}": variant weights sum to ${sum.toFixed(4)} — expected ~1.0`,
        node: node.id,
        line: lookupLine(ast, node.id),
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// V78 – Encrypted value SOPS envelope format
// ---------------------------------------------------------------------------

/** Valid SOPS methods. */
const VALID_SOPS_METHODS: ReadonlySet<string> = new Set([
  "AES256_GCM", "AES256_CBC", "RSA_OAEP",
]);

/** SOPS envelope pattern: ENC[METHOD,data:BASE64] */
const SOPS_ENVELOPE_RE = /^ENC\[([A-Z0-9_]+),data:[A-Za-z0-9+/=]+\.*\]$/;

/**
 * V78: `encrypted` values must match SOPS envelope format ENC[METHOD,data:BASE64].
 * Valid methods: AES256_GCM, AES256_CBC, RSA_OAEP.
 */
function v78EncryptedSopsFormat(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  for (const [key, val] of Object.entries(ast.env)) {
    if (typeof val === "object" && val !== null && val.encrypted) {
      const m = val.value.match(SOPS_ENVELOPE_RE);
      if (!m) {
        results.push({
          rule: "V78",
          level: "warning",
          message: `env "${key}": encrypted value does not match SOPS envelope format ENC[METHOD,data:BASE64]`,
        });
      } else if (!VALID_SOPS_METHODS.has(m[1])) {
        results.push({
          rule: "V78",
          level: "warning",
          message: `env "${key}": unknown SOPS method "${m[1]}" — valid methods: ${[...VALID_SOPS_METHODS].join(", ")}`,
        });
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// V79 – Auth type enum
// ---------------------------------------------------------------------------

/** Valid auth types. */
const VALID_AUTH_TYPES: ReadonlySet<string> = new Set([
  "oidc", "oauth2", "api-key", "aws-iam", "gcp-sa", "azure-msi",
]);

/**
 * V79: provider auth.type must be one of the known auth types.
 */
function v79AuthType(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  for (const provider of ast.providers) {
    if (!provider.auth) continue;
    if (!VALID_AUTH_TYPES.has(provider.auth.type)) {
      results.push({
        rule: "V79",
        level: "error",
        message: `provider "${provider.name}": auth type "${provider.auth.type}" is invalid — must be one of: ${[...VALID_AUTH_TYPES].join(", ")}`,
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// V80 – OIDC/OAuth2 require issuer
// ---------------------------------------------------------------------------

/**
 * V80: OIDC and OAuth2 auth types require an issuer field.
 */
function v80AuthIssuerRequired(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const TYPES_REQUIRING_ISSUER = new Set(["oidc", "oauth2"]);
  for (const provider of ast.providers) {
    if (!provider.auth) continue;
    if (TYPES_REQUIRING_ISSUER.has(provider.auth.type) && !provider.auth.issuer) {
      results.push({
        rule: "V80",
        level: "error",
        message: `provider "${provider.name}": auth type "${provider.auth.type}" requires an issuer field`,
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// V62 – [reflection] requires [max N] and must be on back-edges
// ---------------------------------------------------------------------------

/**
 * V62: `[reflection]` is only valid on back-edges (edges that form cycles)
 * and MUST have `[max N]` to prevent infinite loops.
 */
function v62ReflectionEdge(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];

  // Build adjacency set for cycle detection
  const nodeIds = allNodeIds(ast);

  for (const edge of ast.edges) {
    if (!edge.reflection) continue;

    // reflection without max is an error
    if (edge.maxIterations === null || edge.maxIterations === undefined) {
      results.push({
        rule: "V62",
        level: "error",
        message: `Edge ${edge.from} -> ${edge.to}: [reflection] requires [max N] to prevent infinite loops`,
      });
    }

    // Check if this is a back-edge (forms a cycle).
    // A simple heuristic: check if there is a path from `to` to `from` in the other edges.
    const visited = new Set<string>();
    const queue = [edge.to];
    let isCycle = false;
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === edge.from) {
        // The target can reach the source via other edges — but we need to check
        // via edges OTHER than this one (or any edge, since having a path back means cycle).
        // Actually, for back-edge detection: if `to` can reach `from` through ANY forward edges,
        // then from->to is a back edge. But the simpler check: does `from` appear as a target
        // of edges originating from `to` (directly or transitively)?
        // For the reflection edge itself: from->to with [reflection] means to->from should exist
        // in the remaining edges for this to be a cycle.
        isCycle = true;
        break;
      }
      if (visited.has(current)) continue;
      visited.add(current);
      for (const other of ast.edges) {
        if (other === edge) continue; // Skip the reflection edge itself
        if (other.from === current && !visited.has(other.to)) {
          queue.push(other.to);
        }
      }
    }

    if (!isCycle) {
      results.push({
        rule: "V62",
        level: "warning",
        message: `Edge ${edge.from} -> ${edge.to}: [reflection] is intended for back-edges that form cycles`,
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// V63 – Group node members must reference declared agent nodes
// ---------------------------------------------------------------------------

/**
 * V63: `members` in a group node must reference declared agent nodes.
 */
function v63GroupMembers(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const agentIds = new Set(ast.nodes.filter(isAgent).map((n) => n.id));

  for (const node of ast.nodes) {
    if (isGroup(node)) {
      for (const member of node.members) {
        if (!agentIds.has(member)) {
          results.push({
            rule: "V63",
            level: "error",
            message: `group "${node.id}": member "${member}" is not a declared agent node`,
            node: node.id,
            line: lookupLine(ast, node.id),
          });
        }
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// V64 – Group node speaker-selection enum
// ---------------------------------------------------------------------------

/**
 * V64: `speaker-selection` must be one of: auto, round-robin, random, manual.
 */
function v64SpeakerSelection(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const VALID = new Set(["auto", "round-robin", "random", "manual"]);

  for (const node of ast.nodes) {
    if (isGroup(node) && node.speakerSelection) {
      if (!VALID.has(node.speakerSelection)) {
        results.push({
          rule: "V64",
          level: "error",
          message: `group "${node.id}": speaker-selection "${node.speakerSelection}" is invalid — must be one of: auto, round-robin, random, manual`,
          node: node.id,
          line: lookupLine(ast, node.id),
        });
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// V65 – Group node max-rounds must be positive integer
// ---------------------------------------------------------------------------

/**
 * V65: `max-rounds` must be a positive integer.
 */
function v65MaxRounds(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];

  for (const node of ast.nodes) {
    if (isGroup(node) && node.maxRounds !== undefined) {
      if (!Number.isInteger(node.maxRounds) || node.maxRounds < 1) {
        results.push({
          rule: "V65",
          level: "error",
          message: `group "${node.id}": max-rounds must be a positive integer, got ${node.maxRounds}`,
          node: node.id,
          line: lookupLine(ast, node.id),
        });
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// V66 – Rate limit format
// ---------------------------------------------------------------------------

/**
 * V66: `rate-limit` must match N/unit where N >= 1 and unit is sec|min|hour|day.
 */
function v66RateLimitFormat(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const RATE_LIMIT_RE = /^(\d+)\/(sec|min|hour|day)$/;

  for (const node of ast.nodes) {
    if (isAgent(node) && node.rateLimit) {
      const match = node.rateLimit.match(RATE_LIMIT_RE);
      if (!match) {
        results.push({
          rule: "V66",
          level: "error",
          message: `agent "${node.id}": rate-limit "${node.rateLimit}" is invalid — must match format N/unit where unit is sec, min, hour, or day`,
          node: node.id,
          line: lookupLine(ast, node.id),
        });
      } else {
        const n = parseInt(match[1], 10);
        if (n < 1) {
          results.push({
            rule: "V66",
            level: "error",
            message: `agent "${node.id}": rate-limit value must be >= 1, got ${n}`,
            node: node.id,
            line: lookupLine(ast, node.id),
          });
        }
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate a parsed AgentTopology AST against all specification rules.
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
    ...v23DuplicateSections(ast),
    ...v24UnknownMemorySubBlocks(ast),
    ...v25BounceBackAdvisory(ast),
    ...v26ActionKindEnum(ast),
    ...v27AgentPermissionsEnum(ast),
    ...v28MeteringFormatEnum(ast),
    ...v29MeteringPricingEnum(ast),
    ...v30TimeoutFormat(ast),
    ...v31OnFailValue(ast),
    ...v32FallbackTargetExists(ast),
    ...v33RetryBlockFields(ast),
    ...v34TemperatureRange(ast),
    ...v35ThinkingEnum(ast),
    ...v36OutputFormatEnum(ast),
    ...v37LogLevelEnum(ast),
    ...v38MaxTokensPositive(ast),
    ...v39JoinEnum(ast),
    ...v40ErrorEdgeTarget(ast),
    ...v41RaceFanOut(ast),
    ...v42ToleranceFormat(ast),
    ...v43WaitFormat(ast),
    ...v44ErrorHandlerExists(ast),
    ...v45TopologyTimeout(ast),
    ...v46SchemaTypeValid(ast),
    ...v47SchemaRefResolves(ast),
    ...v48ObservabilityLevel(ast),
    ...v49ObservabilityExporter(ast),
    ...v50ObservabilitySampleRate(ast),
    ...v51SensitiveLiteral(ast),
    ...v52SecretUriScheme(ast),
    ...v53ParamType(ast),
    ...v54InterfaceEndpoints(ast),
    ...v55UniqueImportAlias(ast),
    ...v56ImportSourcePath(ast),
    ...v57CircuitBreakerFields(ast),
    ...v58CompensatesTarget(ast),
    ...v59HumanOnTimeout(ast),
    ...v60QuorumJoin(ast),
    ...v61WeightRange(ast),
    ...v67CheckpointBackend(ast),
    ...v68CheckpointStrategy(ast),
    ...v69ReplayConfig(ast),
    ...v70UniqueArtifactIds(ast),
    ...v71ArtifactRefsResolve(ast),
    ...v72ArtifactCycles(ast),
    ...v73RegistryPackageName(ast),
    ...v74RegistryVersion(ast),
    ...v75Sha256Format(ast),
    ...v76UniqueVariantIds(ast),
    ...v77VariantWeightSum(ast),
    ...v78EncryptedSopsFormat(ast),
    ...v79AuthType(ast),
    ...v80AuthIssuerRequired(ast),
    ...v62ReflectionEdge(ast),
    ...v63GroupMembers(ast),
    ...v64SpeakerSelection(ast),
    ...v65MaxRounds(ast),
    ...v66RateLimitFormat(ast),
  ];
}
