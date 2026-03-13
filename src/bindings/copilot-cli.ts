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
  HookDef,
  EdgeDef,
} from "../parser/ast.js";
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
      let line = `${edge.from} -> ${edge.to}`;
      if (edge.condition) line += ` [when ${edge.condition}]`;
      if (edge.maxIterations) line += ` [max ${edge.maxIterations}]`;
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

    // Fallback chain
    if (agent.fallbackChain && agent.fallbackChain.length > 0) {
      sections.push("## Fallback Chain");
      sections.push(`Models: ${agent.fallbackChain.join(" -> ")}`);
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
 * Generate `.github/workflows/copilot-topology.yml` when the topology
 * has flow edges, enabling Copilot Coding Agent to run as a GitHub Action.
 */
function generateWorkflow(ast: TopologyAST): GeneratedFile | null {
  if (ast.edges.length === 0) return null;

  const name = ast.topology.name;
  const agents = ast.nodes.filter((n) => n.type === "agent") as AgentNode[];

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

    if (supplementary.length > 0) {
      instructions.content += supplementary.join("\n");
    }

    files.push(instructions);

    // 2. Per-agent .agent.md files
    files.push(...generateAgents(ast));

    // 3. Workflow file (only when flow edges exist)
    const workflow = generateWorkflow(ast);
    if (workflow) files.push(workflow);

    return files;
  },
};
