/**
 * OpenAI Codex CLI binding.
 *
 * Generates `.codex/config.toml`, `AGENTS.md`, and supporting scripts
 * from a parsed {@link TopologyAST}.
 *
 * Codex CLI uses TOML-based configuration and reads markdown instruction
 * files. Multi-agent topologies generate per-agent TOML files under
 * `.codex/agents/<name>.toml` and an `[agents]` section in config.toml.
 * AGENTS.md provides a high-level topology overview with references to
 * individual agent TOML files.
 *
 * @module
 */

import { warnSessionsNotCompiled } from "./lib/session.js";
import type {
  TopologyAST,
  AgentNode,
  ActionNode,
  GateNode,
  GroupNode,
  HumanNode,
  OrchestratorNode,
  HookDef,
  InterfaceDef,
  ScheduleJobDef,
  SkillDef,
  ToolBlockDef,
  SchemaFieldDef,
  SchemaType,
  RetryConfig,
  CircuitBreakerConfig,

  SensitiveValue,
} from "../parser/ast.js";
import { deduplicateFiles } from "./types.js";
import type { BindingTarget, GeneratedFile } from "./types.js";
import { shellStub } from "./lib/stub.js";
import { PROMPT_FENCE_OPEN, PROMPT_FENCE_CLOSE } from "./lib/prompt-fence.js";
import { tomlString, tomlStringArray, tomlTable, tomlKey, tomlMultiline } from "./lib/toml.js";
import { APPROVAL_POLICIES, PROJECT_FORBIDDEN_KEYS, SANDBOX_MODES, isClaudeModelName } from "../conformance/codex.js";
import { codexWarnings } from "../parser/validator.js";
import { BindingRefusal } from "./types.js";

/** Markers around the generated part of AGENTS.md; text outside them is the user's. */
export const AGENTS_MD_BEGIN = "<!-- agentopology:begin (generated; edit outside these markers) -->";
export const AGENTS_MD_END = "<!-- /agentopology:end -->";
import { gateAnchors } from "../parser/ast.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


/** Convert a kebab-case id to Title Case. */
function toTitle(id: string): string {
  return id
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Permission words that mean "never ask": Codex `never`. */
const NEVER_ASK = new Set(["never", "unrestricted", "full-auto", "bypassPermissions"]);

/**
 * Map topology permission strings to Codex approval_policy values.
 *
 * Codex 0.156.1 takes `on-request` and `never` (and a `granular` table).
 * `untrusted` is unsupported and `on-failure` is deprecated, so every word
 * that is not "never ask" becomes `on-request`, the policy that still asks.
 */
function mapApprovalPolicy(perm: string): string {
  return NEVER_ASK.has(perm) ? "never" : "on-request";
}

/**
 * One approval policy for the whole project: Codex has one per config, not
 * one per agent. The strictest agent wins (`on-request` over `never`).
 */
function projectApprovalPolicy(agents: AgentNode[]): string {
  const policies = agents.map((a) => mapApprovalPolicy(a.permissions ?? "autonomous"));
  if (policies.length === 0) return "on-request";
  return policies.includes("on-request") ? "on-request" : "never";
}

/** Generate an empty directory marker (a .gitkeep file). */
function gitkeep(dirPath: string): GeneratedFile {
  return { path: `${dirPath}/.gitkeep`, content: "", category: "machine" };
}

/** Format a SchemaType to a human-readable string. */
function formatSchemaType(t: SchemaType): string {
  switch (t.kind) {
    case "primitive":
      return t.value;
    case "array":
      return `${formatSchemaType(t.itemType)}[]`;
    case "enum":
      return t.values.join(" | ");
    case "ref":
      return t.name;
  }
}

/** Format a SchemaFieldDef to a readable line. */
function formatSchemaField(f: SchemaFieldDef): string {
  const opt = f.optional ? "?" : "";
  return `- ${f.name}${opt}: ${formatSchemaType(f.type)}`;
}

/** Format a RetryConfig to a readable string. */
function formatRetryConfig(retry: number | RetryConfig): string {
  if (typeof retry === "number") return String(retry);
  const parts: string[] = [`max ${retry.max}`];
  if (retry.backoff) parts.push(`backoff ${retry.backoff}`);
  if (retry.interval) parts.push(`interval ${retry.interval}`);
  if (retry.maxInterval) parts.push(`max-interval ${retry.maxInterval}`);
  if (retry.jitter) parts.push("jitter");
  if (retry.nonRetryable && retry.nonRetryable.length > 0) {
    parts.push(`non-retryable: ${retry.nonRetryable.join(", ")}`);
  }
  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// TOML generation — .codex/config.toml
// ---------------------------------------------------------------------------

/** Warnings collected during one scaffold; flushed (printed once each) at the end of it. */
let pendingWarnings: string[] = [];
function codexWarn(message: string): void {
  if (!pendingWarnings.includes(message)) pendingWarnings.push(message);
}

/** MCP keys Codex does not have; dropped. `type` is a Claude Code key. */
const MCP_DROPPED_KEYS = new Set(["type"]);

const MCP_NUMBER_KEYS = new Set(["startup_timeout_sec", "tool_timeout_sec"]);
const MCP_BOOLEAN_KEYS = new Set(["enabled", "required"]);
const MCP_LIST_KEYS = new Set(["args", "enabled_tools", "disabled_tools", "env_vars"]);

/** The parser reads every MCP field as text; give Codex the type it expects for the keys it types. */
function mcpValue(key: string, value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (MCP_NUMBER_KEYS.has(key) && /^\d+(\.\d+)?$/.test(value.trim())) return Number(value);
  if (MCP_BOOLEAN_KEYS.has(key) && /^(true|false)$/.test(value.trim())) return value.trim() === "true";
  if (MCP_LIST_KEYS.has(key) && /^\[.*\]$/s.test(value.trim())) {
    return value.trim().slice(1, -1).split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter((x) => x !== "");
  }
  return value;
}

/** An extension or config key written the way Codex spells it (snake_case). */
function snakeKey(key: string): string {
  return key.replace(/-/g, "_");
}

/**
 * Generate the main `.codex/config.toml` configuration file.
 *
 * Top-level scalars come first and every table after them, so no key can land
 * inside the wrong table. Only keys Codex 0.156.1 knows are written; a key a
 * project config may not set (providers, notify, profiles, otel) is dropped
 * with a warning, because Codex would ignore it.
 */
function generateCodexToml(ast: TopologyAST): GeneratedFile {
  const header = ["# Codex CLI configuration", "# Auto-generated by agentopology scaffold — edit as needed.", ""];
  const scalars: Record<string, string | number | boolean> = {};
  const tables: string[] = [];

  const orchestrator = ast.nodes.find((n) => n.type === "orchestrator");
  const agents = ast.nodes.filter((n) => n.type === "agent") as AgentNode[];
  const primaryModel = (orchestrator as any)?.model ?? agents[0]?.model;
  if (primaryModel) scalars.model = primaryModel;

  // One policy for the project: the strictest agent's (the spec default for an omitted `permissions` is `autonomous`).
  scalars.approval_policy = projectApprovalPolicy(agents);
  const distinct = new Set(agents.map((a) => mapApprovalPolicy(a.permissions ?? "autonomous")));
  if (distinct.size > 1) {
    codexWarn(`[codex] agents differ in permissions; Codex has one approval_policy per project, so the strictest ("${scalars.approval_policy}") applies to all`);
  }

  const ext = getTopologyExtensions(ast);

  // Sandbox — first-class AST field, then extension, then derived.
  const topSandbox = ast.settings?.sandbox;
  const sandboxType = topSandbox != null
    ? (typeof topSandbox === "boolean" ? (topSandbox ? "read-only" : "danger-full-access") : mapSandboxMode(String(topSandbox)))
    : ext?.sandbox_type ?? ext?.["sandbox-type"] ?? deriveSandboxType(ast);
  if (sandboxType) scalars.sandbox_mode = String(sandboxType);

  // Extension keys: scalars at the top level (an extension wins over a derived value),
  // never a key Codex lacks or a project config may not set.
  if (ext) {
    const handled = new Set(["sandbox_type", "sandbox-type", "providers", "history", "disable_response_storage", "disable-response-storage"]);
    for (const [rawKey, value] of Object.entries(ext)) {
      if (handled.has(rawKey)) continue;
      const key = snakeKey(rawKey);
      if (PROJECT_FORBIDDEN_KEYS.includes(key)) {
        codexWarn(`[codex] extension key "${rawKey}" is dropped: a project .codex/config.toml may not set it`);
        continue;
      }
      if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") scalars[key] = value;
    }
    if (ext.disable_response_storage != null || ext["disable-response-storage"] != null) {
      codexWarn('[codex] extension key "disable_response_storage" is dropped: it is not a Codex config key');
    }
    if (ext.history) {
      codexWarn('[codex] extension table "history" is dropped: max_conversations is not a Codex config key');
    }
    const prov = ext.providers as unknown[] | undefined;
    if (prov && prov.length > 0) {
      codexWarn("[codex] providers are dropped: a project .codex/config.toml may not set model_providers; set them in your user config");
    }
  }
  if (ast.providers && ast.providers.length > 0) {
    codexWarn("[codex] providers are dropped: a project .codex/config.toml may not set model_providers; set them in your user config");
  }

  // Model parameters Codex has no key for.
  const temp = ast.defaults?.temperature ?? agents[0]?.temperature;
  const maxTok = ast.defaults?.maxTokens ?? agents[0]?.maxTokens;
  const comments: string[] = [];
  if (temp != null || maxTok != null) {
    comments.push("# Not expressible in Codex config: temperature and max tokens have no key.");
    if (temp != null) comments.push(`#   temperature = ${temp}`);
    if (maxTok != null) comments.push(`#   max_tokens = ${maxTok}`);
    comments.push("");
  }

  // MCP servers — [mcp_servers.<id>] with its env table nested under it.
  if (ast.mcpServers && Object.keys(ast.mcpServers).length > 0) {
    for (const [name, config] of Object.entries(ast.mcpServers)) {
      const server: Record<string, unknown> = {};
      for (const [ck, cv] of Object.entries(config as Record<string, unknown>)) {
        const key = snakeKey(ck);
        if (MCP_DROPPED_KEYS.has(key)) continue;
        server[key] = mcpValue(key, cv);
      }
      tables.push(...tomlTable(["mcp_servers", name], server));
    }
  }

  const fallbackChain = ast.settings?.["fallback-chain"] as string[] | undefined;
  if (fallbackChain && fallbackChain.length > 0) {
    comments.push(`# Model fallback chain (Codex has no such key): ${fallbackChain.join(" -> ")}`);
    comments.push("");
  }

  // Multi-agent support: [agents] with one entry per agent.
  if (agents.length > 0) {
    tables.push("[agents]", `max_concurrent_threads_per_session = ${Math.min(agents.length, 10)}`, "");
    for (const agent of agents) {
      const desc = agent.description
        ?? ast.roles[agent.role ?? ""]
        ?? ast.roles[agent.id]
        ?? agent.role
        ?? toTitle(agent.id);
      tables.push(`[agents.${tomlKey(agent.id)}]`, `description = ${tomlString(desc)}`, `config_file = ${tomlString(`agents/${agent.id}.toml`)}`, "");
    }
  }

  // Sanity: nothing the contract forbids or does not allow leaves here.
  if (!APPROVAL_POLICIES.has(String(scalars.approval_policy))) throw new Error("codex binding: illegal approval_policy");
  if (scalars.sandbox_mode !== undefined && !SANDBOX_MODES.has(String(scalars.sandbox_mode))) {
    codexWarn(`[codex] sandbox mode "${scalars.sandbox_mode}" is not a Codex sandbox_mode; left out`);
    delete scalars.sandbox_mode;
  }

  const scalarLines = tomlTable([], scalars);
  return {
    path: ".codex/config.toml",
    content: [...header, ...scalarLines, ...comments, ...tables].join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n*$/, "\n"),
    category: "machine",
  };
}

/**
 * Map generic sandbox mode strings to Codex sandbox values.
 * Codex supports: "read-only", "workspace-write", "danger-full-access"
 */
function mapSandboxMode(mode: string): string {
  // Pass through native Codex values
  const nativeValues = ["read-only", "workspace-write", "danger-full-access"];
  if (nativeValues.includes(mode)) return mode;

  switch (mode) {
    case "docker":
    case "container":
    case "strict":
      return "read-only";
    case "write":
    case "workspace":
      return "workspace-write";
    case "none":
    case "disabled":
    case "off":
      return "danger-full-access";
    default:
      return "read-only"; // safe default
  }
}

/**
 * Map agent sandbox values to Codex sandbox_mode for per-agent TOML.
 * true/"docker"/"strict" → "read-only", "write"/"workspace" → "workspace-write",
 * false/"none" → "danger-full-access", "network-only" → "read-only"
 */
function mapAgentSandbox(sandbox: string | boolean): string {
  if (typeof sandbox === "boolean") {
    return sandbox ? "read-only" : "danger-full-access";
  }
  switch (sandbox) {
    case "docker":
    case "strict":
    case "container":
    case "network-only":
    case "read-only":
      return "read-only";
    case "write":
    case "workspace":
    case "workspace-write":
      return "workspace-write";
    case "none":
    case "disabled":
    case "off":
    case "danger-full-access":
      return "danger-full-access";
    default:
      return "read-only"; // safe default
  }
}

/**
 * Map thinking/reasoning level to Codex model_reasoning_effort.
 * off → "" (omit), low → "low", medium → "medium", high → "high", max → "high"
 */
function mapReasoningEffort(thinking: string): string | null {
  switch (thinking) {
    case "off":
      return null; // omit from TOML
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return "xhigh";
    case "max":
      // Was collapsed onto "high", which left `max` and `xhigh` with no
      // distinct Codex value at all.
      return "max";
    default:
      return null;
  }
}

/**
 * Derive sandbox type from topology permissions.
 * More restrictive permissions suggest sandboxing.
 */
function deriveSandboxType(ast: TopologyAST): string | null {
  const agents = ast.nodes.filter((n) => n.type === "agent") as AgentNode[];
  const hasUnrestricted = agents.some(
    (a) =>
      a.permissions === "unrestricted" ||
      a.permissions === "full-auto" ||
      a.permissions === "bypassPermissions"
  );
  // If any agent is unrestricted, no sandbox (user opted out of restrictions)
  if (hasUnrestricted) return "danger-full-access";
  // Default: no explicit sandbox section needed
  return null;
}

/**
 * Extract codex-specific extension fields from the topology level.
 * Checks settings.extensions["codex"] and any top-level extension block.
 */
function getTopologyExtensions(
  ast: TopologyAST
): Record<string, unknown> | null {
  const settingsExt = ast.settings?.extensions as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (settingsExt?.codex) return settingsExt.codex;
  // Also check top-level ast.extensions["codex"]
  if (ast.extensions?.codex) return ast.extensions.codex as Record<string, unknown>;
  return null;
}

// ---------------------------------------------------------------------------
// AGENTS.md generation
// ---------------------------------------------------------------------------

/**
 * Generate `AGENTS.md` — the primary instructions file for Codex CLI.
 *
 * Since Codex is a single-agent CLI, multi-agent topologies are expressed
 * as instruction sections describing each agent's role, responsibilities,
 * tools, and memory access patterns. The orchestrator reads this file to
 * understand the full workflow.
 */
function generateAgentsMd(ast: TopologyAST): GeneratedFile {
  const sections: string[] = [];
  const name = ast.topology.name;

  // Header
  sections.push(`# ${toTitle(name)} — Agent Instructions`);
  sections.push("");

  // #17 — isFragment notice
  if (ast.isFragment) {
    sections.push("**Note:** This is a topology fragment — it defines a reusable sub-topology.");
    sections.push("");
  }

  if (ast.topology.description) {
    sections.push(ast.topology.description);
    sections.push("");
  }
  sections.push(`Version: ${ast.topology.version}`);
  if (ast.topology.patterns.length > 0) {
    sections.push(`Patterns: ${ast.topology.patterns.join(", ")}`);
  }
  // #7 — topology-level domain, timeout, errorHandler, durable, foundations, advanced
  if (ast.topology.domain) {
    sections.push(`Domain: ${ast.topology.domain}`);
  }
  if (ast.topology.timeout) {
    sections.push(`Timeout: ${ast.topology.timeout}`);
  }
  if (ast.topology.errorHandler) {
    sections.push(`Error handler: ${ast.topology.errorHandler}`);
  }
  if (ast.topology.durable) {
    sections.push(`Durable: true`);
  }
  if (ast.topology.foundations && ast.topology.foundations.length > 0) {
    sections.push(`Foundations: ${ast.topology.foundations.join(", ")}`);
  }
  if (ast.topology.advanced && ast.topology.advanced.length > 0) {
    sections.push(`Advanced: ${ast.topology.advanced.join(", ")}`);
  }
  sections.push("");

  // Defaults section
  if (ast.defaults) {
    sections.push("## Defaults");
    sections.push("");
    const d = ast.defaults;
    if (d.temperature != null) sections.push(`- **Temperature:** ${d.temperature}`);
    if (d.maxTokens != null) sections.push(`- **Max tokens:** ${d.maxTokens}`);
    if (d.topP != null) sections.push(`- **Top-p:** ${d.topP}`);
    if (d.topK != null) sections.push(`- **Top-k:** ${d.topK}`);
    if (d.stop && d.stop.length > 0) sections.push(`- **Stop sequences:** ${d.stop.join(", ")}`);
    if (d.seed != null) sections.push(`- **Seed:** ${d.seed}`);
    if (d.thinking) sections.push(`- **Thinking:** ${d.thinking}`);
    if (d.thinkingBudget != null) sections.push(`- **Thinking budget:** ${d.thinkingBudget}`);
    if (d.outputFormat) sections.push(`- **Output format:** ${d.outputFormat}`);
    if (d.timeout) sections.push(`- **Timeout:** ${d.timeout}`);
    if (d.logLevel) sections.push(`- **Log level:** ${d.logLevel}`);
    sections.push("");
  }

  // Orchestrator section (#14)
  const orch = ast.nodes.find((n) => n.type === "orchestrator") as OrchestratorNode | undefined;
  if (orch) {
    const orchTitle = orch.label || toTitle(orch.id);
    sections.push(`## Orchestrator — ${orchTitle}`);
    sections.push("");
    sections.push(`Model: ${orch.model}`);
    if (orch.handles?.length > 0) {
      sections.push(`Handles: ${orch.handles.join(", ")}`);
    }
    if (orch.generates) {
      sections.push(`Generates: ${orch.generates}`);
    }
    if (orch.outputs) {
      sections.push("Outputs:");
      for (const [field, values] of Object.entries(orch.outputs)) {
        sections.push(`  - ${field}: ${values.join(" | ")}`);
      }
    }
    sections.push("");
  }

  // Flow section
  if (ast.edges.length > 0) {
    sections.push("## Flow");
    sections.push("");
    for (const edge of ast.edges) {
      let line = `${edge.from} -> ${edge.to}`;
      if (edge.condition) line += ` [when ${edge.condition}]`;
      if (edge.maxIterations) line += ` [max ${edge.maxIterations}]`;
      if (edge.per) line += ` [per ${edge.per}]`;
      if (edge.isError) line += ` [error${edge.errorType ? `: ${edge.errorType}` : ""}]`;
      if (edge.weight != null) line += ` [weight ${edge.weight}]`;
      if (edge.reflection) line += ` [reflection]`;
      if (edge.race) line += ` [race]`;
      if (edge.tolerance != null) line += ` [tolerance: ${edge.tolerance}]`;
      if (edge.wait) line += ` [wait ${edge.wait}]`;
      sections.push(`- ${line}`);
    }
    sections.push("");
  }

  // Schedules section (Codex doesn't natively support cron; document for reference)
  if (ast.schedules && ast.schedules.length > 0) {
    sections.push("## Schedules");
    sections.push("");
    for (const job of ast.schedules) {
      const timing = job.cron ? `runs at \`${job.cron}\`` : `runs ${job.every}`;
      const target = job.agent
        ? `triggers agent \`${job.agent}\``
        : job.action
          ? `triggers action \`${job.action}\``
          : "";
      const suffix = target ? `, ${target}` : "";
      const enabled = job.enabled === false ? " (disabled)" : "";
      sections.push(`- **${job.id}**: ${timing}${suffix}${enabled}`);
    }
    sections.push("");
  }

  // Interfaces section (document external interfaces for reference)
  if (ast.interfaces && ast.interfaces.length > 0) {
    sections.push("## Interfaces");
    sections.push("");
    for (const iface of ast.interfaces) {
      const details: string[] = [];
      if (iface.type) details.push(iface.type);
      for (const [k, v] of Object.entries(iface.config)) {
        details.push(`${k} ${v}`);
      }
      const desc = details.length > 0 ? details.join(", ") : "configured";
      sections.push(`- **${iface.id}**: ${desc}`);
    }
    sections.push("");
  }

  // Agent sections
  const agents = ast.nodes.filter((n) => n.type === "agent") as AgentNode[];
  if (agents.length > 0) {
    sections.push("## Agents");
    sections.push("");

    for (const agent of agents) {
      sections.push(`### ${agent.label || toTitle(agent.id)}`);
      sections.push("");
      sections.push(`> See \`.codex/agents/${agent.id}.toml\` for full configuration.`);
      sections.push("");

      // Role
      const roleText =
        ast.roles[agent.role ?? ""] ?? ast.roles[agent.id] ?? agent.role;
      if (roleText) {
        sections.push(`**Role:** ${roleText}`);
        sections.push("");
      }

      // Description
      if (agent.description) {
        sections.push(agent.description);
        sections.push("");
      }

      // Model and permissions
      const model = agent.model ?? "o4-mini";
      const policy = mapApprovalPolicy(agent.permissions ?? "autonomous"); // spec default
      sections.push(`- **Model:** ${model}`);
      sections.push(`- **Approval policy:** ${policy}`);

      // Phase
      if (agent.phase != null) {
        sections.push(`- **Phase:** ${agent.phase}`);
      }

      // Sampling parameters
      if (agent.temperature != null) {
        sections.push(`- **Temperature:** ${agent.temperature}`);
      }
      if (agent.maxTokens != null) {
        sections.push(`- **Max tokens:** ${agent.maxTokens}`);
      }
      if (agent.topP != null) {
        sections.push(`- **Top-p:** ${agent.topP}`);
      }
      if (agent.topK != null) {
        sections.push(`- **Top-k:** ${agent.topK}`);
      }
      if (agent.stop && agent.stop.length > 0) {
        sections.push(`- **Stop sequences:** ${agent.stop.join(", ")}`);
      }
      if (agent.seed != null) {
        sections.push(`- **Seed:** ${agent.seed}`);
      }

      // Thinking / reasoning
      if (agent.thinking) {
        sections.push(`- **Reasoning level:** ${agent.thinking}`);
      }
      if (agent.thinkingBudget != null) {
        sections.push(`- **Thinking budget:** ${agent.thinkingBudget}`);
      }

      // Output format
      if (agent.outputFormat) {
        sections.push(`- **Output format:** ${agent.outputFormat}`);
      }

      // Log level
      if (agent.logLevel) {
        sections.push(`- **Log level:** ${agent.logLevel}`);
      }

      // Timeout
      if (agent.timeout) {
        sections.push(`- **Maximum execution time:** ${agent.timeout}`);
      }

      // On-fail
      if (agent.onFail) {
        sections.push(`- **On failure:** ${agent.onFail}`);
      }

      // Retry
      if (agent.retry != null) {
        sections.push(`- **Retry:** ${formatRetryConfig(agent.retry)}`);
      }

      // Join semantics
      if (agent.join) {
        sections.push(`- **Wait for:** ${agent.join}`);
      }

      // Rate limit
      if (agent.rateLimit) {
        sections.push(`- **Rate limit:** ${agent.rateLimit}`);
      }

      // Circuit breaker
      if (agent.circuitBreaker) {
        const cb = agent.circuitBreaker;
        sections.push(`- **Circuit breaker:** threshold ${cb.threshold}, window ${cb.window}, cooldown ${cb.cooldown}`);
      }

      // Compensates (saga)
      if (agent.compensates) {
        sections.push(`- **Compensates:** ${agent.compensates} (saga rollback)`);
      }

      // The prompt lives in .codex/agents/<id>.toml (developer_instructions),
      // not here: AGENTS.md is read whole into every Codex session (CX-6).
      if (agent.prompt) {
        sections.push(`- **Instructions:** \`.codex/agents/${agent.id}.toml\``);
      }

      // Prompt variants
      if (agent.variants && agent.variants.length > 0) {
        sections.push("");
        sections.push("#### Prompt Variants");
        sections.push("");
        for (const v of agent.variants) {
          const parts: string[] = [`**${v.id}** (weight ${v.weight})`];
          if (v.model) parts.push(`model: ${v.model}`);
          if (v.temperature != null) parts.push(`temperature: ${v.temperature}`);
          sections.push(`- ${parts.join(", ")}`);
        }
        sections.push("");
      }

      // Tools
      if (agent.tools && agent.tools.length > 0) {
        sections.push(`- **Tools:** ${agent.tools.join(", ")}`);
      }
      if (agent.disallowedTools && agent.disallowedTools.length > 0) {
        sections.push(
          `- **Disallowed tools:** ${agent.disallowedTools.join(", ")}`
        );
      }

      // Skills
      if (agent.skills && agent.skills.length > 0) {
        sections.push(`- **Skills:** ${agent.skills.join(", ")}`);
      }

      // Memory access
      if (agent.reads && agent.reads.length > 0) {
        sections.push(`- **Reads:** ${agent.reads.join(", ")}`);
      }
      if (agent.writes && agent.writes.length > 0) {
        sections.push(`- **Writes:** ${agent.writes.join(", ")}`);
      }

      // Input/Output schemas
      if (agent.inputSchema && agent.inputSchema.length > 0) {
        sections.push("- **Input schema:**");
        for (const field of agent.inputSchema) {
          sections.push(`  ${formatSchemaField(field)}`);
        }
      }
      if (agent.outputSchema && agent.outputSchema.length > 0) {
        sections.push("- **Output schema:**");
        for (const field of agent.outputSchema) {
          sections.push(`  ${formatSchemaField(field)}`);
        }
      }

      // Outputs
      if (agent.outputs) {
        sections.push("- **Outputs:**");
        for (const [field, values] of Object.entries(agent.outputs)) {
          sections.push(`  - ${field}: ${values.join(" | ")}`);
        }
      }

      // Artifact lineage
      if (agent.produces && agent.produces.length > 0) {
        sections.push(`- **Produces:** ${agent.produces.join(", ")}`);
      }
      if (agent.consumes && agent.consumes.length > 0) {
        sections.push(`- **Consumes:** ${agent.consumes.join(", ")}`);
      }

      // Behavior modifiers
      if (agent.behavior) {
        sections.push(`- **Behavior:** ${agent.behavior}`);
      }
      if (agent.skip) {
        sections.push(`- **Skip when:** ${agent.skip}`);
      }
      if (agent.isolation) {
        sections.push(`- **Isolation:** ${agent.isolation}`);
      }
      if (agent.background) {
        sections.push(`- **Background:** true`);
      }
      if (agent.maxTurns != null) {
        sections.push(`- **Max turns:** ${agent.maxTurns}`);
      }

      // Scale (#10 — include batchSize)
      if (agent.scale) {
        let scaleLine = `- **Scale:** ${agent.scale.mode} by ${agent.scale.by} (${agent.scale.min}-${agent.scale.max}`;
        if (agent.scale.batchSize != null) {
          scaleLine += `, batch ${agent.scale.batchSize}`;
        }
        scaleLine += `)`;
        sections.push(scaleLine);
      }

      // #4 — per-agent MCP servers
      if (agent.mcpServers && agent.mcpServers.length > 0) {
        sections.push(`- **MCP servers:** ${agent.mcpServers.join(", ")}`);
      }

      // #5 — sandbox
      if (agent.sandbox != null) {
        sections.push(`- **Sandbox:** ${agent.sandbox}`);
      }

      // #5 — fallbackChain
      if (agent.fallbackChain && agent.fallbackChain.length > 0) {
        sections.push(`- **Fallback chain:** ${agent.fallbackChain.join(" -> ")}`);
      }

      // #5 — per-agent hooks
      if (agent.hooks && agent.hooks.length > 0) {
        const hookDesc = agent.hooks.map((h) => `${h.name} (on ${h.on})`).join(", ");
        sections.push(`- **Hooks:** ${hookDesc}`);
      }

      // Codex-specific extensions
      if (agent.extensions?.codex) {
        sections.push("- **Codex config:**");
        for (const [k, v] of Object.entries(agent.extensions.codex)) {
          sections.push(`  - ${k}: ${v}`);
        }
      }

      sections.push("");
    }
  }

  // Human nodes section
  const humans = ast.nodes.filter((n) => n.type === "human") as HumanNode[];
  if (humans.length > 0) {
    sections.push("## Human Checkpoints");
    sections.push("");
    for (const human of humans) {
      sections.push(`### ${human.label || toTitle(human.id)}`);
      sections.push("");
      if (human.description) {
        sections.push(human.description);
        sections.push("");
      }
      sections.push(`- **Type:** Human pause point — requires manual input or approval`);
      if (human.timeout) {
        sections.push(`- **Timeout:** ${human.timeout}`);
      }
      if (human.onTimeout) {
        sections.push(`- **On timeout:** ${human.onTimeout}`);
      }
      sections.push("");
    }
  }

  // Group nodes section
  const groups = ast.nodes.filter((n) => n.type === "group") as GroupNode[];
  if (groups.length > 0) {
    sections.push("## Group Chats");
    sections.push("");
    for (const group of groups) {
      sections.push(`### ${group.label || toTitle(group.id)}`);
      sections.push("");
      if (group.description) {
        sections.push(group.description);
        sections.push("");
      }
      sections.push(`- **Members:** ${group.members.join(", ")}`);
      if (group.speakerSelection) {
        sections.push(`- **Speaker selection:** ${group.speakerSelection}`);
      }
      if (group.maxRounds != null) {
        sections.push(`- **Max rounds:** ${group.maxRounds}`);
      }
      if (group.termination) {
        sections.push(`- **Termination:** ${group.termination}`);
      }
      if (group.timeout) {
        sections.push(`- **Timeout:** ${group.timeout}`);
      }
      sections.push("");
    }
  }

  // Gates section
  const gates = ast.nodes.filter((n) => n.type === "gate") as GateNode[];
  if (gates.length > 0) {
    sections.push("## Gates");
    sections.push("");
    for (const gate of gates) {
      sections.push(`### ${gate.label || toTitle(gate.id)}`);
      sections.push("");
      if (gate.after) sections.push(`- **After:** ${gateAnchors(gate, "after").join(", ")}`);
      if (gate.before) sections.push(`- **Before:** ${gateAnchors(gate, "before").join(", ")}`);
      if (gate.run) sections.push(`- **Run:** ${gate.run}`);
      if (gate.checks && gate.checks.length > 0) {
        sections.push(`- **Checks:** ${gate.checks.join(", ")}`);
      }
      if (gate.onFail) sections.push(`- **On fail:** ${gate.onFail}`);
      if (gate.retry != null) sections.push(`- **Retry:** ${gate.retry}`);
      if (gate.timeout) sections.push(`- **Timeout:** ${gate.timeout}`);
      sections.push(`- **Enforcement:** script-level — run gate script manually between agents`);
      sections.push("");
    }
  }

  // #1 — Action nodes section
  const actions = ast.nodes.filter((n) => n.type === "action") as ActionNode[];
  if (actions.length > 0) {
    sections.push("## Actions");
    sections.push("");
    for (const action of actions) {
      sections.push(`### ${action.label || toTitle(action.id)}`);
      sections.push("");
      if (action.description) {
        sections.push(action.description);
        sections.push("");
      }
      if (action.kind) sections.push(`- **Kind:** ${action.kind}`);
      if (action.source) sections.push(`- **Source:** ${action.source}`);
      if (action.commands && action.commands.length > 0) {
        sections.push(`- **Commands:** ${action.commands.join("; ")}`);
      }
      if (action.timeout) sections.push(`- **Timeout:** ${action.timeout}`);
      if (action.onFail) sections.push(`- **On fail:** ${action.onFail}`);
      if (action.join) sections.push(`- **Join:** ${action.join}`);
      sections.push("");
    }
  }

  // Triggers section
  if (ast.triggers.length > 0) {
    sections.push("## Triggers");
    sections.push("");
    for (const trigger of ast.triggers) {
      sections.push(`### ${trigger.name}`);
      sections.push(`Pattern: \`${trigger.pattern}\``);
      if (trigger.argument) sections.push(`Argument: ${trigger.argument}`);
      sections.push("");
    }
  }

  // Memory paths section
  if (Object.keys(ast.memory).length > 0) {
    sections.push("## Memory");
    sections.push("");
    if (ast.memory.domains) {
      sections.push(`- **Domains:** .codex/domains/`);
    }
    if (ast.memory.references) {
      sections.push(`- **References:** .codex/references/`);
    }
    if (ast.memory.metrics) {
      sections.push(`- **Metrics:** .codex/metrics.jsonl`);
    }
    if (ast.memory.workspace) {
      sections.push(`- **Workspace:** .codex/runs/`);
    }
    sections.push("");
  }

  // Observability section
  if (ast.observability) {
    const o = ast.observability;
    sections.push("## Observability");
    sections.push("");
    sections.push(`- **Enabled:** ${o.enabled}`);
    sections.push(`- **Level:** ${o.level}`);
    sections.push(`- **Exporter:** ${o.exporter}`);
    if (o.endpoint) sections.push(`- **Endpoint:** ${o.endpoint}`);
    if (o.service) sections.push(`- **Service:** ${o.service}`);
    sections.push(`- **Sample rate:** ${o.sampleRate}`);
    sections.push(`- **Capture:** prompts=${o.capture.prompts}, completions=${o.capture.completions}, toolArgs=${o.capture.toolArgs}, toolResults=${o.capture.toolResults}`);
    sections.push(`- **Spans:** agents=${o.spans.agents}, tools=${o.spans.tools}, gates=${o.spans.gates}, memory=${o.spans.memory}`);
    sections.push("");
  }

  // Checkpoint section
  if (ast.checkpoint) {
    const cp = ast.checkpoint;
    sections.push("## Checkpoint");
    sections.push("");
    sections.push(`- **Backend:** ${cp.backend}`);
    sections.push(`- **Strategy:** ${cp.strategy}`);
    if (cp.connection) sections.push(`- **Connection:** ${cp.connection}`);
    if (cp.ttl) sections.push(`- **TTL:** ${cp.ttl}`);
    if (cp.replay) {
      sections.push(`- **Replay:** enabled=${cp.replay.enabled}${cp.replay.maxHistory != null ? `, maxHistory=${cp.replay.maxHistory}` : ""}${cp.replay.branch != null ? `, branch=${cp.replay.branch}` : ""}`);
    }
    sections.push("");
  }

  // Artifacts section
  if (ast.artifacts && ast.artifacts.length > 0) {
    sections.push("## Artifacts");
    sections.push("");
    for (const art of ast.artifacts) {
      const parts: string[] = [`type: ${art.type}`];
      if (art.path) parts.push(`path: ${art.path}`);
      if (art.retention) parts.push(`retention: ${art.retention}`);
      if (art.dependsOn && art.dependsOn.length > 0) {
        parts.push(`depends-on: ${art.dependsOn.join(", ")}`);
      }
      sections.push(`- **${art.id}**: ${parts.join(", ")}`);
    }
    sections.push("");
  }

  // #8 — Batch section
  if (ast.batch && Object.keys(ast.batch).length > 0) {
    sections.push("## Batch");
    sections.push("");
    for (const [key, val] of Object.entries(ast.batch)) {
      sections.push(`- **${key}:** ${JSON.stringify(val)}`);
    }
    sections.push("");
  }

  // #9 — Environments section
  if (ast.environments && Object.keys(ast.environments).length > 0) {
    sections.push("## Environments");
    sections.push("");
    for (const [envName, overrides] of Object.entries(ast.environments)) {
      sections.push(`### ${toTitle(envName)}`);
      sections.push("");
      for (const [key, val] of Object.entries(overrides)) {
        sections.push(`- **${key}:** ${JSON.stringify(val)}`);
      }
      sections.push("");
    }
  }

  // Schemas section
  if (ast.schemas && ast.schemas.length > 0) {
    sections.push("## Schemas");
    sections.push("");
    for (const schema of ast.schemas) {
      sections.push(`### ${toTitle(schema.id)}`);
      sections.push("");
      for (const field of schema.fields) {
        sections.push(formatSchemaField(field));
      }
      sections.push("");
    }
  }

  // Depth levels
  if (ast.depth && ast.depth.levels && ast.depth.levels.length > 0) {
    sections.push("## Depth Levels");
    sections.push("");
    if (ast.depth.factors.length > 0) {
      sections.push(`Factors: ${ast.depth.factors.join(", ")}`);
    }
    for (const level of ast.depth.levels) {
      let line = `- **Level ${level.level}**: ${level.label}`;
      if (level.omit.length > 0) line += ` (omit: ${level.omit.join(", ")})`;
      sections.push(line);
    }
    sections.push("");
  }

  // Composition: params
  if (ast.params && ast.params.length > 0) {
    sections.push("## Parameters");
    sections.push("");
    for (const p of ast.params) {
      const req = p.required ? " (required)" : "";
      const def = p.default != null ? ` = ${p.default}` : "";
      sections.push(`- **${p.name}**: ${p.type}${req}${def}`);
    }
    sections.push("");
  }

  // Composition: interface endpoints
  if (ast.interfaceEndpoints) {
    sections.push("## Interface");
    sections.push("");
    sections.push(`- Entry: ${ast.interfaceEndpoints.entry}`);
    sections.push(`- Exit: ${ast.interfaceEndpoints.exit}`);
    sections.push("");
  }

  // Composition: imports
  if (ast.imports && ast.imports.length > 0) {
    sections.push("## Imports");
    sections.push("");
    for (const imp of ast.imports) {
      let line = `- **${imp.alias}** from \`${imp.source}\``;
      if (imp.sha256) line += ` (sha256: ${imp.sha256})`;
      if (imp.registry) line += ` [registry: ${imp.registryPackage}@${imp.registryVersion}]`;
      sections.push(line);
      if (Object.keys(imp.params).length > 0) {
        for (const [k, v] of Object.entries(imp.params)) {
          sections.push(`  - ${k}: ${v}`);
        }
      }
    }
    sections.push("");
  }

  // Composition: includes
  if (ast.includes && ast.includes.length > 0) {
    sections.push("## Includes");
    sections.push("");
    for (const inc of ast.includes) {
      sections.push(`- ${inc.source}`);
    }
    sections.push("");
  }

  // Skills summary (#11 — additional skill fields)
  if (ast.skills.length > 0) {
    sections.push("## Skills");
    sections.push("");
    for (const skill of ast.skills) {
      sections.push(`### ${toTitle(skill.id)}`);
      if (skill.description) {
        sections.push(skill.description);
      }
      if (skill.scripts && skill.scripts.length > 0) {
        sections.push(`Scripts: ${skill.scripts.join(", ")}`);
      }
      if (skill.prompt) {
        sections.push(`Prompt file: ${skill.prompt}`);
      }
      if (skill.userInvocable != null) {
        sections.push(`User-invocable: ${skill.userInvocable ? "yes" : "no"}`);
      }
      if (skill.allowedTools && skill.allowedTools.length > 0) {
        sections.push(`Allowed tools: ${skill.allowedTools.join(", ")}`);
      }
      if (skill.context) {
        sections.push(`Context: ${skill.context}`);
      }
      if (skill.agent) {
        sections.push(`Agent: ${skill.agent}`);
      }
      if (skill.disableModelInvocation) {
        sections.push(`Model invocation: disabled`);
      }
      sections.push("");
    }
  }

  // Context includes (#16 — also show context.file)
  if ((ast.context.includes && ast.context.includes.length > 0) || ast.context.file) {
    sections.push("## References");
    sections.push("");
    if (ast.context.file) {
      sections.push(`- Context file: ${ast.context.file}`);
    }
    if (ast.context.includes) {
      for (const inc of ast.context.includes) {
        sections.push(`- ${inc}`);
      }
    }
    sections.push("");
  }

  // Environment variables (#2 — handle sensitive, secretRef, encrypted)
  if (Object.keys(ast.env).length > 0) {
    sections.push("## Environment");
    sections.push("");
    for (const [key, val] of Object.entries(ast.env)) {
      if (typeof val === "string") {
        sections.push(`- \`${key}\`: ${val}`);
      } else {
        const sv = val as SensitiveValue;
        let displayVal: string;
        if (sv.secretRef) {
          displayVal = `[secret: ${sv.secretRef.scheme}:${sv.secretRef.uri}]`;
        } else if (sv.encrypted) {
          displayVal = `[encrypted]`;
        } else if (sv.sensitive) {
          displayVal = `\${${key}}`;
        } else {
          displayVal = sv.value;
        }
        sections.push(`- \`${key}\`: ${displayVal}`);
      }
    }
    sections.push("");
  }

  return {
    path: "AGENTS.md",
    content: `${AGENTS_MD_BEGIN}\n${sections.join("\n")}\n${AGENTS_MD_END}\n`,
    category: "agent",
  };
}

// ---------------------------------------------------------------------------
// .codex/instructions.md — REMOVED
// ---------------------------------------------------------------------------
// Codex CLI does NOT use .codex/instructions.md. It reads AGENTS.md files
// from the workspace root and nested directories. Skills, context includes,
// and environment info are now folded into AGENTS.md generation above.

// ---------------------------------------------------------------------------
// Memory directories
// ---------------------------------------------------------------------------

/** Generate memory structure directories under .codex/. */
function generateMemory(ast: TopologyAST): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  if (ast.memory.domains) {
    files.push(gitkeep(".codex/domains"));
  }
  if (ast.memory.references) {
    files.push(gitkeep(".codex/references"));
  }
  if (ast.memory.metrics) {
    files.push({
      path: ".codex/metrics.jsonl",
      content: "",
      category: "machine",
    });
  }
  if (ast.memory.workspace) {
    files.push(gitkeep(".codex/runs"));
  }

  return files;
}

// ---------------------------------------------------------------------------
// Gate scripts
// ---------------------------------------------------------------------------

/** Generate gate script stubs under .codex/scripts/. */
function generateGateScripts(ast: TopologyAST): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  for (const node of ast.nodes) {
    if (node.type !== "gate") continue;
    const gate = node as GateNode;
    if (gate.run) {
      const scriptName = gate.run.replace(/^.*\//, "").replace(/\s.*$/, "");
      files.push({
        path: `.codex/scripts/${scriptName}`,
        content: shellStub(`Gate: ${gate.id} — ${gate.run}`),
        category: "script",
      });
    }
  }

  return files;
}

// ---------------------------------------------------------------------------
// Hook scripts
// ---------------------------------------------------------------------------

/** Generate hook script stubs under .codex/scripts/. */
function generateHookScripts(ast: TopologyAST): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  // Global hooks
  for (const hook of ast.hooks) {
    if (!hook.run) continue;
    const scriptName = hook.run.replace(/^.*\//, "").replace(/\s.*$/, "");
    const hookLines = [
      "#!/usr/bin/env bash",
      `# Hook: ${hook.name} — fires on ${hook.on}`,
    ];
    // #12 — include matcher, type, timeout as comments
    if (hook.matcher) hookLines.push(`# Matcher: ${hook.matcher}`);
    if (hook.type) hookLines.push(`# Type: ${hook.type}`);
    if (hook.timeout != null) hookLines.push(`# Timeout: ${hook.timeout}ms`);
    hookLines.push(
      "# Auto-generated by agentopology scaffold — edit as needed.",
      "set -euo pipefail",
      "",
      `echo "TODO: implement ${hook.name} hook"`,
      "",
    );
    files.push({
      path: `.codex/scripts/${scriptName}`,
      content: hookLines.join("\n"),
      category: "script",
    });
  }

  // #5 — per-agent hook script stubs
  for (const node of ast.nodes) {
    if (node.type !== "agent") continue;
    const agent = node as AgentNode;
    if (!agent.hooks) continue;
    for (const hook of agent.hooks) {
      if (!hook.run) continue;
      const scriptName = hook.run.replace(/^.*\//, "").replace(/\s.*$/, "");
      const hookLines = [
        "#!/usr/bin/env bash",
        `# Hook: ${hook.name} — fires on ${hook.on} (agent: ${agent.id})`,
      ];
      if (hook.matcher) hookLines.push(`# Matcher: ${hook.matcher}`);
      if (hook.type) hookLines.push(`# Type: ${hook.type}`);
      if (hook.timeout != null) hookLines.push(`# Timeout: ${hook.timeout}ms`);
      hookLines.push(
        "# Auto-generated by agentopology scaffold — edit as needed.",
        "set -euo pipefail",
        "",
        `echo "TODO: implement ${hook.name} hook"`,
        "",
      );
      files.push({
        path: `.codex/scripts/${scriptName}`,
        content: hookLines.join("\n"),
        category: "script",
      });
    }
  }

  return files;
}

// ---------------------------------------------------------------------------
// Tool scripts
// ---------------------------------------------------------------------------

/** Generate tool script stubs under .codex/scripts/. */
function generateToolScripts(ast: TopologyAST): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  for (const tool of ast.toolDefs) {
    const ext =
      tool.lang === "python" ? "py" : tool.lang === "node" ? "js" : "sh";
    const shebang =
      tool.lang === "python"
        ? "#!/usr/bin/env python3"
        : tool.lang === "node"
          ? "#!/usr/bin/env node"
          : "#!/usr/bin/env bash";

    const lines = [
      shebang,
      `# Tool: ${tool.id} — ${tool.description}`,
      "# Auto-generated by agentopology scaffold — edit as needed.",
      "",
    ];

    if (tool.lang === "bash" || !tool.lang) {
      lines.push("set -euo pipefail");
      lines.push("");
    }

    if (tool.args && tool.args.length > 0) {
      lines.push(`# Args: ${tool.args.join(", ")}`);
      lines.push("");
    }

    if (tool.lang === "python") {
      lines.push(`print("TODO: implement ${tool.id}")`);
    } else if (tool.lang === "node") {
      lines.push(`console.log("TODO: implement ${tool.id}");`);
    } else {
      lines.push(`echo "TODO: implement ${tool.id}"`);
    }
    lines.push("");

    files.push({
      path: `.codex/scripts/${tool.id}.${ext}`,
      content: lines.join("\n"),
      category: "script",
    });
  }

  return files;
}

// ---------------------------------------------------------------------------
// Metering script
// ---------------------------------------------------------------------------

/** Generate metering script stub. */
function generateMetering(ast: TopologyAST): GeneratedFile | null {
  if (!ast.metering) return null;

  const m = ast.metering;
  const lines = [
    "#!/usr/bin/env bash",
    "# Metering / cost tracking script",
    "# Auto-generated by agentopology scaffold — edit as needed.",
    "set -euo pipefail",
    "",
    `# Track: ${m.track.join(", ")}`,
    `# Per: ${m.per.join(", ")}`,
    `# Output: ${m.output} (${m.format})`,
    `# Pricing: ${m.pricing}`,
    "",
    'echo "TODO: implement metrics collection"',
    "",
  ];

  return {
    path: "scripts/collect-metrics.sh",
    content: lines.join("\n"),
    category: "script",
  };
}

// ---------------------------------------------------------------------------
// Workspace protocol
// ---------------------------------------------------------------------------

/** Generate workspace-protocol.md if workspace memory has a protocol field. */
function generateWorkspaceProtocol(ast: TopologyAST): GeneratedFile | null {
  const workspace = ast.memory.workspace as Record<string, unknown> | undefined;
  if (!workspace || !workspace.protocol) return null;

  const protocol = workspace.protocol as string;
  const sections: string[] = [];
  sections.push("# Workspace Protocol");
  sections.push("");

  // Directory structure from workspace.structure
  const structure = workspace.structure;
  if (structure && Array.isArray(structure)) {
    sections.push("## Directory Structure");
    for (const item of structure) {
      sections.push(`- ${item}`);
    }
    sections.push("");
  }

  // Read/Write rules from agent nodes
  const agents = ast.nodes.filter((n) => n.type === "agent") as AgentNode[];
  if (agents.length > 0) {
    sections.push("## Read/Write Rules");
    for (const agent of agents) {
      const reads = agent.reads ?? [];
      const writes = agent.writes ?? [];
      if (reads.length > 0 || writes.length > 0) {
        sections.push(`### ${toTitle(agent.id)}`);
        if (reads.length > 0) {
          sections.push(`- Reads: ${reads.join(", ")}`);
        }
        if (writes.length > 0) {
          sections.push(`- Writes: ${writes.join(", ")}`);
        }
        sections.push("");
      }
    }
  }

  return {
    path: `.codex/${protocol}`,
    content: sections.join("\n") + "\n",
    category: "machine",
  };
}

// ---------------------------------------------------------------------------
// Skill documentation
// ---------------------------------------------------------------------------

/**
 * Generate skills where Codex reads them: `.agents/skills/<id>/SKILL.md`
 * (frontmatter `name` and `description`), plus `agents/openai.yaml` with
 * `policy.allow_implicit_invocation: false` for a skill that disables model
 * invocation (CX-7).
 */
function generateSkills(ast: TopologyAST): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  for (const skill of ast.skills) {
    const sections: string[] = [];
    const oneLine = (skill.description || toTitle(skill.id)).replace(/\s+/g, " ").trim();

    sections.push("---");
    sections.push(`name: ${skill.id}`);
    sections.push(`description: ${JSON.stringify(oneLine)}`);
    sections.push("---");
    sections.push("");
    sections.push(`# ${toTitle(skill.id)}`);
    sections.push("");
    if (skill.description) {
      sections.push(skill.description);
      sections.push("");
    }
    if (skill.scripts && skill.scripts.length > 0) {
      sections.push("## Scripts");
      for (const s of skill.scripts) {
        sections.push(`- ${s}`);
      }
      sections.push("");
    }
    if (skill.domains && skill.domains.length > 0) {
      sections.push("## Domains");
      for (const d of skill.domains) {
        sections.push(`- ${d}`);
      }
      sections.push("");
    }
    if (skill.references && skill.references.length > 0) {
      sections.push("## References");
      for (const r of skill.references) {
        sections.push(`- ${r}`);
      }
      sections.push("");
    }
    if (skill.prompt) {
      sections.push(`Prompt file: ${skill.prompt}`);
      sections.push("");
    }
    if (skill.userInvocable != null) {
      sections.push(`User-invocable: ${skill.userInvocable ? "yes" : "no"}`);
      sections.push("");
    }
    if (skill.allowedTools && skill.allowedTools.length > 0) {
      sections.push(`Allowed tools: ${skill.allowedTools.join(", ")}`);
      sections.push("");
    }
    if (skill.context) {
      sections.push(`Context: ${skill.context}`);
      sections.push("");
    }
    if (skill.agent) {
      sections.push(`Agent: ${skill.agent}`);
      sections.push("");
    }

    files.push({
      path: `.agents/skills/${skill.id}/SKILL.md`,
      content: sections.join("\n") + "\n",
      category: "agent",
    });

    if (skill.disableModelInvocation) {
      files.push({
        path: `.agents/skills/${skill.id}/agents/openai.yaml`,
        content: "policy:\n  allow_implicit_invocation: false\n",
        category: "machine",
      });
    }
  }

  return files;
}

// ---------------------------------------------------------------------------
// Per-agent TOML files — .codex/agents/<name>.toml
// ---------------------------------------------------------------------------

/**
 * Build developer_instructions for an agent that has no explicit prompt.
 * Constructs instructions from role description, tools, reads/writes, and outputs.
 */
function buildDeveloperInstructions(agent: AgentNode, ast: TopologyAST): string {
  const parts: string[] = [];

  // Role description
  const roleText =
    ast.roles[agent.role ?? ""] ?? ast.roles[agent.id] ?? agent.role;
  if (roleText) {
    parts.push(`You are a ${toTitle(agent.id)} agent. ${roleText}`);
  } else {
    parts.push(`You are the ${toTitle(agent.id)} agent.`);
  }

  // Tools
  if (agent.tools && agent.tools.length > 0) {
    parts.push(`\nAvailable tools: ${agent.tools.join(", ")}`);
  }
  if (agent.disallowedTools && agent.disallowedTools.length > 0) {
    parts.push(`Disallowed tools: ${agent.disallowedTools.join(", ")}`);
  }

  // Memory access
  if (agent.reads && agent.reads.length > 0) {
    parts.push(`\nReads from: ${agent.reads.join(", ")}`);
  }
  if (agent.writes && agent.writes.length > 0) {
    parts.push(`Writes to: ${agent.writes.join(", ")}`);
  }

  // Outputs
  if (agent.outputs) {
    const outputLines: string[] = [];
    for (const [field, values] of Object.entries(agent.outputs)) {
      outputLines.push(`  ${field}: ${values.join(" | ")}`);
    }
    parts.push(`\nOutputs:\n${outputLines.join("\n")}`);
  }

  return parts.join("\n");
}

/**
 * Generate per-agent TOML files under `.codex/agents/<name>.toml`.
 *
 * Each agent in the topology gets its own TOML configuration file with
 * name, description, developer_instructions, model, sandbox_mode,
 * model_reasoning_effort, nickname_candidates, and optional MCP servers.
 */
function generateAgentTomlFiles(ast: TopologyAST): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const agents = ast.nodes.filter((n) => n.type === "agent") as AgentNode[];

  for (const agent of agents) {
    const lines: string[] = [];

    // name
    lines.push(`name = ${tomlString(agent.id)}`);

    // description
    const desc = agent.description
      ?? ast.roles[agent.role ?? ""]
      ?? ast.roles[agent.id]
      ?? agent.role
      ?? toTitle(agent.id);
    lines.push(`description = ${tomlString(desc)}`);

    // developer_instructions — the written prompt sits between the prompt markers so sync can read it back.
    const instructions = agent.prompt
      ? `${PROMPT_FENCE_OPEN}\n${agent.prompt}\n${PROMPT_FENCE_CLOSE}`
      : buildDeveloperInstructions(agent, ast);
    lines.push(`developer_instructions = ${tomlMultiline(instructions)}`);

    // model — only the agent's own, and never a Claude name (scaffold refused those).
    if (agent.model) {
      lines.push(`model = ${tomlString(agent.model)}`);
    }

    // model_reasoning_effort
    if (agent.thinking) {
      const effort = mapReasoningEffort(agent.thinking);
      if (effort) {
        lines.push(`model_reasoning_effort = ${tomlString(effort)}`);
      }
    }

    // Not written: sandbox_mode, approval_policy, model_provider and mcp_servers cannot
    // be overridden from an agent file (Codex ignores them there); nickname_candidates
    // is not a documented key. Scaffold warns about the first and the last-but-one.

    files.push({
      path: `.codex/agents/${agent.id}.toml`,
      content: lines.join("\n") + "\n",
      category: "agent",
    });
  }

  return files;
}

// ---------------------------------------------------------------------------
// Binding export
// ---------------------------------------------------------------------------

/** Refuse a topology that names a Claude model: Codex runs none, and no Codex model is invented in its place. */
function refuseClaudeModels(ast: TopologyAST): void {
  const bad: string[] = [];
  for (const n of ast.nodes) {
    const model = (n as { model?: string }).model;
    if (model && isClaudeModelName(model)) bad.push(`${n.type} "${n.id}" uses the Claude model "${model}"`);
  }
  if (bad.length > 0) {
    throw new BindingRefusal(
      `Codex runs no Claude model: ${bad.join("; ")}. Set a Codex model on each (for example gpt-5.2). Nothing was written.`,
    );
  }
}

/** OpenAI Codex CLI binding — full implementation. */
export const codexBinding: BindingTarget = {
  name: "codex",
  description:
    "OpenAI Codex CLI — generates .codex/config.toml, AGENTS.md, .codex/ directory structure, and scripts.",

  scaffold(ast: TopologyAST): GeneratedFile[] {
    warnSessionsNotCompiled(ast, "codex");
    refuseClaudeModels(ast);
    pendingWarnings = [];
    for (const w of codexWarnings(ast)) codexWarn(w.message);
    const files: GeneratedFile[] = [];

    // 1. .codex/config.toml — main configuration
    files.push(generateCodexToml(ast));

    // 2. AGENTS.md — agent instructions with roles, flow, memory paths
    //    (Codex reads AGENTS.md from workspace root; no separate instructions.md)
    files.push(generateAgentsMd(ast));

    // 3. Per-agent TOML files under .codex/agents/
    files.push(...generateAgentTomlFiles(ast));

    // 4. Memory directories
    files.push(...generateMemory(ast));

    // 5. Skill documentation
    files.push(...generateSkills(ast));

    // 6. Gate scripts
    files.push(...generateGateScripts(ast));

    // 7. Hook scripts
    files.push(...generateHookScripts(ast));

    // 8. Tool scripts
    files.push(...generateToolScripts(ast));

    // 9. Workspace protocol
    const wsProtocol = generateWorkspaceProtocol(ast);
    if (wsProtocol) files.push(wsProtocol);

    // 10. Metering
    const meteringFile = generateMetering(ast);
    if (meteringFile) files.push(meteringFile);

    for (const w of pendingWarnings) console.warn(w);
    pendingWarnings = [];
    return deduplicateFiles(files);
  },
};
