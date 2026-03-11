# AgentTopology Language Specification v1.0

Created by Nadav Naveh

**Extension:** `.at`
**Language:** AgentTopology

---

## 1. Principles

1. **Single-valued** -- Every construct has exactly one interpretation. No ambiguity.
2. **Single source of truth** -- The `.at` file defines the structure. Files are generated from it.
3. **Readable** -- A non-engineer can understand the topology by reading it.
4. **Parseable** -- LL(2) grammar. A compiler can extract the full graph deterministically in O(n) time with no backtracking.

---

## 2. Lexical Rules

### Comments
```
# single-line comment
```

Everything after `#` until end-of-line is ignored.

### Primitive Types

```ebnf
string           = '"' <any-char-except-quote>* '"'
number           = [0-9]+ ('.' [0-9]+)?
boolean          = 'true' | 'false'
identifier       = [a-z] [a-z0-9-]*
template-var     = [A-Z] [A-Z0-9_-]*
```

- `string` -- always quoted with double quotes
- `number` -- integer (3, 42) or decimal (4.5, 6.5). Numbers establish ordering: 4.5 is between 4 and 5.
- `boolean` -- `true` or `false`, unquoted
- `identifier` -- lowercase, hyphens allowed, starts with letter
- `template-var` -- uppercase, underscores/hyphens allowed, starts with letter. Used for `argument` in triggers.

**Rule:** Quote strings. Don't quote identifiers, numbers, or booleans.

### Composite Types

```ebnf
name-list       = '[' identifier (',' identifier)* ']' | '[]'
string-list     = '[' string (',' string)* ']' | '[]'
id-list         = name-list                            # alias
path-list       = '[' (string | 'ticket') (',' (string | 'ticket'))* ']' | '[]'
tool-list       = '[' tool-item (',' tool-item)* ']' | '[]'
tool-item       = identifier                           # Read, Write, Bash, Agent
                | identifier '(' string ')'            # Bash("pattern")
                | 'mcp.' identifier '.*'               # mcp.gitnexus.*
                | 'mcp.' identifier '.' identifier     # mcp.render.list_logs
typed-map       = '{' (identifier ':' enum-values)+ '}'
enum-values     = identifier ('|' identifier)*
skip-expr       = 'not' identifier                     # tag negation
                | identifier '.' identifier op value   # condition
op              = '==' | '!=' | '>=' | '<=' | '>' | '<'
value           = number | identifier
import-path     = './' [a-zA-Z0-9._/-]+ '.at'
```

`ticket` in a `path-list` is a reserved keyword referring to the input ticket data. It appears unquoted.

### Template Variables
```
{IDENTIFIER}            # uppercase letters, underscores, hyphens
```

Template variables appear inside quoted strings and are expanded at runtime. Built-in:
- `{TICKET}` -- ticket identifier from trigger command
- `{BATCH_ID}` -- auto-generated batch run identifier

Custom variables are declared via `triggers.command.argument`.

### Blocks

```ebnf
named-block     = keyword identifier '{' field* '}'
anonymous-block = keyword '{' field* '}'
sub-block       = keyword identifier '{' field* '}'      # gate, command, level
nested-object   = identifier ':' '{' field* '}'          # outputs, conflicts
field           = identifier ':' value
```

- **Named blocks:** `agent explorer { ... }`, `action intake { ... }`
- **Anonymous blocks:** `meta { ... }`, `flow { ... }`, `orchestrator { ... }`
- **Sub-blocks:** `gate validation { ... }`, `command ship { ... }`, `level 1 "label" { ... }`
- **Nested objects:** `outputs: { depth: 1 | 2 | 3 }`, `conflicts: { detect: [...] }`

Curly braces delimit all blocks. Indentation is cosmetic.

### Lists
```
tools: [Read, Write, Edit, Bash]
```

Square brackets, comma-separated. `[]` is a valid empty list meaning "none."

An explicit empty list (e.g., `tools: []`) means "no items" -- distinct from omitting the field entirely (which uses the default).

### Typed Enums (for outputs)
```
verdict: pass | fail | plan-gap
```

Pipe-separated identifiers after a field name.

---

## 3. File Types

Every `.at` file has exactly one root keyword:

| Root | Purpose | Example |
|------|---------|---------|
| `topology` | A complete agentic structure | `pipeline.at` |
| `library` | Reusable agent definitions | `shared-agents.at` |

### 3.1 Path Resolution

All string paths in `.at` files are **relative to the output directory** scaffolded from the topology. The exact output structure depends on the binding (see Section 11: Bindings).

| `.at` field | Example value | Resolves to |
|-------------|---------------|-------------|
| `tools.tool.script` | `"scripts/ocr-pipeline.sh"` | `<output-dir>/scripts/ocr-pipeline.sh` |
| `gates.gate.run` | `"scripts/validate.sh"` | `<output-dir>/scripts/validate.sh` |
| `hooks.hook.run` | `"scripts/emit-event.sh"` | `<output-dir>/scripts/emit-event.sh` |
| `agent.prompt` | `"prompts/classifier.md"` | `<output-dir>/prompts/classifier.md` |
| `agent.reads/writes` | `"workspace/raw/"` | Runtime workspace path (not output-relative) |
| `memory.domains.path` | `"domains/"` | `<output-dir>/domains/` |

**Why output-relative:** Each topology scaffolds into a self-contained directory. Scripts, prompts, references, and domains belong to the topology that owns them. This avoids path collisions when multiple topologies coexist in the same project.

**Exception:** `reads`/`writes` paths are runtime workspace paths, resolved by the orchestrator at execution time (typically relative to the working directory, not the output directory). The shared workspace is accessible to all agents.

---

## 4. Grammar

### 4.1 `topology`

```ebnf
file            = import* topology | import* library
topology        = 'topology' identifier ':' '[' pattern-list ']' '{' topology-body '}'
pattern-list    = identifier (',' identifier)*
topology-body   = topology-section*
topology-section = meta | orchestrator | roles | action | agent | skill-decl | use-stmt
                 | memory | flow | gates | depth | batch | environments | triggers
                 | hooks | settings | mcp-servers | metering | tools
```

**Ordering:** Sections may appear in any order. Each of `meta`, `orchestrator`, `roles`, `memory`, `flow`, `gates`, `depth`, `batch`, `environments`, `triggers`, `hooks`, `settings`, `mcp-servers`, `metering`, and `tools` may appear **at most once** (parser error on duplicates). `action`, `agent`, `skill-decl`, and `use-stmt` may appear multiple times.

Sub-block productions used within topology-body:

```ebnf
action          = 'action' identifier '{' action-fields '}'
action-fields   = ('kind' ':' action-kind | 'source' ':' string
                  | 'commands' ':' name-list | 'description' ':' string)*
action-kind     = 'external' | 'git' | 'decision' | 'inline' | 'report'
agent           = 'agent' identifier '{' agent-fields '}'
use-stmt        = 'use' identifier '{' agent-fields '}'
gate-decl       = 'gate' identifier '{' gate-fields '}'
gate-fields     = ('after' ':' identifier | 'before' ':' identifier | 'run' ':' string
                  | 'checks' ':' name-list | 'retry' ':' number
                  | 'on-fail' ':' ('bounce-back' | 'halt')
                  | 'behavior' ':' ('advisory' | 'blocking'))*
command-decl    = 'command' identifier '{' command-fields '}'
level-decl      = 'level' number string '{' 'omit' ':' name-list '}'
env-decl        = identifier '{' (identifier ':' (identifier | string))* '}'
model-id        = model-identifier | 'inherit'
perm-enum       = perm-identifier
```

**Model identifiers:** A model identifier is any string matching `[a-z][a-z0-9-/.]*`. This allows short aliases (`opus`, `sonnet`, `haiku`) as well as full model strings (`gpt-4o`, `gemini-pro`, `claude-sonnet-4-20250514`, `llama-3.1-70b`). The special value `inherit` means the agent inherits the model from its orchestrator or parent context.

> **Examples:** `opus`, `sonnet`, `haiku`, `gpt-4o`, `gemini-2.0-flash`, `claude-sonnet-4-20250514`, `llama-3.1-70b`, `mistral-large`, `inherit`

**Permission identifiers:** Permissions use an extensible set of universal concepts:

| Permission | Meaning |
|------------|---------|
| `autonomous` | Agent can read and write without confirmation |
| `supervised` | Agent can read freely but proposes writes for approval |
| `interactive` | Agent requires confirmation for all actions |
| `unrestricted` | Agent bypasses all permission checks |

> **Note for binding authors:** Bindings may alias these to platform-specific terms. For example, a Claude Code binding maps `autonomous` to `auto` and `supervised` to `plan`. Short aliases (`auto`, `plan`, `confirm`, `bypass`) are also accepted by the parser for backward compatibility.

**Patterns** -- composable list from the topology catalog:

| Pattern | What it adds |
|---------|-------------|
| `pipeline` | Sequential phases |
| `supervisor` | Central control, isolated workers |
| `blackboard` | Shared state |
| `orchestrator-worker` | Dynamic task discovery |
| `debate` | Peer challenge |
| `market-routing` | Auction scoring |
| `consensus` | Quorum voting |
| `fan-out` | Parallel slices |
| `event-driven` | Pub-sub |
| `human-gate` | Human approval points |

---

### 4.2 `library`

```ebnf
library         = 'library' identifier '{' agent* '}'
```

A library is a collection of reusable agents. No flow, no orchestrator, no triggers.

---

### 4.3 `import` and `use`

```ebnf
import          = 'import' identifier 'from' import-path
```

```agenttopology
import meta-reviewer from ./shared-agents.at

topology my-team : [pipeline] {
  use meta-reviewer {}                  # as-is, no overrides
  use meta-reviewer { phase: 7 }       # with overrides
}
```

`import` loads a definition. `use` places it into the topology. Braces always required on `use`.

**Import path:** Unquoted, starts with `./`, ends with `.at`. Matches `import-path` production in Section 2.

**Merge semantics:** `use` applies REPLACE on specified fields. Omitted fields KEEP their original values. Shallow merge -- nested objects (like `outputs`) and lists (like `reads`) are replaced entirely if specified, not appended.

---

### 4.4 `meta`

```agenttopology
meta {
  version: "1.3.0"
  description: "Autonomous development pipeline"
}
```

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `version` | string | yes | -- |
| `description` | string | yes | -- |

---

### 4.5 `orchestrator`

The coordinator that runs the flow. Handles actions inline, spawns agents.

```agenttopology
orchestrator {
  model: opus
  generates: "commands/ship.md"
  handles: [intake, classify, context]
  outputs: {
    depth: 1 | 2 | 3
  }
}
```

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `model` | model-id | yes | -- |
| `generates` | string | no | -- |
| `handles` | name-list | yes | -- |
| `outputs` | typed-map | no | `{}` |

**Orchestrator outputs** are referenced in flow as `orchestrator.<output>`.

---

### 4.6 `agent`

```ebnf
agent           = 'agent' identifier '{' agent-fields '}'
agent-fields    = agent-field*
agent-field     = 'role' ':' identifier
                | 'model' ':' model-id
                | 'permissions' ':' perm-enum
                | 'prompt' ':' string
                | 'phase' ':' number
                | 'tools' ':' tool-list
                | 'disallowed-tools' ':' tool-list
                | 'reads' ':' path-list
                | 'writes' ':' path-list
                | 'outputs' ':' typed-map
                | 'skip' ':' skip-expr
                | 'retry' ':' number
                | 'isolation' ':' 'worktree'
                | 'invocation' ':' ('manual' | 'auto')
                | 'behavior' ':' ('advisory' | 'blocking')
                | 'memory' ':' ('user' | 'project' | 'local')
                | 'skills' ':' name-list
                | 'mcp-servers' ':' name-list
                | 'background' ':' boolean
                | 'description' ':' string
                | agent-hooks
                | agent-scale
agent-hooks     = 'hooks' '{' hook-decl* '}'
agent-scale     = 'scale' '{' scale-fields '}'
scale-fields    = scale-field*
scale-field     = 'mode' ':' ('auto' | 'fixed' | 'config')
                | 'by' ':' ('batch-count' | 'doc-count' | 'token-volume' | 'source-count')
                | 'min' ':' number
                | 'max' ':' number
                | 'batch-size' ':' number
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `role` | identifier | no | -- | Maps to a role defined in the `roles` block |
| `model` | model-id | yes | -- | LLM model identifier (e.g., `opus`, `gpt-4o`, `gemini-pro`) |
| `permissions` | perm-enum | no | `autonomous` | Permission mode |
| `prompt` | string | no | -- | Path to the agent's instruction file |
| `phase` | number | no | -- | Pipeline position (ordering by numeric value) |
| `tools` | tool-list | no | all | Tool allowlist |
| `disallowed-tools` | tool-list | no | `[]` | Explicit deny-list |
| `reads` | path-list | no | `[]` | Input artifacts |
| `writes` | path-list | no | `[]` | Output artifacts |
| `outputs` | typed-map | no | `{}` | Values that affect flow |
| `skip` | skip-expr | no | -- | Skip condition |
| `retry` | number | no | `0` | Max validation rounds |
| `isolation` | `worktree` | no | -- | Git worktree isolation |
| `invocation` | `manual` / `auto` | no | `auto` | User-triggered only |
| `behavior` | `advisory` / `blocking` | no | `blocking` | Advisory never blocks flow |
| `memory` | `user` / `project` / `local` | no | -- | Persistent memory scope |
| `skills` | name-list | no | `[]` | Skills to preload |
| `mcp-servers` | name-list | no | `[]` | MCP servers available |
| `background` | boolean | no | `false` | Run in background |
| `description` | string | no | -- | Human-readable purpose of this agent |
| `scale` | agent-scale | no | -- | Dynamic scaling configuration (see below) |
| `hooks` | agent-hooks | no | -- | Per-agent hooks (scoped to agent lifetime) |

**Per-agent `hooks`:** Hooks defined inside an agent block are scoped to that agent's lifetime. They only fire while the agent is active. The hook sub-block syntax is identical to the global `hooks` section -- same fields (`on`, `matcher`, `run`, `type`, `timeout`), same hook events.

**`tools` vs `disallowed-tools`:** Mutually exclusive. Parser error if both are specified on the same agent. Use `tools` to allowlist (only these). Use `disallowed-tools` to denylist (all except these).

**Tool list deduplication:** If both an unrestricted tool and a constrained variant appear (e.g., `Bash` and `Bash("pattern")`), the unrestricted form subsumes the constrained. The constrained entry is ignored. No parser error.

**Skip expression disambiguation:** The parser checks the first token after `skip:`. If it is `not`, parse as tag-negation (`not <tag>`). Otherwise, parse as condition (`<source>.<output> <op> <value>`). These are lexically unambiguous -- `not` is a keyword, conditions always contain a dot.

**When an agent is skipped:** The agent is treated as instantly completed with no outputs. Flow continues to the next node(s) via unconditional outgoing edges. Conditional outgoing edges that reference the skipped agent's outputs are **not taken** (outputs are undefined). This is a validation-time check: if skipping an agent would leave the flow with no viable path, it is a validation error.

**Outputs** are referenced in flow as `<agent-name>.<output-name>`.

**Agent `scale`:** Dynamic scaling allows an agent definition to spawn multiple instances at runtime based on workload. Define one agent with a `scale` block and the orchestrator spawns the right number of instances.

```agenttopology
agent classifier {
  role: analyst
  model: sonnet
  phase: 3
  background: true
  scale {
    mode: auto
    by: batch-count
    min: 2
    max: 12
    batch-size: 25
  }
}
```

| Scale Field | Type | Required | Default | Description |
|-------------|------|----------|---------|-------------|
| `mode` | `auto` / `fixed` / `config` | no | `fixed` | How instance count is determined |
| `by` | `batch-count` / `doc-count` / `token-volume` / `source-count` | no | `batch-count` | Metric that drives scaling |
| `min` | number | no | `1` | Minimum instances |
| `max` | number | no | `6` | Maximum instances |
| `batch-size` | number | no | `25` | Items per batch (for batch-count mode) |

**Scale modes:**
- `fixed` -- always spawn `min` instances. Equivalent to omitting `scale` entirely.
- `auto` -- orchestrator counts the workload (e.g., total docs / batch-size = batch count), then spawns `min(max, max(min, batch-count))` instances.
- `config` -- read instance count from a configuration file. Useful when the user wants manual control.

**Scale in flow:** When an agent has `scale`, its flow edges apply to ALL instances. `deduplicator -> classifier` means "deduplicator feeds all classifier instances." `classifier -> synthesizer` means "all classifier instances feed synthesizer." The orchestrator handles fan-out distribution and merge.

**Backward compatibility:** An agent without `scale` behaves as `scale { mode: fixed  min: 1  max: 1 }` -- exactly one instance, identical to current behavior.

---

### 4.7 `action`

Orchestrator-handled steps (not agent spawns).

```agenttopology
action <name> {
  kind: <action-kind>
  source: "<source>"
  commands: [<cmd>, ...]
  description: "<text>"
}
```

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `kind` | action-kind | yes | -- |
| `source` | string | no | -- |
| `commands` | name-list | no | `[]` |
| `description` | string | no | -- |

**action-kind:** `external` | `git` | `decision` | `inline` | `report`

Actions **cannot have outputs**. Only `agent` and `orchestrator` produce outputs.

---

### 4.8 `roles`

```agenttopology
roles {
  explorer: "Deep codebase analysis and blast radius mapping"
  builder: "Implement code changes following the plan"
}
```

Maps role identifiers to human-readable descriptions. Agents reference roles with the `role` field.

---

### 4.9 `memory`

```ebnf
memory          = 'memory' '{' memory-sub-block* '}'
memory-sub-block = identifier '{' (identifier ':' (string | identifier | name-list))* '}'
```

```agenttopology
memory {
  domains {
    path: "domains/"
    routing: "FILE_MAP.md"
    index: "INDEX.json"
  }

  references {
    path: "references/"
    blueprints: [bugfix, feature, refactor]
  }

  external-docs {
    path: "docs/"
    files: ["agent-sdk.md", "composio-sdk.md"]
    load-when: "FILE_MAP.md"
  }

  metrics {
    path: "metrics.jsonl"
    mode: append-only
  }

  workspace {
    path: "runs/{TICKET}/"
    protocol: "workspace-protocol.md"
    structure: [explore, plan, build, qa]
  }
}
```

| Sub-block | Fields | Description |
|-----------|--------|-------------|
| `domains` | `path` (string), `routing` (string), `index` (string, optional) | Shared knowledge base |
| `references` | `path` (string), `blueprints` (name-list) | Static documentation |
| `external-docs` | `path` (string), `files` (string-list), `load-when` (string) | Conditional documentation |
| `metrics` | `path` (string), `mode` (identifier: `append-only`) | Execution log |
| `workspace` | `path` (string), `protocol` (string), `structure` (name-list) | Per-run working directory |

Memory sub-blocks are named blocks with known field schemas. Unknown sub-block names are parser errors.

---

### 4.10 `flow`

```ebnf
flow            = 'flow' '{' flow-statement* '}'
flow-statement  = node ('->' node)+ edge-attrs?
node            = identifier | '[' identifier (',' identifier)+ ']'
edge-attrs      = '[' attr (',' attr)* ']'
attr            = 'when' condition | 'max' number | 'per' identifier
condition       = identifier '.' identifier op value
```

```agenttopology
flow {
  intake -> classify
  classify -> researcher        [when orchestrator.depth >= 2]
  classify -> context           [when orchestrator.depth == 1]
  researcher -> builder
  context -> builder
  builder -> reviewer
  reviewer -> builder           [when reviewer.verdict == revise, max 2]
  reviewer -> done              [when reviewer.verdict == approve]
  reviewer -> researcher        [when reviewer.verdict == reject, max 1]
}
```

**Operators:**

| Syntax | Meaning |
|--------|---------|
| `a -> b` | Sequential: a completes, then b starts |
| `a -> b -> c` | Chained: syntactic sugar for `a -> b` + `b -> c` |
| `a -> [b, c, d]` | Fan-out: a completes, then b, c, d run in parallel |
| `a -> [b, c] [when x]` | Conditional fan-out: condition applies to the fan-out as a whole |
| `[when x.y == z]` | Conditional: edge taken only when condition is true |
| `[max N]` | Bounded loop: back-edge limited to N iterations |
| `[per ticket]` | One instance per unit (currently only `ticket` is valid) |

**Chained flows:** `a -> b -> c [when x]` desugars to `a -> b` + `b -> c [when x]`. Edge attributes apply to the **last edge only**.

**Edge attribute order:** `[when <condition>, max <N>, per <unit>]`. Parser error on wrong order.

**Condition format:** `<source>.<output> <op> <value>`
- Source must be an agent name or `orchestrator`
- Output must be declared in that source's `outputs` block
- Operators: `==` `!=` `>=` `<=` `>` `<`

**Exhaustive conditions:** When a node has ONLY conditional outgoing edges, the conditions must be exhaustive over the output's enum values that are **reachable** at that node. If no condition matches at runtime, it is a **runtime error** (flow halts). Validation rule 15 checks for exhaustiveness at parse time, accounting for upstream routing that eliminates certain values.

**Unconditional edges:** An edge without `[when]` is always taken. If a node has both unconditional and conditional edges, the unconditional edge is always taken regardless of conditions.

**Flow nodes** must resolve to one of:
- An `agent` name
- An `action` name
- A `gate` name (inside `gates` block)

---

### 4.11 `gates`

```ebnf
gates           = 'gates' '{' gate-decl* '}'
gate-decl       = 'gate' identifier '{' gate-fields '}'
```

Gates are auto-injected checkpoints. A gate with `after: X` and `before: Y` is inserted between X and Y in the flow graph. The edge `X -> Y` becomes `X -> gate -> Y`.

If `before` is omitted, the gate runs after `after` completes as a side-effect -- not a flow graph node, but a triggered hook.

Gates execute in declaration order when multiple gates share the same `after`/`before` pair.

```agenttopology
gates {
  gate validation {
    after: builder
    before: deployer
    run: "scripts/validate.sh"
    checks: [typecheck, lint, test, build]
    retry: 3
    on-fail: bounce-back
  }

  gate security-scan {
    after: builder
    run: "scripts/security-scan.sh"
    behavior: advisory
  }
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `after` | identifier | yes | -- | Predecessor node |
| `before` | identifier | no | -- | Successor node (omit for side-effect) |
| `run` | string | yes | -- | Script to execute |
| `checks` | name-list | no | `[]` | Named check items |
| `retry` | number | no | `0` | Max retry attempts |
| `on-fail` | `bounce-back` / `halt` | no | `halt` | Failure behavior |
| `behavior` | `advisory` / `blocking` | no | `blocking` | Advisory gates never block |

---

### 4.12 `depth`

```ebnf
depth           = 'depth' '{' 'factors' ':' name-list level-decl+ '}'
level-decl      = 'level' number string '{' 'omit' ':' name-list '}'
```

```agenttopology
depth {
  factors: [file-count, domain-count, complexity]

  level 1 "Simple" {
    omit: [researcher, planner]
  }

  level 2 "Medium" {
    omit: [planner]
  }

  level 3 "Complex" {
    omit: []
  }
}
```

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `factors` | name-list | yes | -- |
| `level` | sub-block: `level <number> <string> { omit: <name-list> }` | 1+ required | -- |

`level` sub-block syntax: `level <number> <string> { omit: <name-list> }`. The number is the depth level. The string is a human label. `omit` lists agents to skip at this level.

---

### 4.13 `batch`

```agenttopology
batch {
  parallel: true
  per: ticket
  conflicts: {
    detect: ["metrics.jsonl", "INDEX.md"]
    resolve: sequential-rebase
  }
  workspace: "runs/_batch/{BATCH_ID}/"
}
```

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `parallel` | boolean | no | `false` |
| `per` | identifier | yes | -- |
| `conflicts` | nested-object | no | -- |
| `conflicts.detect` | string-list | no | `[]` |
| `conflicts.resolve` | `sequential-rebase` | no | -- |
| `workspace` | string | no | -- |

---

### 4.14 `environments`

```ebnf
environments    = 'environments' '{' env-decl* '}'
env-decl        = identifier '{' (identifier ':' (identifier | string))* '}'
```

```agenttopology
environments {
  staging {
    target-branch: develop
    url: "staging.example.com"
  }

  production {
    target-branch: main
    url: "app.example.com"
  }
}
```

Environment blocks have no fixed schema -- fields are identifier/string key-value pairs. The environment name is the identifier.

---

### 4.15 `triggers`

```ebnf
triggers        = 'triggers' '{' command-decl* '}'
command-decl    = 'command' identifier '{' command-fields '}'
command-fields  = 'pattern' ':' string ('argument' ':' template-var)?
```

```agenttopology
triggers {
  command process {
    pattern: "/process <TICKET>"
    argument: TICKET
  }

  command deploy {
    pattern: "/deploy"
  }
}
```

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `pattern` | string | yes | -- |
| `argument` | template-var | no | -- |

---

### 4.16 `hooks`

```ebnf
hooks           = 'hooks' '{' hook-decl* '}'
hook-decl       = 'hook' identifier '{' hook-fields '}'
hook-fields     = ('on' ':' hook-event | 'matcher' ':' string | 'run' ':' string
                  | 'type' ':' hook-type | 'timeout' ':' number)*
hook-event      = <universal-event> | <platform-event>
hook-type       = 'command' | 'prompt'
```

**Universal hook events** -- these are defined by the spec and must be supported by all bindings:

| Event | When it fires |
|-------|---------------|
| `AgentStart` | When an agent spawns |
| `AgentStop` | When an agent finishes |
| `ToolUse` | Before or after a tool runs |
| `Error` | When an error occurs |
| `SessionStart` | When a session begins |
| `SessionEnd` | When a session ends |

**Platform-specific events** -- bindings may define additional events. For example:

| Event | Platform | Description |
|-------|----------|-------------|
| `PreToolUse` | Claude Code | Before a tool runs (maps to universal `ToolUse`) |
| `PostToolUse` | Claude Code | After a tool runs |
| `SubagentStart` | Claude Code | When an agent spawns (maps to universal `AgentStart`) |
| `SubagentStop` | Claude Code | When an agent finishes (maps to universal `AgentStop`) |
| `Stop` | Claude Code | When the session ends |
| `UserPromptSubmit` | Claude Code | When user submits a prompt |
| `PreCompact` | Claude Code | Before context compaction |

> **Note for binding authors:** When implementing a binding, map universal events to your platform's event system. You may also accept platform-specific event names directly for convenience. The parser accepts any identifier in PascalCase as a hook event name.

```agenttopology
hooks {
  hook security-check {
    on: ToolUse
    matcher: "Bash"
    run: "scripts/security-check.sh"
    type: command
  }

  hook log-agents {
    on: AgentStop
    run: "scripts/log-agent.sh"
    type: command
  }
}
```

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `on` | hook-event | yes | -- |
| `matcher` | string | no | -- |
| `run` | string | yes | -- |
| `type` | hook-type | no | `command` |
| `timeout` | number | no | `600` |

---

### 4.17 `settings`

```ebnf
settings        = 'settings' '{' settings-field* '}'
settings-field  = 'allow' ':' string-list
                | 'deny' ':' string-list
                | 'ask' ':' string-list
```

```agenttopology
settings {
  allow: ["Bash(npm run *)", "Read", "Grep", "Glob"]
  deny: ["Bash(rm -rf *)", "Bash(git push --force)"]
  ask: ["Bash(git push)"]
}
```

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `allow` | string-list | no | `[]` |
| `deny` | string-list | no | `[]` |
| `ask` | string-list | no | `[]` |

---

### 4.18 `mcp-servers`

```ebnf
mcp-servers     = 'mcp-servers' '{' mcp-decl* '}'
mcp-decl        = identifier '{' mcp-fields '}'
mcp-fields      = ('type' ':' mcp-type | 'url' ':' string
                  | 'command' ':' string | 'args' ':' string-list
                  | 'env' ':' env-map)*
mcp-type        = 'http' | 'stdio' | 'sse'
env-map         = '{' (identifier ':' string)* '}'
```

```agenttopology
mcp-servers {
  database {
    type: stdio
    command: "npx"
    args: ["-y", "database-mcp"]
  }

  monitoring {
    type: http
    url: "https://mcp.monitoring.example.com"
  }
}
```

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `type` | mcp-type | yes | -- |
| `url` | string | no | -- |
| `command` | string | no | -- |
| `args` | string-list | no | `[]` |
| `env` | env-map | no | `{}` |

`type: http` requires `url`. `type: stdio` requires `command`. Parser error if the required companion field is missing.

---

### 4.19 `metering`

Per-phase cost and performance tracking. Produces a breakdown file after each run that can be used for billing, optimization, and cost governance.

```ebnf
metering        = 'metering' '{' metering-field* '}'
metering-field  = 'track' ':' name-list
                | 'per' ':' name-list
                | 'output' ':' string
                | 'format' ':' ('json' | 'jsonl' | 'csv')
                | 'pricing' ':' ('anthropic-current' | 'custom' | 'none')
```

```agenttopology
metering {
  track: [tokens-in, tokens-out, cost, wall-time, agent-count]
  per: [phase, agent, run]
  output: "metrics/"
  format: jsonl
  pricing: none
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `track` | name-list | no | `[tokens-in, tokens-out, cost, wall-time]` | Metrics to collect |
| `per` | name-list | no | `[phase]` | Aggregation granularity |
| `output` | string | no | `"metrics/"` | Directory for metering output files |
| `format` | `json` / `jsonl` / `csv` | no | `jsonl` | Output format |
| `pricing` | `anthropic-current` / `custom` / `none` | no | `anthropic-current` | How to calculate cost |

**Track options:**
- `tokens-in` -- input tokens consumed
- `tokens-out` -- output tokens produced
- `cost` -- calculated cost based on model pricing
- `wall-time` -- elapsed wall-clock seconds
- `agent-count` -- number of agent instances spawned (relevant for scaled agents)

**Per options:**
- `phase` -- aggregate by pipeline phase number
- `agent` -- per-agent breakdown (including individual scale instances)
- `run` -- single total for the entire run

**Pricing modes:**
- `anthropic-current` -- use current Anthropic API pricing
- `custom` -- read pricing from a `pricing.json` file in the metering output directory
- `none` -- track tokens and time but don't calculate cost

**Output example** (`format: jsonl`):
```json
{"run_id": "2026-03-11T22:30:00Z", "phase": 3, "agent": "classifier", "instances": 8, "tokens_in": 2570000, "tokens_out": 450000, "cost_usd": 14.50, "wall_time_s": 1080}
```

**Backward compatibility:** A topology without `metering` simply doesn't collect cost data. No existing behavior changes.

---

### 4.20 `tools`

Topology-level declaration of custom script-based tools. Agents reference these by name in their `tools` field. Any runtime maps them to executable tool definitions.

```ebnf
tools-block     = 'tools' '{' tool-decl* '}'
tool-decl       = 'tool' identifier '{' tool-decl-fields '}'
tool-decl-fields = ('script' ':' string
                   | 'args' ':' name-list
                   | 'description' ':' string
                   | 'lang' ':' tool-lang)*
tool-lang       = 'bash' | 'python' | 'node' | 'auto'
```

```agenttopology
tools {
  tool run-tests {
    script: "scripts/run-tests.sh"
    args: [test-dir, coverage]
    lang: bash
    description: "Run test suite with optional coverage reporting"
  }

  tool extract-data {
    script: "scripts/extract-data.py"
    args: [input-path, output-path, format]
    lang: python
    description: "Extract structured data from documents"
  }
}
```

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `script` | string | yes | -- |
| `args` | name-list | no | `[]` |
| `description` | string | no | -- |
| `lang` | tool-lang | no | `auto` |

**`script`** -- Path to the script file, relative to the output directory.

**`lang`** -- Runtime hint. `auto` (default) infers from file extension (`.sh` -> bash, `.py` -> python, `.js`/`.ts` -> node). Explicit values override inference.

**`args`** -- Named arguments the script accepts. These become the tool's input schema when mapped to any platform.

**Agents reference custom tools by name:**
```agenttopology
agent processor {
  tools: [Read, Write, run-tests, extract-data]
}
```

**LL(2) note:** `tools` is a block keyword. The parser sees `tools` `{` and enters the tools-block production. Inside, each `tool` `<identifier>` `{` starts a tool-decl. No ambiguity -- `tools` as a field keyword (in agent-fields) is always followed by `:`, while `tools` as a block keyword is followed by `{`.

---

### 4.21 `skill` (declarations)

Topology-level skill declarations. Each `skill` block declares a self-contained application that bundles executable scripts, domain knowledge, reference docs, and instructions into a coherent capability. Agents load skills via their `skills` field.

When **no `skill` blocks are declared**, the scaffold generates a single default skill named after the topology. When **one or more `skill` blocks are declared**, each generates its own directory with its own scripts, domains, and references.

```ebnf
skill-decl      = 'skill' identifier '{' skill-fields '}'
skill-fields    = ('description' ':' string
                  | 'scripts' ':' name-list
                  | 'domains' ':' path-list
                  | 'references' ':' path-list
                  | 'prompt' ':' string)*
```

```agenttopology
skill orchestration {
  description: "Pipeline coordination -- phase sequencing, agent spawning, error recovery"
  scripts: [emit-event, trace-start, trace-stop]
  prompt: "prompts/orchestrator.md"
}

skill extraction {
  description: "Multi-format text extraction -- PDF, DOC, images"
  scripts: [extract-pdf, extract-docx, ocr-batch]
}

skill classification {
  description: "Document classification and scoring"
  scripts: [merge-classifications, validate-extraction]
  domains: ["domains/rubric.md", "domains/patterns.md"]
}
```

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `description` | string | no | -- |
| `scripts` | name-list | no | `[]` |
| `domains` | path-list | no | `[]` |
| `references` | path-list | no | `[]` |
| `prompt` | string | no | -- |

**`scripts`** -- Names from the `tools` block that this skill owns. The scaffold places these scripts in the skill's scripts directory.

**`domains`** -- Domain knowledge files bundled with this skill.

**`references`** -- Reference docs bundled with this skill.

**`prompt`** -- Path to the skill body content (skill-relative). If omitted, the scaffold generates a default from the description.

**Agents reference skills by name:**
```agenttopology
agent extractor {
  skills: [extraction, shared-domain]
  tools: [Read, Write, extract-pdf, extract-docx]
}
```

**How skills and tools relate:**
- The `tools` block is a **registry** -- declares all custom scripts at the topology level
- The `skill` block is an **application** -- bundles scripts + knowledge + instructions into a deployable capability
- Skills own their scripts (via `scripts` field)
- Agents load skills like apps (via `skills` field)
- An agent's `tools` field controls **which tools it can execute**; `skills` controls **which applications it loads**

**Backward compatibility:** If no `skill` blocks are declared, the scaffold generates a single skill named after the topology. Existing `.at` files continue to work unchanged.

**LL(2) note:** `skill` is a block keyword. The parser sees `skill` `<identifier>` `{` and enters the skill-decl production. No ambiguity -- `skills` (the agent field) is always followed by `:`, while `skill` (the declaration) is followed by an identifier.

---

## 5. Validation Rules

See `validation.md` for the complete list of 15 validation rules with examples.

---

## 6. Reserved Keywords

See `reserved-keywords.md` for the complete keyword list.

---

## 7. Defaults Table

All optional fields and their defaults when omitted:

| Block | Field | Default |
|-------|-------|---------|
| `orchestrator` | `outputs` | `{}` |
| `agent` | `role` | -- (none) |
| `agent` | `permissions` | `autonomous` |
| `agent` | `prompt` | -- (none) |
| `agent` | `phase` | -- (none, unordered) |
| `agent` | `tools` | all (no restriction) |
| `agent` | `disallowed-tools` | `[]` |
| `agent` | `reads` | `[]` |
| `agent` | `writes` | `[]` |
| `agent` | `outputs` | `{}` |
| `agent` | `skip` | -- (never skip) |
| `agent` | `retry` | `0` |
| `agent` | `isolation` | -- (no isolation) |
| `agent` | `invocation` | `auto` |
| `agent` | `behavior` | `blocking` |
| `agent` | `memory` | -- (none) |
| `agent` | `skills` | `[]` |
| `agent` | `mcp-servers` | `[]` |
| `agent` | `background` | `false` |
| `agent` | `hooks` | -- (none) |
| `action` | `source` | -- (none) |
| `action` | `description` | -- (none) |
| `action` | `commands` | `[]` |
| `orchestrator` | `generates` | -- (none) |
| `gate` | `before` | -- (side-effect only) |
| `gate` | `checks` | `[]` |
| `gate` | `retry` | `0` |
| `gate` | `on-fail` | `halt` |
| `gate` | `behavior` | `blocking` |
| `batch` | `parallel` | `false` |
| `batch` | `conflicts.detect` | `[]` |
| `batch` | `conflicts.resolve` | -- (none) |
| `batch` | `workspace` | -- (none) |
| `triggers.command` | `argument` | -- (none) |
| `hook` | `matcher` | -- (none, matches all) |
| `hook` | `type` | `command` |
| `hook` | `timeout` | `600` |
| `settings` | `allow` | `[]` |
| `settings` | `deny` | `[]` |
| `settings` | `ask` | `[]` |
| `mcp-server` | `url` | -- (none) |
| `mcp-server` | `command` | -- (none) |
| `mcp-server` | `args` | `[]` |
| `mcp-server` | `env` | `{}` |
| `tool` | `args` | `[]` |
| `tool` | `lang` | `auto` |
| `tool` | `description` | -- (none) |

---

## 8. Bindings

The `.at` spec defines **WHAT** to generate. Bindings define **HOW** for each platform.

A binding is a code module that reads a parsed `.at` file and produces the platform-specific configuration files, agent definitions, and orchestration logic for a given runtime. Each binding implements the `BindingTarget` interface.

### What a binding does

1. **Reads** the parsed AST from the `.at` compiler
2. **Maps** each block type to platform-specific output (agent configs, permission files, MCP configs, orchestrator scripts)
3. **Generates** the directory structure the platform expects
4. **Resolves** abstract concepts (model identifiers, permissions, hook events) to platform-specific values

### Model mapping

Bindings map model identifiers to their platform's model format:

| `.at` identifier | Claude Code | OpenAI | Google |
|-----------------|-------------|--------|--------|
| `opus` | `claude-opus-4-20250514` | -- | -- |
| `sonnet` | `claude-sonnet-4-20250514` | -- | -- |
| `gpt-4o` | -- | `gpt-4o` | -- |
| `gemini-pro` | -- | -- | `gemini-1.5-pro` |

### Permission mapping

Bindings map universal permissions to platform-specific modes:

| Universal | Claude Code | Description |
|-----------|-------------|-------------|
| `autonomous` | `auto` | Read-write without confirmation |
| `supervised` | `plan` | Read-only, proposes changes |
| `interactive` | `confirm` | Asks before each action |
| `unrestricted` | `bypass` | No permission checks |

### Available bindings

| Binding | Status | Target |
|---------|--------|--------|
| `claude-code` | Stable | Claude Code agent files, settings, MCP config |
| `agent-sdk` | Planned | Anthropic Agent SDK tool definitions |
| `e2b` | Planned | E2B sandbox configuration |
| `openai-swarm` | Planned | OpenAI Swarm agent definitions |

See `docs/bindings.md` for details on creating new bindings.

---

## 9. Roadmap

- `extend` -- topology inheritance
- `template` -- parameterized topologies
- `cost` -- per-agent budgets
- `sla` -- time constraints
- `test` -- inline topology tests
- `variables` -- runtime parameters
- `event` -- event-driven triggers (pub-sub)
