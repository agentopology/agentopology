# AgenTopology Validation Rules

Created by Nadav Naveh

These 35 rules are enforced by the `.at` compiler at parse time. A topology that violates any rule is rejected before scaffold generation.

---

## Rule 1: Unique Names

All agent, action, and gate names must be globally unique within a topology. You cannot have an agent and an action with the same name.

```agenttopology
# INVALID -- duplicate name "intake"
agent intake { ... }
action intake { ... }
```

---

## Rule 2: No Keyword Names

No agent, action, or gate name may match a reserved keyword. See `reserved-keywords.md` for the full list.

```agenttopology
# INVALID -- "flow" is a reserved keyword
agent flow { ... }
```

---

## Rule 3: Flow Resolves

Every node name used in the `flow` block must correspond to a declared `agent`, `action`, or `gate`. No dangling references.

```agenttopology
# INVALID -- "analyzer" is not declared anywhere
flow {
  intake -> analyzer
}
```

---

## Rule 4: No Orphans

Every declared agent must appear in the `flow` block or have `invocation: manual`. An agent that exists but is unreachable from the flow graph is an error.

```agenttopology
# INVALID -- "helper" is declared but never used in flow and not manual
agent helper {
  model: sonnet
}
```

---

## Rule 5: Outputs Exist

Every condition in a `[when x.y == z]` edge attribute must reference a declared `outputs` field on the named agent or orchestrator.

```agenttopology
# INVALID -- "reviewer" has no output named "score"
reviewer -> builder  [when reviewer.score == high]
```

---

## Rule 6: Bounded Loops

Every back-edge (a flow edge that goes "backward" to an earlier node in the graph) must have `max N`. Unbounded loops are not allowed.

```agenttopology
# INVALID -- back-edge without max
reviewer -> writer  [when reviewer.verdict == revise]

# VALID
reviewer -> writer  [when reviewer.verdict == revise, max 2]
```

---

## Rule 7: Model Required

Every agent must have a `model` field. There is no default model.

```agenttopology
# INVALID -- no model specified
agent writer {
  tools: [Read, Write]
}
```

---

## Rule 8: Imports Resolve

Every `import` statement must point to an existing `.at` file that contains the named agent definition.

```agenttopology
# INVALID -- file does not exist
import reviewer from ./nonexistent.at
```

---

## Rule 9: Actions Handled

Every action that appears in the `flow` block must also appear in `orchestrator.handles`. The orchestrator must know about every action it needs to run.

```agenttopology
# INVALID -- "intake" is in flow but not in handles
orchestrator {
  model: opus
  handles: [classify]
}

flow {
  intake -> classify
}
```

---

## Rule 10: Prompts Exist

Every `prompt:` path must resolve to an existing file on the filesystem. This is a filesystem validation performed after parsing.

```agenttopology
# INVALID -- file does not exist
agent writer {
  model: sonnet
  prompt: "prompts/nonexistent.md"
}
```

---

## Rule 11: Reads/Writes Consistent

If agent A writes to a path and agent B reads from that path, there must be a flow path from A to B. This ensures data dependencies match the execution order.

```agenttopology
# INVALID -- writer produces "output.md" but reader runs before writer
agent reader {
  phase: 1
  reads: ["output.md"]
}

agent writer {
  phase: 2
  writes: ["output.md"]
}

flow {
  reader -> writer  # reader runs first but depends on writer's output
}
```

---

## Rule 12: Edge Attribute Order

Edge attributes must appear in the order: `when`, then `max`, then `per`. Any other order is a parser error.

```agenttopology
# INVALID -- max before when
qa -> builder  [max 2, when qa.verdict == revise]

# VALID
qa -> builder  [when qa.verdict == revise, max 2]
```

---

## Rule 13: Gate Placement

Every gate's `after` field must reference a declared agent or action. If `before` is specified, it must also reference a declared agent or action.

```agenttopology
# INVALID -- "nonexistent" is not a declared node
gates {
  gate check {
    after: nonexistent
    run: "scripts/check.sh"
  }
}
```

---

## Rule 14: Tool Exclusivity

An agent cannot have both `tools` (allowlist) and `disallowed-tools` (denylist). Pick one approach.

```agenttopology
# INVALID -- both tools and disallowed-tools
agent writer {
  model: sonnet
  tools: [Read, Write]
  disallowed-tools: [Bash]
}
```

---

## Rule 15: Exhaustive Conditions

When a node has **only** conditional outgoing edges, the conditions must cover every possible value of the referenced output that is **reachable** at that node.

A value is unreachable if all flow paths to the node require a condition that excludes it. The compiler accounts for upstream routing when checking exhaustiveness.

```agenttopology
# INVALID -- "reject" is not covered
agent reviewer {
  outputs: {
    verdict: approve | revise | reject
  }
}

flow {
  reviewer -> publisher  [when reviewer.verdict == approve]
  reviewer -> writer     [when reviewer.verdict == revise, max 2]
  # Missing: reviewer -> ??? [when reviewer.verdict == reject]
}

# VALID -- all three values covered
flow {
  reviewer -> publisher  [when reviewer.verdict == approve]
  reviewer -> writer     [when reviewer.verdict == revise, max 2]
  reviewer -> researcher [when reviewer.verdict == reject, max 1]
}
```

---

## Rule 16: API Key Environment Variables

Provider `api-key` values must be environment variable references using `${ENV_VAR}` syntax. Literal API keys in `.at` files are a security risk and always a validation error.

```agenttopology
# INVALID -- literal API key
providers {
  anthropic {
    api-key: "sk-ant-api03-..."
    models: [opus, sonnet]
  }
}

# VALID -- environment variable reference
providers {
  anthropic {
    api-key: "${ANTHROPIC_API_KEY}"
    models: [opus, sonnet]
  }
}
```

---

## Rule 17: Single Default Provider

At most one provider may have `default: true`. When multiple providers serve the same model, the default provider is preferred for routing.

```agenttopology
# INVALID -- two defaults
providers {
  anthropic {
    api-key: "${ANTHROPIC_API_KEY}"
    models: [opus, sonnet]
    default: true
  }
  openrouter {
    api-key: "${OPENROUTER_API_KEY}"
    models: [opus, sonnet]
    default: true
  }
}
```

---

## Rule 18: Model in Provider (Warning)

When a `providers` block is present, every model referenced by an agent or orchestrator should exist in at least one provider's `models` list. This is a **warning**, not an error — the topology is still valid but may indicate a misconfiguration.

```agenttopology
# WARNING -- agent uses "gpt-4o" but no provider lists it
providers {
  anthropic {
    api-key: "${ANTHROPIC_API_KEY}"
    models: [opus, sonnet]
  }
}

agent writer {
  model: gpt-4o  # warning: not in any provider's models
  tools: [Read, Write]
}
```

---

## Rule 19: Unique Provider Names

Provider names must be unique within the `providers` block. Duplicate names are an error.

```agenttopology
# INVALID -- duplicate "anthropic"
providers {
  anthropic {
    api-key: "${ANTHROPIC_API_KEY}"
    models: [opus]
  }
  anthropic {
    api-key: "${ANTHROPIC_BACKUP_KEY}"
    models: [sonnet]
  }
}
```

---

## Rule 20: Schedule Job References

Every schedule job must reference a declared agent or action. The `cron` and `every` fields are mutually exclusive -- a job cannot have both.

```agenttopology
# INVALID -- "ghost-agent" is not declared
schedule {
  job nightly-run {
    cron: "0 2 * * *"
    agent: ghost-agent
  }
}

# INVALID -- both cron and every specified
schedule {
  job conflicting {
    cron: "0 9 * * *"
    every: "daily"
    agent: summarizer
  }
}
```

---

## Rule 21: Interface Secret Detection

Interface fields named `webhook`, `auth`, `token`, or `secret` must use `${ENV_VAR}` syntax. Literal values are a validation error, preventing accidental secret exposure in `.at` files.

```agenttopology
# INVALID -- literal webhook URL
interfaces {
  slack {
    type: webhook
    webhook: "https://hooks.slack.com/services/T00/B00/xxxx"
  }
}

# VALID
interfaces {
  slack {
    type: webhook
    webhook: "${SLACK_WEBHOOK_URL}"
  }
}
```

---

## Rule 22: Fallback Chain Model Validation

When providers are declared, every model in a `fallback-chain` should exist in at least one provider's `models` list. This is a **warning** (not error) since model availability may vary at runtime.

```agenttopology
providers {
  anthropic {
    api-key: "${ANTHROPIC_API_KEY}"
    models: [opus, sonnet]
  }
}

settings {
  fallback-chain: [opus, sonnet, haiku]  # warning: haiku not in any provider
}
```

---

## Rule 23: Duplicate Sections (Warning)

Singleton top-level sections (`meta`, `flow`, `memory`, `gates`, `depth`, `batch`, `environments`, `triggers`, `hooks`, `settings`, `mcp-servers`, `metering`, `tools`, `schedule`, `interfaces`) may appear at most once. When duplicates are found, only the first occurrence is used by the parser and a **warning** is emitted.

```agenttopology
# WARNING -- duplicate memory block
memory {
  workspace { path: "workspace/" }
}

memory {
  domains { path: "domains/" }
}
```

---

## Rule 24: Unknown Memory Sub-Blocks (Warning)

Only known sub-blocks are expected inside the `memory` section: `domains`, `references`, `external-docs`, `metrics`, `workspace`, `store`, and `retrieval`. Any other named sub-block is parsed but flagged as a **warning**.

```agenttopology
# WARNING -- "custom-store" is not a recognized memory sub-block
memory {
  workspace { path: "workspace/" }
  custom-store { path: "store/" }
}
```

---

## Rule 25: Bounce-Back Advisory (Warning)

The `on-fail: bounce-back` gate behavior is advisory on all CLI bindings. It requires orchestrator cooperation or a framework binding for enforcement. This is a **warning** to inform topology authors that bounce-back is not guaranteed to be enforced at runtime.

```agenttopology
# WARNING -- bounce-back is advisory
gates {
  gate quality-check {
    after: writer
    before: reviewer
    run: "scripts/check.sh"
    on-fail: bounce-back
  }
}
```

---

## Rule 26: Action Kind Enum

Every `action.kind` must be one of the allowed values: `external`, `git`, `decision`, `inline`, or `report`. Any other value is an error.

```agenttopology
# INVALID -- "webhook" is not a recognized action kind
action notify {
  kind: webhook
  description: "Send notification"
}
```

---

## Rule 27: Agent Permissions Enum (Warning)

Agent `permissions` values should be one of the known values: `autonomous`, `supervised`, `interactive`, `unrestricted`, `plan`, `auto`, `confirm`, `bypass`. Unrecognized values produce a **warning** (not error) since new permission modes may be added.

```agenttopology
# WARNING -- "restricted" is not a recognized permission mode
agent writer {
  model: sonnet
  permissions: restricted
}
```

---

## Rule 28: Metering Format Enum

The `metering.format` field must be one of: `json`, `jsonl`, or `csv`. Any other value is an error.

```agenttopology
# INVALID -- "xml" is not a recognized metering format
metering {
  track: [tokens-in, tokens-out]
  per: [agent]
  output: "metrics/"
  format: xml
  pricing: none
}
```

---

## Rule 29: Metering Pricing Enum (Warning)

The `metering.pricing` field should be one of the known values: `anthropic-current`, `custom`, or `none`. Unrecognized values produce a **warning** since custom pricing integrations may exist.

```agenttopology
# WARNING -- "openai-current" is not a recognized pricing model
metering {
  track: [tokens-in, tokens-out]
  per: [agent]
  output: "metrics/"
  format: jsonl
  pricing: openai-current
}
```

---

## Rule 30: Store Backend Enum

Every `store.backend` must be one of the allowed values: `lancedb`, `sqlite-vec`, `chroma`, `kuzu`, `falkordb`, `mongodb`, `pinecone`, `qdrant`, `pgvector`, `neo4j`, or `sqlite`. Any other value is an error.

```agenttopology
# INVALID -- "redis" is not a recognized store backend
memory {
  store cache {
    type: session
    backend: redis
    path: ".memory/cache/"
  }
}
```

---

## Rule 31: Embedding Recommended (Warning)

When a store's `type` is `semantic`, `episodic`, or `procedural`, the `embedding {}` sub-block should be present. Omitting it produces a **warning** -- the topology is valid but the store may not function correctly without embedding configuration.

```agenttopology
# WARNING -- semantic store without embedding configuration
memory {
  store docs {
    type: semantic
    backend: lancedb
    path: ".memory/docs/"
  }
}

# VALID -- embedding provided
memory {
  store docs {
    type: semantic
    backend: lancedb
    path: ".memory/docs/"

    embedding {
      provider: ollama
      model: "nomic-embed-text"
      dimensions: 768
    }
  }
}
```

---

## Rule 32: Store Scope Recommended (Warning)

Every `store` should have a `scope` field. Omitting it produces a **warning** -- the topology is valid but the store's access boundaries are undefined, which may cause issues in multi-agent or multi-user deployments.

```agenttopology
# WARNING -- store without scope
memory {
  store knowledge {
    type: semantic
    backend: lancedb
    path: ".memory/knowledge/"
  }
}

# VALID -- scope specified
memory {
  store knowledge {
    type: semantic
    scope: agent
    backend: lancedb
    path: ".memory/knowledge/"
  }
}
```

---

## Rule 33: Retrieval Sources Resolve

Every store ID in a `retrieval.sources` list must reference a declared `store` block within the `memory` section. Referencing an undefined store is an error.

```agenttopology
# INVALID -- "nonexistent-store" is not a declared store
memory {
  store docs {
    type: semantic
    backend: lancedb
    path: ".memory/docs/"
  }

  retrieval main {
    sources: [docs, nonexistent-store]
    budget: 4096
  }
}
```

---

## Rule 34: Connection Required for Remote Backends

When a store uses a remote backend (`pinecone`, `qdrant`, `pgvector`, `neo4j`, `mongodb`, or `falkordb`), the `connection` field is required. Omitting it is an error.

```agenttopology
# INVALID -- pinecone requires a connection string
memory {
  store vectors {
    type: semantic
    backend: pinecone

    embedding {
      provider: openai
      model: "text-embedding-3-large"
      dimensions: 3072
    }
  }
}

# VALID -- connection provided
memory {
  store vectors {
    type: semantic
    backend: pinecone
    connection: secret "PINECONE_URL"

    embedding {
      provider: openai
      model: "text-embedding-3-large"
      dimensions: 3072
    }
  }
}
```

---

## Rule 35: Agent Memory/Retrieval References

Agent `memory` list entries must reference declared store IDs. Agent `retrieval` must reference a declared retrieval strategy ID. Referencing undefined stores or retrievals is an error.

```agenttopology
# INVALID -- "ghost-store" is not a declared store, "ghost-retrieval" is not declared
memory {
  store docs {
    type: semantic
    backend: lancedb
    path: ".memory/docs/"
  }

  retrieval main {
    sources: [docs]
    budget: 4096
  }
}

agent researcher {
  model: sonnet
  memory: [docs, ghost-store]
  retrieval: ghost-retrieval
}
```

---

## Summary Table

All 129 rules, generated from `src/parser/validator.ts` so the spec cannot drift
from the implementation. Rules V8, V12, V23, V24, V89, V90, V98 and V102 are collected at
**parse time** — the misuse they catch leaves no trace in the AST — and surfaced
through the validator like any other rule.

`error` fails `agentopology validate` with exit 1. `warning` reports and exits 0.

| Rule | Severity | Description |
|------|----------|-------------|
| V1 | error | All agent, action, and gate names must be globally unique |
| V2 | error | No name may match a reserved keyword |
| V3 | error | Every node referenced in flow must be a declared agent, action, or gate |
| V4 | error | Every agent must appear in flow unless it has `invocation: manual` or is a group member |
| V5 | error/warning | Every `[when x.y]` must reference a declared output |
| V6 | error/warning | Every back-edge must have `max N` |
| V7 | error/warning | Every agent and orchestrator must have a model |
| V8 | error/warning | A local import is read relative to the importing file: a missing file, a `sha256` that does not match, an import cycle, or an error inside the imported file is an error; validating a string with no file path skips this and warns `imports not checked` |
| V9 | error/warning | Every action referenced in flow must appear in orchestrator.handles |
| V10 | error/warning | Prompt content should not be empty if a prompt block is declared |
| V11 | error | If agent A writes X and agent B reads X, a path A -> B must exist in flow — unless either is on demand (`invocation: manual`), which has no flow by definition |
| V12 | error | Edge attribute order must be [when, max, per] |
| V13 | error | Gate `after` and `before` must reference declared nodes |
| V14 | error | `tools` and `disallowed-tools` cannot both appear on the same agent |
| V15 | error/warning | When a node has ONLY conditional outgoing edges, the conditions must |
| V16 | error/warning | `api-key` must be a `${...}` env-var reference (no literal secrets) |
| V17 | error/warning | At most one provider may have `default: true` |
| V18 | error/warning | Every model referenced by an agent should exist in at least one provider's models list |
| V19 | error/warning | Provider names must be unique |
| V20 | error/warning | Every schedule job must reference a declared agent or action; cron and every are mutually exclusive |
| V21 | error/warning | Interface webhook/auth values containing literal secrets (not `${ENV_VAR}`) should error |
| V22 | error/warning | Every model in a fallback-chain should exist in at least one provider's models list |
| V23 | error/warning | Duplicate top-level singleton sections |
| V24 | error/warning | Unknown sub-blocks in the `memory` section |
| V25 | error/warning | `on-fail: bounce-back` enforcement depends on the gate's `after` target (a gate before an action with `commands:` is compiled to before-action.sh and does not warn) |
| V26 | error/warning | `action.kind` must be one of the allowed values |
| V27 | error/warning | `agent.permissions` should be one of the known values |
| V28 | error/warning | `metering.format` must be one of the allowed values |
| V29 | error/warning | `metering.pricing` should be one of the known values |
| V30 | error | Validate `timeout` format is a valid duration string (matches /^\d+[smhd]$/) |
| V31 | error | Validate `on-fail` is one of: halt, retry, skip, continue, or starts with "fallback " |
| V32 | error | If `on-fail: fallback <id>`, validate that the referenced agent exists |
| V33 | error | Validate retry block fields (backoff enum, interval format, non-retryable is list) |
| V34 | error | Validate `temperature` is between 0 and 2 (on agents and defaults) |
| V35 | error | Validate `thinking` is one of: off, low, medium, high, max |
| V36 | error | Validate `output-format` is one of: text, json, json-schema |
| V37 | error | Validate `log-level` is one of: debug, info, warn, error |
| V38 | error | Validate `max-tokens` is a positive integer |
| V39 | error | Validate `join` is one of: all, any, all-done, none-failed, or N-of-M |
| V40 | error | Error edge target must be a declared node |
| V41 | error | `[race]` is only valid on fan-out edges (node has multiple outgoing edges) |
| V42 | error | `[tolerance]` format is valid (integer or percentage string matching /^\d+%?$/) |
| V43 | error | `[wait]` format is a valid duration string (reuse timeout validation pattern) |
| V44 | error | Topology-level `error-handler` must reference a declared node |
| V45 | error | Topology-level `timeout` must be a valid duration string |
| V46 | error | Schema type names must be valid (primitive, array of X, enum, or ref) |
| V47 | error | Schema `ref` names must resolve to a declared schema in the top-level `schemas` block |
| V48 | error/warning | Validate `observability.level` is one of: debug, info, warn, error |
| V49 | error/warning | Validate `observability.exporter` is one of: otlp, langsmith, datadog, stdout, none |
| V50 | error/warning | Validate `observability.sample-rate` is between 0 and 1 (inclusive) |
| V51 | error/warning | When `sensitive` is used with a literal string (not a `${...}` env var |
| V52 | error | Validate that secret URI schemes are one of the supported providers |
| V53 | error | Param type must be one of: `string`, `number`, `boolean` |
| V54 | error | Interface entry and exit must reference declared node ids |
| V55 | error | No two imports may share the same alias |
| V56 | error | Import source must be a syntactically valid path (starts with `./`, |
| V57 | error | Validate circuit-breaker fields — threshold must be a positive integer, |
| V58 | error/warning | `compensates` must reference a declared agent node |
| V59 | error | Human node `on-timeout` must be one of: halt, skip, or start with "fallback " |
| V60 | error/warning | When `join` uses quorum syntax `N-of-M`, validate: |
| V61 | error/warning | Validate `[weight N]` edge attributes: |
| V62 | error/warning | `[reflection]` is only valid on back-edges (edges that form cycles) |
| V63 | error | `members` in a group node must reference declared agent nodes |
| V64 | error | `speaker-selection` must be one of: auto, round-robin, random, manual |
| V65 | error | `max-rounds` must be a positive integer |
| V66 | error/warning | `rate-limit` must match N/unit where N >= 1 and unit is sec\|min\|hour\|day |
| V67 | error/warning | checkpoint `backend` must be one of the known values |
| V68 | error/warning | checkpoint `strategy` must be one of the known values, |
| V69 | error/warning | replay requires strategy "every-node"; max-history must be a positive |
| V70 | error | All artifact IDs in the artifacts block must be unique |
| V71 | error | depends-on, produces, and consumes must reference declared artifact IDs |
| V72 | error | Artifact dependency graph must be acyclic |
| V73 | error/warning | Registry package names must match `[a-z0-9-]+(/[a-z0-9-]+)*` |
| V74 | error/warning | Registry package version must be valid semver or "latest" |
| V75 | error/warning | If sha256 is present on an import, it must be a valid 64-char hex string |
| V76 | error/warning | Variant ids must be unique within each agent |
| V77 | error/warning | Variant weights must sum to approximately 1.0 (within 0.01 tolerance) |
| V78 | error/warning | `encrypted` values must match SOPS envelope format ENC[METHOD,data:BASE64] |
| V79 | error/warning | provider auth.type must be one of the known auth types |
| V80 | error/warning | OIDC and OAuth2 auth types require an issuer field |
| V81 | error/warning | StoreNode.backend must be one of the known values |
| V82 | error/warning | When StoreNode.type is "semantic", "episodic", or "procedural", |
| V83 | error/warning | Every store should have a scope defined. Warning level |
| V84 | error | Every source in RetrievalNode.sources must match a store ID in ast.stores |
| V85 | error | Remote backends (pinecone, neo4j, qdrant, pgvector) require a connection field |
| V86 | error | Every ID in AgentNode.memory must match a store ID in ast.stores |
| V87 | error/warning | `orchestrator.delegation` must be "subagent" or "inline" |
| V88 | error/warning | Every store in an agent's `custodian-of` must reference a declared store |
| V89 | error | `agent.prompt` must be a `prompt { }` block, not a `prompt: "path"` key-value pair (the string form belongs to `skill`) |
| V90 | error | A field value must not swallow the next field — fields are one per line (`spec/grammar.md` §2) |
| V91 | error | A required field must not be satisfied by a parser-injected placeholder — `meta.version` and `orchestrator.model` are required, and their sentinels (`0.0.0`, `unknown`) satisfied every downstream check |
| V92 | error | An edge's attributes go in ONE bracket, comma-separated — `[when ...] [max N]` produced a condition string containing brackets, silently |
| V93 | warning | An edge between two agents that both declare paths should declare a handoff — `writer.writes \| reader.reads` empty means the receiver runs after the sender with none of its output |
| V94 | error | A hook's `type` is `command`, `prompt` or `mod`; `flag:` belongs only to a mod and is an env variable name — `type: mod` passed silently and was scaffolded as a bash command |
| V95 | error | A hook's `on:` must fit its type — a mod takes a known engine event (`tool.call`, `prompt.submit`; five more seen in the engine warn as unproven), a command/prompt hook a PascalCase event |
| V96 | error | A gate or hook `run` must be a command, not prose — a sentence there compiled to junk script files (`E;`, `fail:`) and crashed scaffold with EISDIR; the explanation belongs in `description` |
| V97 | error | A node, skill or command `file:` must be a project-relative path (no `..`, not absolute, safe names) — it marks hand-written internals scaffold never writes, so it must be a path scaffold can honour |
| V98 | error | A `gate`, `hook`, `tool`, `job`, `command` or `level` block must sit inside its container (`gates`, `hooks`, `tools`, `schedule`, `triggers`, `depth`) — written beside it, it was dropped with no message and validate passed |
| V99 | warning | An agent's `skills:` and `mcp-servers:`, and a skill's `agent:`, should name something the topology declares (or a built-in agent) — a misspelled name compiled to a reference Claude Code could not resolve, with no message |
| V100 | error | A hook has what its type needs (command/prompt/agent: `run`; http: `url`; mcp_tool: `server` and `tool`; `async` only on a command), and a prompt or agent judge sits on an event Claude Code runs judges for |
| V101 | error | An agent's `runs:` is `subagent`, `session`, `inline` or `fork`, and an `independent` node does not run `inline` (it would read the author's reasoning) |
| V102 | error | Every field and block name in a node, `meta`, a hook, job, artifact, tool or skill, and every topology section, is one the parser reads — a typo, a field of another node type or an unknown block vanished from the AST while validate passed. Contents of free-form blocks (`prompt`, `extensions`, `settings`, `env`, `memory`, ...) are not checked yet |
| V103 | error | An agent's or gate's `behavior:` is `advisory` or `blocking` — any other value was kept and emitted into the scaffold unchecked |
| V104 | error | `strength:` (on a gate, a hook or a flow edge) is `refuse`, `detect`, `hope` or `none`, and a gate's `by:` is `code`, `hook`, `settings` or `gate` |
| V105 | error | A flow edge's `guard:` names a hook in `hooks { }` or a gate in `gates { }`, so an edge is never credited with a refusal nothing provides |
| V106 | error | An `at:` citation is a safe project-relative `"path"` or `"path:line"`, and a gate's `match:` has an `at:` to be looked for in. Whether the file, line and match text exist is read by `guard --check`, never by validate |
| V107 | error | A hook matcher can match: not permission-rule syntax (`Bash(rm -rf *)`, which belongs in `if:`), not the dotted `mcp.server.*` form, not a bare `mcp__server` (which matches no tool), and a regex that compiles. A hook's `if:` sits on a tool event, the only ones Claude Code reads it on |
| V108 | warning | A hook's `run: "exit N"` with N other than 0 or 2 does not block: only exit 2 blocks |
| V109 | warning | A hook with `strength: refuse` on PreToolUse or PermissionRequest that matches a tool of an MCP server matches every tool of that server the topology names (`validate --inventory` adds the inventory's tool names) |
| V110 | warning | A gate before an action with `commands:` has neither a ledger (explicit, or the only record) nor `run:`, so there is nothing to check |
| V111 | error | An action's `unit-from` is not a valid regex, or has no capture group |
| V112 | error | A gate's `ledger:` names no declared record; a record path is unsafe (`{unit}` allowed); or a gate before an action needs a ledger, names none, and several records exist |
| V113 | error | Session agent forms: a `runs: session` agent id is kebab-case (it is also its session name and message address); `place:` is a plain name; `permission-mode:` is `default`, `acceptEdits`, `plan`, `bypassPermissions` or `auto`; an edge's `[message:]` is `ticket`, `report` or `ask`; a `talk: hub` names a session agent |
| V114 | warning | Two or more session agents and no flow edge between any two of them: `talk not declared: unguarded` |
| V115 | warning | With the `hub` pattern, a session-to-session edge that does not touch the hub node |
| V116 | warning | Two agents claim one decision with `decides:`, or a decision listed in the topology's `decisions: [...]` has no agent claiming it |
| V117 | warning | A `runs: session` agent sets `background`, `skills` or `permissions`, which are ignored when run as a session (one warning per field) |
| V118 | warning | A talk edge joins two session agents that declare different `permission-mode`s: a session in another permission mode holds incoming messages for its user, so the edge may not arrive |
| V119 | warning | `model:` is a bare alias (`opus`, `sonnet`, `haiku`, `fable`) while the topology sets `pin-models: true`: an alias resolves differently over time, so use the exact id for a pinned run |
| V120 | warning | An agent with `decides:` has an incoming talk edge: a decision can arrive there as a message from another session. The binding logs each prompt as `typed` or `arrived` in `.claude/state/talk.jsonl` instead of refusing messages by keyword |
| V121 | error | A store with `owner:` is written by two agents and neither is the owner (the message names both), or its owner is not an agent. An unowned store is not checked |
| V122 | error | `machine:` on a session agent, a schedule job or a store names a machine that is not in the top-level `machines { }` block |
| V123 | error | A hook, gate, tool or action command holds an absolute path into one person's home folder (`/Users/<x>/`, `/home/<x>/`, `C:\\Users\\`); it only works on that machine |
| V124 | error | A schedule job's `carrier:` is not one of `session`, `cron`, `launchd`, `cloud`, `calendar`, or its `survives:` is not one of `pane-close`, `reboot`, `away` |
| V125 | error | A schedule job has `carrier: session` and any `survives:`: a session cron dies with its session and after 7 days |
| V126 | warning | A human step's `who:` person is away today or later: the message names the step, the person, the window and the step's timeout behavior (or says it has no timeout) |
| V127 | error | A human's `who:` is no `person` block, or a person's `away:` or a human's `valid:` is not a real `YYYY-MM-DD..YYYY-MM-DD` window |
| V128 | error | An `inventory { roots }` entry is an absolute path, a home path (`~`) or holds `..`; a root must be a folder inside the project |
| V129 | error | `needs memory:` is not a `~/<path>` under the user's home (an absolute path or `..` is refused), or a `user-skills` or `connectors` entry is a path instead of a bare name |

> Sections above document the first 35 rules with worked examples. The rest are
> single-line entries here plus their doc comment in the source. Adding an
> example section for a rule is always welcome.
