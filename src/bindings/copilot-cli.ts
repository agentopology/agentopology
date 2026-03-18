/**
 * GitHub Copilot CLI binding.
 *
 * Generates the `.github/` directory structure for GitHub Copilot CLI
 * (terminal agent) and Copilot Coding Agent (server-side):
 * - `.github/copilot-instructions.md` — project-level instructions
 * - `.github/instructions/{id}.instructions.md` — per-agent scoped instructions
 * - `.github/agents/{id}.agent.md` — per-agent definitions with tools and prompt
 * - `.github/copilot/settings.json` — CLI config (MCP, permissions)
 * - `.github/skills/{name}/SKILL.md` — agent skills
 * - `.github/hooks/{name}.json` — preToolUse/postToolUse hooks
 * - `.github/workflows/copilot-setup-steps.yml` — server-side env setup
 * - `AGENTS.md` — topology overview
 *
 * @module
 */

import type {
  TopologyAST,
  AgentNode,
  ActionNode,
  GateNode,
  HumanNode,
  GroupNode,
  HookDef,
  SchemaFieldDef,
  RetryConfig,
  SensitiveValue,
} from "../parser/ast.js";
import { deduplicateFiles } from "./types.js";
import type { BindingTarget, GeneratedFile } from "./types.js";

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

/**
 * Build YAML frontmatter block for a `.instructions.md` file.
 *
 * Copilot `.instructions.md` files support only:
 * - `applyTo` — glob pattern(s) for path-scoping
 * - `excludeAgent` — optional, `"code-review"` or `"coding-agent"`
 */
function frontmatter(fields: Record<string, string>): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    lines.push(`${key}: "${value}"`);
  }
  lines.push("---");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tool mapping
// ---------------------------------------------------------------------------

/**
 * Map topology-level tool names to Copilot Coding Agent tool aliases.
 *
 * Copilot tool aliases: read, edit, execute, search, web, agent, todo
 */
const TOOL_MAP: Record<string, string> = {
  // Claude Code tools -> Copilot aliases
  Read: "read",
  Write: "edit",
  Edit: "edit",
  Bash: "execute",
  Grep: "search",
  Glob: "search",
  WebFetch: "web",
  WebSearch: "web",
  // Pass through Copilot-native aliases
  read: "read",
  edit: "edit",
  execute: "execute",
  search: "search",
  web: "web",
  agent: "agent",
  todo: "todo",
};

/** Map a single tool name to its Copilot equivalent. Unknown tools pass through. */
function mapTool(tool: string): string {
  return TOOL_MAP[tool] ?? tool;
}

/** Map and deduplicate a list of tool names. */
function mapTools(tools: string[]): string[] {
  const mapped = new Set<string>();
  for (const t of tools) {
    mapped.add(mapTool(t));
  }
  return [...mapped];
}

// ---------------------------------------------------------------------------
// Schema & retry helpers
// ---------------------------------------------------------------------------

/** Format a SchemaType to a human-readable string. */
function formatSchemaType(t: SchemaFieldDef["type"]): string {
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

/** Format a schema field for documentation. */
function formatSchemaField(field: SchemaFieldDef): string {
  const opt = field.optional ? "?" : "";
  const typeStr = formatSchemaType(field.type);
  return `${field.name}${opt}: ${typeStr}`;
}

/** Format retry config for documentation. */
function formatRetry(retry: number | RetryConfig): string {
  if (typeof retry === "number") return `max ${retry} attempts`;
  const parts = [`max ${retry.max} attempts`];
  if (retry.backoff) parts.push(`backoff: ${retry.backoff}`);
  if (retry.interval) parts.push(`interval: ${retry.interval}`);
  if (retry.maxInterval) parts.push(`max interval: ${retry.maxInterval}`);
  if (retry.jitter) parts.push("jitter: on");
  if (retry.nonRetryable && retry.nonRetryable.length > 0) {
    parts.push(`non-retryable: ${retry.nonRetryable.join(", ")}`);
  }
  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// Section generators
// ---------------------------------------------------------------------------

/**
 * Generate `.github/copilot-instructions.md` — project-level instructions
 * with topology overview, flow, roles, and memory layout.
 */
function generateInstructions(ast: TopologyAST): GeneratedFile {
  const sections: string[] = [];

  sections.push(`# ${toTitle(ast.topology.name)}`);
  sections.push("");
  if (ast.topology.description) {
    sections.push(ast.topology.description);
    sections.push("");
  }
  sections.push(`Version: ${ast.topology.version}`);
  if (ast.topology.patterns.length > 0) {
    sections.push(`Patterns: ${ast.topology.patterns.join(", ")}`);
  }
  sections.push("");

  // Orchestrator info
  const orch = ast.nodes.find((n) => n.type === "orchestrator");
  if (orch) {
    sections.push("## Orchestrator");
    sections.push("");
    sections.push(`Model: ${(orch as any).model}`);
    if ((orch as any).handles?.length > 0) {
      sections.push(`Handles: ${(orch as any).handles.join(", ")}`);
    }
    if ((orch as any).generates) {
      sections.push(`Generates: ${(orch as any).generates}`);
    }
    sections.push("");
  }

  // Flow overview
  if (ast.edges.length > 0) {
    sections.push("## Flow");
    sections.push("");
    for (const edge of ast.edges) {
      let line = edge.isError ? `${edge.from} -x-> ${edge.to}` : `${edge.from} -> ${edge.to}`;
      if (edge.condition) line += ` [when ${edge.condition}]`;
      if (edge.maxIterations) line += ` [max ${edge.maxIterations}]`;
      if (edge.errorType) line += ` [error: ${edge.errorType}]`;
      if (edge.race) line += ` [race]`;
      if (edge.tolerance != null) line += ` [tolerance: ${edge.tolerance}]`;
      if (edge.wait) line += ` [wait ${edge.wait}]`;
      sections.push(`- ${line}`);
    }
    sections.push("");
  }

  // Agent summary table
  const agents = ast.nodes.filter((n) => n.type === "agent") as AgentNode[];
  if (agents.length > 0) {
    sections.push("## Agents");
    sections.push("");
    sections.push("| Agent | Phase | Model | Role |");
    sections.push("|-------|-------|-------|------|");
    for (const agent of agents) {
      const phase = agent.phase != null ? String(agent.phase) : "-";
      const model = agent.model ?? "-";
      const role = agent.role ?? "-";
      sections.push(`| ${agent.id} | ${phase} | ${model} | ${role} |`);
    }
    sections.push("");
  }

  // Roles section
  if (Object.keys(ast.roles).length > 0) {
    sections.push("## Roles");
    sections.push("");
    for (const [name, desc] of Object.entries(ast.roles)) {
      sections.push(`### ${toTitle(name)}`);
      sections.push(desc);
      sections.push("");
    }
  }

  // Gates section
  const gates = ast.nodes.filter((n) => n.type === "gate") as GateNode[];
  if (gates.length > 0) {
    sections.push("## Gates");
    sections.push("");
    for (const gate of gates) {
      sections.push(`### ${toTitle(gate.id)}`);
      if (gate.after) sections.push(`After: ${gate.after}`);
      if (gate.before) sections.push(`Before: ${gate.before}`);
      if (gate.run) sections.push(`Run: ${gate.run}`);
      if (gate.checks && gate.checks.length > 0) {
        sections.push(`Checks: ${gate.checks.join(", ")}`);
      }
      if (gate.onFail) sections.push(`On fail: ${gate.onFail}`);
      sections.push("");
    }
  }

  // Triggers section
  if (ast.triggers.length > 0) {
    sections.push("## Triggers");
    sections.push("");
    for (const trigger of ast.triggers) {
      sections.push(`### /${trigger.name}`);
      sections.push(`Pattern: \`${trigger.pattern}\``);
      if (trigger.argument) sections.push(`Argument: ${trigger.argument}`);
      sections.push("");
    }
  }

  // Interfaces section
  if (ast.interfaces.length > 0) {
    sections.push("## Interfaces");
    sections.push("");
    for (const iface of ast.interfaces) {
      const typePart = iface.type ? ` (${iface.type})` : "";
      const configKeys = Object.keys(iface.config);
      const configPart = configKeys.length > 0 ? ` — ${configKeys.map((k) => `${k}: ${iface.config[k]}`).join(", ")}` : "";
      sections.push(`- **${iface.id}**${typePart}${configPart}`);
    }
    sections.push("");
  }

  // Memory section
  if (Object.keys(ast.memory).length > 0) {
    sections.push("## Memory");
    sections.push("");
    for (const [key, value] of Object.entries(ast.memory)) {
      if (value) {
        sections.push(`- **${key}**: configured`);
      }
    }
    sections.push("");
  }

  // Provider credentials
  if (ast.providers && ast.providers.length > 0) {
    const githubProvider = ast.providers.find((p) => p.name === "github");
    if (githubProvider?.apiKey) {
      sections.push("## Authentication");
      sections.push("");
      sections.push(`Set the environment variable referenced by the provider: \`${githubProvider.apiKey}\``);
      sections.push("");
    }
  }

  // Context includes
  if (ast.context.includes && ast.context.includes.length > 0) {
    sections.push("## Includes");
    sections.push("");
    for (const inc of ast.context.includes) {
      sections.push(`- ${inc}`);
    }
    sections.push("");
  }

  return {
    path: ".github/copilot-instructions.md",
    content: sections.join("\n") + "\n",
    category: "agent",
  };
}

/**
 * Build an `applyTo` glob pattern from an agent's reads/writes paths.
 *
 * If the agent has file paths, they are joined with commas.
 * If no paths are available, returns `"**"` as a general scope.
 */
function buildApplyTo(agent: AgentNode): string {
  const paths: string[] = [];
  if (agent.reads && agent.reads.length > 0) paths.push(...agent.reads);
  if (agent.writes && agent.writes.length > 0) paths.push(...agent.writes);

  if (paths.length === 0) return "**";

  // Convert directory paths (ending with /) to glob patterns
  const globs = paths.map((p) => (p.endsWith("/") ? `${p}**` : p));
  return globs.join(",");
}

/**
 * Generate `.github/instructions/{id}.instructions.md` for each agent node.
 *
 * Each file has YAML frontmatter with `applyTo` (the only supported Copilot
 * frontmatter key for scoping). The markdown body contains role, tools,
 * reads/writes, outputs, skills, and behavior information.
 */
function generateAgents(ast: TopologyAST): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  for (const node of ast.nodes) {
    if (node.type !== "agent") continue;
    const agent = node as AgentNode;

    // --- Build frontmatter (only supported keys: applyTo, excludeAgent) ---
    const fm: Record<string, string> = {};
    fm.applyTo = buildApplyTo(agent);

    // --- Build body ---
    const sections: string[] = [frontmatter(fm), ""];

    // Title
    sections.push(`# ${toTitle(agent.id)} Agent`);
    sections.push("");

    // Description
    const desc =
      agent.description ??
      ast.roles[agent.role ?? ""] ??
      ast.roles[agent.id] ??
      agent.role;
    if (desc) {
      sections.push(desc);
      sections.push("");
    }

    // Role section
    const roleText =
      ast.roles[agent.role ?? ""] ?? ast.roles[agent.id] ?? agent.role;
    if (roleText && roleText !== desc) {
      sections.push("## Role");
      sections.push(roleText);
      sections.push("");
    }

    if (agent.prompt) {
      sections.push("## Instructions");
      sections.push(agent.prompt);
      sections.push("");
    }

    // Tools section
    if (agent.tools && agent.tools.length > 0) {
      const mapped = mapTools(agent.tools);
      sections.push("## Tools");
      sections.push(mapped.join(", "));
      sections.push("");
    }

    // Disallowed tools — document deny-tool flags in agent body
    if (agent.disallowedTools && agent.disallowedTools.length > 0) {
      const mapped = mapTools(agent.disallowedTools);
      sections.push("## Disallowed Tools");
      sections.push("");
      sections.push("The following tools are denied for this agent via `--deny-tool` flags:");
      for (const t of mapped) {
        sections.push(`- \`--deny-tool ${t}\``);
      }
      sections.push("");
    }

    // Constraints section (phase, timeout, model, etc.)
    {
      const constraints: string[] = [];
      if (agent.phase != null) constraints.push(`- Phase: ${agent.phase}`);
      if (agent.model) constraints.push(`- Model: ${agent.model}`);
      if (agent.timeout) constraints.push(`- Timeout: ${agent.timeout}`);
      if (agent.permissions) constraints.push(`- Permissions: ${agent.permissions}`);
      if (constraints.length > 0) {
        sections.push("## Constraints");
        sections.push(...constraints);
        sections.push("");
      }
    }

    // Reads section
    if (agent.reads && agent.reads.length > 0) {
      sections.push("## Reads");
      for (const r of agent.reads) {
        sections.push(`- ${r}`);
      }
      sections.push("");
    }

    // Writes section
    if (agent.writes && agent.writes.length > 0) {
      sections.push("## Writes");
      for (const w of agent.writes) {
        sections.push(`- ${w}`);
      }
      sections.push("");
    }

    // Outputs section
    if (agent.outputs) {
      sections.push("## Outputs");
      for (const [field, values] of Object.entries(agent.outputs)) {
        sections.push(`- ${field}: ${values.join(" | ")}`);
      }
      sections.push("");
    }

    // Skills
    if (agent.skills && agent.skills.length > 0) {
      sections.push(`Skills: ${agent.skills.join(", ")}`);
      sections.push("");
    }

    // Behavior
    if (agent.behavior) {
      sections.push(`Behavior: ${agent.behavior}`);
      sections.push("");
    }

    // Skip condition
    if (agent.skip) {
      sections.push(`Skip when: ${agent.skip}`);
      sections.push("");
    }

    // Scale info
    if (agent.scale) {
      sections.push("## Scale");
      sections.push(`Mode: ${agent.scale.mode}`);
      sections.push(`By: ${agent.scale.by}`);
      sections.push(`Range: ${agent.scale.min}-${agent.scale.max}`);
      if (agent.scale.batchSize != null) {
        sections.push(`Batch size: ${agent.scale.batchSize}`);
      }
      sections.push("");
    }

    // Fallback chain
    if (agent.fallbackChain && agent.fallbackChain.length > 0) {
      sections.push("## Fallback Chain");
      sections.push(`Models: ${agent.fallbackChain.join(" -> ")}`);
      sections.push("");
    }

    // On-fail
    if (agent.onFail) {
      sections.push(`On failure: ${agent.onFail}`);
      sections.push("");
    }

    // Retry
    if (agent.retry != null) {
      sections.push(`Retry strategy: ${formatRetry(agent.retry)}`);
      sections.push("");
    }

    // Sampling parameters
    {
      const samplingParts: string[] = [];
      if (agent.temperature != null) samplingParts.push(`temperature=${agent.temperature}`);
      if (agent.maxTokens != null) samplingParts.push(`max-tokens=${agent.maxTokens}`);
      if (agent.topP != null) samplingParts.push(`top-p=${agent.topP}`);
      if (agent.topK != null) samplingParts.push(`top-k=${agent.topK}`);
      if (agent.seed != null) samplingParts.push(`seed=${agent.seed}`);
      if (agent.stop && agent.stop.length > 0) samplingParts.push(`stop=${agent.stop.join(", ")}`);
      if (samplingParts.length > 0) {
        sections.push(`Model config: ${samplingParts.join(", ")}`);
        sections.push("");
      }
    }

    // Thinking
    if (agent.thinking) {
      let thinkingLine = `Reasoning level: ${agent.thinking}`;
      if (agent.thinkingBudget != null) {
        thinkingLine += ` (budget: ${agent.thinkingBudget} tokens)`;
      }
      sections.push(thinkingLine);
      sections.push("");
    }

    // Output format
    if (agent.outputFormat) {
      sections.push(`Output format: ${agent.outputFormat}`);
      sections.push("");
    }

    // Log level
    if (agent.logLevel) {
      sections.push(`Log verbosity: ${agent.logLevel}`);
      sections.push("");
    }

    // Join semantics
    if (agent.join) {
      sections.push(`Wait for: ${agent.join} (join strategy for upstream agents)`);
      sections.push("");
    }

    // Circuit breaker
    if (agent.circuitBreaker) {
      const cb = agent.circuitBreaker;
      sections.push("## Circuit Breaker");
      sections.push(`- Failure threshold: ${cb.threshold}`);
      sections.push(`- Window: ${cb.window}`);
      sections.push(`- Cooldown: ${cb.cooldown}`);
      sections.push("");
    }

    // Compensation (saga)
    if (agent.compensates) {
      sections.push(`This agent compensates (can undo) the work of: ${agent.compensates}`);
      sections.push("");
    }

    // Input/output schemas
    if (agent.inputSchema && agent.inputSchema.length > 0) {
      sections.push("## Input Schema");
      for (const field of agent.inputSchema) {
        sections.push(`- ${formatSchemaField(field)}`);
      }
      sections.push("");
    }

    if (agent.outputSchema && agent.outputSchema.length > 0) {
      sections.push("## Output Schema");
      for (const field of agent.outputSchema) {
        sections.push(`- ${formatSchemaField(field)}`);
      }
      sections.push("");
    }

    // Rate limit
    if (agent.rateLimit) {
      sections.push(`Rate limit: ${agent.rateLimit}`);
      sections.push("");
    }

    // Produces / consumes artifacts
    if ((agent.produces && agent.produces.length > 0) || (agent.consumes && agent.consumes.length > 0)) {
      sections.push("## Artifacts");
      if (agent.produces && agent.produces.length > 0) {
        sections.push(`Produces: ${agent.produces.join(", ")}`);
      }
      if (agent.consumes && agent.consumes.length > 0) {
        sections.push(`Consumes: ${agent.consumes.join(", ")}`);
      }
      sections.push("");
    }

    // Prompt variants
    if (agent.variants && agent.variants.length > 0) {
      sections.push("## Prompt Variants");
      for (const v of agent.variants) {
        const parts = [`**${v.id}** (weight: ${v.weight})`];
        if (v.model) parts.push(`model: ${v.model}`);
        if (v.temperature != null) parts.push(`temperature: ${v.temperature}`);
        sections.push(`- ${parts.join(", ")}`);
      }
      sections.push("");
    }

    files.push({
      path: `.github/instructions/${agent.id}.instructions.md`,
      content: sections.join("\n") + "\n",
      category: "agent",
    });
  }

  return files;
}

/**
 * Generate `.github/instructions/{id}.instructions.md` for each human node.
 *
 * Human nodes represent approval/input points. The instructions file tells
 * Copilot to pause and request human intervention. These are informational
 * context files only — no `.agent.md` is generated for human nodes since
 * they are not automated agents.
 */
function generateHumanAgents(ast: TopologyAST): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  for (const node of ast.nodes) {
    if (node.type !== "human") continue;
    const human = node as HumanNode;

    const sections: string[] = ["<!-- Informational: human-in-the-loop node (not an automated agent) -->", ""];
    sections.push(`# ${toTitle(human.id)} (Human Approval)`);
    sections.push("");
    sections.push("This is a human-in-the-loop checkpoint. You must pause execution and request human input or approval before proceeding.");
    sections.push("");

    if (human.description) {
      sections.push("## Instructions");
      sections.push(human.description);
      sections.push("");
    }

    if (human.timeout) {
      sections.push(`Timeout: ${human.timeout}`);
      sections.push("");
    }

    if (human.onTimeout) {
      sections.push(`On timeout: ${human.onTimeout}`);
      sections.push("");
    }

    files.push({
      path: `.github/instructions/${human.id}.instructions.md`,
      content: sections.join("\n") + "\n",
      category: "machine",
    });
  }

  return files;
}

/**
 * Generate `.github/instructions/{id}.instructions.md` for each group node.
 *
 * Group nodes represent multi-agent conversation/debate coordination points.
 * These are informational context files only — no `.agent.md` is generated
 * for group nodes since they are coordination constructs, not automated agents.
 */
function generateGroupAgents(ast: TopologyAST): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  for (const node of ast.nodes) {
    if (node.type !== "group") continue;
    const group = node as GroupNode;

    const sections: string[] = ["<!-- Informational: group chat coordination node (not an automated agent) -->", ""];
    sections.push(`# ${toTitle(group.id)} (Group Chat)`);
    sections.push("");

    if (group.description) {
      sections.push(group.description);
      sections.push("");
    }

    sections.push("## Role");
    sections.push("Coordinate a multi-agent conversation among the participating members.");
    sections.push("");

    sections.push("## Members");
    for (const member of group.members) {
      sections.push(`- ${member}`);
    }
    sections.push("");

    if (group.speakerSelection) {
      sections.push(`Speaker selection: ${group.speakerSelection}`);
      sections.push("");
    }

    if (group.maxRounds != null) {
      sections.push(`Maximum rounds: ${group.maxRounds}`);
      sections.push("");
    }

    if (group.termination) {
      sections.push(`Termination condition: ${group.termination}`);
      sections.push("");
    }

    if (group.timeout) {
      sections.push(`Timeout: ${group.timeout}`);
      sections.push("");
    }

    files.push({
      path: `.github/instructions/${group.id}.instructions.md`,
      content: sections.join("\n") + "\n",
      category: "agent",
    });
  }

  return files;
}

/**
 * Build YAML frontmatter block for a `.agent.md` file.
 *
 * Copilot `.agent.md` files support:
 * - `name` — agent identifier
 * - `description` — agent description
 * - `tools` — list of Copilot tool aliases
 */
function agentFrontmatter(fields: {
  name: string;
  description: string;
  tools: string[];
  model?: string;
}): string {
  const lines = ["---"];
  lines.push(`name: ${fields.name}`);
  lines.push(`description: ${fields.description}`);
  if (fields.model) {
    lines.push(`model: ${fields.model}`);
  }
  if (fields.tools.length > 0) {
    lines.push("tools:");
    for (const tool of fields.tools) {
      lines.push(`  - ${tool}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

/**
 * Generate `.github/agents/{id}.agent.md` for each agent node.
 *
 * Each file has YAML frontmatter with `name`, `description`, and `tools`
 * (mapped to Copilot tool aliases). The markdown body contains the agent
 * prompt and role information.
 *
 * Human and group nodes do NOT get `.agent.md` files since they are not agents.
 */
function generateAgentMdFiles(ast: TopologyAST): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  for (const node of ast.nodes) {
    if (node.type !== "agent") continue;
    const agent = node as AgentNode;

    // Build description from available sources
    const desc =
      agent.description ??
      ast.roles[agent.role ?? ""] ??
      ast.roles[agent.id] ??
      agent.role ??
      toTitle(agent.id);

    // Map tools to Copilot aliases
    const tools = agent.tools ? mapTools(agent.tools) : [];

    const sections: string[] = [];
    sections.push(agentFrontmatter({ name: agent.id, description: desc, tools, model: agent.model }));
    sections.push("");

    // Agent prompt as body
    if (agent.prompt) {
      sections.push(agent.prompt);
      sections.push("");
    }

    // Role context
    const roleText =
      ast.roles[agent.role ?? ""] ?? ast.roles[agent.id] ?? agent.role;
    if (roleText && roleText !== agent.prompt) {
      sections.push(`## Role`);
      sections.push(roleText);
      sections.push("");
    }

    // Description if different from prompt
    if (agent.description && agent.description !== agent.prompt) {
      sections.push(`## Description`);
      sections.push(agent.description);
      sections.push("");
    }

    // Behavior constraints
    if (agent.permissions) {
      sections.push(`Permissions: ${agent.permissions}`);
      sections.push("");
    }

    if (agent.onFail) {
      sections.push(`On failure: ${agent.onFail}`);
      sections.push("");
    }

    files.push({
      path: `.github/agents/${agent.id}.agent.md`,
      content: sections.join("\n") + "\n",
      category: "agent",
    });
  }

  return files;
}

/**
 * Generate `.github/workflows/copilot-setup-steps.yml` — the REQUIRED
 * Copilot environment setup workflow.
 *
 * This file must have the exact job name `copilot-setup-steps` and is used
 * for environment setup only (checkout, install deps, set env vars, make
 * scripts executable). It is NOT a topology orchestration workflow.
 *
 * Generated from the topology's gate scripts, tool scripts, and env vars.
 */
function generateSetupSteps(ast: TopologyAST): GeneratedFile | null {
  const gates = ast.nodes.filter((n) => n.type === "gate") as GateNode[];
  const hasGateScripts = gates.some((g) => g.run && g.behavior !== "advisory");
  const hasPythonTools = ast.toolDefs.some((t) => t.lang === "python");
  const hasEnv = Object.keys(ast.env).length > 0;

  // Only generate if there's something to set up
  if (!hasGateScripts && !hasPythonTools && ast.toolDefs.length === 0 && !hasEnv) {
    return null;
  }

  const name = ast.topology.name;
  const lines: string[] = [];
  lines.push(`# Auto-generated by agentopology scaffold for topology: ${name}`);
  lines.push(`# Copilot setup steps — environment preparation for the coding agent.`);
  lines.push("");
  lines.push(`name: "Copilot Setup Steps"`);
  lines.push("on: workflow_dispatch");
  lines.push("");
  lines.push("jobs:");
  lines.push("  copilot-setup-steps:");
  lines.push("    runs-on: ubuntu-latest");

  // Set env vars from topology
  if (hasEnv) {
    lines.push("    env:");
    for (const [key, val] of Object.entries(ast.env)) {
      const value = typeof val === "string" ? val : val.value;
      // Skip secret references — those should be in GitHub Secrets
      if (typeof val !== "string" && val.sensitive) {
        lines.push(`      ${key}: \${{ secrets.${key} }}`);
      } else {
        lines.push(`      ${key}: "${value}"`);
      }
    }
  }

  lines.push("    steps:");
  lines.push("      - uses: actions/checkout@v4");

  // Make gate scripts executable
  if (hasGateScripts) {
    lines.push("");
    lines.push("      - name: Make gate scripts executable");
    lines.push("        run: |");
    lines.push("          chmod +x scripts/*.sh 2>/dev/null || true");
  }

  // Make tool scripts executable
  const bashTools = ast.toolDefs.filter((t) => t.lang === "bash");
  if (bashTools.length > 0) {
    lines.push("");
    lines.push("      - name: Make tool scripts executable");
    lines.push("        run: |");
    for (const tool of bashTools) {
      lines.push(`          chmod +x ${tool.script}`);
    }
  }

  // Install Python dependencies if Python tools exist
  if (hasPythonTools) {
    lines.push("");
    lines.push("      - name: Install Python dependencies");
    lines.push("        run: |");
    lines.push("          pip install -r requirements.txt 2>/dev/null || true");
  }

  lines.push("");

  return {
    path: ".github/workflows/copilot-setup-steps.yml",
    content: lines.join("\n") + "\n",
    category: "machine",
  };
}

/**
 * Generate gate check documentation in copilot-instructions.
 *
 * Since Copilot agents run in sandboxed GitHub Actions, gates are
 * expressed as run_command invocations documented in instructions.
 */
function generateGateInstructions(ast: TopologyAST): string {
  const gates = ast.nodes.filter((n) => n.type === "gate") as GateNode[];
  if (gates.length === 0) return "";

  const lines: string[] = [];
  lines.push("## Quality Gates");
  lines.push("");
  lines.push("The following quality gates must pass before proceeding:");
  lines.push("");

  for (const gate of gates) {
    lines.push(`### ${toTitle(gate.id)}`);
    if (gate.after) lines.push(`- Run after: ${gate.after}`);
    if (gate.before) lines.push(`- Run before: ${gate.before}`);
    if (gate.run) lines.push(`- Command: \`${gate.run}\``);
    if (gate.checks && gate.checks.length > 0) {
      lines.push(`- Checks: ${gate.checks.join(", ")}`);
    }
    if (gate.onFail) lines.push(`- On failure: ${gate.onFail}`);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Generate hook documentation for copilot-instructions.
 *
 * Copilot does not have a native hook system, so hooks are documented
 * as recommended practices in the instructions file.
 */
function generateHookInstructions(ast: TopologyAST): string {
  if (ast.hooks.length === 0) return "";

  const lines: string[] = [];
  lines.push("## Hooks");
  lines.push("");
  lines.push("The following hooks should be run at the appropriate times:");
  lines.push("");

  for (const hook of ast.hooks) {
    lines.push(`### ${hook.name}`);
    lines.push(`- Event: ${hook.on}`);
    if (hook.matcher) lines.push(`- Matcher: ${hook.matcher}`);
    lines.push(`- Run: \`${hook.run}\``);
    if (hook.timeout) lines.push(`- Timeout: ${hook.timeout}ms`);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Generate memory documentation as a section to append to copilot-instructions.
 *
 * Since Copilot agents operate on the repository, memory paths are documented
 * so agents know where to read/write shared state.
 */
function generateMemoryInstructions(ast: TopologyAST): string {
  const agents = ast.nodes.filter((n) => n.type === "agent") as AgentNode[];
  const hasReadsWrites = agents.some(
    (a) => (a.reads && a.reads.length > 0) || (a.writes && a.writes.length > 0)
  );

  if (!hasReadsWrites && Object.keys(ast.memory).length === 0) return "";

  const lines: string[] = [];
  lines.push("## Memory Paths");
  lines.push("");

  if (Object.keys(ast.memory).length > 0) {
    lines.push("### Configured Memory");
    for (const [key, value] of Object.entries(ast.memory)) {
      if (value) {
        lines.push(`- **${key}**: configured`);
      }
    }
    lines.push("");
  }

  if (hasReadsWrites) {
    lines.push("### Agent Read/Write Access");
    lines.push("");
    lines.push("| Agent | Reads | Writes |");
    lines.push("|-------|-------|--------|");
    for (const agent of agents) {
      const reads = agent.reads?.join(", ") ?? "-";
      const writes = agent.writes?.join(", ") ?? "-";
      if (reads !== "-" || writes !== "-") {
        lines.push(`| ${agent.id} | ${reads} | ${writes} |`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Generate metering documentation for copilot-instructions.
 */
function generateMeteringInstructions(ast: TopologyAST): string {
  if (!ast.metering) return "";

  const m = ast.metering;
  const lines: string[] = [];
  lines.push("## Metering");
  lines.push("");
  lines.push(`- Track: ${m.track.join(", ")}`);
  lines.push(`- Per: ${m.per.join(", ")}`);
  lines.push(`- Output: ${m.output} (${m.format})`);
  lines.push(`- Pricing: ${m.pricing}`);
  lines.push("");

  return lines.join("\n");
}

/**
 * Generate defaults documentation for copilot-instructions.
 */
function generateDefaultsInstructions(ast: TopologyAST): string {
  if (!ast.defaults) return "";

  const d = ast.defaults;
  const lines: string[] = [];
  lines.push("## Defaults");
  lines.push("");
  lines.push("The following default settings apply to all agents unless overridden:");
  lines.push("");

  if (d.temperature != null) lines.push(`- Temperature: ${d.temperature}`);
  if (d.maxTokens != null) lines.push(`- Max tokens: ${d.maxTokens}`);
  if (d.topP != null) lines.push(`- Top-p: ${d.topP}`);
  if (d.topK != null) lines.push(`- Top-k: ${d.topK}`);
  if (d.stop && d.stop.length > 0) lines.push(`- Stop sequences: ${d.stop.join(", ")}`);
  if (d.seed != null) lines.push(`- Seed: ${d.seed}`);
  if (d.thinking) lines.push(`- Thinking level: ${d.thinking}`);
  if (d.thinkingBudget != null) lines.push(`- Thinking budget: ${d.thinkingBudget} tokens`);
  if (d.outputFormat) lines.push(`- Output format: ${d.outputFormat}`);
  if (d.timeout) lines.push(`- Timeout: ${d.timeout}`);
  if (d.logLevel) lines.push(`- Log level: ${d.logLevel}`);
  lines.push("");

  return lines.join("\n");
}

/**
 * Generate observability documentation for copilot-instructions.
 */
function generateObservabilityInstructions(ast: TopologyAST): string {
  if (!ast.observability) return "";

  const o = ast.observability;
  const lines: string[] = [];
  lines.push("## Observability");
  lines.push("");
  lines.push(`- Enabled: ${o.enabled}`);
  lines.push(`- Level: ${o.level}`);
  lines.push(`- Exporter: ${o.exporter}`);
  if (o.endpoint) lines.push(`- Endpoint: ${o.endpoint}`);
  if (o.service) lines.push(`- Service: ${o.service}`);
  lines.push(`- Sample rate: ${o.sampleRate}`);
  lines.push("");

  const captureItems: string[] = [];
  if (o.capture.prompts) captureItems.push("prompts");
  if (o.capture.completions) captureItems.push("completions");
  if (o.capture.toolArgs) captureItems.push("tool-args");
  if (o.capture.toolResults) captureItems.push("tool-results");
  if (captureItems.length > 0) lines.push(`- Capture: ${captureItems.join(", ")}`);

  const spanItems: string[] = [];
  if (o.spans.agents) spanItems.push("agents");
  if (o.spans.tools) spanItems.push("tools");
  if (o.spans.gates) spanItems.push("gates");
  if (o.spans.memory) spanItems.push("memory");
  if (spanItems.length > 0) lines.push(`- Spans: ${spanItems.join(", ")}`);
  lines.push("");

  return lines.join("\n");
}

/**
 * Generate checkpoint documentation for copilot-instructions.
 */
function generateCheckpointInstructions(ast: TopologyAST): string {
  if (!ast.checkpoint) return "";

  const c = ast.checkpoint;
  const lines: string[] = [];
  lines.push("## Checkpoint");
  lines.push("");
  lines.push(`- Backend: ${c.backend}`);
  lines.push(`- Strategy: ${c.strategy}`);
  if (c.connection) lines.push(`- Connection: ${c.connection}`);
  if (c.ttl) lines.push(`- TTL: ${c.ttl}`);
  if (c.replay) {
    lines.push(`- Replay: ${c.replay.enabled ? "enabled" : "disabled"}`);
    if (c.replay.maxHistory != null) lines.push(`  - Max history: ${c.replay.maxHistory}`);
    if (c.replay.branch != null) lines.push(`  - Branch: ${c.replay.branch}`);
  }
  lines.push("");

  return lines.join("\n");
}

/**
 * Generate depth levels documentation for copilot-instructions.
 */
function generateDepthInstructions(ast: TopologyAST): string {
  if (!ast.depth || !ast.depth.levels || ast.depth.levels.length === 0) return "";

  const lines: string[] = [];
  lines.push("## Depth Levels");
  lines.push("");
  if (ast.depth.factors.length > 0) {
    lines.push(`Factors: ${ast.depth.factors.join(", ")}`);
  }
  for (const level of ast.depth.levels) {
    let line = `- **Level ${level.level}**: ${level.label}`;
    if (level.omit.length > 0) line += ` (omit: ${level.omit.join(", ")})`;
    lines.push(line);
  }
  lines.push("");

  return lines.join("\n");
}

/**
 * Generate params documentation for copilot-instructions.
 */
function generateParamsInstructions(ast: TopologyAST): string {
  if (!ast.params || ast.params.length === 0) return "";

  const lines: string[] = [];
  lines.push("## Parameters");
  lines.push("");
  for (const p of ast.params) {
    const req = p.required ? " (required)" : "";
    const def = p.default != null ? ` = ${p.default}` : "";
    lines.push(`- **${p.name}**: ${p.type}${req}${def}`);
  }
  lines.push("");

  return lines.join("\n");
}

/**
 * Generate interface endpoints documentation for copilot-instructions.
 */
function generateInterfaceEndpointsInstructions(ast: TopologyAST): string {
  if (!ast.interfaceEndpoints) return "";

  const lines: string[] = [];
  lines.push("## Interface");
  lines.push("");
  lines.push(`- Entry: ${ast.interfaceEndpoints.entry}`);
  lines.push(`- Exit: ${ast.interfaceEndpoints.exit}`);
  lines.push("");

  return lines.join("\n");
}

/**
 * Generate imports documentation for copilot-instructions.
 */
function generateImportsInstructions(ast: TopologyAST): string {
  if (!ast.imports || ast.imports.length === 0) return "";

  const lines: string[] = [];
  lines.push("## Imports");
  lines.push("");
  for (const imp of ast.imports) {
    let line = `- **${imp.alias}** from \`${imp.source}\``;
    if (imp.sha256) line += ` (sha256: ${imp.sha256})`;
    if (imp.registry) line += ` [registry: ${imp.registryPackage}@${imp.registryVersion}]`;
    lines.push(line);
    if (Object.keys(imp.params).length > 0) {
      for (const [k, v] of Object.entries(imp.params)) {
        lines.push(`  - ${k}: ${v}`);
      }
    }
  }
  lines.push("");

  return lines.join("\n");
}

/**
 * Generate includes documentation for copilot-instructions.
 */
function generateIncludesInstructions(ast: TopologyAST): string {
  if (!ast.includes || ast.includes.length === 0) return "";

  const lines: string[] = [];
  lines.push("## Includes");
  lines.push("");
  for (const inc of ast.includes) {
    lines.push(`- ${inc.source}`);
  }
  lines.push("");

  return lines.join("\n");
}

/**
 * Generate environment variables documentation for copilot-instructions.
 */
function generateEnvInstructions(ast: TopologyAST): string {
  if (Object.keys(ast.env).length === 0) return "";

  const lines: string[] = [];
  lines.push("## Environment");
  lines.push("");
  for (const [key, val] of Object.entries(ast.env)) {
    const value = typeof val === "string" ? val : val.value;
    lines.push(`- \`${key}\`: ${value}`);
  }
  lines.push("");

  return lines.join("\n");
}

/**
 * Generate artifacts documentation for copilot-instructions.
 */
function generateArtifactsInstructions(ast: TopologyAST): string {
  if (!ast.artifacts || ast.artifacts.length === 0) return "";

  const lines: string[] = [];
  lines.push("## Artifacts");
  lines.push("");

  for (const artifact of ast.artifacts) {
    const parts = [`**${artifact.id}** (${artifact.type})`];
    if (artifact.path) parts.push(`path: ${artifact.path}`);
    if (artifact.retention) parts.push(`retention: ${artifact.retention}`);
    lines.push(`- ${parts.join(", ")}`);
    if (artifact.dependsOn && artifact.dependsOn.length > 0) {
      lines.push(`  - Depends on: ${artifact.dependsOn.join(", ")}`);
    }
  }
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Gate script generation
// ---------------------------------------------------------------------------

/**
 * Generate gate scripts at `scripts/gate-{id}.sh`.
 *
 * For each non-advisory gate with a `run:` field, a wrapper script is created
 * that executes the gate command and handles failure according to `on-fail`.
 */
function generateGateScripts(ast: TopologyAST): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  for (const node of ast.nodes) {
    if (node.type !== "gate") continue;
    const gate = node as GateNode;
    if (!gate.run) continue;
    if (gate.behavior === "advisory") continue;

    const isHalt = gate.onFail === "halt";

    const scriptLines = [
      "#!/usr/bin/env bash",
      `# Gate: ${gate.id}`,
      `# Auto-generated by agentopology scaffold — edit as needed.`,
      "set -euo pipefail",
      "",
      "# Gate runs after: " + (gate.after || "any"),
      "# Gate runs before: " + (gate.before || "any"),
      `# On failure: ${gate.onFail || "halt"}`,
      "",
      "# Run the gate check",
      "GATE_RESULT=0",
      `${gate.run} || GATE_RESULT=$?`,
      "",
      'if [ "$GATE_RESULT" -ne 0 ]; then',
      `  echo "Gate '${gate.id}' FAILED (exit code $GATE_RESULT)"`,
    ];

    if (isHalt) {
      scriptLines.push("  exit 1");
    } else {
      scriptLines.push(`  echo "Gate failed — bounce-back requested"`);
      scriptLines.push("  exit 0  # allow continuation for bounce-back");
    }

    scriptLines.push("fi");
    scriptLines.push("");
    scriptLines.push(`echo "Gate '${gate.id}' PASSED"`);
    scriptLines.push("");

    const content = scriptLines.join("\n");

    files.push({
      path: `scripts/gate-${gate.id}.sh`,
      content,
      category: "script",
    });
  }

  return files;
}

// ---------------------------------------------------------------------------
// Settings, MCP, Skills, Hooks, AGENTS.md — Copilot CLI terminal features
// ---------------------------------------------------------------------------

/**
 * Generate `.github/copilot/settings.json` with MCP servers and permissions.
 */
function generateSettings(ast: TopologyAST): GeneratedFile {
  const settings: Record<string, unknown> = {
    trusted_folders: ["."],
  };

  // URL allow/deny from settings block
  const allow = ast.settings?.allow as string[] | undefined;
  const deny = ast.settings?.deny as string[] | undefined;
  const allowedUrls = (allow ?? []).filter((t) => t.startsWith("http"));
  const deniedUrls = (deny ?? []).filter((t) => t.startsWith("http"));
  if (allowedUrls.length > 0) settings.allowed_urls = allowedUrls;
  if (deniedUrls.length > 0) settings.denied_urls = deniedUrls;

  // MCP servers
  if (Object.keys(ast.mcpServers).length > 0) {
    const mcpServers: Record<string, unknown> = {};
    for (const [name, config] of Object.entries(ast.mcpServers)) {
      const entry: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(config)) {
        entry[key] = value;
      }
      // Copilot CLI uses "local" for stdio servers
      if (entry.command && (!entry.type || entry.type === "stdio")) {
        entry.type = "local";
      }
      if (!entry.env && entry.command) {
        entry.env = {};
      }
      mcpServers[name] = entry;
    }
    settings.mcpServers = mcpServers;
  }

  return {
    path: ".github/copilot/settings.json",
    content: JSON.stringify(settings, null, 2) + "\n",
    category: "machine",
  };
}

/**
 * Generate `.github/skills/{name}/SKILL.md` files.
 */
function generateSkills(ast: TopologyAST): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  for (const skill of ast.skills) {
    const lines: string[] = [];
    lines.push("---");
    lines.push(`name: ${skill.id}`);
    lines.push(`description: ${skill.description}`);
    lines.push("---");
    lines.push("");

    if (skill.prompt) {
      lines.push(skill.prompt);
    } else {
      const bodyParts: string[] = [];
      if (skill.scripts && skill.scripts.length > 0) {
        bodyParts.push(`Scripts: ${skill.scripts.join(", ")}`);
      }
      if (skill.domains && skill.domains.length > 0) {
        bodyParts.push(`Domains: ${skill.domains.join(", ")}`);
      }
      if (skill.references && skill.references.length > 0) {
        bodyParts.push(`References: ${skill.references.join(", ")}`);
      }
      lines.push(bodyParts.length > 0 ? bodyParts.join("\n") : skill.description);
    }
    lines.push("");

    files.push({
      path: `.github/skills/${skill.id}/SKILL.md`,
      content: lines.join("\n"),
      category: "agent",
    });
  }

  return files;
}

/** Map hook event names to Copilot CLI hook events. */
function mapCopilotHookEvent(event: string): string {
  switch (event) {
    case "PreToolUse":
      return "preToolUse";
    case "PostToolUse":
    case "ToolUse":
      return "postToolUse";
    default:
      return "preToolUse";
  }
}

/**
 * Generate `.github/hooks/{name}.json` files for preToolUse/postToolUse hooks.
 */
function generateHookFiles(ast: TopologyAST): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  // Collect all hooks from topology-level and per-agent
  const allHooks: HookDef[] = [...ast.hooks];
  for (const node of ast.nodes) {
    if (node.type === "agent") {
      const agent = node as AgentNode;
      if (agent.hooks) allHooks.push(...agent.hooks);
    }
  }

  // Only generate hook files for tool-use events
  const toolHooks = allHooks.filter(
    (h) => h.on === "PreToolUse" || h.on === "PostToolUse" || h.on === "ToolUse"
  );

  for (const hook of toolHooks) {
    if (!hook.run) continue;
    const hookObj: Record<string, unknown> = {
      event: mapCopilotHookEvent(hook.on),
    };
    if (hook.matcher) hookObj.matcher = hook.matcher;

    // Inline commands vs file paths
    const isInline = /^(exit|true|false|echo)\b/.test(hook.run);
    hookObj.command = isInline ? hook.run : `./${hook.run}`;

    if (hook.timeout != null) hookObj.timeout = hook.timeout;

    files.push({
      path: `.github/hooks/${hook.name}.json`,
      content: JSON.stringify(hookObj, null, 2) + "\n",
      category: "machine",
    });
  }

  // Gate hooks — compile gates as postToolUse hooks
  const gates = ast.nodes.filter((n) => n.type === "gate") as GateNode[];
  for (const gate of gates) {
    if (!gate.run) continue;
    const hookObj: Record<string, unknown> = {
      event: "postToolUse",
      command: `./scripts/gate-${gate.id}.sh`,
    };
    files.push({
      path: `.github/hooks/gate-${gate.id}.json`,
      content: JSON.stringify(hookObj, null, 2) + "\n",
      category: "machine",
    });
  }

  return files;
}

/**
 * Generate `AGENTS.md` at project root — topology overview.
 */
function generateAgentsMd(ast: TopologyAST): GeneratedFile {
  const sections: string[] = [];

  sections.push(`# ${toTitle(ast.topology.name)}`);
  sections.push("");
  if (ast.topology.description) {
    sections.push(ast.topology.description);
    sections.push("");
  }

  // Agents
  const agents = ast.nodes.filter((n) => n.type === "agent") as AgentNode[];
  if (agents.length > 0) {
    sections.push("## Agents");
    sections.push("");
    for (const agent of agents) {
      const desc = agent.description ?? agent.role ?? toTitle(agent.id);
      const model = agent.model ? ` (${agent.model})` : "";
      sections.push(`- **${toTitle(agent.id)}**${model}: ${desc}`);
    }
    sections.push("");
  }

  // Flow
  if (ast.edges.length > 0) {
    sections.push("## Flow");
    sections.push("");
    for (const edge of ast.edges) {
      let line = `${edge.from} → ${edge.to}`;
      if (edge.condition) line += ` [when ${edge.condition}]`;
      if (edge.maxIterations) line += ` [max ${edge.maxIterations}]`;
      if (edge.isError) line = `${edge.from} ⚠→ ${edge.to}`;
      sections.push(`- ${line}`);
    }
    sections.push("");
  }

  // Gates
  const gates = ast.nodes.filter((n) => n.type === "gate") as GateNode[];
  if (gates.length > 0) {
    sections.push("## Gates");
    sections.push("");
    for (const gate of gates) {
      const checks = gate.checks?.join(", ") ?? "";
      sections.push(`- **${toTitle(gate.id)}**: ${checks} (on fail: ${gate.onFail ?? "halt"})`);
    }
    sections.push("");
  }

  // Human checkpoints
  const humans = ast.nodes.filter((n) => n.type === "human") as HumanNode[];
  if (humans.length > 0) {
    sections.push("## Human Checkpoints");
    sections.push("");
    for (const human of humans) {
      sections.push(`- **${toTitle(human.id)}**: ${human.description ?? "Human approval required"}`);
    }
    sections.push("");
  }

  return {
    path: "AGENTS.md",
    content: sections.join("\n") + "\n",
    category: "agent",
  };
}

// ---------------------------------------------------------------------------
// Binding export
// ---------------------------------------------------------------------------

/** GitHub Copilot CLI binding. */
export const copilotCliBinding: BindingTarget = {
  name: "copilot-cli",
  description:
    "GitHub Copilot CLI — generates .github/copilot-instructions.md, .github/instructions/*.instructions.md, .github/agents/*.agent.md, settings.json, skills, hooks, and AGENTS.md.",

  scaffold(ast: TopologyAST): GeneratedFile[] {
    const files: GeneratedFile[] = [];

    // 1. Project-level instructions file
    const instructions = generateInstructions(ast);

    // Append supplementary sections to instructions
    const supplementary: string[] = [];
    const gateInstructions = generateGateInstructions(ast);
    if (gateInstructions) supplementary.push(gateInstructions);
    const hookInstructions = generateHookInstructions(ast);
    if (hookInstructions) supplementary.push(hookInstructions);
    const memoryInstructions = generateMemoryInstructions(ast);
    if (memoryInstructions) supplementary.push(memoryInstructions);
    const meteringInstructions = generateMeteringInstructions(ast);
    if (meteringInstructions) supplementary.push(meteringInstructions);
    const defaultsInstr = generateDefaultsInstructions(ast);
    if (defaultsInstr) supplementary.push(defaultsInstr);
    const observabilityInstr = generateObservabilityInstructions(ast);
    if (observabilityInstr) supplementary.push(observabilityInstr);
    const checkpointInstr = generateCheckpointInstructions(ast);
    if (checkpointInstr) supplementary.push(checkpointInstr);
    const artifactsInstr = generateArtifactsInstructions(ast);
    if (artifactsInstr) supplementary.push(artifactsInstr);
    const depthInstr = generateDepthInstructions(ast);
    if (depthInstr) supplementary.push(depthInstr);
    const paramsInstr = generateParamsInstructions(ast);
    if (paramsInstr) supplementary.push(paramsInstr);
    const ifaceEndpointsInstr = generateInterfaceEndpointsInstructions(ast);
    if (ifaceEndpointsInstr) supplementary.push(ifaceEndpointsInstr);
    const importsInstr = generateImportsInstructions(ast);
    if (importsInstr) supplementary.push(importsInstr);
    const includesInstr = generateIncludesInstructions(ast);
    if (includesInstr) supplementary.push(includesInstr);
    const envInstr = generateEnvInstructions(ast);
    if (envInstr) supplementary.push(envInstr);

    if (supplementary.length > 0) {
      instructions.content += supplementary.join("\n");
    }

    files.push(instructions);

    // 2. Per-agent .instructions.md files (scoped behavioral rules)
    files.push(...generateAgents(ast));

    // 3. Per-agent .agent.md files (agent definitions with tools)
    files.push(...generateAgentMdFiles(ast));

    // 4. Human node .instructions.md files (informational only)
    files.push(...generateHumanAgents(ast));

    // 5. Group node .instructions.md files (informational only)
    files.push(...generateGroupAgents(ast));

    // 6. Settings file (MCP, permissions)
    files.push(generateSettings(ast));

    // 7. Skills (.github/skills/{name}/SKILL.md)
    files.push(...generateSkills(ast));

    // 8. Hook files (.github/hooks/{name}.json)
    files.push(...generateHookFiles(ast));

    // 9. AGENTS.md at project root
    files.push(generateAgentsMd(ast));

    // 10. Setup steps workflow (server-side Copilot Coding Agent only)
    const setupSteps = generateSetupSteps(ast);
    if (setupSteps) files.push(setupSteps);

    // 11. Gate scripts
    files.push(...generateGateScripts(ast));

    return deduplicateFiles(files);
  },
};
