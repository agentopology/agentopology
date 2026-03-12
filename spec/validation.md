# AgentTopology Validation Rules

Created by Nadav Naveh

These 19 rules are enforced by the `.at` compiler at parse time. A topology that violates any rule is rejected before scaffold generation.

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
