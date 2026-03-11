/**
 * AgentTopology parser.
 *
 * Takes the raw text of an `.at` file and produces a fully-typed
 * {@link TopologyAST}. Individual section parsers are also exported for
 * advanced / incremental use.
 *
 * ```ts
 * import { parse } from "./parser";
 * const ast = parse(source);
 * ```
 *
 * @module
 */

import type {
  TopologyAST,
  TopologyMeta,
  OrchestratorNode,
  ActionNode,
  AgentNode,
  GateNode,
  NodeDef,
  EdgeDef,
  DepthDef,
  DepthLevel,
  TriggerDef,
  HookDef,
  SkillDef,
  ToolBlockDef,
  MeteringDef,
  ScaleDef,
} from "./ast.js";

import {
  stripComments,
  extractBlock,
  extractAllBlocks,
  parseKV,
  parseList,
  parseMultilineList,
  unquote,
  parseFields,
  parseOutputsBlock,
} from "./lexer.js";

// Re-export AST types for convenience
export type * from "./ast.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a kebab-case or snake_case identifier to a Title Case label. */
function toLabel(id: string): string {
  return id
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// ---------------------------------------------------------------------------
// Section parsers
// ---------------------------------------------------------------------------

/**
 * Parse the topology header line.
 *
 * Expects `topology <name> : [pattern, ...] {` somewhere in the source.
 *
 * @throws If no topology header is found.
 */
export function parseTopologyHeader(src: string): {
  name: string;
  patterns: string[];
} {
  const m = src.match(
    /topology\s+(\S+)\s*:\s*\[([^\]]*)\]\s*\{/
  );
  if (!m) throw new Error("Could not find topology header");
  return {
    name: m[1],
    patterns: m[2]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

/**
 * Parse the `meta { ... }` block.
 *
 * Extracts version, description, foundations, and advanced fields.
 */
export function parseMeta(body: string): Partial<TopologyMeta> {
  const fields = parseFields(body);
  const result: Partial<TopologyMeta> = {};
  if (fields.version) result.version = unquote(fields.version);
  if (fields.description) result.description = unquote(fields.description);

  const foundations = parseMultilineList(body, "foundations");
  if (foundations.length) result.foundations = foundations;

  const advanced = parseMultilineList(body, "advanced");
  if (advanced.length) result.advanced = advanced;

  return result;
}

/**
 * Parse the `orchestrator { ... }` block into an {@link OrchestratorNode}.
 */
export function parseOrchestrator(body: string): OrchestratorNode {
  const fields = parseFields(body);
  const handles = parseMultilineList(body, "handles");
  const outputs = parseOutputsBlock(body);

  const node: OrchestratorNode = {
    id: "orchestrator",
    type: "orchestrator",
    label: "Orchestrator",
    model: fields.model ?? "unknown",
    handles,
  };
  if (fields.generates) node.generates = unquote(fields.generates);
  if (outputs) node.outputs = outputs;
  return node;
}

/**
 * Parse the `roles { ... }` block into a map of role name to description.
 */
export function parseRoles(body: string): Record<string, string> {
  const roles: Record<string, string> = {};
  for (const line of body.split("\n")) {
    const m = line.match(/^\s*([a-zA-Z_-]+)\s*:\s*"(.+?)"\s*$/);
    if (m) roles[m[1]] = m[2];
  }
  return roles;
}

/**
 * Parse an `action <id> { ... }` block into an {@link ActionNode}.
 */
export function parseAction(id: string, body: string): ActionNode {
  const fields = parseFields(body);
  const commands = parseMultilineList(body, "commands");

  const node: ActionNode = {
    id,
    type: "action",
    label: toLabel(id),
  };
  if (fields.kind) node.kind = fields.kind;
  if (fields.source) node.source = unquote(fields.source);
  if (fields.description) node.description = unquote(fields.description);
  if (commands.length) node.commands = commands;
  return node;
}

/**
 * Parse an `agent <id> { ... }` block into an {@link AgentNode}.
 *
 * @param id    - The agent identifier from the block header.
 * @param body  - The block body (between braces).
 * @param roles - Role descriptions from the `roles` block, used to attach a
 *                role description to matching agents.
 */
export function parseAgent(
  id: string,
  body: string,
  roles: Record<string, string>
): AgentNode {
  const fields = parseFields(body);
  const tools = parseMultilineList(body, "tools");
  const skills = parseMultilineList(body, "skills");
  const reads = parseMultilineList(body, "reads");
  const writes = parseMultilineList(body, "writes");
  const disallowedTools = parseMultilineList(body, "disallowed-tools");
  const outputs = parseOutputsBlock(body);

  const node: AgentNode = {
    id,
    type: "agent",
    label: toLabel(id),
  };

  if (fields.phase) node.phase = parseFloat(fields.phase);
  if (fields.model) node.model = fields.model;
  if (fields.permissions) node.permissions = fields.permissions;
  if (fields.prompt) node.prompt = unquote(fields.prompt);
  if (tools.length) node.tools = tools;
  if (skills.length) node.skills = skills;
  if (reads.length) node.reads = reads;
  if (writes.length) node.writes = writes;
  if (disallowedTools.length) node.disallowedTools = disallowedTools;
  if (fields.skip) node.skip = fields.skip;
  if (fields.behavior) node.behavior = fields.behavior;
  if (fields.invocation) node.invocation = fields.invocation;
  if (fields.retry) node.retry = parseInt(fields.retry, 10);
  if (fields.isolation) node.isolation = fields.isolation;
  if (fields.background) node.background = fields.background === "true";
  const mcpServers = parseMultilineList(body, "mcp-servers");
  if (mcpServers.length) node.mcpServers = mcpServers;
  if (outputs) node.outputs = outputs;

  // Parse scale sub-block
  const scaleBlock = extractBlock(body, "scale");
  if (scaleBlock) {
    const sFields = parseFields(scaleBlock.body);
    const scale: ScaleDef = {
      mode: sFields.mode ?? "auto",
      by: sFields.by ?? "",
      min: sFields.min ? parseInt(sFields.min, 10) : 1,
      max: sFields.max ? parseInt(sFields.max, 10) : 1,
      batchSize: sFields["batch-size"]
        ? parseInt(sFields["batch-size"], 10)
        : null,
    };
    node.scale = scale;
  }

  // Parse per-agent hooks block
  const agentHooksBlock = extractBlock(body, "hooks");
  if (agentHooksBlock) {
    const agentHooks: HookDef[] = [];
    const hookBlocks = extractAllBlocks(agentHooksBlock.body, "hook");
    for (const hBlock of hookBlocks) {
      if (!hBlock.id) continue;
      const hFields = parseFields(hBlock.body);
      agentHooks.push({
        name: hBlock.id,
        on: hFields.on ?? "",
        matcher: hFields.matcher ? unquote(hFields.matcher) : "",
        run: hFields.run ? unquote(hFields.run) : "",
        ...(hFields.type ? { type: hFields.type } : {}),
        ...(hFields.timeout
          ? { timeout: parseInt(hFields.timeout, 10) }
          : {}),
      });
    }
    if (agentHooks.length > 0) node.hooks = agentHooks;
  }

  // Attach role description if available.
  // Prefer exact match, then longest prefix match.
  const exactRole = roles[id];
  if (exactRole) {
    node.role = exactRole;
  } else {
    const prefixMatches = Object.keys(roles)
      .filter((r) => id.startsWith(r))
      .sort((a, b) => b.length - a.length);
    if (prefixMatches.length > 0) node.role = roles[prefixMatches[0]];
  }

  return node;
}

/**
 * Parse a `gate <id> { ... }` block into a {@link GateNode}.
 */
export function parseGate(id: string, body: string): GateNode {
  const fields = parseFields(body);
  const checks = parseMultilineList(body, "checks");

  const node: GateNode = {
    id,
    type: "gate",
    label: toLabel(id),
  };

  if (fields.after) node.after = fields.after;
  if (fields.before) node.before = fields.before;
  if (fields.run) node.run = unquote(fields.run);
  if (checks.length) node.checks = checks;
  if (fields.retry) node.retry = parseInt(fields.retry, 10);
  if (fields["on-fail"]) node.onFail = fields["on-fail"];
  if (fields.behavior) node.behavior = fields.behavior;

  return node;
}

/**
 * Parse the `flow { ... }` block into an array of {@link EdgeDef}.
 *
 * Supports chain syntax (`a -> b -> c`), fan-out (`a -> [b, c]`), and
 * edge annotations (`[when condition, max N]`).
 */
export function parseFlow(body: string): EdgeDef[] {
  const edges: EdgeDef[] = [];

  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let condition: string | null = null;
    let maxIterations: number | null = null;
    let flowPart = trimmed;

    // Match annotation at end of line: [when ..., max N]
    // Must start with "when" or "max" to avoid matching fan-out lists.
    const bracketMatch = trimmed.match(
      /\[(when\s+.+?|max\s+\d+.*?)\]\s*$/
    );
    if (bracketMatch) {
      flowPart = trimmed.slice(0, bracketMatch.index!).trim();
      const annotation = bracketMatch[1];

      const whenMatch = annotation.match(/when\s+(.+?)(?:,\s*max|$)/);
      if (whenMatch) condition = whenMatch[1].trim();

      const maxMatch = annotation.match(/max\s+(\d+)/);
      if (maxMatch) maxIterations = parseInt(maxMatch[1], 10);
    }

    // Split on ->
    const parts = flowPart
      .split("->")
      .map((s) => s.trim())
      .filter(Boolean);

    for (let i = 0; i < parts.length - 1; i++) {
      const from = parts[i];
      const to = parts[i + 1];
      const isLastSegment = i === parts.length - 2;

      // Check for fan-out: [a, b, c]
      const fanOutMatch = to.match(/^\[([^\]]+)\]$/);
      if (fanOutMatch) {
        const targets = fanOutMatch[1].split(",").map((s) => s.trim());
        for (const target of targets) {
          edges.push({
            from,
            to: target,
            condition: isLastSegment ? condition : null,
            maxIterations: isLastSegment ? maxIterations : null,
          });
        }
      } else {
        edges.push({
          from,
          to,
          condition: isLastSegment ? condition : null,
          maxIterations: isLastSegment ? maxIterations : null,
        });
      }
    }
  }

  return edges;
}

/**
 * Parse the `depth { ... }` block.
 */
export function parseDepth(body: string): DepthDef {
  const factors = parseMultilineList(body, "factors");
  const levels: DepthLevel[] = [];

  const levelRe = /level\s+(\d+)\s+"([^"]+)"\s*\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = levelRe.exec(body)) !== null) {
    const omit = parseMultilineList(m[3], "omit");
    levels.push({
      level: parseInt(m[1], 10),
      label: m[2],
      omit,
    });
  }

  return { factors, levels };
}

/**
 * Parse the `memory { ... }` block.
 *
 * Extracts known sub-blocks (domains, references, external-docs, metrics,
 * workspace) and returns them as a nested record.
 */
export function parseMemory(body: string): Record<string, unknown> {
  const memory: Record<string, unknown> = {};

  const knownSubs = [
    "domains",
    "references",
    "external-docs",
    "metrics",
    "workspace",
  ];
  for (const name of knownSubs) {
    const block = extractBlock(body, name);
    if (!block) continue;

    const fields = parseFields(block.body);
    const entry: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      entry[k] = v.startsWith("[") ? parseList(v) : unquote(v);
    }

    // Check for multiline lists
    for (const key of ["blueprints", "files", "structure"]) {
      const list = parseMultilineList(block.body, key);
      if (list.length) entry[key] = list;
    }

    memory[name] = entry;
  }

  return memory;
}

/**
 * Parse the `batch { ... }` block.
 */
export function parseBatch(body: string): Record<string, unknown> {
  const fields = parseFields(body);
  const result: Record<string, unknown> = {};

  if (fields.parallel) result.parallel = fields.parallel === "true";
  if (fields.per) result.per = fields.per;
  if (fields.workspace) result.workspace = unquote(fields.workspace);

  // Parse conflicts sub-block
  const conflictsBlock = extractBlock(body, "conflicts");
  if (conflictsBlock) {
    const cFields = parseFields(conflictsBlock.body);
    const detect = parseMultilineList(conflictsBlock.body, "detect");
    result.conflicts = {
      detect,
      resolve: cFields.resolve ?? null,
    };
  }

  return result;
}

/**
 * Parse the `environments { ... }` block.
 *
 * Extracts named environment sub-blocks. Handles any environment name,
 * not just "staging" and "production".
 */
export function parseEnvironments(
  body: string
): Record<string, Record<string, unknown>> {
  const envs: Record<string, Record<string, unknown>> = {};

  // Extract all named sub-blocks generically
  const re = /(?:^|\n)\s*([a-zA-Z][a-zA-Z0-9_-]*)\s*\{/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const envName = m[1];
    const startIdx = m.index! + m[0].length;
    let depth = 1;
    let i = startIdx;
    while (i < body.length && depth > 0) {
      if (body[i] === "{") depth++;
      else if (body[i] === "}") depth--;
      i++;
    }
    if (depth === 0) {
      const innerBody = body.slice(startIdx, i - 1);
      const fields = parseFields(innerBody);
      const env: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(fields)) {
        env[k] = unquote(v);
      }
      envs[envName] = env;
    }
  }

  return envs;
}

/**
 * Parse the `triggers { ... }` block.
 */
export function parseTriggers(body: string): TriggerDef[] {
  const triggers: TriggerDef[] = [];
  const cmdBlocks = extractAllBlocks(body, "command");
  for (const block of cmdBlocks) {
    if (!block.id) continue;
    const fields = parseFields(block.body);
    const trigger: TriggerDef = {
      name: block.id,
      pattern: fields.pattern ? unquote(fields.pattern) : "",
    };
    if (fields.argument) trigger.argument = fields.argument;
    triggers.push(trigger);
  }
  return triggers;
}

/**
 * Parse the global `hooks { ... }` block.
 */
export function parseHooks(body: string): HookDef[] {
  const hooks: HookDef[] = [];
  const hookBlocks = extractAllBlocks(body, "hook");
  for (const block of hookBlocks) {
    if (!block.id) continue;
    const fields = parseFields(block.body);
    hooks.push({
      name: block.id,
      on: fields.on ?? "",
      matcher: fields.matcher ? unquote(fields.matcher) : "",
      run: fields.run ? unquote(fields.run) : "",
      ...(fields.type ? { type: fields.type } : {}),
      ...(fields.timeout
        ? { timeout: parseInt(fields.timeout, 10) }
        : {}),
    });
  }
  return hooks;
}

/**
 * Parse the `settings { ... }` block.
 */
export function parseSettings(body: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of ["allow", "deny", "ask"]) {
    const list = parseMultilineList(body, key);
    result[key] = list;
  }
  return result;
}

/**
 * Parse the `metering { ... }` block.
 */
export function parseMetering(body: string): MeteringDef | null {
  const fields = parseFields(body);
  const track = parseMultilineList(body, "track");
  const per = parseMultilineList(body, "per");

  if (track.length === 0 && !fields.output) return null;

  return {
    track,
    per,
    output: fields.output ? unquote(fields.output) : "",
    format: fields.format ?? "",
    pricing: fields.pricing ?? "",
  };
}

/**
 * Parse the `mcp-servers { ... }` block.
 */
export function parseMcpServers(
  body: string
): Record<string, Record<string, unknown>> {
  const servers: Record<string, Record<string, unknown>> = {};

  const re = /(?:^|\n)\s*([a-zA-Z][a-zA-Z0-9_-]*)\s*\{/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const name = m[1];
    const startIdx = m.index! + m[0].length;
    let depth = 1;
    let i = startIdx;
    while (i < body.length && depth > 0) {
      if (body[i] === "{") depth++;
      else if (body[i] === "}") depth--;
      i++;
    }
    if (depth === 0) {
      const innerBody = body.slice(startIdx, i - 1);
      const fields = parseFields(innerBody);
      const server: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(fields)) {
        server[k] = unquote(v);
      }
      const args = parseMultilineList(innerBody, "args");
      if (args.length) server.args = args;
      servers[name] = server;
    }
  }

  return servers;
}

/**
 * Parse `skill <id> { ... }` blocks.
 */
export function parseSkillBlocks(topBody: string): SkillDef[] {
  const skillBlocks = extractAllBlocks(topBody, "skill");
  const skillDefs: SkillDef[] = [];
  for (const block of skillBlocks) {
    if (!block.id) continue;
    const sFields = parseFields(block.body);
    const sd: SkillDef = {
      id: block.id,
      description: sFields.description ? unquote(sFields.description) : "",
    };
    const scripts = parseMultilineList(block.body, "scripts");
    const domains = parseMultilineList(block.body, "domains");
    const references = parseMultilineList(block.body, "references");
    if (scripts.length) sd.scripts = scripts;
    if (domains.length) sd.domains = domains;
    if (references.length) sd.references = references;
    if (sFields.prompt) sd.prompt = unquote(sFields.prompt);
    skillDefs.push(sd);
  }
  return skillDefs;
}

/**
 * Parse the top-level `tools { ... }` block containing `tool <id> { ... }` sub-blocks.
 */
export function parseToolsBlock(topBody: string): ToolBlockDef[] {
  const toolsBlock = extractBlock(topBody, "tools");
  const toolDefs: ToolBlockDef[] = [];
  if (!toolsBlock) return toolDefs;

  const toolBlocks = extractAllBlocks(toolsBlock.body, "tool");
  for (const block of toolBlocks) {
    if (!block.id) continue;
    const tFields = parseFields(block.body);
    const td: ToolBlockDef = {
      id: block.id,
      script: tFields.script ? unquote(tFields.script) : "",
      description: tFields.description ? unquote(tFields.description) : "",
    };
    const args = parseMultilineList(block.body, "args");
    if (args.length) td.args = args;
    if (tFields.lang) td.lang = tFields.lang;
    toolDefs.push(td);
  }
  return toolDefs;
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

/**
 * Parse an AgentTopology `.at` source string into a complete {@link TopologyAST}.
 *
 * @param source - The raw `.at` file content.
 * @returns The fully-parsed AST.
 * @throws If the topology header or body cannot be extracted.
 */
export function parse(source: string): TopologyAST {
  const src = stripComments(source);

  // --- Topology header ---
  // Use raw source to preserve the topology line (comments already on other lines)
  const header = parseTopologyHeader(source);

  // --- Extract the full topology body ---
  const topoBlock = extractBlock(source, "topology");
  if (!topoBlock) {
    throw new Error("Could not extract topology body");
  }
  const topBody = stripComments(topoBlock.body);

  // --- Meta ---
  const metaBlock = extractBlock(topBody, "meta");
  const metaFields = metaBlock ? parseMeta(metaBlock.body) : {};

  const topology: TopologyMeta = {
    name: header.name,
    version: metaFields.version ?? "0.0.0",
    description: metaFields.description ?? "",
    patterns: header.patterns,
    ...(metaFields.foundations ? { foundations: metaFields.foundations } : {}),
    ...(metaFields.advanced ? { advanced: metaFields.advanced } : {}),
  };

  // --- Roles ---
  const rolesBlock = extractBlock(topBody, "roles");
  const roles = rolesBlock ? parseRoles(rolesBlock.body) : {};

  // --- Nodes ---
  const nodes: NodeDef[] = [];

  // Orchestrator
  const orchBlock = extractBlock(topBody, "orchestrator");
  if (orchBlock) {
    nodes.push(parseOrchestrator(orchBlock.body));
  }

  // Actions
  const actionBlocks = extractAllBlocks(topBody, "action");
  for (const block of actionBlocks) {
    if (block.id) {
      nodes.push(parseAction(block.id, block.body));
    }
  }

  // Agents
  const agentBlocks = extractAllBlocks(topBody, "agent");
  for (const block of agentBlocks) {
    if (block.id) {
      nodes.push(parseAgent(block.id, block.body, roles));
    }
  }

  // Gates
  const gatesBlock = extractBlock(topBody, "gates");
  if (gatesBlock) {
    const gateBlocks = extractAllBlocks(gatesBlock.body, "gate");
    for (const block of gateBlocks) {
      if (block.id) {
        nodes.push(parseGate(block.id, block.body));
      }
    }
  }

  // --- Skills ---
  const skillDefs = parseSkillBlocks(topBody);

  // --- Tools ---
  const toolDefs = parseToolsBlock(topBody);

  // --- Edges (flow) ---
  const flowBlock = extractBlock(topBody, "flow");
  const edges = flowBlock ? parseFlow(flowBlock.body) : [];

  // --- Depth ---
  const depthBlock = extractBlock(topBody, "depth");
  const depth = depthBlock
    ? parseDepth(depthBlock.body)
    : { factors: [], levels: [] };

  // --- Memory ---
  const memoryBlock = extractBlock(topBody, "memory");
  const memory = memoryBlock ? parseMemory(memoryBlock.body) : {};

  // --- Batch ---
  const batchBlock = extractBlock(topBody, "batch");
  const batch = batchBlock ? parseBatch(batchBlock.body) : {};

  // --- Environments ---
  const envsBlock = extractBlock(topBody, "environments");
  const environments = envsBlock
    ? parseEnvironments(envsBlock.body)
    : {};

  // --- Triggers ---
  const triggersBlock = extractBlock(topBody, "triggers");
  const triggers = triggersBlock
    ? parseTriggers(triggersBlock.body)
    : [];

  // --- Hooks (global) ---
  // Collect per-agent hook names to avoid double-counting them as global.
  const perAgentHookNames = new Set<string>();
  for (const n of nodes) {
    if (n.type === "agent" && n.hooks) {
      for (const h of n.hooks) {
        perAgentHookNames.add(h.name);
      }
    }
  }
  const allHooksBlocks = extractAllBlocks(topBody, "hooks");
  let hooks: HookDef[] = [];
  for (const hb of allHooksBlocks) {
    const parsed = parseHooks(hb.body);
    const globalOnly = parsed.filter((h) => !perAgentHookNames.has(h.name));
    if (globalOnly.length > 0) {
      hooks = globalOnly;
      break;
    }
  }
  if (hooks.length === 0 && allHooksBlocks.length > 1) {
    const lastBlock = allHooksBlocks[allHooksBlocks.length - 1];
    hooks = parseHooks(lastBlock.body);
  }

  // --- Settings ---
  const settingsBlock = extractBlock(topBody, "settings");
  const settings = settingsBlock
    ? parseSettings(settingsBlock.body)
    : {};

  // --- MCP Servers ---
  const mcpBlock = extractBlock(topBody, "mcp-servers");
  const mcpServers = mcpBlock ? parseMcpServers(mcpBlock.body) : {};

  // --- Metering ---
  const meteringBlock = extractBlock(topBody, "metering");
  const metering = meteringBlock
    ? parseMetering(meteringBlock.body)
    : null;

  // --- Assemble AST ---
  return {
    topology,
    nodes,
    edges,
    depth,
    memory,
    batch,
    environments,
    triggers,
    hooks,
    settings,
    mcpServers,
    metering,
    skills: skillDefs,
    toolDefs,
    roles,
  };
}
