/**
 * Claude Code importer — reads .claude/ directory structure and constructs
 * a TopologyAST suitable for serialization to .at format.
 *
 * @module
 */

import type {
  TopologyAST,
  NodeDef,
  AgentNode,
  ActionNode,
  GateNode,
  HumanNode,
  GroupNode,
  OrchestratorNode,
  EdgeDef,
  OutputsMap,
  RetryConfig,
  HookDef,
  SkillDef,
  SchemaFieldDef,
  SchemaType,
  ScaleDef,
  CircuitBreakerConfig,
  PromptVariant,
  TopologyMeta,
  TriggerDef,
  MeteringDef,
} from "../parser/ast.js";
import type { PlatformFile } from "../sync/index.js";
import { extractSectionUntilKnownHeading, CLAUDE_CODE_STRUCTURAL_HEADINGS } from "../sync/index.js";

// ---------------------------------------------------------------------------
// YAML frontmatter parser (minimal, no deps)
// ---------------------------------------------------------------------------

interface FrontmatterResult {
  fields: Record<string, string | boolean | string[]>;
  body: string;
}

function parseFrontmatter(content: string): FrontmatterResult {
  const fields: Record<string, string | boolean | string[]> = {};
  let body = content;

  if (!content.startsWith("---")) {
    return { fields, body };
  }

  const endIdx = content.indexOf("---", 3);
  if (endIdx === -1) return { fields, body };

  const yaml = content.slice(3, endIdx).trim();
  body = content.slice(endIdx + 3).trim();

  let currentKey: string | null = null;
  let currentList: string[] | null = null;

  for (const line of yaml.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // List item continuation
    if (trimmed.startsWith("- ") && currentKey && currentList !== null) {
      currentList.push(trimmed.slice(2).trim());
      continue;
    }

    // Flush previous list
    if (currentKey && currentList !== null) {
      fields[currentKey] = currentList;
      currentKey = null;
      currentList = null;
    }

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const rawValue = trimmed.slice(colonIdx + 1).trim();

    if (rawValue === "" || rawValue === undefined) {
      // Start of a list
      currentKey = key;
      currentList = [];
      continue;
    }

    // Boolean
    if (rawValue === "true") { fields[key] = true; continue; }
    if (rawValue === "false") { fields[key] = false; continue; }

    // Unquote
    const value = rawValue.replace(/^["']|["']$/g, "");
    fields[key] = value;
  }

  // Flush last list
  if (currentKey && currentList !== null) {
    fields[currentKey] = currentList;
  }

  return { fields, body };
}

// ---------------------------------------------------------------------------
// Section extraction helpers
// ---------------------------------------------------------------------------

/** Known structural headings that delimit sections in AGENT.md body. */
const AGENT_KNOWN_HEADINGS = [
  ...CLAUDE_CODE_STRUCTURAL_HEADINGS,
  "## Instructions",
  "## Circuit Breaker",
  "## Input Schema",
  "## Output Schema",
  "## Variants",
  "## Artifacts",
  "## Model Configuration",
  "## Scale",
];

/** Known structural headings in SKILL.md body. */
const SKILL_KNOWN_HEADINGS = [
  "## Orchestrator",
  "## Flow",
  "## Gates",
  "## Triggers",
  "## Depth Levels",
  "## Batch",
  "## Environments",
  "## Memory",
  "## Metering",
  "## Schedules",
  "## Interfaces",
  "## Parameters",
  "## Interface",
  "## Imports",
  "## Includes",
  "## Error Handling",
  "## Fallback Chain",
  "## How to Use",
];

/** Extract a markdown section by heading, stopping at any known heading. */
function extractSection(body: string, heading: string): string | null {
  return extractSectionUntilKnownHeading(
    body,
    heading,
    AGENT_KNOWN_HEADINGS.filter((h) => h !== heading),
  );
}

/** Extract a markdown section from SKILL.md, stopping at known skill headings. */
function extractSkillSection(body: string, heading: string): string | null {
  return extractSectionUntilKnownHeading(
    body,
    heading,
    SKILL_KNOWN_HEADINGS.filter((h) => h !== heading),
  );
}

/** Parse bullet list items from a section: "- item" → ["item"] */
function parseBulletList(text: string | null): string[] {
  if (!text) return [];
  return text
    .split("\n")
    .filter((line) => line.trim().startsWith("- "))
    .map((line) => line.trim().slice(2).trim());
}

/** Parse output enum lines: "- field: val1 | val2" → OutputsMap */
function parseOutputLines(text: string | null): OutputsMap | undefined {
  if (!text) return undefined;
  const outputs: OutputsMap = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("- ")) continue;
    const content = trimmed.slice(2);
    const colonIdx = content.indexOf(":");
    if (colonIdx === -1) continue;
    const field = content.slice(0, colonIdx).trim();
    const values = content.slice(colonIdx + 1).trim().split(/\s*\|\s*/);
    if (field && values.length > 0) {
      outputs[field] = values;
    }
  }
  return Object.keys(outputs).length > 0 ? outputs : undefined;
}

// ---------------------------------------------------------------------------
// Inline pattern extractors
// ---------------------------------------------------------------------------

function extractInlinePattern(body: string, pattern: RegExp): string | null {
  const match = pattern.exec(body);
  return match ? match[1] : null;
}

function extractTimeout(body: string): string | undefined {
  return extractInlinePattern(body, /You have a maximum of (\S+) to complete/) ?? undefined;
}

function extractOnFail(body: string): string | undefined {
  return extractInlinePattern(body, /If you fail: (.+)/) ?? undefined;
}

function extractRetry(body: string): number | RetryConfig | undefined {
  const simple = extractInlinePattern(body, /Retry up to (\d+) times/);
  if (simple) return parseInt(simple, 10);

  const structured = body.match(
    /Retry strategy: max (\d+) attempts,\s*(\w+) backoff,\s*interval (\S+)/,
  );
  if (structured) {
    const config: RetryConfig = {
      max: parseInt(structured[1], 10),
      backoff: structured[2] as "none" | "linear" | "exponential",
      interval: structured[3],
    };
    const maxInt = body.match(/max interval (\S+)/);
    if (maxInt) config.maxInterval = maxInt[1].replace(/,$/, "");
    if (/with jitter/.test(body)) config.jitter = true;
    const nonRetryable = body.match(/non-retryable: (.+)/);
    if (nonRetryable) {
      config.nonRetryable = nonRetryable[1].split(/,\s*/);
    }
    return config;
  }

  return undefined;
}

function extractThinking(body: string): { thinking?: string; thinkingBudget?: number } {
  const match = body.match(/Use (\w+) level reasoning(?: \(budget: (\d+) tokens\))?/);
  if (!match) return {};
  const result: { thinking?: string; thinkingBudget?: number } = { thinking: match[1] };
  if (match[2]) result.thinkingBudget = parseInt(match[2], 10);
  return result;
}

// ---------------------------------------------------------------------------
// Reverse permission mapping
// ---------------------------------------------------------------------------

function reversePermissionMode(mode: string | undefined): string | undefined {
  if (!mode) return undefined;
  switch (mode) {
    case "plan": return "supervised";
    case "bypassPermissions": return "unrestricted";
    case "askUser": return "interactive";
    case "auto": return "autonomous";
    case "confirm": return "confirm";
    default: return mode;
  }
}

// ---------------------------------------------------------------------------
// AGENT.md parser
// ---------------------------------------------------------------------------

const KNOWN_FRONTMATTER_KEYS = new Set([
  "name", "description", "model", "maxTurns", "tools", "disallowed-tools",
  "mcpServers", "background", "permissionMode", "isolation", "sandbox",
  "fallback-chain", "type", "members",
]);

export function parseAgentMd(
  agentId: string,
  content: string,
): NodeDef | null {
  const { fields, body } = parseFrontmatter(content);

  // Detect node type
  if (fields.type === "group" || body.includes("(Group Chat)")) {
    const group: GroupNode = {
      type: "group",
      id: agentId,
      label: agentId,
      members: (fields.members as string[]) ?? [],
      description: fields.description as string | undefined,
    };
    // Try to extract group-specific fields from body
    const speakerMatch = body.match(/Speaker selection:\s*(.+)/);
    if (speakerMatch) group.speakerSelection = speakerMatch[1].trim();
    const roundsMatch = body.match(/Max rounds:\s*(\d+)/);
    if (roundsMatch) group.maxRounds = parseInt(roundsMatch[1], 10);
    const termMatch = body.match(/Termination:\s*(.+)/);
    if (termMatch) group.termination = termMatch[1].trim();
    const timeoutMatch = body.match(/Timeout:\s*(\S+)/);
    if (timeoutMatch) group.timeout = timeoutMatch[1];
    return group;
  }

  if (body.includes("(Human-in-the-Loop)")) {
    const human: HumanNode = {
      type: "human",
      id: agentId,
      label: agentId,
    };
    const descMatch = body.match(/\n\n(.+?)(?:\n\n|$)/s);
    if (descMatch) human.description = descMatch[1].trim();
    const timeoutMatch = body.match(/Timeout:\s*(\S+)/);
    if (timeoutMatch) human.timeout = timeoutMatch[1];
    const onTimeoutMatch = body.match(/On timeout:\s*(.+)/);
    if (onTimeoutMatch) human.onTimeout = onTimeoutMatch[1].trim();
    return human;
  }

  // Regular agent
  const agent: AgentNode = {
    type: "agent",
    id: agentId,
    label: agentId,
  };

  // Frontmatter fields
  if (fields.model) agent.model = fields.model as string;
  if (fields.description) agent.description = fields.description as string;
  if (fields.maxTurns) agent.maxTurns = parseInt(fields.maxTurns as string, 10);
  if (fields.tools) agent.tools = fields.tools as string[];
  if (fields["disallowed-tools"]) agent.disallowedTools = fields["disallowed-tools"] as string[];
  if (fields.mcpServers) agent.mcpServers = fields.mcpServers as string[];
  if (fields.background === true) agent.background = true;
  if (fields.permissionMode) agent.permissions = reversePermissionMode(fields.permissionMode as string);
  if (fields.isolation) agent.isolation = fields.isolation as string;
  if (fields.sandbox !== undefined) {
    agent.sandbox = fields.sandbox as string | boolean;
  }
  if (fields["fallback-chain"]) {
    const fc = fields["fallback-chain"];
    agent.fallbackChain = typeof fc === "string" ? fc.split(/,\s*/) : fc as string[];
  }

  // Extensions: any unknown frontmatter keys
  const extensions: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!KNOWN_FRONTMATTER_KEYS.has(key)) {
      extensions[key] = value;
    }
  }
  if (Object.keys(extensions).length > 0) {
    agent.extensions = { "claude-code": extensions };
  }

  // Body sections
  agent.role = extractSection(body, "## Role")?.trim() ?? undefined;
  // If role matches a single line, it's a role reference, not inline
  // Keep it as the role key for now

  const prompt = extractSection(body, "## Instructions");
  if (prompt) agent.prompt = prompt;

  agent.reads = parseBulletList(extractSection(body, "## Reads"));
  if (agent.reads.length === 0) agent.reads = undefined;

  agent.writes = parseBulletList(extractSection(body, "## Writes"));
  if (agent.writes.length === 0) agent.writes = undefined;

  agent.outputs = parseOutputLines(extractSection(body, "## Outputs"));

  // Scale
  const scaleSection = extractSection(body, "## Scale");
  if (scaleSection) {
    const mode = scaleSection.match(/Mode:\s*(\S+)/);
    const by = scaleSection.match(/By:\s*(.+)/);
    const min = scaleSection.match(/Min:\s*(\d+)/);
    const max = scaleSection.match(/Max:\s*(\d+)/);
    const batchSize = scaleSection.match(/Batch size:\s*(\d+)/);
    if (mode && by && min && max) {
      agent.scale = {
        mode: mode[1],
        by: by[1].trim(),
        min: parseInt(min[1], 10),
        max: parseInt(max[1], 10),
        batchSize: batchSize ? parseInt(batchSize[1], 10) : null,
      };
    }
  }

  // Circuit breaker
  const cbSection = extractSection(body, "## Circuit Breaker");
  if (cbSection) {
    const threshold = cbSection.match(/Failure threshold:\s*(\d+)/);
    const window = cbSection.match(/Window:\s*(\S+)/);
    const cooldown = cbSection.match(/Cooldown:\s*(\S+)/);
    if (threshold && window && cooldown) {
      agent.circuitBreaker = {
        threshold: parseInt(threshold[1], 10),
        window: window[1],
        cooldown: cooldown[1],
      };
    }
  }

  // Model configuration
  const modelConfig = extractSection(body, "## Model Configuration");
  if (modelConfig) {
    const temp = modelConfig.match(/Temperature:\s*([\d.]+)/);
    if (temp) agent.temperature = parseFloat(temp[1]);
    const maxTokens = modelConfig.match(/Max tokens:\s*(\d+)/);
    if (maxTokens) agent.maxTokens = parseInt(maxTokens[1], 10);
    const topP = modelConfig.match(/Top-p:\s*([\d.]+)/);
    if (topP) agent.topP = parseFloat(topP[1]);
    const topK = modelConfig.match(/Top-k:\s*(\d+)/);
    if (topK) agent.topK = parseInt(topK[1], 10);
    const stopMatch = modelConfig.match(/Stop sequences:\s*(.+)/);
    if (stopMatch) agent.stop = stopMatch[1].split(/,\s*/);
    const seed = modelConfig.match(/Seed:\s*(\d+)/);
    if (seed) agent.seed = parseInt(seed[1], 10);
  }

  // Input/Output schema
  const inputSchema = extractSection(body, "## Input Schema");
  if (inputSchema) agent.inputSchema = parseSchemaFields(inputSchema);
  const outputSchema = extractSection(body, "## Output Schema");
  if (outputSchema) agent.outputSchema = parseSchemaFields(outputSchema);

  // Artifacts
  const artifactsSection = extractSection(body, "## Artifacts");
  if (artifactsSection) {
    const producesMatch = artifactsSection.match(/Produces:\s*(.+)/);
    if (producesMatch) agent.produces = producesMatch[1].split(/,\s*/);
    const consumesMatch = artifactsSection.match(/Consumes:\s*(.+)/);
    if (consumesMatch) agent.consumes = consumesMatch[1].split(/,\s*/);
  }

  // Inline patterns
  agent.timeout = extractTimeout(body);
  agent.onFail = extractOnFail(body);
  agent.retry = extractRetry(body);
  const thinkingInfo = extractThinking(body);
  if (thinkingInfo.thinking) agent.thinking = thinkingInfo.thinking;
  if (thinkingInfo.thinkingBudget) agent.thinkingBudget = thinkingInfo.thinkingBudget;

  const outputFormat = extractInlinePattern(body, /Output format:\s*(\S+)/);
  if (outputFormat) agent.outputFormat = outputFormat;
  const logLevel = extractInlinePattern(body, /Log level:\s*(\S+)/);
  if (logLevel) agent.logLevel = logLevel;
  const join = extractInlinePattern(body, /Wait strategy:\s*(\S+)/);
  if (join) agent.join = join;
  const compensates = extractInlinePattern(body, /compensates.*?:\s*(\S+)/);
  if (compensates) agent.compensates = compensates;
  const invocation = extractInlinePattern(body, /Invocation:\s*(\S+)/);
  if (invocation) agent.invocation = invocation;
  const skillsInline = extractInlinePattern(body, /Skills:\s*(.+)/);
  if (skillsInline) agent.skills = skillsInline.split(/,\s*/);
  const behavior = extractInlinePattern(body, /Behavior:\s*(\S+)/);
  if (behavior) agent.behavior = behavior;
  const skip = extractInlinePattern(body, /Skip when:\s*(.+)/);
  if (skip) agent.skip = skip;
  const rateLimit = extractInlinePattern(body, /Rate limit:\s*(.+)/);
  if (rateLimit) agent.rateLimit = rateLimit;

  return agent;
}

function parseSchemaFields(text: string): SchemaFieldDef[] {
  const fields: SchemaFieldDef[] = [];
  for (const line of text.split("\n")) {
    const match = line.trim().match(/^-\s+\*\*(\w+?)(\?)?\*\*.*?:\s*(.+)/);
    if (!match) continue;
    const optional = match[2] === "?";
    fields.push({
      name: match[1],
      type: parseSchemaTypeStr(match[3].trim()),
      optional,
    });
  }
  return fields;
}

function parseSchemaTypeStr(typeStr: string): SchemaType {
  if (typeStr.endsWith("[]")) {
    return { kind: "array", itemType: parseSchemaTypeStr(typeStr.slice(0, -2)) };
  }
  if (typeStr.includes(" | ")) {
    return { kind: "enum", values: typeStr.split(/\s*\|\s*/) };
  }
  const primitives = ["string", "number", "integer", "boolean", "object"];
  if (primitives.includes(typeStr)) {
    return { kind: "primitive", value: typeStr as "string" | "number" | "integer" | "boolean" | "object" };
  }
  return { kind: "ref", name: typeStr };
}

// ---------------------------------------------------------------------------
// SKILL.md parser (topology metadata extraction)
// ---------------------------------------------------------------------------

interface SkillMdResult {
  isTopology: boolean;
  name: string;
  version?: string;
  description?: string;
  patterns?: string[];
  orchestrator?: OrchestratorNode;
  edges: EdgeDef[];
  gates: GateNode[];
  triggers: TriggerDef[];
  agentIds: Set<string>;
  domain?: string;
  foundations?: string[];
  advanced?: string[];
  timeout?: string;
  errorHandler?: string;
  durable?: boolean;
}

export function parseSkillMd(content: string): SkillMdResult {
  const { fields, body } = parseFrontmatter(content);

  const result: SkillMdResult = {
    isTopology: !!fields.topology,
    name: (fields.topology || fields.name) as string,
    version: fields.version as string | undefined,
    description: fields.description as string | undefined,
    patterns: fields.patterns as string[] | undefined,
    edges: [],
    gates: [],
    triggers: [],
    agentIds: new Set<string>(),
  };

  // Orchestrator
  const orchSection = extractSkillSection(body, "## Orchestrator");
  if (orchSection) {
    const modelMatch = orchSection.match(/Model:\s*(\S+)/);
    const handlesMatch = orchSection.match(/Handles:\s*(.+)/);
    if (modelMatch) {
      const orch: OrchestratorNode = {
        type: "orchestrator",
        id: "orchestrator",
        label: "Orchestrator",
        model: modelMatch[1],
        handles: handlesMatch ? handlesMatch[1].split(/,\s*/) : [],
      };

      // Outputs
      const outputsSection = extractSection(orchSection, "### Outputs");
      if (outputsSection) {
        orch.outputs = parseOutputLines(outputsSection);
      }

      const genMatch = orchSection.match(/Generates:\s*(.+)/);
      if (genMatch) orch.generates = genMatch[1].trim();

      result.orchestrator = orch;
    }
  }

  // Flow
  const flowSection = extractSkillSection(body, "## Flow");
  if (flowSection) {
    for (const line of flowSection.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("- ")) continue;
      const edgeLine = trimmed.slice(2).trim();
      const edge = parseEdgeLine(edgeLine);
      if (edge) {
        result.edges.push(edge);
        result.agentIds.add(edge.from);
        result.agentIds.add(edge.to);
      }
    }
  }

  // Gates
  const gatesSection = extractSkillSection(body, "## Gates");
  if (gatesSection) {
    // Split by ### headings
    const gateParts = gatesSection.split(/^### /m).filter((s) => s.trim());
    for (const part of gateParts) {
      const lines = part.split("\n");
      const gateId = lines[0].trim().toLowerCase().replace(/\s+/g, "-");
      const gate: GateNode = {
        type: "gate",
        id: gateId,
        label: gateId,
      };

      for (const line of lines.slice(1)) {
        const trimmed = line.trim();
        if (trimmed.startsWith("After:")) gate.after = trimmed.slice(6).trim();
        if (trimmed.startsWith("Before:")) gate.before = trimmed.slice(7).trim();
        if (trimmed.startsWith("Run:")) gate.run = trimmed.slice(4).trim();
        if (trimmed.startsWith("Checks:")) gate.checks = trimmed.slice(7).trim().split(/,\s*/);
        if (trimmed.startsWith("On fail:")) gate.onFail = trimmed.slice(8).trim();
        if (trimmed.startsWith("Retry:")) gate.retry = parseInt(trimmed.slice(6).trim(), 10);
        if (trimmed.startsWith("Timeout:")) gate.timeout = trimmed.slice(8).trim();
      }

      result.gates.push(gate);
    }
  }

  // Triggers
  const triggersSection = extractSkillSection(body, "## Triggers");
  if (triggersSection) {
    const triggerParts = triggersSection.split(/^### /m).filter((s) => s.trim());
    for (const part of triggerParts) {
      const lines = part.split("\n");
      const name = lines[0].trim().replace(/^\//, "");
      let pattern = "";
      let argument: string | undefined;

      for (const line of lines.slice(1)) {
        const trimmed = line.trim();
        const patternMatch = trimmed.match(/^Pattern:\s*`?(.+?)`?\s*$/);
        if (patternMatch) pattern = patternMatch[1];
        const argMatch = trimmed.match(/^Argument:\s*(\S+)/);
        if (argMatch) argument = argMatch[1];
      }

      if (name && pattern) {
        result.triggers.push({ name, pattern, argument });
      }
    }
  }

  // Extract additional topology-level metadata from body text
  const domainMatch = body.match(/^Domain:\s*(.+)/m);
  if (domainMatch) result.domain = domainMatch[1].trim();
  const foundationsMatch = body.match(/^Foundations:\s*(.+)/m);
  if (foundationsMatch) result.foundations = foundationsMatch[1].split(/,\s*/);
  const advancedMatch = body.match(/^Advanced:\s*(.+)/m);
  if (advancedMatch) result.advanced = advancedMatch[1].split(/,\s*/);
  const timeoutMatch = body.match(/^Timeout:\s*(\S+)/m);
  if (timeoutMatch) result.timeout = timeoutMatch[1];
  const errorMatch = body.match(/handled by:\s*\*\*(\S+)\*\*/);
  if (errorMatch) result.errorHandler = errorMatch[1];
  if (/Durable:\s*yes/i.test(body)) result.durable = true;

  return result;
}

function parseEdgeLine(line: string): EdgeDef | null {
  // Match: from -> to [attrs]... (one or more bracket groups)
  // Also: from -x-> to, from -x[type]-> to
  const match = line.match(
    /^(\S+)\s+(->|-x(?:\[(\w+)\])?->)\s+(\S+)((?:\s+\[[^\]]+\])*)$/,
  );
  if (!match) return null;

  const edge: EdgeDef = {
    from: match[1],
    to: match[4],
    condition: null,
    maxIterations: null,
  };

  // Error edge
  if (match[2].startsWith("-x")) {
    edge.isError = true;
    if (match[3]) edge.errorType = match[3];
  }

  // Parse attributes — merge all bracket groups into one string
  const bracketGroups = match[5]?.trim();
  if (bracketGroups) {
    // Extract contents from all [...] groups and merge
    const allAttrs = Array.from(bracketGroups.matchAll(/\[([^\]]+)\]/g))
      .map((m) => m[1])
      .join(", ");

    const whenMatch = allAttrs.match(/when\s+(.+?)(?:,\s*(?:max|per|race|tolerance|wait|weight|reflection)|$)/);
    if (whenMatch) edge.condition = whenMatch[1].trim();
    const maxMatch = allAttrs.match(/max\s+(\d+)/);
    if (maxMatch) edge.maxIterations = parseInt(maxMatch[1], 10);
    const perMatch = allAttrs.match(/per\s+(\S+)/);
    if (perMatch) edge.per = perMatch[1];
    if (/\brace\b/.test(allAttrs)) edge.race = true;
    const tolMatch = allAttrs.match(/tolerance:\s*(\S+)/);
    if (tolMatch) edge.tolerance = tolMatch[1].includes("%") ? tolMatch[1] : parseInt(tolMatch[1], 10);
    const waitMatch = allAttrs.match(/wait\s+(\S+)/);
    if (waitMatch) edge.wait = waitMatch[1];
    const weightMatch = allAttrs.match(/weight\s+([\d.]+)/);
    if (weightMatch) edge.weight = parseFloat(weightMatch[1]);
    if (/\breflection\b/.test(allAttrs)) edge.reflection = true;
  }

  return edge;
}

// ---------------------------------------------------------------------------
// settings.json parser
// ---------------------------------------------------------------------------

export function parseSettingsJson(content: string): {
  settings: Record<string, unknown>;
  hooks: HookDef[];
} {
  const json = JSON.parse(content);
  const settings: Record<string, unknown> = {};
  const hooks: HookDef[] = [];

  if (json.allow) settings.allow = json.allow;
  if (json.deny) settings.deny = json.deny;
  if (json.ask) settings.ask = json.ask;

  // Parse hooks
  if (json.hooks) {
    for (const [event, handlers] of Object.entries(json.hooks)) {
      if (!Array.isArray(handlers)) continue;
      for (const handler of handlers as Array<{ hooks?: Array<{ command?: string; type?: string; timeout?: number }>; matcher?: string }>) {
        const hookList = handler.hooks ?? [];
        const matcher = handler.matcher ?? "";
        for (const hookEntry of hookList) {
          // Skip gate enforcement hooks (generated, not user-defined)
          if (hookEntry.command && /gate-[\w-]+\.sh/.test(hookEntry.command)) continue;

          const command = hookEntry.command ?? "";
          // Extract script name for hook id
          const nameMatch = command.match(/([^/]+?)(?:\.sh)?$/);
          const name = nameMatch ? nameMatch[1] : event.toLowerCase();

          hooks.push({
            name,
            on: event,
            matcher,
            run: command,
            type: hookEntry.type,
            timeout: hookEntry.timeout,
          });
        }
      }
    }
  }

  return { settings, hooks };
}

// ---------------------------------------------------------------------------
// .mcp.json parser
// ---------------------------------------------------------------------------

export function parseMcpJson(content: string): Record<string, Record<string, unknown>> {
  const json = JSON.parse(content);
  return json.mcpServers ?? {};
}

// ---------------------------------------------------------------------------
// Command file parser
// ---------------------------------------------------------------------------

export function parseCommandMd(filename: string, content: string): TriggerDef | null {
  const name = filename.replace(/\.md$/, "");
  const { body } = parseFrontmatter(content);

  // Look for pattern in body: /command-name or just the first line
  const patternMatch = body.match(/^#\s+\/(.+)/m);
  const pattern = patternMatch ? `/${patternMatch[1].trim()}` : `/${name}`;

  // Look for argument
  const argMatch = body.match(/## Arguments\s*\n-\s*(\w+)/);
  const argument = argMatch ? argMatch[1] : undefined;

  return { name, pattern, argument };
}

// ---------------------------------------------------------------------------
// Action script parser
// ---------------------------------------------------------------------------

export function parseActionScript(filename: string, content: string): ActionNode | null {
  // Extract id from filename: action-<id>.sh → <id>
  const idMatch = filename.match(/action-(.+?)\.sh$/);
  if (!idMatch) return null;

  const id = idMatch[1];
  const action: ActionNode = {
    type: "action",
    id,
    label: id,
  };

  // Parse comment headers
  const descMatch = content.match(/# Action:\s*\S+\s*—\s*(.+)/);
  if (descMatch) action.description = descMatch[1].trim();

  if (content.includes("# External source:")) {
    action.kind = "external";
    const sourceMatch = content.match(/# External source:\s*(.+)/);
    if (sourceMatch) action.source = sourceMatch[1].trim();
  } else if (content.includes("git action")) {
    action.kind = "git";
  } else if (content.includes("report action")) {
    action.kind = "report";
  } else {
    action.kind = "inline";
  }

  const timeoutMatch = content.match(/# Timeout:\s*(\S+)/);
  if (timeoutMatch) action.timeout = timeoutMatch[1];

  const onFailMatch = content.match(/# On failure:\s*(.+)/);
  if (onFailMatch) action.onFail = onFailMatch[1].trim();

  return action;
}

// ---------------------------------------------------------------------------
// Main import function
// ---------------------------------------------------------------------------

export function importClaudeCode(
  files: PlatformFile[],
  topologyName: string,
): TopologyAST {
  const nodes: NodeDef[] = [];
  const roles: Record<string, string> = {};

  // 1. Parse AGENT.md files
  for (const file of files) {
    const match = file.path.match(/(?:^|[\\/])agents[\\/]([^\\/]+)[\\/]AGENT\.md$/);
    if (!match) continue;
    const agentId = match[1];
    const node = parseAgentMd(agentId, file.content);
    if (node) {
      // Extract role description into roles map and set agent.role to the key
      if (node.type === "agent" && node.role) {
        roles[agentId] = node.role;
        (node as AgentNode).role = agentId;
      }
      nodes.push(node);
    }
  }

  // 2. Parse SKILL.md files for topology metadata
  let topologyMeta: SkillMdResult | null = null;
  const additionalSkills: SkillDef[] = [];

  for (const file of files) {
    const match = file.path.match(/(?:^|[\\/])skills[\\/]([^\\/]+)[\\/]SKILL\.md$/);
    if (!match) continue;
    const skillResult = parseSkillMd(file.content);

    if (skillResult.isTopology && !topologyMeta) {
      topologyMeta = skillResult;
    } else {
      // Non-topology skill
      const { fields } = parseFrontmatter(file.content);
      additionalSkills.push({
        id: match[1],
        description: (fields.description as string) ?? "",
        disableModelInvocation: fields["disable-model-invocation"] as boolean | undefined,
        userInvocable: fields["user-invocable"] as boolean | undefined,
        context: fields.context as string | undefined,
        agent: fields.agent as string | undefined,
        allowedTools: fields["allowed-tools"] as string[] | undefined,
      });
    }
  }

  // 3. Parse settings.json
  let settings: Record<string, unknown> = {};
  let hooks: HookDef[] = [];
  const settingsFile = files.find((f) =>
    f.path.endsWith("settings.json") && f.path.includes(".claude"),
  );
  if (settingsFile) {
    const parsed = parseSettingsJson(settingsFile.content);
    settings = parsed.settings;
    hooks = parsed.hooks;
  }

  // 4. Parse .mcp.json
  let mcpServers: Record<string, Record<string, unknown>> = {};
  const mcpFile = files.find((f) => f.path.endsWith(".mcp.json"));
  if (mcpFile) {
    mcpServers = parseMcpJson(mcpFile.content);
  }

  // 5. Parse command files for triggers (only if no SKILL.md triggers)
  let triggers: TriggerDef[] = topologyMeta?.triggers ?? [];
  if (triggers.length === 0) {
    for (const file of files) {
      const match = file.path.match(/(?:^|[\\/])commands[\\/](.+\.md)$/);
      if (!match) continue;
      const trigger = parseCommandMd(match[1], file.content);
      if (trigger) triggers.push(trigger);
    }
  }

  // 6. Parse action scripts
  for (const file of files) {
    const match = file.path.match(/(?:^|[\\/])scripts[\\/](action-.+\.sh)$/);
    if (!match) continue;
    const action = parseActionScript(match[1], file.content);
    if (action) {
      // Don't add if already in nodes (from SKILL.md orchestrator handles)
      if (!nodes.some((n) => n.id === action.id)) {
        nodes.push(action);
      }
    }
  }

  // 7. Build orchestrator
  if (topologyMeta?.orchestrator) {
    nodes.unshift(topologyMeta.orchestrator);
  }

  // 8. Add gates from SKILL.md
  if (topologyMeta?.gates) {
    nodes.push(...topologyMeta.gates);
  }

  // 9. Build edges — from SKILL.md or generate linear flow
  let edges: EdgeDef[] = topologyMeta?.edges ?? [];
  if (edges.length === 0) {
    // Generate linear flow from agent ordering
    const agentNodes = nodes.filter((n) => n.type === "agent");
    for (let i = 0; i < agentNodes.length - 1; i++) {
      edges.push({
        from: agentNodes[i].id,
        to: agentNodes[i + 1].id,
        condition: null,
        maxIterations: null,
      });
    }
  }

  // 10. Add action nodes for orchestrator handles
  if (topologyMeta?.orchestrator) {
    for (const handleId of topologyMeta.orchestrator.handles) {
      if (!nodes.some((n) => n.id === handleId)) {
        nodes.push({
          type: "action",
          id: handleId,
          label: handleId,
          kind: "inline",
        } as ActionNode);
      }
    }
  }

  // Build topology meta
  const meta: TopologyMeta = {
    name: topologyMeta?.name ?? topologyName,
    version: topologyMeta?.version ?? "1.0.0",
    description: topologyMeta?.description ?? "",
    patterns: topologyMeta?.patterns ?? [],
    foundations: topologyMeta?.foundations,
    advanced: topologyMeta?.advanced,
    domain: topologyMeta?.domain,
    timeout: topologyMeta?.timeout,
    errorHandler: topologyMeta?.errorHandler,
    durable: topologyMeta?.durable,
  };

  const ast: TopologyAST = {
    topology: meta,
    nodes,
    edges,
    depth: { factors: [], levels: [] },
    memory: {},
    batch: {},
    environments: {},
    triggers,
    hooks,
    settings,
    mcpServers,
    metering: null,
    skills: additionalSkills,
    toolDefs: [],
    roles,
    context: {},
    env: {},
    providers: [],
    schedules: [],
    interfaces: [],
    defaults: null,
    schemas: [],
    observability: null,
    params: [],
    interfaceEndpoints: null,
    imports: [],
    includes: [],
    checkpoint: null,
    artifacts: [],
  };

  return ast;
}
