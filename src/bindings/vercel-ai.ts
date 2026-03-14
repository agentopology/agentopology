/**
 * Vercel AI SDK binding — multi-provider engine binding.
 *
 * Unlike CLI bindings that generate config files, this binding compiles a
 * {@link TopologyAST} into **runnable TypeScript code** that orchestrates
 * agents via the Vercel AI SDK with `generateText()` / `generateObject()`.
 *
 * Output: a self-contained Node.js project with:
 *   - A provider registry for multi-provider model resolution
 *   - Per-agent executors using generateText with maxSteps for tool loops
 *   - Tool definitions compiled to Zod schemas via tool()
 *   - File-based memory (markdown read/write)
 *   - Edge routing with conditions, error handling, and fan-out
 *   - Group chat, human-in-the-loop, action, gate executors
 *   - Observability via experimental_telemetry + OTel
 *   - Checkpointing, scheduling, rate limiting
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
  ScaleDef,
  HookDef,
  OutputsMap,
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

/** Convert a SchemaType to a Zod expression string. */
function schemaTypeToZod(t: SchemaType): string {
  switch (t.kind) {
    case "primitive":
      switch (t.value) {
        case "string": return "z.string()";
        case "number": return "z.number()";
        case "integer": return "z.number().int()";
        case "boolean": return "z.boolean()";
        case "object": return "z.record(z.unknown())";
        default: return "z.unknown()";
      }
    case "array":
      return `z.array(${schemaTypeToZod(t.itemType)})`;
    case "enum":
      return `z.enum([${t.values.map((v) => `"${escapeQuotes(v)}"`).join(", ")}])`;
    case "ref":
      return `${toPascalCase(t.name)}Schema`;
  }
}

/** Build a Zod object schema from schema fields. */
function fieldsToZodObject(fields: SchemaFieldDef[]): string {
  const entries = fields.map((f) => {
    const zodType = schemaTypeToZod(f.type);
    return `  ${f.name}: ${f.optional ? `${zodType}.optional()` : zodType},`;
  });
  return `z.object({\n${entries.join("\n")}\n})`;
}

// ---------------------------------------------------------------------------
// Model mapping
// ---------------------------------------------------------------------------

/** Map topology model aliases to AI SDK provider-prefixed model IDs. */
function mapModel(model: string | undefined): string {
  if (!model) return "anthropic:claude-sonnet-4-6";
  const m = model.toLowerCase();

  // Alias table
  const aliases: Record<string, string> = {
    "opus": "anthropic:claude-opus-4-6",
    "claude-opus": "anthropic:claude-opus-4-6",
    "sonnet": "anthropic:claude-sonnet-4-6",
    "claude-sonnet": "anthropic:claude-sonnet-4-6",
    "haiku": "anthropic:claude-haiku-4-5-20251001",
    "claude-haiku": "anthropic:claude-haiku-4-5-20251001",
    "gpt-4o": "openai:gpt-4o",
    "gpt-4o-mini": "openai:gpt-4o-mini",
    "o3": "openai:o3",
    "o3-mini": "openai:o3-mini",
    "o4-mini": "openai:o4-mini",
    "gemini-2.0-flash": "google:gemini-2.0-flash",
    "gemini-2.5-pro": "google:gemini-2.5-pro",
  };

  if (aliases[m]) return aliases[m];

  // Auto-detect provider from model ID prefix
  if (m.startsWith("claude-")) return `anthropic:${model}`;
  if (m.startsWith("gpt-") || m.startsWith("o1") || m.startsWith("o3") || m.startsWith("o4")) return `openai:${model}`;
  if (m.startsWith("gemini-")) return `google:${model}`;

  // Already provider-prefixed
  if (m.includes(":")) return model;

  // Default to anthropic
  return `anthropic:${model}`;
}

// ---------------------------------------------------------------------------
// Code generators
// ---------------------------------------------------------------------------

function generatePackageJson(ast: TopologyAST): string {
  const name = ast.topology.name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const deps: Record<string, string> = {
    "ai": "^4.0.0",
    "@ai-sdk/anthropic": "^2.0.0",
    "@ai-sdk/openai": "^1.0.0",
    "@ai-sdk/google": "^1.0.0",
    "zod": "^3.24.0",
  };

  // Add MCP dependency if mcpServers are configured
  if (Object.keys(ast.mcpServers).length > 0) {
    deps["@ai-sdk/mcp"] = "^0.1.0";
  }

  // Add OTel if observability is configured
  if (ast.observability?.enabled) {
    deps["@opentelemetry/sdk-node"] = "^0.52.0";
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

  // Provider API keys
  lines.push("ANTHROPIC_API_KEY=your-api-key-here");
  lines.push("OPENAI_API_KEY=your-openai-key-here");
  lines.push("GOOGLE_GENERATIVE_AI_API_KEY=your-google-key-here");

  // Provider-specific keys
  for (const provider of ast.providers) {
    if (provider.apiKey) {
      const envVar = provider.apiKey.replace(/^\$\{/, "").replace(/\}$/, "");
      if (!["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"].includes(envVar)) {
        lines.push(`${envVar}=your-${provider.name}-key-here`);
      }
    }
  }

  // Env vars from topology
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
    'import type { CoreTool, LanguageModelV1 } from "ai";',
    "",
    "// ---------------------------------------------------------------------------",
    "// Agent identifiers",
    "// ---------------------------------------------------------------------------",
    "",
    `export type AgentId = ${agents.map((a) => `"${a.id}"`).join(" | ") || "string"};`,
    "",
    "// ---------------------------------------------------------------------------",
    "// Message types",
    "// ---------------------------------------------------------------------------",
    "",
    "export interface AgentMessage {",
    "  role: \"user\" | \"assistant\";",
    "  content: string;",
    "  agentId?: AgentId;",
    "  timestamp: number;",
    "}",
    "",
    "export interface AgentResult {",
    "  agentId: AgentId;",
    "  output: string;",
    "  toolCalls: ToolCallRecord[];",
    "  tokenUsage: { input: number; output: number };",
    "  durationMs: number;",
    "  error?: string;",
    "}",
    "",
    "export interface ToolCallRecord {",
    "  name: string;",
    "  input: Record<string, unknown>;",
    "  output: string;",
    "  isError: boolean;",
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
    "// Agent configuration",
    "// ---------------------------------------------------------------------------",
    "",
    "export interface AgentConfig {",
    "  id: AgentId;",
    "  model: string;",
    "  systemPrompt: string;",
    "  tools: Record<string, CoreTool>;",
    "  maxTurns: number;",
    "  temperature?: number;",
    "  maxTokens?: number;",
    "  topP?: number;",
    "  topK?: number;",
    "  stop?: string[];",
    "  timeout?: number;",
    "  seed?: number;",
    "  thinking?: string;",
    "  thinkingBudget?: number;",
    "  outputFormat?: string;",
    "  outputSchema?: Record<string, unknown>;",
    "  retry?: { max: number; backoff?: string; interval?: number };",
    "  memoryReads?: string[];",
    "  memoryWrites?: string[];",
    "  onFail?: string;",
    "  skip?: string;",
    "  fallbackChain?: string[];",
    "  circuitBreaker?: CircuitBreakerConfig;",
    "  compensates?: string;",
    "  phase?: number;",
    "  rateLimit?: string;",
    "  variants?: PromptVariant[];",
    "  providerOptions?: Record<string, Record<string, unknown>>;",
    "  skills?: string[];",
    "  disallowedTools?: string[];",
    "  mcpServers?: string[];",
    "  inputSchema?: Record<string, unknown>;",
    "  outputs?: Record<string, string[]>;",
    "  behavior?: string;",
    "  invocation?: string;",
    "  background?: boolean;",
    "  scale?: ScaleConfig;",
    "  hooks?: HookConfig[];",
    "  join?: string;",
    "  produces?: string[];",
    "  consumes?: string[];",
    "}",
    "",
    "export interface ScaleConfig {",
    "  mode: string;",
    "  by: string;",
    "  min: number;",
    "  max: number;",
    "  batchSize?: number;",
    "}",
    "",
    "export interface HookConfig {",
    "  name: string;",
    "  on: string;",
    "  matcher: string;",
    "  run: string;",
    "  type?: string;",
    "  timeout?: number;",
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
    "  messages: AgentMessage[];",
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
    "  state: \"closed\" | \"open\" | \"half-open\";",
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
    "  tolerance?: number | string;",
    "  per?: string;",
    "}",
    "",
    "// ---------------------------------------------------------------------------",
    "// Topology runtime config",
    "// ---------------------------------------------------------------------------",
    "",
    "export interface TopologyConfig {",
    "  name: string;",
    "  version: string;",
    "  agents: Record<string, AgentConfig>;",
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
// Client generator (provider registry)
// ---------------------------------------------------------------------------

function generateClient(ast: TopologyAST): string {
  // Determine which providers are actually used
  const usedModels = new Set<string>();
  for (const node of ast.nodes) {
    if (node.type === "agent" || node.type === "orchestrator") {
      const model = (node as AgentNode | OrchestratorNode).model;
      if (model) usedModels.add(model);
    }
  }

  return `/**
 * Provider registry — multi-provider model resolution via AI SDK.
 * Auto-generated by agentopology scaffold — edit as needed.
 */

import { createProviderRegistry } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { google } from "@ai-sdk/google";

// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------

export const registry = createProviderRegistry({
  anthropic,
  openai,
  google,
});

// ---------------------------------------------------------------------------
// Model alias table
// ---------------------------------------------------------------------------

const ALIAS_MAP: Record<string, string> = {
  "opus": "anthropic:claude-opus-4-6",
  "claude-opus": "anthropic:claude-opus-4-6",
  "sonnet": "anthropic:claude-sonnet-4-6",
  "claude-sonnet": "anthropic:claude-sonnet-4-6",
  "haiku": "anthropic:claude-haiku-4-5-20251001",
  "claude-haiku": "anthropic:claude-haiku-4-5-20251001",
  "gpt-4o": "openai:gpt-4o",
  "gpt-4o-mini": "openai:gpt-4o-mini",
  "o3": "openai:o3",
  "o3-mini": "openai:o3-mini",
  "o4-mini": "openai:o4-mini",
  "gemini-2.0-flash": "google:gemini-2.0-flash",
  "gemini-2.5-pro": "google:gemini-2.5-pro",
};

/**
 * Resolve a topology model alias to an AI SDK provider-prefixed model ID.
 */
export function resolveModel(alias: string) {
  const lower = alias.toLowerCase();

  // Check alias table first
  const mapped = ALIAS_MAP[lower];
  if (mapped) return registry.languageModel(mapped);

  // Auto-detect provider from model ID prefix
  if (lower.startsWith("claude-")) return registry.languageModel(\`anthropic:\${alias}\`);
  if (lower.startsWith("gpt-") || lower.startsWith("o1") || lower.startsWith("o3") || lower.startsWith("o4")) {
    return registry.languageModel(\`openai:\${alias}\`);
  }
  if (lower.startsWith("gemini-")) return registry.languageModel(\`google:\${alias}\`);

  // Already provider-prefixed
  if (alias.includes(":")) return registry.languageModel(alias);

  // Default to anthropic
  return registry.languageModel(\`anthropic:\${alias}\`);
}
`;
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
    // Keys use dot notation: "domain.research.findings" -> ".memory/domain/research/findings.md"
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
// Agent executor generator
// ---------------------------------------------------------------------------

function generateAgentExecutor(): string {
  return `/**
 * Agent executor — runs a single agent via generateText with maxSteps.
 * Auto-generated by agentopology scaffold — edit as needed.
 *
 * The AI SDK handles the tool_use/tool_result loop automatically via maxSteps.
 */

import { generateText, generateObject, type CoreTool } from "ai";
import { z } from "zod";
import { resolveModel } from "./client.js";
import type {
  AgentConfig,
  AgentResult,
  ToolCallRecord,
  MemoryStore,
} from "./types.js";

export async function executeAgent(
  config: AgentConfig,
  input: string,
  memory: MemoryStore,
): Promise<AgentResult> {
  const startTime = Date.now();
  const toolCalls: ToolCallRecord[] = [];

  // Inject memory context into the system prompt
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

  // Build tools object — merge config tools with memory write tool
  const tools: Record<string, CoreTool> = { ...config.tools };

  // Gap #2: Filter out disallowed tools
  if (config.disallowedTools?.length) {
    for (const toolName of config.disallowedTools) {
      delete tools[toolName];
    }
  }

  // Gap #3: Filter MCP tools to only include per-agent mcpServers
  // When mcpServers is set, only include tools from those servers
  if (config.mcpServers?.length) {
    // MCP tools are prefixed with the server name (e.g. "server-name__tool-name")
    for (const toolName of Object.keys(tools)) {
      const serverPrefix = toolName.split("__")[0];
      // Keep non-MCP tools (no __ prefix) and tools from allowed servers
      if (toolName.includes("__") && !config.mcpServers.includes(serverPrefix)) {
        delete tools[toolName];
      }
    }
  }

  // Gap #1: Log available skills for the agent
  if (config.skills?.length) {
    console.log(\`  Skills available for \${config.id}: \${config.skills.join(", ")}\`);
    // Append skill awareness to system prompt
    systemPrompt += "\\n\\n# Available Skills\\n" + config.skills.map((s) => \`- \${s}\`).join("\\n");
  }

  // Gap #5: Fire AgentStart hooks
  if (config.hooks?.length) {
    for (const hook of config.hooks) {
      if (hook.on === "AgentStart") {
        console.log(\`  [hook] \${hook.name} (AgentStart): \${hook.run}\`);
        // TODO: execute hook.run command
      }
    }
  }

  if (config.memoryWrites?.length) {
    const { tool } = await import("ai");
    tools["memory_write"] = tool({
      description: \`Write to memory. Allowed keys: \${config.memoryWrites.join(", ")}\`,
      parameters: z.object({
        key: z.string().describe("Memory key to write to"),
        value: z.string().describe("Content to write"),
      }),
      execute: async ({ key, value }) => {
        if (config.memoryWrites?.includes(key)) {
          await memory.write(key, value);
          return \`Written to memory key: \${key}\`;
        }
        return \`Error: not allowed to write to key "\${key}". Allowed: \${config.memoryWrites?.join(", ")}\`;
      },
    });
  }

  // Build provider options for thinking/extended reasoning
  const providerOptions: Record<string, Record<string, unknown>> = {
    ...(config.providerOptions || {}),
  };

  if (config.thinking && config.thinking !== "off") {
    // Anthropic thinking
    providerOptions["anthropic"] = {
      ...(providerOptions["anthropic"] || {}),
      thinking: {
        type: "enabled",
        budgetTokens: config.thinkingBudget || 4096,
      },
    };
  }

  try {
    const model = resolveModel(config.model);

    const result = await generateText({
      model,
      system: systemPrompt,
      prompt: input,
      tools: Object.keys(tools).length > 0 ? tools : undefined,
      maxSteps: config.maxTurns || 10,
      maxRetries: config.retry?.max,
      temperature: config.temperature,
      maxTokens: config.maxTokens || 4096,
      topP: config.topP,
      topK: config.topK,
      stopSequences: config.stop,
      seed: config.seed,
      providerOptions,
      experimental_telemetry: {
        isEnabled: true,
        functionId: \`agent-\${config.id}\`,
      },
      onStepFinish: (step) => {
        // Record tool calls from each step
        if (step.toolCalls) {
          for (const tc of step.toolCalls) {
            // Gap #5: Fire PreToolUse / PostToolUse hooks
            if (config.hooks?.length) {
              for (const hook of config.hooks) {
                if (hook.on === "PreToolUse" && (!hook.matcher || hook.matcher === "*" || tc.toolName.includes(hook.matcher))) {
                  console.log(\`  [hook] \${hook.name} (PreToolUse:\${tc.toolName}): \${hook.run}\`);
                  // TODO: execute hook.run command
                }
              }
            }

            toolCalls.push({
              name: tc.toolName,
              input: tc.args as Record<string, unknown>,
              output: String(step.toolResults?.find((tr) => tr.toolCallId === tc.toolCallId)?.result ?? ""),
              isError: false,
            });

            // Gap #5: Fire PostToolUse hooks
            if (config.hooks?.length) {
              for (const hook of config.hooks) {
                if (hook.on === "PostToolUse" && (!hook.matcher || hook.matcher === "*" || tc.toolName.includes(hook.matcher))) {
                  console.log(\`  [hook] \${hook.name} (PostToolUse:\${tc.toolName}): \${hook.run}\`);
                  // TODO: execute hook.run command
                }
              }
            }
          }
        }
      },
    });

    // Handle memory writes from output
    if (config.memoryWrites?.length && result.text) {
      // Memory writes happen through tool calls, already handled
    }

    // Gap #5: Fire AgentStop hooks
    if (config.hooks?.length) {
      for (const hook of config.hooks) {
        if (hook.on === "AgentStop") {
          console.log(\`  [hook] \${hook.name} (AgentStop): \${hook.run}\`);
          // TODO: execute hook.run command
        }
      }
    }

    return {
      agentId: config.id,
      output: result.text,
      toolCalls,
      tokenUsage: {
        input: result.usage?.promptTokens ?? 0,
        output: result.usage?.completionTokens ?? 0,
      },
      durationMs: Date.now() - startTime,
    };
  } catch (err) {
    return {
      agentId: config.id,
      output: "",
      toolCalls,
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
 * Group chat executor — multi-agent conversation.
 * Auto-generated by agentopology scaffold — edit as needed.
 */

import { generateText } from "ai";
import { resolveModel } from "./client.js";
import { executeAgent } from "./executor.js";
import type {
  AgentConfig,
  AgentMessage,
  GroupChatConfig,
  GroupResult,
  MemoryStore,
} from "./types.js";

/**
 * Select the next speaker based on the strategy.
 */
async function selectSpeaker(
  groupConfig: GroupChatConfig,
  agentConfigs: Record<string, AgentConfig>,
  conversationHistory: AgentMessage[],
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
      // Use a lightweight model call to pick the next speaker
      const historyText = conversationHistory
        .map((m) => \`[\${m.agentId || "user"}]: \${m.content}\`)
        .join("\\n");

      const response = await generateText({
        model: resolveModel("haiku"),
        maxTokens: 50,
        system: "You are a conversation moderator. Pick the next speaker from the available members. Respond with ONLY the member id, nothing else.",
        prompt: \`Available members: \${members.join(", ")}\\n\\nConversation so far:\\n\${historyText}\\n\\nWho should speak next?\`,
      });

      const selected = response.text.trim();

      // Validate the selection; fall back to round-robin
      if (members.includes(selected)) {
        return selected;
      }
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
  agentConfigs: Record<string, AgentConfig>,
  input: string,
  memory: MemoryStore,
): Promise<GroupResult> {
  const conversationHistory: AgentMessage[] = [
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

    // Build context from conversation history
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

    // Check termination condition
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
 * Human-in-the-loop executor — prompts for user input in terminal.
 * Auto-generated by agentopology scaffold — edit as needed.
 */

import { createInterface } from "node:readline";
import type { HumanNodeConfig, HumanResult } from "./types.js";

/**
 * Prompt the user for input with optional timeout.
 */
export async function executeHuman(
  config: HumanNodeConfig,
): Promise<HumanResult> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = config.description
    ? \`\\n[Human Input Required] \${config.description}\\n> \`
    : "\\n[Human Input Required] Please provide your input:\\n> ";

  return new Promise<HumanResult>((resolve) => {
    let resolved = false;

    const handleInput = (answer: string) => {
      if (resolved) return;
      resolved = true;
      rl.close();
      resolve({ input: answer, timedOut: false });
    };

    rl.question(prompt, handleInput);

    if (config.timeout) {
      setTimeout(() => {
        if (resolved) return;
        resolved = true;
        rl.close();

        const behavior = config.onTimeout || "halt";

        if (behavior === "skip") {
          resolve({ input: "", timedOut: true });
        } else if (behavior.startsWith("fallback ")) {
          const fallbackId = behavior.slice("fallback ".length);
          resolve({ input: \`__FALLBACK__:\${fallbackId}\`, timedOut: true });
        } else {
          // "halt" — resolve with empty but mark timed out so orchestrator can halt
          resolve({ input: "", timedOut: true });
        }
      }, config.timeout);
    }
  });
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
 * Observability — OpenTelemetry + AI SDK experimental_telemetry.
 * Auto-generated by agentopology scaffold — edit as needed.
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

  /**
   * Check if a span should be sampled based on the configured sample rate.
   */
  private shouldSample(): boolean {
    return Math.random() < this.config.sampleRate;
  }

  /**
   * Start a new span.
   */
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

  /**
   * End a span and emit it if sampling allows.
   */
  endSpan(span: ObservabilitySpan): void {
    span.endTime = Date.now();

    if (!this.shouldSample()) return;

    this.spans.push(span);
    this.exportSpan(span);
  }

  /**
   * Export a span to the configured backend.
   */
  private exportSpan(span: ObservabilitySpan): void {
    const exporter = this.config.exporter;

    switch (exporter) {
      case "stdout":
        console.log(JSON.stringify(span));
        break;

      case "otlp":
        // Non-blocking HTTP POST to OTLP endpoint
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
          }).catch(() => {
            // Silently ignore export errors
          });
        }
        break;

      case "none":
      default:
        break;
    }
  }

  /**
   * Get all collected spans.
   */
  getSpans(): ObservabilitySpan[] {
    return [...this.spans];
  }

  /**
   * Reset trace state for a new run.
   */
  reset(): void {
    this.traceId = generateId();
    this.spans = [];
  }
}

/**
 * Build experimental_telemetry config for an AI SDK call.
 */
export function buildTelemetryConfig(
  agentId: string,
  topologyName: string,
  captureConfig?: { prompts: boolean; completions: boolean },
) {
  return {
    isEnabled: true,
    functionId: \`agent-\${agentId}\`,
    metadata: { topologyName },
    recordInputs: captureConfig?.prompts ?? true,
    recordOutputs: captureConfig?.completions ?? true,
  };
}
`;
}

// ---------------------------------------------------------------------------
// Checkpoint generator
// ---------------------------------------------------------------------------

function generateCheckpoint(): string {
  return `/**
 * Checkpoint — save and restore topology state for durable execution.
 * Auto-generated by agentopology scaffold — edit as needed.
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

  /**
   * Save a node's result to the checkpoint.
   */
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

  /**
   * Load a checkpoint for replay.
   */
  async load(runId: string): Promise<CheckpointData | null> {
    const filePath = this.getFilePath(runId);
    try {
      const content = await readFile(filePath, "utf-8");
      return JSON.parse(content) as CheckpointData;
    } catch {
      return null;
    }
  }

  /**
   * Get the set of completed node IDs from a checkpoint.
   */
  async getCompletedNodes(runId: string): Promise<Set<string>> {
    const data = await this.load(runId);
    if (!data) return new Set();
    return new Set(data.states.map((s) => s.nodeId));
  }

  /**
   * Whether to save after this node (depends on strategy).
   */
  shouldSaveAfterNode(): boolean {
    return this.strategy === "per-node";
  }

  /**
   * Whether to save after a phase completes.
   */
  shouldSaveAfterPhase(): boolean {
    return this.strategy === "per-phase";
  }

  /**
   * Clean up old checkpoints beyond TTL.
   */
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

/**
 * Parse an "every" duration string like "5m", "1h", "30s" into milliseconds.
 */
function parseEvery(every: string): number {
  const match = every.match(/^(\\d+(?:\\.\\d+)?)\\s*(ms|s|m|h|d)$/);
  if (!match) return 60_000; // default 1 minute
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

/**
 * Parse a simple cron expression into the next interval in ms.
 * Supports: "* * * * *" (minute hour day month weekday).
 * This is a simplified implementation — for production, use a cron library.
 */
function parseCronToInterval(cron: string): number {
  const parts = cron.trim().split(/\\s+/);
  if (parts.length < 5) return 60_000;

  // If minute is a number and rest are *, it's "every hour at minute X"
  if (parts[0] !== "*" && parts.slice(1).every((p) => p === "*")) {
    return 3_600_000; // every hour
  }

  // Default: every minute
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

  /**
   * Register a job with an "every" duration.
   */
  addEveryJob(id: string, every: string, handler: () => Promise<void>): void {
    const interval = parseEvery(every);
    this.jobs.set(id, { id, interval, handler });
  }

  /**
   * Register a job with a cron expression.
   */
  addCronJob(id: string, cron: string, handler: () => Promise<void>): void {
    const interval = parseCronToInterval(cron);
    this.jobs.set(id, { id, interval, handler });
  }

  /**
   * Start all registered jobs.
   */
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

  /**
   * Stop all jobs.
   */
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

/**
 * Parse a rate limit expression like "60/min", "1000/hour", "5/sec".
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

  /**
   * Wait until a token is available, then consume it.
   */
  async acquire(): Promise<void> {
    this.refill();

    if (this.tokens > 0) {
      this.tokens--;
      return;
    }

    // Wait until next refill
    const waitTime = this.refillInterval - (Date.now() - this.lastRefill);
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, waitTime)));
    this.refill();
    this.tokens--;
  }
}
`;
}

// ---------------------------------------------------------------------------
// Circuit breaker generator
// ---------------------------------------------------------------------------

function generateCircuitBreaker(): string {
  return `/**
 * Circuit breaker — failure isolation state machine.
 * Auto-generated by agentopology scaffold — edit as needed.
 *
 * States: CLOSED -> OPEN -> HALF_OPEN -> CLOSED
 */

import type { CircuitBreakerConfig, CircuitBreakerState } from "./types.js";

export class CircuitBreaker {
  private states = new Map<string, CircuitBreakerState>();

  getState(agentId: string): CircuitBreakerState {
    if (!this.states.has(agentId)) {
      this.states.set(agentId, {
        state: "closed",
        failureCount: 0,
        lastFailure: 0,
        nextAttempt: 0,
      });
    }
    return this.states.get(agentId)!;
  }

  /**
   * Check if the circuit allows execution.
   */
  isAllowed(agentId: string, cbConfig: CircuitBreakerConfig): boolean {
    const state = this.getState(agentId);
    const now = Date.now();

    if (state.state === "open") {
      if (now >= state.nextAttempt) {
        state.state = "half-open";
        return true; // allow one attempt
      }
      return false; // circuit is open, reject
    }

    return true; // closed or half-open, allow
  }

  /**
   * Record a success or failure.
   */
  record(agentId: string, cbConfig: CircuitBreakerConfig, failed: boolean): void {
    const state = this.getState(agentId);
    const now = Date.now();

    if (failed) {
      // Reset count if outside window
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
      // Success: close the circuit
      state.state = "closed";
      state.failureCount = 0;
    }
  }
}
`;
}

// ---------------------------------------------------------------------------
// Metering generator
// ---------------------------------------------------------------------------

function generateMeteringFile(ast: TopologyAST): string {
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

  /**
   * Record a metering event.
   */
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

  /**
   * Get all recorded entries.
   */
  getRecords(): MeteringRecord[] {
    return [...this.records];
  }

  /**
   * Get total token usage.
   */
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
// Variant selector generator
// ---------------------------------------------------------------------------

function generateVariantSelector(): string {
  return `/**
 * Prompt variant selector — weighted random selection for A/B testing.
 * Auto-generated by agentopology scaffold — edit as needed.
 */

import type { PromptVariant, VariantSelection } from "./types.js";

/**
 * Select a variant using weighted random selection.
 */
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

  // Fallback to last variant
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
// Permissions generator
// ---------------------------------------------------------------------------

function generatePermissions(): string {
  return `/**
 * Permission checker — tool allow/deny/ask enforcement.
 * Auto-generated by agentopology scaffold — edit as needed.
 */

import { createInterface } from "node:readline";

export type PermissionMode = "auto" | "supervised" | "autonomous" | "plan";

export interface PermissionConfig {
  mode: PermissionMode;
  allow?: string[];
  deny?: string[];
  ask?: string[];
}

/**
 * Filter tools based on permission configuration.
 * Returns the set of tool names that are allowed.
 */
export function filterTools(
  allToolNames: string[],
  config: PermissionConfig,
): string[] {
  let allowed = [...allToolNames];

  // If allow list is set, only those tools are permitted
  if (config.allow?.length) {
    allowed = allowed.filter((t) => config.allow!.includes(t));
  }

  // Remove denied tools
  if (config.deny?.length) {
    allowed = allowed.filter((t) => !config.deny!.includes(t));
  }

  // In plan mode, no tools are allowed for execution
  if (config.mode === "plan") {
    return [];
  }

  return allowed;
}

/**
 * Prompt user for tool approval (supervised mode).
 */
export async function requestApproval(toolName: string, args: Record<string, unknown>): Promise<boolean> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise<boolean>((resolve) => {
    rl.question(
      \`\\n[Tool Approval] Allow "\${toolName}" with args \${JSON.stringify(args)}? (y/n) > \`,
      (answer) => {
        rl.close();
        resolve(answer.toLowerCase().startsWith("y"));
      },
    );
  });
}
`;
}

// ---------------------------------------------------------------------------
// Schemas generator
// ---------------------------------------------------------------------------

function generateSchemas(ast: TopologyAST): string {
  if (!ast.schemas.length) {
    return `/**
 * Schema definitions — compiled from topology schema blocks.
 * Auto-generated by agentopology scaffold — edit as needed.
 */

import { z } from "zod";

// No schemas defined in this topology.
export const schemas: Record<string, z.ZodType> = {};
`;
  }

  const schemaLines: string[] = [
    "/**",
    " * Schema definitions — compiled from topology schema blocks to Zod schemas.",
    " * Auto-generated by agentopology scaffold — edit as needed.",
    " */",
    "",
    'import { z } from "zod";',
    "",
  ];

  for (const schema of ast.schemas) {
    const name = toPascalCase(schema.id);
    const fields = schema.fields.map((f) => {
      const zodType = schemaTypeToZod(f.type);
      return `  ${f.name}: ${f.optional ? `${zodType}.optional()` : zodType},`;
    });

    schemaLines.push(
      `export const ${name}Schema = z.object({`,
      ...fields,
      "});",
      "",
      `export type ${name} = z.infer<typeof ${name}Schema>;`,
      "",
    );
  }

  schemaLines.push(
    "export const schemas: Record<string, z.ZodType> = {",
    ...ast.schemas.map((s) => `  "${s.id}": ${toPascalCase(s.id)}Schema,`),
    "};",
    "",
  );

  return schemaLines.join("\n");
}

// ---------------------------------------------------------------------------
// Tools generator
// ---------------------------------------------------------------------------

function generateToolsIndex(ast: TopologyAST): string {
  const lines: string[] = [
    "/**",
    " * Tool definitions for the topology runtime.",
    " * Auto-generated by agentopology scaffold — edit as needed.",
    " */",
    "",
    'import { tool, type CoreTool } from "ai";',
    'import { z } from "zod";',
    'import { readFile, writeFile } from "node:fs/promises";',
    'import { exec } from "node:child_process";',
    'import { promisify } from "node:util";',
    "",
    "const execAsync = promisify(exec);",
    "",
    "// ---------------------------------------------------------------------------",
    "// Built-in tools",
    "// ---------------------------------------------------------------------------",
    "",
    "export const readFileTool = tool({",
    '  description: "Read a file from the filesystem",',
    "  parameters: z.object({",
    '    path: z.string().describe("File path to read"),',
    "  }),",
    "  execute: async ({ path }) => {",
    '    return await readFile(path, "utf-8");',
    "  },",
    "});",
    "",
    "export const writeFileTool = tool({",
    '  description: "Write content to a file",',
    "  parameters: z.object({",
    '    path: z.string().describe("File path to write"),',
    '    content: z.string().describe("Content to write"),',
    "  }),",
    "  execute: async ({ path, content }) => {",
    '    await writeFile(path, content, "utf-8");',
    "    return `Written to ${path}`;",
    "  },",
    "});",
    "",
    "export const bashTool = tool({",
    '  description: "Execute a bash command and return its output",',
    "  parameters: z.object({",
    '    command: z.string().describe("The command to execute"),',
    "  }),",
    "  execute: async ({ command }) => {",
    "    const { stdout, stderr } = await execAsync(command, {",
    "      timeout: 30_000,",
    "    });",
    '    return stdout + (stderr ? "\\nSTDERR:\\n" + stderr : "");',
    "  },",
    "});",
    "",
  ];

  // Generate topology-defined tools
  if (ast.toolDefs.length) {
    lines.push(
      "// ---------------------------------------------------------------------------",
      "// Topology-defined tools",
      "// ---------------------------------------------------------------------------",
      "",
    );

    for (const toolDef of ast.toolDefs) {
      const varName = toCamelCase(toolDef.id) + "Tool";
      const params: string[] = [];

      if (toolDef.args?.length) {
        for (const arg of toolDef.args) {
          params.push(`    ${arg}: z.string().describe("${arg}"),`);
        }
      }

      lines.push(
        `export const ${varName} = tool({`,
        `  description: "${escapeQuotes(toolDef.description)}",`,
        "  parameters: z.object({",
        ...params,
        "  }),",
        "  execute: async (input) => {",
        `    // TODO: implement ${toolDef.id}`,
        `    // Original script: ${toolDef.script}`,
        '    return "TODO: implement this tool";',
        "  },",
        "});",
        "",
      );
    }
  }

  // Export all tools as a map
  lines.push(
    "// ---------------------------------------------------------------------------",
    "// Tool registry",
    "// ---------------------------------------------------------------------------",
    "",
    "export const allTools: Record<string, CoreTool> = {",
    "  read_file: readFileTool,",
    "  write_file: writeFileTool,",
    "  bash: bashTool,",
  );

  for (const toolDef of ast.toolDefs) {
    const varName = toCamelCase(toolDef.id) + "Tool";
    lines.push(`  "${toolDef.id}": ${varName},`);
  }

  lines.push("};", "");

  return lines.join("\n");
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

  // Find entry points: agents with no incoming edges
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
        `  // TODO: implement condition logic based on agent output\n` +
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
    if (edge.tolerance !== undefined) parts.push(`tolerance: ${JSON.stringify(edge.tolerance)}`);
    if (edge.per) parts.push(`per: "${edge.per}"`);
    edgeRoutes.push(parts.join(", ") + " },");
  }

  // Generate agent configs
  const agentConfigs: string[] = [];
  for (const agent of agents) {
    const model = mapModel(agent.model);
    const prompt = agent.prompt
      ? escapeString(agent.prompt)
      : `You are ${toTitle(agent.id)}. ${agent.description || agent.role || "Complete the assigned task."}`;

    const parts: string[] = [
      `    "${agent.id}": {`,
      `      id: "${agent.id}",`,
      `      model: "${model}",`,
      `      systemPrompt: \`${prompt}\`,`,
      `      tools: {}, // Assign tools from src/tools.ts`,
      `      maxTurns: ${agent.maxTurns || 10},`,
    ];

    if (agent.temperature !== undefined) parts.push(`      temperature: ${agent.temperature},`);
    if (agent.maxTokens) parts.push(`      maxTokens: ${agent.maxTokens},`);
    if (agent.topP !== undefined) parts.push(`      topP: ${agent.topP},`);
    if (agent.topK !== undefined) parts.push(`      topK: ${agent.topK},`);
    if (agent.stop?.length) parts.push(`      stop: ${JSON.stringify(agent.stop)},`);
    if (agent.timeout) parts.push(`      timeout: ${durationToMs(agent.timeout)},`);
    if (agent.seed !== undefined) parts.push(`      seed: ${agent.seed},`);
    if (agent.thinking) parts.push(`      thinking: "${agent.thinking}",`);
    if (agent.thinkingBudget) parts.push(`      thinkingBudget: ${agent.thinkingBudget},`);
    if (agent.outputFormat) parts.push(`      outputFormat: "${agent.outputFormat}",`);
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

    if (agent.outputSchema?.length) {
      parts.push(`      outputSchema: ${fieldsToZodObject(agent.outputSchema)},`);
    }

    // Build provider options for thinking
    if (agent.thinking && agent.thinking !== "off") {
      const provOpts: string[] = [];
      provOpts.push(`        anthropic: { thinking: { type: "enabled", budgetTokens: ${agent.thinkingBudget || 4096} } }`);
      parts.push(`      providerOptions: {\n${provOpts.join(",\n")}\n      },`);
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

    // Gap #1: skills
    if (agent.skills?.length) {
      parts.push(`      skills: ${JSON.stringify(agent.skills)},`);
    }

    // Gap #2: disallowedTools
    if (agent.disallowedTools?.length) {
      parts.push(`      disallowedTools: ${JSON.stringify(agent.disallowedTools)},`);
    }

    // Gap #3: mcpServers (per-agent)
    if (agent.mcpServers?.length) {
      parts.push(`      mcpServers: ${JSON.stringify(agent.mcpServers)},`);
    }

    // Gap #4: scale
    if (agent.scale) {
      const s = agent.scale;
      const scaleParts = [`mode: "${s.mode}"`, `by: "${s.by}"`, `min: ${s.min}`, `max: ${s.max}`];
      if (s.batchSize) scaleParts.push(`batchSize: ${s.batchSize}`);
      parts.push(`      scale: { ${scaleParts.join(", ")} },`);
    }

    // Gap #5: hooks (per-agent)
    if (agent.hooks?.length) {
      const hookArr = agent.hooks.map((h) => {
        const hParts: string[] = [
          `name: "${escapeQuotes(h.name)}"`,
          `on: "${escapeQuotes(h.on)}"`,
          `matcher: "${escapeQuotes(h.matcher)}"`,
          `run: "${escapeQuotes(h.run)}"`,
        ];
        if (h.type) hParts.push(`type: "${h.type}"`);
        if (h.timeout) hParts.push(`timeout: ${h.timeout}`);
        return `{ ${hParts.join(", ")} }`;
      });
      parts.push(`      hooks: [${hookArr.join(", ")}],`);
    }

    // Gap #6: inputSchema
    if (agent.inputSchema?.length) {
      parts.push(`      inputSchema: ${fieldsToZodObject(agent.inputSchema)},`);
    }

    // Gap #7: outputs
    if (agent.outputs && Object.keys(agent.outputs).length) {
      parts.push(`      outputs: ${JSON.stringify(agent.outputs)},`);
    }

    // Gap #8: behavior
    if (agent.behavior) parts.push(`      behavior: "${escapeQuotes(agent.behavior)}",`);

    // Gap #9: invocation
    if (agent.invocation) parts.push(`      invocation: "${escapeQuotes(agent.invocation)}",`);

    // Gap #10: background
    if (agent.background) parts.push(`      background: true,`);

    // Gap #11: join
    if (agent.join) parts.push(`      join: "${escapeQuotes(agent.join)}",`);

    // Gap #13: produces / consumes
    if (agent.produces?.length) parts.push(`      produces: ${JSON.stringify(agent.produces)},`);
    if (agent.consumes?.length) parts.push(`      consumes: ${JSON.stringify(agent.consumes)},`);

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
      defaultsCode = `\nconst defaults: Partial<AgentConfig> = {\n${defaultParts.join(",\n")}\n};\n`;
    }
  }

  // Build imports
  const imports: string[] = [
    `import { executeAgent } from "./executor.js";`,
    `import { FileMemory } from "./memory.js";`,
    `import type {`,
    `  AgentConfig,`,
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

  // Check if we need rate limiter or variant selector
  const hasRateLimits = agents.some((a) => a.rateLimit);
  const hasVariants = agents.some((a) => a.variants?.length);
  const hasCompensation = agents.some((a) => a.compensates);

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
 * Topology orchestrator — manages the agent flow graph.
 * Auto-generated by agentopology scaffold — edit as needed.
 *
 * Topology: ${ast.topology.name} v${ast.topology.version}
 * ${ast.topology.description || ""}
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
${ast.hooks.length > 0 ? `  globalHooks: [
${ast.hooks.map((h) => `    { name: "${escapeQuotes(h.name)}", on: "${escapeQuotes(h.on)}", matcher: "${escapeQuotes(h.matcher)}", run: "${escapeQuotes(h.run)}", type: "${h.type || "command"}"${h.timeout ? `, timeout: ${h.timeout}` : ""} },`).join("\n")}
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
      return true; // allow one attempt
    }
    return false; // circuit is open, reject
  }

  return true; // closed or half-open, allow
}

function recordCircuitBreakerResult(agentId: string, cbConfig: { threshold: number; window: number; cooldown: number }, failed: boolean): void {
  const state = getCircuitBreakerState(agentId);
  const now = Date.now();

  if (failed) {
    // Reset count if outside window
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
    // Success: close the circuit
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

/** Results collected during a topology run. */
const results = new Map<string, AgentResult>();

/** Edge iteration counts for maxIterations enforcement. */
const edgeIterations = new Map<string, number>();

/**
 * Get the next agents to execute based on edges from the completed agent.
 */
function getNextAgents(completedId: string, result: AgentResult): Array<{ id: string; wait?: number }> {
  const outgoing = config.edges.filter((e) => e.from === completedId);

  if (!outgoing.length) return [];

  // Separate error edges from normal edges
  const errorEdges = outgoing.filter((e) => e.isError);
  const normalEdges = outgoing.filter((e) => !e.isError);

  // If the agent errored, use error edges
  if (result.error && errorEdges.length) {
    return errorEdges
      .filter((e) => !e.errorType || result.error?.includes(e.errorType))
      .map((e) => ({ id: e.to, wait: e.wait }));
  }

  // Check race edges — only first result matters
  const raceEdges = normalEdges.filter((e) => e.race);
  if (raceEdges.length) {
    return raceEdges.map((e) => ({ id: e.to, wait: e.wait }));
  }

  // Weighted routing
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

  // Conditional and maxIterations routing
  return normalEdges
    .filter((e) => {
      // Check maxIterations
      if (e.maxIterations !== undefined) {
        const key = \`\${e.from}->\${e.to}\`;
        const count = edgeIterations.get(key) || 0;
        if (count >= e.maxIterations) return false;
        edgeIterations.set(key, count + 1);
      }
      // Check condition
      return !e.condition || e.condition(result);
    })
    .map((e) => ({ id: e.to, wait: e.wait }));
}

/**
 * Run gate checks around an agent.
 */
async function runGates(agentId: string, position: "before" | "after"): Promise<boolean> {
  for (const [gateId, gate] of Object.entries(config.gates)) {
    const matchesPosition = position === "before"
      ? gate.before === agentId
      : gate.after === agentId;

    if (!matchesPosition) continue;

    if (!gate.run) continue;

    // Execute gate script
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
          console.log(\`  -> Gate "\${gateId}" failed, retry \${attempt + 1}/\${retries}\`);
        }
      }
    }

    if (!passed) {
      const behavior = gate.onFail || "halt";
      console.log(\`  x Gate "\${gateId}" failed (on-fail: \${behavior})\`);
      if (behavior === "halt") return false;
      // "bounce-back" or other behaviors: continue for now
    }
  }

  return true;
}

/**
 * Execute a single agent with retry, fallback chain, and circuit breaker support.
 */
async function runAgent(agentId: string, input: string): Promise<AgentResult> {
  const agentConfig = config.agents[agentId];
  if (!agentConfig) {
    throw new Error(\`Unknown agent: \${agentId}\`);
  }

  // Check skip condition
  if (agentConfig.skip) {
    console.log(\`  ~ Skipping \${agentId}: \${agentConfig.skip}\`);
    return {
      agentId: agentConfig.id,
      output: "[skipped]",
      toolCalls: [],
      tokenUsage: { input: 0, output: 0 },
      durationMs: 0,
    };
  }

  // Check circuit breaker
  if (agentConfig.circuitBreaker) {
    if (!checkCircuitBreaker(agentId, agentConfig.circuitBreaker)) {
      console.log(\`  ! Circuit open for \${agentId}, skipping\`);
      return {
        agentId: agentConfig.id,
        output: "",
        toolCalls: [],
        tokenUsage: { input: 0, output: 0 },
        durationMs: 0,
        error: "Circuit breaker is open",
      };
    }
  }
${hasRateLimits ? `
  // Apply rate limiting
  if (agentConfig.rateLimit) {
    const limiter = getRateLimiter(agentId, agentConfig.rateLimit);
    await limiter.acquire();
  }
` : ""}${hasVariants ? `
  // Apply prompt variant if configured
  if (agentConfig.variants?.length) {
    const selection = selectVariant(agentConfig.variants, agentConfig.systemPrompt);
    agentConfig.systemPrompt = selection.prompt;
    if (selection.temperature !== undefined) agentConfig.temperature = selection.temperature;
    if (selection.model) agentConfig.model = selection.model;
    console.log(\`  ~ Using variant "\${selection.variantId}" for \${agentId}\`);
  }
` : ""}
  // Run "before" gates
  const gatesPassed = await runGates(agentId, "before");
  if (!gatesPassed) {
    const behavior = agentConfig.onFail || "halt";
    if (behavior === "halt") {
      return {
        agentId: agentConfig.id,
        output: "",
        toolCalls: [],
        tokenUsage: { input: 0, output: 0 },
        durationMs: 0,
        error: "Gate check failed before execution",
      };
    }
  }

  const retryMax = agentConfig.retry?.max ?? 0;
  let lastError: string | undefined;

  // Try with primary model first, then fallback chain
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
        console.log(\`  -> Retry \${attempt}/\${retryMax} for \${agentId}\`);
      }

      const result = await executeAgent(configWithModel, input, config.memory);

      if (!result.error) {
        // Run "after" gates
        const afterGatesPassed = await runGates(agentId, "after");
        if (!afterGatesPassed) {
          const behavior = agentConfig.onFail || "halt";
          if (behavior === "halt") {
            result.error = "Gate check failed after execution";
          }
        }

        // Record circuit breaker success
        if (agentConfig.circuitBreaker) {
          recordCircuitBreakerResult(agentId, agentConfig.circuitBreaker, false);
        }

        return result;
      }

      lastError = result.error;
    }

    console.log(\`  ! Model "\${model}" failed for \${agentId}, trying next fallback...\`);
  }

  // All attempts failed
  if (agentConfig.circuitBreaker) {
    recordCircuitBreakerResult(agentId, agentConfig.circuitBreaker, true);
  }

  return {
    agentId: agentConfig.id,
    output: "",
    toolCalls: [],
    tokenUsage: { input: 0, output: 0 },
    durationMs: 0,
    error: lastError,
  };
}

/**
 * Handle onFail behavior for a failed agent.
 * Returns true if topology should continue, false if it should halt.
 */
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
${hasCompensation ? `
/**
 * Run compensation for a failed agent (saga pattern).
 */
async function runCompensation(failedAgentId: string, input: string): Promise<void> {
  // Find agents that compensate the failed agent
  for (const [id, agent] of Object.entries(config.agents)) {
    if (agent.compensates === failedAgentId) {
      console.log(\`  <- Running compensation agent "\${id}" for failed "\${failedAgentId}"\`);
      await runAgent(id, input);
    }
  }
}
` : ""}
/**
 * Run the full topology starting from entry points.
 */
export async function runTopology(input: string): Promise<Map<string, AgentResult>> {
  console.log(\`\\nRunning topology: \${config.name} v\${config.version}\`);
  console.log(\`  Entry points: \${config.entryPoints.join(", ")}\\n\`);
${ast.observability?.enabled ? `
  const tracer = new Tracer(config.observability!);
  const topologySpan = tracer.startSpan("topology:" + config.name);
` : ""}${ast.checkpoint ? `
  const checkpointMgr = new CheckpointManager(config.checkpoint!);
  const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const completedNodes = await checkpointMgr.getCompletedNodes(runId);
` : ""}
  // Sort agents by phase for phase-aware execution
  const phaseAgents = Object.values(config.agents)
    .filter((a) => a.phase !== undefined)
    .sort((a, b) => (a.phase || 0) - (b.phase || 0));

  // Queue of agents to execute with their input
  const queue: Array<{ agentId: string; input: string }> = config.entryPoints.map(
    (id) => ({ agentId: id, input }),
  );

  const visited = new Set<string>();

  // Gap #11: Join semantics — track pending fan-in inputs per agent
  const pendingInputs = new Map<string, { received: string[]; total: number; failed: number }>();

  /**
   * Check join condition for an agent. Returns true if the agent should execute.
   */
  function checkJoinCondition(agentId: string): boolean {
    const agentConfig = config.agents[agentId];
    if (!agentConfig?.join) return true; // No join semantics, proceed immediately

    const incomingEdges = config.edges.filter((e) => e.to === agentId && !e.isError);
    if (incomingEdges.length <= 1) return true; // Single input, no fan-in

    const pending = pendingInputs.get(agentId);
    if (!pending) return false;

    switch (agentConfig.join) {
      case "any":
        return pending.received.length >= 1;
      case "all":
        return pending.received.length + pending.failed >= incomingEdges.length;
      case "all-done":
        return pending.received.length >= incomingEdges.length;
      case "none-failed":
        return pending.failed === 0 && pending.received.length >= incomingEdges.length;
      default:
        return true;
    }
  }

  while (queue.length > 0) {
    // Collect agents that can run in parallel (no dependencies on each other)
    const batch = queue.splice(0, queue.length);
    const batchPromises = batch.map(async ({ agentId, input: agentInput }) => {
      const runKey = agentId;
      if (visited.has(runKey)) return; // prevent infinite loops

      // Gap #11: Check join condition before executing
      if (!checkJoinCondition(agentId)) {
        // Not all fan-in inputs received yet, re-queue
        queue.push({ agentId, input: agentInput });
        return;
      }

      visited.add(runKey);
${ast.checkpoint ? `
      // Skip already-completed nodes on replay
      if (completedNodes.has(agentId)) {
        console.log(\`  ~ Skipping \${agentId} (already checkpointed)\`);
        return;
      }
` : ""}${ast.depth.levels.length ? `
      // Depth filtering — omit agents based on current depth level
      if (shouldOmitAgent(agentId)) {
        console.log(\`  ~ Omitting \${agentId} (depth level \${getDepthLevel()})\`);
        return;
      }
` : ""}
      // Check if this is a group node
      if (config.groups[agentId]) {
        console.log(\`  > Running group: \${agentId}\`);
        const groupResult = await executeGroup(
          config.groups[agentId],
          config.agents,
          agentInput,
          config.memory,
        );
        console.log(\`  + Group \${agentId} completed (\${groupResult.rounds} rounds)\`);
        // Store as an AgentResult for downstream routing
        const groupAgentResult: AgentResult = {
          agentId: agentId as AgentResult["agentId"],
          output: groupResult.finalOutput,
          toolCalls: [],
          tokenUsage: groupResult.totalTokens,
          durationMs: 0,
        };
        results.set(agentId, groupAgentResult);
        const nextAgents = getNextAgents(agentId, groupAgentResult);
        for (const next of nextAgents) {
          if (next.wait) await new Promise((r) => setTimeout(r, next.wait));
          queue.push({ agentId: next.id, input: groupResult.finalOutput });
        }
        return;
      }

      // Check if this is a human node
      if (config.humans[agentId]) {
        console.log(\`  > Waiting for human: \${agentId}\`);
        const humanResult = await executeHuman(config.humans[agentId]);
        if (humanResult.timedOut && config.humans[agentId].onTimeout === "halt") {
          console.log(\`  x Human \${agentId} timed out (halting)\`);
          return;
        }
        const humanAgentResult: AgentResult = {
          agentId: agentId as AgentResult["agentId"],
          output: humanResult.input,
          toolCalls: [],
          tokenUsage: { input: 0, output: 0 },
          durationMs: 0,
        };
        results.set(agentId, humanAgentResult);
        const nextAgents = getNextAgents(agentId, humanAgentResult);
        for (const next of nextAgents) {
          if (next.wait) await new Promise((r) => setTimeout(r, next.wait));
          queue.push({ agentId: next.id, input: humanResult.input });
        }
        return;
      }

      // Check if this is an action node
      if (config.actions[agentId]) {
        console.log(\`  > Running action: \${agentId}\`);
        const actionResult = await executeAction(config.actions[agentId]);
        const actionAgentResult: AgentResult = {
          agentId: agentId as AgentResult["agentId"],
          output: actionResult.stdout,
          toolCalls: [],
          tokenUsage: { input: 0, output: 0 },
          durationMs: 0,
          error: actionResult.error,
        };
        results.set(agentId, actionAgentResult);
        if (actionResult.error) {
          console.log(\`  x Action \${agentId} failed: \${actionResult.error}\`);
        } else {
          console.log(\`  + Action \${agentId} completed\`);
        }
        const nextAgents = getNextAgents(agentId, actionAgentResult);
        for (const next of nextAgents) {
          if (next.wait) await new Promise((r) => setTimeout(r, next.wait));
          queue.push({ agentId: next.id, input: actionResult.stdout || agentInput });
        }
        return;
      }

      // Regular agent execution
      const agentConfig = config.agents[agentId];

      // Gap #9: Skip manual invocation agents in auto-flow
      if (agentConfig?.invocation === "manual") {
        console.log(\`  ~ Skipping \${agentId} (manual invocation only)\`);
        return;
      }

      console.log(\`  > Running: \${agentId}\`);
${ast.observability?.enabled ? `      const agentSpan = tracer.startSpan("agent:" + agentId, topologySpan.spanId);\n` : ""}
      // Gap #4: Handle scale — run multiple instances in parallel
      let result: AgentResult;
      if (agentConfig?.scale && agentConfig.scale.max > 1) {
        const instanceCount = agentConfig.scale.max;
        console.log(\`  ~ Scaling \${agentId} to \${instanceCount} instances (mode: \${agentConfig.scale.mode}, by: \${agentConfig.scale.by})\`);
        const instancePromises = Array.from({ length: instanceCount }, (_, i) =>
          runAgent(agentId, agentInput).then((r) => ({
            ...r,
            agentId: r.agentId,
          }))
        );
        const instanceResults = await Promise.all(instancePromises);
        // Merge results: concatenate outputs, sum tokens
        result = {
          agentId: agentConfig.id,
          output: instanceResults.map((r, i) => \`[instance \${i}] \${r.output}\`).join("\\n"),
          toolCalls: instanceResults.flatMap((r) => r.toolCalls),
          tokenUsage: {
            input: instanceResults.reduce((sum, r) => sum + r.tokenUsage.input, 0),
            output: instanceResults.reduce((sum, r) => sum + r.tokenUsage.output, 0),
          },
          durationMs: Math.max(...instanceResults.map((r) => r.durationMs)),
          error: instanceResults.find((r) => r.error)?.error,
        };
      } else if (agentConfig?.background) {
        // Gap #10: Background execution — fire and forget, don't await
        console.log(\`  ~ Running \${agentId} in background\`);
        runAgent(agentId, agentInput).then((r) => {
          results.set(agentId, r);
          console.log(\`  + [bg] \${agentId} completed (\${r.durationMs}ms)\`);
        }).catch((err) => {
          console.log(\`  x [bg] \${agentId} failed: \${err}\`);
        });
        return; // Don't await, continue flow
      } else {
        result = await runAgent(agentId, agentInput);
      }

      results.set(agentId, result);

      if (result.error) {
        console.log(\`  x \${agentId} failed: \${result.error}\`);
${hasCompensation ? `        await runCompensation(agentId, agentInput);\n` : ""}
        if (!handleOnFail(agentId, result, queue)) {
          return; // halt
        }
      } else {
        console.log(
          \`  + \${agentId} completed (\${result.durationMs}ms, \${result.tokenUsage.input + result.tokenUsage.output} tokens)\`,
        );
      }
${ast.observability?.enabled ? `      agentSpan.attributes["agent.id"] = agentId;
      agentSpan.attributes["agent.tokens.input"] = result.tokenUsage.input;
      agentSpan.attributes["agent.tokens.output"] = result.tokenUsage.output;
      agentSpan.attributes["agent.duration_ms"] = result.durationMs;
      if (result.error) agentSpan.attributes["agent.error"] = result.error;
      tracer.endSpan(agentSpan);
` : ""}${ast.checkpoint ? `      // Checkpoint after node execution
      if (checkpointMgr.shouldSaveAfterNode()) {
        await checkpointMgr.save(runId, config.name, {
          nodeId: agentId,
          result,
          timestamp: Date.now(),
        });
      }
` : ""}
      // Determine next agents
      const nextAgents = getNextAgents(agentId, result);
      for (const next of nextAgents) {
        if (next.wait) {
          await new Promise((r) => setTimeout(r, next.wait));
        }

        // Gap #11: Track fan-in inputs for join semantics
        const nextConfig = config.agents[next.id];
        if (nextConfig?.join) {
          if (!pendingInputs.has(next.id)) {
            pendingInputs.set(next.id, { received: [], total: 0, failed: 0 });
          }
          const pending = pendingInputs.get(next.id)!;
          if (result.error) {
            pending.failed++;
          } else {
            pending.received.push(result.output || input);
          }
          pending.total++;
        }

        queue.push({
          agentId: next.id,
          input: result.output || input,
        });
      }
    });

    await Promise.all(batchPromises);
  }
${ast.observability?.enabled ? `
  tracer.endSpan(topologySpan);
` : ""}
  console.log(\`\\nTopology complete. \${results.size} agents executed.\\n\`);
  return results;
}
`;
}

// ---------------------------------------------------------------------------
// Entry point generator
// ---------------------------------------------------------------------------

function generateIndex(ast: TopologyAST): string {
  const hasSchedules = ast.schedules.length > 0;
  const hasParams = ast.params.length > 0;

  return `/**
 * ${ast.topology.name} — Topology entry point.
 * Auto-generated by agentopology scaffold — edit as needed.
 */

import { runTopology } from "./orchestrator.js";
${hasSchedules ? `import { Scheduler } from "./scheduler.js";\n` : ""}${hasParams ? `import { parseParams } from "./params.js";\n` : ""}
${hasParams ? `// Parse topology parameters from CLI args / env vars
const params = parseParams();
console.log("Topology params:", params);
` : ""}const input = process.argv.slice(2).join(" ") || "Begin the topology execution.";

runTopology(input)
  .then((results) => {
    // Print summary
    for (const [agentId, result] of results) {
      console.log(\`--- \${agentId} ---\`);
      if (result.error) {
        console.log(\`ERROR: \${result.error}\`);
      } else {
        console.log(result.output.slice(0, 500));
      }
      console.log(\`Tokens: \${result.tokenUsage.input}in / \${result.tokenUsage.output}out\`);
      console.log(\`Duration: \${result.durationMs}ms\`);
      console.log(\`Tool calls: \${result.toolCalls.length}\`);
      console.log();
    }
${hasSchedules ? `
    // Start scheduled jobs
    const scheduler = new Scheduler();
${ast.schedules
  .filter((s) => s.enabled)
  .map((s) => {
    if (s.cron) {
      return `    scheduler.addCronJob("${s.id}", "${escapeQuotes(s.cron)}", async () => {
      console.log("Running scheduled job: ${s.id}");
      await runTopology("Scheduled run: ${s.id}");
    });`;
    } else if (s.every) {
      return `    scheduler.addEveryJob("${s.id}", "${s.every}", async () => {
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
` : ""}  })
  .catch((err) => {
    console.error("Topology failed:", err);
    process.exit(1);
  });
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
      category: "script",
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
// Main binding
// ---------------------------------------------------------------------------

function scaffold(ast: TopologyAST): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  // Package config
  files.push({ path: "package.json", content: generatePackageJson(ast), category: "machine" });
  files.push({ path: "tsconfig.json", content: generateTsConfig(), category: "machine" });
  files.push({ path: ".env.example", content: generateEnvExample(ast), category: "machine" });

  // Source files
  files.push({ path: "src/types.ts", content: generateTypes(ast), category: "machine" });
  files.push({ path: "src/client.ts", content: generateClient(ast), category: "machine" });
  files.push({ path: "src/memory.ts", content: generateMemory(), category: "machine" });
  files.push({ path: "src/executor.ts", content: generateAgentExecutor(), category: "machine" });
  files.push({ path: "src/orchestrator.ts", content: generateOrchestrator(ast), category: "machine" });
  files.push({ path: "src/tools.ts", content: generateToolsIndex(ast), category: "machine" });
  files.push({ path: "src/schemas.ts", content: generateSchemas(ast), category: "machine" });
  files.push({ path: "src/index.ts", content: generateIndex(ast), category: "machine" });

  // Executor files
  files.push({ path: "src/group-executor.ts", content: generateGroupExecutor(), category: "machine" });
  files.push({ path: "src/human-executor.ts", content: generateHumanExecutor(), category: "machine" });
  files.push({ path: "src/action-executor.ts", content: generateActionExecutor(), category: "machine" });

  // Infrastructure files
  files.push({ path: "src/observability.ts", content: generateObservability(), category: "machine" });
  files.push({ path: "src/checkpoint.ts", content: generateCheckpoint(), category: "machine" });
  files.push({ path: "src/scheduler.ts", content: generateScheduler(), category: "machine" });
  files.push({ path: "src/rate-limiter.ts", content: generateRateLimiter(), category: "machine" });
  files.push({ path: "src/circuit-breaker.ts", content: generateCircuitBreaker(), category: "machine" });
  files.push({ path: "src/permissions.ts", content: generatePermissions(), category: "machine" });
  files.push({ path: "src/metering.ts", content: generateMeteringFile(ast), category: "machine" });
  files.push({ path: "src/variants.ts", content: generateVariantSelector(), category: "machine" });

  // Artifacts
  files.push({ path: "src/artifacts.ts", content: generateArtifacts(ast), category: "machine" });

  // Depth
  files.push({ path: "src/depth.ts", content: generateDepth(ast), category: "machine" });

  // Params
  files.push({ path: "src/params.ts", content: generateParams(ast), category: "machine" });

  // Interface endpoints
  if (ast.interfaceEndpoints) {
    files.push({ path: "src/interface.ts", content: generateInterfaceEndpoints(ast), category: "machine" });
  }

  // Imports and includes
  if (ast.imports.length || ast.includes.length) {
    files.push({ path: "src/topology-imports.ts", content: generateImportsAndIncludes(ast), category: "machine" });
  }

  // Gate scripts
  files.push(...generateGateScripts(ast));

  // Memory directory
  files.push({ path: ".memory/.gitkeep", content: "", category: "machine" });

  // Checkpoint directory
  files.push({ path: ".checkpoint/.gitkeep", content: "", category: "machine" });

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
    category: "machine",
  });

  return deduplicateFiles(files);
}

export const vercelAiBinding: BindingTarget = {
  name: "vercel-ai",
  description:
    "Vercel AI SDK — compiles topology to multi-provider TypeScript agents with generateText/generateObject, Zod tool schemas, and provider registry",
  scaffold,
};
