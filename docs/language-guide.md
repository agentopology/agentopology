# The .at Language Guide

Created by Nadav Naveh

## Overview

A `.at` file is the single source of truth for an agentic topology. It defines every agent, how they connect, what they can do, and how work flows between them -- all in one readable file.

The format is designed around three goals:

1. **Human-readable** -- a non-engineer can open the file and understand the team structure.
2. **Machine-parseable** -- a compiler can extract the full graph deterministically, with no ambiguity.
3. **Single source of truth** -- the `.at` file defines the structure. Everything else (agent configs, settings, MCP config) is generated from it.

---

## File Structure

Every `.at` file starts with a `topology` declaration, followed by a block containing all the sections:

```agenttopology
topology my-team : [pipeline, human-gate, fan-out] {

  meta { ... }
  orchestrator { ... }
  roles { ... }

  agent researcher { ... }
  agent writer { ... }

  action intake { ... }

  flow { ... }
  gates { ... }
  memory { ... }
  triggers { ... }
  hooks { ... }
  settings { ... }
  mcp-servers { ... }
}
```

The name (`my-team`) identifies the topology. The list after the colon (`[pipeline, human-gate, fan-out]`) declares which architectural patterns this topology uses. These are drawn from a fixed catalog:

| Pattern | What it means |
|---------|---------------|
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

Sections inside the topology block can appear in any order. Most sections (`meta`, `flow`, `orchestrator`, etc.) appear at most once. `agent` and `action` blocks can appear as many times as you need.

### Syntax Basics

Before diving into sections, a few ground rules:

- **Comments** start with `#` and run to end of line.
- **Strings** are always in double quotes: `"like this"`.
- **Identifiers** are lowercase with hyphens: `my-team`, `meta-reviewer`.
- **Numbers** can be integers (`3`) or decimals (`4.5`). Decimals are useful for inserting phases between existing ones.
- **Booleans** are bare `true` or `false` -- not quoted.
- **Lists** use square brackets: `[Read, Write, Edit]`. An empty list is `[]`.
- **Blocks** use curly braces: `meta { ... }`. Indentation is cosmetic -- the braces are what matter.

---

## Sections

### `meta` -- Version and Description

The `meta` block is the topology's identity card.

```agenttopology
meta {
  version: "1.0.0"
  description: "Content creation pipeline -- research, write, review, publish"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `version` | yes | Semver string |
| `description` | yes | What this topology does |

---

### `agent` -- The Core Building Block

Agents are the workers in your topology. Each one is an LLM-backed process with a specific job, tools, and constraints.

```agenttopology
agent writer {
  role: writer
  model: sonnet
  permissions: autonomous
  prompt: "prompts/writer.md"
  phase: 2
  tools: [Read, Write, Glob]
  reads: ["workspace/research.md"]
  writes: ["workspace/draft.md"]
  outputs: {
    needs-visual: yes | no
  }
}
```

Here is what each field does:

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `model` | **yes** | -- | LLM model identifier (see note below) |
| `role` | no | -- | Maps to a role defined in the `roles` block |
| `permissions` | no | `autonomous` | `supervised` (read-only), `autonomous` (read-write), `interactive` (ask first), `unrestricted` (no checks) |
| `prompt` | no | -- | Path to the agent's instruction file |
| `phase` | no | -- | Pipeline position. Lower numbers run first. Decimals work (e.g., `5.5`) |
| `tools` | no | all | Tool allowlist. Omit to allow everything |
| `disallowed-tools` | no | `[]` | Tool denylist. Cannot use both `tools` and `disallowed-tools` |
| `reads` | no | `[]` | Files this agent reads (input artifacts) |
| `writes` | no | `[]` | Files this agent produces (output artifacts) |
| `outputs` | no | `{}` | Typed values that control flow routing (see below) |
| `skip` | no | -- | Condition under which this agent is skipped entirely |
| `retry` | no | `0` | Max times this agent can be retried after validation failure |
| `isolation` | no | -- | Set to `worktree` for git worktree isolation |
| `invocation` | no | `auto` | `manual` means the agent is not auto-triggered by flow |
| `behavior` | no | `blocking` | `advisory` agents never block the flow |
| `memory` | no | -- | Persistent memory scope: `user`, `project`, or `local` |
| `skills` | no | `[]` | Skills to preload for this agent |
| `mcp-servers` | no | `[]` | MCP servers this agent can access |
| `background` | no | `false` | Whether to run in the background |

**Model identifiers** are flexible. You can use short aliases like `opus`, `sonnet`, `haiku`, or full model strings like `gpt-4o`, `gemini-2.0-flash`, `claude-sonnet-4-20250514`, `llama-3.1-70b`. Any string matching `[a-z][a-z0-9-/.]*` is valid. The binding maps these to the platform's model format. Use `inherit` to inherit the model from the orchestrator.

#### Outputs

Outputs are typed enum values that an agent produces. They drive conditional routing in the `flow` section.

```agenttopology
agent reviewer {
  # ...
  outputs: {
    verdict: approve | revise | reject
  }
}
```

The reviewer produces a `verdict` that can be `approve`, `revise`, or `reject`. In the flow, you reference this as `reviewer.verdict`.

#### Skip

The `skip` field makes an agent conditional. Two forms:

```agenttopology
# Skip based on an upstream output value
skip: writer.needs-visual == no

# Skip based on a tag (negated)
skip: not frontend-ticket
```

When an agent is skipped, it is treated as instantly completed with no outputs. Unconditional outgoing edges still fire.

#### Tools

The `tools` list controls what an agent can use. You can include bare tool names, constrained tools, or MCP server tools:

```agenttopology
tools: [Read, Write, Bash("test-runner:*"), mcp.database.*, mcp.monitoring.query]
```

- `Read` -- unrestricted tool
- `Bash("test-runner:*")` -- Bash, but only matching the given pattern
- `mcp.database.*` -- all tools from the `database` MCP server
- `mcp.monitoring.query` -- a single MCP tool

You can also use `disallowed-tools` instead of `tools` to deny specific tools while allowing everything else:

```agenttopology
disallowed-tools: [Write, Edit]
```

You cannot use both `tools` and `disallowed-tools` on the same agent -- that is a validation error.

---

### `action` -- Orchestrator-Handled Steps

Actions are steps that the orchestrator handles directly, without spawning a separate agent. They appear as nodes in the flow graph just like agents, but they run inline.

```agenttopology
action intake {
  kind: inline
  description: "Parse user request -- extract parameters and requirements"
}

action route {
  kind: decision
  description: "Determine which flow path to take"
}

action create-branch {
  kind: git
  commands: [fetch, checkout]
}
```

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `kind` | **yes** | -- | `external`, `git`, `decision`, `inline`, or `report` |
| `source` | no | -- | Where input comes from (e.g., `"github-pr"`) |
| `commands` | no | `[]` | Git commands for `kind: git` actions |
| `description` | no | -- | What this action does |

Actions cannot have `outputs`. Only agents and the orchestrator produce outputs.

Every action used in the flow must appear in the orchestrator's `handles` list.

---

### `flow` -- How Agents Connect

The `flow` block defines the execution graph -- which steps happen in what order, under what conditions.

```agenttopology
flow {
  intake -> researcher
  researcher -> writer
  writer -> reviewer
  reviewer -> writer     [when reviewer.verdict == revise, max 2]
  reviewer -> done       [when reviewer.verdict == approve]
  reviewer -> researcher [when reviewer.verdict == reject, max 1]
}
```

#### Arrow (`->`)

The arrow means "then." `a -> b` means: when `a` completes, start `b`.

You can chain arrows: `stage -> deploy -> verify` is shorthand for `stage -> deploy` plus `deploy -> verify`.

#### Conditions (`[when ...]`)

Conditions control which path is taken based on an output value:

```agenttopology
writer -> designer    [when writer.needs-visual == yes]
writer -> reviewer    [when writer.needs-visual == no]
```

The format is `source.output op value`. Operators: `==`, `!=`, `>=`, `<=`, `>`, `<`.

Conditions always reference a declared `outputs` field on an agent or the orchestrator.

#### Fan-out

Square brackets create parallel execution:

```agenttopology
intake -> [analyzer, security-scanner]
```

When intake completes, both `analyzer` and `security-scanner` start simultaneously.

#### Bounded Loops (`[max N]`)

Back-edges (loops) must have a maximum iteration count:

```agenttopology
reviewer -> writer    [when reviewer.verdict == revise, max 2]
```

This means the reviewer can send work back to the writer at most twice. After that, the loop stops.

#### Edge Attribute Order

When combining attributes, they must appear in this order: `when`, then `max`, then `per`:

```agenttopology
# Correct
reviewer -> writer  [when reviewer.verdict == revise, max 2]

# Wrong -- parser error
reviewer -> writer  [max 2, when reviewer.verdict == revise]
```

#### Unconditional Edges

An edge without `[when]` is always taken. If a node has both conditional and unconditional edges, the unconditional edge fires regardless.

---

### `gates` -- Quality Checkpoints

Gates are auto-injected checkpoints that sit between two nodes in the flow. You do not need to add them to the `flow` block -- the compiler inserts them automatically.

```agenttopology
gates {
  gate human-approval {
    after: reviewer
    before: publisher
    run: "scripts/human-approve.sh"
    on-fail: halt
  }
}
```

This gate runs `scripts/human-approve.sh` after the reviewer completes but before the publisher starts. The flow edge `reviewer -> publisher` becomes `reviewer -> human-approval -> publisher` automatically.

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `after` | **yes** | -- | Which node triggers this gate |
| `before` | no | -- | Which node is blocked until the gate passes. Omit for side-effect-only gates |
| `run` | **yes** | -- | Script to execute |
| `checks` | no | `[]` | Named check items |
| `retry` | no | `0` | How many times to retry on failure |
| `on-fail` | no | `halt` | `halt` stops the flow. `bounce-back` sends work back to the `after` node |
| `behavior` | no | `blocking` | `advisory` gates log results but never block |

---

### `memory` -- Shared Knowledge

The `memory` block defines where agents find shared context, where metrics go, and how the workspace is structured.

```agenttopology
memory {
  domains {
    path: "domains/"
    routing: "routing.md"
  }

  metrics {
    path: "metrics/log.jsonl"
    mode: append-only
  }

  workspace {
    path: "workspace/"
    protocol: "workspace-protocol.md"
    structure: [research, drafts, reviews, output]
  }
}
```

| Sub-block | Purpose | Key fields |
|-----------|---------|------------|
| `domains` | Shared knowledge base | `path`, `routing` (file that maps agents to domains) |
| `references` | Static documentation | `path`, `blueprints` (list of blueprint names) |
| `external-docs` | Conditional documentation | `path`, `files` (string list), `load-when` |
| `metrics` | Execution log | `path`, `mode` (e.g., `append-only`) |
| `workspace` | Per-run working directory | `path`, `protocol` (rules file), `structure` (directory names) |

---

### `triggers` -- Slash Commands

Triggers define the commands that start the topology.

```agenttopology
triggers {
  command create {
    pattern: "/create <TOPIC>"
    argument: TOPIC
  }

  command review {
    pattern: "/review"
  }
}
```

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `pattern` | **yes** | -- | The command pattern. `<PLACEHOLDER>` for arguments |
| `argument` | no | -- | Template variable name (UPPERCASE) extracted from the pattern |

Arguments use uppercase with underscores/hyphens: `TOPIC`, `COUNT`, `BATCH_ID`.

---

### `orchestrator` -- The Coordinator

The orchestrator is the central brain that runs the flow, handles actions, and spawns agents.

```agenttopology
orchestrator {
  model: opus
  generates: "commands/process.md"
  handles: [intake, route, deliver]
  outputs: {
    mode: fast | thorough
  }
}
```

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `model` | **yes** | -- | LLM model identifier |
| `generates` | no | -- | Path to generated orchestrator instructions |
| `handles` | **yes** | -- | List of actions the orchestrator runs inline |
| `outputs` | no | `{}` | Typed values for flow routing, referenced as `orchestrator.<name>` |

---

### `hooks` -- Event-Driven Automation

Hooks fire on specific events during execution. They run scripts or prompts in response to tool usage, agent lifecycle events, and more.

```agenttopology
hooks {
  hook security-check {
    on: ToolUse
    matcher: "Bash"
    run: "scripts/security-check.sh"
    type: command
  }
}
```

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `on` | **yes** | -- | Event to listen for (see below) |
| `matcher` | no | -- | Pattern to filter events. Omit to match all |
| `run` | **yes** | -- | Script or prompt to execute |
| `type` | no | `command` | `command` runs a script. `prompt` injects a prompt |
| `timeout` | no | `600` | Timeout in seconds |

Universal hook events (supported by all platforms):

| Event | When it fires |
|-------|---------------|
| `AgentStart` | When an agent spawns |
| `AgentStop` | When an agent finishes |
| `ToolUse` | Before or after a tool runs |
| `Error` | When an error occurs |
| `SessionStart` | When a session begins |
| `SessionEnd` | When a session ends |

Platforms may define additional events. See the binding documentation for platform-specific events.

Hooks can also be defined inside an `agent` block. Per-agent hooks only fire while that agent is active.

---

### `settings` -- Permissions

The `settings` block controls global tool permissions.

```agenttopology
settings {
  allow: ["Read", "Write", "Edit", "Glob", "Grep"]
  deny: ["Bash(rm -rf *)"]
  ask: ["Bash(npx *)"]
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `allow` | `[]` | Tools that run without confirmation |
| `deny` | `[]` | Tools that are blocked entirely |
| `ask` | `[]` | Tools that require human confirmation |

Values are strings and support patterns: `"Bash(npm run *)"` matches any `npm run` command.

---

### `mcp-servers` -- External Integrations

MCP servers provide external tool capabilities to agents.

```agenttopology
mcp-servers {
  database {
    type: stdio
    command: "npx"
    args: ["-y", "database-mcp-server"]
  }

  monitoring {
    type: http
    url: "https://mcp.monitoring.example.com"
  }
}
```

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `type` | **yes** | -- | `stdio`, `http`, or `sse` |
| `command` | for stdio | -- | Command to run |
| `args` | no | `[]` | Command arguments |
| `url` | for http | -- | Server URL |
| `env` | no | `{}` | Environment variables as `{ key: "value" }` |

Once defined, agents reference MCP servers by name:

```agenttopology
agent analyst {
  mcp-servers: [database]
  # ...
}
```

Or reference individual tools in the `tools` list:

```agenttopology
tools: [Read, mcp.database.*]
```

---

### `roles` -- Role Descriptions

The `roles` block gives human-readable descriptions to role identifiers used by agents.

```agenttopology
roles {
  researcher: "Gather information, find sources, compile notes"
  writer: "Draft content based on research findings"
  reviewer: "Check accuracy, clarity, and completeness"
}
```

Each role maps an identifier to a description string. Agents reference roles with the `role` field.

---

## Key Rules

These are the five most important validation rules. If your `.at` file violates any of them, the compiler will reject it.

### 1. Unique Names

All agent, action, and gate names must be globally unique within a topology. You cannot have an agent and an action with the same name.

### 2. Exhaustive Conditions

When a node has **only** conditional outgoing edges, the conditions must cover every possible value of the referenced output. The compiler accounts for upstream routing that eliminates certain values.

```agenttopology
# reviewer.verdict has three values: approve | revise | reject
# All three must be covered:
reviewer -> writer     [when reviewer.verdict == revise, max 2]
reviewer -> done       [when reviewer.verdict == approve]
reviewer -> researcher [when reviewer.verdict == reject, max 1]
```

### 3. Tool Exclusivity

An agent can have `tools` (allowlist) or `disallowed-tools` (denylist), but not both. Pick one approach.

### 4. Bounded Loops

Every back-edge (a flow edge that goes "backward" to an earlier node) must have `max N`. Unbounded loops are not allowed.

```agenttopology
# This loop can happen at most twice
reviewer -> writer  [when reviewer.verdict == revise, max 2]
```

### 5. Flow Resolution

Every node name used in the `flow` block must correspond to a declared `agent`, `action`, or `gate`. No dangling references.

---

## Tips

### Common Patterns

**Conditional skip for optional agents.** Use `skip` to make an agent optional based on upstream output:

```agenttopology
agent designer {
  skip: writer.needs-visual == no
  # ...
}
```

**Decimal phases for insertion.** Need to add an agent between phases 5 and 6? Use `5.5`:

```agenttopology
agent security-scanner {
  phase: 5.5
  # ...
}
```

**Advisory agents for non-blocking checks.** Set `behavior: advisory` for agents whose output is informational -- they never block the flow:

```agenttopology
agent style-checker {
  behavior: advisory
  # ...
}
```

**Manual invocation for on-demand agents.** Some agents should only run when explicitly triggered, not as part of the automatic flow:

```agenttopology
agent debugger {
  invocation: manual
  # ...
}
```

**Multiple flows from one entry point.** The orchestrator can route to entirely different flows based on its outputs:

```agenttopology
orchestrator {
  outputs: {
    mode: fast | thorough
  }
}

flow {
  route -> writer      [when orchestrator.mode == fast]
  route -> researcher  [when orchestrator.mode == thorough]
}
```

### Gotchas

**Actions must be in `handles`.** If you define an action and use it in the flow, it must also appear in `orchestrator.handles`. Otherwise you get a validation error.

**Edge attributes have a fixed order.** It is always `[when ..., max ..., per ...]`. The compiler will reject `[max 2, when x == y]`.

**Chained arrows apply attributes to the last edge only.** `a -> b -> c [when x]` means the condition applies to `b -> c`, not to `a -> b`.

**Empty list is not the same as omitting the field.** `tools: []` means "no tools at all." Omitting `tools` means "all tools allowed." These are very different.

**Strings are always quoted. Identifiers never are.** `version: "1.0.0"` (string) vs `model: sonnet` (identifier). If you quote an identifier or forget to quote a string, the parser will complain.

**Gate injection is automatic.** You define gates in the `gates` block with `after` and `before` -- you do not add them as nodes in the `flow` block. The compiler handles the insertion.
