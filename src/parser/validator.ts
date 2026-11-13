/**
 * AgenTopology AST validator.
 *
 * Implements the validation rules from the AgenTopology specification
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

import { MISSING } from "./index.js";
import { gateAnchors } from "./ast.js";
import { proseInRun, scriptNameFromRun } from "./run.js";
import { matcherProblem, matcherGaps, TOOL_EVENTS } from "../conformance/claude-code.js";
import { unsafePathReason } from "./paths.js";
import { gateLedger, guardedActions } from "./ledger.js";
import { sessionAgentsOf, talkEdgesOf } from "./session-graph.js";
import { checkImports, type ImportCache } from "./imports.js";
import { parseWindow, today } from "./window.js";
import { isClaudeModelName } from "../conformance/codex.js";
import { planCodexRules } from "../bindings/lib/codex-rules.js";
import { GUARD_TIMEOUT, codexGateHold, codexHookProblems, gateWorstCase, guardHookTimeout } from "../bindings/lib/codex-hooks.js";
import { humanGateForgeable } from "../bindings/lib/codex-policy.js";
import { checkableActionGate, stepMatchWords } from "../bindings/lib/guards.js";
import { notExpressibleHits, writingJobsWithoutSandbox } from "../bindings/lib/not-expressible.js";
import { parse as parseSource } from "./index.js";
import type {
  HookDef,
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
  StoreNode,
  RetrievalNode,
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
  "behavior", "invocation", "delegation", "subagent",
  "omit", "when", "max", "parallel", "per",
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
  "fan-out", "event-driven", "human-gate", "brain",
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
  // Wave 8: Agent memory stores & retrieval keywords
  "store", "retrieval", "embedding", "index", "ingestion", "search",
  "lifecycle", "scoring", "backend-config",
  "scope", "collection", "chunking", "chunk-size", "overlap",
  "rerank", "top-k", "decay-half-life", "consolidation", "contradiction",
  "audit-log", "extraction", "budget", "diversity",
  "recency-weight", "semantic-weight", "importance-weight",
  "cache-hit-threshold", "cache-hit-action",
  "semantic", "episodic", "procedural", "entity", "graph", "brain",
  // Company-brain pattern: file-native store type + custody primitive
  "custodian-of", "does", "format", "obsidian",
  // Brain presentation (visualizer-only): provenance source styling
  "sources", "color", "icon",
  "lancedb", "sqlite-vec", "chroma", "kuzu", "falkordb", "pinecone",
  "qdrant", "pgvector", "neo4j",
  "vector", "keyword", "hybrid",
  "cosine", "euclidean", "dot-product",
  "recursive", "sentence", "paragraph",
  "overwrite", "preserve", "bi-temporal",
  "short-circuit", "augment", "pass-through",
  "strict", "soft", "org", "global", "session",
  "llm", "regex",
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
export function findBackEdges(edges: EdgeDef[], nodeIds: Set<string>): EdgeDef[] {
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
  // Talk edges between session agents are conversations, not loops: they run
  // both ways by design, so they are left out of the loop check.
  const talk = new Set(talkEdges(ast));
  const backEdges = findBackEdges(ast.edges.filter((e) => !talk.has(e)), ids);

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
 * V8: Imports resolve (N43, T-02). With a file path, each local import is read
 * relative to the importing file: a missing file, a wrong sha256, an import
 * cycle or an error inside the imported file is an error. Without a file path
 * (validating a string) nothing can be resolved, so say so.
 */
function v8ImportsResolve(ast: TopologyAST, opts: ValidateOptions): ValidationResult[] {
  const results: ValidationResult[] = [
    ...((ast as TopologyASTWithParseErrors)._importErrors ?? []),
  ];
  for (const imp of ast.imports.filter((i) => i.registry)) {
    results.push({ rule: "V8", level: "warning", node: imp.alias, message: `import "${imp.source}": registry import not checked` });
  }
  const local = ast.imports.filter((i) => !i.registry);
  if (local.length === 0) return results;
  const filePath = opts.filePath ?? ast.sourcePath;
  if (!filePath) {
    return [...results, { rule: "V8", level: "warning", message: "imports not checked" }];
  }
  return [...results, ...checkImports(ast, filePath, parseSource, validate, opts.importStack, opts.importCache)];
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

/** V11: If agent A writes X and agent B reads X, a path A -> B must exist in flow (unless either runs on demand). */
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
      // An on-demand agent (invocation: manual) sits outside the flow by
      // definition (V4), so no flow path can exist to or from it — the order
      // is the user's. Demanding one made every hand-built project, whose
      // subagents are all on demand, fail on import.
      const manual = (id: string) => {
        const n = ast.nodes.find((x) => x.id === id);
        return !!n && isAgent(n) && n.invocation === "manual";
      };
      const hasPath = manual(node.id) || keyWriters.some((writerId) =>
        manual(writerId) ||
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
  return ((ast as TopologyASTWithParseErrors)._edgeAttributeErrors ?? []).filter(
    (r) => r.rule === "V12"
  );
}

/** Extended AST type that may carry parse-time errors/warnings. */
interface TopologyASTWithParseErrors extends TopologyAST {
  _edgeAttributeErrors?: ValidationResult[];
  _duplicateSectionWarnings?: ValidationResult[];
  _misplacedBlockErrors?: ValidationResult[];
  _unknownMemorySubBlockWarnings?: ValidationResult[];
  _blockFieldMisuseWarnings?: ValidationResult[];
  _unknownNameErrors?: ValidationResult[];
  _importErrors?: ValidationResult[];
  /** Maps node/block IDs to their source line numbers (1-based). */
  _sourceMap?: Record<string, number>;
}

/** V13: Gate `after` and `before` must reference declared nodes. */
function v13GatePlacement(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const ids = allNodeIds(ast);

  for (const node of ast.nodes) {
    if (!isGate(node)) continue;
    for (const anchor of gateAnchors(node, "after")) {
      if (ids.has(anchor)) continue;
      results.push({
        rule: "V13",
        level: "error",
        message: `Gate "${node.id}" references undeclared node "${anchor}" in "after"`,
        node: node.id,
        line: lookupLine(ast, node.id),
      });
    }
    for (const anchor of gateAnchors(node, "before")) {
      if (ids.has(anchor)) continue;
      results.push({
        rule: "V13",
        level: "error",
        message: `Gate "${node.id}" references undeclared node "${anchor}" in "before"`,
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

/**
 * V89: A field the grammar defines as a block must not be written as a
 * key-value pair.
 *
 * `agent.prompt` is a block (spec/grammar.md:350). The string form belongs to
 * `skill` (spec/grammar.md:1377). Writing `prompt: "path.md"` on an agent
 * parses to nothing, so the agent silently ships with no instructions — the
 * binding then falls back to repeating its role sentence. Collected at parse
 * time because the misuse leaves no trace in the AST.
 */
function v89BlockFieldMisuse(ast: TopologyAST): ValidationResult[] {
  return (
    (ast as TopologyASTWithParseErrors)._blockFieldMisuseWarnings ?? []
  ).filter((r) => r.rule === "V89");
}

/**
 * V90: A field value must not swallow the next field.
 *
 * Fields are one per line. `parseFields` is line-based, so two on one line
 * makes the first key take the rest of the line as its value — silently, with
 * no trace in the AST. Collected at parse time for that reason.
 */
/**
 * V91: A required field must not be satisfied by an injected placeholder.
 *
 * The parser substitutes a sentinel when a required field is absent, because
 * the AST types are non-optional. Every downstream "is it present?" check then
 * passed — V7 (model required) saw `"unknown"` and was satisfied, and a
 * topology with no `meta.version` validated clean and scaffolded a config
 * naming a model that does not exist.
 *
 * Recognising the sentinels turns "silently defaulted" back into "missing",
 * which is what `spec/grammar.md` says these are.
 */
function v91RequiredFieldPlaceholder(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];

  if (ast.topology.version === MISSING.version) {
    results.push({
      rule: "V91",
      level: "error",
      message:
        "meta is missing `version`, which the spec marks required — the parser " +
        `substituted "${MISSING.version}" and every downstream check accepted it`,
    });
  }

  for (const node of ast.nodes) {
    if (node.type !== "orchestrator") continue;
    if (node.model === MISSING.model) {
      results.push({
        rule: "V91",
        level: "error",
        message:
          "orchestrator is missing `model`, which the spec marks required — the " +
          `parser substituted "${MISSING.model}", which bindings then emit verbatim`,
        node: node.id,
      });
    }
  }

  return results;
}

/**
 * V92: An edge's attributes belong in ONE bracket, comma-separated.
 *
 * `[when ...] [max N]` made the annotation matcher span from the first `[` to
 * the last `]`, yielding a condition string containing brackets — and nothing
 * reported it. Collected at parse time, where the raw line is still visible.
 */
/**
 * V93: an edge between two agents that both declare paths should declare a
 * handoff.
 *
 * `writer.writes ∩ reader.reads` is what actually crosses an edge. When it is
 * empty, the topology draws a dependency it does not describe — the receiving
 * agent is told to run after the sender and given nothing the sender produced.
 *
 * A WARNING, not an error: an edge may legitimately pass its result inline
 * rather than through a file, and real topologies do. It is a smell worth
 * surfacing, not a rejection.
 *
 * Skipped when either side declares nothing — that is undecidable, not a
 * violation. This is the same computation `plan` reports as the
 * `handoff-overlap-empty` pre-flagged ambiguity; having it here makes it work
 * under `scaffold` too, and for anyone who never runs `plan`.
 */
/**
 * V96: a `run:` value is a command, not a sentence.
 *
 * Gates and hooks compile to scripts named after their `run`. Prose there
 * passed validation, then scaffold wrote junk files named `E;` and `fail:`
 * and crashed with EISDIR on a " / " — after it had already written other
 * files. The explanation belongs in `description`; `run` keeps the command.
 */
function v96RunIsCommand(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const check = (owner: string, run: string | undefined, nodeId?: string) => {
    if (run === undefined) return;
    const why = proseInRun(run);
    if (!why) return;
    results.push({
      rule: "V96",
      level: "error",
      message:
        `${owner} "run" is not a command — ${why}. Keep only the command in ` +
        `"run" (e.g. run: "scripts/check.sh") and move the explanation into "description"`,
      ...(nodeId ? { node: nodeId, line: lookupLine(ast, nodeId) } : {}),
    });
  };

  // Only a command hook's run: is a command: a prompt or agent hook's run: is
  // the prompt itself, and http, mcp_tool and mod hooks are checked by V100/V95.
  const isCommand = (hook: HookDef) => (hook.type ?? "command") === "command";
  for (const node of ast.nodes) {
    if (isGate(node)) check(`Gate "${node.id}"`, node.run, node.id);
    if (node.type === "agent") {
      for (const hook of ((node as AgentNode).hooks ?? []).filter(isCommand)) {
        check(`Hook "${hook.name}" on agent "${node.id}"`, hook.run, node.id);
      }
    }
  }
  for (const hook of (ast.hooks ?? []).filter(isCommand)) check(`Hook "${hook.name}"`, hook.run);

  return results;
}

/**
 * V97: a `file:` is a safe project-relative path.
 *
 * `file:` marks a node's internals as hand-written at that path; scaffold
 * never writes it. A path outside the project ('..', absolute) or with an
 * unsafe name could not be honoured, so it is refused here, not at scaffold.
 */
function v97FileIsProjectPath(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const check = (owner: string, file: string | undefined, nodeId?: string) => {
    if (file === undefined) return;
    const why = unsafePathReason(file.replace(/^\.\//, ""));
    if (!why) return;
    results.push({
      rule: "V97",
      level: "error",
      message: `${owner} "file" is not a project-relative path — ${why}. Name the file from the project root, e.g. file: ".claude/agents/reviewer.md"`,
      ...(nodeId ? { node: nodeId, line: lookupLine(ast, nodeId) } : {}),
    });
  };
  for (const node of ast.nodes) check(`Node "${node.id}"`, node.file, node.id);
  for (const skill of ast.skills ?? []) check(`Skill "${skill.id}"`, skill.file);
  for (const trigger of ast.triggers ?? []) check(`Command "${trigger.name}"`, trigger.file);
  return results;
}

/**
 * Claude Code events that take only command, http and mcp_tool hooks (no
 * prompt or agent judge), and the two that take only command and mcp_tool.
 * From the hooks reference, 2026-10-30.
 */
const NO_JUDGE_EVENTS = new Set([
  "ConfigChange", "CwdChanged", "DirectoryAdded", "Elicitation", "ElicitationResult", "FileChanged",
  "InstructionsLoaded", "MessageDisplay", "Notification", "PostCompact", "PostModelSwitch", "PreCompact",
  "PreModelSwitch", "SessionEnd", "StopFailure", "SubagentStart", "WorktreeCreate", "WorktreeRemove",
  "AgentStart",
]);
const COMMAND_OR_MCP_EVENTS = new Set(["SessionStart", "Setup"]);

/**
 * V100: a hook has what its type needs, on an event that takes that type.
 *
 * A command needs run:, a prompt or agent hook needs run: (the prompt), an
 * http hook url:, an mcp_tool hook server: and tool:. A prompt or agent judge
 * on an event Claude Code runs only command hooks for never fires.
 */
function v100HookTypeFields(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  for (const { hook, where } of allHooks(ast)) {
    const type = hook.type ?? "command";
    if (type === "mod") continue; // V95
    const err = (message: string) => results.push({ rule: "V100", level: "error", message: `Hook "${where}" ${message}`, node: where });
    if ((type === "command" || type === "prompt" || type === "agent") && !hook.run) {
      err(`is type ${type} but has no run: — ${type === "command" ? "name the command" : "write the prompt in run:"}.`);
    }
    if (type === "http" && !hook.url) err(`is type http but has no url: — name the endpoint the event is sent to.`);
    if (type === "mcp_tool" && (!hook.server || !hook.tool)) err(`is type mcp_tool but needs server: and tool:.`);
    if (type !== "command" && hook.async !== undefined) err(`sets async: but is type ${type} — async: belongs to a command hook.`);
    const on = hook.on.trim();
    if ((type === "prompt" || type === "agent") && NO_JUDGE_EVENTS.has(on)) {
      err(`is a ${type} hook on ${on}, which Claude Code runs only command, http and mcp_tool hooks for — it would never fire.`);
    } else if ((type === "prompt" || type === "agent" || type === "http") && COMMAND_OR_MCP_EVENTS.has(on)) {
      err(`is a ${type} hook on ${on}, which takes only command and mcp_tool hooks — it would never fire.`);
    }
  }
  return results;
}

/**
 * V101: a node's run-mode is one Claude Code has, and an independent node
 * does not share its caller's context.
 *
 * runs: subagent (own agent), inline (a skill in the caller's context) or
 * fork (a skill in a fresh forked context). An independent critic running
 * inline would read the author's reasoning, which is what independent forbids.
 */
const RUN_MODES = ["subagent", "session", "inline", "fork"];

function v101RunMode(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  for (const node of ast.nodes) {
    if (node.type !== "agent") continue;
    const agent = node as AgentNode;
    if (agent.runs !== undefined && !RUN_MODES.includes(agent.runs)) {
      results.push({
        rule: "V101", level: "error", node: agent.id, line: lookupLine(ast, agent.id),
        message: `Agent "${agent.id}" has runs: ${agent.runs} — a node runs as ${RUN_MODES.join(", ")}.`,
      });
    }
    if (agent.independent && agent.runs === "inline") {
      results.push({
        rule: "V101", level: "error", node: agent.id, line: lookupLine(ast, agent.id),
        message: `Agent "${agent.id}" is independent but runs inline, in its caller's context, where it reads the author's reasoning. Use runs: fork or runs: subagent.`,
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Session agents (V113 - V118)
// ---------------------------------------------------------------------------

const PERMISSION_MODES = ["default", "acceptEdits", "plan", "bypassPermissions", "auto"];
const MESSAGE_KINDS = ["ticket", "report", "ask"];
const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

const sessionAgents = sessionAgentsOf;
const talkEdges = talkEdgesOf;

/**
 * V113: the forms session agents take. A session agent's id is its agent file
 * name, its session name (`claude -n <id>`), its SendMessage address and what
 * talk edges point at, so it is kebab-case. `place:` is a plain name,
 * `permission-mode:` is one Claude Code has, `[message:]` is ticket, report or
 * ask, and a `talk: hub` names a session agent.
 */
function v113SessionForms(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const sessions = sessionAgents(ast);
  for (const a of sessions) {
    const at = { node: a.id, line: lookupLine(ast, a.id) };
    if (!KEBAB.test(a.id)) {
      results.push({ rule: "V113", level: "error", ...at, message: `Session agent "${a.id}" is not kebab-case: its id is also its session name and its message address, so write it like "lane-build".` });
    }
  }
  for (const n of ast.nodes) {
    if (n.type !== "agent") continue;
    const a = n as AgentNode;
    const at = { node: a.id, line: lookupLine(ast, a.id) };
    if (a.place !== undefined && !/^[a-z][a-z0-9-]*$/.test(a.place)) {
      results.push({ rule: "V113", level: "error", ...at, message: `Agent "${a.id}" has place: ${a.place} — a place is a lowercase name like "ops" (a-z, 0-9 and "-", starting with a letter), because it names a herdr tab and a heading in sessions.md.` });
    }
    if (a.permissionMode !== undefined && !PERMISSION_MODES.includes(a.permissionMode)) {
      results.push({ rule: "V113", level: "error", ...at, message: `Agent "${a.id}" has permission-mode: ${a.permissionMode} — use ${PERMISSION_MODES.join(", ")}.` });
    }
  }
  for (const msg of (ast as TopologyAST & { _talkErrors?: string[] })._talkErrors ?? []) {
    results.push({ rule: "V113", level: "error", message: `flow: ${msg}` });
  }
  for (const e of ast.edges) {
    if (e.message !== undefined && !MESSAGE_KINDS.includes(e.message)) {
      results.push({ rule: "V113", level: "error", message: `Edge ${e.from} -> ${e.to} has [message: ${e.message}] — what crosses is ${MESSAGE_KINDS.join(", ")}.` });
    }
  }
  return results;
}

/** V114: sessions with no declared way to talk are unguarded. */
function v114TalkDeclared(ast: TopologyAST): ValidationResult[] {
  if (sessionAgents(ast).length < 2) return [];
  if (talkEdges(ast).length > 0) return [];
  return [{ rule: "V114", level: "warning", message: "talk not declared: unguarded" }];
}

/** V115: with the `hub` pattern, every session-to-session edge touches one node. */
function v115HubHolds(ast: TopologyAST): ValidationResult[] {
  if (!ast.topology.patterns.includes("hub")) return [];
  const edges = talkEdges(ast);
  if (edges.length === 0) return [];
  // The hub is the node every edge touches; with none, the busiest node stands in.
  const count = new Map<string, number>();
  for (const e of edges) for (const id of new Set([e.from, e.to])) count.set(id, (count.get(id) ?? 0) + 1);
  const hub = [...count.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const results: ValidationResult[] = [];
  const seen = new Set<string>();
  for (const e of edges) {
    if (e.from === hub || e.to === hub) continue;
    const key = [e.from, e.to].sort().join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ rule: "V115", level: "warning", message: `Topology has the hub pattern, but the edge ${e.from} -> ${e.to} between two sessions does not touch the hub "${hub}".` });
  }
  return results;
}

/** V116: a decision has one seat; a decision the topology lists has one at all. */
function v116DecisionSeats(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const holders = new Map<string, string[]>();
  for (const n of ast.nodes) {
    if (n.type !== "agent") continue;
    for (const d of (n as AgentNode).decides ?? []) holders.set(d, [...(holders.get(d) ?? []), n.id]);
  }
  for (const [d, ids] of holders) {
    if (ids.length > 1) {
      results.push({ rule: "V116", level: "warning", message: `Decision "${d}" is claimed by more than one agent: ${ids.join(", ")}. A decision has one seat.` });
    }
  }
  for (const d of ast.decisions ?? []) {
    if (!holders.has(d)) {
      results.push({ rule: "V116", level: "warning", message: `Decision "${d}" is listed in decisions: but no agent claims it with decides:.` });
    }
  }
  return results;
}

/** V117 (T-03): fields a session ignores, one warning per field. */
function v117SessionIgnoredFields(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  for (const a of sessionAgents(ast)) {
    const set: string[] = [];
    if (a.background !== undefined) set.push("background");
    if (a.skills !== undefined) set.push("skills");
    if (a.permissions !== undefined) set.push("permissions");
    for (const f of set) {
      results.push({ rule: "V117", level: "warning", node: a.id, line: lookupLine(ast, a.id), message: `Agent "${a.id}" sets ${f}:, which is ignored when run as a session.` });
    }
  }
  return results;
}

/** V118 (L-1): a talk edge between sessions in different permission modes. */
function v118TalkPermissionModes(ast: TopologyAST): ValidationResult[] {
  const mode = new Map(sessionAgents(ast).map((a) => [a.id, a.permissionMode]));
  const results: ValidationResult[] = [];
  const seen = new Set<string>();
  for (const e of talkEdges(ast)) {
    const a = mode.get(e.from);
    const b = mode.get(e.to);
    if (a === undefined || b === undefined || a === b) continue;
    const key = [e.from, e.to].sort().join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ rule: "V118", level: "warning", message: `Edge ${e.from} -> ${e.to} joins permission-mode ${a} and ${b}: a session in another permission mode holds incoming messages for its user, so this edge may not arrive.` });
  }
  return results;
}

const MODEL_ALIASES = ["opus", "sonnet", "haiku", "fable"];

/** V119 (L-3): with `pin-models: true`, a bare model alias drifts; warn once per alias. */
function v119ModelAliases(ast: TopologyAST): ValidationResult[] {
  if (!ast.pinModels) return [];
  const users = new Map<string, string[]>();
  for (const n of ast.nodes) {
    const m = (n as { model?: string }).model;
    if (m && MODEL_ALIASES.includes(m)) users.set(m, [...(users.get(m) ?? []), n.id]);
  }
  const results: ValidationResult[] = [];
  for (const [alias, ids] of users) {
    results.push({ rule: "V119", level: "warning", message: `model: ${alias} (${ids.join(", ")}) — alias resolves differently over time; use the exact id for a pinned run.` });
  }
  return results;
}

/**
 * V102: every field and block name in a checked block is one the parser reads.
 *
 * Anything else (a typo, a field of another node type, a block the language
 * does not have) vanished from the AST while validate passed. Collected at
 * parse time by findUnknownNames (src/parser/known-fields.ts).
 */
function v102KnownNames(ast: TopologyAST): ValidationResult[] {
  return ((ast as TopologyASTWithParseErrors)._unknownNameErrors ?? []).map((r) =>
    r.node && lookupLine(ast, r.node) !== undefined ? { ...r, line: lookupLine(ast, r.node) } : r
  );
}

/**
 * V103: an agent's or gate's `behavior` is `advisory` or `blocking`.
 *
 * Any other value was kept and emitted into the scaffold unchecked (N24).
 */
const BEHAVIORS = ["advisory", "blocking"];

function v103BehaviorValue(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  for (const node of ast.nodes) {
    if (node.type !== "agent" && node.type !== "gate") continue;
    const behavior = (node as AgentNode | GateNode).behavior;
    if (behavior === undefined || BEHAVIORS.includes(behavior)) continue;
    results.push({
      rule: "V103", level: "error", node: node.id, line: lookupLine(ast, node.id),
      message: `${node.type === "agent" ? "Agent" : "Gate"} "${node.id}" has behavior: ${behavior} — it must be ${BEHAVIORS.join(" or ")}.`,
    });
  }
  return results;
}

const STRENGTHS = ["refuse", "detect", "hope", "none"];
const ENFORCED_BY = ["code", "hook", "settings", "gate"];

/**
 * V104: `strength:` and `by:` use their words.
 *
 * strength says what stops a step (refuse, detect, hope, none) and by says
 * which mechanism refuses (code, hook, settings, gate), on a gate, a hook or
 * a flow edge. Any other word could not be read by guard --check or drawn.
 */
function v104StrengthWords(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const check = (owner: string, field: "strength" | "by", value: string | undefined, nodeId?: string) => {
    const words = field === "strength" ? STRENGTHS : ENFORCED_BY;
    if (value === undefined || words.includes(value)) return;
    results.push({
      rule: "V104", level: "error",
      message: `${owner} has ${field}: ${value} — it must be one of ${words.join(", ")}.`,
      ...(nodeId ? { node: nodeId, line: lookupLine(ast, nodeId) } : {}),
    });
  };
  for (const node of ast.nodes) {
    if (node.type !== "gate") continue;
    const gate = node as GateNode;
    check(`Gate "${gate.id}"`, "strength", gate.strength, gate.id);
    check(`Gate "${gate.id}"`, "by", gate.by, gate.id);
  }
  for (const hook of ast.hooks ?? []) check(`Hook "${hook.name}"`, "strength", hook.strength);
  for (const edge of ast.edges) check(`Edge ${edge.from} -> ${edge.to}`, "strength", edge.strength);
  // D-3: strength: refuse on a hook that cannot stop a call is a claim nothing holds.
  for (const hook of ast.hooks ?? []) {
    if (hook.strength !== "refuse") continue;
    const event = HOOK_EVENT_ALIASES[hook.on] ?? hook.on;
    const why = NON_BLOCKING_EVENTS.has(event)
      ? `${event} cannot block a call (it runs ${event === "PostToolUse" || event === "PostToolUseFailure" ? "after the tool" : "where no call waits on it"})`
      : hook.async ? "it is async: the host does not wait for it, so it cannot block" : null;
    if (!why) continue;
    results.push({
      rule: "V104", level: "warning",
      message: `Hook "${hook.name}" declares strength: refuse, but ${why}. Use PreToolUse (not async) for a hook that refuses, or say strength: detect.`,
    });
  }
  return results;
}

/** Universal hook event names and the host event they mean (as the Claude Code binding maps them). */
const HOOK_EVENT_ALIASES: Record<string, string> = { AgentStart: "SubagentStart", AgentStop: "SubagentStop", ToolUse: "PostToolUse", Error: "PostToolUseFailure" };
/** Events whose hook runs after the call or at a stop: exit 2 there does not stop a call (D-3). */
const NON_BLOCKING_EVENTS = new Set(["PostToolUse", "PostToolUseFailure", "Stop", "SubagentStop", "SubagentStart", "SessionStart", "SessionEnd", "Notification", "PreCompact"]);

/**
 * V105: an edge's `guard:` names a hook or gate this file declares.
 *
 * The guard is how the edge cites what refuses it. A misspelled name would
 * credit the edge with a refusal nothing provides.
 */
function v105GuardResolves(ast: TopologyAST): ValidationResult[] {
  const known = new Set<string>([
    ...(ast.hooks ?? []).map((h) => h.name),
    ...ast.nodes.filter((n) => n.type === "gate").map((n) => n.id),
  ]);
  const results: ValidationResult[] = [];
  for (const edge of ast.edges) {
    for (const g of edge.guard ?? []) {
      if (known.has(g)) continue;
      results.push({
        rule: "V105", level: "error",
        message: `Edge ${edge.from} -> ${edge.to} has guard: ${g}, but no hook or gate is named "${g}". A guard names a hook in hooks { } or a gate in gates { }.`,
      });
    }
  }
  return results;
}

/**
 * V106: an `at:` citation is a safe project-relative "path" or "path:line",
 * and a `match:` has an `at:` to be looked for in.
 *
 * validate never reads the project: whether the file and line exist and the
 * match text is there is guard --check's job.
 */
function v106CitationForm(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const check = (owner: string, at: string | undefined, match: string | undefined, nodeId?: string) => {
    const where = nodeId ? { node: nodeId, line: lookupLine(ast, nodeId) } : {};
    if (match !== undefined && at === undefined) {
      results.push({ rule: "V106", level: "error", message: `${owner} has match: but no at: — match is the text expected at the cited lines, so it needs at: "path:line".`, ...where });
    }
    if (at === undefined) return;
    const path = /^(.*?)(?::\d+)?$/.exec(at)![1];
    const why = path.includes(":")
      ? `the part after ":" must be a line number, e.g. at: "pxframes.py:949"`
      : unsafePathReason(path.replace(/^\.\//, ""));
    if (why) results.push({ rule: "V106", level: "error", message: `${owner} at: "${at}" is not a project-relative "path" or "path:line" — ${why}.`, ...where });
  };
  for (const node of ast.nodes) {
    if (node.type !== "gate") continue;
    const gate = node as GateNode;
    check(`Gate "${gate.id}"`, gate.at, gate.match, gate.id);
  }
  for (const edge of ast.edges) check(`Edge ${edge.from} -> ${edge.to}`, edge.at, undefined);
  return results;
}

/** Claude Code's event name for an .at hook event (AgentStop is Stop). */
const hookEvent = (on: string) => (on === "AgentStop" ? "Stop" : on);

/**
 * V107: a matcher Claude Code would never match, and an `if:` it would never read.
 *
 * Matchers are exact names unless they hold a regex character, and are tested
 * against the tool name alone (hooks docs, checked 2026-11-10). So
 * `Bash(rm -rf *)` (N30), the dotted `mcp.chrome.*` and the bare server
 * `mcp__chrome` never match anything, and a regex that does not compile never
 * matches. `if:` is read on tool events only; elsewhere the hook never runs.
 */
function v107MatcherForm(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  for (const { hook, where: name, agent: node } of allHooks(ast)) {
    const owner = `Hook "${name}"`;
    const where = node ? { node, line: lookupLine(ast, node) } : {};
    const event = hookEvent(hook.on);
    const why = matcherProblem(event, hook.matcher);
    if (why) results.push({ rule: "V107", level: "error", message: `${owner} matcher ${why}.`, ...where });
    if (hook.if && !TOOL_EVENTS.has(event)) {
      results.push({ rule: "V107", level: "error", message: `${owner} has if: "${hook.if}" on ${hook.on}, which is not a tool event, so Claude Code never runs the hook; if: is read on ${[...TOOL_EVENTS].join(", ")}.`, ...where });
    }
  }
  return results;
}

/**
 * V108: a hook whose run: exits with a code that does not block (N29).
 * Only exit 2 blocks; exit 1 is a non-blocking error and the action goes ahead.
 */
function v108ExitCode(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  for (const { hook, where: name, agent: node } of allHooks(ast)) {
    const owner = `Hook "${name}"`;
    if ((hook.type ?? "command") !== "command") continue;
    const code = /^\s*exit\s+(\d+)\s*$/.exec(hook.run ?? "")?.[1];
    if (code === undefined || code === "0" || code === "2") continue;
    results.push({ rule: "V108", level: "warning", message: `${owner} run: "exit ${code}" does not block: only exit 2 blocks, so the action goes ahead. Write exit 2 to refuse.`, ...(node ? { node, line: lookupLine(ast, node) } : {}) });
  }
  return results;
}

/**
 * V109: a refuse hook that guards a server but misses one of its tools.
 * The tools are the ones the topology names; `validate --inventory` adds the
 * tool names the inventory lists.
 */
function v109MatcherGaps(ast: TopologyAST): ValidationResult[] {
  return matcherGaps(ast as never).map((g) => ({
    rule: "V109",
    level: "warning" as const,
    message: `Hook "${g.hook}" declares strength: refuse and guards server ${g.server}, but its matcher does not match ${g.tool}, so that tool is not refused.`,
  }));
}

/**
 * V110: a gate before a script step that has nothing to check.
 *
 * Such a gate compiles to before-action.sh, which refuses the step until the
 * ledger shows the gate's `after:` step ok, or until the gate's `run:` passes.
 * With neither, the guard has nothing to look at and the step is never
 * refused, so the gate reads as a guard and guards nothing.
 */
function v110ActionGateChecksNothing(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  for (const node of ast.nodes) {
    if (node.type !== "gate") continue;
    const gate = node as GateNode;
    if (gate.behavior === "advisory" || guardedActions(ast, gate).length === 0) continue;
    if (gateLedger(ast, gate) || scriptNameFromRun(gate.run)) continue;
    results.push({
      rule: "V110",
      level: "warning",
      message: `Gate "${gate.id}" stands before a script step but has no ledger and no run:, so there is nothing to check and the step is never refused. Declare a records { } block and a ledger:, or give the gate a run: script`,
      node: gate.id,
      line: lookupLine(ast, gate.id),
    });
  }
  return results;
}

/**
 * V111: an action's `unit-from` is a regex with a capture group.
 * The unit is the first group; without one the guard cannot name the unit,
 * and a regex that does not compile would make the generated script fail on
 * every command.
 */
function v111UnitFromRegex(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  for (const node of ast.nodes) {
    if (node.type !== "action") continue;
    const action = node as ActionNode;
    if (action.unitFrom === undefined) continue;
    let problem: string | null = null;
    try {
      const groups = new RegExp(`${action.unitFrom}|`).exec("")!.length - 1;
      if (groups < 1) problem = "it has no capture group, so no unit can be read from the command (wrap the unit in parentheses)";
    } catch (e) {
      problem = `it is not a valid regex (${(e as Error).message})`;
    }
    if (problem) {
      results.push({
        rule: "V111",
        level: "error",
        message: `Action "${action.id}" has unit-from "${action.unitFrom}": ${problem}`,
        node: action.id,
        line: lookupLine(ast, action.id),
      });
    }
    // D-2: a ledger path with no {unit} holds every unit's records in one file, so it cannot tell them apart.
    for (const g of ast.nodes) {
      if (g.type !== "gate" || !guardedActions(ast, g as GateNode).some((a) => a.id === action.id)) continue;
      const rec = gateLedger(ast, g as GateNode);
      if (!rec || rec.path.includes("{unit}")) continue;
      results.push({
        rule: "V111",
        level: "warning",
        message: `Action "${action.id}" has unit-from, but gate "${g.id}" reads ledger "${rec.id}" at "${rec.path}", which has no {unit}: the record cannot tell units apart by its file. The guard reads the unit field of each line, and refuses the step when no unit is read; put {unit} in the path (e.g. "logs/{unit}/trace.jsonl")`,
        node: action.id,
        line: lookupLine(ast, action.id),
      });
    }
  }
  return results;
}

/**
 * V112: ledgers resolve and their paths are safe.
 * A gate's `ledger:` names a declared record; a record path is project-relative
 * (`{unit}` allowed); and a gate before a script step that needs a ledger but
 * names none is only unambiguous when the topology declares exactly one record.
 */
function v112Ledgers(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const records = ast.records ?? [];
  const err = (message: string, node?: string) =>
    results.push({ rule: "V112", level: "error", message, ...(node ? { node, line: lookupLine(ast, node) } : {}) });
  for (const r of records) {
    const why = unsafePathReason(r.path.replace(/\{unit\}/g, "unit").replace(/^\.\//, ""));
    if (why) err(`Record "${r.id}" has path "${r.path}", which is unsafe: ${why}`);
  }
  for (const node of ast.nodes) {
    if (node.type !== "gate") continue;
    const gate = node as GateNode;
    if (gate.ledger) {
      if (!records.some((r) => r.id === gate.ledger)) {
        err(`Gate "${gate.id}" has ledger: ${gate.ledger}, but no record of that name is declared (records: ${records.map((r) => r.id).join(", ") || "none"})`, gate.id);
      }
      continue;
    }
    if (records.length > 1 && guardedActions(ast, gate).length > 0 && !scriptNameFromRun(gate.run)) {
      err(`Gate "${gate.id}" stands before a script step and names no ledger, and ${records.length} records are declared (${records.map((r) => r.id).join(", ")}), so it is unclear which one to read. Add ledger: <record id>`, gate.id);
    }
  }
  return results;
}

/**
 * V98: a block that belongs inside a container is not written beside it.
 *
 * `gate x { }` outside `gates { }` (likewise hook, tool, job, command, level)
 * was dropped by the parser with no message. Collected at parse time.
 */
function v98BlockInsideItsContainer(ast: TopologyAST): ValidationResult[] {
  return (ast as TopologyASTWithParseErrors)._misplacedBlockErrors ?? [];
}

/**
 * V99: an agent's `skills:` and `mcp-servers:`, and a skill's `agent:`, name
 * something this topology declares.
 *
 * A misspelled name compiled to a reference Claude Code could not resolve,
 * with no message. A warning, not an error: the name may be real outside the
 * topology (a skill on disk, a user-level MCP server, a built-in agent).
 */
const BUILT_IN_AGENTS = new Set(["general-purpose", "Explore", "Plan"]);

function v99ReferencesDeclared(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const skills = new Set([ast.topology.name, ...(ast.skills ?? []).map((s) => s.id)]);
  const servers = new Set([...Object.keys(ast.mcpServers ?? {}), ...(ast.stores ?? []).map((s) => s.id)]);
  const agents = new Set(ast.nodes.filter((n) => n.type === "agent" || n.type === "group").map((n) => n.id));
  const warn = (message: string, nodeId?: string) =>
    results.push({ rule: "V99", level: "warning", message, ...(nodeId ? { node: nodeId, line: lookupLine(ast, nodeId) } : {}) });

  for (const node of ast.nodes) {
    if (node.type !== "agent") continue;
    const agent = node as AgentNode;
    for (const skill of agent.skills ?? []) {
      if (!skills.has(skill)) {
        warn(`Agent "${agent.id}" uses skill "${skill}", which this topology does not declare — scaffold writes no SKILL.md for it. If it is hand-written, declare skill ${skill} { file: ".claude/skills/${skill}/SKILL.md" }; otherwise check the name`, agent.id);
      }
    }
    for (const server of agent.mcpServers ?? []) {
      if (!servers.has(server)) {
        warn(`Agent "${agent.id}" uses MCP server "${server}", which mcp-servers { } does not declare — it resolves only if configured outside this project`, agent.id);
      }
    }
  }
  for (const skill of ast.skills ?? []) {
    if (skill.agent && !agents.has(skill.agent) && !BUILT_IN_AGENTS.has(skill.agent)) {
      warn(`Skill "${skill.id}" runs in agent "${skill.agent}", which is not an agent in this topology or a built-in one (${[...BUILT_IN_AGENTS].join(", ")})`);
    }
  }
  return results;
}

function v93EdgeHandoffDeclared(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const byId = new Map(ast.nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();

  for (const edge of ast.edges) {
    if (edge.isError) continue;
    const key = `${edge.from} ${edge.to}`;
    if (seen.has(key)) continue;

    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (from?.type !== "agent" || to?.type !== "agent") continue;

    const writes = (from as AgentNode).writes ?? [];
    const reads = (to as AgentNode).reads ?? [];
    // Undecidable, not a violation.
    if (writes.length === 0 || reads.length === 0) continue;

    seen.add(key);
    const readSet = new Set(reads);
    if (writes.some((w) => readSet.has(w))) continue;

    results.push({
      rule: "V93",
      level: "warning",
      message:
        `Edge "${edge.from} -> ${edge.to}" declares no handoff — ` +
        `"${edge.from}" writes [${writes.join(", ")}] and "${edge.to}" reads ` +
        `[${reads.join(", ")}], which do not overlap. Add a shared path to ` +
        `"${edge.to}" reads, or the receiver runs after the sender with none of its output`,
      node: edge.to,
      line: lookupLine(ast, edge.to),
    });
  }

  return results;
}

function v92EdgeTwoBrackets(ast: TopologyAST): ValidationResult[] {
  return ((ast as TopologyASTWithParseErrors)._edgeAttributeErrors ?? []).filter(
    (r) => r.rule === "V92"
  );
}

function v90SwallowedField(ast: TopologyAST): ValidationResult[] {
  return (
    (ast as TopologyASTWithParseErrors)._blockFieldMisuseWarnings ?? []
  ).filter((r) => r.rule === "V90");
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

/**
 * V25: `on-fail: bounce-back` enforcement depends on the gate's `after` target.
 *
 * On claude-code: when `after` is an agent node, the gate compiles to a
 * SubagentStop hook whose exit 2 prevents the subagent from stopping — so
 * bounce-back IS enforceable. When `after` is a human, action, or unset, no
 * subagent ever runs by that name and the hook would never fire; the
 * scaffolder skips emitting the dead hook and the gate must be invoked by
 * the orchestrator/playbook instead.
 *
 * Other CLI bindings vary; the canonical guidance is still that the
 * orchestrator should cooperate. The warning fires only for the cases where
 * enforcement is NOT automatic — gates with non-agent `after` targets, or
 * gates with no `after` at all.
 */
function v25BounceBackAdvisory(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const registeredIds = new Set(
    ast.nodes.filter((n) => n.type === "agent" || n.type === "group").map((n) => n.id),
  );
  for (const node of ast.nodes) {
    if (node.type !== "gate") continue;
    const gate = node as GateNode;
    if (gate.onFail !== "bounce-back") continue;
    // A gate before an action with commands is compiled (before-action.sh).
    if (guardedActions(ast, gate).length > 0) continue;
    if (gate.after && gateAnchors(gate, "after").every((a) => registeredIds.has(a))) {
      // Agent/group target — enforceable on claude-code via SubagentStop. No warning.
      continue;
    }
    const _anchors = gateAnchors(gate, "after");
    const target = _anchors.length ? `non-agent target "${_anchors.join('", "')}"` : "no after: target";
    results.push({
      rule: "V25",
      level: "warning",
      message: `Gate "${gate.id}" uses on-fail: bounce-back but has ${target} — cannot be wired as a SubagentStop hook on claude-code (matcher must be an agent or group id). Invoke the gate script from your orchestrator playbook at the right step.`,
      node: gate.id,
    });
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
  // `xhigh` sits between high and max, matching the effort tiers modern routing
  // exposes. Added in 0.5.0 — `thinking` IS the reasoning-effort field, and a
  // separate `effort` was deliberately NOT added rather than have two words for
  // one concept.
  const VALID_THINKING = new Set(["off", "low", "medium", "high", "xhigh", "max"]);

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
// V81 – Store backend validation
// ---------------------------------------------------------------------------

/** Valid store backends. `files` is the file-native backend for `brain` stores. */
const VALID_STORE_BACKENDS: ReadonlySet<string> = new Set([
  "lancedb", "sqlite-vec", "chroma", "kuzu", "falkordb",
  "mongodb", "pinecone", "qdrant", "pgvector", "neo4j", "sqlite", "duckdb",
  "files",
]);

/**
 * V81: StoreNode.backend must be one of the known values.
 *
 * `brain` stores are file-native (Obsidian-format markdown). They have no
 * database backend — their backend is always `files` — so they are exempt
 * from the backend-enum requirement. See `docs/company-brain-design.md`.
 */
function v81StoreBackendValid(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  if (!ast.stores) return results;
  for (const store of ast.stores) {
    if (store.type === "brain") continue;
    if (!VALID_STORE_BACKENDS.has(store.backend)) {
      results.push({
        rule: "V81",
        level: "error",
        message: `store "${store.id}": backend "${store.backend}" is invalid — must be one of: ${[...VALID_STORE_BACKENDS].join(", ")}`,
        node: store.id,
        line: lookupLine(ast, store.id),
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// V82 – Store embedding required for semantic types
// ---------------------------------------------------------------------------

/** Store types that typically require embedding configuration. */
const EMBEDDING_REQUIRED_TYPES: ReadonlySet<string> = new Set([
  "semantic", "episodic", "procedural",
]);

/**
 * V82: When StoreNode.type is "semantic", "episodic", or "procedural",
 * embedding config should be present. Warning level — binding may provide defaults.
 */
function v82StoreEmbeddingRequired(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  if (!ast.stores) return results;
  for (const store of ast.stores) {
    // Skip warning for stores that don't need embeddings:
    // - keyword-only or graph search strategies work without vectors
    // - graph backends (kuzu, falkordb, neo4j) do structured queries
    const searchStrategy = store.search?.strategy;
    const skipEmbedding =
      searchStrategy === "keyword" ||
      searchStrategy === "graph" ||
      store.backend === "kuzu" ||
      store.backend === "falkordb" ||
      store.backend === "neo4j" ||
      // Episodic/user stores on sqlite without explicit search config
      // are typically keyword/temporal — don't nag about embeddings
      ((store.type === "episodic" || store.type === "user") && store.backend === "sqlite" && !store.search);
    if (EMBEDDING_REQUIRED_TYPES.has(store.type) && !store.embedding && !skipEmbedding) {
      results.push({
        rule: "V82",
        level: "warning",
        message: `store "${store.id}": type "${store.type}" typically requires an embedding configuration — the binding may provide defaults`,
        node: store.id,
        line: lookupLine(ast, store.id),
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// V83 – Store scope recommended
// ---------------------------------------------------------------------------

/**
 * V83: Every store should have a scope defined. Warning level.
 */
function v83StoreScopeRecommended(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  if (!ast.stores) return results;
  for (const store of ast.stores) {
    if (!store.scope) {
      results.push({
        rule: "V83",
        level: "warning",
        message: `store "${store.id}": no scope defined — consider specifying one of: agent, user, session, org, global`,
        node: store.id,
        line: lookupLine(ast, store.id),
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// V84 – Retrieval sources must reference valid store IDs
// ---------------------------------------------------------------------------

/**
 * V84: Every source in RetrievalNode.sources must match a store ID in ast.stores.
 */
function v84RetrievalSourcesValid(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  if (!ast.stores || !ast.retrievals) return results;
  const storeIds = new Set(ast.stores.map((s) => s.id));

  for (const retrieval of ast.retrievals ?? []) {
    if (!retrieval.sources) continue;
    for (const source of retrieval.sources) {
      if (!storeIds.has(source)) {
        results.push({
          rule: "V84",
          level: "error",
          message: `retrieval "${retrieval.id}": source "${source}" does not reference a declared store`,
          node: retrieval.id,
          line: lookupLine(ast, retrieval.id),
        });
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// V85 – Store connection required for remote backends
// ---------------------------------------------------------------------------

/** Remote backends that require a connection string. */
const REMOTE_BACKENDS: ReadonlySet<string> = new Set([
  "pinecone", "neo4j", "qdrant", "pgvector",
]);

/**
 * V85: Remote backends (pinecone, neo4j, qdrant, pgvector) require a connection field.
 */
function v85StoreConnectionRequired(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  if (!ast.stores) return results;
  for (const store of ast.stores) {
    if (REMOTE_BACKENDS.has(store.backend) && !store.connection) {
      results.push({
        rule: "V85",
        level: "error",
        message: `store "${store.id}": remote backend "${store.backend}" requires a connection field`,
        node: store.id,
        line: lookupLine(ast, store.id),
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// V86 – Agent memory/retrieval references must be valid
// ---------------------------------------------------------------------------

/**
 * V86: Every ID in AgentNode.memory must match a store ID in ast.stores.
 * AgentNode.retrieval must match a retrieval ID in ast.retrievals.
 */
function v86AgentMemoryRefsValid(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  if (!ast.stores || !ast.retrievals) return results;
  const storeIds = new Set(ast.stores.map((s) => s.id));
  const retrievalIds = new Set(ast.retrievals.map((r) => r.id));

  for (const node of ast.nodes) {
    if (!isAgent(node)) continue;

    if (node.memory) {
      for (const storeRef of node.memory) {
        if (!storeIds.has(storeRef)) {
          results.push({
            rule: "V86",
            level: "error",
            message: `agent "${node.id}": memory reference "${storeRef}" does not match a declared store`,
            node: node.id,
            line: lookupLine(ast, node.id),
          });
        }
      }
    }

    if (node.retrieval) {
      if (!retrievalIds.has(node.retrieval)) {
        results.push({
          rule: "V86",
          level: "error",
          message: `agent "${node.id}": retrieval reference "${node.retrieval}" does not match a declared retrieval strategy`,
          node: node.id,
          line: lookupLine(ast, node.id),
        });
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// V87 – Orchestrator delegation mode must be a recognized value
// ---------------------------------------------------------------------------

/**
 * V87: `orchestrator.delegation` must be "subagent" or "inline".
 *
 * The two modes change how agent steps run:
 *   - "subagent" (default): orchestrator spawns each agent via the platform's
 *     subagent/Task-tool mechanism. claude-code emits SubagentStop hooks for
 *     gates.
 *   - "inline": orchestrator drives every agent in its own session. No
 *     subagent ever runs, so SubagentStop hooks would be dead config — the
 *     claude-code binding suppresses them and emits playbook snippets instead.
 *
 * Any other value is a topology error: bindings cannot guess the
 * orchestration shape, so the field can't be silently ignored.
 */
function v87OrchestratorDelegation(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const orch = ast.nodes.find((n) => n.type === "orchestrator");
  if (!orch) return results;
  const delegation = (orch as { delegation?: string }).delegation;
  if (delegation && delegation !== "subagent" && delegation !== "inline") {
    results.push({
      rule: "V87",
      level: "error",
      message: `orchestrator.delegation: "${delegation}" is not recognized — must be "subagent" (default) or "inline"`,
      node: "orchestrator",
      line: lookupLine(ast, "orchestrator"),
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// V88 – Custody references must resolve to declared stores
// ---------------------------------------------------------------------------

/**
 * V88: Every store in an agent's `custodian-of` must reference a declared store.
 *
 * Custody is the primitive behind the `brain` pattern: an agent that owns the
 * upkeep of a memory store (wiring dropped files into the graph — links, tags,
 * index hubs, dedupe), not merely reads it. A custodian pointing at a store
 * that doesn't exist is a wiring error the binding cannot honor.
 *
 * Custody is typically over a `brain`-type store, but the language does not
 * require it — an agent may be declared custodian of any store. We emit a
 * warning (not an error) when custody targets a non-brain store, since that is
 * unusual but legal (e.g. an agent that curates a graph DB).
 */
function v88CustodyRefsValid(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  if (!ast.stores) return results;
  const storeById = new Map((ast.stores ?? []).map((s) => [s.id, s]));

  for (const node of ast.nodes) {
    if (!isAgent(node)) continue;
    const custody = (node as { custodianOf?: string[] }).custodianOf;
    if (!custody) continue;

    for (const storeRef of custody) {
      const store = storeById.get(storeRef);
      if (!store) {
        results.push({
          rule: "V88",
          level: "error",
          message: `agent "${node.id}": custodian-of "${storeRef}" does not match a declared store`,
          node: node.id,
          line: lookupLine(ast, node.id),
        });
      } else if (store.type !== "brain") {
        results.push({
          rule: "V88",
          level: "warning",
          message: `agent "${node.id}": custodian-of "${storeRef}" targets a non-brain store (type "${store.type}") — custody is usually over a brain store`,
          node: node.id,
          line: lookupLine(ast, node.id),
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
 * Validate a parsed AgenTopology AST against all specification rules.
 *
 * @param ast - The parsed topology AST.
 * @returns An array of validation results. An empty array means no issues found.
 */
/**
 * Engine events a `type: mod` hook may subscribe to (Claude Code function
 * hooks, early access, CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1).
 *
 * PROVEN: a Mod was loaded and fired on these (Claude Code 2.1.283).
 * SEEN: the name is in the 2.1.283 binary but no Mod has been observed on it,
 * so V95 accepts it with a warning rather than an error.
 */
export const MOD_EVENTS_PROVEN = ["tool.call", "prompt.submit"] as const;
export const MOD_EVENTS_SEEN = [
  "prompt.context", "session.start", "session.end", "model.complete", "message.received",
] as const;

/** Hook types the grammar defines (`spec/grammar.md` §4.16). */
export const HOOK_TYPES = ["command", "prompt", "agent", "http", "mcp_tool", "mod"] as const;

/** Every hook in the topology — global first, then per-agent — with its owner. */
function allHooks(ast: TopologyAST): Array<{ hook: HookDef; where: string; agent?: string }> {
  const out: Array<{ hook: HookDef; where: string; agent?: string }> = ast.hooks.map((hook) => ({ hook, where: hook.name }));
  for (const n of ast.nodes) {
    if (n.type !== "agent" || !(n as AgentNode).hooks) continue;
    for (const hook of (n as AgentNode).hooks!) out.push({ hook, where: `${n.id}.${hook.name}`, agent: n.id });
  }
  return out;
}

/**
 * V94: a hook's `type` must be one the grammar defines.
 *
 * `type: mod` passed silently before the grammar knew it, and the claude-code
 * binding wrote it into settings.json as a bash command. A misspelt type
 * (`type: comand`) did the same.
 */
function v94HookTypeKnown(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  for (const { hook, where, agent } of allHooks(ast)) {
    const type = hook.type ?? "command";
    if (!(HOOK_TYPES as readonly string[]).includes(type)) {
      results.push({
        rule: "V94",
        level: "error",
        message:
          `Hook "${where}" has type "${type}" — a hook is one of: ${HOOK_TYPES.join(", ")}. ` +
          `Use "mod" for a TypeScript module that runs inside the engine.`,
        node: where,
      });
      continue;
    }
    if (type === "mod" && agent) {
      results.push({
        rule: "V94",
        level: "error",
        message: `Hook "${where}" is a mod inside an agent — a Mod runs in the engine for the whole session; declare it in the topology's hooks block.`,
        node: where,
      });
    }
    if (hook.flag !== undefined && type !== "mod") {
      results.push({
        rule: "V94",
        level: "error",
        message: `Hook "${where}" sets flag: but is type "${type}" — flag: is the env switch of a type: mod hook.`,
        node: where,
      });
    } else if (hook.flag !== undefined && !/^[A-Z_][A-Z0-9_]*$/.test(hook.flag)) {
      results.push({
        rule: "V94",
        level: "error",
        message: `Hook "${where}" has flag "${hook.flag}" — a flag is an env variable name (e.g. MY_MOD_ON).`,
        node: where,
      });
    }
  }
  return results;
}

/**
 * V95: a hook's `on:` must be an event its type can subscribe to.
 *
 * A mod subscribes to a dotted engine event (`tool.call`); a command or prompt
 * hook to a PascalCase lifecycle event (`PreToolUse`, spec §4.16: "any
 * identifier in PascalCase"). Mixing them is a hook that never fires. A value
 * with whitespace is left to V90 (a swallowed field), not reported twice.
 */
function v95HookEventKnown(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const proven = MOD_EVENTS_PROVEN as readonly string[];
  const seen = MOD_EVENTS_SEEN as readonly string[];
  for (const { hook, where } of allHooks(ast)) {
    const type = hook.type ?? "command";
    const on = hook.on.trim();
    if (/\s/.test(on)) continue; // V90
    if (!on) {
      results.push({ rule: "V95", level: "error", message: `Hook "${where}" has no on: — name the event it fires on.`, node: where });
      continue;
    }
    if (type === "mod") {
      if (!hook.run) {
        results.push({ rule: "V95", level: "error", message: `Mod "${where}" has no run: — name its module (e.g. run: "hooks/redact.ts").`, node: where });
      }
      if (proven.includes(on)) continue;
      if (seen.includes(on)) {
        results.push({
          rule: "V95",
          level: "warning",
          message: `Mod "${where}" subscribes to "${on}" — the engine names this event, but no Mod has been observed firing on it. Proven: ${proven.join(", ")}.`,
          node: where,
        });
        continue;
      }
      const hint = /^[A-Z]/.test(on)
        ? ` "${on}" is a command-hook event; a mod subscribes to an engine event.`
        : "";
      results.push({
        rule: "V95",
        level: "error",
        message: `Mod "${where}" subscribes to unknown engine event "${on}".${hint} Engine events: ${[...proven, ...seen].join(", ")}.`,
        node: where,
      });
      continue;
    }
    if (!/^[A-Z][A-Za-z0-9]*$/.test(on)) {
      const hint = proven.includes(on) || seen.includes(on)
        ? ` "${on}" is an engine event — set type: mod to subscribe a module to it.`
        : "";
      results.push({
        rule: "V95",
        level: "error",
        message: `Hook "${where}" (type ${type}) fires on "${on}" — a ${type} hook takes a PascalCase event (e.g. PreToolUse, AgentStop).${hint}`,
        node: where,
      });
    }
  }
  return results;
}

/** Where the topology was read from, so imports can be resolved (N43). */
export interface ValidateOptions {
  /** Path of the file `ast` was parsed from. Omit when validating a string. */
  filePath?: string;
  /** Files already being resolved (cycle detection); set by import resolution. */
  importStack?: string[];
  /** Files already read and checked (set by import resolution; shared across a run). */
  importCache?: ImportCache;
  /** Binding target being compiled for. Target-specific warnings (rule ids CX*) appear only when it is set. */
  target?: string;
}

export function validate(ast: TopologyAST, opts: ValidateOptions = {}): ValidationResult[] {
  return [
    ...(opts.target === "codex" ? codexWarnings(ast) : []),
    ...v1UniqueNames(ast),
    ...v2NoKeywordNames(ast),
    ...v3FlowResolves(ast),
    ...v4NoOrphans(ast),
    ...v5OutputsExist(ast),
    ...v6BoundedLoops(ast),
    ...v7ModelRequired(ast),
    ...v8ImportsResolve(ast, opts),
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
    ...v89BlockFieldMisuse(ast),
    ...v90SwallowedField(ast),
    ...v91RequiredFieldPlaceholder(ast),
    ...v92EdgeTwoBrackets(ast),
    ...v93EdgeHandoffDeclared(ast),
    ...v94HookTypeKnown(ast),
    ...v95HookEventKnown(ast),
    ...v96RunIsCommand(ast),
    ...v97FileIsProjectPath(ast),
    ...v98BlockInsideItsContainer(ast),
    ...v99ReferencesDeclared(ast),
    ...v100HookTypeFields(ast),
    ...v101RunMode(ast),
    ...v102KnownNames(ast),
    ...v103BehaviorValue(ast),
    ...v104StrengthWords(ast),
    ...v105GuardResolves(ast),
    ...v106CitationForm(ast),
    ...v107MatcherForm(ast),
    ...v108ExitCode(ast),
    ...v109MatcherGaps(ast),
    ...v110ActionGateChecksNothing(ast),
    ...v111UnitFromRegex(ast),
    ...v112Ledgers(ast),
    ...v113SessionForms(ast),
    ...v114TalkDeclared(ast),
    ...v115HubHolds(ast),
    ...v116DecisionSeats(ast),
    ...v117SessionIgnoredFields(ast),
    ...v118TalkPermissionModes(ast),
    ...v119ModelAliases(ast),
    ...v120DecisionArrives(ast),
    ...v121StoreOwner(ast),
    ...v122MachineKnown(ast),
    ...v123HomePaths(ast),
    ...v124ScheduleCarrier(ast),
    ...v125SessionCronSurvives(ast),
    ...v126AwayWaits(ast),
    ...v127PersonWindows(ast),
    ...v128InventoryRoots(ast),
    ...v129NeedsOutside(ast),
    ...stepPlaceholderWarnings(ast),
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
    ...v81StoreBackendValid(ast),
    ...v82StoreEmbeddingRequired(ast),
    ...v83StoreScopeRecommended(ast),
    ...v84RetrievalSourcesValid(ast),
    ...v85StoreConnectionRequired(ast),
    ...v86AgentMemoryRefsValid(ast),
    ...v87OrchestratorDelegation(ast),
    ...v88CustodyRefsValid(ast),
  ];
}

/**
 * V120 (T-04c): an agent with `decides:` that a talk edge points at. A
 * decision can arrive there as a message from another session rather than
 * from the person at the seat. The warning names it; the binding writes a
 * prompt log (typed or arrived) rather than refusing messages by keyword.
 */
function v120DecisionArrives(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const incoming = new Map<string, string[]>();
  for (const e of talkEdges(ast)) incoming.set(e.to, [...(incoming.get(e.to) ?? []), e.from]);
  for (const a of sessionAgents(ast)) {
    if (!a.decides?.length || !incoming.has(a.id)) continue;
    results.push({
      rule: "V120", level: "warning", node: a.id, line: lookupLine(ast, a.id),
      message: `Agent "${a.id}" holds ${a.decides.join(", ")} and ${[...new Set(incoming.get(a.id))].join(", ")} can message it: a decision can arrive here as a message.`,
    });
  }
  return results;
}

/**
 * V121 (T-10): a store with `owner:` has one agent that may share it. Two
 * agents that write it (list it under `memory:`, `custodian-of:` or `writes:`)
 * are an error naming both, unless one of the two is the owner. An owner that
 * is not an agent is an error too. A store with no `owner:` is unchecked.
 */
function v121StoreOwner(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const agents = ast.nodes.filter((n): n is AgentNode => n.type === "agent");
  const ids = new Set(agents.map((a) => a.id));
  for (const store of ast.stores ?? []) {
    if (!store.owner) continue;
    if (!ids.has(store.owner)) {
      results.push({ rule: "V121", level: "error", node: store.id, line: lookupLine(ast, store.id), message: `Store "${store.id}" has owner "${store.owner}", which is not an agent.` });
      continue;
    }
    const writers = agents
      .filter((a) => [...(a.memory ?? []), ...(a.custodianOf ?? []), ...(a.writes ?? [])].includes(store.id))
      .map((a) => a.id)
      .filter((id) => id !== store.owner);
    if (writers.length >= 2) {
      results.push({
        rule: "V121", level: "error", node: store.id, line: lookupLine(ast, store.id),
        message: `Store "${store.id}" is owned by "${store.owner}", but "${writers[0]}" and "${writers[1]}" both write it and neither is the owner.`,
      });
    }
  }
  return results;
}

/** V122 (T-07): `machine:` on a session agent, a schedule job or a store must name a `machines` entry. */
function v122MachineKnown(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const known = new Set((ast.machines ?? []).map((m) => m.id));
  const check = (kind: string, id: string, machine: string | undefined) => {
    if (machine === undefined || known.has(machine)) return;
    const have = known.size ? `declared: ${[...known].join(", ")}` : "the topology declares no machines";
    results.push({ rule: "V122", level: "error", node: id, line: lookupLine(ast, id), message: `${kind} "${id}" runs on machine "${machine}", which is not in machines { } (${have}).` });
  };
  for (const n of ast.nodes) if (n.type === "agent") check("Agent", n.id, (n as AgentNode).machine);
  for (const j of ast.schedules ?? []) check("Schedule job", j.id, j.machine);
  for (const st of ast.stores ?? []) check("Store", st.id, st.machine);
  return results;
}

const HOME_PATH = /(?:^|[^A-Za-z0-9_.-])(?:\/Users\/[^/\s"'`]+\/|\/home\/[^/\s"'`]+\/|[A-Za-z]:\\{1,2}Users\\{1,2})/;

/**
 * V123 (T-07): an absolute path into one person's home folder
 * (`/Users/<x>/`, `/home/<x>/`, `C:\Users\`) in a hook, gate, tool or action
 * command only works on that person's machine.
 */
function v123HomePaths(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const check = (what: string, id: string, text: string | undefined) => {
    if (!text) return;
    const m = text.match(HOME_PATH);
    if (!m) return;
    results.push({ rule: "V123", level: "error", node: id, line: lookupLine(ast, id), message: `${what} has a home-folder absolute path (${m[0].replace(/^[^/A-Za-z]/, "")}...): it only works on one machine. Use a project-relative path or declare a machine.` });
  };
  for (const h of ast.hooks ?? []) check(`Hook "${h.name}" command`, h.name, h.run);
  for (const n of ast.nodes) {
    if (n.type === "agent") for (const h of (n as AgentNode).hooks ?? []) check(`Hook "${h.name}" command`, n.id, h.run);
    if (n.type === "gate") {
      check(`Gate "${n.id}" run`, n.id, (n as { run?: string }).run);
      for (const c of (n as { checks?: string[] }).checks ?? []) check(`Gate "${n.id}" check`, n.id, c);
    }
    if (n.type === "action") for (const c of (n as { commands?: string[] }).commands ?? []) check(`Action "${n.id}" command`, n.id, c);
  }
  for (const t of ast.toolDefs ?? []) {
    check(`Tool "${t.id}" script`, t.id, t.script);
    for (const a of t.args ?? []) check(`Tool "${t.id}" argument`, t.id, a);
  }
  return results;
}

const CARRIERS = ["session", "cron", "launchd", "cloud", "calendar"];
const SURVIVES = ["pane-close", "reboot", "away"];

/** V124 (T-06): a schedule job's `carrier:` and `survives:` must be one of the known values. */
function v124ScheduleCarrier(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  for (const j of ast.schedules ?? []) {
    if (j.carrier !== undefined && !CARRIERS.includes(j.carrier))
      results.push({ rule: "V124", level: "error", node: j.id, line: lookupLine(ast, j.id), message: `Schedule job "${j.id}" has carrier "${j.carrier}"; use one of: ${CARRIERS.join(", ")}.` });
    if (j.survives !== undefined && !SURVIVES.includes(j.survives))
      results.push({ rule: "V124", level: "error", node: j.id, line: lookupLine(ast, j.id), message: `Schedule job "${j.id}" has survives "${j.survives}"; use one of: ${SURVIVES.join(", ")}.` });
  }
  return results;
}

/** V125 (L-2): a job carried by a session cannot outlive it. */
function v125SessionCronSurvives(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  for (const j of ast.schedules ?? []) {
    if (j.carrier !== "session" || !j.survives || !SURVIVES.includes(j.survives)) continue;
    results.push({
      rule: "V125", level: "error", node: j.id, line: lookupLine(ast, j.id),
      message: `Schedule job "${j.id}" has carrier: session and survives: ${j.survives}, but a session cron dies with its session and after 7 days. Use carrier: cron, launchd or cloud for a job that must survive.`,
    });
  }
  return results;
}

/**
 * V126 (T-09): a human step whose `who:` person is away today or later waits on
 * someone who may not answer. The warning names the step, the person, the
 * window and what the step does on timeout.
 */
function v126AwayWaits(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const people = new Map((ast.persons ?? []).map((p) => [p.id, p]));
  const now = today();
  for (const n of ast.nodes) {
    if (n.type !== "human" || !n.who) continue;
    const person = people.get(n.who);
    const w = parseWindow(person?.away);
    if (!person || !w || w.end < now) continue;
    const behavior = n.timeout
      ? `on timeout (${n.timeout}) it will ${n.onTimeout ?? "halt"}`
      : "it has no timeout, so it waits until they are back";
    results.push({
      rule: "V126", level: "warning", node: n.id, line: lookupLine(ast, n.id),
      message: `Step "${n.id}" waits on ${person.id}, who is away ${person.away}: ${behavior}.`,
    });
  }
  return results;
}

/** V127 (T-09): `who:` must name a `person`; `away:` and `valid:` must be real `YYYY-MM-DD..YYYY-MM-DD` windows. */
function v127PersonWindows(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const people = new Set((ast.persons ?? []).map((p) => p.id));
  const bad = (id: string, what: string, value: string) =>
    results.push({ rule: "V127", level: "error", node: id, line: lookupLine(ast, id), message: `${what} "${value}" is not a window like "2026-01-31..2026-02-14" (two real dates, the first not after the second).` });
  for (const p of ast.persons ?? []) if (p.away !== undefined && !parseWindow(p.away)) bad(p.id, `Person "${p.id}" away:`, p.away);
  for (const n of ast.nodes) {
    if (n.type !== "human") continue;
    if (n.who && !people.has(n.who))
      results.push({ rule: "V127", level: "error", node: n.id, line: lookupLine(ast, n.id), message: `Human "${n.id}" has who: ${n.who}, which is not a person block.` });
    if (n.valid !== undefined && !parseWindow(n.valid)) bad(n.id, `Human "${n.id}" valid:`, n.valid);
  }
  return results;
}

const hasDotDot = (p: string) => p.split(/[\\/]/).includes("..");
const isAbsolute = (p: string) => p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\");

/** V128 (T-08): an inventory root is a project-relative folder: no absolute path, no `..`. */
function v128InventoryRoots(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  for (const r of ast.inventoryRoots ?? []) {
    if (!r || isAbsolute(r) || r.startsWith("~") || hasDotDot(r))
      results.push({ rule: "V128", level: "error", message: `Inventory root "${r}" must be a path inside the project: relative, with no ".." and no absolute or home path.` });
  }
  return results;
}

/** V129 (L-4): `needs` names things outside the repo: memory is a path under the home folder (`~/...`, no `..`), skills and connectors are bare names. */
function v129NeedsOutside(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const n = ast.needs;
  if (!n) return results;
  const err = (message: string) => results.push({ rule: "V129", level: "error", message });
  if (n.memory !== undefined) {
    if (!n.memory || hasDotDot(n.memory) || (isAbsolute(n.memory)) || (n.memory.startsWith("~") && !n.memory.startsWith("~/")))
      err(`needs memory: "${n.memory}" must be a path under the user's home, written ~/<path> (no "..", no other absolute path).`);
  }
  for (const [what, list] of [["user-skills", n.userSkills], ["connectors", n.connectors]] as const) {
    for (const name of list ?? [])
      if (!name || /[\\/]/.test(name) || name === "." || name === "..")
        err(`needs ${what} entry "${name}" must be a bare name, not a path.`);
  }
  return results;
}

/**
 * AG-placeholder (E-3): a guarded step's command holds placeholder words
 * (`EP.json`, `OUT.mp4`, `<id>`), so its guard matches on the words before
 * them. Said once per command, so the author knows what is matched.
 */
function stepPlaceholderWarnings(ast: TopologyAST): ValidationResult[] {
  const out: ValidationResult[] = [];
  const guarded = new Set<string>();
  for (const n of ast.nodes) {
    if (n.type === "gate" && checkableActionGate(ast, n as GateNode)) for (const a of guardedActions(ast, n as GateNode)) guarded.add(a.id);
  }
  for (const n of ast.nodes) {
    if (n.type !== "action" || !guarded.has(n.id)) continue;
    for (const c of (n as ActionNode).commands ?? []) {
      const { words, cut } = stepMatchWords(c);
      if (cut) out.push({ rule: "AG-placeholder", level: "warning", node: n.id, message: `action "${n.id}" command "${c}" holds placeholder words, so its guard matches any command containing "${words}" (the words before the first placeholder).` });
    }
  }
  return out;
}

/**
 * Codex warnings (CX-5): what a `--target codex` scaffold drops or refuses.
 * They run only when `validate` is given `target: "codex"`, so a Claude Code
 * user never sees them.
 */
export function codexWarnings(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const warn = (rule: string, node: string, message: string) => results.push({ rule, level: "warning", node, message: `[codex] ${message}` });
  for (const n of ast.nodes) {
    const model = (n as { model?: string }).model;
    if (model && isClaudeModelName(model)) {
      warn("CX5-model", n.id, `agent "${n.id}" uses the Claude model "${model}"; Codex runs no Claude model, so scaffold refuses it. Set a Codex model (for example gpt-5.2).`);
    }
    if (n.type !== "agent") continue;
    const agent = n as AgentNode;
    if (agent.sandbox != null) {
      warn("CX5-sandbox", agent.id, `agent "${agent.id}" sets sandbox; a Codex agent file cannot override the parent sandbox_mode, so it is not written. Set sandbox_mode in config.toml for the whole project.`);
    }
    if (agent.mcpServers && agent.mcpServers.length > 0) {
      warn("CX5-mcp", agent.id, `agent "${agent.id}" lists mcp-servers; a Codex agent file cannot scope MCP servers, so they are written once in config.toml for every agent.`);
    }
  }
  for (const hook of ast.hooks) {
    for (const p of codexHookProblems(hook)) {
      if (p.level === "error") results.push({ rule: p.rule, level: "error", node: hook.name, message: `[codex] ${p.message}` });
      else warn(p.rule, hook.name, p.message);
    }
  }
  // R-11: a human step is a line in .codex/state/approvals.jsonl; a sandbox that lets the model write .codex lets it approve itself.
  const forgeable = humanGateForgeable(ast);
  if (forgeable) {
    warn("CX11-forgeable", "approvals", `a human step stands before an agent, but ${forgeable}, so the model can write .codex/state/approvals.jsonl and approve itself; the human gate cannot hold. Set settings { sandbox: workspace-write }, which keeps .codex read-only for the agent.`);
  }
  // R-1: a gate Codex can only run on SubagentStop holds nothing; say so instead of looking like it holds.
  for (const n of ast.nodes) {
    if (n.type !== "gate") continue;
    const hold = codexGateHold(ast, n as GateNode);
    if (hold.kind === "none") {
      warn("CX9-noblock", n.id, `gate "${n.id}" can only run when ${hold.anchors.join(", ")} stops; Codex cannot block a SubagentStop, and no agent spawn or script step follows it to hold, so nothing stops the next step (graded none). Give it a before: agent or script step, or run its script by hand.`);
    }
  }
  // R-3: a long gate check holds every guarded call that long; Codex lets the call run if the hook times out.
  for (const n of ast.nodes) {
    if (n.type !== "gate") continue;
    const gate = n as GateNode;
    const worst = gateWorstCase(gate);
    if (gate.behavior === "advisory" || !gate.run || worst === null) continue;
    const hook = guardHookTimeout([gate]);
    if (hook > GUARD_TIMEOUT) {
      warn("CX9-timeout", gate.id, `gate "${gate.id}" can run up to ${worst}s (timeout ${gate.timeout} x ${(gate.retry ?? 0) + 1} attempt(s)); its hook timeout is raised to ${hook}s, so a guarded call waits that long while it is checked. Shorten the timeout or the retries.`);
    }
  }
  for (const p of planCodexRules(ast).problems) {
    warn("CX13", p.list, `settings ${p.list}: ${p.message}`);
  }
  for (const id of writingJobsWithoutSandbox(ast)) {
    warn("CX20", id, `schedule job "${id}" runs an agent that writes, but no sandbox is set, and exec is read-only by default; the job runs with --sandbox read-only and cannot write. Set sandbox: workspace-write.`);
  }
  for (const hit of notExpressibleHits(ast)) {
    const label = hit.scope === "agent" ? "agent field" : hit.scope === "defaults" ? "defaults field" : "topology field";
    results.push({
      rule: "CX23", level: "warning",
      message: `[codex] ${label} "${hit.field}" is not expressible on Codex: ${hit.reason}. Set by: ${hit.where.join(", ")}.`,
    });
  }
  return results;
}
