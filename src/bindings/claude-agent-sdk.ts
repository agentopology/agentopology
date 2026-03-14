/**
 * Claude Agent SDK binding — the native agent binding.
 *
 * Unlike the `anthropic-sdk` binding that generates a manual tool loop via
 * `messages.create()`, this binding targets the Claude Agent SDK where each
 * agent is a single `query()` call. The SDK handles tool execution, subagent
 * delegation, hooks, MCP servers, and permissions natively.
 *
 * Output: a self-contained Node.js project with:
 *   - Per-agent `query()` configurations (no manual tool loop)
 *   - Native subagent delegation via `options.agents`
 *   - Native hooks via `options.hooks`
 *   - Native MCP via `options.mcpServers`
 *   - Native permissions via `options.permissionMode`
 *   - File-based memory (markdown read/write)
 *   - Orchestrator for flow graph execution
 *   - Group chat, human-in-the-loop, action, gate executors
 *   - Observability, checkpointing, scheduling, rate limiting
 *   - Circuit breaker, saga compensation, prompt variants
 *
 * @module
 */

import type {
  TopologyAST,
  AgentNode,
  EdgeDef,
  NodeDef,
  GateNode,
  HumanNode,
  GroupNode,
  ActionNode,
  OrchestratorNode,
  SchemaFieldDef,
  SchemaType,
  RetryConfig,
} from "../parser/ast.js";
import { deduplicateFiles } from "./types.js";
import type { BindingTarget, GeneratedFile } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toTitle(id: string): string {
  return id
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function toCamelCase(id: string): string {
  const parts = id.split(/[-_]/);
  return parts[0] + parts.slice(1).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
}

function toPascalCase(id: string): string {
  return id
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => (line.trim() ? pad + line : line))
    .join("\n");
}

function escapeString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$/g, "\\$");
}

function escapeQuotes(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Parse a duration string like "30s", "5m", "2h" into milliseconds. */
function durationToMs(duration: string): number {
  const match = duration.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/);
  if (!match) return 30000; // default 30s
  const value = parseFloat(match[1]);
  switch (match[2]) {
    case "ms": return value;
    case "s": return value * 1000;
    case "m": return value * 60_000;
    case "h": return value * 3_600_000;
    case "d": return value * 86_400_000;
    default: return value * 1000;
  }
}

/** Convert a SchemaType to a JSON Schema-compatible type string. */
function schemaTypeToJsonSchema(t: SchemaType): string {
  switch (t.kind) {
    case "primitive":
      return JSON.stringify({ type: t.value });
    case "array":
      return JSON.stringify({ type: "array", items: JSON.parse(schemaTypeToJsonSchema(t.itemType)) });
    case "enum":
      return JSON.stringify({ type: "string", enum: t.values });
    case "ref":
      return JSON.stringify({ $ref: `#/definitions/${t.name}` });
  }
}

/** Build JSON Schema properties from schema fields. */
function fieldsToJsonSchema(fields: SchemaFieldDef[]): string {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const f of fields) {
    properties[f.name] = JSON.parse(schemaTypeToJsonSchema(f.type));
    if (!f.optional) required.push(f.name);
  }
  return JSON.stringify({ type: "object", properties, required }, null, 2);
}

// ---------------------------------------------------------------------------
// Model mapping
// ---------------------------------------------------------------------------

function mapModel(model: string | undefined): string {
  if (!model) return "claude-sonnet-4-6";
  const m = model.toLowerCase();
  if (m === "opus" || m === "claude-opus") return "claude-opus-4-6";
  if (m === "sonnet" || m === "claude-sonnet") return "claude-sonnet-4-6";
  if (m === "haiku" || m === "claude-haiku") return "claude-haiku-4-5-20251001";
  if (m.startsWith("claude-")) return model;
  return "claude-sonnet-4-6";
}

/** Map model alias to subagent-style alias (opus, sonnet, haiku). */
function mapSubagentModel(model: string | undefined): string {
  if (!model) return "sonnet";
  const m = model.toLowerCase();
  if (m === "opus" || m === "claude-opus" || m.includes("opus")) return "opus";
  if (m === "sonnet" || m === "claude-sonnet" || m.includes("sonnet")) return "sonnet";
  if (m === "haiku" || m === "claude-haiku" || m.includes("haiku")) return "haiku";
  return mapModel(model);
}

// ---------------------------------------------------------------------------
// Permission mapping
// ---------------------------------------------------------------------------

function mapPermission(perm: string | undefined): string {
  if (!perm) return "default";
  switch (perm.toLowerCase()) {
    case "plan": return "plan";
    case "auto": case "autonomous": return "bypassPermissions";
    case "confirm": case "supervised": return "default";
    case "accept-edits": return "acceptEdits";
    case "deny-unasked": return "dontAsk";
    default: return "default";
  }
}

// ---------------------------------------------------------------------------
// Thinking mapping
// ---------------------------------------------------------------------------

function mapThinking(thinking: string | undefined, budget?: number): string | null {
  if (!thinking || thinking === "off") return null;
  const budgetTokens = budget || 4096;
  return `{ type: "enabled", budgetTokens: ${budgetTokens} }`;
}

// ---------------------------------------------------------------------------
// Hook event mapping
// ---------------------------------------------------------------------------

/**
 * Map topology hook event names to SDK HookEvent names.
 *
 * The SDK supports 22 hook events:
 *   PreToolUse, PostToolUse, PostToolUseFailure, Notification,
 *   UserPromptSubmit, SessionStart, SessionEnd, Stop,
 *   SubagentStart, SubagentStop, PreCompact, PostCompact,
 *   PermissionRequest, Setup, TeammateIdle, TaskCompleted,
 *   Elicitation, ElicitationResult, ConfigChange,
 *   InstructionsLoaded, WorktreeCreate, WorktreeRemove
 */
function mapHookEvent(event: string): string {
  // Canonical SDK event names (pass through as-is)
  const sdkEvents = new Set([
    "PreToolUse", "PostToolUse", "PostToolUseFailure", "Notification",
    "UserPromptSubmit", "SessionStart", "SessionEnd", "Stop",
    "SubagentStart", "SubagentStop", "PreCompact", "PostCompact",
    "PermissionRequest", "Setup", "TeammateIdle", "TaskCompleted",
    "Elicitation", "ElicitationResult", "ConfigChange",
    "InstructionsLoaded", "WorktreeCreate", "WorktreeRemove",
  ]);

  if (sdkEvents.has(event)) return event;

  // Map common topology-level aliases to SDK events
  const aliases: Record<string, string> = {
    "pre-tool": "PreToolUse",
    "pre-tool-use": "PreToolUse",
    "post-tool": "PostToolUse",
    "post-tool-use": "PostToolUse",
    "tool-failure": "PostToolUseFailure",
    "post-tool-failure": "PostToolUseFailure",
    "notify": "Notification",
    "notification": "Notification",
    "prompt-submit": "UserPromptSubmit",
    "user-prompt": "UserPromptSubmit",
    "session-start": "SessionStart",
    "session-end": "SessionEnd",
    "stop": "Stop",
    "subagent-start": "SubagentStart",
    "subagent-stop": "SubagentStop",
    "pre-compact": "PreCompact",
    "post-compact": "PostCompact",
    "permission": "PermissionRequest",
    "permission-request": "PermissionRequest",
    "setup": "Setup",
    "teammate-idle": "TeammateIdle",
    "task-completed": "TaskCompleted",
    "elicitation": "Elicitation",
    "elicitation-result": "ElicitationResult",
    "config-change": "ConfigChange",
    "instructions-loaded": "InstructionsLoaded",
    "worktree-create": "WorktreeCreate",
    "worktree-remove": "WorktreeRemove",
  };

  const normalized = event.toLowerCase();
  return aliases[normalized] || event;
}

// ---------------------------------------------------------------------------
// Code generators
// ---------------------------------------------------------------------------

function generatePackageJson(ast: TopologyAST): string {
  const name = ast.topology.name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const deps: Record<string, string> = {
    "@anthropic-ai/claude-agent-sdk": "^0.1.0",
  };
  // Include zod when custom tools are defined (used by createSdkMcpServer / tool())
  if (ast.toolDefs.length) {
    deps["zod"] = "^3.22.0";
  }
  return JSON.stringify(
    {
      name: `${name}-topology`,
      version: ast.topology.version || "0.1.0",
      type: "module",
      scripts: {
        start: "tsx src/index.ts",
        build: "tsc",
        dev: "tsx watch src/index.ts",
      },
      dependencies: deps,
      devDependencies: {
        tsx: "^4.7.0",
        typescript: "^5.4.0",
        "@types/node": "^20.11.0",
      },
    },
    null,
    2,
  );
}

function generateTsConfig(): string {
  return JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        outDir: "dist",
        rootDir: "src",
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        declaration: true,
        sourceMap: true,
      },
      include: ["src"],
    },
    null,
    2,
  );
}

function generateEnvExample(ast: TopologyAST): string {
  const lines = ["# Environment variables for the topology runtime"];

  lines.push("ANTHROPIC_API_KEY=your-api-key-here");

  for (const provider of ast.providers) {
    if (provider.apiKey) {
      const envVar = provider.apiKey.replace(/^\$\{/, "").replace(/\}$/, "");
      if (envVar !== "ANTHROPIC_API_KEY") {
        lines.push(`${envVar}=your-${provider.name}-key-here`);
      }
    }
  }

  for (const [key, value] of Object.entries(ast.env)) {
    if (typeof value === "string") {
      lines.push(`${key}=${value}`);
    } else if (value.sensitive) {
      lines.push(`${key}=your-${key.toLowerCase()}-here`);
    } else {
      lines.push(`${key}=${value.value}`);
    }
  }

  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Types generator
// ---------------------------------------------------------------------------

function generateTypes(ast: TopologyAST): string {
  const agents = ast.nodes.filter((n): n is AgentNode => n.type === "agent");
  const lines: string[] = [
    "/**",
    ` * Type definitions for ${ast.topology.name} topology.`,
    " * Auto-generated by agentopology scaffold — edit as needed.",
    " */",
    "",
    "// ---------------------------------------------------------------------------",
    "// Agent identifiers",
    "// ---------------------------------------------------------------------------",
    "",
    `export type AgentId = ${agents.map((a) => `"${a.id}"`).join(" | ") || "string"};`,
    "",
    "// ---------------------------------------------------------------------------",
    "// Agent result types",
    "// ---------------------------------------------------------------------------",
    "",
    "export interface AgentResult {",
    "  agentId: AgentId;",
    "  output: string;",
    "  tokenUsage: { input: number; output: number };",
    "  durationMs: number;",
    "  error?: string;",
    "}",
    "",
    "// ---------------------------------------------------------------------------",
    "// Memory",
    "// ---------------------------------------------------------------------------",
    "",
    "export interface MemoryStore {",
    "  read(key: string): Promise<string | null>;",
    "  write(key: string, value: string): Promise<void>;",
    "  list(prefix?: string): Promise<string[]>;",
    "}",
    "",
    "// ---------------------------------------------------------------------------",
    "// Agent configuration (for query() calls)",
    "// ---------------------------------------------------------------------------",
    "",
    "export interface AgentQueryConfig {",
    "  id: AgentId;",
    "  model: string;",
    "  systemPrompt: string;",
    "  allowedTools?: string[];",
    "  disallowedTools?: string[];",
    "  permissionMode: string;",
    "  maxTurns: number;",
    "  hooks?: HookConfig[];",
    "  mcpServers?: McpServerConfig[];",
    "  subagents?: Record<string, SubagentDef>;",
    "  skills?: string[];",
    "  sandbox?: string | boolean;",
    "  thinking?: { type: string; budgetTokens?: number };",
    "  outputFormat?: OutputFormatConfig;",
    "  // Polyfill fields (not native SDK options)",
    "  retry?: { max: number; backoff?: string; interval?: number };",
    "  timeout?: number;",
    "  onFail?: string;",
    "  skip?: string;",
    "  fallbackChain?: string[];",
    "  circuitBreaker?: CircuitBreakerConfig;",
    "  compensates?: string;",
    "  phase?: number;",
    "  rateLimit?: string;",
    "  variants?: PromptVariant[];",
    "  memoryReads?: string[];",
    "  memoryWrites?: string[];",
    "  background?: boolean;",
    "  isolation?: string;",
    "  description?: string;",
    "}",
    "",
    "// ---------------------------------------------------------------------------",
    "// Subagent definition (for options.agents)",
    "// ---------------------------------------------------------------------------",
    "",
    "export interface SubagentDef {",
    "  description: string;",
    "  prompt?: string;",
    "  tools?: string[];",
    "  model?: string;",
    "  maxTurns?: number;",
    "  skills?: string[];",
    "  mcpServers?: McpServerConfig[];",
    "}",
    "",
    "// ---------------------------------------------------------------------------",
    "// Hook configuration",
    "// ---------------------------------------------------------------------------",
    "",
    "export interface HookConfig {",
    "  event: string;",
    "  matcher?: string;",
    "  run: string;",
    "  type?: string;",
    "  timeout?: number;",
    "}",
    "",
    "// ---------------------------------------------------------------------------",
    "// MCP server configuration",
    "// ---------------------------------------------------------------------------",
    "",
    "export interface McpServerConfig {",
    "  name: string;",
    "  command?: string;",
    "  args?: string[];",
    "  env?: Record<string, string>;",
    "  url?: string;",
    "}",
    "",
    "// ---------------------------------------------------------------------------",
    "// Output format configuration",
    "// ---------------------------------------------------------------------------",
    "",
    "export interface OutputFormatConfig {",
    "  type: string;",
    "  schema?: Record<string, unknown>;",
    "}",
    "",
    "// ---------------------------------------------------------------------------",
    "// Group chat configuration",
    "// ---------------------------------------------------------------------------",
    "",
    "export interface GroupChatConfig {",
    "  id: string;",
    "  members: string[];",
    "  speakerSelection: string;",
    "  maxRounds: number;",
    "  termination?: string;",
    "  timeout?: number;",
    "  description?: string;",
    "}",
    "",
    "export interface GroupResult {",
    "  messages: Array<{ role: string; content: string; agentId?: string; timestamp: number }>;",
    "  finalOutput: string;",
    "  totalTokens: { input: number; output: number };",
    "  rounds: number;",
    "}",
    "",
    "// ---------------------------------------------------------------------------",
    "// Human node configuration",
    "// ---------------------------------------------------------------------------",
    "",
    "export interface HumanNodeConfig {",
    "  id: string;",
    "  description?: string;",
    "  timeout?: number;",
    "  onTimeout?: string;",
    "}",
    "",
    "export interface HumanResult {",
    "  input: string;",
    "  timedOut: boolean;",
    "}",
    "",
    "// ---------------------------------------------------------------------------",
    "// Action node configuration",
    "// ---------------------------------------------------------------------------",
    "",
    "export interface ActionNodeConfig {",
    "  id: string;",
    "  kind?: string;",
    "  source?: string;",
    "  commands: string[];",
    "  timeout?: number;",
    "  onFail?: string;",
    "}",
    "",
    "export interface ActionResult {",
    "  stdout: string;",
    "  stderr: string;",
    "  exitCode: number;",
    "  error?: string;",
    "}",
    "",
    "// ---------------------------------------------------------------------------",
    "// Gate configuration",
    "// ---------------------------------------------------------------------------",
    "",
    "export interface GateConfig {",
    "  id: string;",
    "  after?: string;",
    "  before?: string;",
    "  run?: string;",
    "  checks?: string[];",
    "  retry?: number;",
    "  onFail?: string;",
    "  behavior?: string;",
    "  timeout?: number;",
    "}",
    "",
    "export interface GateResult {",
    "  passed: boolean;",
    "  output: string;",
    "  exitCode: number;",
    "}",
    "",
    "// ---------------------------------------------------------------------------",
    "// Circuit breaker",
    "// ---------------------------------------------------------------------------",
    "",
    "export interface CircuitBreakerConfig {",
    "  threshold: number;",
    "  window: number;",
    "  cooldown: number;",
    "}",
    "",
    "export interface CircuitBreakerState {",
    '  state: "closed" | "open" | "half-open";',
    "  failureCount: number;",
    "  lastFailure: number;",
    "  nextAttempt: number;",
    "}",
    "",
    "// ---------------------------------------------------------------------------",
    "// Checkpoint",
    "// ---------------------------------------------------------------------------",
    "",
    "export interface CheckpointState {",
    "  nodeId: string;",
    "  result: AgentResult | ActionResult | GateResult | GroupResult | HumanResult;",
    "  timestamp: number;",
    "}",
    "",
    "export interface CheckpointData {",
    "  topologyName: string;",
    "  runId: string;",
    "  states: CheckpointState[];",
    "  createdAt: number;",
    "  updatedAt: number;",
    "}",
    "",
    "// ---------------------------------------------------------------------------",
    "// Observability",
    "// ---------------------------------------------------------------------------",
    "",
    "export interface ObservabilitySpan {",
    "  traceId: string;",
    "  spanId: string;",
    "  parentSpanId?: string;",
    "  name: string;",
    "  startTime: number;",
    "  endTime?: number;",
    "  attributes: Record<string, string | number | boolean>;",
    "}",
    "",
    "export interface ObservabilityConfig {",
    "  enabled: boolean;",
    "  exporter: string;",
    "  endpoint?: string;",
    "  service?: string;",
    "  sampleRate: number;",
    "  capture: {",
    "    prompts: boolean;",
    "    completions: boolean;",
    "    toolArgs: boolean;",
    "    toolResults: boolean;",
    "  };",
    "}",
    "",
    "// ---------------------------------------------------------------------------",
    "// Prompt variants",
    "// ---------------------------------------------------------------------------",
    "",
    "export interface PromptVariant {",
    "  id: string;",
    "  prompt?: string;",
    "  weight: number;",
    "  temperature?: number;",
    "  model?: string;",
    "}",
    "",
    "export interface VariantSelection {",
    "  variantId: string;",
    "  prompt: string;",
    "  temperature?: number;",
    "  model?: string;",
    "}",
    "",
    "// ---------------------------------------------------------------------------",
    "// Edge / routing",
    "// ---------------------------------------------------------------------------",
    "",
    "export interface EdgeRoute {",
    "  from: string;",
    "  to: string;",
    "  condition?: (result: AgentResult) => boolean;",
    "  isError?: boolean;",
    "  errorType?: string;",
    "  weight?: number;",
    "  race?: boolean;",
    "  maxIterations?: number;",
    "  wait?: number;",
    "}",
    "",
    "// ---------------------------------------------------------------------------",
    "// Topology runtime config",
    "// ---------------------------------------------------------------------------",
    "",
    "export interface TopologyConfig {",
    "  name: string;",
    "  version: string;",
    "  agents: Record<string, AgentQueryConfig>;",
    "  groups: Record<string, GroupChatConfig>;",
    "  humans: Record<string, HumanNodeConfig>;",
    "  actions: Record<string, ActionNodeConfig>;",
    "  gates: Record<string, GateConfig>;",
    "  edges: EdgeRoute[];",
    "  entryPoints: string[];",
    "  memory: MemoryStore;",
    "  observability?: ObservabilityConfig;",
    "  checkpoint?: {",
    "    backend: string;",
    "    strategy: string;",
    "    ttl?: number;",
    "  };",
    "}",
    "",
  ];

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Memory system generator
// ---------------------------------------------------------------------------

function generateMemory(): string {
  return `/**
 * File-based memory store.
 * Auto-generated by agentopology scaffold — edit as needed.
 */

import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import type { MemoryStore } from "./types.js";

export class FileMemory implements MemoryStore {
  constructor(private basePath: string = "./.memory") {}

  private resolvePath(key: string): string {
    const parts = key.split(".");
    const filename = parts.pop()! + ".md";
    return join(this.basePath, ...parts, filename);
  }

  async read(key: string): Promise<string | null> {
    const path = this.resolvePath(key);
    try {
      return await readFile(path, "utf-8");
    } catch {
      return null;
    }
  }

  async write(key: string, value: string): Promise<void> {
    const path = this.resolvePath(key);
    const dir = dirname(path);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    await writeFile(path, value, "utf-8");
  }

  async list(prefix?: string): Promise<string[]> {
    const dir = prefix
      ? join(this.basePath, ...prefix.split("."))
      : this.basePath;
    try {
      const entries = await readdir(dir, { recursive: true });
      return entries
        .filter((e) => typeof e === "string" && e.endsWith(".md"))
        .map((e) => {
          const withoutExt = (e as string).replace(/\\.md$/, "");
          const key = withoutExt.replace(/[\\/\\\\]/g, ".");
          return prefix ? \`\${prefix}.\${key}\` : key;
        });
    } catch {
      return [];
    }
  }
}
`;
}

// ---------------------------------------------------------------------------
// Agent runner generator — wraps query() for each agent
// ---------------------------------------------------------------------------

function generateAgentRunner(): string {
  return `/**
 * Agent runner — executes a single agent via the Claude Agent SDK query() call.
 * Auto-generated by agentopology scaffold — edit as needed.
 *
 * Unlike the Anthropic Messages API binding, there is NO manual tool loop here.
 * The SDK's query() handles tool execution, subagent delegation, and conversation
 * management internally. Each agent is a single query() call.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentQueryConfig,
  AgentResult,
  MemoryStore,
} from "./types.js";

// Import custom MCP tools if the topology defines a tools {} block.
// This is a conditional import — the file may not exist if no tools are defined.
let customToolsServer: unknown | undefined;
try {
  const mod = await import("./custom-tools.js");
  customToolsServer = mod.customTools;
} catch {
  // No custom tools defined — this is expected.
}

/**
 * Execute an agent via the Claude Agent SDK query() call.
 *
 * This is fundamentally simpler than the Anthropic Messages API binding:
 * - No manual tool loop (query() handles it)
 * - No tool definitions needed (Read, Write, Bash, etc. are built-in)
 * - Native subagent delegation via options.agents
 * - Native hooks via options.hooks
 * - Native MCP via options.mcpServers
 */
export async function executeAgent(
  config: AgentQueryConfig,
  input: string,
  memory: MemoryStore,
): Promise<AgentResult> {
  const startTime = Date.now();

  // Inject memory context into the prompt
  let systemPrompt = config.systemPrompt;
  if (config.memoryReads?.length) {
    const memoryContext: string[] = [];
    for (const key of config.memoryReads) {
      const value = await memory.read(key);
      if (value) {
        memoryContext.push(\`## Memory: \${key}\\n\${value}\`);
      }
    }
    if (memoryContext.length) {
      systemPrompt += "\\n\\n# Available Memory\\n\\n" + memoryContext.join("\\n\\n");
    }
  }

  // Build query options
  const options: Record<string, unknown> = {
    model: config.model,
    // Use appendSystemPrompt instead of systemPrompt to preserve the SDK's
    // built-in system prompt (which teaches Claude how to use Read, Write,
    // Edit, Bash, etc.). Our agent-specific prompt is appended on top.
    appendSystemPrompt: systemPrompt,
    maxTurns: config.maxTurns,
    permissionMode: config.permissionMode,
    // settingSources tells the SDK to auto-load project-level configuration:
    //   - .claude/skills/   (our generated skills)
    //   - CLAUDE.md         (our generated context)
    //   - .claude/commands/ (our generated commands)
    settingSources: ["project"],
  };

  // Allowed / disallowed tools
  if (config.allowedTools?.length) {
    options.allowedTools = config.allowedTools;
  }
  if (config.disallowedTools?.length) {
    options.disallowedTools = config.disallowedTools;
  }

  // Sandbox
  if (config.sandbox !== undefined) {
    options.sandbox = config.sandbox;
  }

  // Thinking / extended reasoning
  if (config.thinking) {
    options.thinking = config.thinking;
  }

  // Output format — use the SDK's native JsonSchemaOutputFormat when available.
  // The SDK accepts { type: "json_schema", schema: <JSON Schema object> } in
  // the output option, which constrains the model's output to valid JSON
  // matching the provided schema.
  if (config.outputFormat) {
    if (config.outputFormat.type === "json_schema" && config.outputFormat.schema) {
      options.output = {
        type: "json_schema",
        schema: config.outputFormat.schema,
      };
    } else {
      options.outputFormat = config.outputFormat;
    }
  }

  // Skills
  if (config.skills?.length) {
    options.skills = config.skills;
  }

  // MCP servers
  if (config.mcpServers?.length) {
    const mcpConfig: Record<string, Record<string, unknown>> = {};
    for (const mcp of config.mcpServers) {
      mcpConfig[mcp.name] = {};
      if (mcp.command) mcpConfig[mcp.name].command = mcp.command;
      if (mcp.args) mcpConfig[mcp.name].args = mcp.args;
      if (mcp.env) mcpConfig[mcp.name].env = mcp.env;
      if (mcp.url) mcpConfig[mcp.name].url = mcp.url;
    }
    options.mcpServers = mcpConfig;
  }

  // Custom MCP tools — add the topology-level tools server if available
  if (customToolsServer) {
    const mcpConfig = (options.mcpServers as Record<string, unknown>) || {};
    mcpConfig["topology-tools"] = customToolsServer;
    options.mcpServers = mcpConfig;
  }

  // Hooks — compile HookConfig[] into SDK hook callbacks
  if (config.hooks?.length) {
    const hooks: Record<string, Array<Record<string, unknown>>> = {};
    for (const hook of config.hooks) {
      if (!hooks[hook.event]) hooks[hook.event] = [];
      const entry: Record<string, unknown> = {};
      if (hook.matcher) entry.matcher = hook.matcher;
      entry.hooks = [\`async (input: unknown, toolUseID: string, ctx: { signal: AbortSignal }) => {
        // Hook: \\\${hook.run}
        const { exec } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execAsync = promisify(exec);
        try {
          await execAsync(hook.run, { timeout: \\\${hook.timeout || 30000}, signal: ctx.signal });
          return undefined; // allow
        } catch {
          return { decision: "deny", reason: "Hook command failed: " + hook.run };
        }
      }\`];
      hooks[hook.event].push(entry);
    }
    options.hooks = hooks;
  }

  // Subagents
  if (config.subagents && Object.keys(config.subagents).length) {
    options.agents = config.subagents;
  }

  // Background / isolation (Agent tool configuration)
  if (config.background) {
    options.runInBackground = true;
  }
  if (config.isolation === "worktree") {
    // Use the SDK's native EnterWorktree/ExitWorktree tools for git worktree
    // isolation. The SDK handles worktree creation and cleanup automatically —
    // no need to generate manual git worktree commands.
    const currentTools = (options.allowedTools as string[] | undefined) || [];
    options.allowedTools = [...currentTools, "EnterWorktree", "ExitWorktree"];
  }

  try {
    // Execute the query — this is the entire agent execution.
    // No tool loop needed; the SDK handles everything.
    const result: string[] = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    // AbortController for timeout
    let controller: AbortController | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (config.timeout) {
      controller = new AbortController();
      timeoutId = setTimeout(() => controller!.abort(), config.timeout);
      options.signal = controller.signal;
    }

    try {
      for await (const message of query({
        prompt: input,
        options,
      })) {
        if (typeof message === "string") {
          result.push(message);
        } else if (message && typeof message === "object") {
          // Extract usage if available
          const msg = message as Record<string, unknown>;
          if (msg.usage && typeof msg.usage === "object") {
            const usage = msg.usage as Record<string, number>;
            totalInputTokens += usage.input_tokens || 0;
            totalOutputTokens += usage.output_tokens || 0;
          }
          if (msg.result && typeof msg.result === "string") {
            result.push(msg.result);
          } else if (msg.content && typeof msg.content === "string") {
            result.push(msg.content);
          }
        }
      }
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }

    const output = result.join("\\n");

    // Write memory if configured
    if (config.memoryWrites?.length && output) {
      for (const key of config.memoryWrites) {
        await memory.write(key, output);
      }
    }

    return {
      agentId: config.id,
      output,
      tokenUsage: { input: totalInputTokens, output: totalOutputTokens },
      durationMs: Date.now() - startTime,
    };
  } catch (err) {
    return {
      agentId: config.id,
      output: "",
      tokenUsage: { input: 0, output: 0 },
      durationMs: Date.now() - startTime,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
`;
}

// ---------------------------------------------------------------------------
// Group executor generator
// ---------------------------------------------------------------------------

function generateGroupExecutor(): string {
  return `/**
 * Group chat executor — multi-agent conversation via query() calls.
 * Auto-generated by agentopology scaffold — edit as needed.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { executeAgent } from "./runner.js";
import type {
  AgentQueryConfig,
  GroupChatConfig,
  GroupResult,
  MemoryStore,
} from "./types.js";

/**
 * Select the next speaker based on the strategy.
 */
async function selectSpeaker(
  groupConfig: GroupChatConfig,
  agentConfigs: Record<string, AgentQueryConfig>,
  conversationHistory: Array<{ role: string; content: string; agentId?: string; timestamp: number }>,
  round: number,
): Promise<string> {
  const strategy = groupConfig.speakerSelection || "round-robin";
  const members = groupConfig.members;

  switch (strategy) {
    case "round-robin":
      return members[round % members.length];

    case "random":
      return members[Math.floor(Math.random() * members.length)];

    case "model-selected": {
      const historyText = conversationHistory
        .map((m) => \`[\${m.agentId || "user"}]: \${m.content}\`)
        .join("\\n");

      // Use a lightweight query to pick the next speaker
      const result: string[] = [];
      for await (const message of query({
        prompt: \`Available members: \${members.join(", ")}\\n\\nConversation so far:\\n\${historyText}\\n\\nWho should speak next? Respond with ONLY the member id.\`,
        options: {
          model: "haiku",
          maxTurns: 1,
          appendSystemPrompt: "You are a conversation moderator. Pick the next speaker. Respond with ONLY the member id, nothing else.",
        },
      })) {
        if (typeof message === "string") result.push(message);
        else if (message && typeof message === "object") {
          const msg = message as Record<string, unknown>;
          if (msg.result && typeof msg.result === "string") result.push(msg.result);
          else if (msg.content && typeof msg.content === "string") result.push(msg.content);
        }
      }

      const selected = result.join("").trim();
      if (members.includes(selected)) return selected;
      return members[round % members.length];
    }

    default:
      return members[round % members.length];
  }
}

/**
 * Execute a group chat — multi-agent conversation with speaker selection.
 */
export async function executeGroup(
  groupConfig: GroupChatConfig,
  agentConfigs: Record<string, AgentQueryConfig>,
  input: string,
  memory: MemoryStore,
): Promise<GroupResult> {
  const conversationHistory: Array<{ role: string; content: string; agentId?: string; timestamp: number }> = [
    { role: "user", content: input, timestamp: Date.now() },
  ];

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  const maxRounds = groupConfig.maxRounds || 10;
  let finalOutput = "";

  for (let round = 0; round < maxRounds; round++) {
    const speakerId = await selectSpeaker(groupConfig, agentConfigs, conversationHistory, round);
    const agentConfig = agentConfigs[speakerId];

    if (!agentConfig) {
      console.warn(\`Group member "\${speakerId}" not found in agent configs, skipping.\`);
      continue;
    }

    const historyText = conversationHistory
      .map((m) => \`[\${m.agentId || "user"}]: \${m.content}\`)
      .join("\\n\\n");

    const agentInput = \`You are participating in a group discussion.\\n\\nConversation so far:\\n\${historyText}\\n\\nPlease provide your response.\`;

    const result = await executeAgent(agentConfig, agentInput, memory);

    totalInputTokens += result.tokenUsage.input;
    totalOutputTokens += result.tokenUsage.output;

    conversationHistory.push({
      role: "assistant",
      content: result.output,
      agentId: agentConfig.id,
      timestamp: Date.now(),
    });

    finalOutput = result.output;

    if (groupConfig.termination && result.output.includes(groupConfig.termination)) {
      break;
    }
  }

  return {
    messages: conversationHistory,
    finalOutput,
    totalTokens: { input: totalInputTokens, output: totalOutputTokens },
    rounds: conversationHistory.filter((m) => m.role === "assistant").length,
  };
}
`;
}

// ---------------------------------------------------------------------------
// Human executor generator
// ---------------------------------------------------------------------------

function generateHumanExecutor(): string {
  return `/**
 * Human-in-the-loop executor — uses the SDK's native AskUserQuestion tool.
 * Auto-generated by agentopology scaffold — edit as needed.
 *
 * Instead of a readline-based terminal prompt, we run a lightweight query()
 * call with AskUserQuestion enabled. The SDK handles the user interaction
 * natively (terminal prompt, timeout, etc.).
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { HumanNodeConfig, HumanResult } from "./types.js";

/**
 * Prompt the user for input via the SDK's AskUserQuestion tool.
 * Supports timeout and on-timeout behavior (halt/skip/fallback).
 */
export async function executeHuman(
  config: HumanNodeConfig,
): Promise<HumanResult> {
  const description = config.description || "Please provide your input";

  // Build query options with AskUserQuestion enabled
  const options: Record<string, unknown> = {
    model: "haiku",
    maxTurns: 2,
    appendSystemPrompt: "You are a human-input collector. Use the AskUserQuestion tool to ask the user the following question, then return their exact response verbatim. Do not add commentary.",
    allowedTools: ["AskUserQuestion"],
    permissionMode: "bypassPermissions",
  };

  // AbortController for timeout
  let controller: AbortController | undefined;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  if (config.timeout) {
    controller = new AbortController();
    timeoutId = setTimeout(() => controller!.abort(), config.timeout);
    options.signal = controller.signal;
  }

  try {
    const result: string[] = [];
    try {
      for await (const message of query({
        prompt: \`Ask the user: \${description}\`,
        options,
      })) {
        if (typeof message === "string") {
          result.push(message);
        } else if (message && typeof message === "object") {
          const msg = message as Record<string, unknown>;
          if (msg.result && typeof msg.result === "string") result.push(msg.result);
          else if (msg.content && typeof msg.content === "string") result.push(msg.content);
        }
      }
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }

    return { input: result.join("\\n").trim(), timedOut: false };
  } catch (err) {
    // Handle timeout (AbortError)
    const isTimeout = err instanceof Error && err.name === "AbortError";
    if (isTimeout) {
      const behavior = config.onTimeout || "halt";

      if (behavior === "skip") {
        return { input: "", timedOut: true };
      } else if (behavior.startsWith("fallback ")) {
        const fallbackId = behavior.slice("fallback ".length);
        return { input: \`__FALLBACK__:\${fallbackId}\`, timedOut: true };
      } else {
        // halt — return empty with timedOut flag
        return { input: "", timedOut: true };
      }
    }

    // Non-timeout error — treat as empty input
    return { input: "", timedOut: false };
  }
}
`;
}

// ---------------------------------------------------------------------------
// Action executor generator
// ---------------------------------------------------------------------------

function generateActionExecutor(): string {
  return `/**
 * Action executor — runs shell commands.
 * Auto-generated by agentopology scaffold — edit as needed.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ActionNodeConfig, ActionResult } from "./types.js";

const execAsync = promisify(exec);

/**
 * Execute an action's shell commands.
 */
export async function executeAction(
  config: ActionNodeConfig,
): Promise<ActionResult> {
  const commands = config.commands;
  if (!commands.length) {
    return { stdout: "", stderr: "", exitCode: 0 };
  }

  const combinedCommand = commands.join(" && ");

  try {
    const { stdout, stderr } = await execAsync(combinedCommand, {
      timeout: config.timeout || 30_000,
    });

    return {
      stdout: stdout || "",
      stderr: stderr || "",
      exitCode: 0,
    };
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; code?: number; message?: string };
    return {
      stdout: execErr.stdout || "",
      stderr: execErr.stderr || "",
      exitCode: execErr.code || 1,
      error: execErr.message || String(err),
    };
  }
}
`;
}

// ---------------------------------------------------------------------------
// Observability generator
// ---------------------------------------------------------------------------

function generateObservability(): string {
  return `/**
 * Observability — telemetry via hooks for topology execution.
 * Auto-generated by agentopology scaffold — edit as needed.
 *
 * The Claude Agent SDK supports hooks for PreToolUse and PostToolUse,
 * which can be used to emit OpenTelemetry-style spans.
 */

import type { ObservabilitySpan, ObservabilityConfig } from "./types.js";

function generateId(): string {
  return Math.random().toString(36).slice(2, 14) + Math.random().toString(36).slice(2, 14);
}

export class Tracer {
  private spans: ObservabilitySpan[] = [];
  private traceId: string;

  constructor(private config: ObservabilityConfig) {
    this.traceId = generateId();
  }

  private shouldSample(): boolean {
    return Math.random() < this.config.sampleRate;
  }

  startSpan(name: string, parentSpanId?: string): ObservabilitySpan {
    const span: ObservabilitySpan = {
      traceId: this.traceId,
      spanId: generateId(),
      parentSpanId,
      name,
      startTime: Date.now(),
      attributes: {},
    };
    return span;
  }

  endSpan(span: ObservabilitySpan): void {
    span.endTime = Date.now();
    if (!this.shouldSample()) return;
    this.spans.push(span);
    this.exportSpan(span);
  }

  private exportSpan(span: ObservabilitySpan): void {
    const exporter = this.config.exporter;

    switch (exporter) {
      case "stdout":
        console.log(JSON.stringify(span));
        break;

      case "otlp":
        if (this.config.endpoint) {
          fetch(this.config.endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              resourceSpans: [{
                resource: { attributes: [{ key: "service.name", value: { stringValue: this.config.service || "topology" } }] },
                scopeSpans: [{ spans: [span] }],
              }],
            }),
          }).catch(() => {});
        }
        break;

      case "none":
      default:
        break;
    }
  }

  getSpans(): ObservabilitySpan[] {
    return [...this.spans];
  }

  reset(): void {
    this.traceId = generateId();
    this.spans = [];
  }
}
`;
}

// ---------------------------------------------------------------------------
// Checkpoint generator
// ---------------------------------------------------------------------------

function generateCheckpoint(): string {
  return `/**
 * Checkpoint — session resume/fork for durable execution.
 * Auto-generated by agentopology scaffold — edit as needed.
 *
 * The Claude Agent SDK supports native session resume/fork via:
 * - enableFileCheckpointing: true
 * - resume / forkSession options
 * - Query.rewindFiles() for rollback
 *
 * This module provides a polyfill for topology-level checkpoint state.
 */

import { readFile, writeFile, readdir, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { CheckpointData, CheckpointState } from "./types.js";

export class CheckpointManager {
  private basePath: string;
  private strategy: string;
  private ttl: number | undefined;

  constructor(options: { backend: string; strategy: string; ttl?: number }) {
    this.basePath = ".checkpoint";
    this.strategy = options.strategy || "per-node";
    this.ttl = options.ttl;
  }

  private getFilePath(runId: string): string {
    return join(this.basePath, \`\${runId}.json\`);
  }

  async save(runId: string, topologyName: string, state: CheckpointState): Promise<void> {
    if (!existsSync(this.basePath)) {
      await mkdir(this.basePath, { recursive: true });
    }

    const filePath = this.getFilePath(runId);
    let data: CheckpointData;

    try {
      const existing = await readFile(filePath, "utf-8");
      data = JSON.parse(existing) as CheckpointData;
    } catch {
      data = {
        topologyName,
        runId,
        states: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    }

    data.states.push(state);
    data.updatedAt = Date.now();

    await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
  }

  async load(runId: string): Promise<CheckpointData | null> {
    const filePath = this.getFilePath(runId);
    try {
      const content = await readFile(filePath, "utf-8");
      return JSON.parse(content) as CheckpointData;
    } catch {
      return null;
    }
  }

  async getCompletedNodes(runId: string): Promise<Set<string>> {
    const data = await this.load(runId);
    if (!data) return new Set();
    return new Set(data.states.map((s) => s.nodeId));
  }

  shouldSaveAfterNode(): boolean {
    return this.strategy === "per-node";
  }

  shouldSaveAfterPhase(): boolean {
    return this.strategy === "per-phase";
  }

  async cleanup(): Promise<void> {
    if (!this.ttl) return;
    if (!existsSync(this.basePath)) return;

    const now = Date.now();
    const files = await readdir(this.basePath);

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const filePath = join(this.basePath, file);
      try {
        const content = await readFile(filePath, "utf-8");
        const data = JSON.parse(content) as CheckpointData;
        if (now - data.updatedAt > this.ttl) {
          await rm(filePath);
        }
      } catch {
        // Skip files that can't be parsed
      }
    }
  }
}
`;
}

// ---------------------------------------------------------------------------
// Scheduler generator
// ---------------------------------------------------------------------------

function generateScheduler(): string {
  return `/**
 * Scheduler — cron-like job scheduling for topology agents and actions.
 * Auto-generated by agentopology scaffold — edit as needed.
 */

function parseEvery(every: string): number {
  const match = every.match(/^(\\d+(?:\\.\\d+)?)\\s*(ms|s|m|h|d)$/);
  if (!match) return 60_000;
  const value = parseFloat(match[1]);
  switch (match[2]) {
    case "ms": return value;
    case "s": return value * 1000;
    case "m": return value * 60_000;
    case "h": return value * 3_600_000;
    case "d": return value * 86_400_000;
    default: return value * 1000;
  }
}

function parseCronToInterval(cron: string): number {
  const parts = cron.trim().split(/\\s+/);
  if (parts.length < 5) return 60_000;
  if (parts[0] !== "*" && parts.slice(1).every((p) => p === "*")) {
    return 3_600_000;
  }
  return 60_000;
}

export interface ScheduledJob {
  id: string;
  interval: number;
  handler: () => Promise<void>;
  timer?: ReturnType<typeof setInterval>;
}

export class Scheduler {
  private jobs: Map<string, ScheduledJob> = new Map();

  addEveryJob(id: string, every: string, handler: () => Promise<void>): void {
    const interval = parseEvery(every);
    this.jobs.set(id, { id, interval, handler });
  }

  addCronJob(id: string, cron: string, handler: () => Promise<void>): void {
    const interval = parseCronToInterval(cron);
    this.jobs.set(id, { id, interval, handler });
  }

  start(): void {
    for (const [id, job] of this.jobs) {
      job.timer = setInterval(async () => {
        try {
          await job.handler();
        } catch (err) {
          console.error(\`Scheduled job "\${id}" failed:\`, err);
        }
      }, job.interval);
      console.log(\`Scheduler: started job "\${id}" (every \${job.interval}ms)\`);
    }
  }

  stop(): void {
    for (const [, job] of this.jobs) {
      if (job.timer) {
        clearInterval(job.timer);
        job.timer = undefined;
      }
    }
  }
}
`;
}

// ---------------------------------------------------------------------------
// Rate limiter generator
// ---------------------------------------------------------------------------

function generateRateLimiter(): string {
  return `/**
 * Rate limiter — token bucket rate limiting for API calls.
 * Auto-generated by agentopology scaffold — edit as needed.
 */

function parseRateLimit(expr: string): { tokens: number; intervalMs: number } {
  const match = expr.match(/^(\\d+)\\/(sec|min|hour|day)$/);
  if (!match) return { tokens: 60, intervalMs: 60_000 };

  const tokens = parseInt(match[1], 10);
  let intervalMs: number;

  switch (match[2]) {
    case "sec": intervalMs = 1000; break;
    case "min": intervalMs = 60_000; break;
    case "hour": intervalMs = 3_600_000; break;
    case "day": intervalMs = 86_400_000; break;
    default: intervalMs = 60_000;
  }

  return { tokens, intervalMs };
}

export class RateLimiter {
  private tokens: number;
  private maxTokens: number;
  private refillInterval: number;
  private lastRefill: number;

  constructor(rateExpr: string) {
    const { tokens, intervalMs } = parseRateLimit(rateExpr);
    this.maxTokens = tokens;
    this.tokens = tokens;
    this.refillInterval = intervalMs;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const periods = Math.floor(elapsed / this.refillInterval);
    if (periods > 0) {
      this.tokens = Math.min(this.maxTokens, this.tokens + periods * this.maxTokens);
      this.lastRefill += periods * this.refillInterval;
    }
  }

  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens > 0) {
      this.tokens--;
      return;
    }
    const waitTime = this.refillInterval - (Date.now() - this.lastRefill);
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, waitTime)));
    this.refill();
    this.tokens--;
  }
}
`;
}

// ---------------------------------------------------------------------------
// Variant selector generator
// ---------------------------------------------------------------------------

function generateVariantSelector(): string {
  return `/**
 * Prompt variant selector — weighted random selection for A/B testing.
 * Auto-generated by agentopology scaffold — edit as needed.
 */

import type { PromptVariant, VariantSelection } from "./types.js";

export function selectVariant(
  variants: PromptVariant[],
  defaultPrompt: string,
): VariantSelection {
  if (!variants.length) {
    return { variantId: "default", prompt: defaultPrompt };
  }

  const totalWeight = variants.reduce((sum, v) => sum + v.weight, 0);
  let random = Math.random() * totalWeight;

  for (const variant of variants) {
    random -= variant.weight;
    if (random <= 0) {
      return {
        variantId: variant.id,
        prompt: variant.prompt || defaultPrompt,
        temperature: variant.temperature,
        model: variant.model,
      };
    }
  }

  const last = variants[variants.length - 1];
  return {
    variantId: last.id,
    prompt: last.prompt || defaultPrompt,
    temperature: last.temperature,
    model: last.model,
  };
}
`;
}

// ---------------------------------------------------------------------------
// Orchestrator generator
// ---------------------------------------------------------------------------

function generateOrchestrator(ast: TopologyAST): string {
  const agents = ast.nodes.filter((n): n is AgentNode => n.type === "agent");
  const gates = ast.nodes.filter((n): n is GateNode => n.type === "gate");
  const actions = ast.nodes.filter((n): n is ActionNode => n.type === "action");
  const groups = ast.nodes.filter((n): n is GroupNode => n.type === "group");
  const humans = ast.nodes.filter((n): n is HumanNode => n.type === "human");

  // Find entry points: nodes with no incoming edges
  const targets = new Set(ast.edges.map((e) => e.to));
  const entryPoints = agents.filter((a) => !targets.has(a.id));

  // Generate condition functions for edges
  const conditionFns: string[] = [];
  for (const edge of ast.edges) {
    if (edge.condition) {
      const fnName = `condition_${edge.from}_to_${edge.to}`.replace(/-/g, "_");
      conditionFns.push(
        `function ${fnName}(result: AgentResult): boolean {\n` +
        `  // Condition: ${escapeString(edge.condition)}\n` +
        `  return result.output.toLowerCase().includes("${escapeQuotes(edge.condition.toLowerCase())}");\n` +
        `}`,
      );
    }
  }

  // Generate edge routes
  const edgeRoutes: string[] = [];
  for (const edge of ast.edges) {
    const parts = [`    { from: "${edge.from}", to: "${edge.to}"`];
    if (edge.condition) {
      const fnName = `condition_${edge.from}_to_${edge.to}`.replace(/-/g, "_");
      parts.push(`condition: ${fnName}`);
    }
    if (edge.isError) parts.push(`isError: true`);
    if (edge.errorType) parts.push(`errorType: "${edge.errorType}"`);
    if (edge.weight !== undefined) parts.push(`weight: ${edge.weight}`);
    if (edge.race) parts.push(`race: true`);
    if (edge.maxIterations !== undefined && edge.maxIterations !== null) parts.push(`maxIterations: ${edge.maxIterations}`);
    if (edge.wait) parts.push(`wait: ${durationToMs(edge.wait)}`);
    edgeRoutes.push(parts.join(", ") + " },");
  }

  // Generate agent configs
  const agentConfigs: string[] = [];
  for (const agent of agents) {
    const model = mapModel(agent.model);
    const prompt = agent.prompt
      ? escapeString(agent.prompt)
      : `You are ${toTitle(agent.id)}. ${agent.description || agent.role || "Complete the assigned task."}`;
    const permMode = mapPermission(agent.permissions);

    const parts: string[] = [
      `    "${agent.id}": {`,
      `      id: "${agent.id}",`,
      `      model: "${model}",`,
      `      systemPrompt: \`${prompt}\`,`,
      `      permissionMode: "${permMode}",`,
      `      maxTurns: ${agent.maxTurns || 10},`,
    ];

    // Allowed tools — these are built-in tool names for the SDK
    if (agent.tools?.length) {
      parts.push(`      allowedTools: ${JSON.stringify(agent.tools)},`);
    }
    if (agent.disallowedTools?.length) {
      parts.push(`      disallowedTools: ${JSON.stringify(agent.disallowedTools)},`);
    }

    // Skills
    if (agent.skills?.length) {
      parts.push(`      skills: ${JSON.stringify(agent.skills)},`);
    }

    // Description (for subagent delegation)
    if (agent.description) {
      parts.push(`      description: "${escapeQuotes(agent.description)}",`);
    }

    // Sandbox
    if (agent.sandbox !== undefined) {
      if (typeof agent.sandbox === "boolean") {
        parts.push(`      sandbox: ${agent.sandbox},`);
      } else {
        parts.push(`      sandbox: "${agent.sandbox}",`);
      }
    }

    // Background / isolation
    if (agent.background) parts.push(`      background: true,`);
    if (agent.isolation) parts.push(`      isolation: "${agent.isolation}",`);

    // Thinking — native SDK support
    const thinkingConfig = mapThinking(agent.thinking, agent.thinkingBudget);
    if (thinkingConfig) {
      parts.push(`      thinking: ${thinkingConfig},`);
    }

    // Output format — native SDK support
    if (agent.outputFormat) {
      if (agent.outputFormat === "json-schema" && agent.outputSchema?.length) {
        parts.push(`      outputFormat: { type: "json_schema", schema: ${fieldsToJsonSchema(agent.outputSchema)} },`);
      } else if (agent.outputFormat === "json") {
        parts.push(`      outputFormat: { type: "json" },`);
      }
    }

    // MCP servers
    if (agent.mcpServers?.length) {
      const mcpConfigs: string[] = [];
      for (const mcpName of agent.mcpServers) {
        const mcpConfig = ast.mcpServers[mcpName];
        if (mcpConfig) {
          const mcpParts: string[] = [`name: "${mcpName}"`];
          if (mcpConfig.command) mcpParts.push(`command: "${escapeQuotes(String(mcpConfig.command))}"`);
          if (mcpConfig.args) mcpParts.push(`args: ${JSON.stringify(mcpConfig.args)}`);
          if (mcpConfig.url) mcpParts.push(`url: "${escapeQuotes(String(mcpConfig.url))}"`);
          mcpConfigs.push(`{ ${mcpParts.join(", ")} }`);
        } else {
          mcpConfigs.push(`{ name: "${mcpName}" }`);
        }
      }
      parts.push(`      mcpServers: [${mcpConfigs.join(", ")}],`);
    }

    // Hooks — compile per-agent hooks to SDK format.
    // The SDK supports 22 hook events:
    //   PreToolUse, PostToolUse, PostToolUseFailure, Notification,
    //   UserPromptSubmit, SessionStart, SessionEnd, Stop,
    //   SubagentStart, SubagentStop, PreCompact, PostCompact,
    //   PermissionRequest, Setup, TeammateIdle, TaskCompleted,
    //   Elicitation, ElicitationResult, ConfigChange,
    //   InstructionsLoaded, WorktreeCreate, WorktreeRemove
    if (agent.hooks?.length) {
      const hookEntries: string[] = [];
      for (const hook of agent.hooks) {
        const mappedEvent = mapHookEvent(hook.on);
        const hookParts: string[] = [
          `event: "${mappedEvent}"`,
        ];
        if (hook.matcher) hookParts.push(`matcher: "${escapeQuotes(hook.matcher)}"`);
        hookParts.push(`run: "${escapeQuotes(hook.run)}"`);
        if (hook.type) hookParts.push(`type: "${hook.type}"`);
        if (hook.timeout) hookParts.push(`timeout: ${hook.timeout}`);
        hookEntries.push(`{ ${hookParts.join(", ")} }`);
      }
      parts.push(`      hooks: [${hookEntries.join(", ")}],`);
    }

    // Polyfill fields
    if (agent.timeout) parts.push(`      timeout: ${durationToMs(agent.timeout)},`);
    if (agent.onFail) parts.push(`      onFail: "${escapeQuotes(agent.onFail)}",`);
    if (agent.skip) parts.push(`      skip: "${escapeQuotes(agent.skip)}",`);
    if (agent.phase !== undefined) parts.push(`      phase: ${agent.phase},`);
    if (agent.rateLimit) parts.push(`      rateLimit: "${agent.rateLimit}",`);
    if (agent.compensates) parts.push(`      compensates: "${agent.compensates}",`);

    if (agent.reads?.length) parts.push(`      memoryReads: ${JSON.stringify(agent.reads)},`);
    if (agent.writes?.length) parts.push(`      memoryWrites: ${JSON.stringify(agent.writes)},`);

    if (agent.fallbackChain?.length) {
      parts.push(`      fallbackChain: ${JSON.stringify(agent.fallbackChain.map(mapModel))},`);
    }

    if (agent.retry) {
      if (typeof agent.retry === "number") {
        parts.push(`      retry: { max: ${agent.retry} },`);
      } else {
        const r = agent.retry;
        const retryParts = [`max: ${r.max}`];
        if (r.backoff) retryParts.push(`backoff: "${r.backoff}"`);
        if (r.interval) retryParts.push(`interval: ${durationToMs(r.interval)}`);
        parts.push(`      retry: { ${retryParts.join(", ")} },`);
      }
    }

    if (agent.circuitBreaker) {
      const cb = agent.circuitBreaker;
      parts.push(`      circuitBreaker: { threshold: ${cb.threshold}, window: ${durationToMs(cb.window)}, cooldown: ${durationToMs(cb.cooldown)} },`);
    }

    if (agent.variants?.length) {
      const variantArr = agent.variants.map((v) => {
        const vParts: string[] = [`id: "${v.id}"`, `weight: ${v.weight}`];
        if (v.prompt) vParts.push(`prompt: "${escapeQuotes(v.prompt)}"`);
        if (v.temperature !== undefined) vParts.push(`temperature: ${v.temperature}`);
        if (v.model) vParts.push(`model: "${mapModel(v.model)}"`);
        return `{ ${vParts.join(", ")} }`;
      });
      parts.push(`      variants: [${variantArr.join(", ")}],`);
    }

    // Sampling params — commented out (SDK manages internally)
    if (agent.temperature !== undefined) parts.push(`      // temperature: ${agent.temperature}, // SDK manages internally`);
    if (agent.maxTokens) parts.push(`      // maxTokens: ${agent.maxTokens}, // SDK manages internally`);
    if (agent.topP !== undefined) parts.push(`      // topP: ${agent.topP}, // Not exposed by SDK`);
    if (agent.topK !== undefined) parts.push(`      // topK: ${agent.topK}, // Not exposed by SDK`);
    if (agent.stop?.length) parts.push(`      // stop: ${JSON.stringify(agent.stop)}, // Not exposed by SDK`);
    if (agent.seed !== undefined) parts.push(`      // seed: ${agent.seed}, // Not exposed by SDK`);

    parts.push("    },");
    agentConfigs.push(parts.join("\n"));
  }

  // Generate group configs
  const groupConfigs: string[] = [];
  for (const group of groups) {
    const parts: string[] = [
      `    "${group.id}": {`,
      `      id: "${group.id}",`,
      `      members: ${JSON.stringify(group.members)},`,
      `      speakerSelection: "${group.speakerSelection || "round-robin"}",`,
      `      maxRounds: ${group.maxRounds || 10},`,
    ];
    if (group.termination) parts.push(`      termination: "${escapeQuotes(group.termination)}",`);
    if (group.timeout) parts.push(`      timeout: ${durationToMs(group.timeout)},`);
    if (group.description) parts.push(`      description: "${escapeQuotes(group.description)}",`);
    parts.push("    },");
    groupConfigs.push(parts.join("\n"));
  }

  // Generate human configs
  const humanConfigs: string[] = [];
  for (const human of humans) {
    const parts: string[] = [
      `    "${human.id}": {`,
      `      id: "${human.id}",`,
    ];
    if (human.description) parts.push(`      description: "${escapeQuotes(human.description)}",`);
    if (human.timeout) parts.push(`      timeout: ${durationToMs(human.timeout)},`);
    if (human.onTimeout) parts.push(`      onTimeout: "${escapeQuotes(human.onTimeout)}",`);
    parts.push("    },");
    humanConfigs.push(parts.join("\n"));
  }

  // Generate action configs
  const actionConfigs: string[] = [];
  for (const action of actions) {
    const parts: string[] = [
      `    "${action.id}": {`,
      `      id: "${action.id}",`,
    ];
    if (action.kind) parts.push(`      kind: "${action.kind}",`);
    if (action.source) parts.push(`      source: "${escapeQuotes(action.source)}",`);
    parts.push(`      commands: ${JSON.stringify(action.commands || [])},`);
    if (action.timeout) parts.push(`      timeout: ${durationToMs(action.timeout)},`);
    if (action.onFail) parts.push(`      onFail: "${escapeQuotes(action.onFail)}",`);
    parts.push("    },");
    actionConfigs.push(parts.join("\n"));
  }

  // Generate gate configs
  const gateConfigs: string[] = [];
  for (const gate of gates) {
    const parts: string[] = [
      `    "${gate.id}": {`,
      `      id: "${gate.id}",`,
    ];
    if (gate.after) parts.push(`      after: "${gate.after}",`);
    if (gate.before) parts.push(`      before: "${gate.before}",`);
    if (gate.run) parts.push(`      run: "${escapeQuotes(gate.run)}",`);
    if (gate.checks?.length) parts.push(`      checks: ${JSON.stringify(gate.checks)},`);
    if (gate.retry) parts.push(`      retry: ${gate.retry},`);
    if (gate.onFail) parts.push(`      onFail: "${escapeQuotes(gate.onFail)}",`);
    if (gate.behavior) parts.push(`      behavior: "${gate.behavior}",`);
    if (gate.timeout) parts.push(`      timeout: ${durationToMs(gate.timeout)},`);
    parts.push("    },");
    gateConfigs.push(parts.join("\n"));
  }

  // Build observability config if present
  let observabilityConfig = "";
  if (ast.observability?.enabled) {
    const obs = ast.observability;
    observabilityConfig = `  observability: {
    enabled: true,
    exporter: "${obs.exporter}",
    ${obs.endpoint ? `endpoint: "${escapeQuotes(obs.endpoint)}",` : ""}
    ${obs.service ? `service: "${escapeQuotes(obs.service)}",` : ""}
    sampleRate: ${obs.sampleRate},
    capture: {
      prompts: ${obs.capture.prompts},
      completions: ${obs.capture.completions},
      toolArgs: ${obs.capture.toolArgs},
      toolResults: ${obs.capture.toolResults},
    },
  },`;
  }

  // Build checkpoint config if present
  let checkpointConfig = "";
  if (ast.checkpoint) {
    const cp = ast.checkpoint;
    checkpointConfig = `  checkpoint: {
    backend: "${cp.backend}",
    strategy: "${cp.strategy}",
    ${cp.ttl ? `ttl: ${durationToMs(cp.ttl)},` : ""}
  },`;
  }

  // Build defaults config
  let defaultsCode = "";
  if (ast.defaults) {
    const d = ast.defaults;
    const defaultParts: string[] = [];
    if (d.temperature !== undefined) defaultParts.push(`  temperature: ${d.temperature}`);
    if (d.maxTokens !== undefined) defaultParts.push(`  maxTokens: ${d.maxTokens}`);
    if (d.topP !== undefined) defaultParts.push(`  topP: ${d.topP}`);
    if (d.topK !== undefined) defaultParts.push(`  topK: ${d.topK}`);
    if (d.stop?.length) defaultParts.push(`  stop: ${JSON.stringify(d.stop)}`);
    if (d.seed !== undefined) defaultParts.push(`  seed: ${d.seed}`);
    if (d.thinking) defaultParts.push(`  thinking: "${d.thinking}"`);
    if (d.thinkingBudget) defaultParts.push(`  thinkingBudget: ${d.thinkingBudget}`);
    if (d.outputFormat) defaultParts.push(`  outputFormat: "${d.outputFormat}"`);
    if (d.timeout) defaultParts.push(`  timeout: ${durationToMs(d.timeout)}`);
    if (defaultParts.length) {
      defaultsCode = `\nconst defaults: Partial<AgentQueryConfig> = {\n${defaultParts.join(",\n")}\n};\n`;
    }
  }

  const hasRateLimits = agents.some((a) => a.rateLimit);
  const hasVariants = agents.some((a) => a.variants?.length);

  // Build imports
  const imports: string[] = [
    `import { executeAgent } from "./runner.js";`,
    `import { FileMemory } from "./memory.js";`,
    `import type {`,
    `  AgentQueryConfig,`,
    `  AgentResult,`,
    `  EdgeRoute,`,
    `  TopologyConfig,`,
  ];

  if (groups.length) {
    imports.push(`  GroupChatConfig,`);
    imports.push(`  GroupResult,`);
  }
  if (humans.length) {
    imports.push(`  HumanNodeConfig,`);
    imports.push(`  HumanResult,`);
  }
  if (actions.length) {
    imports.push(`  ActionNodeConfig,`);
    imports.push(`  ActionResult,`);
  }
  if (gates.length) {
    imports.push(`  GateConfig,`);
    imports.push(`  GateResult,`);
  }

  imports.push(`  CircuitBreakerState,`);
  imports.push(`} from "./types.js";`);

  if (groups.length) {
    imports.push(`import { executeGroup } from "./group-executor.js";`);
  }
  if (humans.length) {
    imports.push(`import { executeHuman } from "./human-executor.js";`);
  }
  if (actions.length) {
    imports.push(`import { executeAction } from "./action-executor.js";`);
  }
  if (ast.observability?.enabled) {
    imports.push(`import { Tracer } from "./observability.js";`);
  }
  if (ast.checkpoint) {
    imports.push(`import { CheckpointManager } from "./checkpoint.js";`);
  }
  if (hasRateLimits) {
    imports.push(`import { RateLimiter } from "./rate-limiter.js";`);
  }
  if (hasVariants) {
    imports.push(`import { selectVariant } from "./variants.js";`);
  }

  // Depth, artifacts, interface endpoints
  if (ast.depth.levels.length) {
    imports.push(`import { shouldOmitAgent, getDepthLevel } from "./depth.js";`);
  }
  if (ast.artifacts.length) {
    imports.push(`import { artifactManifest, artifactProducers, artifactConsumers, markProduced } from "./artifacts.js";`);
  }
  if (ast.interfaceEndpoints) {
    imports.push(`import { interfaceEntry, interfaceExit } from "./interface.js";`);
  }

  // Build entryPoints — use interface entry if defined
  const effectiveEntryPoints = ast.interfaceEndpoints
    ? [`"${escapeQuotes(ast.interfaceEndpoints.entry)}"`]
    : entryPoints.map((a) => `"${a.id}"`);

  return `/**
 * Topology orchestrator — manages the agent flow graph via query() calls.
 * Auto-generated by agentopology scaffold — edit as needed.
 *
 * Topology: ${ast.topology.name} v${ast.topology.version}
 * ${ast.topology.description || ""}
 *
 * Key difference from anthropic-sdk binding: each agent is a single query()
 * call to the Claude Agent SDK. No manual tool loop needed.
 */

${imports.join("\n")}

// ---------------------------------------------------------------------------
// Edge condition functions
// ---------------------------------------------------------------------------

${conditionFns.join("\n\n")}

// ---------------------------------------------------------------------------
// Topology configuration
// ---------------------------------------------------------------------------

const memory = new FileMemory();
${defaultsCode}
const config: TopologyConfig = {
  name: "${escapeQuotes(ast.topology.name)}",
  version: "${ast.topology.version || "0.1.0"}",
  agents: {
${agentConfigs.join("\n")}
  },
  groups: {
${groupConfigs.join("\n")}
  },
  humans: {
${humanConfigs.join("\n")}
  },
  actions: {
${actionConfigs.join("\n")}
  },
  gates: {
${gateConfigs.join("\n")}
  },
  edges: [
${edgeRoutes.join("\n")}
  ],
  entryPoints: [${effectiveEntryPoints.join(", ")}],
  memory,
${observabilityConfig}
${checkpointConfig}
${ast.hooks.length > 0 ? `  // Global hooks — event names are mapped to the SDK's 22 HookEvent names.
  globalHooks: [
${ast.hooks.map((h) => `    { name: "${escapeQuotes(h.name)}", on: "${escapeQuotes(mapHookEvent(h.on))}", matcher: "${escapeQuotes(h.matcher)}", run: "${escapeQuotes(h.run)}", type: "${h.type || "command"}"${h.timeout ? `, timeout: ${h.timeout}` : ""} },`).join("\n")}
  ],` : ""}
};
${ast.defaults ? `
// Apply defaults to all agents that don't override
for (const agent of Object.values(config.agents)) {
  for (const [key, value] of Object.entries(defaults)) {
    if ((agent as Record<string, unknown>)[key] === undefined) {
      (agent as Record<string, unknown>)[key] = value;
    }
  }
}
` : ""}
// ---------------------------------------------------------------------------
// Circuit breaker state
// ---------------------------------------------------------------------------

const circuitBreakerStates = new Map<string, CircuitBreakerState>();

function getCircuitBreakerState(agentId: string): CircuitBreakerState {
  if (!circuitBreakerStates.has(agentId)) {
    circuitBreakerStates.set(agentId, {
      state: "closed",
      failureCount: 0,
      lastFailure: 0,
      nextAttempt: 0,
    });
  }
  return circuitBreakerStates.get(agentId)!;
}

function checkCircuitBreaker(agentId: string, cbConfig: { threshold: number; window: number; cooldown: number }): boolean {
  const state = getCircuitBreakerState(agentId);
  const now = Date.now();

  if (state.state === "open") {
    if (now >= state.nextAttempt) {
      state.state = "half-open";
      return true;
    }
    return false;
  }

  return true;
}

function recordCircuitBreakerResult(agentId: string, cbConfig: { threshold: number; window: number; cooldown: number }, failed: boolean): void {
  const state = getCircuitBreakerState(agentId);
  const now = Date.now();

  if (failed) {
    if (now - state.lastFailure > cbConfig.window) {
      state.failureCount = 0;
    }
    state.failureCount++;
    state.lastFailure = now;
    if (state.failureCount >= cbConfig.threshold) {
      state.state = "open";
      state.nextAttempt = now + cbConfig.cooldown;
    }
  } else {
    state.state = "closed";
    state.failureCount = 0;
  }
}
${hasRateLimits ? `
// ---------------------------------------------------------------------------
// Rate limiters
// ---------------------------------------------------------------------------

const rateLimiters = new Map<string, RateLimiter>();

function getRateLimiter(agentId: string, rateExpr: string): RateLimiter {
  if (!rateLimiters.has(agentId)) {
    rateLimiters.set(agentId, new RateLimiter(rateExpr));
  }
  return rateLimiters.get(agentId)!;
}
` : ""}
// ---------------------------------------------------------------------------
// Flow engine
// ---------------------------------------------------------------------------

const results = new Map<string, AgentResult>();
const edgeIterations = new Map<string, number>();

function getNextAgents(completedId: string, result: AgentResult): Array<{ id: string; wait?: number }> {
  const outgoing = config.edges.filter((e) => e.from === completedId);
  if (!outgoing.length) return [];

  const errorEdges = outgoing.filter((e) => e.isError);
  const normalEdges = outgoing.filter((e) => !e.isError);

  if (result.error && errorEdges.length) {
    return errorEdges
      .filter((e) => !e.errorType || result.error?.includes(e.errorType))
      .map((e) => ({ id: e.to, wait: e.wait }));
  }

  const raceEdges = normalEdges.filter((e) => e.race);
  if (raceEdges.length) {
    return raceEdges.map((e) => ({ id: e.to, wait: e.wait }));
  }

  const weighted = normalEdges.filter((e) => e.weight !== undefined);
  if (weighted.length) {
    const rand = Math.random();
    let cumulative = 0;
    for (const e of weighted) {
      cumulative += e.weight!;
      if (rand <= cumulative) return [{ id: e.to, wait: e.wait }];
    }
    return [{ id: weighted[weighted.length - 1].to, wait: weighted[weighted.length - 1].wait }];
  }

  return normalEdges
    .filter((e) => {
      if (e.maxIterations !== undefined) {
        const key = \`\${e.from}->\${e.to}\`;
        const count = edgeIterations.get(key) || 0;
        if (count >= e.maxIterations) return false;
        edgeIterations.set(key, count + 1);
      }
      return !e.condition || e.condition(result);
    })
    .map((e) => ({ id: e.to, wait: e.wait }));
}

async function runGates(agentId: string, position: "before" | "after"): Promise<boolean> {
  for (const [gateId, gate] of Object.entries(config.gates)) {
    const matchesPosition = position === "before"
      ? gate.before === agentId
      : gate.after === agentId;

    if (!matchesPosition) continue;
    if (!gate.run) continue;

    const { exec } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execAsync = promisify(exec);

    let retries = gate.retry || 0;
    let passed = false;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await execAsync(gate.run, { timeout: gate.timeout || 30_000 });
        passed = true;
        break;
      } catch {
        if (attempt < retries) {
          console.log(\`  Gate "\${gateId}" failed, retry \${attempt + 1}/\${retries}\`);
        }
      }
    }

    if (!passed) {
      const behavior = gate.onFail || "halt";
      console.log(\`  Gate "\${gateId}" failed (on-fail: \${behavior})\`);
      if (behavior === "halt") return false;
    }
  }

  return true;
}

async function runAgent(agentId: string, input: string): Promise<AgentResult> {
  const agentConfig = config.agents[agentId];
  if (!agentConfig) {
    throw new Error(\`Unknown agent: \${agentId}\`);
  }

  if (agentConfig.skip) {
    console.log(\`  Skipping \${agentId}: \${agentConfig.skip}\`);
    return {
      agentId: agentConfig.id,
      output: "[skipped]",
      tokenUsage: { input: 0, output: 0 },
      durationMs: 0,
    };
  }

  if (agentConfig.circuitBreaker) {
    if (!checkCircuitBreaker(agentId, agentConfig.circuitBreaker)) {
      console.log(\`  Circuit open for \${agentId}, skipping\`);
      return {
        agentId: agentConfig.id,
        output: "",
        tokenUsage: { input: 0, output: 0 },
        durationMs: 0,
        error: "Circuit breaker is open",
      };
    }
  }
${hasRateLimits ? `
  if (agentConfig.rateLimit) {
    const limiter = getRateLimiter(agentId, agentConfig.rateLimit);
    await limiter.acquire();
  }
` : ""}${hasVariants ? `
  if (agentConfig.variants?.length) {
    const selection = selectVariant(agentConfig.variants, agentConfig.systemPrompt);
    agentConfig.systemPrompt = selection.prompt;
    if (selection.model) agentConfig.model = selection.model;
    console.log(\`  Using variant "\${selection.variantId}" for \${agentId}\`);
  }
` : ""}
  const gatesPassed = await runGates(agentId, "before");
  if (!gatesPassed) {
    const behavior = agentConfig.onFail || "halt";
    if (behavior === "halt") {
      return {
        agentId: agentConfig.id,
        output: "",
        tokenUsage: { input: 0, output: 0 },
        durationMs: 0,
        error: "Gate check failed before execution",
      };
    }
  }

  const retryMax = agentConfig.retry?.max ?? 0;
  let lastError: string | undefined;
  const modelsToTry = [agentConfig.model, ...(agentConfig.fallbackChain || [])];

  for (const model of modelsToTry) {
    const configWithModel = { ...agentConfig, model };

    for (let attempt = 0; attempt <= retryMax; attempt++) {
      if (attempt > 0) {
        const backoff = agentConfig.retry?.backoff ?? "none";
        const baseInterval = agentConfig.retry?.interval ?? 1000;
        let delay = baseInterval;
        if (backoff === "linear") delay = baseInterval * attempt;
        if (backoff === "exponential") delay = baseInterval * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
        console.log(\`  Retry \${attempt}/\${retryMax} for \${agentId}\`);
      }

      const result = await executeAgent(configWithModel, input, config.memory);

      if (!result.error) {
        const afterGatesPassed = await runGates(agentId, "after");
        if (!afterGatesPassed) {
          const behavior = agentConfig.onFail || "halt";
          if (behavior === "halt") {
            result.error = "Gate check failed after execution";
          }
        }

        if (agentConfig.circuitBreaker) {
          recordCircuitBreakerResult(agentId, agentConfig.circuitBreaker, false);
        }

        return result;
      }

      lastError = result.error;
    }

    console.log(\`  Model "\${model}" failed for \${agentId}, trying next fallback...\`);
  }

  if (agentConfig.circuitBreaker) {
    recordCircuitBreakerResult(agentId, agentConfig.circuitBreaker, true);
  }

  return {
    agentId: agentConfig.id,
    output: "",
    tokenUsage: { input: 0, output: 0 },
    durationMs: 0,
    error: lastError,
  };
}

function handleOnFail(agentId: string, result: AgentResult, queue: Array<{ agentId: string; input: string }>): boolean {
  const agentConfig = config.agents[agentId];
  const behavior = agentConfig?.onFail || "halt";

  if (behavior === "halt") return false;
  if (behavior === "skip" || behavior === "continue") return true;

  if (behavior.startsWith("fallback ")) {
    const fallbackId = behavior.slice("fallback ".length);
    queue.push({ agentId: fallbackId, input: result.output || "" });
    return true;
  }

  return false;
}

/**
 * Run the topology flow graph.
 */
export async function runTopology(input: string): Promise<Map<string, AgentResult>> {
  console.log(\`Running topology: \${config.name} v\${config.version}\`);

  const queue: Array<{ agentId: string; input: string }> = [];
  for (const ep of config.entryPoints) {
    queue.push({ agentId: ep, input });
  }

  while (queue.length > 0) {
    const batch = queue.splice(0, queue.length);

    const batchResults = await Promise.allSettled(
      batch.map(async ({ agentId, input: agentInput }) => {
${ast.depth.levels.length ? `        // Depth filtering — omit agents based on current depth level
        if (shouldOmitAgent(agentId)) {
          console.log(\`  Omitting \${agentId} (depth level \${getDepthLevel()})\`);
          const skipResult: AgentResult = {
            agentId: agentId as AgentResult["agentId"],
            output: "[omitted by depth]",
            tokenUsage: { input: 0, output: 0 },
            durationMs: 0,
          };
          results.set(agentId, skipResult);
          return { agentId, result: skipResult };
        }
` : ""}
        // Check node type and route to appropriate executor
        if (config.groups[agentId]) {
          const groupResult = await executeGroup(config.groups[agentId], config.agents, agentInput, config.memory);
          const agentResult: AgentResult = {
            agentId: agentId as AgentResult["agentId"],
            output: groupResult.finalOutput,
            tokenUsage: groupResult.totalTokens,
            durationMs: 0,
          };
          results.set(agentId, agentResult);
          return { agentId, result: agentResult };
        }

        if (config.humans[agentId]) {
          const humanResult = await executeHuman(config.humans[agentId]);
          const agentResult: AgentResult = {
            agentId: agentId as AgentResult["agentId"],
            output: humanResult.input,
            tokenUsage: { input: 0, output: 0 },
            durationMs: 0,
          };
          results.set(agentId, agentResult);
          return { agentId, result: agentResult };
        }

        if (config.actions[agentId]) {
          const actionResult = await executeAction(config.actions[agentId]);
          const agentResult: AgentResult = {
            agentId: agentId as AgentResult["agentId"],
            output: actionResult.stdout,
            tokenUsage: { input: 0, output: 0 },
            durationMs: 0,
            error: actionResult.error,
          };
          results.set(agentId, agentResult);
          return { agentId, result: agentResult };
        }

        // Default: agent node
        const result = await runAgent(agentId, agentInput);
        results.set(agentId, result);
        return { agentId, result };
      }),
    );

    for (const settled of batchResults) {
      if (settled.status === "rejected") {
        console.error("Batch item failed:", settled.reason);
        continue;
      }

      const { agentId, result } = settled.value;

      if (result.error) {
        const shouldContinue = handleOnFail(agentId, result, queue);
        if (!shouldContinue) {
          console.error(\`Topology halted: agent "\${agentId}" failed: \${result.error}\`);
          return results;
        }
        continue;
      }

      // Get next agents from edges
      const nextAgents = getNextAgents(agentId, result);
      for (const next of nextAgents) {
        if (next.wait) {
          await new Promise((resolve) => setTimeout(resolve, next.wait));
        }
        queue.push({ agentId: next.id, input: result.output });
      }
    }
  }

  return results;
}

export { config };
`;
}

// ---------------------------------------------------------------------------
// Settings generator (for .claude/settings.json)
// ---------------------------------------------------------------------------

function generateSettings(ast: TopologyAST): string {
  const settings: Record<string, unknown> = {};

  if (ast.settings && typeof ast.settings === "object") {
    const perms = ast.settings as Record<string, unknown>;
    if (perms.permissions && typeof perms.permissions === "object") {
      const permRules = perms.permissions as Record<string, unknown>;
      if (permRules.allow) settings.allow = permRules.allow;
      if (permRules.deny) settings.deny = permRules.deny;
      if (permRules.ask) settings.ask = permRules.ask;
    }
  }

  return JSON.stringify(settings, null, 2);
}

// ---------------------------------------------------------------------------
// Index / entry point generator
// ---------------------------------------------------------------------------

function generateIndex(ast: TopologyAST): string {
  const hasSchedules = ast.schedules.length > 0;
  const hasParams = ast.params.length > 0;

  return `/**
 * Entry point for ${ast.topology.name} topology.
 * Auto-generated by agentopology scaffold — edit as needed.
 *
 * Uses the Claude Agent SDK — each agent is a query() call.
 * No manual tool loop needed.
 */

import { runTopology, config } from "./orchestrator.js";
${hasSchedules ? `import { Scheduler } from "./scheduler.js";\n` : ""}${hasParams ? `import { parseParams } from "./params.js";\n` : ""}
async function main() {
${hasParams ? `  // Parse topology parameters from CLI args / env vars
  const params = parseParams();
  console.log("Topology params:", params);
` : ""}  const input = process.argv.slice(2).join(" ") || "Start the topology";
  console.log("Starting ${escapeQuotes(ast.topology.name)} topology...");
  console.log(\`Input: \${input}\`);
  console.log("");

  const results = await runTopology(input);

  console.log("");
  console.log("=".repeat(60));
  console.log("Results:");
  console.log("=".repeat(60));

  for (const [agentId, result] of results) {
    console.log(\`\\n[\${agentId}]\`);
    if (result.error) {
      console.log(\`  Error: \${result.error}\`);
    } else {
      console.log(\`  Output: \${result.output.slice(0, 200)}\${result.output.length > 200 ? "..." : ""}\`);
    }
    console.log(\`  Tokens: \${result.tokenUsage.input} in / \${result.tokenUsage.output} out\`);
    console.log(\`  Duration: \${result.durationMs}ms\`);
  }
${hasSchedules ? `
  // Start scheduled jobs
  const scheduler = new Scheduler();
${ast.schedules
  .filter((s) => s.enabled)
  .map((s) => {
    if (s.cron) {
      return `  scheduler.addCronJob("${s.id}", "${escapeQuotes(s.cron)}", async () => {
    console.log("Running scheduled job: ${s.id}");
    await runTopology("Scheduled run: ${s.id}");
  });`;
    } else if (s.every) {
      return `  scheduler.addEveryJob("${s.id}", "${s.every}", async () => {
    console.log("Running scheduled job: ${s.id}");
    await runTopology("Scheduled run: ${s.id}");
  });`;
    }
    return "";
  })
  .filter(Boolean)
  .join("\n")}
  scheduler.start();
  console.log("\\nScheduler started. Press Ctrl+C to stop.");
  process.on("SIGINT", () => {
    scheduler.stop();
    process.exit(0);
  });
` : ""}
}

main().catch(console.error);
`;
}

// ---------------------------------------------------------------------------
// Gate scripts
// ---------------------------------------------------------------------------

function generateGateScripts(ast: TopologyAST): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const gates = ast.nodes.filter((n): n is GateNode => n.type === "gate");

  for (const gate of gates) {
    const description = gate.checks?.length
      ? `Gate: ${gate.id} — checks: ${gate.checks.join(", ")}`
      : `Gate: ${gate.id}`;

    files.push({
      path: `scripts/gate-${gate.id}.sh`,
      content: [
        "#!/usr/bin/env bash",
        `# ${description}`,
        "# Auto-generated by agentopology scaffold — edit as needed.",
        "set -euo pipefail",
        "",
        ...(gate.checks?.map((c) => `# Check: ${c}`) || []),
        "",
        'echo "TODO: implement gate checks"',
        "",
      ].join("\n"),
    });
  }

  return files;
}

// ---------------------------------------------------------------------------
// Artifacts generator
// ---------------------------------------------------------------------------

function generateArtifacts(ast: TopologyAST): string {
  if (!ast.artifacts.length) return `/** No artifacts defined. */\nexport const artifactManifest: Record<string, ArtifactEntry> = {};\n\nexport interface ArtifactEntry {\n  id: string;\n  type: string;\n  path?: string;\n  retention?: string;\n  dependsOn?: string[];\n}\n`;

  const entries = ast.artifacts.map((a) => {
    const parts: string[] = [`    id: "${a.id}"`, `    type: "${a.type}"`];
    if (a.path) parts.push(`    path: "${escapeQuotes(a.path)}"`);
    if (a.retention) parts.push(`    retention: "${a.retention}"`);
    if (a.dependsOn?.length) parts.push(`    dependsOn: ${JSON.stringify(a.dependsOn)}`);
    return `  "${a.id}": {\n${parts.join(",\n")}\n  }`;
  });

  const agents = ast.nodes.filter((n): n is AgentNode => n.type === "agent");
  const producerMap: Record<string, string[]> = {};
  const consumerMap: Record<string, string[]> = {};
  for (const agent of agents) {
    if (agent.produces?.length) {
      for (const artId of agent.produces) {
        (producerMap[artId] ??= []).push(agent.id);
      }
    }
    if (agent.consumes?.length) {
      for (const artId of agent.consumes) {
        (consumerMap[artId] ??= []).push(agent.id);
      }
    }
  }

  return `/**
 * Artifact manifest — tracks artifact definitions, producers, and consumers.
 * Auto-generated by agentopology scaffold — edit as needed.
 */

export interface ArtifactEntry {
  id: string;
  type: string;
  path?: string;
  retention?: string;
  dependsOn?: string[];
}

export const artifactManifest: Record<string, ArtifactEntry> = {
${entries.join(",\n")}
};

export const artifactProducers: Record<string, string[]> = ${JSON.stringify(producerMap, null, 2)};
export const artifactConsumers: Record<string, string[]> = ${JSON.stringify(consumerMap, null, 2)};

const producedArtifacts = new Set<string>();
export function markProduced(artifactId: string): void { producedArtifacts.add(artifactId); }
export function isProduced(artifactId: string): boolean { return producedArtifacts.has(artifactId); }
export function getProducedArtifacts(): string[] { return [...producedArtifacts]; }
`;
}

// ---------------------------------------------------------------------------
// Depth generator
// ---------------------------------------------------------------------------

function generateDepth(ast: TopologyAST): string {
  const depth = ast.depth;
  if (!depth.levels.length) return `/** No depth levels defined. */\nexport function shouldOmitAgent(_agentId: string): boolean { return false; }\nexport function getDepthLevel(): number { return 0; }\n`;

  return `/**
 * Depth configuration — controls which agents to omit at each depth level.
 * Auto-generated by agentopology scaffold — edit as needed.
 *
 * Factors: ${depth.factors.join(", ") || "none"}
 */

export interface DepthLevel {
  level: number;
  label: string;
  omit: string[];
}

export const depthFactors: string[] = ${JSON.stringify(depth.factors)};
export const depthLevels: DepthLevel[] = ${JSON.stringify(depth.levels, null, 2)};

export function getDepthLevel(): number {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--depth=")) return parseInt(args[i].split("=")[1], 10) || 0;
    if (args[i] === "--depth" && args[i + 1]) return parseInt(args[i + 1], 10) || 0;
  }
  if (process.env.TOPOLOGY_DEPTH) return parseInt(process.env.TOPOLOGY_DEPTH, 10) || 0;
  return 0;
}

export function shouldOmitAgent(agentId: string): boolean {
  const level = getDepthLevel();
  const depthDef = depthLevels.find((d) => d.level === level);
  if (!depthDef) return false;
  return depthDef.omit.includes(agentId);
}
`;
}

// ---------------------------------------------------------------------------
// Metering generator
// ---------------------------------------------------------------------------

function generateMetering(ast: TopologyAST): string {
  const metering = ast.metering;
  const outputPath = metering?.output || "./metrics.jsonl";
  const format = metering?.format || "jsonl";
  const track = metering?.track || ["tokens-in", "tokens-out", "cost"];
  const per = metering?.per || ["agent", "run"];
  const pricing = metering?.pricing || "default";

  return `/**
 * Metering — cost and token usage tracking.
 * Auto-generated by agentopology scaffold — edit as needed.
 *
 * Track: ${track.join(", ")}
 * Per: ${per.join(", ")}
 * Pricing: ${pricing}
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { existsSync } from "node:fs";

export interface MeteringRecord {
  timestamp: number;
  runId?: string;
  agentId: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  cost?: number;
}

export class Meter {
  private records: MeteringRecord[] = [];

  constructor(
    private outputPath: string = "${escapeQuotes(outputPath)}",
    private format: string = "${format}",
    private tracked: string[] = ${JSON.stringify(track)},
    private dimensions: string[] = ${JSON.stringify(per)},
    private pricing: string = "${pricing}",
  ) {}

  async record(entry: MeteringRecord): Promise<void> {
    this.records.push(entry);

    const dir = dirname(this.outputPath);
    if (!existsSync(dir) && dir !== ".") {
      await mkdir(dir, { recursive: true });
    }

    const line = this.format === "csv"
      ? \`\${entry.timestamp},\${entry.agentId},\${entry.model},\${entry.tokensIn},\${entry.tokensOut},\${entry.durationMs},\${entry.cost ?? ""}\\n\`
      : JSON.stringify(entry) + "\\n";

    await appendFile(this.outputPath, line, "utf-8");
  }

  getRecords(): MeteringRecord[] { return [...this.records]; }

  getTotals(): { tokensIn: number; tokensOut: number; cost: number } {
    return this.records.reduce(
      (acc, r) => ({
        tokensIn: acc.tokensIn + r.tokensIn,
        tokensOut: acc.tokensOut + r.tokensOut,
        cost: acc.cost + (r.cost ?? 0),
      }),
      { tokensIn: 0, tokensOut: 0, cost: 0 },
    );
  }
}
`;
}

// ---------------------------------------------------------------------------
// Params generator
// ---------------------------------------------------------------------------

function generateParams(ast: TopologyAST): string {
  if (!ast.params.length) return `/** No topology parameters defined. */\nexport function parseParams(): Record<string, unknown> { return {}; }\n`;

  const paramDefs = ast.params.map((p) => {
    const parts: string[] = [`    name: "${p.name}"`, `    type: "${p.type}"`, `    required: ${p.required}`];
    if (p.default !== undefined) parts.push(`    default: ${JSON.stringify(p.default)}`);
    return `  {\n${parts.join(",\n")}\n  }`;
  });

  return `/**
 * Topology parameters — parsed from CLI args or env vars.
 * Auto-generated by agentopology scaffold — edit as needed.
 */

interface ParamDef {
  name: string;
  type: "string" | "number" | "boolean";
  required: boolean;
  default?: string | number | boolean;
}

const paramDefs: ParamDef[] = [
${paramDefs.join(",\n")}
];

export function parseParams(): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const args = process.argv.slice(2);

  for (const def of paramDefs) {
    let raw: string | undefined;

    for (let i = 0; i < args.length; i++) {
      if (args[i] === \`--\${def.name}\` && args[i + 1]) { raw = args[i + 1]; break; }
      if (args[i].startsWith(\`--\${def.name}=\`)) { raw = args[i].split("=").slice(1).join("="); break; }
    }

    if (raw === undefined) {
      raw = process.env[\`TOPOLOGY_PARAM_\${def.name.toUpperCase()}\`];
    }

    if (raw !== undefined) {
      switch (def.type) {
        case "number": result[def.name] = parseFloat(raw); break;
        case "boolean": result[def.name] = raw === "true" || raw === "1"; break;
        default: result[def.name] = raw;
      }
    } else if (def.default !== undefined) {
      result[def.name] = def.default;
    } else if (def.required) {
      throw new Error(\`Missing required parameter: \${def.name}\`);
    }
  }

  return result;
}
`;
}

// ---------------------------------------------------------------------------
// Interface endpoints generator
// ---------------------------------------------------------------------------

function generateInterfaceEndpoints(ast: TopologyAST): string {
  if (!ast.interfaceEndpoints) return "";
  return `/**
 * Interface endpoints — entry and exit points for this topology.
 * Auto-generated by agentopology scaffold — edit as needed.
 */

export const interfaceEntry = "${escapeQuotes(ast.interfaceEndpoints.entry)}";
export const interfaceExit = "${escapeQuotes(ast.interfaceEndpoints.exit)}";
`;
}

// ---------------------------------------------------------------------------
// Imports/includes comment generator
// ---------------------------------------------------------------------------

function generateImportsAndIncludes(ast: TopologyAST): string {
  const lines: string[] = [
    "/**",
    " * Topology imports and includes — reference information.",
    " * Auto-generated by agentopology scaffold — edit as needed.",
    " */",
    "",
  ];

  if (ast.imports.length) {
    lines.push("// --- Imports ---");
    for (const imp of ast.imports) {
      lines.push(`// import ${imp.alias} from "${imp.source}"`);
    }
    lines.push("");
    lines.push("export const topologyImports = " + JSON.stringify(ast.imports.map((i) => ({
      source: i.source,
      alias: i.alias,
      params: i.params,
      sha256: i.sha256,
      registry: i.registry,
    })), null, 2) + ";");
    lines.push("");
  }

  if (ast.includes.length) {
    lines.push("// --- Includes (fragment files) ---");
    for (const inc of ast.includes) {
      lines.push(`// include "${inc.source}"`);
    }
    lines.push("");
    lines.push("export const topologyIncludes = " + JSON.stringify(ast.includes.map((i) => i.source)) + ";");
    lines.push("");
  }

  if (!ast.imports.length && !ast.includes.length) {
    lines.push("// No imports or includes defined.");
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Custom MCP tools generator (from topology `tools {}` block)
// ---------------------------------------------------------------------------

function generateCustomMcpTools(ast: TopologyAST): string {
  if (!ast.toolDefs.length) return "";

  const toolEntries = ast.toolDefs.map((t) => {
    const argNames = t.args || [];
    const schemaFields = argNames
      .map((arg) => `    ${arg}: z.string().describe("Argument: ${arg}"),`)
      .join("\n");
    const argsSpread = argNames
      .map((arg) => `\${args.${arg}}`)
      .join(" ");
    const scriptCmd = t.script + (argsSpread ? ` ${argsSpread}` : "");

    return `// Tool: ${t.id}
customTools.addTool(tool(
  "${escapeQuotes(t.id)}",
  "${escapeQuotes(t.description)}",
  {
${schemaFields}
  },
  async (args) => {
    const { execSync } = await import("child_process");
    return execSync(\`${escapeString(scriptCmd)}\`).toString();
  }
));`;
  });

  return `/**
 * Custom MCP tools — compiled from the topology \`tools {}\` block.
 * Auto-generated by agentopology scaffold — edit as needed.
 *
 * Uses the SDK's native createSdkMcpServer() and tool() helpers to define
 * in-process MCP tools. These are passed to query() via mcpServers, so every
 * agent in the topology can access them.
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

export const customTools = createSdkMcpServer({
  name: "topology-tools",
  version: "1.0.0",
});

${toolEntries.join("\n\n")}
`;
}

// ---------------------------------------------------------------------------
// Main binding
// ---------------------------------------------------------------------------

function scaffold(ast: TopologyAST): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  // Package config
  files.push({ path: "package.json", content: generatePackageJson(ast) });
  files.push({ path: "tsconfig.json", content: generateTsConfig() });
  files.push({ path: ".env.example", content: generateEnvExample(ast) });

  // Source files
  files.push({ path: "src/types.ts", content: generateTypes(ast) });
  files.push({ path: "src/memory.ts", content: generateMemory() });
  files.push({ path: "src/runner.ts", content: generateAgentRunner() });
  files.push({ path: "src/orchestrator.ts", content: generateOrchestrator(ast) });
  files.push({ path: "src/index.ts", content: generateIndex(ast) });

  // Executor files
  files.push({ path: "src/group-executor.ts", content: generateGroupExecutor() });
  files.push({ path: "src/human-executor.ts", content: generateHumanExecutor() });
  files.push({ path: "src/action-executor.ts", content: generateActionExecutor() });

  // Runtime files
  files.push({ path: "src/observability.ts", content: generateObservability() });
  files.push({ path: "src/checkpoint.ts", content: generateCheckpoint() });
  files.push({ path: "src/scheduler.ts", content: generateScheduler() });
  files.push({ path: "src/rate-limiter.ts", content: generateRateLimiter() });
  files.push({ path: "src/variants.ts", content: generateVariantSelector() });

  // Custom MCP tools (from topology `tools {}` block)
  if (ast.toolDefs.length) {
    files.push({ path: "src/custom-tools.ts", content: generateCustomMcpTools(ast) });
  }

  // Metering
  files.push({ path: "src/metering.ts", content: generateMetering(ast) });

  // Artifacts
  files.push({ path: "src/artifacts.ts", content: generateArtifacts(ast) });

  // Depth
  files.push({ path: "src/depth.ts", content: generateDepth(ast) });

  // Params
  files.push({ path: "src/params.ts", content: generateParams(ast) });

  // Interface endpoints
  if (ast.interfaceEndpoints) {
    files.push({ path: "src/interface.ts", content: generateInterfaceEndpoints(ast) });
  }

  // Imports and includes
  if (ast.imports.length || ast.includes.length) {
    files.push({ path: "src/topology-imports.ts", content: generateImportsAndIncludes(ast) });
  }

  // Settings
  files.push({ path: ".claude/settings.json", content: generateSettings(ast) });

  // Gate scripts
  files.push(...generateGateScripts(ast));

  // Directories
  files.push({ path: ".memory/.gitkeep", content: "" });
  files.push({ path: ".checkpoint/.gitkeep", content: "" });

  // .gitignore
  files.push({
    path: ".gitignore",
    content: [
      "node_modules/",
      "dist/",
      ".env",
      ".memory/",
      ".checkpoint/",
      "*.js",
      "*.d.ts",
      "*.js.map",
      "",
    ].join("\n"),
  });

  return deduplicateFiles(files);
}

export const claudeAgentSdkBinding: BindingTarget = {
  name: "claude-agent-sdk",
  description:
    "Claude Agent SDK — compiles topology to native query() calls with built-in tools, subagents, hooks, MCP, and permissions",
  scaffold,
};
