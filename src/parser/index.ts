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
  HumanNode,
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
  ProviderDef,
  ScheduleJobDef,
  InterfaceDef,
  RetryConfig,
  CircuitBreakerConfig,
  DefaultsDef,
  SchemaType,
  SchemaFieldDef,
  SchemaDef,
  SensitiveValue,
  SecretRef,
  ObservabilityDef,
  ObservabilityCaptureConfig,
  ObservabilitySpanConfig,
  ParamDef,
  InterfaceEndpoints,
  ImportDef,
  IncludeDef,
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
  dedentBlock,
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

/**
 * Parse an `extensions { binding-name { key: value } }` sub-block.
 *
 * Each named sub-block inside `extensions` becomes a key in the returned
 * record, with its key-value pairs parsed via {@link parseFields}.
 */
function parseExtensionsBlock(block: string): Record<string, Record<string, unknown>> | undefined {
  const extBlock = extractBlock(block, "extensions");
  if (!extBlock) return undefined;

  const result: Record<string, Record<string, unknown>> = {};

  // Extract each named sub-block inside extensions
  const re = /(?:^|\n)\s*([a-zA-Z][a-zA-Z0-9_-]*)\s*\{/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(extBlock.body)) !== null) {
    const name = m[1];
    const startIdx = m.index! + m[0].length;
    let depth = 1;
    let i = startIdx;
    while (i < extBlock.body.length && depth > 0) {
      if (extBlock.body[i] === "{") depth++;
      else if (extBlock.body[i] === "}") depth--;
      i++;
    }
    if (depth === 0) {
      const innerBody = extBlock.body.slice(startIdx, i - 1);
      const fields = parseFields(innerBody);
      const entry: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(fields)) {
        // Try to parse booleans and numbers
        if (v === "true") entry[k] = true;
        else if (v === "false") entry[k] = false;
        else if (/^\d+$/.test(v)) entry[k] = parseInt(v, 10);
        else entry[k] = unquote(v);
      }
      result[name] = entry;
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

// ---------------------------------------------------------------------------
// Schema parsing
// ---------------------------------------------------------------------------

/** Known primitive type names for the schema type system. */
const SCHEMA_PRIMITIVES = new Set(["string", "number", "integer", "boolean", "object"]);

/**
 * Parse a type expression string into a {@link SchemaType}.
 *
 * Supports:
 * - Primitives: `"string"`, `"number"`, `"integer"`, `"boolean"`, `"object"`
 * - Arrays: `"array of string"`, `"array of finding"`
 * - Enums: `"low | medium | high"`
 * - References: any non-primitive identifier like `"finding"`
 */
export function parseSchemaType(typeStr: string): SchemaType {
  const trimmed = typeStr.trim();

  // Enum: contains ` | ` separator
  if (trimmed.includes("|")) {
    const values = trimmed.split("|").map((v) => v.trim()).filter(Boolean);
    return { kind: "enum", values };
  }

  // Array: "array of <type>"
  const arrayMatch = trimmed.match(/^array\s+of\s+(.+)$/i);
  if (arrayMatch) {
    return { kind: "array", itemType: parseSchemaType(arrayMatch[1]) };
  }

  // Primitive
  if (SCHEMA_PRIMITIVES.has(trimmed)) {
    return { kind: "primitive", value: trimmed as SchemaType & { kind: "primitive" } extends { value: infer V } ? V : never };
  }

  // Reference to a named schema
  return { kind: "ref", name: trimmed };
}

/**
 * Parse a block body of `name: type-expression` lines into schema field definitions.
 *
 * Each line is parsed as a KV pair. A leading `?` on the type expression marks
 * the field as optional.
 */
export function parseSchemaFields(body: string): SchemaFieldDef[] {
  const fields: SchemaFieldDef[] = [];

  for (const line of body.split("\n")) {
    const kv = parseKV(line);
    if (!kv) continue;

    const [name, rawType] = kv;
    let typeStr = rawType.trim();
    let optional = false;

    if (typeStr.startsWith("?")) {
      optional = true;
      typeStr = typeStr.slice(1).trim();
    }

    fields.push({
      name,
      type: parseSchemaType(typeStr),
      optional,
    });
  }

  return fields;
}

/**
 * Parse the top-level `schemas { schema <id> { ... } ... }` block.
 *
 * Returns an array of named schema definitions.
 */
export function parseSchemas(topBody: string): SchemaDef[] {
  const schemasBlock = extractBlock(topBody, "schemas");
  if (!schemasBlock) return [];

  const schemaBlocks = extractAllBlocks(schemasBlock.body, "schema");
  const schemas: SchemaDef[] = [];

  for (const block of schemaBlocks) {
    if (!block.id) continue;
    schemas.push({
      id: block.id,
      fields: parseSchemaFields(block.body),
    });
  }

  return schemas;
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
  if (fields.domain) result.domain = fields.domain;

  const foundations = parseMultilineList(body, "foundations");
  if (foundations.length) result.foundations = foundations;

  const advanced = parseMultilineList(body, "advanced");
  if (advanced.length) result.advanced = advanced;

  if (fields.timeout) result.timeout = fields.timeout;
  if (fields["error-handler"]) result.errorHandler = fields["error-handler"];

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
  if (fields.timeout) node.timeout = fields.timeout;
  if (fields["on-fail"]) node.onFail = fields["on-fail"];
  if (fields.join) node.join = fields.join;
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

  // Extract prompt from prompt {} block (not KV pair)
  const promptBlock = extractBlock(body, "prompt");
  if (promptBlock) {
    node.prompt = dedentBlock(promptBlock.body);
  }

  if (tools.length) node.tools = tools;
  if (skills.length) node.skills = skills;
  if (reads.length) node.reads = reads;
  if (writes.length) node.writes = writes;
  if (disallowedTools.length) node.disallowedTools = disallowedTools;
  if (fields.skip) node.skip = fields.skip;
  if (fields.behavior) node.behavior = fields.behavior;
  if (fields.invocation) node.invocation = fields.invocation;

  // Retry: support both simple number and structured block form
  const retryBlock = extractBlock(body, "retry");
  if (retryBlock) {
    const rFields = parseFields(retryBlock.body);
    const retryConfig: RetryConfig = {
      max: rFields.max ? parseInt(rFields.max, 10) : 1,
    };
    if (rFields.backoff) retryConfig.backoff = rFields.backoff as RetryConfig["backoff"];
    if (rFields.interval) retryConfig.interval = rFields.interval;
    if (rFields["max-interval"]) retryConfig.maxInterval = rFields["max-interval"];
    if (rFields.jitter) retryConfig.jitter = rFields.jitter === "true";
    const nonRetryable = parseMultilineList(retryBlock.body, "non-retryable");
    if (nonRetryable.length) retryConfig.nonRetryable = nonRetryable;
    node.retry = retryConfig;
  } else if (fields.retry) {
    node.retry = parseInt(fields.retry, 10);
  }

  // Timeout
  if (fields.timeout) node.timeout = fields.timeout;

  // On-fail
  if (fields["on-fail"]) node.onFail = fields["on-fail"];

  // Sampling parameters
  if (fields.temperature) node.temperature = parseFloat(fields.temperature);
  if (fields["max-tokens"]) node.maxTokens = parseInt(fields["max-tokens"], 10);
  if (fields["top-p"]) node.topP = parseFloat(fields["top-p"]);
  if (fields["top-k"]) node.topK = parseInt(fields["top-k"], 10);
  const stop = parseMultilineList(body, "stop");
  if (stop.length) node.stop = stop;
  if (fields.seed) node.seed = parseInt(fields.seed, 10);

  // Thinking
  if (fields.thinking) node.thinking = fields.thinking;
  if (fields["thinking-budget"]) node.thinkingBudget = parseInt(fields["thinking-budget"], 10);

  // Output format
  if (fields["output-format"]) node.outputFormat = fields["output-format"];

  // Log level
  if (fields["log-level"]) node.logLevel = fields["log-level"];

  // Join semantics
  if (fields.join) node.join = fields.join;

  // Circuit breaker
  const cbBlock = extractBlock(body, "circuit-breaker");
  if (cbBlock) {
    const cbFields = parseFields(cbBlock.body);
    const cb: CircuitBreakerConfig = {
      threshold: cbFields.threshold ? parseInt(cbFields.threshold, 10) : 1,
      window: cbFields.window ?? "1m",
      cooldown: cbFields.cooldown ?? "30s",
    };
    node.circuitBreaker = cb;
  }

  // Compensation / saga
  if (fields.compensates) node.compensates = fields.compensates;

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
      const agentHook: HookDef = {
        name: hBlock.id,
        on: hFields.on ?? "",
        matcher: hFields.matcher ? unquote(hFields.matcher) : "",
        run: hFields.run ? unquote(hFields.run) : "",
        ...(hFields.type ? { type: hFields.type } : {}),
        ...(hFields.timeout
          ? { timeout: parseInt(hFields.timeout, 10) }
          : {}),
      };

      // Parse extensions sub-block inside per-agent hook
      const hookExtensions = parseExtensionsBlock(hBlock.body);
      if (hookExtensions) agentHook.extensions = hookExtensions;

      agentHooks.push(agentHook);
    }
    if (agentHooks.length > 0) node.hooks = agentHooks;
  }

  // Sandbox override
  if (fields.sandbox) {
    const sv = fields.sandbox;
    if (sv === "true") node.sandbox = true;
    else if (sv === "false") node.sandbox = false;
    else node.sandbox = sv;
  }

  // Fallback chain
  const fallbackChain = parseMultilineList(body, "fallback-chain");
  if (fallbackChain.length) node.fallbackChain = fallbackChain;

  // Input/output schema blocks
  const inputSchemaBlock = extractBlock(body, "input-schema");
  if (inputSchemaBlock) {
    node.inputSchema = parseSchemaFields(inputSchemaBlock.body);
  }
  const outputSchemaBlock = extractBlock(body, "output-schema");
  if (outputSchemaBlock) {
    node.outputSchema = parseSchemaFields(outputSchemaBlock.body);
  }

  // New fields: description, max-turns, extensions
  if (fields.description) node.description = unquote(fields.description);
  if (fields["max-turns"]) node.maxTurns = parseInt(fields["max-turns"], 10);
  const extensions = parseExtensionsBlock(body);
  if (extensions) node.extensions = extensions;

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
  if (fields.timeout) node.timeout = fields.timeout;

  const extensions = parseExtensionsBlock(body);
  if (extensions) node.extensions = extensions;

  return node;
}

/**
 * Parse a `human <id> { ... }` block into a {@link HumanNode}.
 */
export function parseHuman(id: string, body: string): HumanNode {
  const fields = parseFields(body);

  const node: HumanNode = {
    id,
    type: "human",
    label: toLabel(id),
  };

  if (fields.description) node.description = unquote(fields.description);
  if (fields.timeout) node.timeout = fields.timeout;
  if (fields["on-timeout"]) node.onTimeout = fields["on-timeout"];

  return node;
}

/**
 * Parse the `flow { ... }` block into an array of {@link EdgeDef}.
 *
 * Supports chain syntax (`a -> b -> c`), fan-out (`a -> [b, c]`),
 * error edges (`-x->`, `-x[type]->`), and edge annotations
 * (`[when condition, max N, tolerance: N, race, wait 30s]`).
 */
export function parseFlow(body: string, _edgeAttributeErrors?: Array<{ rule: string; level: "error" | "warning"; message: string; node?: string }>): EdgeDef[] {
  const edges: EdgeDef[] = [];

  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let condition: string | null = null;
    let maxIterations: number | null = null;
    let per: string | null = null;
    let tolerance: number | string | undefined;
    let race: boolean | undefined;
    let wait: string | undefined;
    let flowPart = trimmed;

    // Match annotation at end of line: [when ..., max N, per agent-id, tolerance: N, race, wait 30s]
    // Must start with "when", "max", "per", "tolerance", "race", "wait", or "join" to avoid matching fan-out lists.
    const bracketMatch = trimmed.match(
      /\[(when\s+.+?|max\s+\d+.*?|per\s+\S+.*?|tolerance\s*:.+?|race.*?|wait\s+\S+.*?|join\s+\S+.*?)\]\s*$/
    );
    if (bracketMatch) {
      flowPart = trimmed.slice(0, bracketMatch.index!).trim();
      const annotation = bracketMatch[1];

      // V12: Detect wrong attribute order — "max" before "when"
      const maxIdx = annotation.search(/\bmax\s+\d+/);
      const whenIdx = annotation.search(/\bwhen\s+/);
      if (maxIdx !== -1 && whenIdx !== -1 && maxIdx < whenIdx && _edgeAttributeErrors) {
        _edgeAttributeErrors.push({
          rule: "V12",
          level: "error",
          message: `Edge annotation has wrong attribute order: "max" before "when" — expected [when ..., max N] (line: ${trimmed})`,
        });
      }

      const whenMatch = annotation.match(/when\s+(.+?)(?:,\s*(?:max|per|tolerance|race|wait)|$)/);
      if (whenMatch) condition = whenMatch[1].trim();

      const maxMatch = annotation.match(/max\s+(\d+)/);
      if (maxMatch) maxIterations = parseInt(maxMatch[1], 10);

      const perMatch = annotation.match(/per\s+(\S+)/);
      if (perMatch) per = perMatch[1].replace(/,\s*$/, "");

      // tolerance: N or tolerance: 33%
      const toleranceMatch = annotation.match(/tolerance\s*:\s*(\d+%?)/);
      if (toleranceMatch) {
        const tolVal = toleranceMatch[1];
        tolerance = tolVal.endsWith("%") ? tolVal : parseInt(tolVal, 10);
      }

      // race
      if (/\brace\b/.test(annotation)) {
        race = true;
      }

      // wait 30s
      const waitMatch = annotation.match(/wait\s+(\d+[smhd])/);
      if (waitMatch) {
        wait = waitMatch[1];
      }
    }

    // Handle error edges: replace -x-> and -x[type]-> with a parseable form.
    // We use a sentinel to mark error edge segments.
    // -x[type]-> becomes __ERROR_EDGE_type__ ->
    // -x-> becomes __ERROR_EDGE__ ->
    interface SegmentInfo {
      text: string;
      isError: boolean;
      errorType?: string;
    }

    // Split the flow part into segments, handling error edge arrows.
    // We need to split on both -> and -x-> / -x[type]->.
    // Strategy: use regex to split on arrow patterns, tracking which type each is.
    const segments: SegmentInfo[] = [];
    const arrowPattern = /-x\[([^\]]+)\]->|-x->|->/g;
    let lastIndex = 0;
    let arrowMatch: RegExpExecArray | null;
    const arrowTypes: Array<{ isError: boolean; errorType?: string }> = [];

    // Reset lastIndex
    arrowPattern.lastIndex = 0;
    while ((arrowMatch = arrowPattern.exec(flowPart)) !== null) {
      const before = flowPart.slice(lastIndex, arrowMatch.index).trim();
      if (before) {
        segments.push({ text: before, isError: false });
      }

      if (arrowMatch[0].startsWith("-x")) {
        // Error edge
        if (arrowMatch[1]) {
          // -x[type]->
          arrowTypes.push({ isError: true, errorType: arrowMatch[1] });
        } else {
          // -x->
          arrowTypes.push({ isError: true });
        }
      } else {
        // Normal ->
        arrowTypes.push({ isError: false });
      }

      lastIndex = arrowMatch.index + arrowMatch[0].length;
    }
    // Remaining text after last arrow
    const remaining = flowPart.slice(lastIndex).trim();
    if (remaining) {
      segments.push({ text: remaining, isError: false });
    }

    // Now segments[i] and arrowTypes[i] give us: segments[i] --arrowTypes[i]--> segments[i+1]
    for (let i = 0; i < segments.length - 1; i++) {
      const from = segments[i].text;
      const to = segments[i + 1].text;
      const arrow = arrowTypes[i];
      const isLastSegment = i === segments.length - 2;

      // Check for fan-out: [a, b, c]
      const fanOutMatch = to.match(/^\[([^\]]+)\]$/);

      // Build base edge properties
      const baseEdge: Partial<EdgeDef> = {
        condition: isLastSegment ? condition : null,
        maxIterations: isLastSegment ? maxIterations : null,
        per: isLastSegment ? per : null,
      };
      if (arrow.isError) {
        baseEdge.isError = true;
        if (arrow.errorType) baseEdge.errorType = arrow.errorType;
      }
      if (isLastSegment && tolerance !== undefined) baseEdge.tolerance = tolerance;
      if (isLastSegment && race) baseEdge.race = true;
      if (isLastSegment && wait) baseEdge.wait = wait;

      if (fanOutMatch) {
        const targets = fanOutMatch[1].split(",").map((s) => s.trim());
        for (const target of targets) {
          edges.push({
            from,
            to: target,
            condition: baseEdge.condition ?? null,
            maxIterations: baseEdge.maxIterations ?? null,
            per: baseEdge.per ?? null,
            ...(baseEdge.isError ? { isError: true } : {}),
            ...(baseEdge.errorType ? { errorType: baseEdge.errorType } : {}),
            ...(baseEdge.tolerance !== undefined ? { tolerance: baseEdge.tolerance } : {}),
            ...(baseEdge.race ? { race: true } : {}),
            ...(baseEdge.wait ? { wait: baseEdge.wait } : {}),
          });
        }
      } else {
        edges.push({
          from,
          to,
          condition: baseEdge.condition ?? null,
          maxIterations: baseEdge.maxIterations ?? null,
          per: baseEdge.per ?? null,
          ...(baseEdge.isError ? { isError: true } : {}),
          ...(baseEdge.errorType ? { errorType: baseEdge.errorType } : {}),
          ...(baseEdge.tolerance !== undefined ? { tolerance: baseEdge.tolerance } : {}),
          ...(baseEdge.race ? { race: true } : {}),
          ...(baseEdge.wait ? { wait: baseEdge.wait } : {}),
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
export function parseMemory(body: string, _unknownSubBlockWarnings?: Array<{ rule: string; level: "error" | "warning"; message: string; node?: string }>): Record<string, unknown> {
  const memory: Record<string, unknown> = {};

  const knownSubs = [
    "domains",
    "references",
    "external-docs",
    "metrics",
    "workspace",
  ];
  const knownSubsSet = new Set(knownSubs);

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

  // Detect unknown sub-blocks
  if (_unknownSubBlockWarnings) {
    const subBlockRe = /(?:^|\n)\s*([a-zA-Z][a-zA-Z0-9_-]*)\s*\{/gm;
    let m: RegExpExecArray | null;
    while ((m = subBlockRe.exec(body)) !== null) {
      const name = m[1];
      if (!knownSubsSet.has(name)) {
        _unknownSubBlockWarnings.push({
          rule: "V24",
          level: "warning",
          message: `Unknown sub-block "${name}" in memory block — known sub-blocks are: ${knownSubs.join(", ")}`,
        });
      }
    }
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
    const hook: HookDef = {
      name: block.id,
      on: fields.on ?? "",
      matcher: fields.matcher ? unquote(fields.matcher) : "",
      run: fields.run ? unquote(fields.run) : "",
      ...(fields.type ? { type: fields.type } : {}),
      ...(fields.timeout
        ? { timeout: parseInt(fields.timeout, 10) }
        : {}),
    };

    // Parse extensions sub-block inside hook
    const extensions = parseExtensionsBlock(block.body);
    if (extensions) hook.extensions = extensions;

    hooks.push(hook);
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

  // Sandbox setting
  const fields = parseFields(body);
  if (fields.sandbox) {
    const sv = fields.sandbox;
    if (sv === "true") result.sandbox = true;
    else if (sv === "false") result.sandbox = false;
    else result.sandbox = sv;
  }

  // Fallback chain
  const fallbackChain = parseMultilineList(body, "fallback-chain");
  if (fallbackChain.length) result.fallbackChain = fallbackChain;

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

      // Parse env sub-block (key-value pairs for environment variables)
      const envBlock = extractBlock(innerBody, "env");
      if (envBlock) {
        const envVars: Record<string, string> = {};
        for (const line of envBlock.body.split("\n")) {
          const kv = parseKV(line);
          if (kv) {
            envVars[kv[0]] = unquote(kv[1]);
          }
        }
        if (Object.keys(envVars).length > 0) {
          server.env = envVars;
        }
      }

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

    // New skill fields
    if (sFields["disable-model-invocation"]) {
      sd.disableModelInvocation = sFields["disable-model-invocation"] === "true";
    }
    if (sFields["user-invocable"]) {
      sd.userInvocable = sFields["user-invocable"] === "true";
    }
    if (sFields.context) sd.context = sFields.context;
    if (sFields.agent) sd.agent = sFields.agent;
    const allowedTools = parseMultilineList(block.body, "allowed-tools");
    if (allowedTools.length) sd.allowedTools = allowedTools;
    const skillExtensions = parseExtensionsBlock(block.body);
    if (skillExtensions) sd.extensions = skillExtensions;

    skillDefs.push(sd);
  }
  return skillDefs;
}

/**
 * Parse the `context { ... }` block.
 *
 * Returns context file configuration with optional file path and includes list.
 */
export function parseContext(body: string): { file?: string; includes?: string[] } {
  const fields = parseFields(body);
  const result: { file?: string; includes?: string[] } = {};
  if (fields.file) result.file = unquote(fields.file);
  const includes = parseMultilineList(body, "includes");
  if (includes.length) result.includes = includes;
  return result;
}

/**
 * Parse the `env { ... }` block.
 *
 * Returns a record of environment variable key-value pairs. Values may be
 * plain strings (backward compatible) or {@link SensitiveValue} objects when
 * the `sensitive` or `secret` modifier is used.
 */
export function parseEnv(body: string): Record<string, string | SensitiveValue> {
  const result: Record<string, string | SensitiveValue> = {};
  for (const line of body.split("\n")) {
    const kv = parseKV(line);
    if (kv) {
      const rawValue = kv[1].trim();

      // Check for `secret "uri"` modifier
      if (rawValue.startsWith("secret ")) {
        const uriPart = rawValue.slice("secret ".length).trim();
        const uri = unquote(uriPart);
        const schemeMatch = uri.match(/^([a-zA-Z][a-zA-Z0-9]*):\/\//);
        const scheme = schemeMatch ? schemeMatch[1] : "";
        const secretRef: SecretRef = { scheme, uri };
        result[kv[0]] = {
          value: uri,
          sensitive: true,
          secretRef,
        } satisfies SensitiveValue;
      }
      // Check for `sensitive` modifier
      else if (rawValue.startsWith("sensitive ")) {
        const innerValue = rawValue.slice("sensitive ".length).trim();
        result[kv[0]] = {
          value: unquote(innerValue),
          sensitive: true,
        } satisfies SensitiveValue;
      }
      // Plain string (backward compatible)
      else {
        result[kv[0]] = unquote(rawValue);
      }
    }
  }
  return result;
}

/**
 * Parse the `providers { ... }` block.
 *
 * Each named sub-block declares a provider with api-key, base-url, models,
 * default, and any extra fields.
 */
export function parseProviders(body: string): ProviderDef[] {
  const providers: ProviderDef[] = [];

  // Extract each named sub-block inside providers
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

      // Parse models list
      const models = parseMultilineList(innerBody, "models");

      // Collect known fields
      const knownKeys = new Set(["api-key", "base-url", "models", "default"]);
      const extra: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(fields)) {
        if (!knownKeys.has(k)) {
          if (v === "true") extra[k] = true;
          else if (v === "false") extra[k] = false;
          else if (/^\d+$/.test(v)) extra[k] = parseInt(v, 10);
          else extra[k] = unquote(v);
        }
      }

      const provider: ProviderDef = {
        name,
        models,
        extra,
      };

      if (fields["api-key"]) provider.apiKey = unquote(fields["api-key"]);
      if (fields["base-url"]) provider.baseUrl = unquote(fields["base-url"]);
      if (fields["default"]) provider.default = fields["default"] === "true";

      providers.push(provider);
    }
  }

  return providers;
}

/**
 * Parse the `schedule { ... }` block.
 *
 * Extracts `job <id> { ... }` sub-blocks within the schedule section.
 */
export function parseSchedule(body: string): ScheduleJobDef[] {
  const jobs: ScheduleJobDef[] = [];
  const jobBlocks = extractAllBlocks(body, "job");
  for (const block of jobBlocks) {
    if (!block.id) continue;
    const fields = parseFields(block.body);
    const job: ScheduleJobDef = {
      id: block.id,
      enabled: true,
    };
    if (fields.cron) job.cron = unquote(fields.cron);
    if (fields.every) job.every = unquote(fields.every);
    if (fields.agent) job.agent = fields.agent;
    if (fields.action) job.action = fields.action;
    if (fields.enabled) job.enabled = fields.enabled !== "false";
    jobs.push(job);
  }
  return jobs;
}

/**
 * Parse the `interfaces { ... }` block.
 *
 * Each named sub-block declares an interface with a `type` field and arbitrary
 * configuration. Follows the same named-sub-block pattern as {@link parseMcpServers}.
 */
export function parseInterfaces(body: string): InterfaceDef[] {
  const interfaces: InterfaceDef[] = [];

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
      const config: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(fields)) {
        if (k === "type") continue;
        if (v === "true") config[k] = true;
        else if (v === "false") config[k] = false;
        else if (/^\d+$/.test(v)) config[k] = parseInt(v, 10);
        else config[k] = unquote(v);
      }
      const iface: InterfaceDef = {
        id: name,
        config,
      };
      if (fields.type) iface.type = fields.type;
      interfaces.push(iface);
    }
  }

  return interfaces;
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

/**
 * Parse the `defaults { ... }` block.
 *
 * Extracts topology-level default values for sampling parameters and
 * shared agent configuration.
 */
export function parseDefaults(body: string): DefaultsDef | null {
  const fields = parseFields(body);
  const defaults: DefaultsDef = {};
  let hasFields = false;

  if (fields.temperature) {
    defaults.temperature = parseFloat(fields.temperature);
    hasFields = true;
  }
  if (fields["max-tokens"]) {
    defaults.maxTokens = parseInt(fields["max-tokens"], 10);
    hasFields = true;
  }
  if (fields["top-p"]) {
    defaults.topP = parseFloat(fields["top-p"]);
    hasFields = true;
  }
  if (fields["top-k"]) {
    defaults.topK = parseInt(fields["top-k"], 10);
    hasFields = true;
  }
  const stop = parseMultilineList(body, "stop");
  if (stop.length) {
    defaults.stop = stop;
    hasFields = true;
  }
  if (fields.seed) {
    defaults.seed = parseInt(fields.seed, 10);
    hasFields = true;
  }
  if (fields.thinking) {
    defaults.thinking = fields.thinking;
    hasFields = true;
  }
  if (fields["thinking-budget"]) {
    defaults.thinkingBudget = parseInt(fields["thinking-budget"], 10);
    hasFields = true;
  }
  if (fields["output-format"]) {
    defaults.outputFormat = fields["output-format"];
    hasFields = true;
  }
  if (fields.timeout) {
    defaults.timeout = fields.timeout;
    hasFields = true;
  }
  if (fields["log-level"]) {
    defaults.logLevel = fields["log-level"];
    hasFields = true;
  }

  return hasFields ? defaults : null;
}

/**
 * Parse the `observability { ... }` block.
 *
 * Extracts simple KV fields plus `capture { ... }` and `spans { ... }`
 * sub-blocks. Returns an {@link ObservabilityDef} with defaults applied
 * for any omitted fields.
 */
export function parseObservability(body: string): ObservabilityDef {
  const fields = parseFields(body);

  // Parse simple KV fields with defaults
  const enabled = fields.enabled !== undefined ? fields.enabled === "true" : true;
  const level = fields.level ?? "info";
  const exporter = fields.exporter ?? "otlp";
  const endpoint = fields.endpoint ? unquote(fields.endpoint) : undefined;
  const service = fields.service ? unquote(fields.service) : undefined;
  const sampleRate = fields["sample-rate"] !== undefined
    ? parseFloat(fields["sample-rate"])
    : 1.0;

  // Parse capture sub-block with defaults (all false)
  const captureBlock = extractBlock(body, "capture");
  const captureFields = captureBlock ? parseFields(captureBlock.body) : {};
  const capture: ObservabilityCaptureConfig = {
    prompts: captureFields.prompts === "true",
    completions: captureFields.completions === "true",
    toolArgs: (captureFields["tool-args"] ?? captureFields.toolArgs) === "true",
    toolResults: (captureFields["tool-results"] ?? captureFields.toolResults) === "true",
  };

  // Parse spans sub-block with defaults (agents/tools/gates: true, memory: false)
  const spansBlock = extractBlock(body, "spans");
  const spansFields = spansBlock ? parseFields(spansBlock.body) : {};
  const spans: ObservabilitySpanConfig = {
    agents: spansFields.agents !== undefined ? spansFields.agents === "true" : true,
    tools: spansFields.tools !== undefined ? spansFields.tools === "true" : true,
    gates: spansFields.gates !== undefined ? spansFields.gates === "true" : true,
    memory: spansFields.memory !== undefined ? spansFields.memory === "true" : false,
  };

  const def: ObservabilityDef = {
    enabled,
    level,
    exporter,
    sampleRate,
    capture,
    spans,
  };

  if (endpoint !== undefined) def.endpoint = endpoint;
  if (service !== undefined) def.service = service;

  return def;
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
/**
 * Build a source map that records the line number (1-based) where each named
 * block starts in the raw source. Scans for `agent <id> {`, `gate <id> {`,
 * `action <id> {`, and `orchestrator {` patterns.
 */
function buildSourceMap(rawSource: string): Record<string, number> {
  const sourceMap: Record<string, number> = {};
  const lines = rawSource.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match: agent <id> {, action <id> {, gate <id> {, human <id> {
    const namedMatch = line.match(/^\s*(?:agent|action|gate|human)\s+([a-zA-Z][a-zA-Z0-9_-]*)\s*(?:\{|[^{]*\{)/);
    if (namedMatch) {
      sourceMap[namedMatch[1]] = i + 1; // 1-based line number
      continue;
    }
    // Match: orchestrator {
    const orchMatch = line.match(/^\s*orchestrator\s*(?:\{|[^{]*\{)/);
    if (orchMatch) {
      sourceMap["orchestrator"] = i + 1;
    }
  }
  return sourceMap;
}

// ---------------------------------------------------------------------------
// Composition parsing: params, interface, import, include, fragment
// ---------------------------------------------------------------------------

/**
 * Parse a `params { ... }` block into typed parameter definitions.
 *
 * Each line has the form `name: type` or `name: type = default`.
 * If a default is provided, the parameter is optional; otherwise required.
 */
export function parseParams(body: string): ParamDef[] {
  const params: ParamDef[] = [];
  const VALID_TYPES = new Set(["string", "number", "boolean"]);

  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Match: name: type = default  OR  name: type
    const m = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(string|number|boolean)(?:\s*=\s*(.+))?$/);
    if (!m) continue;

    const [, name, type, rawDefault] = m;
    const paramType = type as "string" | "number" | "boolean";
    let defaultValue: string | number | boolean | undefined;
    let required = true;

    if (rawDefault !== undefined) {
      required = false;
      const dv = rawDefault.trim();
      if (paramType === "number") {
        defaultValue = parseFloat(dv);
      } else if (paramType === "boolean") {
        defaultValue = dv === "true";
      } else {
        // string — strip quotes if present
        defaultValue = unquote(dv);
      }
    }

    params.push({ name, type: paramType, required, ...(defaultValue !== undefined ? { default: defaultValue } : {}) });
  }

  return params;
}

/**
 * Parse an `interface { entry: <id>  exit: <id> }` block body.
 */
export function parseInterfaceEndpoints(body: string): InterfaceEndpoints | null {
  const fields = parseFields(body);
  const entry = fields["entry"];
  const exit = fields["exit"];
  if (!entry || !exit) return null;
  return { entry: unquote(entry), exit: unquote(exit) };
}

/**
 * Extract and parse the `interface { ... }` block from a topology body,
 * carefully avoiding collision with `interfaces { ... }`.
 */
function parseInterfaceBlock(topBody: string): InterfaceEndpoints | null {
  // Match "interface" followed by whitespace+"{" but NOT "interfaces"
  const re = /(?:^|\n)\s*interface\s*\{/m;
  const m = re.exec(topBody);
  if (!m) return null;

  // Make sure we did not match "interfaces" — check what precedes the `{`
  const matchText = m[0];
  if (/interfaces/.test(matchText)) return null;

  // Find the opening brace and count braces to extract the body
  const braceIdx = m.index! + m[0].length;
  let depth = 1;
  let i = braceIdx;
  while (i < topBody.length && depth > 0) {
    if (topBody[i] === "{") depth++;
    else if (topBody[i] === "}") depth--;
    i++;
  }
  if (depth !== 0) return null;

  const body = topBody.slice(braceIdx, i - 1);
  return parseInterfaceEndpoints(body);
}

/**
 * Parse import statements from a topology body.
 *
 * Syntax:
 *   import "./path.at" as alias
 *   import "./path.at" as alias with { key: value ... }
 *
 * Import statements are parsed from the raw body text since they are
 * not brace-delimited blocks in the usual sense.
 */
export function parseImports(body: string): ImportDef[] {
  const imports: ImportDef[] = [];

  // Regex: import "source" as alias (captures everything after for optional with block)
  const importRe = /(?:^|\n)\s*import\s+"([^"]+)"\s+as\s+([a-zA-Z][a-zA-Z0-9_-]*)/g;
  let m: RegExpExecArray | null;

  while ((m = importRe.exec(body)) !== null) {
    const source = m[1];
    const alias = m[2];
    const params: Record<string, string | number | boolean> = {};

    // Check for `with { ... }` block following the import
    const afterImport = body.slice(m.index! + m[0].length);
    const withMatch = afterImport.match(/^\s*with\s*\{([^}]*)\}/);

    if (withMatch) {
      const withBody = withMatch[1];
      for (const line of withBody.split("\n")) {
        const kv = parseKV(line);
        if (!kv) continue;
        const [key, rawVal] = kv;
        const val = unquote(rawVal);
        // Try number
        if (/^-?\d+(\.\d+)?$/.test(val)) {
          params[key] = parseFloat(val);
        } else if (val === "true" || val === "false") {
          params[key] = val === "true";
        } else {
          params[key] = val;
        }
      }
    }

    imports.push({ source, alias, params });
  }

  return imports;
}

/**
 * Parse include statements from a topology body.
 *
 * Syntax: include "./path.at"
 */
export function parseIncludes(body: string): IncludeDef[] {
  const includes: IncludeDef[] = [];
  const re = /(?:^|\n)\s*include\s+"([^"]+)"/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(body)) !== null) {
    includes.push({ source: m[1] });
  }

  return includes;
}

export function parse(source: string): TopologyAST {
  const src = stripComments(source);

  // --- Source map (line numbers for nodes) ---
  const sourceMap = buildSourceMap(source);

  // --- Detect fragment vs topology root ---
  const isFragment = /(?:^|\n)\s*fragment\s+\S+\s*\{/.test(source);

  // --- Topology header ---
  let header: { name: string; patterns: string[] };
  if (isFragment) {
    // Fragment header: fragment <name> { ... }
    const fm = source.match(/fragment\s+(\S+)\s*\{/);
    if (!fm) throw new Error("Could not find fragment header");
    header = { name: fm[1], patterns: [] };
  } else {
    // Use raw source to preserve the topology line (comments already on other lines)
    header = parseTopologyHeader(source);
  }

  // --- Extract the full topology/fragment body ---
  const topoBlock = extractBlock(source, isFragment ? "fragment" : "topology");
  if (!topoBlock) {
    throw new Error(isFragment ? "Could not extract fragment body" : "Could not extract topology body");
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
    ...(metaFields.domain ? { domain: metaFields.domain } : {}),
    ...(metaFields.timeout ? { timeout: metaFields.timeout } : {}),
    ...(metaFields.errorHandler ? { errorHandler: metaFields.errorHandler } : {}),
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

  // Human nodes
  const humanBlocks = extractAllBlocks(topBody, "human");
  for (const block of humanBlocks) {
    if (block.id) {
      nodes.push(parseHuman(block.id, block.body));
    }
  }

  // --- Skills ---
  const skillDefs = parseSkillBlocks(topBody);

  // --- Tools ---
  const toolDefs = parseToolsBlock(topBody);

  // --- Edges (flow) ---
  const flowBlock = extractBlock(topBody, "flow");
  const edgeAttributeErrors: Array<{ rule: string; level: "error" | "warning"; message: string; node?: string }> = [];
  const edges = flowBlock ? parseFlow(flowBlock.body, edgeAttributeErrors) : [];

  // --- Depth ---
  const depthBlock = extractBlock(topBody, "depth");
  const depth = depthBlock
    ? parseDepth(depthBlock.body)
    : { factors: [], levels: [] };

  // --- Memory ---
  const memoryBlock = extractBlock(topBody, "memory");
  const unknownMemorySubBlockWarnings: Array<{ rule: string; level: "error" | "warning"; message: string; node?: string }> = [];
  const memory = memoryBlock ? parseMemory(memoryBlock.body, unknownMemorySubBlockWarnings) : {};

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

  // --- Context ---
  const contextBlock = extractBlock(topBody, "context");
  const context = contextBlock ? parseContext(contextBlock.body) : {};

  // --- Env ---
  const envBlock = extractBlock(topBody, "env");
  const env = envBlock ? parseEnv(envBlock.body) : {};

  // --- Providers ---
  const providersBlock = extractBlock(topBody, "providers");
  const providers = providersBlock ? parseProviders(providersBlock.body) : [];

  // --- Schedule ---
  const scheduleBlock = extractBlock(topBody, "schedule");
  const schedules = scheduleBlock ? parseSchedule(scheduleBlock.body) : [];

  // --- Interfaces ---
  const interfacesBlock = extractBlock(topBody, "interfaces");
  const interfaces = interfacesBlock ? parseInterfaces(interfacesBlock.body) : [];

  // --- Defaults ---
  const defaultsBlock = extractBlock(topBody, "defaults");
  const defaults = defaultsBlock ? parseDefaults(defaultsBlock.body) : null;

  // --- Schemas ---
  const schemas = parseSchemas(topBody);

  // --- Observability ---
  const observabilityBlock = extractBlock(topBody, "observability");
  const observability = observabilityBlock ? parseObservability(observabilityBlock.body) : null;

  // --- Top-level Extensions ---
  const topLevelExtensions = parseExtensionsBlock(topBody);

  // --- Params ---
  const paramsBlock = extractBlock(topBody, "params");
  const params = paramsBlock ? parseParams(paramsBlock.body) : [];

  // --- Interface (entry/exit endpoints) ---
  // Note: "interface" block is distinct from "interfaces" (external interface definitions).
  // We use a targeted regex to avoid matching "interfaces" when looking for "interface".
  const interfaceEndpoints = parseInterfaceBlock(topBody);

  // --- Imports ---
  const imports = parseImports(topBody);

  // --- Includes ---
  const includes = parseIncludes(topBody);

  // --- Duplicate section detection ---
  const singletonKeywords = [
    "meta", "orchestrator", "flow", "memory", "batch", "environments",
    "triggers", "settings", "mcp-servers", "metering", "context", "env",
    "providers", "schedule", "interfaces", "depth", "gates", "roles", "tools",
    "defaults", "schemas", "observability", "params", "interface",
  ];
  const duplicateSectionWarnings: Array<{ rule: string; level: "error" | "warning"; message: string; node?: string }> = [];
  for (const keyword of singletonKeywords) {
    const allBlocks = extractAllBlocks(topBody, keyword);
    if (allBlocks.length > 1) {
      duplicateSectionWarnings.push({
        rule: "V23",
        level: "warning",
        message: `Duplicate "${keyword}" block detected (found ${allBlocks.length}) — only the first occurrence is used`,
      });
    }
  }

  // --- Assemble AST ---
  const ast: TopologyAST & {
    _edgeAttributeErrors?: typeof edgeAttributeErrors;
    _duplicateSectionWarnings?: typeof duplicateSectionWarnings;
    _unknownMemorySubBlockWarnings?: typeof unknownMemorySubBlockWarnings;
    _sourceMap?: Record<string, number>;
  } = {
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
    context,
    env,
    providers,
    schedules,
    interfaces,
    defaults,
    schemas,
    ...(topLevelExtensions ? { extensions: topLevelExtensions } : {}),
    observability,
    params,
    interfaceEndpoints,
    imports,
    includes,
    ...(isFragment ? { isFragment: true } : {}),
  };

  // Attach V12 parse-time errors for the validator to consume.
  if (edgeAttributeErrors.length > 0) {
    ast._edgeAttributeErrors = edgeAttributeErrors;
  }

  // Attach V23 duplicate section warnings for the validator to consume.
  if (duplicateSectionWarnings.length > 0) {
    ast._duplicateSectionWarnings = duplicateSectionWarnings;
  }

  // Attach V24 unknown memory sub-block warnings for the validator to consume.
  if (unknownMemorySubBlockWarnings.length > 0) {
    ast._unknownMemorySubBlockWarnings = unknownMemorySubBlockWarnings;
  }

  // Attach source map for line number tracking in validation results.
  if (Object.keys(sourceMap).length > 0) {
    ast._sourceMap = sourceMap;
  }

  return ast;
}
