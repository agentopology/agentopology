/**
 * GitHub Copilot CLI binding.
 *
 * Generates the `.github/` directory structure for GitHub Copilot Coding Agent:
 * - `.github/copilot-instructions.md` — project-level instructions
 * - `.github/agents/{id}.agent.md` — per-agent definitions with YAML frontmatter
 * - `.github/workflows/copilot-topology.yml` — workflow file for flow-based topologies
 *
 * @module
 */

import type {
  TopologyAST,
  AgentNode,
  GateNode,
  HumanNode,
  GroupNode,
  HookDef,
  EdgeDef,
  SchemaFieldDef,
  RetryConfig,
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
 * Build YAML frontmatter block for a `.agent.md` file.
 *
 * Supports scalar values, arrays (rendered as YAML lists), and booleans.
 */
function frontmatter(fields: Record<string, string | boolean | string[]>): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      lines.push(`${key}:`);
      for (const item of value) {
        lines.push(`  - ${item}`);
      }
    } else if (typeof value === "boolean") {
      lines.push(`${key}: ${value}`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tool mapping
// ---------------------------------------------------------------------------

/**
 * Map topology-level tool names to Copilot Coding Agent tool names.
 *
 * Copilot tools: read_file, edit_file, run_command, web_search, create_pull_request
 */
const TOOL_MAP: Record<string, string> = {
  // Claude Code tools -> Copilot tools
  Read: "read_file",
  Write: "edit_file",
  Edit: "edit_file",
  Bash: "run_command",
  WebSearch: "web_search",
  WebFetch: "web_search",
  Grep: "run_command",
  Glob: "run_command",
  // Pass through Copilot-native names
  read_file: "read_file",
  edit_file: "edit_file",
  run_command: "run_command",
  web_search: "web_search",
  create_pull_request: "create_pull_request",
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

/** Parse a duration string like "5m", "2h", "30s" to minutes (for workflow timeout-minutes). */
function durationToMinutes(duration: string): number | null {
  const match = duration.match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/);
  if (!match) return null;
  const value = parseFloat(match[1]);
  switch (match[2]) {
    case "s": return Math.max(1, Math.ceil(value / 60));
    case "m": return Math.ceil(value);
    case "h": return Math.ceil(value * 60);
    case "d": return Math.ceil(value * 1440);
    default: return null;
  }
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
  };
}

/**
 * Generate `.github/agents/{id}.agent.md` for each agent node.
 *
 * Each file has YAML frontmatter with name, description, tools, and optional
 * model override. The markdown body contains role, reads/writes, outputs,
 * skills, and behavior information.
 */
function generateAgents(ast: TopologyAST): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  for (const node of ast.nodes) {
    if (node.type !== "agent") continue;
    const agent = node as AgentNode;

    // --- Build frontmatter ---
    const fm: Record<string, string | boolean | string[]> = {};
    fm.name = agent.id;

    // Description
    const desc =
      agent.description ??
      ast.roles[agent.role ?? ""] ??
      ast.roles[agent.id] ??
      agent.role;
    if (desc) {
      fm.description = `"${desc}"`;
    }

    // Tools: map topology tools to Copilot tools
    if (agent.tools && agent.tools.length > 0) {
      fm.tools = mapTools(agent.tools);
    } else {
      // Default Copilot tools when none specified
      fm.tools = ["read_file", "edit_file", "run_command"];
    }

    // Model override
    if (agent.model) fm.model = agent.model;

    // Sandbox mode
    if (agent.sandbox != null) {
      fm.sandbox = typeof agent.sandbox === "boolean" ? agent.sandbox : agent.sandbox;
    }

    // Merge copilot-cli extension fields into frontmatter
    if (agent.extensions?.["copilot-cli"]) {
      for (const [k, v] of Object.entries(agent.extensions["copilot-cli"])) {
        if (typeof v === "string") fm[k] = v;
        else if (typeof v === "boolean") fm[k] = v;
        else if (Array.isArray(v)) fm[k] = v as string[];
      }
    }

    // --- Build body ---
    const sections: string[] = [frontmatter(fm), ""];
    sections.push(`You are the ${toTitle(agent.id)} agent.`);
    sections.push("");

    // Role section
    const roleText =
      ast.roles[agent.role ?? ""] ?? ast.roles[agent.id] ?? agent.role;
    if (roleText) {
      sections.push("## Role");
      sections.push(roleText);
      sections.push("");
    }

    // Phase info
    if (agent.phase != null) {
      sections.push(`Phase: ${agent.phase}`);
      sections.push("");
    }

    if (agent.prompt) {
      sections.push("## Instructions");
      sections.push("");
      sections.push(agent.prompt);
      sections.push("");
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

    // Fallback chain
    if (agent.fallbackChain && agent.fallbackChain.length > 0) {
      sections.push("## Fallback Chain");
      sections.push(`Models: ${agent.fallbackChain.join(" -> ")}`);
      sections.push("");
    }

    // --- Wave 1-7 fields ---

    // Timeout
    if (agent.timeout) {
      sections.push(`Maximum execution time: ${agent.timeout}`);
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
      path: `.github/agents/${agent.id}.agent.md`,
      content: sections.join("\n") + "\n",
    });
  }

  return files;
}

/**
 * Generate `.github/agents/{id}.agent.md` for each human node.
 *
 * Human nodes represent approval/input points. The agent.md instructs
 * Copilot to pause and request human intervention.
 */
function generateHumanAgents(ast: TopologyAST): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  for (const node of ast.nodes) {
    if (node.type !== "human") continue;
    const human = node as HumanNode;

    const fm: Record<string, string | boolean | string[]> = {};
    fm.name = human.id;
    fm.description = `"Human approval point: ${human.description ?? toTitle(human.id)}"`;

    const sections: string[] = [frontmatter(fm), ""];
    sections.push(`You are the ${toTitle(human.id)} approval agent.`);
    sections.push("");
    sections.push("## Role");
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
      path: `.github/agents/${human.id}.agent.md`,
      content: sections.join("\n") + "\n",
    });
  }

  return files;
}

/**
 * Generate `.github/agents/{id}.agent.md` for each group node.
 *
 * Group nodes represent multi-agent conversation/debate coordination points.
 */
function generateGroupAgents(ast: TopologyAST): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  for (const node of ast.nodes) {
    if (node.type !== "group") continue;
    const group = node as GroupNode;

    const fm: Record<string, string | boolean | string[]> = {};
    fm.name = group.id;
    fm.description = `"Group chat coordinator: ${group.description ?? toTitle(group.id)}"`;

    const sections: string[] = [frontmatter(fm), ""];
    sections.push(`You are the ${toTitle(group.id)} group chat coordinator.`);
    sections.push("");
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
      path: `.github/agents/${group.id}.agent.md`,
      content: sections.join("\n") + "\n",
    });
  }

  return files;
}

/**
 * Generate `.github/workflows/copilot-topology.yml` when the topology
 * has flow edges, enabling Copilot Coding Agent to run as a GitHub Action.
 *
 * Non-advisory gates with `run:` are compiled to workflow steps that execute
 * the gate script between the `after` and `before` agent steps.  If a gate
 * has `on-fail: halt`, the workflow naturally stops on a non-zero exit code.
 *
 * Agents with `disallowedTools` get `--deny-tool` flags appended to the
 * copilot invocation step.
 */
function generateWorkflow(ast: TopologyAST): GeneratedFile | null {
  if (ast.edges.length === 0) return null;

  const name = ast.topology.name;
  const agents = ast.nodes.filter((n) => n.type === "agent") as AgentNode[];
  const gates = ast.nodes.filter((n) => n.type === "gate") as GateNode[];

  // Index gates by `after` agent id for insertion after that agent's step
  const gatesAfter = new Map<string, GateNode[]>();
  for (const gate of gates) {
    if (!gate.run || gate.behavior === "advisory") continue;
    const key = gate.after ?? "__none__";
    if (!gatesAfter.has(key)) gatesAfter.set(key, []);
    gatesAfter.get(key)!.push(gate);
  }

  // Build a simple sequential workflow based on flow edges
  const lines: string[] = [];
  lines.push(`# Auto-generated by agentopology scaffold for topology: ${name}`);
  lines.push(`# This workflow orchestrates the Copilot Coding Agent topology.`);
  lines.push("");
  lines.push(`name: "Copilot Topology: ${toTitle(name)}"`);
  lines.push("");
  lines.push("on:");
  lines.push("  workflow_dispatch:");
  lines.push("    inputs:");
  lines.push("      task:");
  lines.push('        description: "Task description for the topology"');
  lines.push("        required: true");
  lines.push('        type: string');

  // Add trigger patterns if they exist
  if (ast.triggers.length > 0) {
    lines.push("  issue_comment:");
    lines.push("    types: [created]");
  }

  // Add schedule triggers from topology schedules
  const cronJobs = ast.schedules.filter((s) => s.cron && s.enabled !== false);
  if (cronJobs.length > 0) {
    lines.push("  schedule:");
    for (const job of cronJobs) {
      lines.push(`    - cron: '${job.cron}'  # ${job.id}`);
    }
  }

  lines.push("");
  lines.push("permissions:");
  lines.push("  contents: write");
  lines.push("  pull-requests: write");
  lines.push("  issues: write");
  lines.push("");
  lines.push("jobs:");

  // Generate one job per agent, respecting edge ordering
  const emitted = new Set<string>();
  const edgesByTo = new Map<string, EdgeDef[]>();
  for (const edge of ast.edges) {
    if (!edgesByTo.has(edge.to)) edgesByTo.set(edge.to, []);
    edgesByTo.get(edge.to)!.push(edge);
  }

  for (const agent of agents) {
    const jobId = agent.id.replace(/[^a-zA-Z0-9_-]/g, "-");
    lines.push("");
    lines.push(`  ${jobId}:`);
    lines.push(`    name: "${toTitle(agent.id)}"`);
    lines.push("    runs-on: ubuntu-latest");

    // Add needs (dependencies from flow edges)
    const deps = edgesByTo.get(agent.id);
    if (deps && deps.length > 0) {
      const needs = deps
        .map((d) => d.from.replace(/[^a-zA-Z0-9_-]/g, "-"))
        .filter((d) => emitted.has(d));
      if (needs.length > 0) {
        lines.push(`    needs: [${needs.join(", ")}]`);
      }
    }

    // Add condition from edge if present
    const edgesTo = edgesByTo.get(agent.id);
    if (edgesTo) {
      for (const edge of edgesTo) {
        if (edge.condition) {
          lines.push(`    # Condition: ${edge.condition}`);
        }
        if (edge.isError) {
          lines.push(`    # Error edge from ${edge.from}${edge.errorType ? ` (type: ${edge.errorType})` : ""}`);
        }
        if (edge.race) {
          lines.push(`    # Race: first completed result wins`);
        }
        if (edge.tolerance != null) {
          lines.push(`    # Tolerance: ${edge.tolerance} failures allowed`);
        }
        if (edge.wait) {
          lines.push(`    # Wait: ${edge.wait} before proceeding`);
        }
      }
    }

    // Timeout for the job
    if (agent.timeout) {
      const minutes = durationToMinutes(agent.timeout);
      if (minutes != null) {
        lines.push(`    timeout-minutes: ${minutes}`);
      }
    }

    lines.push("    steps:");
    lines.push("      - uses: actions/checkout@v4");
    lines.push("");
    lines.push(`      - name: Run ${toTitle(agent.id)} agent`);
    lines.push("        uses: github/copilot-coding-agent@v1");
    lines.push("        with:");
    lines.push(`          agent: ${agent.id}`);

    if (agent.model) {
      lines.push(`          model: ${agent.model}`);
    }

    // Append --deny-tool flags for disallowed tools
    if (agent.disallowedTools && agent.disallowedTools.length > 0) {
      const denyFlags = agent.disallowedTools
        .map((t) => `--deny-tool ${mapTool(t)}`)
        .join(" ");
      lines.push(`          args: "${denyFlags}"`);
    }

    // Insert gate steps after this agent's step
    const agentGates = gatesAfter.get(agent.id);
    if (agentGates) {
      for (const gate of agentGates) {
        lines.push("");
        lines.push(`      - name: "Gate: ${gate.id}"`);
        lines.push(`        run: bash scripts/gate-${gate.id}.sh`);
      }
    }

    // Error handling step for agents with on-fail
    if (agent.onFail && agent.onFail !== "halt") {
      lines.push("");
      lines.push(`      - name: "Error handler: ${agent.id}"`);
      lines.push("        if: failure()");
      lines.push(`        run: echo "Agent ${agent.id} failed — on-fail strategy: ${agent.onFail}"`);
    }

    emitted.add(jobId);
  }

  lines.push("");

  return {
    path: ".github/workflows/copilot-topology.yml",
    content: lines.join("\n") + "\n",
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

    const onFailExit =
      gate.onFail === "halt"
        ? 'exit 1'
        : 'echo "Gate failed — bounce-back requested (advisory)"';

    const content = [
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
      `  ${onFailExit}`,
      "fi",
      "",
      `echo "Gate '${gate.id}' PASSED"`,
      "",
    ].join("\n");

    files.push({
      path: `scripts/gate-${gate.id}.sh`,
      content,
    });
  }

  return files;
}

// ---------------------------------------------------------------------------
// Binding export
// ---------------------------------------------------------------------------

/** GitHub Copilot CLI binding. */
export const copilotCliBinding: BindingTarget = {
  name: "copilot-cli",
  description:
    "GitHub Copilot Coding Agent — generates .github/copilot-instructions.md, .github/agents/*.agent.md, and workflow files.",

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

    if (supplementary.length > 0) {
      instructions.content += supplementary.join("\n");
    }

    files.push(instructions);

    // 2. Per-agent .agent.md files
    files.push(...generateAgents(ast));

    // 3. Human node agent.md files
    files.push(...generateHumanAgents(ast));

    // 4. Group node agent.md files
    files.push(...generateGroupAgents(ast));

    // 5. Workflow file (only when flow edges exist)
    const workflow = generateWorkflow(ast);
    if (workflow) files.push(workflow);

    // 6. Gate scripts
    files.push(...generateGateScripts(ast));

    return deduplicateFiles(files);
  },
};
