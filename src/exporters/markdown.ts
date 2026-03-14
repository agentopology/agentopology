/**
 * Markdown exporter — converts a TopologyAST into a beautiful, shareable
 * Markdown document suitable for stakeholders, documentation, and onboarding.
 *
 * @module
 */

import type { TopologyAST, NodeDef, EdgeDef, AgentNode, GateNode, ActionNode, OrchestratorNode, HumanNode, GroupNode } from "../parser/ast.js";
import type { GeneratedFile } from "../bindings/types.js";
import type { Exporter } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toTitle(s: string): string {
  return s
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function edgeLabel(edge: EdgeDef): string {
  const parts: string[] = [];
  if (edge.isError) {
    parts.push(edge.errorType ? `error(${edge.errorType})` : "error");
  }
  if (edge.condition) parts.push(`when ${edge.condition}`);
  if (edge.maxIterations) parts.push(`max ${edge.maxIterations}`);
  if (edge.race) parts.push("race");
  if (edge.tolerance != null) parts.push(`tolerance: ${edge.tolerance}`);
  if (edge.wait) parts.push(`wait ${edge.wait}`);
  if (edge.weight != null) parts.push(`weight ${edge.weight}`);
  if (edge.reflection) parts.push("reflection");
  return parts.length > 0 ? parts.join(", ") : "";
}

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

function renderHeader(ast: TopologyAST): string {
  const t = ast.topology;
  const lines: string[] = [];

  // Title block
  lines.push(`<div align="center">`);
  lines.push("");
  lines.push(`# ${toTitle(t.name)}`);
  lines.push("");
  if (t.description) {
    lines.push(`*${t.description}*`);
    lines.push("");
  }
  // Badges row
  const badges: string[] = [];
  badges.push(`![version](https://img.shields.io/badge/version-${t.version}-blue)`);
  for (const p of t.patterns) {
    badges.push(`![${p}](https://img.shields.io/badge/pattern-${encodeURIComponent(p)}-purple)`);
  }
  if (t.domain) {
    badges.push(`![${t.domain}](https://img.shields.io/badge/domain-${encodeURIComponent(t.domain)}-green)`);
  }
  lines.push(badges.join(" "));
  lines.push("");
  lines.push(`</div>`);
  lines.push("");

  // Extra metadata as a clean list if present
  const extra: string[] = [];
  if (t.foundations && t.foundations.length > 0) {
    extra.push(`**Foundations:** ${t.foundations.map((f) => `\`${f}\``).join(", ")}`);
  }
  if (t.advanced && t.advanced.length > 0) {
    extra.push(`**Advanced:** ${t.advanced.map((a) => `\`${a}\``).join(", ")}`);
  }
  if (t.timeout) extra.push(`**Timeout:** ${t.timeout}`);
  if (t.durable) extra.push(`**Durable:** Yes`);
  if (t.errorHandler) extra.push(`**Error Handler:** \`${t.errorHandler}\``);
  if (extra.length > 0) {
    for (const e of extra) lines.push(`> ${e}`);
    lines.push("");
  }

  return lines.join("\n");
}

function renderOverview(ast: TopologyAST): string {
  const agents = ast.nodes.filter((n) => n.type === "agent");
  const actions = ast.nodes.filter((n) => n.type === "action");
  const gates = ast.nodes.filter((n) => n.type === "gate");
  const orchestrators = ast.nodes.filter((n) => n.type === "orchestrator");
  const humans = ast.nodes.filter((n) => n.type === "human");
  const groups = ast.nodes.filter((n) => n.type === "group");

  const lines: string[] = [];
  lines.push("## At a Glance");
  lines.push("");

  const items: string[] = [];
  if (orchestrators.length) items.push(`**${orchestrators.length}** Orchestrator${orchestrators.length > 1 ? "s" : ""}`);
  if (agents.length) items.push(`**${agents.length}** Agent${agents.length > 1 ? "s" : ""}`);
  if (actions.length) items.push(`**${actions.length}** Action${actions.length > 1 ? "s" : ""}`);
  if (gates.length) items.push(`**${gates.length}** Gate${gates.length > 1 ? "s" : ""}`);
  if (humans.length) items.push(`**${humans.length}** Human Node${humans.length > 1 ? "s" : ""}`);
  if (groups.length) items.push(`**${groups.length}** Group${groups.length > 1 ? "s" : ""}`);
  items.push(`**${ast.edges.length}** Edge${ast.edges.length !== 1 ? "s" : ""}`);

  lines.push(`> ${items.join(" &nbsp;&bull;&nbsp; ")}`);
  lines.push("");
  return lines.join("\n");
}

function renderRoles(ast: TopologyAST): string {
  const entries = Object.entries(ast.roles);
  if (entries.length === 0) return "";

  const lines: string[] = [];
  lines.push("## Roles");
  lines.push("");
  for (const [name, desc] of entries) {
    lines.push(`- **${toTitle(name)}** — ${desc}`);
  }
  lines.push("");
  return lines.join("\n");
}

function renderOrchestrator(node: OrchestratorNode): string {
  const lines: string[] = [];
  lines.push(`### Orchestrator`);
  lines.push("");

  const details: string[] = [];
  details.push(`Model: \`${node.model}\``);
  if (node.generates) details.push(`Generates: \`${node.generates}\``);
  if (node.handles.length) details.push(`Handles: ${node.handles.map((h) => `\`${h}\``).join(", ")}`);

  lines.push(`> ${details.join(" &nbsp;&middot;&nbsp; ")}`);
  lines.push("");

  if (node.outputs) {
    lines.push("**Outputs:**");
    lines.push("");
    for (const [key, values] of Object.entries(node.outputs)) {
      lines.push(`- \`${key}\` — ${values.map((v) => `\`${v}\``).join(" / ")}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function renderAgent(node: AgentNode, roles: Record<string, string>): string {
  const lines: string[] = [];

  // Agent heading with model badge inline
  const modelBadge = node.model ? ` \`${node.model}\`` : "";
  lines.push(`#### ${toTitle(node.id)}${modelBadge}`);
  lines.push("");

  // Role description as italic subtitle
  if (node.role && roles[node.role]) {
    lines.push(`*${roles[node.role]}*`);
    lines.push("");
  }

  // Compact key-value line
  const kvParts: string[] = [];
  if (node.phase != null) kvParts.push(`Phase **${node.phase}**`);
  if (node.permissions) kvParts.push(`Permissions: \`${node.permissions}\``);
  if (node.behavior) kvParts.push(`Behavior: \`${node.behavior}\``);
  if (node.isolation) kvParts.push(`Isolation: \`${node.isolation}\``);
  if (node.background) kvParts.push(`Background`);
  if (node.sandbox != null) kvParts.push(`Sandbox: \`${String(node.sandbox)}\``);
  if (node.maxTurns != null) kvParts.push(`Max turns: ${node.maxTurns}`);
  if (node.timeout) kvParts.push(`Timeout: ${node.timeout}`);
  if (node.temperature != null) kvParts.push(`Temperature: ${node.temperature}`);
  if (node.thinking) kvParts.push(`Thinking: \`${node.thinking}\``);
  if (node.rateLimit) kvParts.push(`Rate limit: ${node.rateLimit}`);
  if (node.onFail) kvParts.push(`On fail: \`${node.onFail}\``);
  if (node.compensates) kvParts.push(`Compensates: \`${node.compensates}\``);
  if (node.invocation) kvParts.push(`Invocation: \`${node.invocation}\``);

  if (kvParts.length) {
    lines.push(kvParts.join(" &nbsp;&middot;&nbsp; "));
    lines.push("");
  }

  // Tools & access in a compact block
  const accessLines: string[] = [];
  if (node.tools && node.tools.length) {
    accessLines.push(`**Tools:** ${node.tools.map((t) => `\`${t}\``).join(", ")}`);
  }
  if (node.disallowedTools && node.disallowedTools.length) {
    accessLines.push(`**Denied:** ${node.disallowedTools.map((t) => `~~\`${t}\`~~`).join(", ")}`);
  }
  if (node.reads && node.reads.length) {
    accessLines.push(`**Reads:** ${node.reads.map((r) => `\`${r}\``).join(", ")}`);
  }
  if (node.writes && node.writes.length) {
    accessLines.push(`**Writes:** ${node.writes.map((w) => `\`${w}\``).join(", ")}`);
  }
  if (node.skills && node.skills.length) {
    accessLines.push(`**Skills:** ${node.skills.map((s) => `\`${s}\``).join(", ")}`);
  }
  if (node.mcpServers && node.mcpServers.length) {
    accessLines.push(`**MCP Servers:** ${node.mcpServers.map((s) => `\`${s}\``).join(", ")}`);
  }
  if (accessLines.length) {
    for (const l of accessLines) lines.push(l + "  ");
    lines.push("");
  }

  // Fallback chain
  if (node.fallbackChain && node.fallbackChain.length) {
    lines.push(`**Fallback:** ${node.fallbackChain.map((m) => `\`${m}\``).join(" → ")}`);
    lines.push("");
  }

  // Outputs
  if (node.outputs) {
    lines.push("**Outputs:**");
    for (const [key, values] of Object.entries(node.outputs)) {
      lines.push(`- \`${key}\` — ${values.map((v) => `\`${v}\``).join(" / ")}`);
    }
    lines.push("");
  }

  // Scale
  if (node.scale) {
    lines.push(`**Scale:** \`${node.scale.mode}\` by \`${node.scale.by}\` (${node.scale.min}–${node.scale.max}${node.scale.batchSize ? `, batch ${node.scale.batchSize}` : ""})`);
    lines.push("");
  }

  // Circuit breaker
  if (node.circuitBreaker) {
    lines.push(`**Circuit Breaker:** threshold=${node.circuitBreaker.threshold}, window=${node.circuitBreaker.window}, cooldown=${node.circuitBreaker.cooldown}`);
    lines.push("");
  }

  // Retry
  if (node.retry) {
    if (typeof node.retry === "number") {
      lines.push(`**Retry:** ${node.retry}x`);
    } else {
      const retryParts = [`max ${node.retry.max}`];
      if (node.retry.backoff) retryParts.push(node.retry.backoff);
      if (node.retry.interval) retryParts.push(node.retry.interval);
      lines.push(`**Retry:** ${retryParts.join(", ")}`);
    }
    lines.push("");
  }

  // Prompt
  if (node.prompt) {
    lines.push("<details>");
    lines.push("<summary>Prompt</summary>");
    lines.push("");
    lines.push("```");
    lines.push(node.prompt.trim());
    lines.push("```");
    lines.push("");
    lines.push("</details>");
    lines.push("");
  }

  return lines.join("\n");
}

function renderAction(node: ActionNode): string {
  const lines: string[] = [];
  const kindBadge = node.kind ? ` \`${node.kind}\`` : "";
  lines.push(`#### ${toTitle(node.id)}${kindBadge}`);
  lines.push("");
  if (node.description) {
    lines.push(node.description);
    lines.push("");
  }
  const extra: string[] = [];
  if (node.source) extra.push(`Source: \`${node.source}\``);
  if (node.timeout) extra.push(`Timeout: ${node.timeout}`);
  if (node.onFail) extra.push(`On fail: \`${node.onFail}\``);
  if (node.join) extra.push(`Join: \`${node.join}\``);
  if (extra.length) {
    lines.push(extra.join(" &nbsp;&middot;&nbsp; "));
    lines.push("");
  }
  if (node.commands && node.commands.length) {
    lines.push("```bash");
    lines.push(node.commands.join("\n"));
    lines.push("```");
    lines.push("");
  }
  return lines.join("\n");
}

function renderGate(node: GateNode): string {
  const lines: string[] = [];
  lines.push(`#### ${toTitle(node.id)}`);
  lines.push("");
  const parts: string[] = [];
  if (node.after) parts.push(`After: \`${node.after}\``);
  if (node.before) parts.push(`Before: \`${node.before}\``);
  if (node.run) parts.push(`Run: \`${node.run}\``);
  if (node.onFail) parts.push(`On fail: \`${node.onFail}\``);
  if (node.retry) parts.push(`Retry: ${node.retry}x`);
  if (node.timeout) parts.push(`Timeout: ${node.timeout}`);
  if (parts.length) {
    lines.push(parts.join(" &nbsp;&middot;&nbsp; "));
    lines.push("");
  }
  if (node.checks && node.checks.length) {
    lines.push(`Checks: ${node.checks.map((c) => `\`${c}\``).join(", ")}`);
    lines.push("");
  }
  return lines.join("\n");
}

function renderHuman(node: HumanNode): string {
  const lines: string[] = [];
  lines.push(`#### ${toTitle(node.id)}`);
  lines.push("");
  if (node.description) {
    lines.push(node.description);
    lines.push("");
  }
  const parts: string[] = [];
  if (node.timeout) parts.push(`Timeout: ${node.timeout}`);
  if (node.onTimeout) parts.push(`On timeout: \`${node.onTimeout}\``);
  if (parts.length) {
    lines.push(parts.join(" &nbsp;&middot;&nbsp; "));
    lines.push("");
  }
  return lines.join("\n");
}

function renderGroup(node: GroupNode): string {
  const lines: string[] = [];
  lines.push(`#### ${toTitle(node.id)}`);
  lines.push("");
  if (node.description) {
    lines.push(node.description);
    lines.push("");
  }
  if (node.members.length) {
    lines.push(`**Members:** ${node.members.map((m) => `\`${m}\``).join(", ")}`);
    lines.push("");
  }
  const parts: string[] = [];
  if (node.speakerSelection) parts.push(`Speaker: \`${node.speakerSelection}\``);
  if (node.maxRounds) parts.push(`Max rounds: ${node.maxRounds}`);
  if (node.termination) parts.push(`Termination: ${node.termination}`);
  if (node.timeout) parts.push(`Timeout: ${node.timeout}`);
  if (parts.length) {
    lines.push(parts.join(" &nbsp;&middot;&nbsp; "));
    lines.push("");
  }
  return lines.join("\n");
}

function renderNodes(ast: TopologyAST): string {
  const lines: string[] = [];

  // Orchestrators
  const orchestrators = ast.nodes.filter((n): n is OrchestratorNode => n.type === "orchestrator");
  if (orchestrators.length) {
    for (const n of orchestrators) lines.push(renderOrchestrator(n));
  }

  // Agents by phase
  const agents = ast.nodes.filter((n): n is AgentNode => n.type === "agent");
  if (agents.length) {
    lines.push("## Agents");
    lines.push("");
    const sorted = [...agents].sort((a, b) => (a.phase ?? 0) - (b.phase ?? 0));
    for (const n of sorted) lines.push(renderAgent(n, ast.roles));
  }

  // Actions
  const actions = ast.nodes.filter((n): n is ActionNode => n.type === "action");
  if (actions.length) {
    lines.push("## Actions");
    lines.push("");
    for (const n of actions) lines.push(renderAction(n));
  }

  // Gates
  const gates = ast.nodes.filter((n): n is GateNode => n.type === "gate");
  if (gates.length) {
    lines.push("## Gates");
    lines.push("");
    for (const n of gates) lines.push(renderGate(n));
  }

  // Humans
  const humans = ast.nodes.filter((n): n is HumanNode => n.type === "human");
  if (humans.length) {
    lines.push("## Human Nodes");
    lines.push("");
    for (const n of humans) lines.push(renderHuman(n));
  }

  // Groups
  const groups = ast.nodes.filter((n): n is GroupNode => n.type === "group");
  if (groups.length) {
    lines.push("## Groups");
    lines.push("");
    for (const n of groups) lines.push(renderGroup(n));
  }

  return lines.join("\n");
}

function renderFlow(ast: TopologyAST): string {
  if (ast.edges.length === 0) return "";

  const lines: string[] = [];
  lines.push("## Flow");
  lines.push("");
  lines.push("```");

  for (const edge of ast.edges) {
    const arrow = edge.isError ? " ─✗─> " : " ───> ";
    const label = edgeLabel(edge);
    const suffix = label ? `  [${label}]` : "";
    lines.push(`  ${edge.from}${arrow}${edge.to}${suffix}`);
  }

  lines.push("```");
  lines.push("");
  return lines.join("\n");
}

function renderMemory(ast: TopologyAST): string {
  const entries = Object.entries(ast.memory);
  if (entries.length === 0) return "";

  const lines: string[] = [];
  lines.push("## Memory");
  lines.push("");
  for (const [name, config] of entries) {
    lines.push(`**${toTitle(name)}**`);
    if (typeof config === "object" && config !== null) {
      const rec = config as Record<string, unknown>;
      for (const [k, v] of Object.entries(rec)) {
        if (Array.isArray(v)) {
          lines.push(`- ${k}: ${v.map((i) => `\`${i}\``).join(", ")}`);
        } else {
          lines.push(`- ${k}: \`${String(v)}\``);
        }
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

function renderTriggers(ast: TopologyAST): string {
  if (ast.triggers.length === 0) return "";

  const lines: string[] = [];
  lines.push("## Triggers");
  lines.push("");
  for (const t of ast.triggers) {
    lines.push(`- **\`${t.name}\`** — \`${t.pattern}\`${t.argument ? ` (argument: \`${t.argument}\`)` : ""}`);
  }
  lines.push("");
  return lines.join("\n");
}

function renderHooks(ast: TopologyAST): string {
  if (ast.hooks.length === 0) return "";

  const lines: string[] = [];
  lines.push("## Hooks");
  lines.push("");
  for (const h of ast.hooks) {
    const matcher = h.matcher ? ` matching \`${h.matcher}\`` : "";
    lines.push(`- **\`${h.name}\`** — on \`${h.on}\`${matcher} runs \`${h.run}\``);
  }
  lines.push("");
  return lines.join("\n");
}

function renderSchedules(ast: TopologyAST): string {
  if (ast.schedules.length === 0) return "";

  const lines: string[] = [];
  lines.push("## Schedules");
  lines.push("");
  for (const s of ast.schedules) {
    const schedule = s.cron ? `cron \`${s.cron}\`` : s.every ? `every \`${s.every}\`` : "";
    const target = s.agent ? `agent \`${s.agent}\`` : s.action ? `action \`${s.action}\`` : "";
    const enabled = s.enabled ? "" : " *(disabled)*";
    lines.push(`- **\`${s.id}\`** — ${schedule} → ${target}${enabled}`);
  }
  lines.push("");
  return lines.join("\n");
}

function renderSchemas(ast: TopologyAST): string {
  if (ast.schemas.length === 0) return "";

  const lines: string[] = [];
  lines.push("## Schemas");
  lines.push("");
  for (const schema of ast.schemas) {
    lines.push(`**${toTitle(schema.id)}**`);
    lines.push("");
    for (const field of schema.fields) {
      const typeStr = formatSchemaType(field.type);
      const opt = field.optional ? " *(optional)*" : "";
      lines.push(`- \`${field.name}\` — ${typeStr}${opt}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function formatSchemaType(t: import("../parser/ast.js").SchemaType): string {
  switch (t.kind) {
    case "primitive": return `\`${t.value}\``;
    case "array": return `\`${formatSchemaTypeRaw(t.itemType)}[]\``;
    case "enum": return t.values.map((v) => `\`${v}\``).join(" / ");
    case "ref": return `\`@${t.name}\``;
  }
}

function formatSchemaTypeRaw(t: import("../parser/ast.js").SchemaType): string {
  switch (t.kind) {
    case "primitive": return t.value;
    case "array": return `${formatSchemaTypeRaw(t.itemType)}[]`;
    case "enum": return t.values.join(" / ");
    case "ref": return `@${t.name}`;
  }
}

function renderSkills(ast: TopologyAST): string {
  if (ast.skills.length === 0) return "";

  const lines: string[] = [];
  lines.push("## Skills");
  lines.push("");
  for (const s of ast.skills) {
    lines.push(`- **${toTitle(s.id)}** — ${s.description}`);
    if (s.scripts && s.scripts.length) {
      lines.push(`  - Scripts: ${s.scripts.map((x) => `\`${x}\``).join(", ")}`);
    }
    if (s.domains && s.domains.length) {
      lines.push(`  - Domains: ${s.domains.map((x) => `\`${x}\``).join(", ")}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function renderTools(ast: TopologyAST): string {
  if (ast.toolDefs.length === 0) return "";

  const lines: string[] = [];
  lines.push("## Custom Tools");
  lines.push("");
  for (const t of ast.toolDefs) {
    const lang = t.lang ? ` (\`${t.lang}\`)` : "";
    lines.push(`- **\`${t.id}\`**${lang} — ${t.description}  `);
    lines.push(`  Script: \`${t.script}\``);
  }
  lines.push("");
  return lines.join("\n");
}

function renderMetering(ast: TopologyAST): string {
  if (!ast.metering) return "";

  const m = ast.metering;
  const lines: string[] = [];
  lines.push("## Metering");
  lines.push("");
  lines.push(`- **Track:** ${m.track.map((t) => `\`${t}\``).join(", ")}`);
  lines.push(`- **Per:** ${m.per.map((p) => `\`${p}\``).join(", ")}`);
  lines.push(`- **Output:** \`${m.output}\` (\`${m.format}\`)`);
  lines.push("");
  return lines.join("\n");
}

function renderSettings(ast: TopologyAST): string {
  const entries = Object.entries(ast.settings);
  if (entries.length === 0) return "";

  const lines: string[] = [];
  lines.push("## Settings");
  lines.push("");
  for (const [key, value] of entries) {
    if (Array.isArray(value)) {
      const arr = value as string[];
      if (arr.length === 0) {
        lines.push(`- **${toTitle(key)}:** *(none)*`);
      } else {
        lines.push(`- **${toTitle(key)}:** ${arr.map((v) => `\`${v}\``).join(", ")}`);
      }
    } else {
      lines.push(`- **${toTitle(key)}:** \`${String(value)}\``);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function renderMcpServers(ast: TopologyAST): string {
  const entries = Object.entries(ast.mcpServers);
  if (entries.length === 0) return "";

  const lines: string[] = [];
  lines.push("## MCP Servers");
  lines.push("");
  for (const [name, config] of entries) {
    const configEntries = Object.entries(config);
    const summary = configEntries.map(([k, v]) => {
      if (Array.isArray(v)) return `${k}: ${(v as string[]).map((i) => `\`${String(i)}\``).join(", ")}`;
      return `${k}: \`${String(v)}\``;
    }).join(" &nbsp;&middot;&nbsp; ");
    lines.push(`- **${toTitle(name)}** — ${summary}`);
  }
  lines.push("");
  return lines.join("\n");
}

function renderEnvironments(ast: TopologyAST): string {
  const entries = Object.entries(ast.environments);
  if (entries.length === 0) return "";

  const lines: string[] = [];
  lines.push("## Environments");
  lines.push("");
  for (const [name, config] of entries) {
    const summary = Object.entries(config).map(([k, v]) => `\`${k}\`=\`${String(v)}\``).join(", ");
    lines.push(`- **${toTitle(name)}** — ${summary}`);
  }
  lines.push("");
  return lines.join("\n");
}

function renderFooter(): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push("");
  lines.push(`<sub>Generated by <a href="https://agentopology.com">AgentTopology</a></sub>`);
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main export function
// ---------------------------------------------------------------------------

function exportMarkdown(ast: TopologyAST): GeneratedFile[] {
  const sections: string[] = [];

  sections.push(renderHeader(ast));
  sections.push(renderOverview(ast));
  sections.push(renderRoles(ast));
  sections.push(renderNodes(ast));
  sections.push(renderFlow(ast));
  sections.push(renderMemory(ast));
  sections.push(renderTriggers(ast));
  sections.push(renderHooks(ast));
  sections.push(renderSchedules(ast));
  sections.push(renderSchemas(ast));
  sections.push(renderSkills(ast));
  sections.push(renderTools(ast));
  sections.push(renderMetering(ast));
  sections.push(renderMcpServers(ast));
  sections.push(renderEnvironments(ast));
  sections.push(renderSettings(ast));
  sections.push(renderFooter());

  // Filter empty sections and join
  const content = sections.filter((s) => s.trim().length > 0).join("\n");
  const stem = ast.topology.name;

  return [{ path: `${stem}.md`, content }];
}

// ---------------------------------------------------------------------------
// Exporter instance
// ---------------------------------------------------------------------------

export const markdownExporter: Exporter = {
  name: "markdown",
  description: "Markdown documentation — shareable topology reference",
  extension: ".md",
  export: exportMarkdown,
};
