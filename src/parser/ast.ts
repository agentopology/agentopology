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
  /**
   * The hand-written file that holds this node's internals, project-relative
   * (e.g. ".claude/agents/reviewer.md"). The topology describes the node; the
   * file is the author's. Bindings never generate it or write its body;
   * scaffold patches in only the frontmatter keys the .at states. This is
   * how a system built by hand comes into .at without losing what is inside.
   */
  file?: string;
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
  /** Permission-rule filter on the tool's arguments (`Bash(rm -rf *)`); read on tool events only. */
  if?: string;
  /** Command or script to run when the hook fires. */
  run: string;
  /**
   * Hook type: "command" (a shell command), "prompt" (a model judges the event;
   * run: is the prompt), "agent" (a subagent judges it; run: is the prompt),
   * "http" (POST the event to url:), "mcp_tool" (call tool: on server:) or
   * "mod" (a TypeScript module loaded INSIDE the engine, subscribing to an
   * engine event such as `tool.call`; see V95). V100 checks each has what it needs.
   */
  type?: string;
  /** http hooks: the endpoint the event is POSTed to. */
  url?: string;
  /** mcp_tool hooks: the MCP server and the tool on it. */
  server?: string;
  tool?: string;
  /** command hooks: run in the background without blocking. */
  async?: boolean;
  /** prompt and agent hooks: the model that judges. */
  model?: string;
  /** Env switch that turns a `mod` hook on (e.g. "CONGREAT_MOD_REDACT"). */
  flag?: string;
  /** Timeout, passed through as written (the Claude Code binding writes it to settings.json, which reads SECONDS). */
  timeout?: number;
  /** What stops the step this hook guards: refuse | detect | hope | none (V104). */
  strength?: string;
  /** The declared way around it (an env switch, a flag). */
  bypass?: string;
  /** Bash commands `guard --test` feeds the hook's script as PreToolUse payloads (V141). */
  tests?: GateTests;
  /** Written on a hook, reported by V142: mode and let-go belong to gates. */
  mode?: string;
  letGo?: string;
  /** Id of a declared `rules { }` entry this hook enforces (V144 checks it exists). */
  rule?: string;
  /** Platform-specific extension fields, keyed by binding name. */
  extensions?: Record<string, Record<string, unknown>>;
}

/** A skill declaration within a topology. */
export interface SkillDef {
  /** Skill identifier. */
  id: string;
  /**
   * The hand-written file that holds this node's internals, project-relative
   * (e.g. ".claude/agents/reviewer.md"). The topology describes the node; the
   * file is the author's. Bindings never generate it or write its body;
   * scaffold patches in only the frontmatter keys the .at states. This is
   * how a system built by hand comes into .at without losing what is inside.
   */
  file?: string;
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
  /** Tools the skill may not use. */
  disallowedTools?: string[];
  /** When Claude should reach for the skill (added to its description for matching). */
  whenToUse?: string;
  /** Hint shown for the skill's arguments in the / menu, e.g. "<slug>". */
  argumentHint?: string;
  /** Named arguments the skill takes. */
  arguments?: string[];
  /** Globs: the skill loads only when working on matching files. */
  paths?: string[];
  /** Shell for the skill's inline commands: bash or powershell. */
  shell?: string;
  /** Model and reasoning level while the skill runs (thinking is the language's one word for effort). */
  model?: string;
  thinking?: string;
  /** Platform-specific extension fields. */
  extensions?: Record<string, Record<string, unknown>>;
}

/** A tool declaration within a topology-level `tools` block. */
export interface ToolBlockDef {
  /** Tool identifier. */
  id: string;
  /** Path to the script that implements this tool ("" when none is given). */
  script: string;
  /**
   * The shell command that runs this tool (e.g. "npm test"). On Claude Code a
   * tool with a command (or a script) is a Bash call: the agent gets `Bash`
   * and settings.json gets the allow rule `Bash(<command> *)`.
   */
  command?: string;
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
  /** The machine the job runs on (a `machines` entry, V122). */
  machine?: string;
  /** What fires the job: session | cron | launchd | cloud | calendar (V124). */
  carrier?: string;
  /** What the job outlives: pane-close | reboot | away (V124, V125). */
  survives?: string;
}

/** A machine from the top-level `machines` block. */
export interface MachineDef {
  id: string;
  /** Operating system, as written (macos, linux, windows). */
  os?: string;
}

/** A secret from the top-level `secrets` block: a path glob only the listed readers may read. */
export interface SecretDef {
  id: string;
  /** Project-relative path glob. */
  path?: string;
  /** Agent ids, or "main" for the main session. */
  readers: string[];
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
  /** Spend cap in USD (`max-cost:`, or its alias `cap:`). Advisory: written to the metering output, never enforced. */
  maxCost?: number;
  /** The value as written, kept when it is not a positive number so V156 can name it. */
  maxCostRaw?: string;
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
// Agent memory stores & retrieval
// ---------------------------------------------------------------------------

/** Embedding configuration for a memory store. */
export interface EmbeddingConfig {
  /** Embedding provider (e.g. "ollama", "local", "voyage", "openai", "gemini"). */
  provider?: string;
  /** Model identifier for embedding generation. */
  model?: string;
  /** Vector dimensions produced by the embedding model. */
  dimensions?: number;
  /** Endpoint URL or secret reference for the embedding service. */
  endpoint?: string;
}

/** Index configuration for a memory store's vector/search index. */
export interface IndexConfig {
  /** Collection or table name within the backend. */
  collection?: string;
  /** Distance metric for vector similarity: "cosine" | "euclidean" | "dot-product". */
  metric?: string;
}

/** Ingestion configuration for populating a memory store. */
export interface IngestionConfig {
  /** Source paths or globs to ingest from. */
  sources?: string[];
  /** Chunking strategy: "recursive" | "sentence" | "paragraph" | "fixed". */
  chunking?: string;
  /** Target chunk size in tokens or characters. */
  chunkSize?: number;
  /** Overlap between chunks in tokens or characters. */
  overlap?: number;
}

/** Search configuration for querying a memory store. */
export interface SearchConfig {
  /** Search strategy: "vector" | "keyword" | "hybrid" | "graph". */
  strategy?: string;
  /** Whether to apply reranking to search results. */
  rerank?: boolean;
  /** Number of top results to return. */
  topK?: number;
}

/** Lifecycle management configuration for a memory store. */
export interface LifecycleConfig {
  /** Retention period (duration string, e.g. "90d", "1y"). */
  retention?: string;
  /** Half-life for memory decay scoring (duration string, e.g. "30d"). */
  decayHalfLife?: string;
  /** Consolidation threshold (0 to 1). */
  consolidation?: number;
  /** Contradiction resolution strategy: "overwrite" | "preserve" | "bi-temporal". */
  contradiction?: string;
  /** Whether to maintain an audit log of memory mutations. */
  auditLog?: boolean;
}

/** A memory store declaration within the memory block. */
export interface StoreNode {
  /** Store identifier (from `store <id> {}`). */
  id: string;
  /** Memory type: "semantic" | "episodic" | "procedural" | "entity" | "graph" | "user" | "session" | "temporal". */
  type: string;
  /** Human-readable description of this store's purpose. */
  description?: string;
  /** Access scope: "agent" | "user" | "session" | "org" | "global". */
  scope?: string;
  /** Isolation level: "strict" | "soft" | "none". */
  isolation?: string;
  /** Storage backend: "lancedb" | "sqlite-vec" | "chroma" | "kuzu" | "falkordb" | "mongodb" | "pinecone" | "qdrant" | "pgvector" | "neo4j" | "sqlite". */
  backend: string;
  /** File system path for local backends. */
  path?: string;
  /** Connection string or secret reference for remote backends. */
  connection?: string;
  /** Embedding model and provider configuration. */
  embedding?: EmbeddingConfig;
  /** Index/collection configuration. */
  index?: IndexConfig;
  /** Data ingestion configuration. */
  ingestion?: IngestionConfig;
  /** Search/query configuration. */
  search?: SearchConfig;
  /** Memory lifecycle management configuration. */
  lifecycle?: LifecycleConfig;
  /** Entity/fact extraction method: "llm" | "regex" | "hybrid". */
  extraction?: string;
  /**
   * File format/convention for file-native stores. For `brain` stores this is
   * typically `obsidian` — a promise that the store holds only Obsidian-format
   * markdown ([[wikilinks]], #tags, YAML frontmatter), so it round-trips as a
   * real Obsidian vault. See `docs/company-brain-design.md`.
   */
  format?: string;
  /**
   * PRESENTATION ONLY — provenance styling for the brain graph view. Maps a
   * note's `source:` frontmatter value (e.g. "gmail", "slack") to a display
   * color and/or icon path. This is purely cosmetic: it affects ONLY the
   * `visualize-brain` rendering, never ingestion, agents, files, or any
   * binding output (bindings ignore it entirely). Delete it and the brain
   * behaves identically — the graph just falls back to category coloring.
   * The language stores only strings (a hex color, a path); image bytes are
   * read and inlined by the visualizer at generate-time, never by the language.
   */
  sources?: Record<string, SourceStyle>;
  /** Backend-specific passthrough configuration. */
  backendConfig?: Record<string, unknown>;
  /** The one agent that may share this store with another writer (V121). */
  owner?: string;
  /** The machine this store lives on (T-07, V122). */
  machine?: string;
}

/** Presentation styling for one provenance source (e.g. gmail) in the graph. */
export interface SourceStyle {
  /** Hex color (e.g. "#EA4335") for nodes whose `source:` matches this key. */
  color?: string;
  /** Path to a logo/icon file. Inlined as a data: URI by the visualizer. */
  icon?: string;
}

/** Scoring weight configuration for retrieval ranking. */
export interface ScoringConfig {
  /** Weight for recency in scoring (0 to 1). */
  recencyWeight?: number;
  /** Weight for semantic similarity in scoring (0 to 1). */
  semanticWeight?: number;
  /** Weight for importance/frequency in scoring (0 to 1). */
  importanceWeight?: number;
}

/** A retrieval strategy declaration within the memory block. */
export interface RetrievalNode {
  /** Retrieval strategy identifier (from `retrieval <id> {}`). */
  id: string;
  /** Store IDs this retrieval draws from. */
  sources?: string[];
  /** Token budget for retrieved context. */
  budget?: number;
  /** Scoring weight configuration. */
  scoring?: ScoringConfig;
  /** Retrieval paths to activate: e.g. ["semantic", "episodic", "graph"]. */
  paths?: string[];
  /** Whether to apply cross-source reranking. */
  rerank?: boolean;
  /** Whether to enforce diversity across results. */
  diversity?: boolean;
  /** Similarity threshold for cache-hit detection (0 to 1). */
  cacheHitThreshold?: number;
  /** Action on cache hit: "short-circuit" | "augment" | "pass-through". */
  cacheHitAction?: string;
}

// ---------------------------------------------------------------------------
// Artifact / asset lineage
// ---------------------------------------------------------------------------

/**
 * A record in the top-level `records` block: a project-relative JSON Lines
 * file a step's own script appends to. agentopology only reads it.
 * (`append-only` and `written-by` are reserved, not implemented.)
 */
export interface RecordDef {
  id: string;
  /** Project-relative path; may contain `{unit}`. */
  path: string;
  /** Fields a row must hold: `fields: [name: type, ..]` (types: string, number, boolean, ts). */
  fields?: RecordFieldDef[];
  /** A schema declared in `schemas { }`. */
  schema?: string;
  /** What writes the record: an action id, an agent id or a project script path. */
  writer?: string;
  /** `run-state`: the fixed fields target and step. Any other value is reported by V139. */
  kind?: string;
}

/** One field of a record, as written: the type is kept as written so V139 can name a wrong one. */
export interface RecordFieldDef {
  name: string;
  type: string;
}

/** The field types a record field may have. */
export const RECORD_FIELD_TYPES = ["string", "number", "boolean", "ts"] as const;

/** The fields of a `kind: run-state` record. */
export const RUN_STATE_FIELDS: RecordFieldDef[] = [
  { name: "target", type: "string" },
  { name: "step", type: "string" },
];

/** The fields a record's rows must hold: its run-state fixed fields, or the ones it declares. */
export function recordFields(r: RecordDef): RecordFieldDef[] {
  return r.kind === "run-state" ? RUN_STATE_FIELDS : r.fields ?? [];
}

/**
 * The top-level `ci { provider: github, on: [...], gates: [...] }` block.
 * Scaffold writes a workflow that runs `agentopology step check` for the step
 * after each listed gate. Only `github` is supported (V155).
 */
export interface CiDef {
  /** CI provider as written; only "github" is accepted. */
  provider: string;
  /** Events that start the workflow. Default: pull_request and push. */
  on: string[];
  /** Ids of declared gates whose following step the workflow checks. */
  gates: string[];
}

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
  /**
   * The hand-written file that holds this node's internals, project-relative
   * (e.g. ".claude/agents/reviewer.md"). The topology describes the node; the
   * file is the author's. Bindings never generate it or write its body;
   * scaffold patches in only the frontmatter keys the .at states. This is
   * how a system built by hand comes into .at without losing what is inside.
   */
  file?: string;
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
  /**
   * Delegation mode — how the orchestrator runs the agent nodes.
   *
   * - "subagent" (default): orchestrator spawns each agent via the platform's
   *   subagent / Task-tool mechanism. Agent runs in its own context window.
   *   On claude-code: SubagentStop hooks fire and gates compile to those hooks.
   *
   * - "inline": orchestrator drives every agent in its own session context.
   *   Agent AGENT.md files are read as prompt fragments, no subagent is ever
   *   spawned. On claude-code: SubagentStop hooks NEVER fire — gates must be
   *   invoked from a command playbook at the right step.
   *
   * If unset, bindings treat it as "subagent" for backward compatibility.
   */
  delegation?: "subagent" | "inline";
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
  /**
   * Regex with one capture group that reads the unit (an episode id, a ticket)
   * out of the command line, e.g. `./tool publish (\S+)`. A gate before this
   * action checks its ledger for that unit.
   */
  unitFrom?: string;
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
  /** Disallowed tool names. May be set together with `tools`: Claude Code removes them first, then resolves `tools`. */
  disallowedTools?: string[];
  /** Path globs this agent may not read (Read, Grep, Glob, and Bash commands naming them). */
  neverReads?: string[];
  /** Skip condition expression. */
  skip?: string;
  /** Behavior mode (e.g. "advisory", "blocking"). */
  behavior?: string;
  /** Invocation mode (e.g. "manual"). */
  invocation?: string;
  /**
   * How the node runs: "subagent" (its own agent, the default), "session" (its
   * own named Claude Code session that can message other sessions), "inline" (a
   * skill in the caller's own context) or "fork" (a skill in a fresh forked
   * context). The choice shows on the node instead of hiding in fields.
   */
  runs?: string;
  /**
   * Where a session agent lives, a name shared by the agents that run
   * together (`place: ops`). Only meaningful with `runs: session`.
   */
  place?: string;
  /** The machine a session agent runs on (a `machines` entry, V122). */
  machine?: string;
  /** Decisions this agent holds the seat for (`decides: [package-yes]`). */
  decides?: string[];
  /**
   * Permission mode of a session agent: default | acceptEdits | plan |
   * bypassPermissions | auto. A talk edge whose ends differ may not arrive.
   */
  permissionMode?: string;
  /**
   * Must not see the author's reasoning (a critic, a judge): it gets only the
   * artifacts it reads. Cannot run inline (V101).
   */
  independent?: boolean;
  /** Display color in the agent list. */
  color?: string;
  /** First user turn when the agent runs as the main session agent. */
  initialPrompt?: string;
  /** Leave the project's CLAUDE.md out of the agent's context. */
  omitClaudeMd?: boolean;
  /** Retry configuration: simple count or structured block. */
  retry?: number | RetryConfig;
  /** Isolation mode (e.g. "worktree"). */
  isolation?: string;
  /** Whether this agent runs in the background. */
  background?: boolean;
  /** MCP server names this agent uses. */
  mcpServers?: string[];
  /** Memory store IDs this agent has access to. */
  memory?: string[];
  /** Retrieval strategy ID this agent uses for memory queries. */
  retrieval?: string;
  /**
   * Memory store IDs this agent is the CUSTODIAN of — i.e. it owns the upkeep
   * of the store, not merely read access. The primitive behind the `brain`
   * pattern: a custodian wires dropped files into the graph (links, tags,
   * index hubs, dedupe). See `docs/company-brain-design.md`.
   */
  custodianOf?: string[];
  /**
   * Optional, declared vocabulary of maintenance verbs this custodian performs
   * (e.g. ["link", "tag", "index", "dedupe"]). Omit to let the agent infer its
   * duties from its prompt. The verb NAMES are language vocabulary; HOW each is
   * done well stays in the skill repo (MOAT).
   */
  custodianDoes?: string[];
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
  /** Most subagents this agent may have open at once (`max-subagents:`). */
  maxSubagents?: number;
  /** Wall-clock cap on the whole session, as written (`4h`, `90m`); the entry agent only (V159). On claude-code a PreToolUse guard refuses every tool once it has passed. */
  wallTime?: string;
  /** The `max-subagents:` value as written, kept when it is not a positive integer (V156). */
  maxSubagentsRaw?: string;
  /** Spend cap in USD (`max-cost:`). Advisory: never enforced. */
  maxCost?: number;
  /** The `max-cost:` value as written, kept when it is not a positive number (V156). */
  maxCostRaw?: string;
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
  /**
   * Node id(s) this gate runs after. A list attaches ONE declaration to many
   * anchors — the gate fires after each named node independently.
   *
   * The list form exists to stop a repeated verification ritual being copied
   * per lane, where one copy inevitably drifts and the whole value of a ritual
   * is that it is identical everywhere. It changes nothing an agent sees: the
   * brief still gets one gate step per anchor, and bindings still emit one hook
   * entry per anchor.
   *
   * **Never read this directly — use {@link gateAnchors}.** Roughly eighteen
   * sites across the bindings, the visualizer and the serializer would accept
   * an array SILENTLY and mis-handle it: a hook matcher would ship `["a","b"]`
   * into settings.json and never fire, `g.after === id` would never match, and
   * the round-trip serializer would emit `after: a,b` which re-parses as one id.
   */
  after?: string | string[];
  /** Node id(s) this gate runs before. See {@link after}. */
  before?: string | string[];
  /**
   * Path globs from `before: write "<glob>"`: an edit of a matching path is refused until the
   * gate holds. Kept apart from {@link before} (node ids); an empty glob is kept so V151 can say so.
   */
  beforeWrite?: string[];
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
  /** What the gate checks, in words (V96 sends prose here, out of `run`). */
  description?: string;
  /** What stops the step: refuse | detect | hope | none (V104). */
  strength?: string;
  /** How it refuses: code | hook | settings | gate (V104). */
  by?: string;
  /** The code that refuses, "path" or "path:line", project-relative (V106). */
  at?: string;
  /** Text expected on the cited lines, so a refactor that removes the check is caught. */
  match?: string;
  /** The declared way around it (an env switch, a flag). */
  bypass?: string;
  /**
   * Record id of the ledger a gate before an action reads: the step in `after:`
   * must have an ok line for the unit. Omitted, a topology with exactly one
   * record uses that record.
   */
  ledger?: string;
  /** Commands (or, before a subagent, agent names) the generated check must refuse and allow; `guard --test` runs them (V141). */
  tests?: GateTests;
  /** `shadow`: the generated check logs what it would refuse to logs/shadow.jsonl and lets the step run. `refuse` (default) refuses (V142). */
  mode?: string;
  /** `once`: a human's ledger row lifts one refusal for one run (V142). */
  letGo?: string;
  /** The human id whose ledger row lets this gate go (default: the human in `after:`). */
  lift?: string;
  /** Id of a declared `rules { }` entry this gate enforces (V144 checks it exists). */
  rule?: string;
  /** Platform-specific extension fields, keyed by binding name. */
  extensions?: Record<string, Record<string, unknown>>;
}

/** The `tests { refuse: [..] allow: [..] }` rows of a gate or a hook. */
export interface GateTests {
  /** Each is fed to the guard and must be refused. */
  refuse: string[];
  /** Each is fed to the guard and must be allowed. */
  allow: string[];
}

/** An MCP server a Claude Code plugin provides: `from: plugin "<plugin>"`, with `server:` (default: the block key). */
export interface PluginMcpServer {
  plugin: string;
  server: string;
}

/**
 * The plugin server an `mcp-servers` entry names, or null for a project
 * server. The parser stores `from: plugin "<name>"` as from = "plugin",
 * plugin = "<name>"; any other `from:` stays as written (V130 reports it).
 */
export function pluginMcpServer(key: string, config: Record<string, unknown> | undefined): PluginMcpServer | null {
  if (!config || config.from !== "plugin" || typeof config.plugin !== "string" || config.plugin === "") return null;
  const server = typeof config.server === "string" && config.server !== "" ? config.server : key;
  return { plugin: config.plugin, server };
}

/** Every plugin MCP server the topology declares, by its block key. */
export function pluginMcpServers(ast: Pick<TopologyAST, "mcpServers">): Map<string, PluginMcpServer> {
  const out = new Map<string, PluginMcpServer>();
  for (const [key, config] of Object.entries(ast.mcpServers ?? {})) {
    const p = pluginMcpServer(key, config);
    if (p) out.set(key, p);
  }
  return out;
}

/**
 * The anchors of a gate, always as a list.
 *
 * The single normalisation point for `after` / `before`. No consumer should
 * branch on the union — the seven-phase-sentinel bug fixed earlier the same day
 * is what happens when each consumer decides for itself.
 *
 * @param gate - Any gate node.
 * @param which - Which anchor field to read.
 * @returns Zero or more node ids, never undefined.
 */
export function gateAnchors(
  gate: Pick<GateNode, "after" | "before">,
  which: "after" | "before"
): string[] {
  const v = gate[which];
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * The FIRST anchor, for the handful of places that genuinely need one value —
 * a hook matcher on a platform whose matcher field is a string, for instance.
 * Callers must handle the remaining anchors themselves (usually by emitting one
 * entry per anchor); this exists so nobody reaches for `gate.after as string`.
 */
export function primaryAnchor(
  gate: Pick<GateNode, "after" | "before">,
  which: "after" | "before"
): string | undefined {
  return gateAnchors(gate, which)[0];
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
  /** The person this step waits on (a `person` block, V127). */
  who?: string;
  /** Window `"YYYY-MM-DD..YYYY-MM-DD"` this human's approval holds; `step check` refuses a guarded step after it. */
  valid?: string;
  /** The go word the person types. On claude-code a UserPromptSubmit hook writes the go row to the ledger of the gate after this human when a typed prompt holds it. */
  word?: string;
  /** The stop word the person types. On claude-code the same go hook then appends a halt row to the same ledger, and go-halt.sh refuses every tool until the person types the go word again. */
  stopWord?: string;
  /** Project paths whose content the go approves: the row records each one's sha256, and before-action.sh counts the go only while they are unchanged. */
  binds?: string[];
  /** Programs that type into the person's terminal (beyond the built-in keystroke tools): a Bash command running one that holds the go word is refused. */
  typedOnlyPrograms?: string[];
}

/** A person from a top-level `person <id> { away: "YYYY-MM-DD..YYYY-MM-DD" }` block. */
export interface PersonDef {
  id: string;
  /** Window the person is away, as written. */
  away?: string;
}

/** The top-level `threat-model { untrusted, outside-sandbox, refuse-after-untrusted, lift }` block. */
export interface ThreatModelDef {
  /** `web`, `mcp:<server id>`, or a path glob. A server written `trust: untrusted` is added where the list is used. */
  untrusted: string[];
  /** Commands and paths that run outside the sandbox. */
  outsideSandbox: string[];
  /** Permission-rule strings refused while the session holds a taint mark. */
  refuseAfterUntrusted: string[];
  /** The human whose ok row for an act ends the taint for that act. */
  lift?: string;
}

/** What an `egress { covers }` list may name. */
export const EGRESS_COVERS = ["observability", "web", "network", "mcp"] as const;

/** The top-level `egress { gate: <human id | record id>, covers: [observability, web, network, mcp] }` block: the covered tools are held until the gate clears. */
export interface EgressDef {
  /** A human with a `word:` (cleared by its go row) or a record id (cleared by a row in it); empty when not written (V160). */
  gate: string;
  /** What is held, as written. */
  covers: string[];
}

/** The top-level `needs { memory: "<path under home>" connectors: [..] user-skills: [..] }` block (L-4). */
export interface NeedsDef {
  /** A path under the user's home (`~/...`). */
  memory?: string;
  /** Account connectors; they cannot be checked locally. */
  connectors?: string[];
  /** Skills expected at `~/.claude/skills/<name>`. */
  userSkills?: string[];
  /** Plugins expected under `~/.claude/plugins`. */
  plugins?: string[];
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
  /**
   * True for a `[finish]` edge: it closes the run and hands the line back to
   * the entry agent. An end, not a loop, so it needs no `[max N]` (V149).
   */
  finish?: boolean;
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
  /** What stops this step, written down: refuse | detect | hope | none (V104). */
  strength?: string;
  /** Where the enforcement (or the prose that hopes) lives, "path[:line]" (V106). */
  at?: string;
  /** Hooks or gates that guard this edge, by id (V105). */
  guard?: string[];
  /** What crosses a talk edge between session agents: ticket | report | ask. */
  message?: string;
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
  /**
   * The agent every session starts as (`meta { entry: <agent-id> }`). Claude
   * Code: the settings.json `agent` key. Must name an agent Claude Code can
   * start as the main thread (V134).
   */
  entry?: string;
  /** Node ids a run may end at (`meta { outpoints: [..] }`, V150). */
  outpoints?: string[];
  /** Whether durable execution is enabled. */
  durable?: boolean;
  /** Version range of the agentopology package this file needs (`meta { requires: ">=0.13.0" }`). */
  requires?: string;
  /**
   * The directory the generated hooks resolve project paths against (ledgers, gate checks,
   * `before: write` globs): absolute, or relative to the project. Default: the project root.
   */
  target?: string;
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
/** One `rule "<id>" { text: ..., source: ... }` of the `rules` block. */
export interface RuleDef {
  /** The quoted id; may hold dots ("R-7.6"). */
  id: string;
  /** What the rule says. Required, never empty (V143). */
  text: string;
  /** Where the rule comes from. */
  source?: string;
}

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
  /** Memory store declarations (parsed from store blocks within memory). */
  stores: StoreNode[];
  /** Retrieval strategy declarations (parsed from retrieval blocks within memory). */
  retrievals: RetrievalNode[];
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
    /** Longest the context file may be, in lines (V146 warns above it). */
    maxLines?: number;
    /** Terms the context file defines, in the order written. */
    glossary?: { term: string; definition: string }[];
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
  /** Conduct rules from the top-level `rules` block, traced to their ids. */
  rules?: RuleDef[];
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
  /** Records from the top-level `records` block (ledgers gates read). */
  records?: RecordDef[];
  /** The top-level `ci { }` block: the gates a CI workflow runs (see {@link CiDef}). */
  ci?: CiDef;
  /** Decision names the topology says must have a seat (`decisions: [...]`). */
  decisions?: string[];
  /** `pin-models: true` at the top level: a bare model alias warns (V119). */
  pinModels?: boolean;
  /**
   * Absolute path of the file the CLI parsed this from. Set (non-enumerable, so
   * it never reaches `export --format json`) by the CLI; `validate` uses it to
   * resolve imports when no `filePath` option is given.
   */
  sourcePath?: string;
  /** Machines from the top-level `machines` block (T-07). */
  machines?: MachineDef[];
  /** Secrets from the top-level `secrets` block. */
  secrets?: SecretDef[];
  /** People from the top-level `person` blocks (T-09). */
  persons?: PersonDef[];
  /** Extra project folders whose files count as live things, from `inventory { roots: [...] }` (T-08). */
  inventoryRoots?: string[];
  /** What the topology needs from outside the repo, from the top-level `needs` block (L-4). */
  needs?: NeedsDef;
  /** Untrusted inputs and what is refused after reading one, from the top-level `threat-model` block. */
  threatModel?: ThreatModelDef;
  /** Tools held until a gate clears, from the top-level `egress` block. */
  egress?: EgressDef;
  /** `inventory { strict: true }`: validate --inventory exits 1 when a live file is unmapped. */
  inventoryStrict?: boolean;
  /** Code regions from the top-level `islands` block: files they match count as accounted for. */
  islands?: IslandDef[];
}

/** One `island <id> { path, owner, test }` from the top-level `islands` block. */
export interface IslandDef {
  id: string;
  /** Glob of project files the island covers (`*`, `**`, `?`). */
  path: string;
  /** A declared person id. */
  owner: string;
  /** Command that tests the island; listed by guard --check, never run. */
  test?: string;
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
  /**
   * Resource attributes (`attributes { key: "value" }`), in file order. Claude
   * Code gets them in OTEL_RESOURCE_ATTRIBUTES after service.name. Absent when
   * the block has no `attributes { }`.
   */
  attributes?: Record<string, string>;
  /** Whether the .at wrote a `spans { }` block (the `spans` values are defaults otherwise). */
  spansWritten?: boolean;
  /** Sampling rate between 0 and 1. */
  sampleRate: number;
  /** Data capture configuration. */
  capture: ObservabilityCaptureConfig;
  /** Span emission configuration. */
  spans: ObservabilitySpanConfig;
}
