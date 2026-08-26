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

All 90 rules, generated from `src/parser/validator.ts` so the spec cannot drift
from the implementation. Rules V8, V12, V23, V24, V89 and V90 are collected at
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
| V8 | error/warning | Import references should resolve (warning only -- we cannot check the filesystem) |
| V9 | error/warning | Every action referenced in flow must appear in orchestrator.handles |
| V10 | error/warning | Prompt content should not be empty if a prompt block is declared |
| V11 | error | If agent A writes X and agent B reads X, a path A -> B must exist in flow |
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
| V25 | error/warning | `on-fail: bounce-back` enforcement depends on the gate's `after` target |
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

> Sections above document the first 35 rules with worked examples. The rest are
> single-line entries here plus their doc comment in the source. Adding an
> example section for a rule is always welcome.
