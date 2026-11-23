/**
 * AgenTopology parser.
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
  GroupNode,
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
  CheckpointDef,
  ReplayConfig,
  ArtifactDef,
  RecordDef,
  PromptVariant,
  AuthDef,
  StoreNode,
  MachineDef,
  PersonDef,
  NeedsDef,
  RetrievalNode,
  EmbeddingConfig,
  IndexConfig,
  IngestionConfig,
  SearchConfig,
  LifecycleConfig,
  ScoringConfig,
} from "./ast.js";

import {
  stripComments,
  extractBlock,
  extractAllBlocks,
  extractTopLevelBlocks,
  parseKV,
  parseList,
  parseMultilineList,
  unquote,
  parseFields,
  parseOutputsBlock,
  dedentBlock,
  maskProse,
  closingBrace,
  braceText,
} from "./lexer.js";

/**
 * Every `name {` block header directly in `body` (prose is never a block),
 * with its content. `skipNested` resumes the search after each block, so a
 * block inside one is not listed.
 */
function namedSubBlocks(body: string, skipNested = false): Array<{ name: string; body: string }> {
  const mask = maskProse(body);
  const re = /(?:^|\n)\s*([a-zA-Z][a-zA-Z0-9_-]*)\s*\{/gm;
  const out: Array<{ name: string; body: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(mask)) !== null) {
    const startIdx = m.index! + m[0].length;
    const end = closingBrace(braceText(body), startIdx);
    if (skipNested) re.lastIndex = end < 0 ? mask.length : end + 1;
    if (end >= 0) out.push({ name: m[1], body: body.slice(startIdx, end) });
  }
  return out;
}
import { findUnknownNames } from "./known-fields.js";
import { findLostStructure } from "./lost-structure.js";
import { SINGLE_SECTIONS } from "./sections.js";

// Re-export AST types for convenience
export type * from "./ast.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * V90: detect a field value that swallowed the next field.
 *
 * `parseFields` is line-based, and the grammar never says so. Writing two
 * fields on one line — `agent a { model: sonnet retry: 3 }` — makes the first
 * key take the whole rest of the line as its value (`"sonnet retry: 3"`), and
 * nothing catches it. The value is then silently wrong: a model name that does
 * not exist, a version string carrying a description, an action `kind` that
 * fails its enum for a confusing reason.
 *
 * Detection: an UNQUOTED value containing whitespace followed by
 * `identifier:` is almost certainly a swallowed field. Quoted values are
 * exempt (a description may legitimately contain a colon), and a leading
 * scheme like `https://` is not matched because it has no preceding
 * whitespace.
 */
function detectSwallowedFields(
  fields: Record<string, string>,
  nodeId: string,
  out: Array<{ rule: string; level: "error" | "warning"; message: string; node?: string }>
): void {
  for (const [key, raw] of Object.entries(fields)) {
    if (typeof raw !== "string") continue;
    const value = raw.trim();
    // Free-prose fields whose quotes have already been stripped are exempt: a
    // colon inside a description is ordinary English ("Demo: agent pipeline"),
    // and once the quotes are gone there is no way to tell prose from a
    // swallow. Where quotes SURVIVE parsing — every block except `meta` — the
    // check below still catches `description: "k" model: sonnet`.
    const PROSE_FIELDS = new Set(["description", "role", "generates", "termination"]);
    if (PROSE_FIELDS.has(key) && !value.startsWith('"')) continue;
    // A balanced brace block is a NESTED OBJECT, not a swallow. The single-line
    // form is spec-legal and parses correctly — `spec/grammar.md:117` gives
    // `outputs: { depth: 1 | 2 | 3 }` verbatim. Flagging it rejected valid
    // topologies, which is worse than missing one.
    if (value.startsWith("{") && value.endsWith("}")) continue;
    // Same for a list.
    if (value.startsWith("[") && value.endsWith("]")) continue;
    // A WELL-FORMED quoted string is exempt — a description may contain a
    // colon. `"1.0.0" description: "x"` is NOT well-formed: it is one quoted
    // token followed by more content, i.e. a swallowed field.
    if (/^"(?:[^"\\]|\\.)*"$/.test(value)) continue;
    const search = value.startsWith('"')
      ? value.replace(/^"(?:[^"\\]|\\.)*"/, "")
      : value;
    const m = /\s([a-zA-Z][a-zA-Z0-9_-]*):/.exec(search.startsWith(" ") ? search : " " + search);
    if (!m) continue;
    out.push({
      rule: "V90",
      level: "error",
      message:
        `"${nodeId}" field \`${key}\` has the value \`${value}\`, which looks like it swallowed the ` +
        `field \`${m[1]}\` — fields must be one per line`,
      node: nodeId,
    });
  }
}

/**
 * Placeholders the parser injects for REQUIRED fields that were not declared.
 *
 * The parser cannot leave them undefined without changing non-optional AST
 * types, so it substitutes a sentinel — and that sentinel then satisfied every
 * "is it present?" check downstream. V91 recognises them and reports the field
 * as missing, which is what the spec says it is.
 */
export const MISSING = {
  /** `orchestrator.model` — spec/grammar.md, orchestrator field table. */
  model: "unknown",
  /** `meta.version` — spec/grammar.md:282, Required: yes. */
  version: "0.0.0",
} as const;

/** Convert a kebab-case or snake_case identifier to a Title Case label. */
function toLabel(id: string): string {
  return id
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * `src` with the inside of every block blanked out: what remains is the text
 * at depth 0 plus each block's own braces. A keyword found in it is a
 * top-level one, at the same position as in `src`.
 */
function depthZeroText(src: string): string {
  // Depth is counted on braceText; a brace it does not count shows as a
  // space, so no later search can take it for a block.
  const braces = braceText(src);
  let depth = 0;
  let out = "";
  for (let i = 0; i < src.length; i++) {
    const brace = braces[i] === "{" || braces[i] === "}";
    const ch = brace || (src[i] !== "{" && src[i] !== "}") ? src[i] : " ";
    if (ch === "{") {
      depth++;
      out += depth === 1 ? ch : " ";
    } else if (ch === "}") {
      out += depth === 1 ? ch : " ";
      depth--;
    } else {
      out += depth >= 1 && ch !== "\n" ? " " : ch;
    }
  }
  return out;
}

/** `key: value` lines at the top level of an extension namespace; a key may hold dots, digits and `@`. */
function parseExtensionFields(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  let depth = 0;
  const lines = body.split("\n");
  const masked = maskProse(body).split("\n");
  const braceLines = braceText(body).split("\n");
  const kv = /^\s*([A-Za-z_][A-Za-z0-9_.@-]*)\s*:\s*(.+?)\s*$/;
  for (let li = 0; li < lines.length; li++) {
    for (const ch of braceLines[li]) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    if (depth !== 0 || !kv.test(masked[li])) continue;
    const m = lines[li].match(kv);
    if (m) fields[m[1]] = m[2];
  }
  return fields;
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
  for (const { name, body: innerBody } of namedSubBlocks(extBlock.body)) {
    // A binding's own key may be a dotted path (`permissions.defaultMode`)
    // or hold digits; parseFields reads only plain words and would drop it.
    const fields = parseExtensionFields(innerBody);
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
  const header = /topology\s+(\S+)\s*:\s*\[([^\]]*)\]\s*\{/;
  // The header in a comment (or any prose) above the real one is text.
  const at = maskProse(src).search(header);
  const m = at < 0 ? null : src.slice(at).match(header);
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
  // Kept as written, an empty value included: V134 reports one that is not an agent id.
  if (fields.entry !== undefined) result.entry = unquote(fields.entry.trim());
  else if (/^\s*entry\s*:\s*(#.*)?$/m.test(body)) result.entry = "";
  if (fields.durable) result.durable = fields.durable === "true";

  return result;
}

/**
 * Parse the `orchestrator { ... }` block into an {@link OrchestratorNode}.
 */
export function parseOrchestrator(
  body: string,
  _blockFieldMisuseWarnings?: Array<{ rule: string; level: "error" | "warning"; message: string; node?: string }>
): OrchestratorNode {
  const fields = parseFields(body);
  if (_blockFieldMisuseWarnings) {
    detectSwallowedFields(fields, "orchestrator", _blockFieldMisuseWarnings);
  }
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
  if (fields.delegation) {
    const delegation = unquote(fields.delegation);
    if (delegation === "subagent" || delegation === "inline") {
      node.delegation = delegation;
    } else {
      // Preserve the raw value so the validator can flag it (V88).
      // TypeScript cast is intentional — the field type is narrow but the
      // validator runs on the AST after parse and reports unknown values.
      node.delegation = delegation as "subagent" | "inline";
    }
  }
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
export function parseAction(
  id: string,
  body: string,
  _blockFieldMisuseWarnings?: Array<{ rule: string; level: "error" | "warning"; message: string; node?: string }>
): ActionNode {
  const fields = parseFields(body);
  if (_blockFieldMisuseWarnings) {
    detectSwallowedFields(fields, id, _blockFieldMisuseWarnings);
  }
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
  if (fields["unit-from"]) node.unitFrom = unquote(fields["unit-from"]);
  return node;
}

/**
 * The `hooks { }` blocks an agent writes at its own level, in file order.
 * When none sits at that level, the first one found anywhere in the body (how
 * 0.11.4 read an agent's hooks) so no existing topology loses a hook.
 */
function agentHookBlocks(body: string): Array<{ body: string; at?: number }> {
  const top = extractTopLevelBlocks(body, "hooks");
  if (top.length) return top;
  const first = extractBlock(body, "hooks");
  return first ? [first] : [];
}

/**
 * V23 for an agent's hooks: a hook name used in two of the agent's blocks is
 * an error, twice in one block a warning (both are kept), as at the top level.
 */
function agentHookDuplicates(
  agentId: string,
  body: string
): Array<{ rule: string; level: "error" | "warning"; message: string; node?: string }> {
  const blocksOf = new Map<string, number[]>();
  agentHookBlocks(body).forEach((b, i) => {
    for (const h of extractAllBlocks(b.body, "hook")) {
      if (h.id) blocksOf.set(h.id, [...(blocksOf.get(h.id) ?? []), i]);
    }
  });
  const out: Array<{ rule: string; level: "error" | "warning"; message: string; node?: string }> = [];
  for (const [name, at] of blocksOf) {
    if (at.length < 2) continue;
    const oneBlock = new Set(at).size === 1;
    out.push({
      rule: "V23",
      level: oneBlock ? "warning" : "error",
      node: `${agentId}.${name}`,
      message: `Hook "${name}" is declared ${oneBlock ? "twice in one hooks block" : "in two hooks blocks"} of agent "${agentId}": a hook name must be unique — rename or remove one`,
    });
  }
  return out;
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
  roles: Record<string, string>,
  _blockFieldMisuseWarnings?: Array<{ rule: string; level: "error" | "warning"; message: string; node?: string }>
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

  if (fields.file) node.file = unquote(fields.file);
  if (fields.phase) node.phase = parseFloat(fields.phase);
  if (fields.model) node.model = fields.model;
  if (fields.permissions) node.permissions = fields.permissions;

  // Extract prompt from prompt {} block (not KV pair).
  //
  // V89: `agent.prompt` is a BLOCK per spec/grammar.md:350. The string form
  // (`prompt: "path.md"`) belongs to `skill`, a different node type
  // (spec/grammar.md:1377). A KV `prompt` on an agent is silently unparseable,
  // so flag it rather than dropping the author's instructions on the floor.
  if (fields.prompt) {
    _blockFieldMisuseWarnings?.push({
      rule: "V89",
      level: "error",
      message:
        `agent "${id}" uses \`prompt:\` as a key-value field, but agent prompts must be a \`prompt { }\` block — ` +
        `this value is ignored and the agent will have no instructions`,
      node: id,
    });
  }
  if (_blockFieldMisuseWarnings) {
    detectSwallowedFields(fields, id, _blockFieldMisuseWarnings);
  }

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
  if (fields.runs) node.runs = fields.runs;
  if (fields.place) node.place = unquote(fields.place);
  if (fields.machine) node.machine = unquote(fields.machine);
  if (fields["permission-mode"]) node.permissionMode = fields["permission-mode"];
  const decides = parseMultilineList(body, "decides");
  if (decides.length) node.decides = decides;
  else if (fields.decides) node.decides = parseList(fields.decides);
  if (fields.independent) node.independent = fields.independent === "true";
  if (fields.color) node.color = unquote(fields.color);
  if (fields["initial-prompt"]) node.initialPrompt = unquote(fields["initial-prompt"]);
  if (fields["omit-claude-md"]) node.omitClaudeMd = fields["omit-claude-md"] === "true";

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

  // Memory store references and retrieval strategy
  const agentMemory = parseMultilineList(body, "memory");
  if (agentMemory.length) {
    node.memory = agentMemory;
  } else if (fields.memory) {
    node.memory = parseList(fields.memory);
  }
  if (fields.retrieval) node.retrieval = fields.retrieval;

  // Custody: `custodian-of: [store, ...]` with optional `{ does: [verb, ...] }`.
  // The store-list appears before an optional brace block. Match the list first,
  // then look inside the block (if any) for `does`.
  const custodyAt = maskProse(body).search(/custodian-of\s*:\s*\[/);
  const custodyMatch = custodyAt < 0 ? null : /custodian-of\s*:\s*\[([^\]]*)\]/.exec(body.slice(custodyAt));
  if (custodyMatch) {
    const stores = parseList(custodyMatch[1]);
    if (stores.length) node.custodianOf = stores;
    const custodyBlock = extractBlock(body, "custodian-of");
    if (custodyBlock) {
      const does = parseMultilineList(custodyBlock.body, "does");
      const doesInline = parseFields(custodyBlock.body).does;
      if (does.length) node.custodianDoes = does;
      else if (doesInline) node.custodianDoes = parseList(doesInline);
    }
  }

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

  // Per-agent hooks: the agent's FIRST `hooks { }` block, as in 0.11.4. A
  // second and later block's hooks are project hooks (see parse()), where
  // 0.11.4 put them.
  const agentHooksBlock = agentHookBlocks(body)[0];
  if (agentHooksBlock) {
    const agentHooks: HookDef[] = [];
    const hookBlocks = extractAllBlocks(agentHooksBlock.body, "hook");
    for (const hBlock of hookBlocks) {
      if (!hBlock.id) continue;
      const hFields = parseFields(hBlock.body);
      if (_blockFieldMisuseWarnings) {
        detectSwallowedFields(hFields, `${id}.${hBlock.id}`, _blockFieldMisuseWarnings);
      }
      const agentHook = hookFromFields(hBlock.id, hFields);

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

  // Artifact lineage: produces and consumes
  const produces = parseMultilineList(body, "produces");
  if (produces.length) node.produces = produces;
  const consumes = parseMultilineList(body, "consumes");
  if (consumes.length) node.consumes = consumes;

  // Prompt variants (A/B testing)
  const variantsBlock = extractBlock(body, "variants");
  if (variantsBlock) {
    const variants: PromptVariant[] = [];
    const variantBlocks = extractAllBlocks(variantsBlock.body, "variant");
    for (const vBlock of variantBlocks) {
      if (!vBlock.id) continue;
      const vFields = parseFields(vBlock.body);
      const variant: PromptVariant = {
        id: vBlock.id,
        weight: vFields.weight ? parseFloat(vFields.weight) : 0,
      };
      const vPromptBlock = extractBlock(vBlock.body, "prompt");
      if (vPromptBlock) {
        variant.prompt = dedentBlock(vPromptBlock.body);
      }
      if (vFields.temperature) variant.temperature = parseFloat(vFields.temperature);
      if (vFields.model) variant.model = vFields.model;
      variants.push(variant);
    }
    if (variants.length > 0) node.variants = variants;
  }

  // Rate limit
  if (fields["rate-limit"]) node.rateLimit = fields["rate-limit"];

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
export function parseGate(
  id: string,
  body: string,
  _blockFieldMisuseWarnings?: Array<{ rule: string; level: "error" | "warning"; message: string; node?: string }>
): GateNode {
  const fields = parseFields(body);
  if (_blockFieldMisuseWarnings) {
    detectSwallowedFields(fields, id, _blockFieldMisuseWarnings);
  }
  const checks = parseMultilineList(body, "checks");

  const node: GateNode = {
    id,
    type: "gate",
    label: toLabel(id),
  };

  // `after: [a, b, c]` or `after: a`. parseMultilineList returns [] for the
  // scalar form, so fall back to the field — the same pattern `checks` uses
  // above, extended to accept both shapes.
  const afterList = parseMultilineList(body, "after");
  if (afterList.length) node.after = afterList;
  else if (fields.after) node.after = fields.after;

  const beforeList = parseMultilineList(body, "before");
  if (beforeList.length) node.before = beforeList;
  else if (fields.before) node.before = fields.before;
  if (fields.run) node.run = unquote(fields.run);
  if (checks.length) node.checks = checks;
  if (fields.retry) node.retry = parseInt(fields.retry, 10);
  if (fields["on-fail"]) node.onFail = fields["on-fail"];
  if (fields.behavior) node.behavior = fields.behavior;
  if (fields.timeout) node.timeout = fields.timeout;
  if (fields.description) node.description = unquote(fields.description);
  if (fields.strength) node.strength = fields.strength;
  if (fields.by) node.by = fields.by;
  if (fields.at) node.at = unquote(fields.at);
  if (fields.match) node.match = unquote(fields.match);
  if (fields.bypass) node.bypass = unquote(fields.bypass);
  if (fields.ledger) node.ledger = fields.ledger;

  const extensions = parseExtensionsBlock(body);
  if (extensions) node.extensions = extensions;

  return node;
}

/**
 * Parse a `human <id> { ... }` block into a {@link HumanNode}.
 */
export function parseHuman(
  id: string,
  body: string,
  _blockFieldMisuseWarnings?: Array<{ rule: string; level: "error" | "warning"; message: string; node?: string }>
): HumanNode {
  const fields = parseFields(body);
  if (_blockFieldMisuseWarnings) {
    detectSwallowedFields(fields, id, _blockFieldMisuseWarnings);
  }

  const node: HumanNode = {
    id,
    type: "human",
    label: toLabel(id),
  };

  if (fields.file) node.file = unquote(fields.file);
  if (fields.description) node.description = unquote(fields.description);
  if (fields.timeout) node.timeout = unquote(fields.timeout);
  if (fields["on-timeout"]) node.onTimeout = unquote(fields["on-timeout"]);
  if (fields.who) node.who = unquote(fields.who);
  if (fields.valid) node.valid = unquote(fields.valid);

  return node;
}

/**
 * Parse a `group <id> { ... }` block into a {@link GroupNode}.
 */
export function parseGroup(
  id: string,
  body: string,
  _blockFieldMisuseWarnings?: Array<{ rule: string; level: "error" | "warning"; message: string; node?: string }>
): GroupNode {
  const fields = parseFields(body);
  if (_blockFieldMisuseWarnings) {
    detectSwallowedFields(fields, id, _blockFieldMisuseWarnings);
  }
  const members = parseList(fields.members ?? "");

  const node: GroupNode = {
    id,
    type: "group",
    label: toLabel(id),
    members,
  };
  if (fields.file) node.file = unquote(fields.file);

  if (fields["speaker-selection"]) node.speakerSelection = fields["speaker-selection"];
  if (fields["max-rounds"]) node.maxRounds = parseInt(fields["max-rounds"], 10);
  if (fields.termination) node.termination = unquote(fields.termination);
  if (fields.description) node.description = unquote(fields.description);
  if (fields.timeout) node.timeout = fields.timeout;

  return node;
}

/** An edge's enforcement attributes (strength, at, guard), only those written. */
function enforcement(e: Partial<EdgeDef>): Partial<EdgeDef> {
  return {
    ...(e.strength ? { strength: e.strength } : {}),
    ...(e.at !== undefined ? { at: e.at } : {}),
    ...(e.guard ? { guard: [...e.guard] } : {}),
  };
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
    let weight: number | undefined;
    let reflection: boolean | undefined;
    let strength: string | undefined;
    let at: string | undefined;
    let guard: string[] | undefined;
    let message: string | undefined;
    let flowPart = trimmed;

    // Match annotation at end of line: [when ..., max N, per agent-id, tolerance: N, race, wait 30s, reflection]
    // Must start with "when", "max", "per", "tolerance", "race", "wait", "join", "weight", or "reflection" to avoid matching fan-out lists.
    const bracketMatch = trimmed.match(
      /\[(when\s+.+?|max\s+\d+.*?|per\s+\S+.*?|tolerance\s*:.+?|race.*?|wait\s+\S+.*?|join\s+\S+.*?|weight\s+\S+.*?|reflection.*?|strength\s*:.+?|guard\s*:.+?|at\s*:.+?|message\s*:.+?)\]\s*$/
    );
    // V92: two bracket groups on one edge. The grammar defines ONE annotation
    // with comma-separated attributes (`[when ..., max N]`). Written as
    // `[when ...] [max N]`, the matcher below spans from the first `[` to the
    // last `]` and produces a corrupt condition — literally
    // `a.verdict == fail] [max 3` — with no error at all.
    // Count only ANNOTATION brackets. A fan-out list is also bracketed —
    // `analyzer -> [reporter, alerter] [when ...]` is legal — so testing for
    // `] [` alone flagged valid topologies.
    const ATTR = /\[\s*(?:when|max|per|tolerance|race|wait|join|weight|reflection|strength|guard|at|message)\b/g;
    const annotationBrackets = (trimmed.match(ATTR) ?? []).length;
    if (annotationBrackets > 1 && _edgeAttributeErrors) {
      _edgeAttributeErrors.push({
        rule: "V92",
        level: "error",
        message:
          "Edge has two bracket groups — attributes go in ONE bracket, " +
          `comma-separated: [when ..., max N] (line: ${trimmed})`,
      });
    }

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

      const whenMatch = annotation.match(/when\s+(.+?)(?:,\s*(?:max|per|tolerance|race|wait|weight|reflection|strength|guard|at\b|message\b)|$)/);
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

      // weight 0.7
      const weightMatch = annotation.match(/weight\s+(\d+(?:\.\d+)?)/);
      if (weightMatch) {
        weight = parseFloat(weightMatch[1]);
      }

      // reflection
      if (/\breflection\b/.test(annotation)) {
        reflection = true;
      }

      // strength: refuse | detect | hope | none; at: "path:line"; guard: id | [id, id]
      const strengthMatch = annotation.match(/\bstrength\s*:\s*([A-Za-z-]+)/);
      if (strengthMatch) strength = strengthMatch[1];
      const atMatch = annotation.match(/(?:^|,)\s*at\s*:\s*"([^"]*)"/);
      if (atMatch) at = atMatch[1];
      const messageMatch = annotation.match(/\bmessage\s*:\s*([A-Za-z0-9_-]+)/);
      if (messageMatch) message = messageMatch[1];
      const guardMatch = annotation.match(/\bguard\s*:\s*(\[[^\]]*\]|[A-Za-z0-9_-]+)/);
      if (guardMatch) {
        guard = guardMatch[1].replace(/^\[|\]$/g, "").split(",").map((g) => g.trim()).filter(Boolean);
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
      if (isLastSegment && weight !== undefined) baseEdge.weight = weight;
      if (isLastSegment && reflection) baseEdge.reflection = true;
      if (isLastSegment && strength) baseEdge.strength = strength;
      if (isLastSegment && at !== undefined) baseEdge.at = at;
      if (isLastSegment && guard) baseEdge.guard = guard;
      if (isLastSegment && message) baseEdge.message = message;

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
            ...(baseEdge.weight !== undefined ? { weight: baseEdge.weight } : {}),
            ...(baseEdge.reflection ? { reflection: true } : {}),
            ...enforcement(baseEdge),
            ...(baseEdge.message ? { message: baseEdge.message } : {}),
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
          ...(baseEdge.weight !== undefined ? { weight: baseEdge.weight } : {}),
          ...(baseEdge.reflection ? { reflection: true } : {}),
          ...enforcement(baseEdge),
          ...(baseEdge.message ? { message: baseEdge.message } : {}),
        });
      }
    }
  }

  return edges;
}

/**
 * Expand `talk:` shorthand lines of a flow body into plain edges.
 *
 * `talk: all` makes an edge each way between every pair of session agents;
 * `talk: hub <name>` makes `<name> <-> x` for every other session agent.
 * An optional `[message: ticket]` marks every edge the line makes. An edge the
 * flow already declares in that direction is kept as written, so one edge of a
 * hub can carry its own `[message:]`. Expansion happens here, so the AST (and
 * `export --format json`) only ever holds plain edges.
 */
export function expandTalk(flowBody: string, nodes: NodeDef[], edges: EdgeDef[], talkErrors?: string[]): EdgeDef[] {
  const sessions = nodes.filter((n) => n.type === "agent" && (n as AgentNode).runs === "session").map((n) => n.id);
  const out = [...edges];
  const have = new Set(out.map((e) => `${e.from}\u0000${e.to}`));
  const add = (from: string, to: string, message?: string) => {
    if (from === to || have.has(`${from}\u0000${to}`)) return;
    have.add(`${from}\u0000${to}`);
    out.push({ from, to, condition: null, maxIterations: null, per: null, ...(message ? { message } : {}) });
  };
  for (const line of flowBody.split("\n")) {
    const trimmed = line.trim();
    if (!/^talk\s*:/.test(trimmed)) continue;
    const m = trimmed.match(/^talk\s*:\s*(all|hub\s+([A-Za-z0-9_-]+))\s*(?:\[\s*message\s*:\s*([A-Za-z0-9_-]+)\s*\])?\s*$/);
    if (!m) {
      talkErrors?.push(`"${trimmed}" is not a talk form: write "talk: all" or "talk: hub <session-agent>", each optionally followed by [message: ticket|report|ask].`);
      continue;
    }
    const message = m[3];
    if (m[1] === "all") {
      for (const a of sessions) for (const b of sessions) add(a, b, message);
    } else {
      const hub = m[2];
      if (!sessions.includes(hub)) {
        talkErrors?.push(`"talk: hub ${hub}": "${hub}" is not a session agent (runs: session), so no talk edges were made.`);
        continue;
      }
      for (const x of sessions) {
        add(hub, x, message);
        add(x, hub, message);
      }
    }
  }
  return out;
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

// ---------------------------------------------------------------------------
// Memory store & retrieval parsers
// ---------------------------------------------------------------------------

/** Parse an `embedding { ... }` sub-block into an {@link EmbeddingConfig}. */
function parseEmbeddingConfig(body: string): EmbeddingConfig {
  const fields = parseFields(body);
  const config: EmbeddingConfig = {};
  if (fields.provider) config.provider = unquote(fields.provider);
  if (fields.model) config.model = unquote(fields.model);
  if (fields.dimensions) config.dimensions = parseInt(fields.dimensions, 10);
  if (fields.endpoint) config.endpoint = unquote(fields.endpoint);
  return config;
}

/** Parse an `index { ... }` sub-block into an {@link IndexConfig}. */
function parseIndexConfig(body: string): IndexConfig {
  const fields = parseFields(body);
  const config: IndexConfig = {};
  if (fields.collection) config.collection = unquote(fields.collection);
  if (fields.metric) config.metric = fields.metric;
  return config;
}

/** Parse an `ingestion { ... }` sub-block into an {@link IngestionConfig}. */
function parseIngestionConfig(body: string): IngestionConfig {
  const fields = parseFields(body);
  const config: IngestionConfig = {};
  const sources = parseMultilineList(body, "sources");
  if (sources.length) config.sources = sources;
  else if (fields.sources) config.sources = parseList(fields.sources);
  if (fields.chunking) config.chunking = fields.chunking;
  if (fields["chunk-size"]) config.chunkSize = parseInt(fields["chunk-size"], 10);
  if (fields.overlap) config.overlap = parseInt(fields.overlap, 10);
  return config;
}

/** Parse a `search { ... }` sub-block into a {@link SearchConfig}. */
function parseSearchConfig(body: string): SearchConfig {
  const fields = parseFields(body);
  const config: SearchConfig = {};
  if (fields.strategy) config.strategy = fields.strategy;
  if (fields.rerank) config.rerank = fields.rerank === "true";
  if (fields["top-k"]) config.topK = parseInt(fields["top-k"], 10);
  return config;
}

/** Parse a `lifecycle { ... }` sub-block into a {@link LifecycleConfig}. */
function parseLifecycleConfig(body: string): LifecycleConfig {
  const fields = parseFields(body);
  const config: LifecycleConfig = {};
  if (fields.retention) config.retention = fields.retention;
  if (fields["decay-half-life"]) config.decayHalfLife = fields["decay-half-life"];
  if (fields.consolidation) config.consolidation = parseFloat(fields.consolidation);
  if (fields.contradiction) config.contradiction = fields.contradiction;
  if (fields["audit-log"]) config.auditLog = fields["audit-log"] === "true";
  return config;
}

/** Parse a `scoring { ... }` sub-block into a {@link ScoringConfig}. */
function parseScoringConfig(body: string): ScoringConfig {
  const fields = parseFields(body);
  const config: ScoringConfig = {};
  if (fields["recency-weight"]) config.recencyWeight = parseFloat(fields["recency-weight"]);
  if (fields["semantic-weight"]) config.semanticWeight = parseFloat(fields["semantic-weight"]);
  if (fields["importance-weight"]) config.importanceWeight = parseFloat(fields["importance-weight"]);
  return config;
}

/**
 * Parse a `store <id> { ... }` block into a {@link StoreNode}.
 */
export function parseStore(id: string, body: string): StoreNode {
  const fields = parseFields(body);

  // `brain` stores are file-native (Obsidian-format markdown) — their backend
  // is always `files`, never a database. Every other type defaults to lancedb.
  const type = fields.type ?? "semantic";
  const store: StoreNode = {
    id,
    type,
    backend: fields.backend ?? (type === "brain" ? "files" : "lancedb"),
  };

  if (fields.description) store.description = unquote(fields.description);
  if (fields.scope) store.scope = fields.scope;
  if (fields.isolation) store.isolation = fields.isolation;
  if (fields.path) store.path = unquote(fields.path);
  if (fields.extraction) store.extraction = fields.extraction;
  if (fields.format) store.format = fields.format;
  if (fields.owner) store.owner = fields.owner;
  if (fields.machine) store.machine = fields.machine;

  // Connection: may use `secret "uri"` modifier (same pattern as parseCheckpoint)
  if (fields.connection) {
    const rawConn = fields.connection.trim();
    if (rawConn.startsWith("secret ")) {
      store.connection = unquote(rawConn.slice("secret ".length).trim());
    } else {
      store.connection = unquote(rawConn);
    }
  }

  // Sub-blocks
  const embeddingBlock = extractBlock(body, "embedding");
  if (embeddingBlock) store.embedding = parseEmbeddingConfig(embeddingBlock.body);

  const indexBlock = extractBlock(body, "index");
  if (indexBlock) store.index = parseIndexConfig(indexBlock.body);

  const ingestionBlock = extractBlock(body, "ingestion");
  if (ingestionBlock) store.ingestion = parseIngestionConfig(ingestionBlock.body);

  const searchBlock = extractBlock(body, "search");
  if (searchBlock) store.search = parseSearchConfig(searchBlock.body);

  const lifecycleBlock = extractBlock(body, "lifecycle");
  if (lifecycleBlock) store.lifecycle = parseLifecycleConfig(lifecycleBlock.body);

  // Presentation-only `sources { gmail { color icon } slack { ... } }` block.
  // Maps a note's `source:` frontmatter to a graph color/icon. Cosmetic — the
  // visualizer reads it; bindings ignore it entirely.
  const sourcesBlock = extractBlock(body, "sources");
  if (sourcesBlock) {
    const sources: Record<string, { color?: string; icon?: string }> = {};
    for (const sub of namedSubBlocks(sourcesBlock.body)) {
      const inner = parseFields(sub.body);
      const style: { color?: string; icon?: string } = {};
      if (inner.color) style.color = unquote(inner.color);
      if (inner.icon) style.icon = unquote(inner.icon);
      if (style.color || style.icon) sources[sub.name] = style;
    }
    if (Object.keys(sources).length > 0) store.sources = sources;
  }

  // Backend-config passthrough bag
  const backendConfigBlock = extractBlock(body, "backend-config");
  if (backendConfigBlock) {
    const bcFields = parseFields(backendConfigBlock.body);
    const bag: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(bcFields)) {
      if (v === "true") bag[k] = true;
      else if (v === "false") bag[k] = false;
      else if (/^-?\d+(\.\d+)?$/.test(v)) bag[k] = parseFloat(v);
      else bag[k] = unquote(v);
    }
    if (Object.keys(bag).length > 0) store.backendConfig = bag;
  }

  return store;
}

/**
 * Parse a `retrieval <id> { ... }` block into a {@link RetrievalNode}.
 */
export function parseRetrieval(id: string, body: string): RetrievalNode {
  const fields = parseFields(body);

  const retrieval: RetrievalNode = { id };

  // Sources list
  const sources = parseMultilineList(body, "sources");
  if (sources.length) retrieval.sources = sources;
  else if (fields.sources) retrieval.sources = parseList(fields.sources);

  // Paths list
  const paths = parseMultilineList(body, "paths");
  if (paths.length) retrieval.paths = paths;
  else if (fields.paths) retrieval.paths = parseList(fields.paths);

  if (fields.budget) retrieval.budget = parseInt(fields.budget, 10);
  if (fields.rerank) retrieval.rerank = fields.rerank === "true";
  if (fields.diversity) retrieval.diversity = fields.diversity === "true";
  if (fields["cache-hit-threshold"]) retrieval.cacheHitThreshold = parseFloat(fields["cache-hit-threshold"]);
  if (fields["cache-hit-action"]) retrieval.cacheHitAction = fields["cache-hit-action"];

  // Scoring sub-block
  const scoringBlock = extractBlock(body, "scoring");
  if (scoringBlock) retrieval.scoring = parseScoringConfig(scoringBlock.body);

  return retrieval;
}

/**
 * Parse the `memory { ... }` block.
 *
 * Extracts known sub-blocks (domains, references, external-docs, metrics,
 * workspace) and returns them as a nested record.
 */
export function parseMemory(body: string, _unknownSubBlockWarnings?: Array<{ rule: string; level: "error" | "warning"; message: string; node?: string }>): { memory: Record<string, unknown>; stores: StoreNode[]; retrievals: RetrievalNode[] } {
  const memory: Record<string, unknown> = {};
  const stores: StoreNode[] = [];
  const retrievals: RetrievalNode[] = [];

  const knownSubs = [
    "domains",
    "references",
    "external-docs",
    "metrics",
    "workspace",
  ];
  const knownSubsSet = new Set([
    ...knownSubs,
    "store", "retrieval", // the two typed top-level blocks
  ]);

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

  // Parse store blocks (multiple named blocks)
  const storeBlocks = extractAllBlocks(body, "store");
  for (const block of storeBlocks) {
    if (!block.id) continue;
    stores.push(parseStore(block.id, block.body));
  }

  // Parse retrieval blocks (multiple named blocks)
  const retrievalBlocks = extractAllBlocks(body, "retrieval");
  for (const block of retrievalBlocks) {
    if (!block.id) continue;
    retrievals.push(parseRetrieval(block.id, block.body));
  }

  // Detect unknown sub-blocks. Only consider TOP-LEVEL blocks of the memory
  // body — names nested inside a `store {}` or `retrieval {}` (e.g. a brain
  // store's `sources { gmail {} }`) are that block's own concern, not memory
  // sub-blocks. Walk the body tracking brace depth so we only flag depth-0 names.
  if (_unknownSubBlockWarnings) {
    const mask = maskProse(body);
    let depth = 0;
    let i = 0;
    const braces = braceText(body);
    while (i < mask.length) {
      const ch = braces[i] === "{" || braces[i] === "}" ? braces[i] : mask[i];
      if (ch === "}") {
        depth = Math.max(0, depth - 1);
        i++;
        continue;
      }
      if (ch === "{") {
        depth++;
        i++;
        continue;
      }
      // At top level, match a block header before `{`. Handles both the bare
      // form (`workspace {`) and the typed-block form (`store brain {`,
      // `retrieval smart {`) — in the latter the FIRST token is the keyword.
      if (depth === 0) {
        const rest = mask.slice(i);
        const m = /^([a-zA-Z][a-zA-Z0-9_-]*)(?:\s+[a-zA-Z][a-zA-Z0-9_-]*)?\s*\{/.exec(rest);
        if (m && (i === 0 || /\s/.test(mask[i - 1]))) {
          const name = m[1]; // the leading keyword (store / retrieval / workspace / …)
          if (!knownSubsSet.has(name)) {
            _unknownSubBlockWarnings.push({
              rule: "V24",
              level: "warning",
              message: `Unknown sub-block "${name}" in memory block — known sub-blocks are: ${knownSubs.join(", ")}`,
            });
          }
          // Advance into the block (past the `{`) so its body is depth-counted.
          i += m[0].length;
          depth++;
          continue;
        }
      }
      i++;
    }
  }

  return { memory, stores, retrievals };
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
  for (const { name: envName, body: innerBody } of namedSubBlocks(body)) {
    const fields = parseFields(innerBody);
    const env: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      env[k] = unquote(v);
    }
    envs[envName] = env;
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
    if (fields.file) trigger.file = unquote(fields.file);
    triggers.push(trigger);
  }
  return triggers;
}

/**
 * Build a HookDef from a hook block's parsed fields. Shared by global and
 * per-agent hooks so the two cannot drift apart.
 */
function hookFromFields(name: string, fields: Record<string, string>): HookDef {
  return {
    name,
    on: fields.on ?? "",
    matcher: fields.matcher ? unquote(fields.matcher) : "",
    run: fields.run ? unquote(fields.run) : "",
    ...(fields.if ? { if: unquote(fields.if) } : {}),
    ...(fields.type ? { type: fields.type } : {}),
    ...(fields.flag ? { flag: unquote(fields.flag) } : {}),
    ...(fields.timeout
      ? { timeout: parseInt(fields.timeout, 10) }
      : {}),
    ...(fields.url ? { url: unquote(fields.url) } : {}),
    ...(fields.server ? { server: unquote(fields.server) } : {}),
    ...(fields.tool ? { tool: unquote(fields.tool) } : {}),
    ...(fields.async ? { async: fields.async === "true" } : {}),
    ...(fields.model ? { model: unquote(fields.model) } : {}),
    ...(fields.strength ? { strength: fields.strength } : {}),
    ...(fields.bypass ? { bypass: unquote(fields.bypass) } : {}),
  };
}

/**
 * Parse the global `hooks { ... }` block.
 */
export function parseHooks(
  body: string,
  _blockFieldMisuseWarnings?: Array<{ rule: string; level: "error" | "warning"; message: string; node?: string }>
): HookDef[] {
  const hooks: HookDef[] = [];
  const hookBlocks = extractAllBlocks(body, "hook");
  for (const block of hookBlocks) {
    if (!block.id) continue;
    const fields = parseFields(block.body);
    // V90: `hook h { on: Stop run: "x" }` makes `on` swallow the whole line
    // (run and type silently empty). Hooks were the one block V90 skipped.
    if (_blockFieldMisuseWarnings) {
      detectSwallowedFields(fields, block.id, _blockFieldMisuseWarnings);
    }
    const hook = hookFromFields(block.id, fields);

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

  for (const { name, body: innerBody } of namedSubBlocks(body)) {
    {
      const fields = parseFields(innerBody);
      const server: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(fields)) {
        server[k] = unquote(v);
      }
      // from: plugin "<name>": a server a Claude Code plugin provides. Any
      // other from: stays as written; validation (V130) reports it.
      const from = typeof fields.from === "string" ? /^plugin\s+(?:"([^"]+)"|([A-Za-z0-9._-]+))$/.exec(fields.from.trim()) : null;
      if (from) {
        server.from = "plugin";
        server.plugin = from[1] ?? from[2];
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
    // `prompt { ... }` holds the skill's instructions; `prompt: "path"` names a file holding them.
    const sPromptBlock = extractBlock(block.body, "prompt");
    if (sPromptBlock) sd.prompt = dedentBlock(sPromptBlock.body);
    else if (sFields.prompt) sd.prompt = unquote(sFields.prompt);
    if (sFields.file) sd.file = unquote(sFields.file);
    if (sFields["when-to-use"]) sd.whenToUse = unquote(sFields["when-to-use"]);
    if (sFields["argument-hint"]) sd.argumentHint = unquote(sFields["argument-hint"]);
    if (sFields.shell) sd.shell = sFields.shell;
    if (sFields.model) sd.model = sFields.model;
    if (sFields.thinking) sd.thinking = sFields.thinking;
    const sArguments = parseMultilineList(block.body, "arguments");
    if (sArguments.length) sd.arguments = sArguments;
    const sPaths = parseMultilineList(block.body, "paths");
    if (sPaths.length) sd.paths = sPaths;
    const sDisallowed = parseMultilineList(block.body, "disallowed-tools");
    if (sDisallowed.length) sd.disallowedTools = sDisallowed;

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
      // Check for `encrypted` modifier
      else if (rawValue.startsWith("encrypted ")) {
        const innerValue = rawValue.slice("encrypted ".length).trim();
        const unquoted = unquote(innerValue);
        const sv: SensitiveValue = {
          value: unquoted,
          sensitive: true,
          encrypted: true,
        };
        // Parse SOPS envelope: ENC[METHOD,data:...]
        const sopsMatch = unquoted.match(/^ENC\[([A-Z0-9_]+),data:/);
        if (sopsMatch) {
          sv.sopsMethod = sopsMatch[1];
        }
        result[kv[0]] = sv;
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
  // (past each closing brace, so a provider's sub-blocks are not providers)
  for (const { name, body: innerBody } of namedSubBlocks(body, true)) {
    {
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

      // Parse auth sub-block
      const authBlock = extractBlock(innerBody, "auth");
      if (authBlock) {
        const aFields = parseFields(authBlock.body);
        const auth: AuthDef = {
          type: aFields.type ?? "api-key",
        };
        if (aFields.issuer) auth.issuer = unquote(aFields.issuer);
        if (aFields.audience) auth.audience = unquote(aFields.audience);
        if (aFields["token-url"]) auth.tokenUrl = unquote(aFields["token-url"]);
        if (aFields["client-id"]) auth.clientId = unquote(aFields["client-id"]);
        const scopes = parseMultilineList(authBlock.body, "scopes");
        if (scopes.length) auth.scopes = scopes;
        provider.auth = auth;
      }

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
    if (fields.machine) job.machine = unquote(fields.machine);
    if (fields.carrier) job.carrier = unquote(fields.carrier);
    if (fields.survives) job.survives = unquote(fields.survives);
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

  for (const { name, body: innerBody } of namedSubBlocks(body)) {
    {
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
    if (tFields.command && unquote(tFields.command).trim()) td.command = unquote(tFields.command).trim();
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

/**
 * Parse the `checkpoint { ... }` block.
 *
 * Extracts KV fields plus an optional `replay { ... }` sub-block.
 * Returns a {@link CheckpointDef} with parsed connection supporting
 * the `secret "uri"` modifier.
 */
export function parseCheckpoint(body: string): CheckpointDef {
  const fields = parseFields(body);

  const def: CheckpointDef = {
    backend: fields.backend ?? "memory",
    strategy: fields.strategy ?? "every-node",
  };

  // Connection: may use `secret "uri"` modifier
  if (fields.connection) {
    const rawConn = fields.connection.trim();
    if (rawConn.startsWith("secret ")) {
      const uri = unquote(rawConn.slice("secret ".length).trim());
      def.connection = uri;
    } else {
      def.connection = unquote(rawConn);
    }
  }

  if (fields.ttl) def.ttl = fields.ttl;

  // Parse replay sub-block
  const replayBlock = extractBlock(body, "replay");
  if (replayBlock) {
    const rFields = parseFields(replayBlock.body);
    const replay: ReplayConfig = {
      enabled: rFields.enabled === "true",
    };
    if (rFields["max-history"]) {
      replay.maxHistory = parseInt(rFields["max-history"], 10);
    }
    if (rFields.branch) {
      replay.branch = rFields.branch === "true";
    }
    def.replay = replay;
  }

  return def;
}

/**
 * Parse the top-level `artifacts { artifact <id> { ... } ... }` block.
 *
 * Returns an array of artifact definitions with their dependencies.
 */
export function parseArtifacts(topBody: string): ArtifactDef[] {
  const artifactsBlock = extractBlock(topBody, "artifacts");
  if (!artifactsBlock) return [];

  const artifactBlocks = extractAllBlocks(artifactsBlock.body, "artifact");
  const artifacts: ArtifactDef[] = [];

  for (const block of artifactBlocks) {
    if (!block.id) continue;
    const fields = parseFields(block.body);
    const artifact: ArtifactDef = {
      id: block.id,
      type: fields.type ?? "unknown",
    };
    if (fields.path) artifact.path = unquote(fields.path);
    if (fields.retention) artifact.retention = fields.retention;
    const dependsOn = parseMultilineList(block.body, "depends-on");
    if (dependsOn.length) artifact.dependsOn = dependsOn;
    artifacts.push(artifact);
  }

  return artifacts;
}

/**
 * Parse the top-level `records { record <id> { path: "..." } }` block.
 * A record without a path is kept with an empty path so V112 can name it.
 */
export function parseRecords(topBody: string): RecordDef[] {
  const block = extractBlock(topBody, "records");
  if (!block) return [];
  return extractAllBlocks(block.body, "record")
    .filter((b) => b.id)
    .map((b) => ({ id: b.id!, path: unquote(parseFields(b.body).path ?? "") }));
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

/**
 * Parse an AgenTopology `.at` source string into a complete {@link TopologyAST}.
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
  // A block header written in prose (a prompt, a string, a comment) is text.
  const lines = maskProse(rawSource).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match: agent <id> {, action <id> {, gate <id> {, human <id> {, store <id> {, retrieval <id> {
    const namedMatch = line.match(/^\s*(?:agent|action|gate|human|group|store|retrieval|person)\s+([a-zA-Z][a-zA-Z0-9_-]*)\s*(?:\{|[^{]*\{)/);
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
  const mask = maskProse(topBody);
  const m = re.exec(mask);
  if (!m) return null;

  // Make sure we did not match "interfaces" — check what precedes the `{`
  const matchText = m[0];
  if (/interfaces/.test(matchText)) return null;

  // Find the opening brace and count braces to extract the body
  const braceIdx = m.index! + m[0].length;
  const end = closingBrace(braceText(topBody), braceIdx);
  if (end < 0) return null;

  const body = topBody.slice(braceIdx, end);
  return parseInterfaceEndpoints(body);
}

/**
 * Parse import statements from a topology body (or file top level).
 *
 * Forms:
 *   import alias from ./path.at
 *   import alias from "./path.at"
 *   import alias from registry:@org/pkg@1.2.0
 *   import alias from ./path.at sha256 "<hex>"      (or `sha256: "<hex>"`)
 *   import "./path.at" as alias                     (older form)
 * Any of them may be followed by `with { key: value ... }`.
 *
 * Only lines at brace depth zero are read. A line starting with `import` that
 * matches no form is returned in `errors`, never dropped (T02b).
 */
export function parseImportsDetailed(text: string): { imports: ImportDef[]; errors: string[] } {
  const imports: ImportDef[] = [];
  const errors: string[] = [];
  const lineRe = /^[ \t]*import\b([^\n]*)/gm;
  const aliasRe = "([a-zA-Z][a-zA-Z0-9_-]*)";
  let m: RegExpExecArray | null;
  let depth = 0;
  let scanned = 0;
  // Braces inside a quoted string or a # comment do not count toward depth.
  // A string ends at its closing quote or at the end of its line.
  let inString = false;
  let inComment = false;

  while ((m = lineRe.exec(text)) !== null) {
    for (; scanned < m.index; scanned++) {
      const ch = text[scanned];
      if (ch === "\n") {
        inString = false;
        inComment = false;
      } else if (inComment) {
        continue;
      } else if (inString) {
        if (ch === "\\") scanned++;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === "#") inComment = true;
      else if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    if (depth > 0) continue;
    const lineEnd = m.index + m[0].length;
    const rest = m[1];

    let source: string | undefined;
    let alias: string | undefined;
    let tail = "";
    const legacy = rest.match(new RegExp(`^\\s+"([^"]+)"\\s+as\\s+${aliasRe}(.*)$`));
    const from = rest.match(new RegExp(`^\\s+${aliasRe}\\s+from\\s+(?:"([^"]+)"|([^\\s"]+))(.*)$`));
    if (legacy) {
      [, source, alias, tail] = legacy;
    } else if (from) {
      alias = from[1];
      source = from[2] ?? from[3];
      tail = from[4];
    }
    if (source === undefined || alias === undefined) {
      errors.push(`unrecognized import form: "${m[0].trim()}" (use: import <alias> from <path> [sha256 "<hex>"])`);
      continue;
    }

    const params: Record<string, string | number | boolean> = {};
    const importDef: ImportDef = { source, alias, params };

    let sha: string | undefined;
    let withBody: string | undefined;
    const sm = tail.match(/^\s+sha256\s*:?\s*"([^"]+)"/);
    if (sm) {
      sha = sm[1];
      tail = tail.slice(sm[0].length);
    }
    let fullTail = tail + text.slice(lineEnd);
    const wm = fullTail.match(/^\s*with\s*\{([^}]*)\}/);
    if (wm) {
      withBody = wm[1];
      fullTail = fullTail.slice(wm[0].length);
    } else if (tail.trim() !== "") {
      errors.push(`unrecognized import form: "${m[0].trim()}" (unexpected "${tail.trim()}")`);
      continue;
    }
    if (withBody !== undefined) {
      for (const line of withBody.split("\n")) {
        const kv = parseKV(line);
        if (!kv) continue;
        const [key, rawVal] = kv;
        const val = unquote(rawVal);
        if (/^-?\d+(\.\d+)?$/.test(val)) params[key] = parseFloat(val);
        else if (val === "true" || val === "false") params[key] = val === "true";
        else params[key] = val;
      }
    }
    if (!sha) {
      // older form: sha256 after the with block
      const after = fullTail.match(/^\s*sha256\s*:\s*"([^"]+)"/);
      if (after) sha = after[1];
    }
    if (sha) importDef.sha256 = sha;

    // Registry: explicit `registry:` prefix, or (older form) not a relative path.
    const explicit = source.startsWith("registry:");
    const pkg = explicit ? source.slice("registry:".length) : source;
    if (explicit || (!source.startsWith("./") && !source.startsWith("../") && !source.startsWith("/"))) {
      importDef.registry = true;
      const atIdx = pkg.lastIndexOf("@");
      if (atIdx > 0) {
        importDef.registryPackage = pkg.slice(0, atIdx);
        importDef.registryVersion = pkg.slice(atIdx + 1);
      } else {
        importDef.registryPackage = pkg;
      }
    }
    imports.push(importDef);
  }
  return { imports, errors };
}

/** Parse import statements; see {@link parseImportsDetailed}. */
export function parseImports(body: string): ImportDef[] {
  return parseImportsDetailed(body).imports;
}

/**
 * Parse include statements from a topology body.
 *
 * Syntax: include "./path.at"
 */
export function parseIncludes(body: string): IncludeDef[] {
  const includes: IncludeDef[] = [];
  const re = /(?:^|\n)\s*include\s+"([^"]+)"/g;
  // An `include` line inside a prompt or a comment is text.
  const mask = maskProse(body);
  let m: RegExpExecArray | null;

  while ((m = re.exec(body)) !== null) {
    const at = m.index + m[0].indexOf("include");
    if (mask[at] !== "i") continue;
    includes.push({ source: m[1] });
  }

  return includes;
}

/**
 * Line numbers for offsets in the comment-stripped topology body. The body is
 * a slice of the source and stripComments keeps every line, so a line count
 * from the body's start in the source is exact.
 */
function topBodyLineFinder(source: string, rawBody: string, topBody: string): (at: number) => number {
  const start = source.indexOf(rawBody);
  const first = start < 0 ? 1 : source.slice(0, start).split("\n").length;
  return (at) => first + (topBody.slice(0, at).match(/\n/g)?.length ?? 0);
}

export function parse(source: string): TopologyAST {
  const src = stripComments(source);

  // --- Source map (line numbers for nodes) ---
  const sourceMap = buildSourceMap(source);

  // --- Detect fragment vs topology root ---
  // A `fragment x {` line in a prompt, a string or a comment is text.
  const sourceMask = maskProse(source);
  const isFragment = /(?:^|\n)\s*fragment\s+\S+\s*\{/.test(sourceMask);

  // --- Topology header ---
  let header: { name: string; patterns: string[] };
  if (isFragment) {
    // Fragment header: fragment <name> { ... }
    const fm = sourceMask.match(/fragment\s+(\S+)\s*\{/);
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
  // V89/V90: collected while parsing blocks — a field written in a form the
  // grammar does not define. Attached to the AST below.
  const blockFieldMisuseWarnings: Array<{ rule: string; level: "error" | "warning"; message: string; node?: string }> = [];

  const metaFields = metaBlock ? parseMeta(metaBlock.body) : {};
  detectSwallowedFields(metaFields as Record<string, string>, "<meta>", blockFieldMisuseWarnings);

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
    ...(metaFields.entry !== undefined ? { entry: metaFields.entry } : {}),
    ...(metaFields.durable !== undefined ? { durable: metaFields.durable } : {}),
  };

  // --- Roles ---
  const rolesBlock = extractBlock(topBody, "roles");
  const roles = rolesBlock ? parseRoles(rolesBlock.body) : {};

  // --- Nodes ---
  const nodes: NodeDef[] = [];


  // Orchestrator
  const orchBlock = extractBlock(topBody, "orchestrator");
  if (orchBlock) {
    nodes.push(parseOrchestrator(orchBlock.body, blockFieldMisuseWarnings));
  }

  // Actions
  const actionBlocks = extractAllBlocks(topBody, "action");
  for (const block of actionBlocks) {
    if (block.id) {
      nodes.push(parseAction(block.id, block.body, blockFieldMisuseWarnings));
    }
  }

  // Agents
  const agentBlocks = extractAllBlocks(topBody, "agent");
  for (const block of agentBlocks) {
    if (block.id) {
      nodes.push(parseAgent(block.id, block.body, roles, blockFieldMisuseWarnings));
    }
  }

  // Gates
  const gatesBlock = extractBlock(topBody, "gates");
  if (gatesBlock) {
    const gateBlocks = extractAllBlocks(gatesBlock.body, "gate");
    for (const block of gateBlocks) {
      if (block.id) {
        nodes.push(parseGate(block.id, block.body, blockFieldMisuseWarnings));
      }
    }
  }

  // Human nodes
  const humanBlocks = extractAllBlocks(topBody, "human");
  for (const block of humanBlocks) {
    if (block.id) {
      nodes.push(parseHuman(block.id, block.body, blockFieldMisuseWarnings));
    }
  }

  // Group chat nodes
  const groupBlocks = extractAllBlocks(topBody, "group");
  for (const block of groupBlocks) {
    if (block.id) {
      nodes.push(parseGroup(block.id, block.body, blockFieldMisuseWarnings));
    }
  }

  // --- Skills ---
  const skillDefs = parseSkillBlocks(topBody);

  // --- Tools ---
  const toolDefs = parseToolsBlock(topBody);

  // --- Edges (flow) ---
  const flowBlock = extractBlock(topBody, "flow");
  const edgeAttributeErrors: Array<{ rule: string; level: "error" | "warning"; message: string; node?: string }> = [];
  const talkErrors: string[] = [];
  const edges = flowBlock
    ? expandTalk(flowBlock.body, nodes, parseFlow(flowBlock.body, edgeAttributeErrors), talkErrors)
    : [];

  // --- Decisions (topology-level `decisions: [...]`) ---
  // A list may span lines and its quoted items may hold `]` (parseMultilineList).
  const topText = depthZeroText(topBody);
  const decisionsList = parseMultilineList(topText, "decisions");
  const decisionsField = decisionsList.length ? null : topText.match(/(?:^|\n)[ \t]*decisions[ \t]*:[ \t]*([^\n]*)/);
  const decisions = decisionsList.length ? decisionsList : decisionsField ? parseList(decisionsField[1]) : undefined;

  const pinField = depthZeroText(topBody).match(/(?:^|\n)[ \t]*pin-models[ \t]*:[ \t]*(true|false)\b/);
  const pinModels = pinField ? pinField[1] === "true" : undefined;

  // --- Machines (top-level `machines { machine <id> { os: ... } }`) ---
  const machinesBlock = extractBlock(topBody, "machines");
  const machines: MachineDef[] | undefined = machinesBlock
    ? extractAllBlocks(machinesBlock.body, "machine").filter((b) => b.id).map((b) => {
        const f = parseFields(b.body);
        return { id: b.id as string, ...(f.os ? { os: unquote(f.os) } : {}) };
      })
    : undefined;

  // --- People (top-level `person <id> { away: "..." }`) ---
  const personBlocks = extractAllBlocks(topBody, "person").filter((b) => b.id);
  const persons: PersonDef[] | undefined = personBlocks.length
    ? personBlocks.map((b) => {
        const f = parseFields(b.body);
        return { id: b.id as string, ...(f.away ? { away: unquote(f.away) } : {}) };
      })
    : undefined;

  // --- Inventory roots (top-level `inventory { roots: ["harness/"] }`) ---
  const inventoryBlock = extractBlock(topBody, "inventory");
  const inventoryRootsField = inventoryBlock ? parseFields(inventoryBlock.body).roots : undefined;
  const inventoryRoots = inventoryRootsField ? parseList(inventoryRootsField).map(unquote) : undefined;

  // --- Needs outside the repo (top-level `needs { memory: "~/x" connectors: [..] user-skills: [..] }`) ---
  const needsBlock = extractBlock(topBody, "needs");
  const needs: NeedsDef | undefined = needsBlock
    ? (() => {
        // The fields may share a line: `needs { memory: "~/m"  connectors: [a] }`.
        const f = parseFields(needsBlock.body.replace(/[ \t]+(?=(?:memory|connectors|user-skills)[ \t]*:)/g, "\n"));
        return {
          ...(f.memory ? { memory: unquote(f.memory) } : {}),
          ...(f.connectors ? { connectors: parseList(f.connectors).map(unquote) } : {}),
          ...(f["user-skills"] ? { userSkills: parseList(f["user-skills"]).map(unquote) } : {}),
        };
      })()
    : undefined;

  // --- Depth ---
  const depthBlock = extractBlock(topBody, "depth");
  const depth = depthBlock
    ? parseDepth(depthBlock.body)
    : { factors: [], levels: [] };

  // --- Memory ---
  const memoryBlock = extractBlock(topBody, "memory");
  const unknownMemorySubBlockWarnings: Array<{ rule: string; level: "error" | "warning"; message: string; node?: string }> = [];
  const memoryResult = memoryBlock ? parseMemory(memoryBlock.body, unknownMemorySubBlockWarnings) : { memory: {}, stores: [], retrievals: [] };
  const memory = memoryResult.memory;
  const stores = memoryResult.stores;
  const retrievals = memoryResult.retrievals;

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
  // Every top-level `hooks { }` block, merged in file order. Only the first
  // block holding a global hook used to be read: a second block validated and
  // never reached settings.json. A hook name used twice is an error (V23).
  // An agent's first `hooks { }` block is the agent's own (parseAgent). Its
  // second and later blocks are project hooks, merged here in file order:
  // 0.11.4 wrote them to settings.json, and a settings.json hook refuses even
  // before the folder is trusted, where an agent's frontmatter hook does not.
  const lineInTopBody = topBodyLineFinder(source, topoBlock.body, topBody);
  const hookSources: Array<{ at: number; body: string; owner?: string }> = extractTopLevelBlocks(topBody, "hooks").map(
    (hb) => ({ at: hb.at ?? 0, body: hb.body })
  );
  let agentCursor = 0;
  for (const block of agentBlocks) {
    const bodyAt = topBody.indexOf(block.body, agentCursor);
    if (bodyAt < 0) continue;
    agentCursor = bodyAt + block.body.length;
    if (!block.id) continue;
    for (const hb of agentHookBlocks(block.body).slice(1)) {
      hookSources.push({ at: bodyAt + (hb.at ?? 0), body: hb.body, owner: block.id });
    }
  }
  hookSources.sort((a, b) => a.at - b.at);
  const hooks: HookDef[] = [];
  const hookLines = new Map<string, Array<{ line: number; owner?: string }>>();
  for (const hb of hookSources) {
    const blockLine = lineInTopBody(hb.at);
    for (const h of parseHooks(hb.body, blockFieldMisuseWarnings)) {
      hooks.push(h);
      hookLines.set(h.name, [...(hookLines.get(h.name) ?? []), { line: blockLine, owner: hb.owner }]);
    }
  }
  const duplicateHookErrors: Array<{ rule: string; level: "error" | "warning"; message: string; node?: string }> = [];
  for (const [name, seen] of hookLines) {
    if (seen.length < 2) continue;
    // Every copy inside one agent's blocks: agentHookDuplicates names the agent.
    if (seen[0].owner && seen.every((s) => s.owner === seen[0].owner)) continue;
    const lines = seen.map((s) => s.line);
    // Across blocks it is an error: the second block used to vanish, so no
    // reading of the file is safe. Twice in one block validated in 0.11.4 and
    // both hooks were kept, so it stays a warning there.
    const oneBlock = new Set(lines).size === 1;
    const where = oneBlock
      ? `twice in the hooks block on line ${lines[0]}`
      : `in the hooks blocks on lines ${[...new Set(lines)].join(" and ")}`;
    duplicateHookErrors.push({
      rule: "V23",
      level: oneBlock ? "warning" : "error",
      node: name,
      message: `Hook "${name}" is declared ${where}: a hook name must be unique — rename or remove one`,
    });
  }
  for (const block of agentBlocks) {
    if (block.id) duplicateHookErrors.push(...agentHookDuplicates(block.id, block.body));
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
  // Only a top-level `env`: an MCP server's env, or `environments`, is not
  // the topology's (S-13).
  const envBlock = extractTopLevelBlocks(topBody, "env")[0];
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

  // --- Checkpoint ---
  const checkpointBlock = extractBlock(topBody, "checkpoint");
  const checkpoint = checkpointBlock ? parseCheckpoint(checkpointBlock.body) : null;

  // --- Artifacts ---
  const artifacts = parseArtifacts(topBody);

  // --- Records ---
  const records = parseRecords(topBody);

  // --- Top-level Extensions ---
  // Only an `extensions` block at the topology's own level. The first one
  // anywhere used to win, so an agent's extensions (effort, color, ...) were
  // read as topology-wide and written into settings.json.
  const topExtAt = depthZeroText(topBody).search(/(?:^|\n)\s*extensions\s*\{/);
  const topLevelExtensions = topExtAt === -1 ? undefined : parseExtensionsBlock(topBody.slice(topExtAt));

  // --- Params ---
  const paramsBlock = extractBlock(topBody, "params");
  const params = paramsBlock ? parseParams(paramsBlock.body) : [];

  // --- Interface (entry/exit endpoints) ---
  // Note: "interface" block is distinct from "interfaces" (external interface definitions).
  // We use a targeted regex to avoid matching "interfaces" when looking for "interface".
  const interfaceEndpoints = parseInterfaceBlock(topBody);

  // --- Imports ---
  // Read the file top level too: an import above the `topology` line used to
  // be dropped with no message (T02b).
  const topImports = parseImportsDetailed(stripComments(source).replace(/(?:^|\n)[ \t]*(?:topology|fragment)\b[^{\n]*\{[\s\S]*$/, "\n"));
  const bodyImports = parseImportsDetailed(topBody);
  const imports = [...topImports.imports, ...bodyImports.imports];
  const importErrors = [...topImports.errors, ...bodyImports.errors].map((message) => ({
    rule: "V8", level: "error" as const, message,
  }));

  // --- Includes ---
  const includes = parseIncludes(topBody);

  // --- Duplicate section detection ---
  // A section that may appear once (see sections.ts): a second copy is a
  // warning that names it. Machines, extensions, inventory and needs used to
  // say nothing at all.
  const duplicateSectionWarnings: Array<{ rule: string; level: "error" | "warning"; message: string; node?: string }> = [];
  for (const keyword of SINGLE_SECTIONS) {
    // A block of the same name nested in another section (an MCP server's
    // env) is not a second top-level one.
    const allBlocks = extractTopLevelBlocks(topBody, keyword);
    if (allBlocks.length > 1) {
      duplicateSectionWarnings.push({
        rule: "V23",
        level: "warning",
        message: `Duplicate "${keyword}" block detected (found ${allBlocks.length}) — only the first occurrence is used`,
      });
    }
  }
  duplicateSectionWarnings.push(...duplicateHookErrors);

  // --- Blocks outside their container ---
  // `gate x { }` written beside `gates { }` instead of inside it was dropped
  // with no message, and validate passed (N21). Only keywords that never stand
  // at the top level are checked, so no valid section can be flagged.
  const CONTAINER_OF: Record<string, string> = {
    gate: "gates", hook: "hooks", tool: "tools", job: "schedule", command: "triggers", level: "depth",
  };
  const misplacedBlockErrors: Array<{ rule: string; level: "error" | "warning"; message: string; node?: string }> = [];
  for (const m of depthZeroText(topBody).matchAll(/^[ \t]*(gate|hook|tool|job|command|level)\s+([\w-]+)[^\n{]*\{/gm)) {
    const container = CONTAINER_OF[m[1]];
    misplacedBlockErrors.push({
      rule: "V98",
      level: "error",
      message: `"${m[1]} ${m[2]}" is outside a "${container} { }" block, so it is ignored — move it inside "${container} { ... }"`,
    });
  }

  // --- Names the parser does not read ---
  // A field or block the grammar does not have was dropped with no message,
  // and validate passed (N23). V102 names each one with its block.
  const unknownNameErrors = findUnknownNames(topBody);
  // F5: since S-13 only a top-level `env { }` is the topology env; the keys of
  // one inside `settings { }` are not written to settings.json.
  const settingsEnv = settingsBlock ? extractTopLevelBlocks(settingsBlock.body, "env")[0] : undefined;
  const droppedEnv = settingsEnv ? Object.keys(parseEnv(settingsEnv.body)) : [];
  if (droppedEnv.length > 0) {
    unknownNameErrors.push({
      rule: "V102",
      level: "warning",
      message: `\`env\` is not a settings field, so its keys (${droppedEnv.join(", ")}) are not written to settings.json. Move them to a top-level env { } block.`,
    });
  }

  // --- Assemble AST ---
  const ast: TopologyAST & {
    _unknownNameErrors?: typeof unknownNameErrors;
    _edgeAttributeErrors?: typeof edgeAttributeErrors;
    _talkErrors?: string[];
    _duplicateSectionWarnings?: typeof duplicateSectionWarnings;
    _misplacedBlockErrors?: typeof misplacedBlockErrors;
    _unknownMemorySubBlockWarnings?: typeof unknownMemorySubBlockWarnings;
    _blockFieldMisuseWarnings?: typeof blockFieldMisuseWarnings;
    _lostStructure?: ReturnType<typeof findLostStructure>;
    _sourceMap?: Record<string, number>;
  } = {
    topology,
    nodes,
    edges,
    depth,
    memory,
    stores,
    retrievals,
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
    checkpoint,
    artifacts,
    records,
    ...(decisions ? { decisions } : {}),
    ...(pinModels !== undefined ? { pinModels } : {}),
    ...(machines ? { machines } : {}),
    ...(persons ? { persons } : {}),
    ...(inventoryRoots?.length ? { inventoryRoots } : {}),
    ...(needs ? { needs } : {}),
    ...(isFragment ? { isFragment: true } : {}),
  };

  if (talkErrors.length > 0) ast._talkErrors = talkErrors;

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

  if (importErrors.length > 0) {
    (ast as TopologyAST & { _importErrors?: typeof importErrors })._importErrors = importErrors;
  }

  // Attach V89 block-vs-KV field misuse errors for the validator to consume.
  if (misplacedBlockErrors.length > 0) {
    ast._misplacedBlockErrors = misplacedBlockErrors;
  }
  if (blockFieldMisuseWarnings.length > 0) {
    ast._blockFieldMisuseWarnings = blockFieldMisuseWarnings;
  }
  if (unknownNameErrors.length > 0) {
    ast._unknownNameErrors = unknownNameErrors;
  }

  // V131: a block the source declares that the parse does not hold as written.
  const lostStructure = findLostStructure(source, isFragment ? "fragment" : "topology", new Set(nodes.map((n) => n.id)));
  if (lostStructure.length > 0) {
    ast._lostStructure = lostStructure;
  }

  // Attach source map for line number tracking in validation results.
  if (Object.keys(sourceMap).length > 0) {
    ast._sourceMap = sourceMap;
  }

  return ast;
}
