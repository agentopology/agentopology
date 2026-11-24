/**
 * V102: every name written in a checked block is one the parser reads.
 *
 * The parser pulls fields out of a block by name and ignores the rest, so a
 * typo (`modle:`), a field from another node type (`produces:` on an action)
 * or a block the language does not have (`contract c1 { }`) vanished from the
 * AST while validate printed "All validation rules passed" (N23). This module
 * lists the names each block takes, as the parser reads them, and reports any
 * other name with the block it sits in.
 *
 * Blocks whose contents are free-form or not yet listed (prompt, extensions,
 * env, mcp-servers, memory, providers, ...) are not looked inside;
 * their own name is still checked where they sit.
 *
 * @module
 */

import { braceText, closingBrace, maskProse } from "./lexer.js";

/** What a block takes: its fields, and the sub-blocks it may hold. */
interface BlockSchema {
  /** `key: value` names, as written in the source. */
  fields: readonly string[];
  /** Sub-block names; `null` means the contents are not checked. */
  blocks?: Readonly<Record<string, BlockSchema | null>>;
}

const OPAQUE = null;

const HOOK: BlockSchema = {
  fields: ["on", "matcher", "if", "run", "type", "flag", "timeout", "url", "server", "tool", "async", "model", "strength", "bypass", "mode", "let-go", "rule"],
  blocks: { extensions: OPAQUE, tests: { fields: ["refuse", "allow"] } },
};

const AGENT: BlockSchema = {
  fields: [
    "file", "role", "model", "permissions", "phase", "description",
    "tools", "disallowed-tools", "never-reads", "ask-reads", "skills", "reads", "writes", "mcp-servers",
    "produces", "consumes", "outputs", "skip", "behavior", "invocation", "runs",
    "independent", "color", "initial-prompt", "omit-claude-md", "retry", "timeout",
    "on-fail", "temperature", "max-tokens", "top-p", "top-k", "stop", "seed",
    "thinking", "thinking-budget", "output-format", "log-level", "join",
    "compensates", "isolation", "background", "memory", "retrieval",
    "custodian-of", "place", "machine", "decides", "permission-mode", "sandbox", "fallback-chain", "rate-limit", "max-turns",
    "max-subagents", "max-cost", "output-into", "wall-time",
    // `prompt:` is a known misuse, reported by V89 with a better message.
    "prompt",
  ],
  blocks: {
    prompt: OPAQUE,
    outputs: OPAQUE,
    extensions: OPAQUE,
    "input-schema": OPAQUE,
    "output-schema": OPAQUE,
    retry: { fields: ["max", "backoff", "interval", "max-interval", "jitter", "non-retryable"] },
    "circuit-breaker": { fields: ["threshold", "window", "cooldown"] },
    scale: { fields: ["mode", "by", "min", "max", "batch-size"] },
    hooks: { fields: [], blocks: { hook: HOOK } },
    variants: {
      fields: [],
      blocks: { variant: { fields: ["weight", "model", "temperature"], blocks: { prompt: OPAQUE } } },
    },
  },
};

const NODE_SCHEMAS = {
  orchestrator: {
    fields: ["model", "handles", "generates", "delegation", "outputs"],
    blocks: { outputs: OPAQUE },
  },
  agent: AGENT,
  action: { fields: ["kind", "source", "description", "commands", "timeout", "on-fail", "join", "unit-from"] },
  gate: {
    fields: ["after", "before", "run", "checks", "retry", "on-fail", "behavior", "timeout", "description", "strength", "by", "at", "match", "bypass", "ledger", "mode", "let-go", "lift", "rule"],
    blocks: { extensions: OPAQUE, tests: { fields: ["refuse", "allow"] } },
  },
  human: { fields: ["file", "description", "timeout", "on-timeout", "who", "valid", "word", "stop-word", "binds", "typed-only-programs"] },
  group: {
    fields: ["members", "file", "speaker-selection", "max-rounds", "termination", "description", "timeout"],
  },
  hook: HOOK,
  job: { fields: ["cron", "every", "agent", "action", "enabled", "machine", "carrier", "survives"] },
  artifact: { fields: ["type", "path", "retention", "depends-on"] },
  record: { fields: ["path", "fields", "schema", "writer", "kind", "max-per-day"] },
  tool: { fields: ["script", "command", "description", "args", "lang"] },
  skill: {
    fields: [
      "description", "scripts", "domains", "references", "prompt", "file", "when-to-use",
      "argument-hint", "shell", "model", "thinking", "arguments", "paths", "disallowed-tools",
      "disable-model-invocation", "user-invocable", "context", "agent", "allowed-tools",
    ],
    blocks: { prompt: OPAQUE, extensions: OPAQUE },
  },
  meta: {
    fields: ["version", "description", "domain", "foundations", "advanced", "timeout", "error-handler", "entry", "outpoints", "durable", "requires", "target", "refusal-events"],
  },
} satisfies Record<string, BlockSchema>;

/** The topology body: the sections it takes. Fields are not allowed there. */
const TOPOLOGY: BlockSchema = {
  fields: ["decisions", "pin-models", "uses-plugins"],
  blocks: {
    meta: NODE_SCHEMAS.meta,
    orchestrator: NODE_SCHEMAS.orchestrator,
    agent: NODE_SCHEMAS.agent,
    action: NODE_SCHEMAS.action,
    human: NODE_SCHEMAS.human,
    group: NODE_SCHEMAS.group,
    skill: NODE_SCHEMAS.skill,
    gates: { fields: [], blocks: { gate: NODE_SCHEMAS.gate } },
    hooks: { fields: [], blocks: { hook: NODE_SCHEMAS.hook } },
    schedule: { fields: [], blocks: { job: NODE_SCHEMAS.job } },
    person: { fields: ["away"] },
    boundary: { fields: ["path", "in", "out", "outbound", "branch"] },
    inventory: { fields: ["roots", "strict"] },
    needs: { fields: ["memory", "connectors", "user-skills", "plugins"] },
    "threat-model": { fields: ["untrusted", "outside-sandbox", "refuse-after-untrusted", "lift"] },
    egress: { fields: ["gate", "covers"] },
    islands: { fields: [], blocks: { island: { fields: ["path", "owner", "test"] } } },
    machines: { fields: [], blocks: { machine: { fields: ["os"] } } },
    secrets: { fields: [], blocks: { secret: { fields: ["path", "readers"] } } },
    artifacts: { fields: [], blocks: { artifact: NODE_SCHEMAS.artifact } },
    records: { fields: [], blocks: { record: NODE_SCHEMAS.record } },
    tools: { fields: [], blocks: { tool: NODE_SCHEMAS.tool } },
    // Not in the grammar, but the parser reads the skills inside it.
    skills: { fields: [], blocks: { skill: NODE_SCHEMAS.skill } },
    // What parseSettings reads. An `env { }` inside it warns on its own (its
    // keys are not written to settings.json; the topology env is top-level).
    settings: { fields: ["allow", "deny", "ask", "sandbox", "fallback-chain"], blocks: { env: OPAQUE } },
    // What parseMetering reads.
    // `cap:` is max-cost's alias (parseMetering reads both).
    metering: { fields: ["track", "per", "output", "format", "pricing", "max-cost", "cap"] },
    // Sections whose contents are not checked yet.
    roles: OPAQUE, flow: OPAQUE, depth: OPAQUE, memory: OPAQUE, batch: OPAQUE,
    environments: OPAQUE, triggers: OPAQUE, "mcp-servers": OPAQUE,
    context: OPAQUE, env: OPAQUE, providers: OPAQUE,
    interfaces: OPAQUE, defaults: OPAQUE, schemas: OPAQUE, rules: OPAQUE, observability: OPAQUE,
    checkpoint: OPAQUE, extensions: OPAQUE, params: OPAQUE, interface: OPAQUE,
    // Children of a misplaced container keyword are reported by V98 instead.
    gate: OPAQUE, hook: OPAQUE, tool: OPAQUE, job: OPAQUE, command: OPAQUE, level: OPAQUE,
  },
};

/** Which node kinds take a field, for "it is a field of X" in the message. */
function kindsWithField(field: string): string[] {
  return Object.entries(NODE_SCHEMAS)
    .filter(([, s]) => (s.fields as readonly string[]).includes(field))
    .map(([k]) => k);
}

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      // A swap of two neighbours (`modle`) is one edit, not two.
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

/** The closest known name, if it is close enough to be a typo. */
function closest(name: string, known: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestD = Infinity;
  for (const k of known) {
    const dist = editDistance(name, k);
    if (dist < bestD) { best = k; bestD = dist; }
  }
  return bestD <= (name.length <= 4 ? 1 : 2) ? best : undefined;
}

/** A name at the top level of a block body: a field, or a sub-block. */
interface Item {
  kind: "field" | "block";
  name: string;
  id?: string;
  /** Sub-block body, between its braces. */
  body?: string;
}

/**
 * The fields and sub-blocks written directly in `body` (not inside a nested
 * block or a multi-line list). Everything is read on the prose mask: a brace,
 * a bracket or a name in a prompt, a quoted string or a comment is text.
 */
function topLevelItems(body: string): Item[] {
  const items: Item[] = [];
  const mask = maskProse(body);
  let depth = 0;
  let bracket = 0;
  let i = 0;
  while (i < mask.length) {
    // At the start of a line, at depth 0, outside a list: read the head.
    if (depth === 0 && bracket === 0) {
      const rest = mask.slice(i);
      const field = /^[ \t]*([A-Za-z_][\w-]*)[ \t]*:/.exec(rest);
      // The brace may be on a later line, with only blank or comment lines (blank on the mask) between.
      const block = field ? null : /^[ \t]*([A-Za-z_][\w-]*)(?:[ \t]+([A-Za-z_][\w-]*))?(?:[^\n{:"]*|[ \t]*(?:\n[ \t]*)+)\{/.exec(rest);
      if (field) {
        items.push({ kind: "field", name: field[1] });
        // A one-line block (`a: 1, b: 2`): a top-level comma before `key:` starts
        // another field, as the parser's field reader (splitOneLineFields) reads it.
        let paren = 0;
        let inner = 0;
        for (let k = i + field[0].length; k < mask.length && mask[k] !== "\n"; k++) {
          const ch = mask[k];
          if (ch === "(") paren++;
          else if (ch === ")") paren--;
          else if (ch === "[" || ch === "{") inner++;
          else if (ch === "]" || ch === "}") inner--;
          else if (ch === "," && paren === 0 && inner === 0) {
            const next = /^\s*([A-Za-z_][\w-]*)\s*:/.exec(mask.slice(k + 1));
            if (next) items.push({ kind: "field", name: next[1] });
          }
        }
      } else if (block) {
        const open = i + block[0].length;
        const close = closingBrace(braceText(body), open);
        const j = close < 0 ? mask.length : close + 1;
        items.push({ kind: "block", name: block[1], id: block[2], body: body.slice(open, j - 1) });
        i = j;
        continue;
      }
    }
    // Walk to the next line, tracking depth.
    while (i < mask.length && mask[i] !== "\n") {
      const ch = mask[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === "[") bracket++;
      else if (ch === "]") bracket--;
      i++;
    }
    i++;
  }
  return items;
}

export interface UnknownNameResult {
  rule: "V102";
  /** A name that vanished is an error; `env` inside settings (dropped since S-13, F5) warns. */
  level: "error" | "warning";
  message: string;
  node?: string;
}

/** "an agent", "a gate". */
function article(word: string): string {
  return /^[aeiou]/.test(word) ? `an ${word}` : `a ${word}`;
}

function describeBlock(kind: string, id: string | undefined): string {
  return id ? `${kind} "${id}"` : kind === "topology" ? "the topology" : `"${kind}"`;
}

function check(
  body: string,
  schema: BlockSchema,
  kind: string,
  id: string | undefined,
  out: UnknownNameResult[],
  claim?: (keyword: string, label: string) => boolean,
): void {
  const where = describeBlock(kind, id);
  const node = id ?? (kind === "topology" ? undefined : kind);
  const blocks = schema.blocks ?? {};
  for (const item of topLevelItems(body)) {
    if (item.kind === "field") {
      if (schema.fields.includes(item.name)) continue;
      // `outputs: { ... }` and `custodian-of: [..] { }` are fields with a brace.
      if (item.name in blocks) continue;
      const elsewhere = kindsWithField(item.name).filter((k) => k !== kind);
      const guess = closest(item.name, schema.fields);
      let message: string;
      if (kind === "topology") {
        message = `\`${item.name}:\` is not a topology section, so it is ignored. Fields go inside a block (meta, an agent, ...)`;
      } else if (elsewhere.length > 0) {
        message = `\`${item.name}\` is not ${article(kind)} field (it is a field of ${elsewhere.join(", ")}), so on ${where} it is ignored`;
      } else {
        message = `${where} has \`${item.name}:\`, which is not ${article(kind)} field, so it is ignored` +
          (guess ? `. Did you mean \`${guess}\`?` : "");
      }
      out.push({ rule: "V102", level: "error", message, ...(node ? { node } : {}) });
      continue;
    }
    if (item.name in blocks) {
      const sub = blocks[item.name];
      if (sub) check(item.body ?? "", sub, item.name, item.id, out);
      continue;
    }
    const label = item.id ? `${item.name} ${item.id}` : item.name;
    if (claim?.(item.name, label)) continue;
    const guess = closest(item.name, Object.keys(blocks));
    out.push({
      rule: "V102",
      level: "error",
      message: `${where} has a \`${label} { }\` block, which is not ${kind === "topology" ? "a topology section" : article(`${kind} block`)}, so it is ignored` +
        (guess ? `. Did you mean \`${guess}\`?` : ""),
      ...(node ? { node } : {}),
    });
  }
}

/**
 * Report every field and block name in a topology body that the parser does
 * not read. `topBody` is the comment-stripped body of `topology { }`.
 */
export function findUnknownNames(
  topBody: string,
  plugins?: {
    /** Loaded plugins' top-level keywords: known, checked against their fields (null: not looked inside). */
    blocks?: Readonly<Record<string, { fields: readonly string[] } | null>>;
    /** An unknown top-level block a declared, unloaded plugin may own: true when it was reported elsewhere (V167). */
    claim?: (keyword: string, label: string) => boolean;
  },
): UnknownNameResult[] {
  const out: UnknownNameResult[] = [];
  const schema = plugins?.blocks && Object.keys(plugins.blocks).length > 0
    ? { ...TOPOLOGY, blocks: { ...TOPOLOGY.blocks, ...plugins.blocks } }
    : TOPOLOGY;
  check(topBody, schema, "topology", undefined, out, plugins?.claim);
  return out;
}

/** The source names each checked block takes (for docs and tests). */
export const KNOWN_FIELDS: Readonly<Record<keyof typeof NODE_SCHEMAS, readonly string[]>> =
  Object.fromEntries(Object.entries(NODE_SCHEMAS).map(([k, s]) => [k, s.fields])) as never;

/** Every block keyword the topology level takes (for the section-count guard). */
export const TOPOLOGY_BLOCKS: readonly string[] = Object.keys(TOPOLOGY.blocks ?? {});
