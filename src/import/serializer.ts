/**
 * AST serializer — converts a TopologyAST back to .at source text.
 *
 * This is the inverse of the parser. The output must be valid .at syntax
 * that round-trips through `parse()` without errors.
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
  CircuitBreakerConfig,
  ScaleDef,
  SchemaFieldDef,
  SchemaType,
  HookDef,
  SkillDef,
  ToolBlockDef,
  ProviderDef,
  ScheduleJobDef,
  InterfaceDef,
  SensitiveValue,
  MeteringDef,
  CheckpointDef,
  ArtifactDef,
  ParamDef,
  PromptVariant,
  StoreNode,
  RetrievalNode,
} from "../parser/ast.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Quote a string if it contains spaces, special chars, or is empty. */
function q(s: string): string {
  if (!s) return '""';
  if (/[\s#:{}[\],|]/.test(s) || s.includes('"')) return `"${s.replace(/"/g, '\\"')}"`;
  return s;
}

/** Format a list inline: [a, b, c] */
function inlineList(items: string[]): string {
  return `[${items.map(q).join(", ")}]`;
}

/** Indent each line of text by n spaces. */
function indent(text: string, n: number): string {
  const pad = " ".repeat(n);
  return text
    .split("\n")
    .map((line) => (line.trim() ? pad + line : ""))
    .join("\n");
}

function formatSchemaType(t: SchemaType): string {
  switch (t.kind) {
    case "primitive": return t.value;
    case "array": return `${formatSchemaType(t.itemType)}[]`;
    case "enum": return t.values.join(" | ");
    case "ref": return t.name;
  }
}

// ---------------------------------------------------------------------------
// Section serializers
// ---------------------------------------------------------------------------

function serializeMeta(ast: TopologyAST): string {
  const meta = ast.topology;
  const lines: string[] = [];
  lines.push("  meta {");
  if (meta.version) lines.push(`    version: "${meta.version}"`);
  if (meta.description) lines.push(`    description: "${meta.description}"`);
  if (meta.domain) lines.push(`    domain: ${q(meta.domain)}`);
  if (meta.foundations?.length) lines.push(`    foundations: ${inlineList(meta.foundations)}`);
  if (meta.advanced?.length) lines.push(`    advanced: ${inlineList(meta.advanced)}`);
  if (meta.timeout) lines.push(`    timeout: ${q(meta.timeout)}`);
  if (meta.errorHandler) lines.push(`    error-handler: ${meta.errorHandler}`);
  if (meta.durable) lines.push("    durable: true");
  lines.push("  }");
  return lines.join("\n");
}

function serializeOrchestrator(node: OrchestratorNode): string {
  const lines: string[] = [];
  lines.push("  orchestrator {");
  lines.push(`    model: ${node.model}`);
  if (node.generates) lines.push(`    generates: "${node.generates}"`);
  if (node.handles.length) lines.push(`    handles: ${inlineList(node.handles)}`);
  if (node.outputs) {
    lines.push("    outputs: {");
    for (const [field, values] of Object.entries(node.outputs)) {
      lines.push(`      ${field}: ${values.join(" | ")}`);
    }
    lines.push("    }");
  }
  lines.push("  }");
  return lines.join("\n");
}

function serializeRoles(roles: Record<string, string>): string | null {
  const entries = Object.entries(roles);
  if (entries.length === 0) return null;
  const lines: string[] = ["  roles {"];
  for (const [name, desc] of entries) {
    lines.push(`    ${name}: "${desc}"`);
  }
  lines.push("  }");
  return lines.join("\n");
}

function serializeOutputs(outputs: OutputsMap, pad: string): string[] {
  const lines: string[] = [];
  lines.push(`${pad}outputs: {`);
  for (const [field, values] of Object.entries(outputs)) {
    lines.push(`${pad}  ${field}: ${values.join(" | ")}`);
  }
  lines.push(`${pad}}`);
  return lines;
}

function serializeRetry(retry: number | RetryConfig, pad: string): string[] {
  if (typeof retry === "number") {
    return [`${pad}retry: ${retry}`];
  }
  const lines: string[] = [`${pad}retry {`];
  lines.push(`${pad}  max: ${retry.max}`);
  if (retry.backoff) lines.push(`${pad}  backoff: ${retry.backoff}`);
  if (retry.interval) lines.push(`${pad}  interval: ${retry.interval}`);
  if (retry.maxInterval) lines.push(`${pad}  max-interval: ${retry.maxInterval}`);
  if (retry.jitter) lines.push(`${pad}  jitter: true`);
  if (retry.nonRetryable?.length) lines.push(`${pad}  non-retryable: ${inlineList(retry.nonRetryable)}`);
  lines.push(`${pad}}`);
  return lines;
}

function serializeAgent(node: AgentNode): string {
  const lines: string[] = [];
  lines.push(`  agent ${node.id} {`);

  if (node.role) lines.push(`    role: ${node.role}`);
  if (node.model) lines.push(`    model: ${node.model}`);
  if (node.permissions) lines.push(`    permissions: ${node.permissions}`);
  if (node.phase !== undefined) lines.push(`    phase: ${node.phase}`);
  if (node.description) lines.push(`    description: "${node.description}"`);
  if (node.tools?.length) lines.push(`    tools: ${inlineList(node.tools)}`);
  if (node.disallowedTools?.length) lines.push(`    disallowed-tools: ${inlineList(node.disallowedTools)}`);
  if (node.skills?.length) lines.push(`    skills: ${inlineList(node.skills)}`);
  if (node.reads?.length) lines.push(`    reads: ${inlineList(node.reads)}`);
  if (node.writes?.length) lines.push(`    writes: ${inlineList(node.writes)}`);
  if (node.outputs) lines.push(...serializeOutputs(node.outputs, "    "));
  if (node.mcpServers?.length) lines.push(`    mcp-servers: ${inlineList(node.mcpServers)}`);
  if (node.isolation) lines.push(`    isolation: ${node.isolation}`);
  if (node.background) lines.push("    background: true");
  if (node.sandbox !== undefined) {
    lines.push(`    sandbox: ${typeof node.sandbox === "boolean" ? node.sandbox : q(node.sandbox)}`);
  }
  if (node.fallbackChain?.length) lines.push(`    fallback-chain: ${inlineList(node.fallbackChain)}`);
  if (node.maxTurns) lines.push(`    max-turns: ${node.maxTurns}`);
  if (node.timeout) lines.push(`    timeout: ${q(node.timeout)}`);
  if (node.onFail) lines.push(`    on-fail: ${node.onFail}`);
  if (node.behavior) lines.push(`    behavior: ${node.behavior}`);
  if (node.invocation) lines.push(`    invocation: ${node.invocation}`);
  if (node.skip) lines.push(`    skip: ${q(node.skip)}`);
  if (node.join) lines.push(`    join: ${node.join}`);
  if (node.compensates) lines.push(`    compensates: ${node.compensates}`);
  if (node.temperature !== undefined) lines.push(`    temperature: ${node.temperature}`);
  if (node.maxTokens !== undefined) lines.push(`    max-tokens: ${node.maxTokens}`);
  if (node.topP !== undefined) lines.push(`    top-p: ${node.topP}`);
  if (node.topK !== undefined) lines.push(`    top-k: ${node.topK}`);
  if (node.stop?.length) lines.push(`    stop: ${inlineList(node.stop)}`);
  if (node.seed !== undefined) lines.push(`    seed: ${node.seed}`);
  if (node.thinking) lines.push(`    thinking: ${node.thinking}`);
  if (node.thinkingBudget) lines.push(`    thinking-budget: ${node.thinkingBudget}`);
  if (node.outputFormat) lines.push(`    output-format: ${node.outputFormat}`);
  if (node.logLevel) lines.push(`    log-level: ${node.logLevel}`);
  if (node.rateLimit) lines.push(`    rate-limit: ${q(node.rateLimit)}`);
  if (node.retry !== undefined) lines.push(...serializeRetry(node.retry, "    "));

  if (node.circuitBreaker) {
    const cb = node.circuitBreaker;
    lines.push("    circuit-breaker {");
    lines.push(`      threshold: ${cb.threshold}`);
    lines.push(`      window: ${cb.window}`);
    lines.push(`      cooldown: ${cb.cooldown}`);
    lines.push("    }");
  }

  if (node.scale) {
    const s = node.scale;
    lines.push("    scale {");
    lines.push(`      mode: ${s.mode}`);
    lines.push(`      by: ${q(s.by)}`);
    lines.push(`      min: ${s.min}`);
    lines.push(`      max: ${s.max}`);
    if (s.batchSize !== null) lines.push(`      batch-size: ${s.batchSize}`);
    lines.push("    }");
  }

  if (node.inputSchema?.length) {
    lines.push("    input-schema {");
    for (const f of node.inputSchema) {
      lines.push(`      ${f.name}${f.optional ? "?" : ""}: ${formatSchemaType(f.type)}`);
    }
    lines.push("    }");
  }

  if (node.outputSchema?.length) {
    lines.push("    output-schema {");
    for (const f of node.outputSchema) {
      lines.push(`      ${f.name}${f.optional ? "?" : ""}: ${formatSchemaType(f.type)}`);
    }
    lines.push("    }");
  }

  if (node.produces?.length) lines.push(`    produces: ${inlineList(node.produces)}`);
  if (node.consumes?.length) lines.push(`    consumes: ${inlineList(node.consumes)}`);

  if (node.variants?.length) {
    for (const v of node.variants) {
      lines.push(`    variant ${v.id} {`);
      lines.push(`      weight: ${v.weight}`);
      if (v.model) lines.push(`      model: ${v.model}`);
      if (v.temperature !== undefined) lines.push(`      temperature: ${v.temperature}`);
      if (v.prompt) {
        lines.push("      prompt {");
        lines.push(indent(v.prompt, 8));
        lines.push("      }");
      }
      lines.push("    }");
    }
  }

  if (node.hooks?.length) {
    for (const hook of node.hooks) {
      lines.push(...serializeHook(hook, "    "));
    }
  }

  if (node.extensions) {
    for (const [binding, fields] of Object.entries(node.extensions)) {
      lines.push(`    extensions {`);
      lines.push(`      ${binding} {`);
      for (const [k, v] of Object.entries(fields)) {
        lines.push(`        ${k}: ${JSON.stringify(v)}`);
      }
      lines.push("      }");
      lines.push("    }");
    }
  }

  if (node.prompt) {
    lines.push("    prompt {");
    lines.push(indent(node.prompt, 6));
    lines.push("    }");
  }

  lines.push("  }");
  return lines.join("\n");
}

function serializeAction(node: ActionNode): string {
  const lines: string[] = [];
  lines.push(`  action ${node.id} {`);
  if (node.kind) lines.push(`    kind: ${node.kind}`);
  if (node.description) lines.push(`    description: "${node.description}"`);
  if (node.source) lines.push(`    source: "${node.source}"`);
  if (node.commands?.length) {
    lines.push("    commands: [");
    for (const cmd of node.commands) {
      lines.push(`      "${cmd}"`);
    }
    lines.push("    ]");
  }
  if (node.timeout) lines.push(`    timeout: ${q(node.timeout)}`);
  if (node.onFail) lines.push(`    on-fail: ${node.onFail}`);
  if (node.join) lines.push(`    join: ${node.join}`);
  lines.push("  }");
  return lines.join("\n");
}

function serializeGate(node: GateNode): string {
  const lines: string[] = [];
  lines.push(`    gate ${node.id} {`);
  if (node.after) lines.push(`      after: ${node.after}`);
  if (node.before) lines.push(`      before: ${node.before}`);
  if (node.run) lines.push(`      run: "${node.run}"`);
  if (node.checks?.length) lines.push(`      checks: ${inlineList(node.checks)}`);
  if (node.onFail) lines.push(`      on-fail: ${node.onFail}`);
  if (node.retry) lines.push(`      retry: ${node.retry}`);
  if (node.behavior) lines.push(`      behavior: ${node.behavior}`);
  if (node.timeout) lines.push(`      timeout: ${q(node.timeout)}`);
  lines.push("    }");
  return lines.join("\n");
}

function serializeHuman(node: HumanNode): string {
  const lines: string[] = [];
  lines.push(`  human ${node.id} {`);
  if (node.description) lines.push(`    description: "${node.description}"`);
  if (node.timeout) lines.push(`    timeout: ${q(node.timeout)}`);
  if (node.onTimeout) lines.push(`    on-timeout: ${node.onTimeout}`);
  lines.push("  }");
  return lines.join("\n");
}

function serializeGroup(node: GroupNode): string {
  const lines: string[] = [];
  lines.push(`  group ${node.id} {`);
  if (node.members?.length) lines.push(`    members: ${inlineList(node.members)}`);
  if (node.speakerSelection) lines.push(`    speaker-selection: ${q(node.speakerSelection)}`);
  if (node.maxRounds) lines.push(`    max-rounds: ${node.maxRounds}`);
  if (node.termination) lines.push(`    termination: "${node.termination}"`);
  if (node.description) lines.push(`    description: "${node.description}"`);
  if (node.timeout) lines.push(`    timeout: ${q(node.timeout)}`);
  lines.push("  }");
  return lines.join("\n");
}

function serializeEdge(edge: EdgeDef): string {
  let line = `    ${edge.from} -> ${edge.to}`;
  const attrs: string[] = [];

  if (edge.isError) {
    const errPart = edge.errorType ? `x[${edge.errorType}]` : "x";
    line = `    ${edge.from} -${errPart}-> ${edge.to}`;
  }

  if (edge.condition) attrs.push(`when ${edge.condition}`);
  if (edge.maxIterations) attrs.push(`max ${edge.maxIterations}`);
  if (edge.per) attrs.push(`per ${edge.per}`);
  if (edge.race) attrs.push("race");
  if (edge.tolerance !== undefined) attrs.push(`tolerance: ${edge.tolerance}`);
  if (edge.wait) attrs.push(`wait ${edge.wait}`);
  if (edge.weight !== undefined) attrs.push(`weight ${edge.weight}`);
  if (edge.reflection) attrs.push("reflection");

  if (attrs.length > 0) {
    line += ` [${attrs.join(", ")}]`;
  }

  return line;
}

function serializeFlow(edges: EdgeDef[]): string | null {
  if (edges.length === 0) return null;
  const lines: string[] = ["  flow {"];
  for (const edge of edges) {
    lines.push(serializeEdge(edge));
  }
  lines.push("  }");
  return lines.join("\n");
}

function serializeGates(gates: GateNode[]): string | null {
  if (gates.length === 0) return null;
  const lines: string[] = ["  gates {"];
  for (const gate of gates) {
    lines.push(serializeGate(gate));
  }
  lines.push("  }");
  return lines.join("\n");
}

function serializeHook(hook: HookDef, pad: string): string[] {
  const lines: string[] = [];
  lines.push(`${pad}hook ${hook.name} {`);
  lines.push(`${pad}  on: ${hook.on}`);
  if (hook.matcher) lines.push(`${pad}  matcher: ${q(hook.matcher)}`);
  lines.push(`${pad}  run: "${hook.run}"`);
  if (hook.type) lines.push(`${pad}  type: ${hook.type}`);
  if (hook.timeout) lines.push(`${pad}  timeout: ${hook.timeout}`);
  lines.push(`${pad}}`);
  return lines;
}

function serializeHooks(hooks: HookDef[]): string | null {
  if (hooks.length === 0) return null;
  const lines: string[] = ["  hooks {"];
  for (const hook of hooks) {
    lines.push(...serializeHook(hook, "    "));
  }
  lines.push("  }");
  return lines.join("\n");
}

function serializeSettings(settings: Record<string, unknown>): string | null {
  const allow = settings.allow as string[] | undefined;
  const deny = settings.deny as string[] | undefined;
  const ask = settings.ask as string[] | undefined;
  if (!allow?.length && !deny?.length && !ask?.length) return null;

  const lines: string[] = ["  settings {"];
  if (allow?.length) lines.push(`    allow: ${inlineList(allow)}`);
  if (deny?.length) lines.push(`    deny: ${inlineList(deny)}`);
  if (ask?.length) lines.push(`    ask: ${inlineList(ask)}`);
  lines.push("  }");
  return lines.join("\n");
}

function serializeMcpServers(servers: Record<string, Record<string, unknown>>): string | null {
  const entries = Object.entries(servers);
  if (entries.length === 0) return null;

  const lines: string[] = ["  mcp-servers {"];
  for (const [name, config] of entries) {
    lines.push(`    ${name} {`);
    for (const [k, v] of Object.entries(config)) {
      if (Array.isArray(v)) {
        lines.push(`      ${k}: ${inlineList(v.map(String))}`);
      } else if (typeof v === "object" && v !== null) {
        lines.push(`      ${k} {`);
        for (const [ek, ev] of Object.entries(v as Record<string, unknown>)) {
          lines.push(`        ${ek}: ${q(String(ev))}`);
        }
        lines.push("      }");
      } else {
        lines.push(`      ${k}: ${q(String(v))}`);
      }
    }
    lines.push("    }");
  }
  lines.push("  }");
  return lines.join("\n");
}

function serializeTriggers(triggers: { name: string; pattern: string; argument?: string }[]): string | null {
  if (triggers.length === 0) return null;
  const lines: string[] = ["  triggers {"];
  for (const t of triggers) {
    lines.push(`    command ${t.name} {`);
    lines.push(`      pattern: "${t.pattern}"`);
    if (t.argument) lines.push(`      argument: ${t.argument}`);
    lines.push("    }");
  }
  lines.push("  }");
  return lines.join("\n");
}

function serializeMemory(memory: Record<string, unknown>): string | null {
  const entries = Object.entries(memory);
  if (entries.length === 0) return null;

  const lines: string[] = ["  memory {"];
  for (const [key, value] of entries) {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      lines.push(`    ${key} {`);
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (Array.isArray(v)) {
          lines.push(`      ${k}: ${inlineList(v.map(String))}`);
        } else {
          lines.push(`      ${k}: ${q(String(v))}`);
        }
      }
      lines.push("    }");
    } else if (Array.isArray(value)) {
      lines.push(`    ${key}: ${inlineList(value.map(String))}`);
    } else {
      lines.push(`    ${key}: ${q(String(value))}`);
    }
  }
  lines.push("  }");
  return lines.join("\n");
}

function serializeStores(stores: StoreNode[]): string[] {
  const blocks: string[] = [];
  for (const store of stores) {
    const lines: string[] = [];
    lines.push(`    store ${store.id} {`);
    lines.push(`      type: ${store.type}`);
    if (store.description) lines.push(`      description: ${q(store.description)}`);
    if (store.scope) lines.push(`      scope: ${store.scope}`);
    if (store.isolation) lines.push(`      isolation: ${store.isolation}`);
    lines.push(`      backend: ${store.backend}`);
    if (store.path) lines.push(`      path: ${q(store.path)}`);
    if (store.connection) lines.push(`      connection: secret ${q(store.connection)}`);
    if (store.extraction) lines.push(`      extraction: ${store.extraction}`);

    // Embedding sub-block
    if (store.embedding) {
      lines.push("      embedding {");
      if (store.embedding.provider) lines.push(`        provider: ${store.embedding.provider}`);
      if (store.embedding.model) lines.push(`        model: ${q(store.embedding.model)}`);
      if (store.embedding.dimensions != null) lines.push(`        dimensions: ${store.embedding.dimensions}`);
      if (store.embedding.endpoint) lines.push(`        endpoint: ${q(store.embedding.endpoint)}`);
      lines.push("      }");
    }

    // Index sub-block
    if (store.index) {
      lines.push("      index {");
      if (store.index.collection) lines.push(`        collection: ${q(store.index.collection)}`);
      if (store.index.metric) lines.push(`        metric: ${store.index.metric}`);
      lines.push("      }");
    }

    // Ingestion sub-block
    if (store.ingestion) {
      lines.push("      ingestion {");
      if (store.ingestion.sources) lines.push(`        sources: ${inlineList(store.ingestion.sources)}`);
      if (store.ingestion.chunking) lines.push(`        chunking: ${store.ingestion.chunking}`);
      if (store.ingestion.chunkSize != null) lines.push(`        chunk-size: ${store.ingestion.chunkSize}`);
      if (store.ingestion.overlap != null) lines.push(`        overlap: ${store.ingestion.overlap}`);
      lines.push("      }");
    }

    // Search sub-block
    if (store.search) {
      lines.push("      search {");
      if (store.search.strategy) lines.push(`        strategy: ${store.search.strategy}`);
      if (store.search.rerank != null) lines.push(`        rerank: ${store.search.rerank}`);
      if (store.search.topK != null) lines.push(`        top-k: ${store.search.topK}`);
      lines.push("      }");
    }

    // Lifecycle sub-block
    if (store.lifecycle) {
      const lc = store.lifecycle;
      lines.push("      lifecycle {");
      if (lc.retention) lines.push(`        retention: ${lc.retention}`);
      if (lc.decayHalfLife) lines.push(`        decay-half-life: ${lc.decayHalfLife}`);
      if (lc.consolidation != null) lines.push(`        consolidation: ${lc.consolidation}`);
      if (lc.contradiction) lines.push(`        contradiction: ${lc.contradiction}`);
      if (lc.auditLog != null) lines.push(`        audit-log: ${lc.auditLog}`);
      lines.push("      }");
    }

    // Backend-config passthrough
    if (store.backendConfig && Object.keys(store.backendConfig).length > 0) {
      lines.push("      backend-config {");
      for (const [k, v] of Object.entries(store.backendConfig)) {
        lines.push(`        ${k}: ${q(String(v))}`);
      }
      lines.push("      }");
    }

    lines.push("    }");
    blocks.push(lines.join("\n"));
  }
  return blocks;
}

function serializeRetrievals(retrievals: RetrievalNode[]): string[] {
  const blocks: string[] = [];
  for (const ret of retrievals) {
    const lines: string[] = [];
    lines.push(`    retrieval ${ret.id} {`);
    if (ret.sources) lines.push(`      sources: ${inlineList(ret.sources)}`);
    if (ret.budget != null) lines.push(`      budget: ${ret.budget}`);
    if (ret.paths) lines.push(`      paths: ${inlineList(ret.paths)}`);
    if (ret.rerank != null) lines.push(`      rerank: ${ret.rerank}`);
    if (ret.diversity != null) lines.push(`      diversity: ${ret.diversity}`);
    if (ret.cacheHitThreshold != null) lines.push(`      cache-hit-threshold: ${ret.cacheHitThreshold}`);
    if (ret.cacheHitAction) lines.push(`      cache-hit-action: ${ret.cacheHitAction}`);

    // Scoring sub-block
    if (ret.scoring) {
      lines.push("      scoring {");
      if (ret.scoring.recencyWeight != null) lines.push(`        recency-weight: ${ret.scoring.recencyWeight}`);
      if (ret.scoring.semanticWeight != null) lines.push(`        semantic-weight: ${ret.scoring.semanticWeight}`);
      if (ret.scoring.importanceWeight != null) lines.push(`        importance-weight: ${ret.scoring.importanceWeight}`);
      lines.push("      }");
    }

    lines.push("    }");
    blocks.push(lines.join("\n"));
  }
  return blocks;
}

function serializeDepth(depth: { factors: string[]; levels: { level: number; label: string; omit: string[] }[] }): string | null {
  if (!depth.factors?.length && !depth.levels?.length) return null;
  const lines: string[] = ["  depth {"];
  if (depth.factors?.length) lines.push(`    factors: ${inlineList(depth.factors)}`);
  for (const lvl of depth.levels ?? []) {
    lines.push(`    ${lvl.level}: ${q(lvl.label)}${lvl.omit?.length ? ` omit ${inlineList(lvl.omit)}` : ""}`);
  }
  lines.push("  }");
  return lines.join("\n");
}

function serializeMetering(metering: MeteringDef): string {
  const lines: string[] = ["  metering {"];
  lines.push(`    track: ${inlineList(metering.track)}`);
  lines.push(`    per: ${inlineList(metering.per)}`);
  lines.push(`    output: ${q(metering.output)}`);
  lines.push(`    format: ${metering.format}`);
  lines.push(`    pricing: ${metering.pricing}`);
  lines.push("  }");
  return lines.join("\n");
}

function serializeSkills(skills: SkillDef[]): string | null {
  if (skills.length === 0) return null;
  const lines: string[] = ["  skills {"];
  for (const skill of skills) {
    lines.push(`    skill ${skill.id} {`);
    if (skill.description) lines.push(`      description: "${skill.description}"`);
    if (skill.scripts?.length) lines.push(`      scripts: ${inlineList(skill.scripts)}`);
    if (skill.domains?.length) lines.push(`      domains: ${inlineList(skill.domains)}`);
    if (skill.references?.length) lines.push(`      references: ${inlineList(skill.references)}`);
    if (skill.prompt) lines.push(`      prompt: "${skill.prompt}"`);
    if (skill.disableModelInvocation) lines.push("      disable-model-invocation: true");
    if (skill.userInvocable) lines.push("      user-invocable: true");
    if (skill.context) lines.push(`      context: ${skill.context}`);
    if (skill.agent) lines.push(`      agent: ${skill.agent}`);
    if (skill.allowedTools?.length) lines.push(`      allowed-tools: ${inlineList(skill.allowedTools)}`);
    lines.push("    }");
  }
  lines.push("  }");
  return lines.join("\n");
}

function serializeTools(tools: ToolBlockDef[]): string | null {
  if (tools.length === 0) return null;
  const lines: string[] = ["  tools {"];
  for (const tool of tools) {
    lines.push(`    tool ${tool.id} {`);
    lines.push(`      script: "${tool.script}"`);
    lines.push(`      description: "${tool.description}"`);
    if (tool.lang) lines.push(`      lang: ${tool.lang}`);
    if (tool.args?.length) lines.push(`      args: ${inlineList(tool.args)}`);
    lines.push("    }");
  }
  lines.push("  }");
  return lines.join("\n");
}

function serializeProviders(providers: ProviderDef[]): string | null {
  if (providers.length === 0) return null;
  const lines: string[] = ["  providers {"];
  for (const p of providers) {
    lines.push(`    ${p.name} {`);
    if (p.apiKey) lines.push(`      api-key: ${q(p.apiKey)}`);
    if (p.baseUrl) lines.push(`      base-url: ${q(p.baseUrl)}`);
    if (p.models.length) lines.push(`      models: ${inlineList(p.models)}`);
    if (p.default) lines.push("      default: true");
    if (p.auth) {
      lines.push("      auth {");
      lines.push(`        type: ${p.auth.type}`);
      if (p.auth.issuer) lines.push(`        issuer: ${q(p.auth.issuer)}`);
      if (p.auth.audience) lines.push(`        audience: ${q(p.auth.audience)}`);
      if (p.auth.tokenUrl) lines.push(`        token-url: ${q(p.auth.tokenUrl)}`);
      if (p.auth.clientId) lines.push(`        client-id: ${q(p.auth.clientId)}`);
      if (p.auth.scopes?.length) lines.push(`        scopes: ${inlineList(p.auth.scopes)}`);
      lines.push("      }");
    }
    lines.push("    }");
  }
  lines.push("  }");
  return lines.join("\n");
}

function serializeSchedules(jobs: ScheduleJobDef[]): string | null {
  if (jobs.length === 0) return null;
  const lines: string[] = ["  schedule {"];
  for (const job of jobs) {
    lines.push(`    job ${job.id} {`);
    if (job.cron) lines.push(`      cron: "${job.cron}"`);
    if (job.every) lines.push(`      every: "${job.every}"`);
    if (job.agent) lines.push(`      agent: ${job.agent}`);
    if (job.action) lines.push(`      action: ${job.action}`);
    if (job.enabled === false) lines.push("      enabled: false");
    lines.push("    }");
  }
  lines.push("  }");
  return lines.join("\n");
}

function serializeInterfaces(ifaces: InterfaceDef[]): string | null {
  if (ifaces.length === 0) return null;
  const lines: string[] = ["  interfaces {"];
  for (const iface of ifaces) {
    lines.push(`    ${iface.id} {`);
    if (iface.type) lines.push(`      type: ${iface.type}`);
    for (const [k, v] of Object.entries(iface.config)) {
      lines.push(`      ${k}: ${q(String(v))}`);
    }
    lines.push("    }");
  }
  lines.push("  }");
  return lines.join("\n");
}

function serializeSchemas(schemas: { id: string; fields: SchemaFieldDef[] }[]): string | null {
  if (schemas.length === 0) return null;
  const lines: string[] = ["  schemas {"];
  for (const schema of schemas) {
    lines.push(`    schema ${schema.id} {`);
    for (const f of schema.fields) {
      lines.push(`      ${f.name}${f.optional ? "?" : ""}: ${formatSchemaType(f.type)}`);
    }
    lines.push("    }");
  }
  lines.push("  }");
  return lines.join("\n");
}

function serializeEnv(env: Record<string, string | SensitiveValue>): string | null {
  const entries = Object.entries(env);
  if (entries.length === 0) return null;
  const lines: string[] = ["  env {"];
  for (const [key, value] of entries) {
    const val = typeof value === "string" ? value : value.value;
    lines.push(`    ${key}: ${q(val)}`);
  }
  lines.push("  }");
  return lines.join("\n");
}

function serializeBatch(batch: Record<string, unknown>): string | null {
  const entries = Object.entries(batch);
  if (entries.length === 0) return null;
  const lines: string[] = ["  batch {"];
  for (const [k, v] of entries) {
    lines.push(`    ${k}: ${JSON.stringify(v)}`);
  }
  lines.push("  }");
  return lines.join("\n");
}

function serializeEnvironments(environments: Record<string, Record<string, unknown>>): string | null {
  const entries = Object.entries(environments);
  if (entries.length === 0) return null;
  const lines: string[] = ["  environments {"];
  for (const [name, config] of entries) {
    lines.push(`    ${name} {`);
    for (const [k, v] of Object.entries(config)) {
      lines.push(`      ${k}: ${JSON.stringify(v)}`);
    }
    lines.push("    }");
  }
  lines.push("  }");
  return lines.join("\n");
}

function serializeCheckpoint(cp: CheckpointDef): string {
  const lines: string[] = ["  checkpoint {"];
  lines.push(`    backend: ${cp.backend}`);
  if (cp.connection) lines.push(`    connection: ${q(cp.connection)}`);
  lines.push(`    strategy: ${cp.strategy}`);
  if (cp.ttl) lines.push(`    ttl: ${cp.ttl}`);
  if (cp.replay) {
    lines.push("    replay {");
    lines.push(`      enabled: ${cp.replay.enabled}`);
    if (cp.replay.maxHistory) lines.push(`      max-history: ${cp.replay.maxHistory}`);
    if (cp.replay.branch) lines.push(`      branch: true`);
    lines.push("    }");
  }
  lines.push("  }");
  return lines.join("\n");
}

function serializeArtifacts(artifacts: ArtifactDef[]): string | null {
  if (artifacts.length === 0) return null;
  const lines: string[] = ["  artifacts {"];
  for (const a of artifacts) {
    lines.push(`    artifact ${a.id} {`);
    lines.push(`      type: ${a.type}`);
    if (a.path) lines.push(`      path: "${a.path}"`);
    if (a.retention) lines.push(`      retention: ${a.retention}`);
    if (a.dependsOn?.length) lines.push(`      depends-on: ${inlineList(a.dependsOn)}`);
    lines.push("    }");
  }
  lines.push("  }");
  return lines.join("\n");
}

function serializeParams(params: ParamDef[]): string | null {
  if (params.length === 0) return null;
  const lines: string[] = ["  params {"];
  for (const p of params) {
    const parts = [`type: ${p.type}`];
    if (p.required) parts.push("required: true");
    if (p.default !== undefined) parts.push(`default: ${JSON.stringify(p.default)}`);
    lines.push(`    param ${p.name} { ${parts.join("; ")} }`);
  }
  lines.push("  }");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main serializer
// ---------------------------------------------------------------------------

export function serializeAST(ast: TopologyAST): string {
  const sections: string[] = [];

  // Header
  const patterns = ast.topology.patterns.length > 0
    ? ast.topology.patterns.join(", ")
    : "";
  const keyword = ast.isFragment ? "fragment" : "topology";
  sections.push(`${keyword} ${ast.topology.name} : [${patterns}] {`);

  // Meta
  sections.push(serializeMeta(ast));

  // Orchestrator
  const orchestrator = ast.nodes.find((n): n is OrchestratorNode => n.type === "orchestrator");
  if (orchestrator) {
    sections.push("");
    sections.push(serializeOrchestrator(orchestrator));
  }

  // Roles
  const roles = serializeRoles(ast.roles);
  if (roles) {
    sections.push("");
    sections.push(roles);
  }

  // Nodes: agents, actions, groups, humans
  const agents = ast.nodes.filter((n): n is AgentNode => n.type === "agent");
  const actions = ast.nodes.filter((n): n is ActionNode => n.type === "action");
  const groups = ast.nodes.filter((n): n is GroupNode => n.type === "group");
  const humans = ast.nodes.filter((n): n is HumanNode => n.type === "human");
  const gates = ast.nodes.filter((n): n is GateNode => n.type === "gate");

  for (const action of actions) {
    sections.push("");
    sections.push(serializeAction(action));
  }

  for (const agent of agents) {
    sections.push("");
    sections.push(serializeAgent(agent));
  }

  for (const group of groups) {
    sections.push("");
    sections.push(serializeGroup(group));
  }

  for (const human of humans) {
    sections.push("");
    sections.push(serializeHuman(human));
  }

  // Flow
  const flow = serializeFlow(ast.edges);
  if (flow) {
    sections.push("");
    sections.push(flow);
  }

  // Gates
  const gatesSerialized = serializeGates(gates);
  if (gatesSerialized) {
    sections.push("");
    sections.push(gatesSerialized);
  }

  // Depth
  const depth = serializeDepth(ast.depth);
  if (depth) {
    sections.push("");
    sections.push(depth);
  }

  // Memory (with stores and retrievals)
  const stores = ast.stores ?? [];
  const retrievals = ast.retrievals ?? [];
  const memory = serializeMemory(ast.memory);
  if (memory || stores.length > 0 || retrievals.length > 0) {
    if (memory) {
      // Memory block already has opening/closing braces — inject stores before closing
      const memLines = memory.split("\n");
      const closingIdx = memLines.lastIndexOf("  }");
      if (closingIdx !== -1 && (stores.length > 0 || retrievals.length > 0)) {
        const storeBlocks = serializeStores(stores);
        const retrievalBlocks = serializeRetrievals(retrievals);
        const injected = [
          ...memLines.slice(0, closingIdx),
          ...(storeBlocks.length > 0 ? ["", ...storeBlocks] : []),
          ...(retrievalBlocks.length > 0 ? ["", ...retrievalBlocks] : []),
          memLines[closingIdx],
        ];
        sections.push("");
        sections.push(injected.join("\n"));
      } else {
        sections.push("");
        sections.push(memory);
      }
    } else if (stores.length > 0 || retrievals.length > 0) {
      // No generic memory fields, but we have stores/retrievals — create memory block
      const lines: string[] = ["  memory {"];
      const storeBlocks = serializeStores(stores);
      const retrievalBlocks = serializeRetrievals(retrievals);
      for (const b of storeBlocks) { lines.push(""); lines.push(b); }
      for (const b of retrievalBlocks) { lines.push(""); lines.push(b); }
      lines.push("  }");
      sections.push("");
      sections.push(lines.join("\n"));
    }
  }

  // Batch
  const batch = serializeBatch(ast.batch);
  if (batch) {
    sections.push("");
    sections.push(batch);
  }

  // Environments
  const environments = serializeEnvironments(ast.environments);
  if (environments) {
    sections.push("");
    sections.push(environments);
  }

  // Triggers
  const triggers = serializeTriggers(ast.triggers);
  if (triggers) {
    sections.push("");
    sections.push(triggers);
  }

  // Hooks
  const hooks = serializeHooks(ast.hooks);
  if (hooks) {
    sections.push("");
    sections.push(hooks);
  }

  // Settings
  const settings = serializeSettings(ast.settings);
  if (settings) {
    sections.push("");
    sections.push(settings);
  }

  // MCP Servers
  const mcp = serializeMcpServers(ast.mcpServers);
  if (mcp) {
    sections.push("");
    sections.push(mcp);
  }

  // Metering
  if (ast.metering) {
    sections.push("");
    sections.push(serializeMetering(ast.metering));
  }

  // Skills
  const skills = serializeSkills(ast.skills);
  if (skills) {
    sections.push("");
    sections.push(skills);
  }

  // Tools
  const tools = serializeTools(ast.toolDefs);
  if (tools) {
    sections.push("");
    sections.push(tools);
  }

  // Schemas
  const schemas = serializeSchemas(ast.schemas);
  if (schemas) {
    sections.push("");
    sections.push(schemas);
  }

  // Providers
  const providers = serializeProviders(ast.providers);
  if (providers) {
    sections.push("");
    sections.push(providers);
  }

  // Schedules
  const schedules = serializeSchedules(ast.schedules);
  if (schedules) {
    sections.push("");
    sections.push(schedules);
  }

  // Interfaces
  const interfaces = serializeInterfaces(ast.interfaces);
  if (interfaces) {
    sections.push("");
    sections.push(interfaces);
  }

  // Params
  const params = serializeParams(ast.params);
  if (params) {
    sections.push("");
    sections.push(params);
  }

  // Env
  const env = serializeEnv(ast.env);
  if (env) {
    sections.push("");
    sections.push(env);
  }

  // Checkpoint
  if (ast.checkpoint) {
    sections.push("");
    sections.push(serializeCheckpoint(ast.checkpoint));
  }

  // Artifacts
  const artifacts = serializeArtifacts(ast.artifacts);
  if (artifacts) {
    sections.push("");
    sections.push(artifacts);
  }

  // Interface endpoints
  if (ast.interfaceEndpoints) {
    sections.push("");
    sections.push("  interface {");
    sections.push(`    entry: ${ast.interfaceEndpoints.entry}`);
    sections.push(`    exit: ${ast.interfaceEndpoints.exit}`);
    sections.push("  }");
  }

  // Imports
  if (ast.imports.length > 0) {
    sections.push("");
    for (const imp of ast.imports) {
      let line = `  import ${imp.alias} from "${imp.source}"`;
      if (imp.sha256) line += ` sha256 "${imp.sha256}"`;
      const paramEntries = Object.entries(imp.params);
      if (paramEntries.length > 0) {
        line += ` with { ${paramEntries.map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ")} }`;
      }
      sections.push(line);
    }
  }

  // Includes
  if (ast.includes.length > 0) {
    sections.push("");
    for (const inc of ast.includes) {
      sections.push(`  include "${inc.source}"`);
    }
  }

  // Close
  sections.push("}");

  return sections.join("\n") + "\n";
}
