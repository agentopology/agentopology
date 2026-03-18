# AgenTopology Validation Rules

Created by Nadav Naveh

These 29 rules are enforced by the `.at` compiler at parse time. A topology that violates any rule is rejected before scaffold generation.

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

Only known sub-blocks are expected inside the `memory` section: `domains`, `references`, `external-docs`, `metrics`, and `workspace`. Any other named sub-block is parsed but flagged as a **warning**.

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

## Summary Table

| Rule | Severity | Description |
|------|----------|-------------|
| V1 | error | Unique names — all agent, action, and gate names must be globally unique |
| V2 | error | No keyword names — names cannot match reserved keywords |
| V3 | error | Flow resolves — every flow reference must be a declared node |
| V4 | error | No orphans — every agent must appear in flow or have `invocation: manual` |
| V5 | error | Outputs exist — `[when x.y]` must reference a declared output |
| V6 | error | Bounded loops — every back-edge must have `[max N]` |
| V7 | error | Model required — every agent and orchestrator must have a model |
| V8 | error | Imports resolve — import paths must point to existing files |
| V9 | error | Actions handled — flow actions must appear in `orchestrator.handles` |
| V10 | warning | Prompts exist — prompt blocks should not be empty |
| V11 | error | Reads/writes consistent — data dependencies must match flow order |
| V12 | error | Edge attribute order — must be `[when, max, per]` |
| V13 | error | Gate placement — `after` and `before` must reference declared nodes |
| V14 | error | Tool exclusivity — cannot have both `tools` and `disallowed-tools` |
| V15 | error | Exhaustive conditions — conditional edges must cover all output values |
| V16 | error | API key env vars — provider `api-key` must use `${ENV_VAR}` syntax |
| V17 | error | Single default provider — at most one provider may be default |
| V18 | warning | Model in provider — agent models should exist in a provider's list |
| V19 | error | Unique provider names — no duplicate provider names |
| V20 | error | Schedule job references — jobs must reference declared nodes; cron/every exclusive |
| V21 | error | Interface secret detection — sensitive fields must use `${ENV_VAR}` syntax |
| V22 | warning | Fallback chain models — fallback models should exist in a provider's list |
| V23 | warning | Duplicate sections — singleton sections should appear at most once |
| V24 | warning | Unknown memory sub-blocks — only known sub-blocks are expected |
| V25 | warning | Bounce-back advisory — `on-fail: bounce-back` is advisory on CLI bindings |
| V26 | error | Action kind enum — must be external, git, decision, inline, or report |
| V27 | warning | Agent permissions enum — should be a recognized permission mode |
| V28 | error | Metering format enum — must be json, jsonl, or csv |
| V29 | warning | Metering pricing enum — should be a recognized pricing model |
