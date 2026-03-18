/**
 * AgenTopology AST type definitions.
 *
 * These interfaces describe the complete abstract syntax tree produced by
 * parsing an `.at` (AgenTopology) file. The types are intentionally
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

/** A scheduled job definition. */
export interface ScheduleJobDef {
  /** Job identifier. */
  id: string;
  /** Cron expression (mutually exclusive with `every`). */
  cron?: string;
  /** Human-readable recurrence (mutually exclusive with `cron`). */
  every?: string;
  /** Agent id to invoke. */
  agent?: string;
  /** Action id to invoke. */
  action?: string;
  /** Whether this job is enabled. Defaults to true. */
  enabled: boolean;
}

/** An external interface definition (webhook, HTTP, etc.). */
export interface InterfaceDef {
  /** Interface identifier. */
  id: string;
  /** Interface type (e.g. "webhook", "http"). */
  type?: string;
  /** All non-type configuration fields. */
  config: Record<string, unknown>;
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
// Schema system
// ---------------------------------------------------------------------------

/** A schema type expression (primitive, array, enum, or reference). */
export type SchemaType =
  | { kind: "primitive"; value: "string" | "number" | "integer" | "boolean" | "object" }
  | { kind: "array"; itemType: SchemaType }
  | { kind: "enum"; values: string[] }
  | { kind: "ref"; name: string };

/** A single field definition within a schema block. */
export interface SchemaFieldDef {
  /** Field name. */
  name: string;
  /** Field type expression. */
  type: SchemaType;
  /** Whether this field is optional (prefixed with `?`). */
  optional: boolean;
}

/** A named schema definition from the top-level `schemas` block. */
export interface SchemaDef {
  /** Schema identifier. */
  id: string;
  /** Field definitions. */
  fields: SchemaFieldDef[];
}

// ---------------------------------------------------------------------------
// Checkpoint / durable execution
// ---------------------------------------------------------------------------

/** Replay/time-travel configuration within a checkpoint block. */
export interface ReplayConfig {
  /** Whether replay is enabled. */
  enabled: boolean;
  /** Maximum number of historical states to retain. */
  maxHistory?: number;
  /** Whether branching from a historical state is allowed. */
  branch?: boolean;
}

/** Checkpoint / durable execution configuration. */
export interface CheckpointDef {
  /** Storage backend for checkpoints. */
  backend: string;
  /** Connection string or secret reference. */
  connection?: string;
  /** Checkpointing strategy. */
  strategy: string;
  /** Time-to-live for checkpoint data (duration string). */
  ttl?: string;
  /** Replay/time-travel configuration. */
  replay?: ReplayConfig;
}

// ---------------------------------------------------------------------------
// Artifact / asset lineage
// ---------------------------------------------------------------------------

/** An artifact definition in the top-level `artifacts` block. */
export interface ArtifactDef {
  /** Artifact identifier. */
  id: string;
  /** Artifact type (e.g. "markdown", "json", "csv"). */
  type: string;
  /** File system path or prefix for artifact storage. */
  path?: string;
  /** Retention duration (duration string, e.g. "30d"). */
  retention?: string;
  /** IDs of other artifacts this artifact depends on. */
  dependsOn?: string[];
}

// ---------------------------------------------------------------------------
// Circuit breaker configuration
// ---------------------------------------------------------------------------

/** Circuit breaker configuration for agents. */
export interface CircuitBreakerConfig {
  /** Number of failures before the circuit opens. */
  threshold: number;
  /** Time window for counting failures (duration string, e.g. "5m"). */
  window: string;
  /** Cooldown before transitioning to half-open (duration string, e.g. "30s"). */
  cooldown: string;
}

// ---------------------------------------------------------------------------
// Retry configuration
// ---------------------------------------------------------------------------

/** Structured retry configuration for agents. */
export interface RetryConfig {
  /** Maximum number of retry attempts. */
  max: number;
  /** Backoff strategy between retries. */
  backoff?: "none" | "linear" | "exponential";
  /** Initial interval between retries (duration string, e.g. "1s", "5m"). */
  interval?: string;
  /** Maximum interval cap (duration string). */
  maxInterval?: string;
  /** Whether to add random jitter to retry intervals. */
  jitter?: boolean;
  /** Error types that should not trigger retries. */
  nonRetryable?: string[];
}

// ---------------------------------------------------------------------------
// Prompt variants (A/B testing)
// ---------------------------------------------------------------------------

/** A prompt variant for A/B testing within an agent. */
export interface PromptVariant {
  /** Variant identifier. */
  id: string;
  /** Inline prompt content. */
  prompt?: string;
  /** Selection weight (0 to 1). */
  weight: number;
  /** Optional temperature override. */
  temperature?: number;
  /** Optional model override. */
  model?: string;
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
  /** Timeout duration string (e.g. "5m", "2h"). */
  timeout?: string;
  /** Failure behavior: "halt" | "retry" | "skip" | "continue" | "fallback <agent-id>". */
  onFail?: string;
  /** Join semantics for fan-in: "all" | "any" | "all-done" | "none-failed". */
  join?: string;
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
  /** Retry configuration: simple count or structured block. */
  retry?: number | RetryConfig;
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
  /** Sandbox mode override (e.g. "docker", "none", "network-only", true, false). */
  sandbox?: string | boolean;
  /** Model fallback chain (ordered list of model ids to try). */
  fallbackChain?: string[];
  /** Timeout duration string (e.g. "5m", "2h"). */
  timeout?: string;
  /** Failure behavior: "halt" | "retry" | "skip" | "continue" | "fallback <agent-id>". */
  onFail?: string;
  /** Sampling temperature (0-2). */
  temperature?: number;
  /** Maximum tokens to generate. */
  maxTokens?: number;
  /** Top-p (nucleus) sampling parameter. */
  topP?: number;
  /** Top-k sampling parameter. */
  topK?: number;
  /** Stop sequences. */
  stop?: string[];
  /** Random seed for reproducibility. */
  seed?: number;
  /** Thinking/reasoning level: "off" | "low" | "medium" | "high" | "max". */
  thinking?: string;
  /** Token budget for thinking/reasoning. */
  thinkingBudget?: number;
  /** Output format: "text" | "json" | "json-schema". */
  outputFormat?: string;
  /** Log level: "debug" | "info" | "warn" | "error". */
  logLevel?: string;
  /** Join semantics for fan-in: "all" | "any" | "all-done" | "none-failed". */
  join?: string;
  /** Circuit breaker configuration for failure isolation. */
  circuitBreaker?: CircuitBreakerConfig;
  /** ID of the agent whose side effects this agent can undo (compensation/saga). */
  compensates?: string;
  /** Typed input schema fields for structured input. */
  inputSchema?: SchemaFieldDef[];
  /** Typed output schema fields for structured output. */
  outputSchema?: SchemaFieldDef[];
  /** Artifact ids this agent produces. */
  produces?: string[];
  /** Artifact ids this agent consumes. */
  consumes?: string[];
  /** Prompt variants for A/B testing. */
  variants?: PromptVariant[];
  /** Rate limit expression (e.g. "60/min", "1000/hour", "5/sec"). */
  rateLimit?: string;
  /** Platform-specific extension fields, keyed by binding name. */
  extensions?: Record<string, Record<string, unknown>>;
}

/** A group chat node for multi-agent conversation/debate. */
export interface GroupNode extends BaseNode {
  type: "group";
  /** Agent IDs that participate in the group chat. */
  members: string[];
  /** Speaker selection strategy. */
  speakerSelection?: string;
  /** Maximum conversation rounds. */
  maxRounds?: number;
  /** Termination condition (natural language or pattern). */
  termination?: string;
  /** Human-readable description. */
  description?: string;
  /** Timeout duration string. */
  timeout?: string;
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
  /** Timeout duration string (e.g. "5m", "2h"). */
  timeout?: string;
  /** Platform-specific extension fields, keyed by binding name. */
  extensions?: Record<string, Record<string, unknown>>;
}

/** A human-in-the-loop node requiring manual input or approval. */
export interface HumanNode extends BaseNode {
  type: "human";
  /** Human-readable description of what the human should do. */
  description?: string;
  /** How long to wait for human input (duration string, e.g. "1h", "30m"). */
  timeout?: string;
  /** What to do if human doesn't respond: "halt" | "skip" | "fallback <id>". */
  onTimeout?: string;
}

/** Topology-level defaults for sampling params and shared agent config. */
export interface DefaultsDef {
  /** Sampling temperature (0-2). */
  temperature?: number;
  /** Maximum tokens to generate. */
  maxTokens?: number;
  /** Top-p (nucleus) sampling parameter. */
  topP?: number;
  /** Top-k sampling parameter. */
  topK?: number;
  /** Stop sequences. */
  stop?: string[];
  /** Random seed for reproducibility. */
  seed?: number;
  /** Thinking/reasoning level: "off" | "low" | "medium" | "high" | "max". */
  thinking?: string;
  /** Token budget for thinking/reasoning. */
  thinkingBudget?: number;
  /** Output format: "text" | "json" | "json-schema". */
  outputFormat?: string;
  /** Timeout duration string (e.g. "5m", "2h"). */
  timeout?: string;
  /** Log level: "debug" | "info" | "warn" | "error". */
  logLevel?: string;
}

// ---------------------------------------------------------------------------
// Secrets & sensitive values
// ---------------------------------------------------------------------------

/** A reference to a secret stored in an external secret manager. */
export interface SecretRef {
  /** Secret manager scheme (e.g. "vault", "op", "awssm"). */
  scheme: string;
  /** Full URI string (e.g. "vault://secret/data/prod#key"). */
  uri: string;
}

/** A string value marked as sensitive or referencing a secret. */
export interface SensitiveValue {
  /** The raw string value. */
  value: string;
  /** Whether this value is sensitive and should not be echoed. */
  sensitive: boolean;
  /** Optional secret reference parsed from a `secret "uri"` form. */
  secretRef?: SecretRef;
  /** Whether the value is SOPS-encrypted at rest. */
  encrypted?: boolean;
  /** SOPS encryption method (parsed from ENC[METHOD,...] wrapper). */
  sopsMethod?: string;
}

/** Union of all node types. */
export type NodeDef = OrchestratorNode | ActionNode | AgentNode | GateNode | HumanNode | GroupNode;

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
  /** Optional per-agent scoping identifier (from `[per <id>]`). */
  per?: string | null;
  /** True for `-x->` error edges. */
  isError?: boolean;
  /** Optional error type filter from `-x[type]->`. */
  errorType?: string;
  /** Fan-out tolerance: integer or percentage string (e.g. "33%") from `[tolerance: N]`. */
  tolerance?: number | string;
  /** True for `[race]` fan-out edges. */
  race?: boolean;
  /** Duration string from `[wait 30s]` inline timer edge attribute. */
  wait?: string;
  /** Routing weight from `[weight 0.7]` edge attribute (0 exclusive to 1 inclusive). */
  weight?: number;
  /** Whether this back-edge represents an evaluator/reflection loop pattern. */
  reflection?: boolean;
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
  /** Topology-level timeout duration string (e.g. "30m", "2h"). */
  timeout?: string;
  /** Node id for catch-all error handler. */
  errorHandler?: string;
  /** Whether durable execution is enabled. */
  durable?: boolean;
}

/** Authentication configuration for a provider (OIDC, OAuth2, etc.). */
export interface AuthDef {
  /** Auth type (e.g. "oidc", "oauth2", "api-key", "aws-iam", "gcp-sa", "azure-msi"). */
  type: string;
  /** Token issuer URL. */
  issuer?: string;
  /** Expected audience claim. */
  audience?: string;
  /** Token endpoint URL. */
  tokenUrl?: string;
  /** OAuth2 client ID. */
  clientId?: string;
  /** OAuth2 scopes. */
  scopes?: string[];
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
  /** Authentication configuration. */
  auth?: AuthDef;
  /** Future-proof extensibility fields. */
  extra: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Composition system
// ---------------------------------------------------------------------------

/** A typed parameter declaration for a topology's `params` block. */
export interface ParamDef {
  /** Parameter name. */
  name: string;
  /** Parameter type. */
  type: "string" | "number" | "boolean";
  /** Default value (if provided, the parameter is optional). */
  default?: string | number | boolean;
  /** Whether this parameter is required (no default value). */
  required: boolean;
}

/** Entry and exit points for a composable topology. */
export interface InterfaceEndpoints {
  /** Node id that serves as the topology's entry point. */
  entry: string;
  /** Node id that serves as the topology's exit point. */
  exit: string;
}

/** An import declaration bringing another topology into the current one. */
export interface ImportDef {
  /** File path or registry address of the imported topology. */
  source: string;
  /** Alias identifier (from the `as` clause). */
  alias: string;
  /** Parameter overrides from the `with { ... }` clause. */
  params: Record<string, string | number | boolean>;
  /** Optional SHA-256 integrity hash. */
  sha256?: string;
  /** Whether this import is from a registry (vs local file). */
  registry?: boolean;
  /** Registry package name (parsed from source). */
  registryPackage?: string;
  /** Registry package version (parsed from source). */
  registryVersion?: string;
}

/** An include directive for merging a fragment file. */
export interface IncludeDef {
  /** Path to the fragment file. */
  source: string;
}

// ---------------------------------------------------------------------------
// Complete AST
// ---------------------------------------------------------------------------

/** The complete abstract syntax tree for an AgenTopology file. */
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
  /** Environment variables for the topology (plain strings or sensitive values). */
  env: Record<string, string | SensitiveValue>;
  /** Provider configurations for API credentials and model routing. */
  providers: ProviderDef[];
  /** Scheduled job definitions. */
  schedules: ScheduleJobDef[];
  /** External interface definitions. */
  interfaces: InterfaceDef[];
  /** Topology-level defaults for sampling params and shared agent config. */
  defaults: DefaultsDef | null;
  /** Named schema definitions from the top-level `schemas` block. */
  schemas: SchemaDef[];
  /** Top-level platform-specific extension fields, keyed by binding name. */
  extensions?: Record<string, Record<string, unknown>>;
  /** Observability / tracing configuration (null if not configured). */
  observability: ObservabilityDef | null;
  /** Typed parameter declarations for composition. */
  params: ParamDef[];
  /** Interface entry/exit endpoints for composition (null if not declared). */
  interfaceEndpoints: InterfaceEndpoints | null;
  /** Import declarations for sub-topologies. */
  imports: ImportDef[];
  /** Include directives for fragment files. */
  includes: IncludeDef[];
  /** Whether this file was parsed as a `fragment` rather than a `topology`. */
  isFragment?: boolean;
  /** Checkpoint / durable execution configuration (null if not configured). */
  checkpoint: CheckpointDef | null;
  /** Artifact definitions from the top-level `artifacts` block. */
  artifacts: ArtifactDef[];
}

// ---------------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------------

/** Capture settings for observability — what data to record. */
export interface ObservabilityCaptureConfig {
  /** Whether to capture prompt text sent to models. */
  prompts: boolean;
  /** Whether to capture completion text returned from models. */
  completions: boolean;
  /** Whether to capture tool invocation arguments. */
  toolArgs: boolean;
  /** Whether to capture tool invocation results. */
  toolResults: boolean;
}

/** Span settings for observability — which spans to emit. */
export interface ObservabilitySpanConfig {
  /** Emit spans for agent execution. */
  agents: boolean;
  /** Emit spans for tool invocations. */
  tools: boolean;
  /** Emit spans for gate checks. */
  gates: boolean;
  /** Emit spans for memory reads/writes. */
  memory: boolean;
}

/** Observability / tracing configuration block. */
export interface ObservabilityDef {
  /** Whether observability is enabled. */
  enabled: boolean;
  /** Log level for observability output. */
  level: string;
  /** Exporter backend (e.g. "otlp", "langsmith", "datadog", "stdout", "none"). */
  exporter: string;
  /** Exporter endpoint URL. */
  endpoint?: string;
  /** Service name for trace attribution. */
  service?: string;
  /** Sampling rate between 0 and 1. */
  sampleRate: number;
  /** Data capture configuration. */
  capture: ObservabilityCaptureConfig;
  /** Span emission configuration. */
  spans: ObservabilitySpanConfig;
}
