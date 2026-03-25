/**
 * OpenClaw importer — reads an OpenClaw workspace directory structure and
 * constructs a TopologyAST suitable for serialization to .at format.
 *
 * Reverses the OpenClaw binding ({@link ../bindings/openclaw.ts}) by parsing:
 * - openclaw.json  — agent list, models, providers, env, settings
 * - SOUL.md        — topology metadata, roles, params, triggers, interface
 * - AGENTS.md      — agents, groups, humans, flow, gates, schedule, hooks
 * - MEMORY.md      — workspace, domains, stores
 * - skills/        — skill definitions (YAML frontmatter)
 * - cron/jobs.json — scheduled jobs (fallback)
 *
 * @module
 */

import type {
  TopologyAST,
  NodeDef,
  AgentNode,
  GateNode,
  HumanNode,
  GroupNode,
  EdgeDef,
  HookDef,
  SkillDef,
  CircuitBreakerConfig,
  RetryConfig,
  TriggerDef,
  TopologyMeta,
  ProviderDef,
  ParamDef,
  InterfaceEndpoints,
  ScheduleJobDef,
  MeteringDef,
} from "../parser/ast.js";
import type { PlatformFile } from "../sync/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Reverse Title Case to kebab-case: "Linkedin Soldier" → "linkedin-soldier" */
function toId(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, "-");
}

/**
 * Reverse model mapping: strip provider prefix and reverse short aliases.
 *
 * The OpenClaw binding prepends the provider name (e.g., "openrouter/") to
 * model strings. This function strips it back and converts Anthropic model
 * names to their short aliases (opus, sonnet, haiku).
 */
function reverseMapModel(
  openclawModel: string,
  providerNames: string[],
): string {
  let model = openclawModel;

  // Strip known provider prefixes
  for (const provider of providerNames) {
    if (model.startsWith(`${provider}/`)) {
      model = model.slice(provider.length + 1);
      break;
    }
  }

  // Reverse Anthropic short aliases
  const REVERSE_ALIASES: Record<string, string> = {
    "claude-opus-4-6": "opus",
    "claude-sonnet-4-6": "sonnet",
    "claude-haiku-4-5": "haiku",
  };

  // Check if the last segment matches an alias
  const lastSlash = model.lastIndexOf("/");
  const baseName = lastSlash >= 0 ? model.slice(lastSlash + 1) : model;
  if (REVERSE_ALIASES[baseName]) {
    return REVERSE_ALIASES[baseName];
  }

  return model;
}

/** Reverse permission mapping from OpenClaw → .at format. */
function reversePermission(perm: string): string {
  switch (perm) {
    case "autonomous":
      return "auto";
    case "supervised":
      return "plan";
    case "interactive":
      return "confirm";
    case "unrestricted":
      return "bypassPermissions";
    default:
      return perm;
  }
}

/** Minimal YAML frontmatter parser (same pattern as claude-code.ts). */
interface FrontmatterResult {
  fields: Record<string, string | boolean>;
  body: string;
}

function parseFrontmatter(content: string): FrontmatterResult {
  const fields: Record<string, string | boolean> = {};
  let body = content;

  if (!content.startsWith("---")) {
    return { fields, body };
  }

  const endIdx = content.indexOf("---", 3);
  if (endIdx === -1) return { fields, body };

  const yaml = content.slice(3, endIdx).trim();
  body = content.slice(endIdx + 3).trim();

  for (const line of yaml.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const rawValue = trimmed.slice(colonIdx + 1).trim();

    if (rawValue === "true") {
      fields[key] = true;
      continue;
    }
    if (rawValue === "false") {
      fields[key] = false;
      continue;
    }

    fields[key] = rawValue.replace(/^["']|["']$/g, "");
  }

  return { fields, body };
}

/**
 * Extract a section from markdown by heading, returning text until the next
 * heading of equal or higher level.
 */
function extractSection(
  content: string,
  heading: string,
  stopLevel?: number,
): string | null {
  const headingLevel = heading.match(/^#+/)?.[0].length ?? 2;
  const level = stopLevel ?? headingLevel;

  const pattern = new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m");
  const match = pattern.exec(content);
  if (!match) return null;

  const startIdx = match.index + match[0].length;
  const rest = content.slice(startIdx);

  // Find next heading of same or higher level
  const stopPattern = new RegExp(`^#{1,${level}}\\s`, "m");
  const stopMatch = stopPattern.exec(rest);

  const section = stopMatch ? rest.slice(0, stopMatch.index) : rest;
  return section.trim() || null;
}

/**
 * Extract all level-3 subsections from a section body.
 * Returns array of [title, body] tuples.
 */
function extractSubsections(
  sectionBody: string,
  level: number = 3,
): Array<[string, string]> {
  const prefix = "#".repeat(level);
  const pattern = new RegExp(`^${prefix} (.+)$`, "gm");
  const results: Array<[string, string]> = [];
  let match: RegExpExecArray | null;
  const matches: Array<{ title: string; start: number }> = [];

  while ((match = pattern.exec(sectionBody)) !== null) {
    matches.push({ title: match[1].trim(), start: match.index + match[0].length });
  }

  for (let i = 0; i < matches.length; i++) {
    const end = i + 1 < matches.length
      ? sectionBody.lastIndexOf(`\n${prefix} `, matches[i + 1].start - matches[i + 1].title.length - prefix.length - 2) + 1
      : sectionBody.length;
    // Simpler: just slice from current start to next match start (minus the heading line)
    const nextStart = i + 1 < matches.length
      ? sectionBody.indexOf(`\n${prefix} ${matches[i + 1].title}`, matches[i].start)
      : sectionBody.length;
    const body = sectionBody.slice(matches[i].start, nextStart).trim();
    results.push([matches[i].title, body]);
  }

  return results;
}

/** Parse a `- **Key:** value` line from markdown. */
function extractField(text: string, key: string): string | undefined {
  const pattern = new RegExp(`-\\s*\\*\\*${key}:\\*\\*\\s*(.+)`, "i");
  const match = pattern.exec(text);
  return match ? match[1].trim() : undefined;
}

// ---------------------------------------------------------------------------
// openclaw.json parser
// ---------------------------------------------------------------------------

export interface OpenClawJsonResult {
  agents: Array<{
    id: string;
    model?: string;
    fallbacks?: string[];
    subagents?: string[];
  }>;
  defaultModel?: string;
  providers: ProviderDef[];
  providerNames: string[];
  settings: { allow?: string[]; deny?: string[] };
  env: Record<string, string>;
  extensions: Record<string, unknown>;
}

export function parseOpenClawJson(content: string): OpenClawJsonResult {
  const json = JSON.parse(content);
  const result: OpenClawJsonResult = {
    agents: [],
    providers: [],
    providerNames: [],
    settings: {},
    env: {},
    extensions: {},
  };

  // Default model
  if (json.agents?.defaults?.model?.primary) {
    result.defaultModel = json.agents.defaults.model.primary;
  }

  // Agent list
  if (json.agents?.list) {
    for (const agent of json.agents.list) {
      const entry: OpenClawJsonResult["agents"][0] = { id: agent.id };
      if (agent.model?.primary) entry.model = agent.model.primary;
      if (agent.model?.fallbacks) entry.fallbacks = agent.model.fallbacks;
      if (agent.subagents?.allowAgents) entry.subagents = agent.subagents.allowAgents;
      result.agents.push(entry);
    }
  }

  // Providers
  if (json.models?.providers) {
    for (const [name, config] of Object.entries(json.models.providers) as [string, any][]) {
      result.providerNames.push(name);
      const provider: ProviderDef = {
        name,
        models: (config.models ?? []).map((m: any) => typeof m === "string" ? m : m.id ?? m.name),
        extra: {},
      };
      if (config.apiKey) provider.apiKey = config.apiKey;
      if (config.baseUrl) provider.baseUrl = config.baseUrl;
      result.providers.push(provider);
    }
  }

  // Tools settings
  if (json.tools) {
    if (json.tools.allow?.length) result.settings.allow = json.tools.allow;
    if (json.tools.deny?.length) result.settings.deny = json.tools.deny;
  }

  // Env
  if (json.env) {
    result.env = { ...json.env };
  }

  // Gateway → extensions
  if (json.gateway) {
    result.extensions["gateway-port"] = json.gateway.port;
    if (json.gateway.auth) {
      result.extensions["auth-mode"] = json.gateway.auth.mode;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// SOUL.md parser
// ---------------------------------------------------------------------------

export interface SoulMdResult {
  name?: string;
  version?: string;
  description?: string;
  patterns?: string[];
  roles: Record<string, string>;
  params: ParamDef[];
  interfaceEndpoints: InterfaceEndpoints | null;
  triggers: TriggerDef[];
  env: Record<string, string>;
  domain?: string;
  timeout?: string;
  durable?: boolean;
  errorHandler?: string;
}

export function parseSoulMd(content: string): SoulMdResult {
  const result: SoulMdResult = {
    roles: {},
    params: [],
    interfaceEndpoints: null,
    triggers: [],
    env: {},
  };

  // Quote block at top → description
  const quoteMatch = content.match(/^>\s*(.+)/m);
  if (quoteMatch) {
    result.description = quoteMatch[1].trim();
  }

  // ## Identity
  const identity = extractSection(content, "## Identity");
  if (identity) {
    const nameMatch = identity.match(/Name:\s*(.+)/);
    if (nameMatch) result.name = toId(nameMatch[1].trim());
    const versionMatch = identity.match(/Version:\s*(.+)/);
    if (versionMatch) result.version = versionMatch[1].trim();
    const patternsMatch = identity.match(/Patterns:\s*(.+)/);
    if (patternsMatch) {
      result.patterns = patternsMatch[1].split(/,\s*/).map((p) => p.trim());
    }
  }

  // ## Mission (fallback description)
  if (!result.description) {
    const mission = extractSection(content, "## Mission");
    if (mission) result.description = mission.split("\n")[0].trim();
  }

  // ## Roles
  const rolesSection = extractSection(content, "## Roles");
  if (rolesSection) {
    const roleSubs = extractSubsections(rolesSection);
    for (const [title, body] of roleSubs) {
      const roleId = toId(title);
      // Body is the role description (first non-empty line)
      const desc = body.split("\n").find((l) => l.trim())?.trim();
      if (desc) result.roles[roleId] = desc;
    }
  }

  // ## Ethical Guardrails — extract meta info
  const guardrails = extractSection(content, "## Ethical Guardrails");
  if (guardrails) {
    const permMatch = guardrails.match(/Permission model:\s*(.+)/);
    // stored but not directly mapped to AST — informational
    const domainMatch = guardrails.match(/Domain:\s*(.+)/);
    if (domainMatch) result.domain = domainMatch[1].trim();
  }

  // ## Parameters
  const paramsSection = extractSection(content, "## Parameters");
  if (paramsSection) {
    // Format: - **name**: type (required) = default
    // Or:     - **name**: type = default
    const paramPattern = /- \*\*(\S+)\*\*:\s*(\w+)(?:\s*\(required\))?(?:\s*=\s*(.+))?/g;
    let paramMatch: RegExpExecArray | null;
    while ((paramMatch = paramPattern.exec(paramsSection)) !== null) {
      const name = paramMatch[1];
      const type = paramMatch[2] as "string" | "number" | "boolean";
      const defaultVal = paramMatch[3]?.trim();
      const required = !defaultVal && paramsSection.includes(`${name}**:`) && paramsSection.includes("(required)");
      result.params.push({
        name,
        type,
        default: defaultVal,
        required: !defaultVal,
      });
    }
  }

  // ## Interface
  const interfaceSection = extractSection(content, "## Interface");
  if (interfaceSection) {
    const entryMatch = interfaceSection.match(/Entry:\s*(\S+)/);
    const exitMatch = interfaceSection.match(/Exit:\s*(\S+)/);
    if (entryMatch && exitMatch) {
      result.interfaceEndpoints = {
        entry: entryMatch[1],
        exit: exitMatch[1],
      };
    }
  }

  // ## Triggers
  const triggersSection = extractSection(content, "## Triggers");
  if (triggersSection) {
    const triggerSubs = extractSubsections(triggersSection);
    for (const [title, body] of triggerSubs) {
      const trigger: TriggerDef = { name: toId(title), pattern: "" };
      const patternMatch = body.match(/Pattern:\s*`?([^`\n]+)`?/);
      if (patternMatch) trigger.pattern = patternMatch[1].trim();
      const argMatch = body.match(/Argument:\s*(\S+)/);
      if (argMatch) trigger.argument = argMatch[1];
      result.triggers.push(trigger);
    }
  }

  // ## Environment
  const envSection = extractSection(content, "## Environment");
  if (envSection) {
    const envPattern = /- `(\S+)`:\s*(.+)/g;
    let envMatch: RegExpExecArray | null;
    while ((envMatch = envPattern.exec(envSection)) !== null) {
      result.env[envMatch[1]] = envMatch[2].trim();
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// AGENTS.md parser
// ---------------------------------------------------------------------------

export interface AgentsMdResult {
  agents: AgentNode[];
  groups: GroupNode[];
  humans: HumanNode[];
  gates: GateNode[];
  edges: EdgeDef[];
  schedules: ScheduleJobDef[];
  hooks: HookDef[];
  metering: MeteringDef | null;
  patterns?: string[];
}

export function parseAgentsMd(content: string): AgentsMdResult {
  const result: AgentsMdResult = {
    agents: [],
    groups: [],
    humans: [],
    gates: [],
    edges: [],
    schedules: [],
    hooks: [],
    metering: null,
  };

  // ## Agents
  const agentsSection = extractSection(content, "## Agents");
  if (agentsSection) {
    const agentSubs = extractSubsections(agentsSection);
    for (const [title, body] of agentSubs) {
      const agent = parseAgentSubsection(toId(title), body);
      result.agents.push(agent);
    }
  }

  // ## Human Pause Points
  const humanSection = extractSection(content, "## Human Pause Points");
  if (humanSection) {
    const humanSubs = extractSubsections(humanSection);
    for (const [title, body] of humanSubs) {
      const human: HumanNode = {
        type: "human",
        id: toId(title),
        label: toId(title),
      };
      const action = extractField(body, "Action");
      if (action) human.description = action;
      const timeout = extractField(body, "Timeout");
      if (timeout) human.timeout = timeout;
      const onTimeout = extractField(body, "On timeout");
      if (onTimeout) human.onTimeout = onTimeout;
      result.humans.push(human);
    }
  }

  // ## Group Chat Coordination
  const groupSection = extractSection(content, "## Group Chat Coordination");
  if (groupSection) {
    const groupSubs = extractSubsections(groupSection);
    for (const [title, body] of groupSubs) {
      const group: GroupNode = {
        type: "group",
        id: toId(title),
        label: toId(title),
        members: [],
      };
      const members = extractField(body, "Members");
      if (members) group.members = members.split(/,\s*/);
      const speaker = extractField(body, "Speaker selection");
      if (speaker) group.speakerSelection = speaker;
      const maxRounds = extractField(body, "Max rounds");
      if (maxRounds) group.maxRounds = parseInt(maxRounds, 10);
      const termination = extractField(body, "Termination");
      if (termination) group.termination = termination;
      const description = extractField(body, "Description");
      if (description) group.description = description;
      const timeout = extractField(body, "Timeout");
      if (timeout) group.timeout = timeout;
      result.groups.push(group);
    }
  }

  // ## Flow → ### Execution Order
  const flowSection = extractSection(content, "## Flow");
  if (flowSection) {
    const execOrder = extractSection(flowSection, "### Execution Order", 3);
    if (execOrder) {
      result.edges = parseEdgeLines(execOrder);
    }
  }

  // ## Gates
  const gatesSection = extractSection(content, "## Gates");
  if (gatesSection) {
    const gateSubs = extractSubsections(gatesSection);
    for (const [title, body] of gateSubs) {
      const gate: GateNode = {
        type: "gate",
        id: toId(title),
        label: toId(title),
      };
      const after = extractField(body, "After");
      if (after) gate.after = after;
      const before = extractField(body, "Before");
      if (before) gate.before = before;
      const script = extractField(body, "Script");
      if (script) gate.run = script;
      const onFail = extractField(body, "On failure");
      if (onFail) gate.onFail = onFail;
      const behavior = extractField(body, "Behavior");
      if (behavior) gate.behavior = behavior;
      const checks = extractField(body, "Checks");
      if (checks) gate.checks = checks.split(/,\s*/);
      const retry = extractField(body, "Retry");
      if (retry) gate.retry = parseInt(retry, 10);
      const timeout = extractField(body, "Timeout");
      if (timeout) gate.timeout = timeout;
      result.gates.push(gate);
    }
  }

  // ## Schedule
  const scheduleSection = extractSection(content, "## Schedule");
  if (scheduleSection) {
    const scheduleSubs = extractSubsections(scheduleSection);
    for (const [title, body] of scheduleSubs) {
      const job: ScheduleJobDef = {
        id: toId(title),
        enabled: true,
      };
      const agent = extractField(body, "Agent");
      if (agent) job.agent = agent;
      const cron = extractField(body, "Cron");
      if (cron) job.cron = cron.replace(/`/g, "").trim();
      const enabled = extractField(body, "Enabled");
      if (enabled) job.enabled = enabled === "true";
      result.schedules.push(job);
    }
  }

  // ## Hooks
  const hooksSection = extractSection(content, "## Hooks");
  if (hooksSection) {
    const hookSubs = extractSubsections(hooksSection);
    for (const [title, body] of hookSubs) {
      const hook: HookDef = {
        name: toId(title),
        on: "",
        matcher: "",
        run: "",
      };
      const event = extractField(body, "Event");
      if (event) hook.on = event;
      const matcher = extractField(body, "Matcher");
      if (matcher) hook.matcher = matcher;
      const run = extractField(body, "Run");
      if (run) hook.run = run;
      const type = extractField(body, "Type");
      if (type) hook.type = type;
      const timeout = extractField(body, "Timeout");
      if (timeout) hook.timeout = parseInt(timeout, 10);
      result.hooks.push(hook);
    }
  }

  // ### Metering (within the topology overview, after ---)
  const meteringSection = extractSection(content, "### Metering", 3);
  if (meteringSection) {
    const track = extractField(meteringSection, "Track") ?? meteringSection.match(/Track:\s*(.+)/)?.[1];
    const per = extractField(meteringSection, "Per") ?? meteringSection.match(/Per:\s*(.+)/)?.[1];
    const outputMatch = meteringSection.match(/Output:\s*(\S+)\s*\((\w+)\)/);
    const pricing = extractField(meteringSection, "Pricing") ?? meteringSection.match(/Pricing:\s*(.+)/)?.[1];
    if (track && per && outputMatch) {
      result.metering = {
        track: track.split(/,\s*/),
        per: per.split(/,\s*/),
        output: outputMatch[1],
        format: outputMatch[2],
        pricing: pricing ?? "",
      };
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Agent subsection parser (within AGENTS.md ## Agents)
// ---------------------------------------------------------------------------

function parseAgentSubsection(agentId: string, body: string): AgentNode {
  const agent: AgentNode = {
    type: "agent",
    id: agentId,
    label: agentId,
  };

  // Extract fields before #### Instructions
  const instructionsIdx = body.indexOf("#### Instructions");
  const propsText = instructionsIdx >= 0 ? body.slice(0, instructionsIdx) : body;
  const promptText = instructionsIdx >= 0 ? body.slice(instructionsIdx + "#### Instructions".length) : null;

  // Model — strip the "anthropic/" prefix the binding sometimes adds
  const model = extractField(propsText, "Model");
  if (model) agent.model = model;

  // Phase
  const phase = extractField(propsText, "Phase");
  if (phase) agent.phase = parseFloat(phase);

  // Role
  const role = extractField(propsText, "Role");
  if (role) agent.role = role;

  // Tools
  const tools = extractField(propsText, "Tools allowed");
  if (tools && tools !== "none") agent.tools = tools.split(/,\s*/);
  const denied = extractField(propsText, "Tools denied");
  if (denied && denied !== "none") agent.disallowedTools = denied.split(/,\s*/);

  // Memory access
  const reads = extractField(propsText, "Reads");
  if (reads) agent.reads = reads.split(/,\s*/);
  const writes = extractField(propsText, "Writes");
  if (writes) agent.writes = writes.split(/,\s*/);

  // Skills
  const skills = extractField(propsText, "Skills");
  if (skills) agent.skills = skills.split(/,\s*/);

  // Max turns
  const maxTurns = extractField(propsText, "Max turns");
  if (maxTurns) agent.maxTurns = parseInt(maxTurns, 10);

  // Permissions
  const permissions = extractField(propsText, "Permissions");
  if (permissions) agent.permissions = reversePermission(permissions);

  // Outputs
  const outputsMatch = propsText.match(/- \*\*Outputs:\*\*\n((?:\s+- .+\n?)+)/);
  if (outputsMatch) {
    const outputs: Record<string, string[]> = {};
    for (const line of outputsMatch[1].split("\n")) {
      const oMatch = line.trim().match(/^-\s+(\S+):\s*(.+)/);
      if (oMatch) {
        outputs[oMatch[1]] = oMatch[2].split(/\s*\|\s*/);
      }
    }
    if (Object.keys(outputs).length > 0) agent.outputs = outputs;
  }

  // Scale
  const scale = extractField(propsText, "Scale");
  if (scale) {
    const scaleMatch = scale.match(/(\d+)-(\d+)\s+instances\s+by\s+(.+)/);
    if (scaleMatch) {
      agent.scale = {
        mode: "auto",
        by: scaleMatch[3].trim(),
        min: parseInt(scaleMatch[1], 10),
        max: parseInt(scaleMatch[2], 10),
        batchSize: null,
      };
    }
  }

  // Prompt
  if (promptText) {
    // The prompt text runs until we hit trailing property lines (- **Key:** ...)
    // Split: prompt content is everything that's NOT a trailing `- **` line
    const lines = promptText.split("\n");
    const promptLines: string[] = [];
    const trailingProps: string[] = [];
    let hitTrailingProps = false;

    // Walk from the end to find trailing property lines
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.match(/^- \*\*/) || (hitTrailingProps && line === "")) {
        trailingProps.unshift(lines[i]);
        hitTrailingProps = true;
      } else {
        break;
      }
    }

    const promptEndIdx = lines.length - trailingProps.length;
    for (let i = 0; i < promptEndIdx; i++) {
      promptLines.push(lines[i]);
    }

    const prompt = promptLines.join("\n").trim();
    if (prompt) agent.prompt = prompt;

    // Parse trailing properties
    const trailingText = trailingProps.join("\n");
    parseTrailingAgentProps(agent, trailingText);
  }

  // Also parse trailing props that might be in the propsText (after description/before instructions)
  parseTrailingAgentProps(agent, propsText);

  return agent;
}

/** Parse `- **Key:** value` properties that appear after agent instructions. */
function parseTrailingAgentProps(agent: AgentNode, text: string): void {
  // Timeout
  const timeout = extractField(text, "Maximum execution time");
  if (timeout && !agent.timeout) agent.timeout = timeout;

  // On failure
  const onFail = extractField(text, "On failure");
  if (onFail && !agent.onFail) agent.onFail = onFail;

  // Retry — format: "max N attempts" or structured
  const retry = extractField(text, "Retry");
  if (retry && agent.retry == null) {
    agent.retry = parseRetryString(retry);
  }

  // Thinking
  const thinking = extractField(text, "Reasoning level");
  if (thinking && !agent.thinking) agent.thinking = thinking;

  // Output format
  const outputFormat = extractField(text, "Output format");
  if (outputFormat && !agent.outputFormat) agent.outputFormat = outputFormat;

  // Log level
  const logLevel = extractField(text, "Log verbosity");
  if (logLevel && !agent.logLevel) agent.logLevel = logLevel;

  // Join
  const join = extractField(text, "Wait for");
  if (join && !agent.join) agent.join = join;

  // Circuit breaker
  const cb = extractField(text, "Circuit breaker");
  if (cb && !agent.circuitBreaker) {
    agent.circuitBreaker = parseCircuitBreakerString(cb);
  }

  // Compensates
  const compensates = extractField(text, "Compensates");
  if (compensates && !agent.compensates) {
    agent.compensates = compensates.replace(/\s*\(saga rollback\)/, "").trim();
  }

  // Rate limit
  const rateLimit = extractField(text, "Rate limit");
  if (rateLimit && !agent.rateLimit) agent.rateLimit = rateLimit;

  // Produces / Consumes
  const produces = extractField(text, "Produces");
  if (produces && !agent.produces) agent.produces = produces.split(/,\s*/);
  const consumes = extractField(text, "Consumes");
  if (consumes && !agent.consumes) agent.consumes = consumes.split(/,\s*/);
}

/** Parse retry string: "max N attempts" or structured format. */
function parseRetryString(s: string): number | RetryConfig {
  const simpleMatch = s.match(/max (\d+) attempts?/);
  if (simpleMatch) {
    // Check for additional structured fields
    const parts = s.split(/,\s*/);
    if (parts.length === 1) {
      return parseInt(simpleMatch[1], 10);
    }
    // Structured
    const config: RetryConfig = { max: parseInt(simpleMatch[1], 10) };
    for (const part of parts.slice(1)) {
      const kv = part.match(/(\S+):\s*(.+)/);
      if (!kv) continue;
      const key = kv[1].trim();
      const val = kv[2].trim();
      if (key === "backoff") config.backoff = val as RetryConfig["backoff"];
      else if (key === "interval") config.interval = val;
      else if (key === "max interval") config.maxInterval = val;
      else if (key === "jitter" && val === "on") config.jitter = true;
      else if (key === "non-retryable") config.nonRetryable = val.split(/,\s*/);
    }
    if (config.backoff || config.interval || config.jitter || config.nonRetryable) {
      return config;
    }
    return config.max;
  }
  // Simple integer
  const num = parseInt(s, 10);
  return isNaN(num) ? 1 : num;
}

/** Parse circuit breaker string: "threshold=N, window=X, cooldown=Y" */
function parseCircuitBreakerString(s: string): CircuitBreakerConfig | undefined {
  const threshold = s.match(/threshold=(\d+)/);
  const window = s.match(/window=(\S+)/);
  const cooldown = s.match(/cooldown=(\S+)/);
  if (threshold && window && cooldown) {
    return {
      threshold: parseInt(threshold[1], 10),
      window: window[1].replace(/,$/, ""),
      cooldown: cooldown[1].replace(/,$/, ""),
    };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Edge line parser
// ---------------------------------------------------------------------------

/**
 * Parse edge lines from the Execution Order section.
 *
 * Formats:
 *   1. from -> to
 *   1. from -> to when condition
 *   1. from -x-> to (max N iterations)
 *   1. from -> to (max N iterations) [error: type] [weight: N] [race] [tolerance: N] [wait: T] [reflection]
 */
function parseEdgeLines(text: string): EdgeDef[] {
  const edges: EdgeDef[] = [];
  const lines = text.split("\n").filter((l) => l.trim());

  for (const line of lines) {
    // Match: N. from ARROW to [rest]
    // Arrow is either -> or -x->
    const match = line.match(
      /^\d+\.\s+(\S+)\s+(->|-x->)\s+(\S+)\s*(.*)?$/,
    );
    if (!match) continue;

    const from = match[1];
    const arrow = match[2];
    const to = match[3];
    const rest = match[4] ?? "";

    const edge: EdgeDef = {
      from,
      to,
      condition: null,
      maxIterations: null,
    };

    if (arrow === "-x->") {
      edge.isError = true;
    }

    // when condition
    const whenMatch = rest.match(/when\s+(.+?)(?:\s*\(|$)/);
    if (whenMatch) edge.condition = whenMatch[1].trim();

    // (max N iterations)
    const maxMatch = rest.match(/\(max (\d+) iterations?\)/);
    if (maxMatch) edge.maxIterations = parseInt(maxMatch[1], 10);

    // [error: type]
    const errorTypeMatch = rest.match(/\[error:\s*(\S+)\]/);
    if (errorTypeMatch) edge.errorType = errorTypeMatch[1];

    // [weight: N]
    const weightMatch = rest.match(/\[weight:\s*([\d.]+)\]/);
    if (weightMatch) edge.weight = parseFloat(weightMatch[1]);

    // [race]
    if (/\[race\]/.test(rest)) edge.race = true;

    // [tolerance: N]
    const tolMatch = rest.match(/\[tolerance:\s*([^\]]+)\]/);
    if (tolMatch) {
      const tVal = tolMatch[1].trim();
      edge.tolerance = tVal.includes("%") ? tVal : parseInt(tVal, 10);
    }

    // [wait: T]
    const waitMatch = rest.match(/\[wait:\s*(\S+)\]/);
    if (waitMatch) edge.wait = waitMatch[1];

    // [reflection]
    if (/\[reflection\]/.test(rest)) edge.reflection = true;

    edges.push(edge);
  }

  return edges;
}

// ---------------------------------------------------------------------------
// MEMORY.md parser
// ---------------------------------------------------------------------------

export interface MemoryMdResult {
  memory: Record<string, unknown>;
}

export function parseMemoryMd(content: string): MemoryMdResult {
  const memory: Record<string, unknown> = {};

  // ## Workspace or workspace subsection
  const workspaceSection = extractSection(content, "## Workspace") ??
    extractSection(content, "### Workspace");
  if (workspaceSection) {
    const workspace: Record<string, unknown> = {};
    const pathMatch = workspaceSection.match(/Path:\s*`?([^`\n]+)`?/);
    if (pathMatch) workspace.path = pathMatch[1].trim();
    const structMatch = workspaceSection.match(/Structure:\s*(.+)/);
    if (structMatch) {
      workspace.structure = structMatch[1].split(/,\s*/).map((s) => s.trim());
    }
    // Also handle bullet list structure
    const bulletStructure = workspaceSection.match(/Structure:\s*\n((?:\s+- .+\n?)+)/);
    if (bulletStructure) {
      workspace.structure = bulletStructure[1]
        .split("\n")
        .filter((l) => l.trim().startsWith("- "))
        .map((l) => l.trim().slice(2).trim());
    }
    memory.workspace = workspace;
  }

  // ## Domains or domains subsection
  const domainsSection = extractSection(content, "## Domains") ??
    extractSection(content, "### Domains");
  if (domainsSection) {
    const domains: Record<string, unknown> = {};
    const pathMatch = domainsSection.match(/Path:\s*`?([^`\n]+)`?/);
    if (pathMatch) domains.path = pathMatch[1].trim();
    const routingMatch = domainsSection.match(/Routing:\s*(.+)/);
    if (routingMatch) domains.routing = routingMatch[1].trim();
    memory.domains = domains;
  }

  return { memory };
}

// ---------------------------------------------------------------------------
// Skill file parser
// ---------------------------------------------------------------------------

export function parseSkillFile(
  skillId: string,
  content: string,
): SkillDef {
  const { fields, body } = parseFrontmatter(content);

  const skill: SkillDef = {
    id: skillId,
    description: (fields.description as string) ?? body.split("\n")[0]?.trim() ?? "",
  };

  if (fields["user-invocable"] !== undefined) {
    skill.userInvocable = fields["user-invocable"] as boolean;
  }

  return skill;
}

// ---------------------------------------------------------------------------
// cron/jobs.json parser (fallback)
// ---------------------------------------------------------------------------

export function parseCronJobsJson(content: string): ScheduleJobDef[] {
  const json = JSON.parse(content);
  const jobs: ScheduleJobDef[] = [];

  const jobList = json.jobs ?? json;
  if (!Array.isArray(jobList)) return jobs;

  for (const job of jobList) {
    const def: ScheduleJobDef = {
      id: job.id,
      enabled: job.enabled ?? true,
    };
    if (job.agentId) def.agent = job.agentId;
    if (job.schedule?.expr) def.cron = job.schedule.expr;
    if (job.cron) def.cron = job.cron;
    jobs.push(def);
  }

  return jobs;
}

// ---------------------------------------------------------------------------
// Main import function
// ---------------------------------------------------------------------------

export function importOpenClaw(
  files: PlatformFile[],
  topologyName: string,
): TopologyAST {
  // 1. Parse openclaw.json
  let openclawJson: OpenClawJsonResult | null = null;
  for (const file of files) {
    if (file.path.endsWith("openclaw.json") && !file.path.includes("node_modules")) {
      openclawJson = parseOpenClawJson(file.content);
      break;
    }
  }

  // Helper: match root-level markdown files (not inside config/agents/)
  const isRootMd = (path: string, name: string): boolean =>
    (path.endsWith(`/${name}`) || path === name) &&
    !path.includes("config/agents/");

  // 2. Parse root SOUL.md (not in config/agents/)
  let soulResult: SoulMdResult | null = null;
  for (const file of files) {
    if (isRootMd(file.path, "SOUL.md")) {
      soulResult = parseSoulMd(file.content);
      break;
    }
  }

  // 3. Parse root AGENTS.md (not in config/agents/)
  let agentsResult: AgentsMdResult | null = null;
  for (const file of files) {
    if (isRootMd(file.path, "AGENTS.md")) {
      agentsResult = parseAgentsMd(file.content);
      break;
    }
  }

  // 4. Parse root MEMORY.md (not in config/agents/)
  let memoryResult: MemoryMdResult | null = null;
  for (const file of files) {
    if (isRootMd(file.path, "MEMORY.md")) {
      memoryResult = parseMemoryMd(file.content);
      break;
    }
  }

  // 5. Parse skill files
  const skills: SkillDef[] = [];
  const skillPattern = /skills\/([^/]+)\/SKILL\.md$/;
  for (const file of files) {
    const match = skillPattern.exec(file.path);
    if (match) {
      skills.push(parseSkillFile(match[1], file.content));
    }
  }

  // 6. Parse cron/jobs.json (fallback for schedules)
  let cronJobs: ScheduleJobDef[] = [];
  for (const file of files) {
    if (file.path.endsWith("cron/jobs.json")) {
      try {
        cronJobs = parseCronJobsJson(file.content);
      } catch {
        // Ignore parse errors
      }
      break;
    }
  }

  // --- Merge everything into a TopologyAST ---

  const providerNames = openclawJson?.providerNames ?? [];

  // Reverse model mapping on agents
  const agents = agentsResult?.agents ?? [];
  if (openclawJson) {
    for (const agent of agents) {
      // Enrich from openclaw.json
      const jsonAgent = openclawJson.agents.find((a) => a.id === agent.id);
      if (jsonAgent) {
        // Prefer openclaw.json model (more structured)
        if (jsonAgent.model) {
          agent.model = reverseMapModel(jsonAgent.model, providerNames);
        }
        // Fallback chain
        if (jsonAgent.fallbacks && jsonAgent.fallbacks.length > 0) {
          agent.fallbackChain = jsonAgent.fallbacks.map((m) =>
            reverseMapModel(m, providerNames),
          );
        }
      }
      // If model wasn't in openclaw.json, still reverse-map the AGENTS.md model
      if (agent.model && !openclawJson.agents.find((a) => a.id === agent.id)?.model) {
        agent.model = reverseMapModel(agent.model, providerNames);
      }
    }
  }

  // Match agent roles to role keys if they match role descriptions
  const roles = soulResult?.roles ?? {};
  for (const agent of agents) {
    if (agent.role) {
      // Check if agent.role text matches a role description — if so, use the role key
      for (const [key, desc] of Object.entries(roles)) {
        if (agent.role === desc) {
          agent.role = key;
          break;
        }
      }
    }
  }

  // Build providers — reverse-map model IDs in provider model lists
  const providers = openclawJson?.providers ?? [];
  for (const provider of providers) {
    provider.models = provider.models.map((m) =>
      reverseMapModel(m, providerNames),
    );
    // Mark default provider
    if (openclawJson?.defaultModel) {
      const defaultModelProvider = openclawJson.defaultModel.split("/")[0];
      if (defaultModelProvider === provider.name) {
        provider.default = true;
      }
    }
  }

  // Build nodes array
  const nodes: NodeDef[] = [
    ...agents,
    ...(agentsResult?.groups ?? []),
    ...(agentsResult?.humans ?? []),
    ...(agentsResult?.gates ?? []),
  ];

  // Build topology meta
  const topology: TopologyMeta = {
    name: soulResult?.name ?? topologyName,
    version: soulResult?.version ?? "1.0.0",
    description: soulResult?.description ?? "",
    patterns: soulResult?.patterns ?? [],
    domain: soulResult?.domain,
    timeout: soulResult?.timeout,
    durable: soulResult?.durable,
    errorHandler: soulResult?.errorHandler,
  };

  // Env — merge from SOUL.md and openclaw.json (SOUL.md takes priority)
  const env: Record<string, string> = {
    ...(openclawJson?.env ?? {}),
    ...(soulResult?.env ?? {}),
  };

  // Settings
  const settings: Record<string, unknown> = {};
  if (openclawJson?.settings.allow?.length) {
    settings.allow = openclawJson.settings.allow;
  }
  if (openclawJson?.settings.deny?.length) {
    settings.deny = openclawJson.settings.deny;
  }

  // Schedules — prefer AGENTS.md, fallback to cron/jobs.json
  const schedules = (agentsResult?.schedules?.length ?? 0) > 0
    ? agentsResult!.schedules
    : cronJobs;

  // Extensions
  const extensions: Record<string, Record<string, unknown>> | undefined =
    openclawJson?.extensions && Object.keys(openclawJson.extensions).length > 0
      ? { openclaw: openclawJson.extensions }
      : undefined;

  return {
    topology,
    nodes,
    edges: agentsResult?.edges ?? [],
    depth: { factors: [], levels: [] },
    memory: memoryResult?.memory ?? {},
    stores: [],
    retrievals: [],
    batch: {},
    environments: {},
    triggers: soulResult?.triggers ?? [],
    hooks: agentsResult?.hooks ?? [],
    settings,
    mcpServers: {},
    metering: agentsResult?.metering ?? null,
    skills,
    toolDefs: [],
    roles,
    context: {},
    env,
    providers,
    schedules,
    interfaces: [],
    defaults: null,
    schemas: [],
    extensions,
    observability: null,
    params: soulResult?.params ?? [],
    interfaceEndpoints: soulResult?.interfaceEndpoints ?? null,
    imports: [],
    includes: [],
    checkpoint: null,
    artifacts: [],
  };
}
