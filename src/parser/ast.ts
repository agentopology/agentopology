/**
 * AgentTopology AST type definitions.
 *
 * These interfaces describe the complete abstract syntax tree produced by
 * parsing an `.at` (AgentTopology) file. The types are intentionally
 * open -- model names, permission modes, and hook events are plain strings
 * so the parser works with any topology, not just Claude Code topologies.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Scalars & small structs
// ---------------------------------------------------------------------------

/** Key-value output enum: maps an output name to its possible values. */
export type OutputsMap = Record<string, string[]>;

/** Scale configuration for parallel agent execution. */
export interface ScaleDef {
  /** Scaling strategy (e.g. "auto", "fixed"). */
  mode: string;
  /** Dimension to scale by (e.g. "batch-count", "doc-count"). */
  by: string;
  /** Minimum number of concurrent instances. */
  min: number;
  /** Maximum number of concurrent instances. */
  max: number;
  /** Optional batch size per instance. */
  batchSize: number | null;
}

/** A single depth level definition. */
export interface DepthLevel {
  /** Numeric depth value (e.g. 1, 2, 3). */
  level: number;
  /** Human-readable label for this depth. */
  label: string;
  /** Agent ids to omit at this depth. */
  omit: string[];
}

/** The depth section of a topology. */
export interface DepthDef {
  /** Factors that determine depth selection. */
  factors: string[];
  /** Available depth levels. */
  levels: DepthLevel[];
}

/** A trigger (command) definition. */
export interface TriggerDef {
  /** Trigger name (the command identifier). */
  name: string;
  /** Regex or glob pattern that activates this trigger. */
  pattern: string;
  /** Optional argument template variable. */
  argument?: string;
}

/** A hook definition (global or per-agent). */
export interface HookDef {
  /** Hook identifier. */
  name: string;
  /** Event name this hook listens to (any string, e.g. "PreToolUse"). */
  on: string;
  /** Pattern to match against the event payload. */
  matcher: string;
  /** Command or script to run when the hook fires. */
  run: string;
  /** Hook type (e.g. "command", "prompt"). */
  type?: string;
  /** Timeout in milliseconds. */
  timeout?: number;
  /** Platform-specific extension fields, keyed by binding name. */
  extensions?: Record<string, Record<string, unknown>>;
}

/** A skill declaration within a topology. */
export interface SkillDef {
  /** Skill identifier. */
  id: string;
  /** Human-readable description. */
  description: string;
  /** Script file names belonging to this skill. */
  scripts?: string[];
  /** Domain knowledge file paths. */
  domains?: string[];
  /** Reference file paths. */
  references?: string[];
  /** Prompt file path. */
  prompt?: string;
  /** Whether to disable automatic model invocation. */
  disableModelInvocation?: boolean;
  /** Whether this skill is user-invocable (shows in menu). */
  userInvocable?: boolean;
  /** Context mode (e.g. "fork" for subagent isolation). */
  context?: string;
  /** Agent type to use when context is "fork". */
  agent?: string;
  /** Tools allowed without permission prompt. */
  allowedTools?: string[];
  /** Platform-specific extension fields. */
  extensions?: Record<string, Record<string, unknown>>;
}

/** A tool declaration within a topology-level `tools` block. */
export interface ToolBlockDef {
  /** Tool identifier. */
  id: string;
  /** Path to the script that implements this tool. */
  script: string;
  /** Positional arguments to pass to the script. */
  args?: string[];
  /** Script language (e.g. "bash", "python", "node"). */
  lang?: string;
  /** Human-readable description. */
  description: string;
}

/** Metering / cost tracking configuration. */
export interface MeteringDef {
  /** Metrics to track (e.g. ["tokens-in", "tokens-out", "cost"]). */
  track: string[];
  /** Dimensions to track per (e.g. ["agent", "run"]). */
  per: string[];
  /** Output file path for metrics. */
  output: string;
  /** Output format (e.g. "jsonl", "csv"). */
  format: string;
  /** Pricing model identifier. */
  pricing: string;
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

/** Base fields shared by all node types. */
export interface BaseNode {
  /** Unique node identifier (lowercase, kebab-case). */
  id: string;
  /** Human-readable display label. */
  label: string;
}

/** An orchestrator node. */
export interface OrchestratorNode extends BaseNode {
  type: "orchestrator";
  /** Model identifier (any string, e.g. "opus", "gpt-4o"). */
  model: string;
  /** Template the orchestrator generates (e.g. a plan path). */
  generates?: string;
  /** Action ids this orchestrator handles. */
  handles: string[];
  /** Output enum definitions. */
  outputs?: OutputsMap;
}

/** An action node (external command, script, or git operation). */
export interface ActionNode extends BaseNode {
  type: "action";
  /** Action kind (e.g. "external", "git", "inline"). */
  kind?: string;
  /** Source reference (file path or URL). */
  source?: string;
  /** Human-readable description. */
  description?: string;
  /** Shell commands to execute. */
  commands?: string[];
}

/** An agent node. */
export interface AgentNode extends BaseNode {
  type: "agent";
  /** Execution phase (decimal ordering value). */
  phase?: number;
  /** Model identifier (any string). */
  model?: string;
  /** Permission mode (any string, e.g. "plan", "auto", "confirm"). */
  permissions?: string;
  /** Inline prompt content (multi-line text from prompt {} block). */
  prompt?: string;
  /** Allowed tool names. */
  tools?: string[];
  /** Skill identifiers this agent can use. */
  skills?: string[];
  /** Memory keys this agent can read. */
  reads?: string[];
  /** Memory keys this agent can write. */
  writes?: string[];
  /** Disallowed tool names (mutually exclusive with `tools`). */
  disallowedTools?: string[];
  /** Skip condition expression. */
  skip?: string;
  /** Behavior mode (e.g. "advisory", "blocking"). */
  behavior?: string;
  /** Invocation mode (e.g. "manual"). */
  invocation?: string;
  /** Max retry count on failure. */
  retry?: number;
  /** Isolation mode (e.g. "worktree"). */
  isolation?: string;
  /** Whether this agent runs in the background. */
  background?: boolean;
  /** MCP server names this agent uses. */
  mcpServers?: string[];
  /** Output enum definitions. */
  outputs?: OutputsMap;
  /** Scale / parallelism configuration. */
  scale?: ScaleDef;
  /** Per-agent hook definitions. */
  hooks?: HookDef[];
  /** Role description (resolved from the roles block). */
  role?: string;
  /** Human-readable description for delegation/discovery. */
  description?: string;
  /** Maximum number of agentic turns before stopping. */
  maxTurns?: number;
  /** Platform-specific extension fields, keyed by binding name. */
  extensions?: Record<string, Record<string, unknown>>;
}

/** A gate node (quality / security checkpoint). */
export interface GateNode extends BaseNode {
  type: "gate";
  /** Agent or action id this gate runs after. */
  after?: string;
  /** Agent or action id this gate runs before. */
  before?: string;
  /** Script to execute for the gate check. */
  run?: string;
  /** List of check identifiers. */
  checks?: string[];
  /** Max retry count on failure. */
  retry?: number;
  /** Failure behavior (e.g. "halt", "bounce-back"). */
  onFail?: string;
  /** Behavior mode. */
  behavior?: string;
  /** Platform-specific extension fields, keyed by binding name. */
  extensions?: Record<string, Record<string, unknown>>;
}

/** Union of all node types. */
export type NodeDef = OrchestratorNode | ActionNode | AgentNode | GateNode;

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

/** A directed edge in the flow graph. */
export interface EdgeDef {
  /** Source node id. */
  from: string;
  /** Target node id. */
  to: string;
  /** Optional condition expression (from `[when ...]`). */
  condition: string | null;
  /** Optional max iteration count (from `[max N]`). */
  maxIterations: number | null;
}

// ---------------------------------------------------------------------------
// Top-level sections
// ---------------------------------------------------------------------------

/** The `meta` block within a topology. */
export interface TopologyMeta {
  /** Topology name (from the header). */
  name: string;
  /** Semantic version string. */
  version: string;
  /** Human-readable description. */
  description: string;
  /** Pattern tags declared in the topology header. */
  patterns: string[];
  /** Foundation patterns (from meta block). */
  foundations?: string[];
  /** Advanced patterns (from meta block). */
  advanced?: string[];
  /** Domain identifier (e.g. "legal", "marketing"). */
  domain?: string;
}

/** A provider configuration for API credentials and model routing. */
export interface ProviderDef {
  /** Provider name (e.g. "anthropic", "openai", "ollama"). */
  name: string;
  /** Environment variable reference for API key (must be "${ENV_VAR}" format). */
  apiKey?: string;
  /** Custom base URL for the provider's API endpoint. */
  baseUrl?: string;
  /** Model identifiers this provider serves. */
  models: string[];
  /** Whether this is the default provider (at most one can be true). */
  default?: boolean;
  /** Future-proof extensibility fields. */
  extra: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Complete AST
// ---------------------------------------------------------------------------

/** The complete abstract syntax tree for an AgentTopology file. */
export interface TopologyAST {
  /** Topology metadata (header + meta block). */
  topology: TopologyMeta;
  /** All declared nodes (orchestrator, agents, actions, gates). */
  nodes: NodeDef[];
  /** All flow edges. */
  edges: EdgeDef[];
  /** Depth configuration. */
  depth: DepthDef;
  /** Memory configuration (sub-blocks like domains, references, etc.). */
  memory: Record<string, unknown>;
  /** Batch execution configuration. */
  batch: Record<string, unknown>;
  /** Environment-specific overrides. */
  environments: Record<string, Record<string, unknown>>;
  /** Command triggers. */
  triggers: TriggerDef[];
  /** Global hooks. */
  hooks: HookDef[];
  /** Permission settings (allow/deny/ask lists). */
  settings: Record<string, unknown>;
  /** MCP server configurations. */
  mcpServers: Record<string, Record<string, unknown>>;
  /** Metering / cost tracking (null if not configured). */
  metering: MeteringDef | null;
  /** Skill declarations. */
  skills: SkillDef[];
  /** Top-level tool declarations. */
  toolDefs: ToolBlockDef[];
  /** Role descriptions keyed by role name. */
  roles: Record<string, string>;
  /** Context/instructions file configuration. */
  context: {
    /** Filename for the context file (e.g. "CONTEXT.md"). */
    file?: string;
    /** Additional files to include in context. */
    includes?: string[];
  };
  /** Environment variables for the topology. */
  env: Record<string, string>;
  /** Provider configurations for API credentials and model routing. */
  providers: ProviderDef[];
}
