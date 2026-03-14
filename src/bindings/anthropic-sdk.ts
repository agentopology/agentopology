/**
 * Anthropic SDK binding — the engine binding.
 *
 * Unlike CLI bindings that generate config files, this binding compiles a
 * {@link TopologyAST} into **runnable TypeScript code** that orchestrates
 * agents via the Anthropic Messages API with tool use.
 *
 * Output: a self-contained Node.js project with:
 *   - An orchestrator that manages the agent flow graph
 *   - Per-agent executors using the Messages API
 *   - File-based memory (markdown read/write)
 *   - Tool definitions compiled from the topology
 *   - Edge routing with conditions, error handling, and fan-out
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
  if (!model) return "claude-sonnet-4-5-20250514";
  const m = model.toLowerCase();
  // Anthropic model aliases
  if (m === "opus" || m === "claude-opus") return "claude-opus-4-0-20250514";
  if (m === "sonnet" || m === "claude-sonnet") return "claude-sonnet-4-5-20250514";
  if (m === "haiku" || m === "claude-haiku") return "claude-haiku-4-5-20251001";
  // Pass through full model ids
  if (m.startsWith("claude-")) return model;
  // Default for unknown
  return "claude-sonnet-4-5-20250514";
}

// ---------------------------------------------------------------------------
// Code generators
// ---------------------------------------------------------------------------

function generatePackageJson(ast: TopologyAST): string {
  const name = ast.topology.name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
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
      dependencies: {
        "@anthropic-ai/sdk": "^0.39.0",
      },
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

  // Always need the API key
  lines.push("ANTHROPIC_API_KEY=your-api-key-here");

  // Provider-specific keys
  for (const provider of ast.providers) {
    if (provider.apiKey) {
      const envVar = provider.apiKey.replace(/^\$\{/, "").replace(/\}$/, "");
      if (envVar !== "ANTHROPIC_API_KEY") {
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
    'import Anthropic from "@anthropic-ai/sdk";',
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
    "// Tool definition",
    "// ---------------------------------------------------------------------------",
    "",
    "export interface ToolDefinition {",
    "  name: string;",
    "  description: string;",
    "  input_schema: Record<string, unknown>;",
    "  execute: (input: Record<string, unknown>) => Promise<string>;",
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
    "  tools: ToolDefinition[];",
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
 * Agent executor — runs a single agent through the Messages API agentic loop.
 * Auto-generated by agentopology scaffold — edit as needed.
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  AgentConfig,
  AgentResult,
  ToolCallRecord,
  ToolDefinition,
  MemoryStore,
} from "./types.js";

const client = new Anthropic();

export async function executeAgent(
  config: AgentConfig,
  input: string,
  memory: MemoryStore,
): Promise<AgentResult> {
  const startTime = Date.now();
  const toolCalls: ToolCallRecord[] = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

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

  // Build tool definitions for the API
  const tools: Anthropic.Messages.Tool[] = config.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as Anthropic.Messages.Tool.InputSchema,
  }));

  // Build memory tools if the agent has write access
  if (config.memoryWrites?.length) {
    tools.push({
      name: "memory_write",
      description: \`Write to memory. Allowed keys: \${config.memoryWrites.join(", ")}\`,
      input_schema: {
        type: "object" as const,
        properties: {
          key: { type: "string", description: "Memory key to write to" },
          value: { type: "string", description: "Content to write" },
        },
        required: ["key", "value"],
      },
    });
  }

  // If structured output is requested, add it as a forced tool
  if (config.outputSchema) {
    tools.push({
      name: "structured_output",
      description: "Return your response as structured data matching the required schema.",
      input_schema: config.outputSchema as Anthropic.Messages.Tool.InputSchema,
    });
  }

  const messages: Anthropic.Messages.MessageParam[] = [
    { role: "user", content: input },
  ];

  let turn = 0;
  const maxTurns = config.maxTurns || 10;

  // Create request params
  const baseParams: Record<string, unknown> = {
    model: config.model,
    max_tokens: config.maxTokens || 4096,
    system: systemPrompt,
    ...(tools.length > 0 && { tools }),
    ...(config.temperature !== undefined && { temperature: config.temperature }),
    ...(config.topP !== undefined && { top_p: config.topP }),
    ...(config.topK !== undefined && { top_k: config.topK }),
    ...(config.stop?.length && { stop_sequences: config.stop }),
    ...(config.seed !== undefined && { metadata: { user_id: String(config.seed) } }),
  };

  // Add extended thinking support
  if (config.thinking && config.thinking !== "off") {
    (baseParams as Record<string, unknown>).thinking = {
      type: "enabled",
      budget_tokens: config.thinkingBudget || 4096,
    };
    // Thinking requires removing temperature
    delete (baseParams as Record<string, unknown>).temperature;
  }

  // Add output format
  if (config.outputFormat === "json") {
    (baseParams as Record<string, unknown>).response_format = { type: "json" };
  }

  // Force structured output tool if outputSchema is set
  if (config.outputSchema) {
    (baseParams as Record<string, unknown>).tool_choice = {
      type: "tool",
      name: "structured_output",
    };
  }

  while (turn < maxTurns) {
    turn++;

    let response: Anthropic.Messages.Message;

    try {
      const apiCall = client.messages.create({
        ...baseParams,
        messages,
      } as Anthropic.Messages.MessageCreateParams);

      // Wrap in timeout if configured
      if (config.timeout) {
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Agent execution timed out")), config.timeout)
        );
        response = await Promise.race([apiCall, timeoutPromise]);
      } else {
        response = await apiCall;
      }
    } catch (err) {
      return {
        agentId: config.id,
        output: "",
        toolCalls,
        tokenUsage: { input: totalInputTokens, output: totalOutputTokens },
        durationMs: Date.now() - startTime,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    totalInputTokens += response.usage.input_tokens;
    totalOutputTokens += response.usage.output_tokens;

    // If the model is done (no tool use), extract text and return
    if (response.stop_reason === "end_turn" || response.stop_reason === "max_tokens") {
      const textBlocks = response.content.filter(
        (b): b is Anthropic.Messages.TextBlock => b.type === "text",
      );
      const output = textBlocks.map((b) => b.text).join("\\n");
      return {
        agentId: config.id,
        output,
        toolCalls,
        tokenUsage: { input: totalInputTokens, output: totalOutputTokens },
        durationMs: Date.now() - startTime,
      };
    }

    // Handle tool use
    if (response.stop_reason === "tool_use") {
      // Add assistant response to conversation
      messages.push({ role: "assistant", content: response.content });

      const toolUseBlocks = response.content.filter(
        (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
      );

      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];

      for (const block of toolUseBlocks) {
        let result: string;
        let isError = false;

        // Handle structured output tool — just return the input as JSON
        if (block.name === "structured_output") {
          result = JSON.stringify(block.input);
        } else if (block.name === "memory_write") {
          // Handle memory writes
          const inp = block.input as { key: string; value: string };
          if (config.memoryWrites?.includes(inp.key)) {
            await memory.write(inp.key, inp.value);
            result = \`Written to memory key: \${inp.key}\`;
          } else {
            result = \`Error: not allowed to write to key "\${inp.key}". Allowed: \${config.memoryWrites?.join(", ")}\`;
            isError = true;
          }
        } else {
          // Find and execute the tool
          const tool = config.tools.find((t) => t.name === block.name);
          if (tool) {
            try {
              result = await tool.execute(block.input as Record<string, unknown>);
            } catch (err) {
              result = \`Error: \${err instanceof Error ? err.message : String(err)}\`;
              isError = true;
            }
          } else {
            result = \`Error: unknown tool "\${block.name}"\`;
            isError = true;
          }
        }

        toolCalls.push({
          name: block.name,
          input: block.input as Record<string, unknown>,
          output: result,
          isError,
        });

        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: result,
          ...(isError && { is_error: true }),
        });
      }

      messages.push({ role: "user", content: toolResults });
    }
  }

  // Max turns reached — extract whatever we have
  const lastAssistant = messages.findLast((m) => m.role === "assistant");
  let output = "[max turns reached]";
  if (lastAssistant && Array.isArray(lastAssistant.content)) {
    const textBlocks = (lastAssistant.content as Anthropic.Messages.ContentBlock[]).filter(
      (b): b is Anthropic.Messages.TextBlock => b.type === "text",
    );
    if (textBlocks.length) {
      output = textBlocks.map((b) => b.text).join("\\n");
    }
  }

  return {
    agentId: config.id,
    output,
    toolCalls,
    tokenUsage: { input: totalInputTokens, output: totalOutputTokens },
    durationMs: Date.now() - startTime,
  };
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

import Anthropic from "@anthropic-ai/sdk";
import { executeAgent } from "./executor.js";
import type {
  AgentConfig,
  AgentMessage,
  GroupChatConfig,
  GroupResult,
  MemoryStore,
} from "./types.js";

const client = new Anthropic();

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
      // Use a lightweight Claude call to pick the next speaker
      const historyText = conversationHistory
        .map((m) => \`[\${m.agentId || "user"}]: \${m.content}\`)
        .join("\\n");

      const response = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 50,
        system: "You are a conversation moderator. Pick the next speaker from the available members. Respond with ONLY the member id, nothing else.",
        messages: [
          {
            role: "user",
            content: \`Available members: \${members.join(", ")}\\n\\nConversation so far:\\n\${historyText}\\n\\nWho should speak next?\`,
          },
        ],
      });

      const textBlock = response.content.find(
        (b): b is Anthropic.Messages.TextBlock => b.type === "text",
      );
      const selected = textBlock?.text.trim() || "";

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
 * Observability — OpenTelemetry-style tracing for topology execution.
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
    for (const [id, job] of this.jobs) {
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

  // Build adjacency map
  const edgesByFrom = new Map<string, EdgeDef[]>();
  for (const edge of ast.edges) {
    const list = edgesByFrom.get(edge.from) || [];
    list.push(edge);
    edgesByFrom.set(edge.from, list);
  }

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
      `      tools: [], // Add tools in src/tools/`,
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
      parts.push(`      outputSchema: ${fieldsToJsonSchema(agent.outputSchema)},`);
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

  // Build global hooks config
  let hooksConfig = "";
  if (ast.hooks.length > 0) {
    const hookParts: string[] = [];
    for (const hook of ast.hooks) {
      hookParts.push(`  {
    name: "${hook.name}",
    on: "${hook.on}",
    matcher: "${escapeQuotes(hook.matcher)}",
    run: "${escapeQuotes(hook.run)}",
    type: "${hook.type || "command"}",
    ${hook.timeout ? `timeout: ${hook.timeout},` : ""}
  }`);
    }
    hooksConfig = `\nconst globalHooks = [\n${hookParts.join(",\n")}\n];\n`;
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
  const hasFallbackChain = agents.some((a) => a.fallbackChain?.length);

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
          console.log(\`  ↻ Gate "\${gateId}" failed, retry \${attempt + 1}/\${retries}\`);
        }
      }
    }

    if (!passed) {
      const behavior = gate.onFail || "halt";
      console.log(\`  ✗ Gate "\${gateId}" failed (on-fail: \${behavior})\`);
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
    console.log(\`  ⊘ Skipping \${agentId}: \${agentConfig.skip}\`);
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
      console.log(\`  ⚡ Circuit open for \${agentId}, skipping\`);
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
    console.log(\`  ⚄ Using variant "\${selection.variantId}" for \${agentId}\`);
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
        console.log(\`  ↻ Retry \${attempt}/\${retryMax} for \${agentId}\`);
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

    console.log(\`  ⚠ Model "\${model}" failed for \${agentId}, trying next fallback...\`);
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
      console.log(\`  ↩ Running compensation agent "\${id}" for failed "\${failedAgentId}"\`);
      await runAgent(id, input);
    }
  }
}
` : ""}
/**
 * Run the full topology starting from entry points.
 */
export async function runTopology(input: string): Promise<Map<string, AgentResult>> {
  console.log(\`\\n⚡ Running topology: \${config.name} v\${config.version}\`);
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

  while (queue.length > 0) {
    // Collect agents that can run in parallel (no dependencies on each other)
    const batch = queue.splice(0, queue.length);
    const batchPromises = batch.map(async ({ agentId, input: agentInput }) => {
      const runKey = agentId;
      if (visited.has(runKey)) return; // prevent infinite loops
      visited.add(runKey);
${ast.checkpoint ? `
      // Skip already-completed nodes on replay
      if (completedNodes.has(agentId)) {
        console.log(\`  ⟳ Skipping \${agentId} (already checkpointed)\`);
        return;
      }
` : ""}${ast.depth.levels.length ? `
      // Depth filtering — omit agents based on current depth level
      if (shouldOmitAgent(agentId)) {
        console.log(\`  ⊘ Omitting \${agentId} (depth level \${getDepthLevel()})\`);
        return;
      }
` : ""}
      // Check if this is a group node
      if (config.groups[agentId]) {
        console.log(\`  ▶ Running group: \${agentId}\`);
        const groupResult = await executeGroup(
          config.groups[agentId],
          config.agents,
          agentInput,
          config.memory,
        );
        console.log(\`  ✓ Group \${agentId} completed (\${groupResult.rounds} rounds)\`);
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
        console.log(\`  ▶ Waiting for human: \${agentId}\`);
        const humanResult = await executeHuman(config.humans[agentId]);
        if (humanResult.timedOut && config.humans[agentId].onTimeout === "halt") {
          console.log(\`  ✗ Human \${agentId} timed out (halting)\`);
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
        console.log(\`  ▶ Running action: \${agentId}\`);
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
          console.log(\`  ✗ Action \${agentId} failed: \${actionResult.error}\`);
        } else {
          console.log(\`  ✓ Action \${agentId} completed\`);
        }
        const nextAgents = getNextAgents(agentId, actionAgentResult);
        for (const next of nextAgents) {
          if (next.wait) await new Promise((r) => setTimeout(r, next.wait));
          queue.push({ agentId: next.id, input: actionResult.stdout || agentInput });
        }
        return;
      }

      // Regular agent execution
      console.log(\`  ▶ Running: \${agentId}\`);
${ast.observability?.enabled ? `      const agentSpan = tracer.startSpan("agent:" + agentId, topologySpan.spanId);\n` : ""}      const result = await runAgent(agentId, agentInput);
      results.set(agentId, result);

      if (result.error) {
        console.log(\`  ✗ \${agentId} failed: \${result.error}\`);
${hasCompensation ? `        await runCompensation(agentId, agentInput);\n` : ""}
        if (!handleOnFail(agentId, result, queue)) {
          return; // halt
        }
      } else {
        console.log(
          \`  ✓ \${agentId} completed (\${result.durationMs}ms, \${result.tokenUsage.input + result.tokenUsage.output} tokens)\`,
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
  console.log(\`\\n✓ Topology complete. \${results.size} agents executed.\\n\`);
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
// Tools generator
// ---------------------------------------------------------------------------

function generateToolsIndex(ast: TopologyAST): string {
  const lines: string[] = [
    "/**",
    " * Tool definitions for the topology runtime.",
    " * Auto-generated by agentopology scaffold — edit as needed.",
    " */",
    "",
    'import type { ToolDefinition } from "./types.js";',
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
    "export const readFileTool: ToolDefinition = {",
    '  name: "read_file",',
    '  description: "Read a file from the filesystem",',
    "  input_schema: {",
    '    type: "object",',
    "    properties: {",
    '      path: { type: "string", description: "File path to read" },',
    "    },",
    '    required: ["path"],',
    "  },",
    "  async execute(input) {",
    '    return await readFile(input.path as string, "utf-8");',
    "  },",
    "};",
    "",
    "export const writeFileTool: ToolDefinition = {",
    '  name: "write_file",',
    '  description: "Write content to a file",',
    "  input_schema: {",
    '    type: "object",',
    "    properties: {",
    '      path: { type: "string", description: "File path to write" },',
    '      content: { type: "string", description: "Content to write" },',
    "    },",
    '    required: ["path", "content"],',
    "  },",
    "  async execute(input) {",
    '    await writeFile(input.path as string, input.content as string, "utf-8");',
    "    return `Written to ${input.path}`;",
    "  },",
    "};",
    "",
    "export const bashTool: ToolDefinition = {",
    '  name: "bash",',
    '  description: "Execute a bash command and return its output",',
    "  input_schema: {",
    '    type: "object",',
    "    properties: {",
    '      command: { type: "string", description: "The command to execute" },',
    "    },",
    '    required: ["command"],',
    "  },",
    "  async execute(input) {",
    "    const { stdout, stderr } = await execAsync(input.command as string, {",
    "      timeout: 30_000,",
    "    });",
    '    return stdout + (stderr ? "\\nSTDERR:\\n" + stderr : "");',
    "  },",
    "};",
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

    for (const tool of ast.toolDefs) {
      const varName = toCamelCase(tool.id) + "Tool";
      lines.push(
        `export const ${varName}: ToolDefinition = {`,
        `  name: "${tool.id}",`,
        `  description: "${escapeQuotes(tool.description)}",`,
        "  input_schema: {",
        '    type: "object",',
        "    properties: {",
      );

      if (tool.args?.length) {
        for (const arg of tool.args) {
          lines.push(`      ${arg}: { type: "string", description: "${arg}" },`);
        }
      }

      lines.push(
        "    },",
        `    required: ${JSON.stringify(tool.args || [])},`,
        "  },",
        "  async execute(input) {",
        `    // TODO: implement ${tool.id}`,
        `    // Original script: ${tool.script}`,
        '    return "TODO: implement this tool";',
        "  },",
        "};",
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
    "export const allTools: Record<string, ToolDefinition> = {",
    "  read_file: readFileTool,",
    "  write_file: writeFileTool,",
    "  bash: bashTool,",
  );

  for (const tool of ast.toolDefs) {
    const varName = toCamelCase(tool.id) + "Tool";
    lines.push(`  "${tool.id}": ${varName},`);
  }

  lines.push("};", "");

  return lines.join("\n");
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

  // Build producer/consumer maps from agent nodes
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

/** Map of artifact id -> agent ids that produce it. */
export const artifactProducers: Record<string, string[]> = ${JSON.stringify(producerMap, null, 2)};

/** Map of artifact id -> agent ids that consume it. */
export const artifactConsumers: Record<string, string[]> = ${JSON.stringify(consumerMap, null, 2)};

/** Track which artifacts have been produced in this run. */
const producedArtifacts = new Set<string>();

export function markProduced(artifactId: string): void {
  producedArtifacts.add(artifactId);
}

export function isProduced(artifactId: string): boolean {
  return producedArtifacts.has(artifactId);
}

export function getProducedArtifacts(): string[] {
  return [...producedArtifacts];
}
`;
}

// ---------------------------------------------------------------------------
// Depth generator
// ---------------------------------------------------------------------------

function generateDepth(ast: TopologyAST): string {
  const depth = ast.depth;
  if (!depth.levels.length) return `/** No depth levels defined. */\nexport function shouldOmitAgent(_agentId: string): boolean { return false; }\nexport function getDepthLevel(): number { return 0; }\n`;

  const levelsJson = JSON.stringify(depth.levels, null, 2);

  return `/**
 * Depth configuration — controls which agents to omit at each depth level.
 * Auto-generated by agentopology scaffold — edit as needed.
 *
 * Factors: ${depth.factors.join(", ") || "none"}
 * Set depth via TOPOLOGY_DEPTH env var or --depth CLI arg.
 */

export interface DepthLevel {
  level: number;
  label: string;
  omit: string[];
}

export const depthFactors: string[] = ${JSON.stringify(depth.factors)};

export const depthLevels: DepthLevel[] = ${levelsJson};

/**
 * Get the current depth level from env or CLI args.
 */
export function getDepthLevel(): number {
  // Check CLI args: --depth=N or --depth N
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--depth=")) return parseInt(args[i].split("=")[1], 10) || 0;
    if (args[i] === "--depth" && args[i + 1]) return parseInt(args[i + 1], 10) || 0;
  }
  // Check env var
  if (process.env.TOPOLOGY_DEPTH) return parseInt(process.env.TOPOLOGY_DEPTH, 10) || 0;
  return 0;
}

/**
 * Check if an agent should be omitted at the current depth level.
 */
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

/**
 * Parse topology parameters from CLI args (--name=value) and env vars (TOPOLOGY_PARAM_NAME).
 */
export function parseParams(): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const args = process.argv.slice(2);

  for (const def of paramDefs) {
    let raw: string | undefined;

    // CLI args: --name=value or --name value
    for (let i = 0; i < args.length; i++) {
      if (args[i] === \`--\${def.name}\` && args[i + 1]) { raw = args[i + 1]; break; }
      if (args[i].startsWith(\`--\${def.name}=\`)) { raw = args[i].split("=").slice(1).join("="); break; }
    }

    // Env var fallback: TOPOLOGY_PARAM_<NAME>
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
      const parts: string[] = [`source: "${imp.source}"`, `alias: "${imp.alias}"`];
      if (imp.sha256) parts.push(`sha256: "${imp.sha256}"`);
      if (imp.registry) parts.push(`registry: true`);
      if (Object.keys(imp.params).length) parts.push(`params: ${JSON.stringify(imp.params)}`);
      lines.push(`// import ${imp.alias} from "${imp.source}" — ${parts.join(", ")}`);
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

  const groups = ast.nodes.filter((n): n is GroupNode => n.type === "group");
  const humans = ast.nodes.filter((n): n is HumanNode => n.type === "human");
  const actions = ast.nodes.filter((n): n is ActionNode => n.type === "action");
  const agents = ast.nodes.filter((n): n is AgentNode => n.type === "agent");
  const hasRateLimits = agents.some((a) => a.rateLimit);
  const hasVariants = agents.some((a) => a.variants?.length);

  // Package config
  files.push({ path: "package.json", content: generatePackageJson(ast), category: "machine" });
  files.push({ path: "tsconfig.json", content: generateTsConfig(), category: "machine" });
  files.push({ path: ".env.example", content: generateEnvExample(ast), category: "machine" });

  // Source files
  files.push({ path: "src/types.ts", content: generateTypes(ast), category: "machine" });
  files.push({ path: "src/memory.ts", content: generateMemory(), category: "machine" });
  files.push({ path: "src/executor.ts", content: generateAgentExecutor(), category: "machine" });
  files.push({ path: "src/orchestrator.ts", content: generateOrchestrator(ast), category: "machine" });
  files.push({ path: "src/tools.ts", content: generateToolsIndex(ast), category: "machine" });
  files.push({ path: "src/index.ts", content: generateIndex(ast), category: "machine" });

  // New executor files
  files.push({ path: "src/group-executor.ts", content: generateGroupExecutor(), category: "machine" });
  files.push({ path: "src/human-executor.ts", content: generateHumanExecutor(), category: "machine" });
  files.push({ path: "src/action-executor.ts", content: generateActionExecutor(), category: "machine" });

  // Observability
  files.push({ path: "src/observability.ts", content: generateObservability(), category: "machine" });

  // Checkpoint
  files.push({ path: "src/checkpoint.ts", content: generateCheckpoint(), category: "machine" });

  // Scheduler
  files.push({ path: "src/scheduler.ts", content: generateScheduler(), category: "machine" });

  // Rate limiter
  files.push({ path: "src/rate-limiter.ts", content: generateRateLimiter(), category: "machine" });

  // Variant selector
  files.push({ path: "src/variants.ts", content: generateVariantSelector(), category: "machine" });

  // Artifacts
  files.push({ path: "src/artifacts.ts", content: generateArtifacts(ast), category: "machine" });

  // Depth
  files.push({ path: "src/depth.ts", content: generateDepth(ast), category: "machine" });

  // Metering
  files.push({ path: "src/metering.ts", content: generateMetering(ast), category: "machine" });

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

export const anthropicSdkBinding: BindingTarget = {
  name: "anthropic-sdk",
  description:
    "Anthropic Messages API — compiles topology to runnable TypeScript agents with tool use, memory, and flow orchestration",
  scaffold,
};
