/**
 * AgenTopology language reference documentation content.
 *
 * Each topic is a static reference page for `npx agentopology docs [topic]`.
 * Content is derived from the formal grammar (spec/grammar.md) and AST types
 * (src/parser/ast.ts).
 *
 * @module
 */

export interface DocTopic {
  name: string;
  description: string;
  content: () => string;
}

export const topics: Record<string, DocTopic> = {
  // -------------------------------------------------------------------------
  // 1. topology
  // -------------------------------------------------------------------------
  topology: {
    name: "topology",
    description: "Top-level block that wraps an entire .at file",
    content: () => `# topology

The \`topology\` block is the root container for every AgenTopology file. It declares the system name, pattern tags, and contains all other blocks.

## Syntax

\`\`\`at
topology NAME : [pattern, ...] {
  meta { ... }
  # all other blocks go here
}
\`\`\`

The pattern list after the colon is optional. If omitted, no pattern tags are set:

\`\`\`at
topology my-system {
  meta { ... }
}
\`\`\`

## Header Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| NAME | identifier | yes | Unique topology name (lowercase, kebab-case) |
| patterns | name-list | no | Pattern tags declared in the header |

## Meta Block Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| version | string | yes | -- | Semantic version (e.g. "1.0.0") |
| description | string | yes | -- | Human-readable description |
| domain | identifier | no | -- | Domain identifier (e.g. "legal", "marketing") |
| foundations | name-list | no | [] | Foundation pattern names |
| advanced | name-list | no | [] | Advanced pattern names |
| timeout | string | no | -- | Topology-level timeout (e.g. "30m", "2h") |
| error-handler | identifier | no | -- | Node ID for catch-all error handler |
| entry | identifier | no | -- | The agent every session starts as (Claude Code: settings.json \`agent\`; see V134) |
| outpoints | name-list | no | -- | Nodes a run may end at; each must be declared, and a flow node with no outgoing edge that is not listed warns (V150) |
| durable | boolean | no | false | Enable durable execution (requires checkpoint block) |
| target | path | no | the project root | Directory the generated hooks resolve project paths against (ledgers, gate checks, \`before: write\` globs): absolute, or relative to the project. Claude Code only; V152 |

## Available Patterns

\`pipeline\`, \`supervisor\`, \`blackboard\`, \`orchestrator-worker\`, \`debate\`, \`market-routing\`, \`consensus\`, \`fan-out\`, \`event-driven\`, \`human-gate\`

## Example

\`\`\`at
topology content-pipeline : [pipeline, human-gate] {
  meta {
    version: "1.0.0"
    description: "Research, write, review"
    domain: marketing
    timeout: "2h"
  }
  # ... agents, flow, etc.
}
\`\`\`

## Notes

- Every .at file must have exactly one \`topology\` block (or one \`fragment\` block).
- The topology name must be globally unique and follow identifier rules (lowercase, hyphens allowed).
- Pattern tags are informational metadata -- they don't enforce behavior but document intent.
- \`entry: <agent-id>\` names the agent every session starts as. claude-code writes it as \`"agent": "<name>"\` in .claude/settings.json (the agent file's name: its \`extensions { claude-code { name } }\`, else its id). A settings.json that already sets \`agent\` keeps it, an earlier scaffold's value included: after changing \`entry\`, delete the \`agent\` key and scaffold again. The entry agent is the session, so a gate after it is not a SubagentStop hook, and its \`tools\` are the session's tools (include \`Agent\`). An \`extensions { claude-code { agent } }\` value is more specific and wins; V134 warns when they differ. Codex and Cursor have no such setting and write nothing (\`validate --target codex\`: CX5-entry; Cursor: a scaffold warning). claude-workflow lists it in its LOSSY report. V134 errors when the entry is not an agent Claude Code can start as a subagent.
`,
  },

  // -------------------------------------------------------------------------
  // 2. agent
  // -------------------------------------------------------------------------
  agent: {
    name: "agent",
    description: "Agent node -- the primary compute unit (47 fields)",
    content: () => `# agent

The \`agent\` node is the primary compute unit in AgenTopology. Each agent represents an LLM-powered worker with a model, prompt, tools, and data access.

## Syntax

\`\`\`at
agent NAME {
  model: MODEL
  permissions: MODE
  phase: N
  prompt {
    Multi-line prompt text here.
  }
  tools: [tool1, tool2]
  # ... additional fields
}
\`\`\`

## All Fields (47)

### Identity & Execution

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| model | string | yes (V7) | -- | Model identifier (e.g. "opus", "gpt-4o") |
| phase | number | no | -- | Decimal ordering value (e.g. 1, 2.5) |
| permissions | string | no | -- | Permission mode (see below) |
| role | identifier | no | -- | Role name (resolved from roles block) |
| description | string | no | -- | Human-readable description for delegation |
| invocation | string | no | "auto" | "manual" or "auto" (V4: manual exempts from orphan check) |
| background | boolean | no | false | Run in background |
| isolation | string | no | -- | Isolation mode: "worktree" |
| max-turns | number | no | -- | Max agentic turns before stopping |
| output-into | record id | no | -- | Append the agent's output-schema fields to this record when it stops: a SubagentStop hook writes \`{ts, agent, ...fields}\`, or \`{ts, agent, error: "schema"}\` when the output does not match (never the raw output). Needs an output-schema (V159). It reads \`last_assistant_message\` and matches on \`agent_type\`; a text-level check, claude-code only |
| wall-time | duration | no | -- | Wall-clock cap on the whole session (\`4h\`, \`90m\`), on the entry agent only (V161). A SessionStart hook records the start; a PreToolUse guard on every tool refuses each call, a subagent's too, once the cap has passed, with a reason naming it; no recorded start refuses too. A text check of elapsed time between calls: it does not interrupt a call already running |
| renew-on | human id | no | -- | Beside \`wall-time\`: past the cap, the typed go of that human (a human with a go word; the same typed check as every go) starts a fresh window. The start is reset and a renewal row \`{ts, human, previous_start}\` is appended to the go ledger. A relayed go, another human's go, and a session with no recorded start do not renew (V161). Past the cap, one typed go both renews the window and gives the go for the gates after that human: the two are one word. The renewal follows the go row: when the go row or the renewal row cannot be written, the start is not moved. The \`.claude/state\` folder is refused to the agent (guards, sandbox, permission rules), and a start later than now refuses |
| max-subagents | number | no | -- | Most subagents this agent may have open at once. Enforced on claude-code: a PreToolUse hook on Agent\|Task refuses a launch at the cap (V156) |
| max-cost | number | no | -- | Spend cap in USD. Advisory, not enforced (Claude Code hooks do not see spend); written to the metering output (V156) |
| timeout | duration | no | -- | Longest the agent may run, e.g. 30m. Enforced on claude-code: a PreToolUse hook in the agent refuses every tool call after it (V30) |
| sandbox | string or boolean | no | -- | "docker", "none", "network-only", true, false |
| skip | string | no | -- | Skip condition: "not identifier" or "identifier.identifier op value" |
| runs | string | no | "subagent" | \`subagent\`, \`session\`, \`inline\` or \`fork\`. A \`session\` agent is its own named Claude Code session (V113) |
| place | identifier | no | -- | Where a session agent lives (\`place: ops\`); agents sharing a place run together |
| machine | identifier | no | -- | The machine a session agent runs on; must be in the top-level \`machines { machine mac { os: macos } }\` block (V122) |
| decides | list | no | -- | Decisions this agent holds the seat for (\`decides: [package-yes]\`); two claimants warn (V116) |
| permission-mode | string | no | -- | Session agents: \`default\`, \`acceptEdits\`, \`plan\`, \`bypassPermissions\` or \`auto\` (V113); differing modes on a talk edge warn (V118) |

### Prompt & Output

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| prompt | string | no (V10) | -- | Multi-line via \`prompt {}\` block or file path string |
| outputs | OutputsMap | no | -- | Enum outputs: \`{ field: val1 \\| val2 }\` (V5) |
| output-format | string | no | "text" | "text", "json", "json-schema" |
| input-schema | SchemaFieldDef[] | no | -- | Typed input schema fields |
| output-schema | SchemaFieldDef[] | no | -- | Typed output schema fields |

### Tools & Data

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| tools | string[] | no | -- | Allowed tools (supports wildcards like \`mcp.server.*\`) |
| disallowed-tools | string[] | no | -- | Denied tools (mutually exclusive with tools -- V14) |
| never-reads | string[] | no | -- | Path globs this agent may not read; see the \`secrets\` topic |
| ask-reads | string[] | no | -- | Paths a Read asks about instead of refusing (\`permissions.ask\`, session-wide); see the \`secrets\` topic |
| skills | string[] | no | -- | Skill IDs this agent can use |
| reads | string[] | no | -- | Memory keys this agent reads (V11) |
| writes | string[] | no | -- | Memory keys this agent writes (V11) |
| mcp-servers | string[] | no | -- | MCP server names this agent uses |
| produces | string[] | no | -- | Artifact IDs this agent produces |
| consumes | string[] | no | -- | Artifact IDs this agent consumes |

### Behavior & Flow

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| behavior | string | no | -- | "advisory" or "blocking" |
| join | string | no | -- | Fan-in: "all", "any", "all-done", "none-failed" |
| on-fail | string | no | -- | "halt", "retry", "skip", "continue", "fallback <agent-id>" |
| timeout | string | no | -- | Duration: "5m", "2h" |
| fallback-chain | string[] | no | -- | Ordered model IDs to try (V22) |
| compensates | string | no | -- | Agent ID (saga pattern compensation) |

### Retry & Resilience

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| retry | number or RetryConfig | no | -- | Simple count or structured config |
| circuit-breaker | CircuitBreakerConfig | no | -- | \`{ threshold, window, cooldown }\` |
| rate-limit | string | no | -- | "60/min", "1000/hour", "5/sec" |

### Sampling Parameters

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| temperature | number | no | -- | Sampling temperature (0-2) |
| max-tokens | number | no | -- | Max tokens to generate |
| top-p | number | no | -- | Nucleus sampling (0-1) |
| top-k | number | no | -- | Top-k sampling |
| stop | string[] | no | -- | Stop sequences |
| seed | number | no | -- | Random seed for reproducibility |
| thinking | string | no | -- | "off", "low", "medium", "high", "xhigh", "max" — the reasoning-effort field. Compiles to Codex model_reasoning_effort and to the Workflow tool effort option. |
| thinking-budget | number | no | -- | Token budget for reasoning (min 1000) |

### Observability

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| log-level | string | no | -- | "debug", "info", "warn", "error" |

### Scaling

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| scale | ScaleDef | no | -- | Parallel execution config (see \`scale\` topic) |

### A/B Testing

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| variants | PromptVariant[] | no | -- | \`{ id, prompt?, weight (0-1), temperature?, model? }\` |

### Extensibility

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| hooks | HookDef[] | no | -- | Per-agent hook definitions |
| extensions | Record | no | -- | Binding-specific fields |

## Permission Modes

| Word | Also written | Description | Claude Code agent file |
|------|--------------|-------------|------------------------|
| autonomous | -- | Agent acts without human approval | no permissionMode (the session's own mode) |
| supervised | plan | Agent presents a plan, then executes after approval | \`permissionMode: plan\` |
| interactive | confirm | Agent asks for confirmation on each action | no permissionMode (asks); \`acceptEdits\` before 0.12.2 |
| unrestricted | bypass | No safety checks (use with caution) | \`permissionMode: bypassPermissions\` |
| auto | -- | Claude Code's auto mode: a classifier approves actions without asking | \`permissionMode: auto\` |

\`auto\` is not a short form of \`autonomous\`: it is Claude Code's auto mode, and validation says so (V132). Write \`autonomous\` for the session's own mode.

\`interactive\` (and \`confirm\`) write no permissionMode, so Claude Code asks. Before 0.12.2, \`interactive\` wrote \`acceptEdits\` (file edits approved without asking) and V132 names that change; write \`permissions: acceptEdits\` to keep it.

Claude Code's own values pass through as written: \`default\` (written as no permissionMode), \`acceptEdits\`, \`dontAsk\`, \`plan\`, \`auto\`, \`bypassPermissions\`.

## RetryConfig Fields

\`\`\`at
retry {
  max: 3
  backoff: exponential    # none | linear | exponential
  interval: "1s"
  max-interval: "30s"
  jitter: true
  non-retryable: ["AuthError", "NotFound"]
}
\`\`\`

## Validation Rules

- **V7**: Every agent must have a \`model\` field
- **V10**: Prompt blocks should not be empty (warning)
- **V11**: reads/writes must match flow order
- **V14**: Cannot have both \`tools\` and \`disallowed-tools\`
- **V4**: Agents must appear in flow or have \`invocation: manual\`
- **V5**: \`[when x.y == z]\` must reference declared outputs
- **V22**: Fallback chain models should exist in a provider (warning)
- **V27**: Permission mode should be a recognized value (warning)

## Example

\`\`\`at
agent reviewer {
  role: reviewer
  model: opus
  permissions: supervised
  phase: 2
  tools: [Read, Grep, Glob]
  reads: ["workspace/draft.md"]
  writes: ["workspace/review.md"]
  timeout: "10m"
  retry: 2
  outputs: {
    verdict: approve | revise | reject
  }
  prompt {
    You are a code reviewer. Check for correctness,
    clarity, and test coverage.
  }
}
\`\`\`
`,
  },

  // -------------------------------------------------------------------------
  // 3. orchestrator
  // -------------------------------------------------------------------------
  orchestrator: {
    name: "orchestrator",
    description: "Orchestrator node -- coordinates agents and handles actions",
    content: () => `# orchestrator

The \`orchestrator\` node coordinates the overall topology. It routes work, generates plans, and handles action responses.

## Syntax

\`\`\`at
orchestrator {
  model: MODEL
  generates: "path/to/plan.md"
  handles: [action1, action2]
  outputs: {
    field: val1 | val2
  }
}
\`\`\`

## Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| model | string | yes (V7) | -- | Model identifier |
| generates | string | no | -- | Path to the plan/template file the orchestrator creates |
| handles | string[] | yes (V9) | -- | Action IDs this orchestrator handles |
| outputs | OutputsMap | no | -- | Enum output definitions (V5) |

## Validation Rules

- **V7**: Model is required
- **V9**: All actions referenced in the flow must appear in \`handles\`
- **V5**: Output values must match \`[when]\` conditions in edges

## Example

\`\`\`at
orchestrator {
  model: opus
  generates: "commands/plan.md"
  handles: [intake, deliver]
  outputs: {
    mode: batch | realtime
  }
}
\`\`\`

## Notes

- A topology has at most one orchestrator node.
- The orchestrator is typically the entry point that delegates to agents via actions.
`,
  },

  // -------------------------------------------------------------------------
  // 4. action
  // -------------------------------------------------------------------------
  action: {
    name: "action",
    description: "Action node -- external commands, scripts, or decisions",
    content: () => `# action

An \`action\` node represents a discrete operation: an external call, git command, inline decision, or report generation.

## Syntax

\`\`\`at
action NAME {
  kind: KIND
  description: "What this action does"
  source: "source-reference"
  commands: ["cmd1", "cmd2"]
  timeout: "5m"
  on-fail: halt
  join: all
}
\`\`\`

## Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| kind | string | yes (V26) | -- | "external", "git", "decision", "inline", "report" |
| source | string | no | -- | Source reference (file path or URL) |
| description | string | no | -- | Human-readable description |
| commands | string[] | no | -- | Shell commands to execute. The action's script runs each one as written (an interpreter flag, \`npx\` or \`env\` included). With none, an inline, decision or report action is done by the orchestrator in conversation (its script says so and is no stub); an external or git action scaffolds a stub, counted by validate and scaffold. A gate before this action guards them in Claude Code sessions |
| unit-from | string (regex) | no | -- | One capture group that reads the unit (an episode id, a ticket) from the command line, e.g. \`"./tool publish (\\S+)"\`. Needs a capture group (V111). Write one backslash: a string keeps its backslashes as written, so \`\\\\\` matches a literal backslash (V111 warns) |
| timeout | string | no | -- | Duration string (e.g. "5m", "2h") |
| on-fail | string | no | -- | "halt", "retry", "skip", "continue", "fallback <agent-id>" |
| join | string | no | -- | Fan-in: "all", "any", "all-done", "none-failed" |

## Action Kinds

| Kind | Description |
|------|-------------|
| external | External API call or service invocation |
| git | Git operation (commit, branch, PR) |
| decision | Routing decision point. With no \`commands:\` the orchestrator decides in conversation; no stub |
| inline | Inline logic, no external side effects. With no \`commands:\` the orchestrator does it in conversation; no stub |
| report | Compile and deliver output. With no \`commands:\` the orchestrator reports in conversation; no stub |

## Validation Rules

- **V26**: \`kind\` must be one of: external, git, decision, inline, report
- **V9**: Actions in the flow must be listed in the orchestrator's \`handles\`
- **V136**: warning, a schedule job runs a decision, report or inline action, or one with no kind, with no \`commands:\`: the job does nothing
- **V147**: error, an \`islands\` entry has no path or owner, or its owner is not a declared person
- **V148**: error, \`meta { requires }\` is not a version range (\`>=0.13.0\`, \`^0.13.0\`)

## Example

\`\`\`at
action intake {
  kind: external
  source: "github-pr"
  description: "Fetch PR diff and metadata from GitHub"
  timeout: "2m"
}

action deliver {
  kind: report
  description: "Deliver final output to the user"
}
\`\`\`
`,
  },

  // -------------------------------------------------------------------------
  // 5. gate
  // -------------------------------------------------------------------------
  gate: {
    name: "gate",
    description: "Gate node -- quality or security checkpoint between agents",
    content: () => `# gate

A \`gate\` node is a checkpoint that runs between two agents. Gates enforce quality, security, or compliance checks before work proceeds.

## Syntax

Gates are declared inside a \`gates {}\` block:

\`\`\`at
gates {
  gate NAME {
    after: AGENT_ID
    before: AGENT_ID
    run: "scripts/check.sh"
    checks: [check1, check2]
    retry: 2
    on-fail: bounce-back
    behavior: blocking
    timeout: "5m"
  }
}
\`\`\`

## Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| after | identifier | no (V13) | -- | Node this gate runs after |
| before | identifier | no (V13) | -- | Node this gate runs before |
| run | string | no | -- | Script to execute for the check |
| description | string | no | -- | What the gate checks, in words (prose goes here, never in \`run\`: V96) |
| strength | refuse / detect / hope / none | no | -- | What stops the step, as written down (V104) |
| by | code / hook / settings / gate | no | -- | Which mechanism refuses (V104) |
| at | "path" or "path:line" | no | -- | The code that refuses, project-relative (V106) |
| match | string | no | -- | Text expected near \`at\`; needs \`at\` (V106) |
| bypass | string | no | -- | The declared way around it (an env switch, a flag) |
| ledger | record id | no | the only record | The record a gate before a script step reads (V112) |
| tests | block | no | -- | \`tests { refuse: ["<command>", ..] allow: ["<command>", ..] }\`: rows \`guard --test\` feeds the gate's generated check (a Bash command; before a subagent, an agent name). Needs a check that holds the gate (V141) |
| mode | shadow / refuse | no | refuse | \`shadow\`: the generated check logs what it would refuse to \`logs/shadow.jsonl\` and lets the step run (V142) |
| let-go | once | no | -- | One override per step: a refusal is lifted for one run when the gate's human has an ok ledger row naming this gate with \`let-go: true\`, newer than the last refusal. Used up when the step runs (\`logs/let-go.jsonl\`) (V142) |
| lift | human id | no | the human in \`after\` | The human whose ledger row lets the gate go (V142) |
| checks | string[] | no | -- | List of check identifiers |
| retry | number | no | -- | Max retries on failure |
| on-fail | string | no | "halt" | "halt" or "bounce-back" |
| behavior | string | no | "blocking" | "advisory" or "blocking" |
| timeout | string | no | -- | Duration string |
| extensions | Record | no | -- | Binding-specific fields |

## On-Fail Behaviors

| Value | Description |
|-------|-------------|
| halt | Stop the topology on gate failure |
| bounce-back | Return work to the \`after\` agent for correction |

## Gates before a write of a path

\`before: write "<glob>"\` holds an edit of a matching path until the gate holds: its ledger (the LAST line for its \`after\` step must be ok) and its \`run\` check, as for a script step. The claude-code binding makes \`before-edit.sh\` (PreToolUse on \`Write|Edit|MultiEdit|NotebookEdit\`) refuse an edit whose path, relative to the project root (or \`meta { target }\`), matches the glob, and \`before-action.sh\` refuse a Bash command that names a matching path and does more than read it. \`*\` and \`**\` both match across folders. It is a path anchor, not a node id: a gate with one is written as its own gate. V151: an empty glob is an error; no ledger and no \`run\` is a warning. \`meta { target: "<dir>" }\` makes the generated hooks resolve project paths (ledgers, checks, these globs) against that directory, absolute or relative to the project (V152).

agentopology's own read-only subcommands on a \`.at\` file pass such a gate as reads (\`validate\`, \`inventory\`, \`plan\`, \`info\`, \`step check\`, \`guard --check\` or \`--test\`, \`visualize --no-open\`, \`scaffold --dry-run\`), run as a bare \`agentopology\` found on PATH, \`npx [-y|--yes] agentopology\` or \`npx agentopology@X.Y.Z\`, and only with \`--no-plugins\` (its own word, unquoted, before any \`--\`): a plugin is code that could write, and \`--no-plugins\` loads none. Without it, with \`--plugin\` or \`--dir\`, or as \`export\` (it writes next to the \`.at\`), the call is a write, and the refusal says to add \`--no-plugins\` when that is all it lacks.

\`\`\`at
gate src-open {
  after: review
  before: write "src/**"
  ledger: trace
  on-fail: halt
}
\`\`\`

## Gates before a script step

A gate whose \`before\` is an action with \`commands\` refuses that step in Claude Code sessions. The claude-code binding writes \`before-action.sh\`, a PreToolUse hook on \`Bash|Monitor|PowerShell\` (\`onFailure: "block"\`): every Claude Code tool that runs a shell command. A PowerShell command is read the same way, a backslash as a path separator, and a mention of the tool not read as a declared step is refused; \`guard --check\` grades PowerShell unverified (not measured), and says when the installed Claude Code (below 2.1.314) does not run the hook for Monitor commands. When the command starts with one of the action's commands (leading \`VAR=value\` words ignored) it checks the gate: with a ledger, the LAST line for the \`after\` step (same unit, when \`unit-from\` reads one) must have \`ok: true\`; with \`run\`, that wrapper must exit 0. Otherwise it exits 2 and names the gate, step, unit and ledger path.

\`\`\`at
action publish {
  kind: external
  commands: ["./tool publish"]
  unit-from: "./tool publish (\\S+)"
}
records {
  record trace { path: "logs/{unit}/trace.jsonl" }
}
gates {
  gate publish-ready {
    after: render
    before: publish
    ledger: trace
  }
}
\`\`\`

\`records { record ID { path: "..." } }\` declares ledgers; \`path\` is project-relative and may contain \`{unit}\`. With exactly one record, a gate needs no \`ledger:\`.

A record may also declare what a row holds, one field per line:

\`\`\`
records {
  record trace {
    path: "logs/trace.jsonl"
    fields: [step: string, ok: boolean, ts: ts]
    schema: row
    writer: render
  }
  record state {
    path: "logs/state.jsonl"
    kind: run-state
  }
}
\`\`\`

\`fields: [name: type, ..]\` has types \`string\`, \`number\`, \`boolean\` and \`ts\` (an ISO 8601 time). \`schema:\` names a schema declared in \`schemas { }\`. \`writer:\` names an action, an agent or a project-relative script path. \`kind: run-state\` is a record with the fixed fields \`target\` and \`step\` (it takes no \`fields:\`). V139 checks all of it. On claude-code, a record with any of these is written as \`record-<id>.sh '<json>'\`, which appends the row only when it holds every declared field with the declared type (exit 2 naming the field otherwise) and adds \`ts\` when missing. A ledger row \`{step, ok: "n/a", reason}\` goes through it, with \`reason\` required. When a gate's ledger is such a record and its \`after:\` step is an action with \`commands:\`, a PostToolUse hook on Bash (\`after-action.sh\`) appends \`{step, ok: true, ts, model}\` when the step's command succeeded. \`.claude/records.json\` lists every record, with the gates that read it. Codex and cursor write none of this (V140 warns).

\`max-per-day: N\` (0.13.1) caps a record at N rows a UTC day. The N+1th row is refused by the record's writer \`record-<id>.sh\` (exit 2) and, on a direct append, by \`before-action.sh\` (a redirect, \`tee\`, \`cp\`, \`mv\` that names the record's path, once the file holds N rows for today); \`before-edit.sh\` refuses an Edit or Write of the file. A row counts for the UTC day its \`ts\` (or \`at\`) starts with; the writer adds \`ts\` to every row, so a record with no \`ts\` field counts the same way. Reading the file, and every command that does not name it, pass. This is a text check: it cannot know how many rows one command adds, and two writers racing at the cap can both pass. The path must have no \`{unit}\` (V158).

**Ledger line format.** JSON Lines, one object per line, appended by the step's own script (agentopology only reads it):

\`\`\`json
{"step": "render", "unit": "ep42", "ok": true, "at": "2026-01-01T00:00:00Z"}
\`\`\`

\`unit\` is omitted when the step has none. A hook covers Claude Code sessions only: a step run from a terminal or a scheduler should call \`agentopology step check FILE.at STEP [--unit U] [--dir D]\` at its start (\`by: code\`). It exits 0 when every gate before STEP is satisfied, 1 otherwise, naming each failing gate and why.

A \`ci { }\` block is not part of this package: a .at that declares one fails validate (V155), unless a loaded plugin reads it.

## Validation Rules

- **V13**: \`after\` and \`before\` must reference declared nodes
- **V25**: \`on-fail: bounce-back\` warning when \`after\` is not an agent/group (cannot be wired as a SubagentStop hook on claude-code). Not raised for a gate before an action with commands: that is compiled to before-action.sh
- **V110**: warning, a gate before a script step has neither a ledger nor \`run\`: nothing to check
- **V151**: error, a \`before: write ""\` anchor has an empty glob; warning, a gate before a write has neither a ledger nor \`run\`
- **V152**: error, \`meta { target }\` is not a path
- **V111**: error, \`unit-from\` is not a valid regex or has no capture group
- **V112**: error, \`ledger\` names no declared record, a record path is unsafe, or the gate needs a ledger and several records exist
- **V139**: error, a record's \`fields:\` has a type that is not string, number, boolean or ts, its \`schema:\` is not declared, its \`writer:\` names no action, agent or project script path, or \`kind: run-state\` has \`fields:\`
- **V140**: warning, \`--target codex\` or \`cursor\` and a record declares fields, a schema, a writer or a kind: only claude-code writes them
- **V141**: error, \`tests\` on a gate no generated check holds (no script step or subagent in \`before:\`), or an empty tests block or row
- **V142**: error, \`mode\` is not shadow or refuse, \`let-go\` is not once, \`mode: shadow\` or \`let-go\` on a gate no generated check holds, \`let-go\` with no human (\`lift:\` or a human in \`after\`) or no ledger
- **V135**: error, a gate meant to refuse (\`run:\` script, not advisory, \`strength\` refuse or unset) that no hook runs: no subagent in \`after:\` (every one must be) or \`before:\`, no script step in \`before:\`, or inline delegation without a script step. Fix the anchor, or write \`strength: hope\` when a playbook runs it
- **V155**: error, a top-level \`ci { }\` block: it isn't part of this package (a plugin can provide it)

## Example

\`\`\`at
gates {
  gate security-scan {
    after: writer
    before: reviewer
    run: "scripts/security-scan.sh"
    checks: [secrets, dependencies, permissions]
    retry: 1
    on-fail: halt
    behavior: blocking
  }
}
\`\`\`

## Notes

- Gates are positioned hooks -- they compile to the strongest enforcement the target platform supports.
- A gate with \`behavior: advisory\` logs failures but does not block the flow.
`,
  },

  // -------------------------------------------------------------------------
  // 6. human
  // -------------------------------------------------------------------------
  human: {
    name: "human",
    description: "Human-in-the-loop node requiring manual input or approval",
    content: () => `# human

A \`human\` node represents a point in the flow where human input or approval is required.

## Syntax

\`\`\`at
human NAME {
  description: "What the human needs to do"
  timeout: "1h"
  on-timeout: skip
}
\`\`\`

## Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| description | string | no | -- | What the human should do |
| timeout | string | no | -- | How long to wait (e.g. "1h", "30m") |
| on-timeout | string | no | "halt" | "halt", "skip", or "fallback <agent-id>" |
| who | identifier | no | -- | The \`person\` block this step waits on; a person who is away today or later gets a V126 warning (V127 checks the name) |
| valid | string | no | -- | \`"YYYY-MM-DD..YYYY-MM-DD"\`: the window this human's approval holds; \`step check\` refuses a step they guard after it, and on claude-code and codex \`before-action.sh\` refuses it too, also when the go row's time is outside the window |
| word | string | no | -- | The go word the person types. On claude-code a typed prompt that is the word as the whole message, matched without regard to case (ASCII) and surrounding whitespace and punctuation (\`go release\`, \`Go release.\`), writes the go row to the ledger of the gate after this human. A trailing clause (\`go release, notes look right\`) does not count, and neither does a question or a quotation (\`go release?\`, \`"go release"\`): type the go alone, as its own message. Needs such a gate with a ledger (V127) |
| stop-word | string or list | no | -- | The stop word the person types, or a list of them (\`stop-word: [stop, עצור]\`). On claude-code the go hook, on a typed prompt whose first word is a stop word (without regard to case for an ASCII word, exactly for one in another script; whitespace and punctuation around the word are trimmed, and so are the marks phones add: typographic quotes and guillemets, Hebrew geresh, gershayim and maqaf, CJK and full-width punctuation, direction and zero-width marks, \`#\`, \`>\`, brackets and the stop-sign emoji; full-width letters are read as ASCII and Hebrew points are dropped; a trailing clause is allowed: \`Stop, the build is wrong\`). Another form of a word in another script (\`תעצור\`, \`עצרו\`) is a different word: list each form you type. The stop word then appends a halt row \`{step, ok: false, halt: true, word, ts}\` to the same ledger, and \`go-halt.sh\` (PreToolUse, every tool) refuses every tool call while the human's last row is a halt, until the person types the go word. Needs \`word\` and must differ from it (V160, V169). A text check of the ledger: it does not stop a process already running |
| binds | list of paths | no | -- | Project files the go approves. The go row records each one's sha256, and the go counts only while they are unchanged. Needs \`word\` (V127) |
| stop-from | \`any\` | no | -- | Opt-in, and \`any\` is the only value (V169). With it, a stop word in a prompt the person did not type (a message from another session, a background report, a scheduled prompt) still halts: the go hook writes the halt row. What is read: the body of a message from another session (the text after its header), and the text after the last \`</task-notification>\` of a background report (text inside the notification, such as its summary, is not read). A go word in a prompt that was not typed never counts, with or without this field. Needs \`stop-word\` |
| typed-only-programs | list of program names | no | -- | Your own programs that type into the person's terminal or pane, beyond the built-in tmux, screen, xdotool, osascript, wtype and ydotool. On claude-code a Bash command that runs one and holds the go word is refused. Needs \`word\` (V127) |

## The go: a typed word

\`\`\`at
human owner-go {
  who: owner
  valid: "2026-11-01..2026-12-31"
  word: "go release"
  binds: ["docs/release-notes.md"]
}
records {
  record go-ledger { path: "logs/go.jsonl" }
}
gates {
  gate go-given {
    after: owner-go
    before: release
    ledger: go-ledger
  }
}
\`\`\`

On claude-code this writes \`go-owner-go.sh\`, a UserPromptSubmit hook. When the person types \`go release\`, it appends
\`{"step": "owner-go", "ok": true, "word": "go release", "ts": "...", "binds": {"docs/release-notes.md": "<sha256>"}}\`
to \`logs/go.jsonl\`. It never blocks a prompt. Claude Code also runs this hook for prompts nobody typed, such as a
message from another session or a background subagent's report. A prompt that opens with \`<cross-session-message\`,
or holds a \`<task-notification\` envelope anywhere, writes no row, and the word counts only as the whole message.
A session-scoped scheduled task or \`/loop\` prompt arrives as its text was written, with no envelope, so one that
reads as the word would count as typed. The model schedules those prompts with the CronCreate and ScheduleWakeup
tools (and a cloud routine with RemoteTrigger), and \`before-schedule.sh\`, a PreToolUse hook on
\`CronCreate|ScheduleWakeup|RemoteTrigger\` (30 s timeout, blocking on failure), reads each string of the call
with the go hook's own readers and a wider trim (also \`?\`, quotes and the marks phones add), also after a leading
\`/loop\` and its interval, and refuses one that is the word or opens with it (\`Go release\`, \`**go release**\`,
\`- go release\`, \`/loop 5m Go release\`, \`go release now\`), whoever asked for it. A message longer than the go
word by more than 64 bytes is never the go; a scheduled string over 4096 bytes is refused unread, and the hook
refuses once it has run 10 seconds.

\`before-action.sh\` then lets \`release\` run only while \`docs/release-notes.md\` is unchanged since the go (a changed
file fails and is named) and inside the \`valid\` window.

These forms are refused, each proven by a test that feeds the hook the call:
- an edit of the ledger or of the go hook;
- a Bash command that writes the ledger, or runs or changes the go hook, unless it only reads it;
- a Bash command that runs \`claude\` (a new session, whose prompt the go hook would read as typed), named \`claude\`,
  also behind \`npx\`, \`env\`, \`timeout\` or another program that runs its arguments, or as the package
  \`@anthropic-ai/claude-code\` (\`npx\`, \`npx -y\`, \`pnpm dlx\`, \`bunx\`, \`yarn dlx\`): when it holds the go word
  anywhere, or when it matches no runner step the topology declares (an action whose
  \`commands:\` run \`claude\`, or a schedule job's agent run). A runner prompt that merely mentions the word is
  refused too;
- \`at\`, \`batch\` or \`systemd-run\` (also after \`sudo\`, \`nohup\`, \`timeout\` or a shell's \`-c\`) in a command that
  holds a \`claude\` call, the go word or the name of a file the guards protect, its input from a pipe or a
  here-string included (\`echo 'claude -p "go release"' | at now + 1 minute\`); \`crontab\` installing a crontab
  that holds them, from a pipe, a here-string, \`-\` or a file argument the guard reads (a file it cannot read is
  refused; \`crontab -l\` passes); \`nohup\`, \`setsid\` and \`disown\`
  are held to the same rules as the command run directly;
- a command that names a terminal device (\`/dev/pts/*\`, \`/dev/tty*\`, \`/dev/console\`, also as a glob, through
  \`$(tty)\`, or as dd's \`of=\`), unless it only reads it with \`<\`;
- typing into a terminal, whatever it types (0.13.3; the go word can hide in hex keys, a variable or an encoding):
  a \`send-keys\`, \`send-text\`, \`send-key\` or \`write-chars\` word anywhere in the command (tmux, kitty, wezterm, a
  program named by an expansion), tmux with \`send\` or \`paste-buffer\`, screen with \`stuff\`, zellij with \`write\`,
  and any mention of xdotool, wtype, ydotool, osascript or a program the human lists in \`typed-only-programs\`
  (list your own pane tools there). \`tmux ls\` and \`screen -ls\` still run. Known false refusals: those words in a
  commit message or an \`echo\`.
- with a wall-time cap, the whole \`.claude/state\` folder (the session's start file is there): an Edit or Write, a
  Bash write, \`cp\`, \`mv\` or \`rm\`. \`wall-time.sh\` also refuses a start later than now.

What these checks do not read (known, documented, not fixed): a stop word after U+202F, U+2009, U+2028, U+2060, U+00AD
or the bidi embedding marks; a stop word typed before a task notification in the same prompt; a \`">\` inside a quoted
header attribute of a cross-session message (the body is read after the first \`">\`); a stop word after an image
marker such as \`[Image #1]\`; and the stop reader's 256-character prefix, counted in bytes under the C locale and in
characters under UTF-8.

With Bash and an interpreter, text checks can't stop a determined agent; only the sandbox can. A go word turns it
on (see Sandbox below). An interpreter can still reach the route record, the gate ledgers your own steps write and
the guards' own files; the guards' text checks are what protect those.

## Sandbox

When a human has a go word (\`word:\`), the claude-code binding writes into \`.claude/settings.json\`:

- \`sandbox.enabled: true\`, \`sandbox.allowUnsandboxedCommands: false\` (a command the sandbox stops is not run again
  outside it) and \`sandbox.failIfUnavailable: true\`;
- \`sandbox.filesystem.denyWrite\`: each go ledger, \`.claude/state/talk.jsonl\` when talk-guard.sh or a
  session-prompt script is generated, the scaffold manifest (\`.claude/.scaffold-manifest.json\`), and, with a
  wall-time cap, the folder \`.claude/state\` (\`Edit(/.claude/state/**)\` in \`permissions.deny\`); and
  \`permissions.deny\` \`Edit(...)\` for each of them. A ledger a gate after a step also reads is left out: the step
  writes it.
- Hooks run outside the sandbox (Claude Code: command hooks "run with your full access"), so the go hook can still write.
  No \`excludedCommands\` is written.
- Scaffold creates each denied ledger and \`talk.jsonl\` as an empty file (and its folder) when it is missing, because on
  Linux and WSL2 a \`denyWrite\` entry for a path that does not exist may have no effect. A file that exists is never touched.

The sandbox protects the go ledger and the files hooks write; the route record and the gate ledgers your own steps write are protected by the guards' text checks.

Without a go word nothing of this is written.

Platforms: macOS, Linux and WSL2. On native Windows \`failIfUnavailable\` makes Claude Code exit at startup. Writes
outside the project are blocked. The network allow-list starts empty: npm, git over HTTPS and curl will prompt or
fail until you list hosts, and \`validate\` warns when the list is empty.

Your own settings come only through \`extensions { claude-code { ... } }\` (no new grammar). Lists add to the defaults:

\`\`\`at
extensions {
  claude-code {
    sandbox.network.allowedDomains: [registry.npmjs.org, github.com]
    sandbox.excludedCommands: ["docker compose *"]
    sandbox.filesystem.allowWrite: ["~/.kube"]
  }
}
\`\`\`

A value that weakens a default (\`sandbox.enabled\` false, \`sandbox.allowUnsandboxedCommands\` true,
\`sandbox.failIfUnavailable\` false, an \`allowWrite\` that covers a denied path) is kept as written; \`validate\` and
\`scaffold\` warn naming the key, and \`guard --check\` grades the go \`none\` with that reason.

docker does not run inside the sandbox: list it in \`sandbox.excludedCommands\`. Claude Code's rule is that
\`excludedCommands\` needs every command in a call to match: "\`npm ci && docker compose build\` stays sandboxed unless
another entry covers \`npm ci\`". The same holds for \`;\` (inferred, not stated by the docs). SSH git does not work
in the macOS sandbox: use HTTPS.

## Example

\`\`\`at
human manager-approval {
  description: "Review the generated report and approve or reject"
  timeout: "4h"
  on-timeout: fallback auto-approver
}
\`\`\`

## Notes

- Human nodes appear in the flow graph like any other node.
- If no \`on-timeout\` is set, the topology halts when the timeout expires.
- Use the \`human-gate\` pattern tag when your topology includes human nodes.
`,
  },

  // -------------------------------------------------------------------------
  // 7. group
  // -------------------------------------------------------------------------
  group: {
    name: "group",
    description: "Group chat node -- multi-agent conversation or debate",
    content: () => `# group

A \`group\` node defines a multi-agent conversation where several agents interact in rounds, simulating debate, brainstorming, or consensus.

## Syntax

\`\`\`at
group NAME {
  members: [agent1, agent2, agent3]
  speaker-selection: round-robin
  max-rounds: 5
  termination: "All members agree on a solution"
  description: "Debate the best approach"
  timeout: "30m"
}
\`\`\`

## Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| members | string[] | yes | -- | Agent IDs that participate |
| speaker-selection | string | no | -- | "round-robin" or "random" |
| max-rounds | number | no | -- | Maximum conversation rounds |
| termination | string | no | -- | Natural language termination condition |
| description | string | no | -- | Human-readable description |
| timeout | string | no | -- | Duration string |

## Example

\`\`\`at
group design-review {
  members: [architect, security-lead, ux-lead]
  speaker-selection: round-robin
  max-rounds: 10
  termination: "All members approve the design"
  timeout: "1h"
}
\`\`\`

## Notes

- Member agents must be declared as \`agent\` nodes in the same topology.
- Groups appear in the flow graph and can have edges to/from other nodes.
- Use the \`debate\` or \`consensus\` pattern tag when using groups.
`,
  },

  // -------------------------------------------------------------------------
  // 8. flow
  // -------------------------------------------------------------------------
  flow: {
    name: "flow",
    description: "Edge syntax -- arrows, fan-out, conditions, error edges",
    content: () => `# flow

The \`flow\` block defines the directed graph of edges between nodes. It uses arrow syntax to describe how work moves through the topology.

## Syntax

\`\`\`at
flow {
  # Simple edge
  from -> to

  # Fan-out (parallel)
  from -> [to1, to2, to3]

  # Edge with attributes
  from -> to [when from.field == value]

  # Error edge
  from -x-> error-handler

  # Typed error edge
  from -x[TimeoutError]-> timeout-handler
}
\`\`\`

## Arrow Types

| Syntax | Description |
|--------|-------------|
| \`->\` | Normal directed edge |
| \`-x->\` | Error edge (fires on failure, sets isError) |
| \`-x[Type]->\` | Typed error edge (sets errorType to the specified type) |

## Edge Attributes

Attributes appear in brackets after the target. Order matters (V12):

| Attribute | Syntax | Description |
|-----------|--------|-------------|
| when | \`[when agent.field == value]\` | Conditional edge (V5, V15) |
| max | \`[max N]\` | Loop bound for back-edges (V6) |
| finish | \`[finish]\` | Closes the run and hands the line back to the entry agent: an end, not a loop, so no \`[max N]\`. Must point at \`meta { entry }\` (V149) |
| per | \`[per agent-id]\` | Scoping per agent instance |
| tolerance | \`[tolerance N]\` or \`[tolerance "33%"]\` | Fan-out failure tolerance |
| race | \`[race]\` | First-to-finish wins |
| wait | \`[wait 30s]\` | Timer delay before edge fires |
| weight | \`[weight 0.7]\` | Routing probability (0-1) |
| reflection | \`[reflection]\` | Marks an evaluator/reflection loop |
| strength | \`[strength: none]\` | Enforcement written down: refuse, detect, hope or none (V104) |
| at | \`[at: "story/SKILL.md"]\` | Where the enforcement or the hoping prose lives (V106) |
| guard | \`[guard: lock-bash]\` or \`[guard: [a, b]]\` | Hooks or gates that guard this edge, by id (V105) |
| message | \`[message: ticket]\` | What crosses a talk edge between session agents: ticket, report or ask (V113) |

Multiple attributes can be combined:

\`\`\`at
reviewer -> writer [when reviewer.verdict == revise, max 3]
\`\`\`

## Talk between session agents

Agents with \`runs: session\` message each other. Who may talk is the flow edges between two session agents, and two shorthands write them:

\`\`\`at
flow {
  talk: all                 # an edge each way between every pair of sessions
  talk: hub lane-manager    # lane-manager <-> every other session
  lane-manager -> lane-build [message: ticket]
}
\`\`\`

The parser expands \`talk:\` into plain edges, so \`export --format json\` shows them as ordinary edges. \`[message: ticket | report | ask]\` records what crosses an edge (V113). With the \`hub\` pattern every session-to-session edge must touch one node (V115). Sessions with no talk edge at all warn "talk not declared: unguarded" (V114). Talk edges are conversations, so they are not checked as loops (V6).

## Fan-Out

Fan-out sends work to multiple agents in parallel:

\`\`\`at
flow {
  intake -> [analyzer, scanner, checker]
  analyzer -> reviewer
  scanner -> reviewer
  checker -> reviewer
}
\`\`\`

## Conditional Edges

Conditional edges require the source agent to have matching \`outputs\`:

\`\`\`at
agent reviewer {
  outputs: {
    verdict: approve | revise | reject
  }
}

flow {
  reviewer -> done      [when reviewer.verdict == approve]
  reviewer -> writer    [when reviewer.verdict == revise, max 2]
  reviewer -> intake    [when reviewer.verdict == reject]
}
\`\`\`

## What a when edge compiles to (Claude Code)

An edge \`router -> builder [when router.class == change]\`, where \`class\` is an enum that \`router\` (an agent or the orchestrator) declares in \`outputs:\`, is a route. When every edge into an agent is a route, the claude-code binding writes:

- \`.claude/skills/<topology>/scripts/route.sh <agent> <field> <value>\`: the router records its choice. It appends \`{"agent", "field", "value", "ts"}\` to \`.claude/state/routes-<topology>.jsonl\`. A value the .at does not declare exits 2 and writes nothing. The router's agent file (or, for the orchestrator, SKILL.md) gets the command and the route table: each value and the node it starts.
- a route check in \`before-agent.sh\` (PreToolUse on \`Agent|Task\`): the agent starts only when the last record for that agent and field holds a value whose edge leads to it. Otherwise it exits 2, naming the recorded value (or that there is none) and the edge it needed. An agent that no route leads to is not affected.
- \`before-edit.sh\` refuses an Edit or Write of the route record.

- \`before-action.sh\` (PreToolUse on \`Bash|Monitor|PowerShell\`) refuses a shell command that writes the route record (a redirect, \`tee\`, \`cp\`, \`mv\`, \`rm\`), as it does for a gate ledger. Reading it, and running route.sh, pass.

Not enforced, and named by a \`validate\` warning (CC-route): a condition of any other form (\`!=\`, \`>=\`, a value not declared); an edge to an action with no \`commands:\` (done in conversation, so no step to refuse; an action with commands that only routes reach is refused by \`before-action.sh\` the same way);a router whose \`tools\` leave out Bash (it cannot run route.sh); inline delegation. These edges stay a line in the playbook's Flow list. A route into an agent that a plain edge also reaches is not checked (its launch cannot be told apart) and does not warn. Codex and Cursor get no route check.

## Validation Rules

- **V3**: All node references in flow must be declared
- **V5**: \`[when x.y == z]\` must reference declared outputs with valid values
- **V6**: Back-edges (loops) must have \`[max N]\` to prevent infinite loops
- **V12**: Edge attributes must appear in order: when, max, per
- **V15**: Conditional edges must exhaustively cover all output values

## Notes

- Fan-in happens automatically when multiple edges point to the same target.
- The \`join\` field on the target node controls fan-in semantics (all, any, etc.).
- Error edges provide explicit error routing instead of relying on \`on-fail\`.
`,
  },

  // -------------------------------------------------------------------------
  // 9. memory
  // -------------------------------------------------------------------------
  memory: {
    name: "memory",
    description: "Memory block -- workspace, domains, stores, retrieval strategies",
    content: () => `# memory

The \`memory\` block declares the shared data layer for the topology. It defines where agents read and write data, declares memory stores for persistent knowledge, and configures retrieval strategies for multi-source memory queries.

## Syntax

\`\`\`at
memory {
  workspace {
    path: "workspace/"
    structure: [folder1, folder2]
  }

  domains {
    path: "domains/"
    routing: "domain-routing.md"
  }

  references {
    path: "references/"
  }

  external-docs {
    path: "docs/"
  }

  metrics {
    path: "metrics/data.jsonl"
    mode: append-only
  }

  store codebase-knowledge {
    type: semantic
    backend: lancedb
    path: ".memory/semantic/"
    scope: global
    isolation: soft
    embedding {
      provider: ollama
      model: "nomic-embed-text"
      dimensions: 768
    }
    search {
      strategy: hybrid
      rerank: true
      top-k: 10
    }
    lifecycle {
      retention: 90d
      decay-half-life: 30d
      contradiction: overwrite
    }
  }

  retrieval default {
    sources: [codebase-knowledge]
    budget: 4096
    scoring {
      recency-weight: 0.3
      semantic-weight: 0.5
      importance-weight: 0.2
    }
    paths: [semantic]
    cache-hit-threshold: 0.92
    cache-hit-action: short-circuit
  }
}
\`\`\`

## Sub-Blocks

| Sub-block | Description |
|-----------|-------------|
| workspace | Primary working directory for agent I/O |
| domains | Domain knowledge files |
| references | Reference documentation |
| external-docs | External documentation |
| metrics | Metrics output (supports append-only mode) |
| store \`<id>\` | Named memory store declaration (vector, graph, episodic backends) |
| retrieval \`<id>\` | Named retrieval strategy for multi-source memory queries |

### workspace Fields

| Field | Type | Description |
|-------|------|-------------|
| path | string | Directory path |
| structure | name-list | Expected folder structure |

### domains Fields

| Field | Type | Description |
|-------|------|-------------|
| path | string | Directory path |
| routing | string | Routing config file path |

### references / external-docs Fields

| Field | Type | Description |
|-------|------|-------------|
| path | string | Directory path |

### metrics Fields

| Field | Type | Description |
|-------|------|-------------|
| path | string | Output file path |
| mode | string | "append-only" for log-style output |

## Memory Stores

The \`store <id> {}\` sub-block declares a named memory store within the memory block. Each store specifies a memory type, storage backend, embedding configuration, and lifecycle policies. See the **store** topic for full field reference.

Supported memory types: \`semantic\`, \`episodic\`, \`procedural\`, \`entity\`, \`graph\`, \`user\`, \`session\`, \`temporal\`.

Supported backends: \`lancedb\`, \`sqlite-vec\`, \`chroma\`, \`kuzu\`, \`falkordb\`, \`mongodb\`, \`pinecone\`, \`qdrant\`, \`pgvector\`, \`neo4j\`, \`sqlite\`.

Each store can contain sub-blocks: \`embedding {}\`, \`index {}\`, \`ingestion {}\`, \`search {}\`, \`lifecycle {}\`, \`backend-config {}\`.

## Retrieval Strategies

The \`retrieval <id> {}\` sub-block declares a named retrieval strategy that queries one or more stores. It controls token budgets, scoring weights, retrieval paths, and cache-hit behavior. See the **retrieval** topic for full field reference.

Key fields: \`sources\` (store IDs to query), \`budget\` (token limit), \`scoring {}\` (weight configuration), \`paths\` (retrieval types), \`cache-hit-threshold\`, \`cache-hit-action\`.

## Agent Memory References

Agents reference memory stores and retrieval strategies via two fields on the agent node:

| Field | Type | Description |
|-------|------|-------------|
| memory | name-list | Store IDs this agent can access |
| retrieval | identifier | Retrieval strategy ID for memory queries |

\`\`\`at
agent researcher {
  memory: [codebase-knowledge, session-history]
  retrieval: default
}
\`\`\`

## Validation Rules

- **V11**: Agent \`reads\` and \`writes\` must be consistent with flow order
- **V24**: Only known sub-block names are expected (warning)

## Notes

- Memory paths are relative to the topology's root directory.
- Agents declare which memory keys they access via \`reads\` and \`writes\` fields.
- The workspace structure is informational -- it documents expected folders but does not create them.
- Store and retrieval blocks are parsed into typed AST nodes (\`StoreNode[]\` and \`RetrievalNode[]\`) at the top level of the AST.
- Local-first defaults: \`lancedb\` for semantic, \`kuzu\` for graph, \`sqlite\` for session/episodic.
`,
  },

  // -------------------------------------------------------------------------
  // 9a. store
  // -------------------------------------------------------------------------
  store: {
    name: "store",
    description: "Memory store declaration -- vector, graph, and episodic backends",
    content: () => `# store

The \`store\` block declares a named memory store within the \`memory {}\` block. Each store represents a persistent knowledge backend -- vector databases for semantic search, graph databases for entity relationships, or simple key-value stores for session state.

## Syntax

\`\`\`at
store <id> {
  type: <semantic | episodic | procedural | entity | graph | user | session | temporal>
  description: "Human-readable purpose"
  scope: <agent | user | session | org | global>
  isolation: <strict | soft | none>

  backend: <lancedb | sqlite-vec | chroma | kuzu | falkordb | mongodb | pinecone | qdrant | pgvector | neo4j | sqlite>
  path: ".memory/<type>/"
  connection: secret "STORE_URL"

  embedding {
    provider: <ollama | local | voyage | openai | gemini>
    model: "nomic-embed-text"
    dimensions: 768
    endpoint: secret "EMBEDDING_URL"
  }

  index {
    collection: "chunks"
    metric: <cosine | euclidean | dot-product>
  }

  ingestion {
    sources: ["docs/", "references/"]
    chunking: <recursive | sentence | paragraph | fixed>
    chunk-size: 512
    overlap: 50
  }

  search {
    strategy: <vector | keyword | hybrid | graph>
    rerank: true
    top-k: 10
  }

  lifecycle {
    retention: 90d
    decay-half-life: 30d
    consolidation: 0.85
    contradiction: <overwrite | preserve | bi-temporal>
    audit-log: true
  }

  extraction: <llm | regex | hybrid>

  backend-config {
    # passthrough key-value pairs for backend-specific settings
  }
}
\`\`\`

## Top-Level Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| type | string | yes | Memory type: semantic, episodic, procedural, entity, graph, user, session, temporal |
| description | string | no | Human-readable description of this store's purpose |
| scope | string | yes | Access scope: agent, user, session, org, global |
| isolation | string | no | Isolation level: strict, soft, none |
| backend | string | yes | Storage backend identifier |
| path | string | no | File system path for local backends |
| owner | agent id | no | The one agent that may share this store; two other agents writing it is an error (V121) |
| machine | identifier | no | The machine the store lives on; must be in \`machines { }\` (V122) |
| connection | string | no | Connection string or \`secret "..."\` reference for remote backends |
| extraction | string | no | Entity/fact extraction method: llm, regex, hybrid |

## Memory Types

| Type | Description |
|------|-------------|
| semantic | Long-term knowledge via vector embeddings (RAG) |
| episodic | Event and experience memories with temporal context |
| procedural | Learned procedures, workflows, and how-to knowledge |
| entity | Named entity facts and attributes |
| graph | Relationship graphs between entities |
| user | Per-user preferences and profile data |
| session | Short-lived conversational context |
| temporal | Time-series data with temporal ordering |

## Supported Backends

| Backend | Type | Local | Description |
|---------|------|-------|-------------|
| lancedb | vector | yes | Embeddable columnar vector DB (Rust, zero-infra) |
| sqlite-vec | vector | yes | SQLite extension for vector search |
| chroma | vector | yes/no | Open-source embedding database |
| kuzu | graph | yes | Embeddable graph DB (columnar, fast multi-hop) |
| falkordb | graph | no | Redis-compatible graph database |
| mongodb | document | no | Document store with Atlas Vector Search |
| pinecone | vector | no | Managed vector database |
| qdrant | vector | no | Vector similarity search engine |
| pgvector | vector | no | PostgreSQL vector extension |
| neo4j | graph | no | Native graph database |
| sqlite | kv/relational | yes | Lightweight relational/key-value store |

## Sub-Block: embedding {}

Configures the embedding model used to vectorize content for this store. Required when type is semantic, episodic, or procedural.

| Field | Type | Description |
|-------|------|-------------|
| provider | string | Embedding provider: ollama, local, voyage, openai, gemini |
| model | string | Model identifier (e.g. "nomic-embed-text", "text-embedding-3-small") |
| dimensions | number | Vector dimensions produced by the model |
| endpoint | string | Endpoint URL or \`secret "..."\` reference |

See the **embedding** topic for full details.

## Sub-Block: index {}

Configures the index or collection within the backend.

| Field | Type | Description |
|-------|------|-------------|
| collection | string | Collection or table name within the backend |
| metric | string | Distance metric: cosine, euclidean, dot-product |

## Sub-Block: ingestion {}

Configures how content is loaded into the store.

| Field | Type | Description |
|-------|------|-------------|
| sources | string-list | Source paths or globs to ingest from |
| chunking | string | Chunking strategy: recursive, sentence, paragraph, fixed |
| chunk-size | number | Target chunk size in tokens or characters |
| overlap | number | Overlap between chunks |

## Sub-Block: search {}

Configures how the store is queried.

| Field | Type | Description |
|-------|------|-------------|
| strategy | string | Search strategy: vector, keyword, hybrid, graph |
| rerank | boolean | Whether to apply reranking to results |
| top-k | number | Number of top results to return |

## Sub-Block: lifecycle {}

Configures memory retention, decay, and contradiction resolution. See the **lifecycle** topic for full details.

| Field | Type | Description |
|-------|------|-------------|
| retention | string | Retention period (e.g. "90d", "1y") |
| decay-half-life | string | Half-life for memory decay scoring (e.g. "30d") |
| consolidation | number | Consolidation threshold (0 to 1) |
| contradiction | string | Resolution strategy: overwrite, preserve, bi-temporal |
| audit-log | boolean | Whether to maintain an audit log |

## Sub-Block: backend-config {}

Passthrough key-value pairs for backend-specific settings not covered by the universal schema. Follows the same pattern as \`extensions {}\` -- unknown keys are preserved as-is.

## Connection with Secret Modifier

Remote backends use the \`secret\` modifier for connection strings:

\`\`\`at
store vectors {
  backend: pinecone
  connection: secret "PINECONE_URL"
  embedding {
    endpoint: secret "EMBEDDING_API_KEY"
  }
}
\`\`\`

## Scope and Isolation

Every store declares a \`scope\` (who can access it) and optionally an \`isolation\` level (how strictly access is enforced):

- **scope: agent** -- private to a single agent
- **scope: user** -- per-user data
- **scope: session** -- per-session, ephemeral
- **scope: org** -- shared across an organization
- **scope: global** -- accessible by all agents in the topology

Isolation levels: \`strict\` (hard boundaries), \`soft\` (warnings on cross-scope access), \`none\` (no enforcement).

## Example

\`\`\`at
memory {
  store codebase {
    type: semantic
    description: "Indexed codebase for semantic search"
    scope: global
    isolation: soft
    backend: lancedb
    path: ".memory/codebase/"
    embedding {
      provider: ollama
      model: "nomic-embed-text"
      dimensions: 768
    }
    index {
      collection: "code-chunks"
      metric: cosine
    }
    ingestion {
      sources: ["src/", "docs/"]
      chunking: recursive
      chunk-size: 512
      overlap: 50
    }
    search {
      strategy: hybrid
      rerank: true
      top-k: 10
    }
    lifecycle {
      retention: 90d
      decay-half-life: 30d
      consolidation: 0.85
      contradiction: overwrite
      audit-log: true
    }
  }
}
\`\`\`
`,
  },

  // -------------------------------------------------------------------------
  // 9b. retrieval
  // -------------------------------------------------------------------------
  retrieval: {
    name: "retrieval",
    description: "Retrieval strategy -- multi-source memory query planning",
    content: () => `# retrieval

The \`retrieval\` block declares a named retrieval strategy within the \`memory {}\` block. A retrieval strategy defines how an agent queries one or more memory stores -- controlling token budgets, scoring weights, retrieval paths, and cache-hit behavior.

## Syntax

\`\`\`at
retrieval <id> {
  sources: [store-id-1, store-id-2]
  budget: 4096

  scoring {
    recency-weight: 0.3
    semantic-weight: 0.5
    importance-weight: 0.2
  }

  paths: [semantic, episodic, procedural, graph, hybrid]
  rerank: true
  diversity: true

  cache-hit-threshold: 0.92
  cache-hit-action: <short-circuit | augment | pass-through>
}
\`\`\`

## Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| sources | name-list | no | Store IDs this retrieval draws from |
| budget | number | no | Token budget for retrieved context |
| scoring | sub-block | no | Scoring weight configuration |
| paths | name-list | no | Retrieval path types to activate |
| rerank | boolean | no | Whether to apply cross-source reranking |
| diversity | boolean | no | Whether to enforce diversity across results |
| cache-hit-threshold | number | no | Similarity threshold for cache-hit detection (0 to 1) |
| cache-hit-action | string | no | Action on cache hit: short-circuit, augment, pass-through |

## Sources

The \`sources\` field lists store IDs declared in the same \`memory {}\` block. The retrieval strategy queries all listed stores and merges results according to the scoring weights.

\`\`\`at
retrieval multi-source {
  sources: [codebase, session-history, entity-graph]
}
\`\`\`

## Budget

The \`budget\` field sets a token limit for the total retrieved context injected into the agent's prompt. This prevents context window overflow when querying multiple large stores.

\`\`\`at
retrieval compact {
  budget: 2048
}
\`\`\`

## Sub-Block: scoring {}

The \`scoring\` sub-block controls how results from multiple stores are ranked and merged. Weights should sum to 1.0.

| Field | Type | Description |
|-------|------|-------------|
| recency-weight | number | Weight for recency in scoring (0 to 1) |
| semantic-weight | number | Weight for semantic similarity (0 to 1) |
| importance-weight | number | Weight for importance/frequency (0 to 1) |

\`\`\`at
scoring {
  recency-weight: 0.3
  semantic-weight: 0.5
  importance-weight: 0.2
}
\`\`\`

## Paths

Retrieval paths define which types of memory retrieval are activated. Multiple paths can run in parallel and results are merged.

| Path | Description |
|------|-------------|
| semantic | Vector similarity search |
| episodic | Temporal event retrieval |
| procedural | Workflow/how-to retrieval |
| graph | Graph traversal queries |
| hybrid | Combined vector + keyword search |

## Cache-Hit Threshold and Action

Memory-gated routing allows the retrieval strategy to short-circuit agent execution when a sufficiently similar memory already exists.

- **cache-hit-threshold**: A similarity score (0 to 1). If a retrieved memory exceeds this threshold, it is considered a cache hit.
- **cache-hit-action**: What to do on a cache hit:
  - \`short-circuit\` -- return the cached result directly, skip agent execution
  - \`augment\` -- inject the cached result as additional context alongside the query
  - \`pass-through\` -- ignore the cache hit, proceed normally

\`\`\`at
retrieval with-cache {
  cache-hit-threshold: 0.92
  cache-hit-action: short-circuit
}
\`\`\`

## Agent Reference

Agents reference a retrieval strategy by ID:

\`\`\`at
agent researcher {
  retrieval: default
  memory: [codebase, session-history]
}
\`\`\`

## Validation Rules

- Retrieval \`sources\` must reference valid store IDs declared in the same \`memory {}\` block.
- Agent \`retrieval\` field must reference a valid retrieval ID.

## Example

\`\`\`at
memory {
  store codebase {
    type: semantic
    backend: lancedb
    scope: global
    embedding {
      provider: ollama
      model: "nomic-embed-text"
      dimensions: 768
    }
  }

  store conversations {
    type: episodic
    backend: sqlite
    scope: session
  }

  retrieval balanced {
    sources: [codebase, conversations]
    budget: 4096
    scoring {
      recency-weight: 0.3
      semantic-weight: 0.5
      importance-weight: 0.2
    }
    paths: [semantic, episodic]
    rerank: true
    diversity: true
    cache-hit-threshold: 0.92
    cache-hit-action: augment
  }
}
\`\`\`
`,
  },

  // -------------------------------------------------------------------------
  // 9c. lifecycle
  // -------------------------------------------------------------------------
  lifecycle: {
    name: "lifecycle",
    description: "Memory lifecycle management -- retention, decay, contradiction resolution",
    content: () => `# lifecycle

The \`lifecycle {}\` sub-block within a \`store\` declaration configures memory retention, decay, consolidation, and contradiction resolution policies.

## Syntax

\`\`\`at
lifecycle {
  retention: 90d
  decay-half-life: 30d
  consolidation: 0.85
  contradiction: <overwrite | preserve | bi-temporal>
  audit-log: true
}
\`\`\`

## Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| retention | string | no | How long memories are kept (duration string) |
| decay-half-life | string | no | Half-life for memory decay scoring |
| consolidation | number | no | Threshold (0 to 1) for merging similar memories |
| contradiction | string | no | Strategy for handling contradictory information |
| audit-log | boolean | no | Whether to log all memory mutations |

## Retention

The \`retention\` field accepts duration strings that specify how long memories are kept before expiration:

| Format | Example | Meaning |
|--------|---------|---------|
| Days | 90d | 90 days |
| Weeks | 4w | 4 weeks |
| Months | 6m | 6 months |
| Years | 1y | 1 year |
| Forever | forever | Never expires |

Expired memories are eligible for garbage collection by the binding runtime.

## Decay Half-Life

The \`decay-half-life\` field controls how quickly memory relevance scores decay over time. A shorter half-life means older memories lose relevance faster.

\`\`\`at
lifecycle {
  decay-half-life: 30d    # relevance halves every 30 days
}
\`\`\`

This is used in scoring calculations -- retrieval strategies weight results by recency using the decay curve.

## Consolidation Threshold

The \`consolidation\` field sets a similarity threshold (0 to 1) for merging similar memories. When two memories exceed this similarity, they are candidates for consolidation into a single, stronger memory.

\`\`\`at
lifecycle {
  consolidation: 0.85    # merge memories that are 85%+ similar
}
\`\`\`

## Contradiction Strategies

The \`contradiction\` field determines how the system handles new information that conflicts with existing memories:

| Strategy | Behavior |
|----------|----------|
| overwrite | Replace the old memory with the new one. Simplest approach -- last write wins. |
| preserve | Keep both memories. The system maintains conflicting facts and lets the agent or user decide. |
| bi-temporal | Track both the "valid time" (when the fact was true) and "transaction time" (when it was recorded). Enables point-in-time queries and full audit trails. |

\`\`\`at
# Mem0-style: always overwrite
lifecycle {
  contradiction: overwrite
}

# Letta-style: preserve conflicting facts
lifecycle {
  contradiction: preserve
}

# Zep/Graphiti-style: full temporal tracking
lifecycle {
  contradiction: bi-temporal
}
\`\`\`

## Audit Logging

When \`audit-log: true\`, all memory mutations (creates, updates, deletes, consolidations) are logged for debugging and compliance.

\`\`\`at
lifecycle {
  audit-log: true
}
\`\`\`

## Example

\`\`\`at
store project-knowledge {
  type: semantic
  backend: lancedb
  scope: global
  lifecycle {
    retention: 1y
    decay-half-life: 60d
    consolidation: 0.9
    contradiction: bi-temporal
    audit-log: true
  }
}
\`\`\`
`,
  },

  // -------------------------------------------------------------------------
  // 9d. embedding
  // -------------------------------------------------------------------------
  embedding: {
    name: "embedding",
    description: "Embedding configuration -- providers, models, dimensions",
    content: () => `# embedding

The \`embedding {}\` sub-block within a \`store\` declaration configures the embedding model used to vectorize content. It specifies the provider, model, vector dimensions, and optional endpoint.

## Syntax

\`\`\`at
embedding {
  provider: <ollama | local | voyage | openai | gemini>
  model: "nomic-embed-text"
  dimensions: 768
  endpoint: secret "EMBEDDING_URL"
}
\`\`\`

## Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| provider | string | no | Embedding provider |
| model | string | no | Model identifier for embedding generation |
| dimensions | number | no | Vector dimensions produced by the model |
| endpoint | string | no | Endpoint URL or \`secret "..."\` reference |

## Providers

| Provider | Type | Description |
|----------|------|-------------|
| ollama | local | Local inference via Ollama. Zero-cost, no data leaves the machine. |
| local | local | Generic local embedding (e.g. ONNX runtime, sentence-transformers). |
| voyage | cloud | Voyage AI embedding models. High quality for code and text. |
| openai | cloud | OpenAI embedding models (text-embedding-3-small, text-embedding-3-large). |
| gemini | cloud | Google Gemini embedding models. |

## Model Selection

The \`model\` field accepts any model identifier supported by the chosen provider:

\`\`\`at
# Local with Ollama
embedding {
  provider: ollama
  model: "nomic-embed-text"
  dimensions: 768
}

# OpenAI cloud
embedding {
  provider: openai
  model: "text-embedding-3-small"
  dimensions: 1536
}

# Voyage (optimized for code)
embedding {
  provider: voyage
  model: "voyage-code-3"
  dimensions: 1024
}
\`\`\`

## Dimensions

The \`dimensions\` field specifies the vector size produced by the embedding model. This must match the model's output dimensions:

| Model | Provider | Dimensions |
|-------|----------|------------|
| nomic-embed-text | ollama | 768 |
| text-embedding-3-small | openai | 1536 |
| text-embedding-3-large | openai | 3072 |
| voyage-code-3 | voyage | 1024 |

## Local vs Cloud Embedding

**Local embedding** (ollama, local) runs on the developer's machine:
- Zero cost, no API keys needed
- Data never leaves the machine
- Suitable for development and sensitive codebases
- Requires model download and local compute

**Cloud embedding** (voyage, openai, gemini) calls external APIs:
- Higher quality models available
- Requires API keys (use \`secret "..."\` modifier)
- Per-token pricing
- Suitable for production deployments

\`\`\`at
# Local-first development setup
embedding {
  provider: ollama
  model: "nomic-embed-text"
  dimensions: 768
}

# Production cloud setup
embedding {
  provider: openai
  model: "text-embedding-3-small"
  dimensions: 1536
  endpoint: secret "OPENAI_API_KEY"
}
\`\`\`

## Example

\`\`\`at
store documentation {
  type: semantic
  backend: lancedb
  scope: global
  path: ".memory/docs/"
  embedding {
    provider: ollama
    model: "nomic-embed-text"
    dimensions: 768
  }
  search {
    strategy: vector
    top-k: 5
  }
}
\`\`\`
`,
  },

  // -------------------------------------------------------------------------
  // 10. hooks
  // -------------------------------------------------------------------------
  hooks: {
    name: "hooks",
    description: "Hook definitions -- global and per-agent event handlers",
    content: () => `# hooks

Hooks are event-driven handlers that fire at specific points in the topology lifecycle. They can be global (topology-level) or per-agent.

## Syntax

### Global Hooks

\`\`\`at
hooks {
  hook NAME {
    on: EVENT
    matcher: "pattern"
    run: "scripts/handler.sh"
    type: command
    timeout: 5
  }
}
\`\`\`

### Per-Agent Hooks

\`\`\`at
agent my-agent {
  hooks {
    hook NAME {
      on: EVENT
      run: "scripts/handler.sh"
      type: command
    }
  }
}
\`\`\`

## Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| name | identifier | yes | -- | Hook identifier |
| on | string | yes | -- | Event name to listen for |
| matcher | string | no | -- | Tool name (or agent type, path) the event must match: exact names (\`Edit\\|Write\`) or a regex (\`mcp__chrome__.*\`), never permission-rule syntax (V107) |
| if | string | no | -- | Permission-rule filter on the tool's arguments, e.g. \`"Bash(rm -rf *)"\`; tool events only (V107) |
| run | string | yes | -- | Command or script to execute; \`exit 2\` runs as written, and only exit 2 blocks (V108) |
| type | string | no | command | "command", "prompt" or "mod" (V94) |
| flag | string | no | -- | mod only: the env switch that turns the Mod on |
| tests | block | no | -- | \`tests { refuse: ["<command>"] allow: ["<command>"] }\`: Bash commands \`guard --test\` feeds this hook's \`run:\` as PreToolUse payloads; exit 2 is refused (V141). A command hook on PreToolUse only |
| timeout | number | no | -- | Timeout in seconds (Claude Code reads seconds) |
| strength | string | no | -- | refuse, detect, hope or none (V104); a refuse hook is checked against every tool of a server it guards (V109) |
| extensions | Record | no | -- | Binding-specific fields |

## Events (23 total, command and prompt hooks)

A command or prompt hook fires on a PascalCase event (V95):

### Agent Lifecycle
\`AgentStart\`, \`AgentStop\`, \`SubagentStart\`, \`SubagentStop\`, \`Stop\`

### Tool Events
\`ToolUse\`, \`PreToolUse\`, \`PostToolUse\`, \`PostToolUseFailure\`

### Session Events
\`SessionStart\`, \`SessionEnd\`

### User Events
\`UserPromptSubmit\`, \`PermissionRequest\`, \`Notification\`

### System Events
\`Error\`, \`InstructionsLoaded\`, \`TeammateIdle\`, \`TaskCompleted\`, \`ConfigChange\`

### Worktree Events
\`WorktreeCreate\`, \`WorktreeRemove\`

### Memory Events
\`PreCompact\`

## Mods (type: mod)

A Mod is a TypeScript module loaded INSIDE the engine (Claude Code function
hooks, early access): no process is spawned per event. It subscribes to a
dotted engine event (V95):

| Event | Status |
|-------|--------|
| \`tool.call\` | proven (a Mod observed firing, Claude Code 2.1.283) |
| \`prompt.submit\` | proven |
| \`prompt.context\`, \`session.start\`, \`session.end\`, \`model.complete\`, \`message.received\` | seen in the engine, unproven as Mod events (V95 warns) |

\`\`\`at
hooks {
  hook redact {
    on: tool.call
    run: "hooks/redact.ts"
    type: mod
    flag: MY_MOD_REDACT
  }
}
\`\`\`

On the claude-code target, Mods are not written to settings.json. The
scaffold emits a plugin in the folder that holds the Mods' modules (the engine
refuses a module that imports outside its plugin folder; a trailing \`hooks/\`
is the plugin's own): \`.claude-plugin/plugin.json\`, \`hooks/hooks.json\`
naming ONE entry module (the engine loads one module per plugin), a generated
\`hooks/at-register.ts\` that registers every declared Mod, and
\`launch-mods.sh\`, which sets \`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1\`, each
Mod's flag and \`--plugin-dir\`.

## Example

\`\`\`at
hooks {
  hook block-dangerous-tools {
    on: PreToolUse
    matcher: "Bash"
    if: "Bash(rm -rf *)"
    run: "exit 2"
    type: command
  }

  hook log-completions {
    on: AgentStop
    run: "scripts/log-completion.sh"
    type: command
    timeout: 5000
  }
}
\`\`\`

## Notes

- \`type: command\` runs a shell command; \`type: prompt\` injects text into the agent's context; \`type: mod\` loads a module inside the engine.
- Fields are one per line: \`hook h { on: Stop run: "x" }\` makes \`on\` swallow the rest of the line (V90). A comma before a \`key:\` separates fields (\`checkpoint { backend: sqlite, ttl: 7d }\`); commas inside \`[..]\`, \`{..}\`, \`(..)\` and quotes stay in the value.
- The \`matcher\` is tested against the tool name alone. Letters, digits, \`_\`, \`-\`, spaces, \`,\` and \`|\` mean exact names; any other character makes it an unanchored regex. MCP tools are \`mcp__<server>__<tool>\`, so match a whole server with \`mcp__chrome__.*\` (\`mcp__chrome\` alone matches nothing). Filter on arguments with \`if:\`.
- Only exit 2 blocks. Exit 1 is a non-blocking error and the action goes ahead.
- Global hooks fire for all agents; per-agent hooks fire only for that agent.
`,
  },

  // -------------------------------------------------------------------------
  // 11. triggers
  // -------------------------------------------------------------------------
  triggers: {
    name: "triggers",
    description: "Command triggers -- user-invocable slash commands",
    content: () => `# triggers

Triggers define slash commands that users can invoke to start or control the topology.

## Syntax

\`\`\`at
triggers {
  command NAME {
    pattern: "REGEX_OR_PATTERN"
    argument: VAR
  }
}
\`\`\`

## Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| pattern | string | yes | -- | Regex or glob pattern with optional \`<VAR>\` placeholders |
| argument | template-var | no | -- | Variable name captured from the pattern |

## Example

\`\`\`at
triggers {
  command review {
    pattern: "/review <PR_URL>"
    argument: PR_URL
  }

  command status {
    pattern: "/status"
  }

  command deploy {
    pattern: "/deploy <ENV>"
    argument: ENV
  }
}
\`\`\`

## Notes

- Template variables use UPPER_CASE (e.g. \`PR_URL\`, \`BATCH_ID\`).
- The \`argument\` field names the captured value from the angle-bracket placeholder in the pattern.
- Triggers compile to platform-specific command mechanisms (e.g. Claude Code slash commands).
`,
  },

  // -------------------------------------------------------------------------
  // 12. settings
  // -------------------------------------------------------------------------
  settings: {
    name: "settings",
    description: "Permission settings -- allow, deny, ask tool lists",
    content: () => `# settings

The \`settings\` block defines tool permission lists that apply topology-wide.

## Syntax

\`\`\`at
settings {
  allow: ["Tool1", "Tool2"]
  deny: ["Tool3", "Bash(rm -rf *)"]
  ask: ["Bash(aws s3 *)"]
  sandbox: true
  fallback-chain: [opus, sonnet, haiku]
}
\`\`\`

## Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| allow | string[] | no | -- | Tools permitted without prompting |
| deny | string[] | no | -- | Tools blocked entirely |
| ask | string[] | no | -- | Tools that require user confirmation |
| sandbox | boolean or string | no | -- | Enable sandboxing |
| fallback-chain | name-list | no | -- | Default model fallback order |

## Notes

- Tool names can include argument patterns: \`"Bash(rm -rf *)"\` denies only that specific invocation.
- \`allow\`, \`deny\`, and \`ask\` are evaluated in that priority order.
- Individual agents can override these with their own \`tools\` or \`disallowed-tools\` fields.
`,
  },

  // -------------------------------------------------------------------------
  // 13. tools
  // -------------------------------------------------------------------------
  tools: {
    name: "tools",
    description: "Custom tool definitions -- scripts agents can invoke",
    content: () => `# tools

The \`tools\` block defines a repo's own tools: a shell command or a script that agents can run.

## Syntax

\`\`\`at
tools {
  tool NAME {
    script: "path/to/script.py"
    args: [arg1, arg2]
    lang: python
    description: "What this tool does"
  }
  tool OTHER {
    command: "npm test"
    description: "What this tool does"
  }
}
\`\`\`

## Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| id | identifier | yes | -- | Tool identifier (the NAME) |
| script | string | one of script, command | -- | Path to the implementing script |
| command | string | one of script, command | -- | The shell command that runs the tool (no script, no stub) |
| args | string[] | no | -- | Positional argument names |
| lang | string | no | "auto" | "bash", "python", "node", "auto" |
| description | string | yes | -- | Human-readable description |

## Example

\`\`\`at
tools {
  tool extract-pdf {
    script: "scripts/extract-pdf.py"
    args: [input-path, output-path]
    lang: python
    description: "Extract text from PDF documents"
  }

  tool run-tests {
    command: "npm test"
    description: "Run the test suite and return results"
  }
}
\`\`\`

## Notes

- Custom tools are referenced by name in agent \`tools\` lists, and in a skill's \`scripts\` and \`allowed-tools\`.
- On claude-code a tool's name is never written into an agent's \`tools:\` (Claude Code knows no such tool). A tool with \`command:\` or \`script:\` runs through Bash: the agent gets \`Bash\` (added once). A command tool also gets the allow rule \`Bash(npm test *)\` in \`.claude/settings.json\`, after \`settings { allow }\` (it also matches the bare command); a skill's \`allowed-tools\` naming it gets that rule in its place. A script tool gets no allow rule and prompts: the agent can edit the script, so a rule on it would widen what the agent may run.
- A tool with neither \`script:\` nor \`command:\` compiles to nothing on claude-code (V130 warns).
- Never widen: a skill with \`disallowed-tools: [Bash]\` that names a command or script tool, or an agent with it whose skill does, is a V14 error.
- Codex and Cursor write the tool's name in the agent's instructions, and a stub for a script.
- The \`lang\` field determines how the script is executed. \`auto\` infers from the file extension.
- Tool scripts receive arguments positionally in the order declared.
`,
  },

  // -------------------------------------------------------------------------
  // 14. skills
  // -------------------------------------------------------------------------
  skills: {
    name: "skills",
    description: "Skill definitions -- reusable capability bundles",
    content: () => `# skills

Skills are reusable capability bundles that package scripts, domain knowledge, and configuration together.

## Syntax

\`\`\`at
skill NAME {
  description: "What this skill enables"
  scripts: [tool1, tool2]
  domains: ["domains/rubric.md"]
  references: ["refs/guide.md"]
  prompt: "prompts/skill-prompt.md"
  disable-model-invocation: false
  user-invocable: true
  context: fork
  agent: sub-agent-id
  allowed-tools: ["Read", "Write"]
}
\`\`\`

## Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| id | identifier | yes | -- | Skill identifier (the NAME) |
| description | string | yes | -- | Human-readable description |
| scripts | string[] | no | -- | Tool/script names belonging to this skill |
| domains | string[] | no | -- | Domain knowledge file paths |
| references | string[] | no | -- | Reference file paths |
| prompt | string | no | -- | Prompt file path |
| disable-model-invocation | boolean | no | false | Disable automatic model invocation |
| user-invocable | boolean | no | false | Show in user-facing skill menu |
| context | string | no | -- | "fork" for subagent isolation |
| agent | identifier | no | -- | Agent type for fork context |
| allowed-tools | string[] | no | -- | Tools allowed without permission |
| extensions | Record | no | -- | Binding-specific fields |

## Example

\`\`\`at
skill data-extraction {
  description: "Document extraction -- PDF, DOC, images"
  scripts: [extract-pdf, extract-doc]
  domains: ["domains/extraction-rules.md"]
  user-invocable: true
}
\`\`\`

## Notes

- Agents reference skills via the \`skills\` field: \`skills: [data-extraction]\`.
- Skills with \`context: fork\` run in an isolated subagent.
- The \`scripts\` field references tools declared in the \`tools\` block.
`,
  },

  // -------------------------------------------------------------------------
  // 15. mcp-servers
  // -------------------------------------------------------------------------
  "mcp-servers": {
    name: "mcp-servers",
    description: "MCP server configurations for tool connectivity",
    content: () => `# mcp-servers

The \`mcp-servers\` block configures Model Context Protocol servers that provide additional tools and capabilities to agents.

## Syntax

\`\`\`at
mcp-servers {
  NAME {
    type: TYPE
    command: "command"
    args: ["arg1", "arg2"]
    url: "https://..."
    env: {
      KEY: "value"
    }
  }
}
\`\`\`

## Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| type | string | yes | -- | "stdio", "http", or "sse" |
| command | string | conditional | -- | Command to run (required for stdio) |
| url | string | conditional | -- | Server URL (required for http/sse) |
| args | string[] | no | -- | Command arguments (for stdio) |
| env | key-value | no | -- | Environment variables for the server |

## Server Types

| Type | Description | Required Fields |
|------|-------------|-----------------|
| stdio | Local process communicating via stdin/stdout | command |
| http | Remote HTTP endpoint | url |
| sse | Server-Sent Events stream | url |

## Example

\`\`\`at
mcp-servers {
  database {
    type: stdio
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-postgres"]
    env: {
      DATABASE_URL: "\${POSTGRES_URL}"
    }
  }

  analytics {
    type: http
    url: "https://mcp.analytics.example.com"
  }
}
\`\`\`

## Notes

- Agents reference MCP servers via the \`mcp-servers\` field: \`mcp-servers: [database]\`.
- Tool names from MCP servers can be referenced with wildcards: \`tools: [mcp.database.*]\`.
- Environment variables in \`env\` should use \`\${ENV_VAR}\` syntax for secrets.
- \`trust: untrusted\` marks a server whose results are untrusted input: it is added to the \`threat-model\` untrusted list (see the **threat-model** topic). \`trust: trusted\` is the default.

## A plugin's server

A server a Claude Code plugin provides is declared with \`from: plugin "<plugin-name>"\`; add \`server: "<server-name>"\` when the plugin's server name differs from the block key. No \`.mcp.json\` entry is written for it: the plugin configures it.

\`\`\`at
mcp-servers {
  playwright {
    from: plugin "playwright"
  }
}
\`\`\`

Claude Code names a plugin server's tools \`mcp__plugin_<plugin>_<server>__<tool>\` (any character outside \`A-Za-z0-9_-\` becomes \`_\`), so every reference compiles to that form: \`tools: [mcp.playwright.*]\` is \`mcp__plugin_playwright_playwright__*\`. The same holds in \`disallowed-tools\`, a skill's \`allowed-tools\`, \`settings { allow ask deny }\`, and a hook \`matcher\` written with the key (\`mcp__playwright__.*\`). An \`mcp_tool\` hook's \`server\` becomes the registered name \`plugin:playwright:playwright\`. An agent's \`mcp-servers: [playwright]\` entry is left out of the agent's \`mcpServers\` for now (validate notes it): that scoped name is not yet verified there, and the agent's \`tools\` already reach the server. Codex and Cursor have no Claude Code plugins and write no entry for such a server.
`,
  },

  // -------------------------------------------------------------------------
  // 15b. threat-model
  // -------------------------------------------------------------------------
  "threat-model": {
    name: "threat-model",
    description: "Untrusted inputs, and what is refused after reading one",
    content: () => `# threat-model

The top-level \`threat-model\` block names inputs the session cannot trust and the acts to hold back once one has been read.

## Syntax

\`\`\`at
threat-model {
  untrusted: [web, mcp:crm, "inbox/**"]
  refuse-after-untrusted: ["Bash(git push *)", "SendMessage"]
  outside-sandbox: ["npm"]
  lift: owner
}
\`\`\`

## Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| untrusted | list | no | \`web\` (WebFetch and WebSearch), \`mcp:<server id>\` (every tool of a declared MCP server), or a quoted path glob (reads by Read, Grep or Glob) |
| refuse-after-untrusted | list | no | Permission rules, as in \`settings { deny }\`: \`Tool\` or \`Tool(specifier)\` |
| outside-sandbox | list | no | Commands that run outside the sandbox (\`sandbox.excludedCommands\`), and paths the sandbox may write (\`sandbox.filesystem.allowWrite\`: starts with \`/\` or \`~\`, ends with \`/\`, or holds \`*\`) |
| lift | human id | no | The human whose ok row for an act ends the hold for that act |

An MCP server written \`trust: untrusted\` in \`mcp-servers { }\` is added to the untrusted list.

## What claude-code writes

- \`taint-mark.sh\`, a PostToolUse hook on the untrusted tools. It writes \`.claude/state/taint/<session_id>\` (\`{"source": ..., "ts": <epoch>}\`); the session id comes from the hook's stdin JSON.
- \`taint-guard.sh\`, a PreToolUse hook on the tools the rules name. While the session has a mark, a call matching a rule exits 2 with a reason that names the source. A Bash rule is read per command segment (\`cd x && git push\` matches \`Bash(git push *)\`); a command run through \`sudo\`, \`sh -c\`, \`env\` and the like counts when it holds the rule's fixed start. A command reached through a variable or another script is not seen.
- The hold ends in a new session (a new session id has no mark), or for one act when the \`lift:\` human has an ok row in \`.claude/state/approvals.jsonl\` with \`"act"\` equal to the rule string and \`"at"\` (ISO time) not older than the mark. A later untrusted read marks again, so an older row no longer lifts. Nothing clears the whole mark.
- The agent cannot write the mark folder or the approvals file: the before-edit guard refuses edits of them, and the before-action guard refuses a Bash command that writes them.
- \`outside-sandbox\` goes to the sandbox keys of settings.json; it takes effect only when \`settings { sandbox: true }\`.

An agent's own \`sandbox\` field has no Claude Code key and is still not written (validate warns, V130).

## Not written

Codex and Cursor write nothing for the block: \`validate --target codex\` and \`--target cursor\` warn (V138). Only Read, Grep and Glob count for a path glob; a file read through Bash does not mark the session.
`,
  },

  // -------------------------------------------------------------------------
  // 15c. egress
  // -------------------------------------------------------------------------
  egress: {
    name: "egress",
    description: "Hold web, network, MCP and telemetry until a gate clears",
    content: () => `# egress

The top-level \`egress\` block holds what leaves the machine until a gate clears. Local work is never held.

## Syntax

\`\`\`at
egress {
  gate: owner-go
  covers: [observability, web, network, mcp]
}
\`\`\`

## Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| gate | id | yes | A human with a \`word:\` (cleared by the human's go row: the last row for its step, in every go ledger, is ok and not a halt) or a record id (cleared by any row in the record's file; a record path with \`{unit}\` is refused) |
| covers | list | yes | Any of \`observability\`, \`web\`, \`network\`, \`mcp\` (V162) |

## What claude-code writes

- \`web\`: WebFetch and WebSearch are refused until the gate clears.
- \`mcp\`: every \`mcp__*\` tool is refused until the gate clears.
- \`network\`: a Bash command is refused until the gate clears when its program, read by its first word, is one of these: \`curl\`, \`wget\`, \`nc\`, \`ncat\`, \`netcat\`, \`ssh\`, \`scp\`, \`sftp\`, \`telnet\`, \`ftp\`; \`rsync\` with a host (a word like \`host:path\` or \`rsync://...\`); \`git push\`, \`git fetch\`, \`git pull\`, \`git clone\`; \`npm publish\`, \`npm install\`, \`npm i\`, \`npm ci\`, \`npm add\`. The command is read the way a person reads it: split at \`;\`, \`&\`, \`|\`, parentheses, backticks and newlines outside single quotes (and at \`$(\` and backticks inside double quotes); a heredoc body is skipped unless it is fed to a shell; quotes and backslashes are dropped from a word; assignments, shell keywords and the wrappers sudo, doas, env, nohup, nice, command, exec, builtin, setsid, stdbuf, timeout, xargs, unbuffer, ionice, chrt, taskset (with their options) are passed over; \`sh -c\`, \`bash -c\` and \`eval\` are read through. \`git status\`, \`git commit\`, \`git log\`, \`npm test\`, \`npm run\`, \`ls\`, \`rsync\` between local folders and the like pass.
- \`observability\`: the telemetry env of an \`observability { }\` block (\`CLAUDE_CODE_ENABLE_TELEMETRY\`, \`OTEL_*\`) is left out of \`.claude/settings.json\`. A SessionStart hook, \`egress-observability.sh\`, merges it into \`.claude/settings.local.json\` under \`env\` once the gate has cleared, keeping what is there; before the clear it writes nothing. Claude Code reads settings when it starts, so the export begins with the next session.

The guard is \`egress-guard.sh\`, a PreToolUse hook on the covered tools, failing closed (a ledger it cannot read does not clear the gate).

## What it does not stop

This is a text check of a tool name and of a command's first word, not a firewall. It does not see: pnpm, yarn, pip, gem or any program not listed; a script, Makefile or npm script that runs curl (the command it sees is \`npm run\`, \`make\` or \`./deploy.sh\`); an interpreter that opens a socket (python, node, perl); a program an expansion hides. Those are the sandbox's class: turn on \`settings { sandbox: true }\` and its network rules. A human's go row is read as written: its \`binds:\` and \`valid:\` are not checked here.
`,
  },

  // -------------------------------------------------------------------------
  // 16. metering
  // -------------------------------------------------------------------------
  metering: {
    name: "metering",
    description: "Cost tracking and usage metering configuration",
    content: () => `# metering

The \`metering\` block configures cost tracking and usage metrics for the topology.

## Syntax

\`\`\`at
metering {
  track: [tokens-in, tokens-out, cost, wall-time, agent-count]
  per: [agent, run, phase]
  output: "metrics/"
  format: jsonl
  pricing: anthropic-current
}
\`\`\`

## Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| track | string[] | yes | -- | Metrics to track |
| per | string[] | yes | -- | Dimensions to aggregate by |
| output | string | yes | -- | Output file or directory path |
| format | string | yes (V28) | -- | "json", "jsonl", or "csv" |
| pricing | string | yes (V29) | -- | Pricing model identifier |
| max-cost | number | no | -- | Spend cap in USD (\`cap:\` is accepted as an alias). Advisory, not enforced: written to the metering output for reporting (V156) |

## Track Metrics

\`tokens-in\`, \`tokens-out\`, \`cost\`, \`wall-time\`, \`agent-count\`

## Per Dimensions

\`agent\`, \`run\`, \`phase\`, \`topology\`

## Pricing Models

| Value | Description |
|-------|-------------|
| anthropic-current | Current Anthropic API pricing |
| custom | Custom pricing configuration |
| none | No cost calculation |

## Validation Rules

- **V28**: \`format\` must be "json", "jsonl", or "csv"
- **V29**: \`pricing\` should be a recognized pricing model (warning)

## Example

\`\`\`at
metering {
  track: [tokens-in, tokens-out, cost]
  per: [agent, run]
  output: "metrics/usage.jsonl"
  format: jsonl
  pricing: none
}
\`\`\`
`,
  },

  // -------------------------------------------------------------------------
  // 17. providers
  // -------------------------------------------------------------------------
  providers: {
    name: "providers",
    description: "API provider configurations for model routing",
    content: () => `# providers

The \`providers\` block declares API providers for model credentials and routing.

## Syntax

\`\`\`at
providers {
  NAME {
    api-key: "\${ENV_VAR}"
    base-url: "https://api.example.com"
    models: [model1, model2]
    default: true
    auth {
      type: oidc
      issuer: "https://auth.example.com"
      audience: "api"
    }
  }
}
\`\`\`

## Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| name | identifier | yes | -- | Provider name (the block key) |
| api-key | string | no (V16) | -- | Must use \`\${ENV_VAR}\` format |
| base-url | string | no | -- | Custom API endpoint |
| models | name-list | yes | -- | Model identifiers this provider serves |
| default | boolean | no | false | Mark as default provider (V17, V19) |

## Auth Block Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| type | string | yes | "oidc", "oauth2", "api-key", "aws-iam", "gcp-sa", "azure-msi" |
| issuer | string | no | Token issuer URL |
| audience | string | no | Expected audience claim |
| token-url | string | no | Token endpoint URL |
| client-id | string | no | OAuth2 client ID |
| scopes | string[] | no | OAuth2 scopes |

## Validation Rules

- **V16**: \`api-key\` must use \`\${ENV_VAR}\` syntax (never inline secrets)
- **V17**: At most one provider can be \`default: true\`
- **V18**: Agent models should exist in a declared provider (warning)
- **V19**: Provider names must be unique

## Example

\`\`\`at
providers {
  anthropic {
    api-key: "\${ANTHROPIC_API_KEY}"
    models: [opus, sonnet, haiku]
    default: true
  }

  openai {
    api-key: "\${OPENAI_API_KEY}"
    models: [gpt-4o, gpt-4o-mini]
  }

  ollama {
    base-url: "http://localhost:11434"
    models: [llama3, codellama]
  }
}
\`\`\`
`,
  },

  // -------------------------------------------------------------------------
  // 18. env
  // -------------------------------------------------------------------------
  env: {
    name: "env",
    description: "Environment variables and secrets configuration",
    content: () => `# env

The \`env\` block declares environment variables for the topology, including support for secret references.

## Syntax

\`\`\`at
env {
  KEY: "value"
  KEY: "\${ENV_VAR}"
  KEY: secret "vault://path/to/secret#field"
}
\`\`\`

## Value Types

| Form | Description |
|------|-------------|
| \`"literal"\` | Inline string value |
| \`"\${ENV_VAR}"\` | Reference to a runtime environment variable |
| \`secret "URI"\` | Sensitive value from a secret manager |

## Secret Schemes

| Scheme | Description | Example URI |
|--------|-------------|-------------|
| vault | HashiCorp Vault | \`vault://secret/data/prod#api-key\` |
| op | 1Password CLI | \`op://vault/item/field\` |
| awssm | AWS Secrets Manager | \`awssm://prod/api-key\` |
| ssm | AWS SSM Parameter Store | \`ssm:///prod/config/key\` |
| gcpsm | GCP Secret Manager | \`gcpsm://project/secret/version\` |
| azurekv | Azure Key Vault | \`azurekv://vault-name/secret-name\` |

## Example

\`\`\`at
env {
  DATABASE_URL: "\${DATABASE_URL}"
  API_KEY: secret "vault://secret/data/prod#api-key"
  LOG_LEVEL: "info"
  REGION: "us-east-1"
}
\`\`\`

## Validation Rules

- **V21**: Sensitive fields must use \`\${ENV_VAR}\` or \`secret\` syntax (never inline credentials)

## Notes

- Values marked with \`secret\` are treated as sensitive and are not echoed in logs.
- SOPS-encrypted values (\`ENC[METHOD,...]\`) are also supported for encrypted-at-rest secrets.
`,
  },

  // -------------------------------------------------------------------------
  // 19. environments
  // -------------------------------------------------------------------------
  environments: {
    name: "environments",
    description: "Environment-specific configuration overrides",
    content: () => `# environments

The \`environments\` block defines per-environment configuration overrides (development, staging, production, etc.).

## Syntax

\`\`\`at
environments {
  development {
    bucket: "dev-bucket"
    log-level: "debug"
  }

  production {
    bucket: "prod-bucket"
    log-level: "warn"
  }
}
\`\`\`

## Structure

Each environment is a named block containing key-value pairs. The keys and values are free-form -- they are not validated against a schema.

## Example

\`\`\`at
environments {
  development {
    api-url: "http://localhost:3000"
    debug: "true"
  }

  staging {
    api-url: "https://staging.example.com"
  }

  production {
    api-url: "https://api.example.com"
    replicas: "3"
  }
}
\`\`\`

## Notes

- Environment names are identifiers (lowercase, kebab-case).
- Values are always strings (quoted).
- Bindings select the active environment at compile/deploy time.
`,
  },

  // -------------------------------------------------------------------------
  // 20. batch
  // -------------------------------------------------------------------------
  batch: {
    name: "batch",
    description: "Batch processing configuration",
    content: () => `# batch

The \`batch\` block configures how the topology handles batch processing -- parallel execution, conflict resolution, and workspace isolation.

## Syntax

\`\`\`at
batch {
  parallel: true
  per: ticket
  conflicts: {
    detect: ["workspace/output.json"]
    resolve: sequential-rebase
  }
  workspace: "runs/_batch/{BATCH_ID}/"
}
\`\`\`

## Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| parallel | boolean | no | false | Enable parallel batch execution |
| per | string | no | -- | Batch scoping: "ticket" or an agent ID |
| conflicts.detect | string[] | no | -- | File paths to monitor for conflicts |
| conflicts.resolve | string | no | -- | Resolution strategy: "sequential-rebase" |
| workspace | string | no | -- | Workspace path template (\`{BATCH_ID}\` is replaced) |

## Example

\`\`\`at
batch {
  parallel: true
  per: ticket
  conflicts: {
    detect: ["workspace/synthesis.json"]
    resolve: sequential-rebase
  }
  workspace: "runs/_batch/{BATCH_ID}/"
}
\`\`\`

## Notes

- \`{BATCH_ID}\` in the workspace path is replaced with the actual batch identifier at runtime.
- \`per: ticket\` creates one batch instance per incoming ticket/request.
- Conflict detection monitors specified files and applies the resolution strategy when concurrent writes occur.
`,
  },

  // -------------------------------------------------------------------------
  // 21. depth
  // -------------------------------------------------------------------------
  depth: {
    name: "depth",
    description: "Depth levels -- progressive complexity control",
    content: () => `# depth

The \`depth\` block defines progressive complexity levels, allowing the same topology to run at different levels of thoroughness.

## Syntax

\`\`\`at
depth {
  factors: [complexity, risk]

  level 1 "quick" {
    omit: [security-scanner, deep-analyzer]
  }

  level 2 "standard" {
    omit: [deep-analyzer]
  }

  level 3 "thorough" {
    omit: []
  }
}
\`\`\`

## Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| factors | string[] | yes | Factors that determine depth selection |

### Level Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| level | number | yes | Numeric depth value |
| label | string | yes | Human-readable label (quoted after level number) |
| omit | string[] | yes | Agent IDs to skip at this depth |

## Example

\`\`\`at
depth {
  factors: [file-count, change-type]

  level 1 "fast" {
    omit: [deep-review, security-audit]
  }

  level 2 "normal" {
    omit: [security-audit]
  }

  level 3 "full" {
    omit: []
  }
}
\`\`\`

## Notes

- Higher depth levels include more agents (fewer omissions).
- The \`factors\` list documents what determines which depth to use.
- Depth selection happens at runtime based on the input characteristics.
`,
  },

  // -------------------------------------------------------------------------
  // 22. scale
  // -------------------------------------------------------------------------
  scale: {
    name: "scale",
    description: "Parallel execution and auto-scaling configuration",
    content: () => `# scale

The \`scale\` block configures parallel execution for an agent. It can appear as a sub-block inside an \`agent\` node.

## Syntax

\`\`\`at
agent my-agent {
  scale {
    mode: auto
    by: doc-count
    min: 2
    max: 8
    batch-size: 50
  }
}
\`\`\`

## Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| mode | string | yes | -- | "auto", "fixed", or "config" |
| by | string | yes | -- | Scaling dimension (see below) |
| min | number | yes | -- | Minimum concurrent instances |
| max | number | yes | -- | Maximum concurrent instances |
| batch-size | number | no | -- | Items per instance |

## Scaling Modes

| Mode | Description |
|------|-------------|
| auto | Scale based on workload |
| fixed | Always run exactly \`min\` instances |
| config | Scale based on external configuration |

## Scaling Dimensions

| Dimension | Description |
|-----------|-------------|
| batch-count | Number of batches |
| doc-count | Number of documents |
| token-volume | Total token count |
| source-count | Number of source files |

## Example

\`\`\`at
agent processor {
  model: sonnet
  scale {
    mode: auto
    by: batch-count
    min: 1
    max: 16
    batch-size: 25
  }
}
\`\`\`
`,
  },

  // -------------------------------------------------------------------------
  // 23. extensions
  // -------------------------------------------------------------------------
  extensions: {
    name: "extensions",
    description: "Binding-specific extension fields",
    content: () => `# extensions

The \`extensions\` block provides binding-specific configuration that is passed through to a particular target platform.

## Syntax

\`\`\`at
extensions {
  binding-name {
    field: value
    another-field: "string value"
  }
}
\`\`\`

## Scopes

Extensions can appear at multiple levels:

| Scope | Location | Description |
|-------|----------|-------------|
| topology | Top-level block | Topology-wide binding config |
| agent | Inside agent block | Agent-specific binding config |
| skill | Inside skill block | Skill-specific binding config |
| gate | Inside gate block | Gate-specific binding config |
| hook | Inside hook block | Hook-specific binding config |

## Example

\`\`\`at
# Topology-level: settings.json keys
extensions {
  claude-code {
    defaultMode: plan                    # lands at permissions.defaultMode
    additionalDirectories: ["../shared"] # permissions.additionalDirectories
    sandbox.autoAllowBashIfSandboxed: true
  }
}

# Agent-level: agent frontmatter keys
agent reviewer {
  model: opus
  extensions {
    claude-code {
      memory: project
      autoCompactWindow: 200000
    }
  }
}
\`\`\`

## Notes

- Unknown binding namespaces are ignored. This allows a single .at file to target multiple platforms.
- \`claude-code\` keys are checked against the Claude Code key schema (rule V130): on the topology they are settings.json keys (a dotted path, or a \`permissions\` / \`sandbox\` key by its own name), on an agent agent-frontmatter keys, on a skill skill-frontmatter keys. An unknown key, a mistyped value or a key a project settings file cannot set is not written, and validation warns, naming the nearest key: nothing is written that Claude Code would ignore.
- Other bindings define their own sets of recognized extension fields.
`,
  },

  // -------------------------------------------------------------------------
  // 24. schemas
  // -------------------------------------------------------------------------
  schemas: {
    name: "schemas",
    description: "Named schema definitions for typed input/output",
    content: () => `# schemas

The \`schemas\` block defines named schemas for structured agent input and output.

## Syntax

\`\`\`at
schemas {
  schema NAME {
    field: TYPE
    optional-field?: TYPE
  }
}
\`\`\`

## Primitive Types

| Type | Description |
|------|-------------|
| string | Text value |
| number | Floating-point number |
| integer | Whole number |
| boolean | true or false |
| object | Untyped object |

## Complex Types

| Syntax | Description |
|--------|-------------|
| \`array of TYPE\` | Array of a type |
| \`enum(val1, val2)\` | Enumerated values |
| \`ref(schema-name)\` | Reference to another schema |

## Optional Fields

Append \`?\` to the field name to mark it as optional:

\`\`\`at
schema review-result {
  verdict: enum(approve, revise, reject)
  score: number
  comments?: string
  details?: ref(review-details)
}
\`\`\`

## Usage

Reference schemas in agent \`input-schema\` and \`output-schema\` fields:

\`\`\`at
agent reviewer {
  model: opus
  output-schema {
    verdict: enum(approve, reject)
    confidence: number
  }
}
\`\`\`

## Example

\`\`\`at
schemas {
  schema pr-info {
    url: string
    title: string
    files-changed: integer
    labels?: array of string
  }

  schema review-output {
    verdict: enum(approve, request-changes, reject)
    risk: enum(low, medium, high)
    summary: string
    line-comments?: array of ref(line-comment)
  }

  schema line-comment {
    file: string
    line: integer
    comment: string
  }
}
\`\`\`
`,
  },

  // -------------------------------------------------------------------------
  // rules
  // -------------------------------------------------------------------------
  rules: {
    name: "rules",
    description: "Conduct rules traced to their ids, cited by gates and hooks",
    content: () => `# rules

The \`rules\` block holds conduct rules, each with an id a person can trace.

## Syntax

\`\`\`at
rules {
  rule "R-7.6" {
    text: "Never publish a draft without a second read."
    source: "editorial handbook, section 7"
  }
}
\`\`\`

- The id is a quoted string and may hold dots. Each id appears once (V143).
- \`text:\` is required and never empty (V143). \`source:\` is optional.

## What it compiles to

- **claude-code**: a \`## Rules\` section, one entry per rule with its id, written between
  \`<!-- agentopology:rules -->\` markers into the entry agent's file (\`meta { entry }\`), or the
  topology skill when there is no entry agent. Text outside the markers is yours.
- **codex**: the same section in AGENTS.md.
- \`agentopology validate\` prints \`rules: N declared (<ids>)\`.

## Citing a rule

A gate or hook may name the rule it enforces with \`rule: "<id>"\`. An id the block does not
declare is an error (V144). The citation is written into the gate's section of the playbook
and listed beside the gate by \`agentopology guard <file> --check\`. It is a trace, not
enforcement: the gate's own hook is what refuses.

\`\`\`at
gates {
  gate second-read {
    after: drafter
    run: "scripts/second-read.sh"
    rule: "R-7.6"
  }
}
\`\`\`
`,
  },

  // -------------------------------------------------------------------------
  // 25. defaults
  // -------------------------------------------------------------------------
  defaults: {
    name: "defaults",
    description: "Topology-wide default sampling parameters",
    content: () => `# defaults

The \`defaults\` block sets topology-wide default values for sampling parameters and shared agent configuration. Individual agents can override any default.

## Syntax

\`\`\`at
defaults {
  temperature: 0.7
  max-tokens: 4096
  top-p: 0.9
  thinking: medium
  thinking-budget: 5000
  output-format: text
  timeout: "10m"
  log-level: info
}
\`\`\`

## Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| temperature | number | -- | Sampling temperature (0-2) |
| max-tokens | number | -- | Max tokens to generate |
| top-p | number | -- | Nucleus sampling (0-1) |
| top-k | number | -- | Top-k sampling |
| stop | string[] | -- | Stop sequences |
| seed | number | -- | Random seed for reproducibility |
| thinking | string | -- | "off", "low", "medium", "high", "max" |
| thinking-budget | number | -- | Token budget for reasoning (min 1000) |
| output-format | string | -- | "text", "json", "json-schema" |
| timeout | string | -- | Duration string (e.g. "5m", "2h") |
| log-level | string | -- | "debug", "info", "warn", "error" |

## Notes

- Defaults apply to all agents unless overridden at the agent level.
- Only sampling-related and shared config fields are valid in defaults -- not agent-specific fields like \`tools\` or \`reads\`.
- A topology can have at most one \`defaults\` block (V23).
`,
  },

  // -------------------------------------------------------------------------
  // 26. observability
  // -------------------------------------------------------------------------
  context: {
    name: "context",
    description: "The context file (CLAUDE.md): one generated block, the rest yours",
    content: () => `# context

The \`context\` block makes the Claude Code binding write a context file. Without \`file:\`, no CLAUDE.md is written.

## Syntax

\`\`\`at
context {
  file: "CLAUDE.md"
  includes: [docs/style.md]
  max-lines: 200
  glossary {
    "ticket": "A unit of customer work"
  }
}
\`\`\`

## Fields

| Field | Description |
|-------|-------------|
| \`file\` | The file to write the block into |
| \`includes\` | Project files the block imports, one \`@<path>\` line each |
| \`max-lines\` | Longest the file may be (V146 warns above it) |
| \`glossary\` | \`"term": "definition"\` pairs, written as a list |

## What is written

One block between \`agentopology:context:begin\` and \`agentopology:context:end\` markers: the entry agent (\`meta { entry }\`) with an instruction to start as it and \`If no agent is named, start as <entry>.\`, the imports, and the glossary. A missing file is created; in an existing file only the text between the markers is replaced and every other line is kept; a file with no block gets it appended.

## Validation Rules

- **V145**: warning, an include that is not in the project (\`validate --dir\`)
- **V146**: warning, the file is longer than \`max-lines\`
`,
  },

  observability: {
    name: "observability",
    description: "Tracing and observability configuration",
    content: () => `# observability

The \`observability\` block configures distributed tracing and telemetry for the topology.

## Syntax

\`\`\`at
observability {
  enabled: true
  level: "info"
  exporter: otlp
  endpoint: "https://otel.example.com:4317"
  service: "my-topology"
  sample-rate: 0.5

  attributes {
    team.id: "platform"
    cost_center: "eng-123"
  }

  capture {
    prompts: true
    completions: true
    tool-args: true
    tool-results: false
  }

  spans {
    agents: true
    tools: true
    gates: true
    memory: false
  }
}
\`\`\`

## Top-Level Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| enabled | boolean | yes | -- | Enable/disable observability |
| level | string | no | -- | Log level for output |
| exporter | string | yes | -- | Backend exporter |
| endpoint | string | no | -- | Exporter endpoint URL |
| protocol | string | no | http/protobuf (grpc for a :4317 endpoint) | OTLP protocol, written as OTEL_EXPORTER_OTLP_PROTOCOL: \`http/json\`, \`http/protobuf\` or \`grpc\`; anything else is a V168 error |
| service | string | no | -- | Service name for trace attribution |
| sample-rate | number | no | 1.0 | Sampling rate (0-1) |
| attributes | block of key: "value" | no | -- | Resource attributes (keys may hold dots: \`team.id\`) |

## Exporters

\`otlp\`, \`langsmith\`, \`datadog\`, \`stdout\`, \`none\`

## Capture Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| prompts | boolean | -- | Capture prompt text sent to models |
| completions | boolean | -- | Capture completion text from models |
| tool-args | boolean | -- | Capture tool invocation arguments |
| tool-results | boolean | -- | Capture tool invocation results |

## Span Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| agents | boolean | -- | Emit spans for agent execution |
| tools | boolean | -- | Emit spans for tool invocations |
| gates | boolean | -- | Emit spans for gate checks |
| memory | boolean | -- | Emit spans for memory reads/writes |

## Claude Code (scaffold --target claude-code)

Since 0.13.0 the block is written to \`.claude/settings.json\` \`env\` as the keys Claude Code reads (https://code.claude.com/docs/en/monitoring-usage). \`enabled: false\` writes none.

| .at | settings.json env |
|-----|-------------------|
| enabled: true | CLAUDE_CODE_ENABLE_TELEMETRY=1 |
| exporter: otlp | OTEL_METRICS_EXPORTER=otlp, OTEL_LOGS_EXPORTER=otlp, OTEL_EXPORTER_OTLP_PROTOCOL (grpc for an endpoint on port 4317, else http/protobuf) |
| endpoint | OTEL_EXPORTER_OTLP_ENDPOINT |
| service, attributes | OTEL_RESOURCE_ATTRIBUTES=service.name=<service>,<key>=<value>,... (values percent-encoded) |
| capture { prompts: true } | OTEL_LOG_USER_PROMPTS=1 (scaffold warns: prompt text can carry client content) |
| capture { tool-args: true } | OTEL_LOG_TOOL_DETAILS=1 (scaffold warns: tool details can carry client content) |
| capture { completions: true } | OTEL_LOG_ASSISTANT_RESPONSES=1 (scaffold warns: response text can carry client content) |
| capture { prompts: true }, completions not true | OTEL_LOG_ASSISTANT_RESPONSES=0 (Claude Code would otherwise fall back to OTEL_LOG_USER_PROMPTS) |

- Capture switches left out or false write nothing else: Claude Code keeps prompts, responses and tool details redacted.
- A key you also set in \`env { }\` keeps your value; a different value is a V137 warning in validate and a warning in scaffold.
- \`spans { }\`, \`sample-rate\` other than 1, \`capture { tool-results }\` and exporters other than otlp have no Claude Code key: scaffold says so in a warning and writes nothing for them.

## Notes

- Observability data can contain sensitive information -- use \`capture\` settings carefully.
- \`sample-rate: 0.5\` means approximately 50% of traces are recorded.
`,
  },

  // -------------------------------------------------------------------------
  // 27. schedule
  // -------------------------------------------------------------------------
  schedule: {
    name: "schedule",
    description: "Scheduled job definitions -- cron and interval triggers",
    content: () => `# schedule

The \`schedule\` block defines time-based triggers that invoke agents or actions on a schedule.

## Syntax

\`\`\`at
schedule {
  job NAME {
    cron: "0 9 * * 1-5"
    agent: daily-reporter
    enabled: true
  }

  job NAME {
    every: "6 hours"
    action: health-check
  }
}
\`\`\`

## Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| id | identifier | yes | -- | Job identifier (the NAME) |
| cron | string | conditional (V20) | -- | 5-field cron expression (mutually exclusive with \`every\`) |
| every | string | conditional (V20) | -- | Human-readable interval (mutually exclusive with \`cron\`) |
| agent | identifier | conditional (V20) | -- | Agent ID to invoke |
| action | identifier | conditional (V20) | -- | Action ID to invoke |
| enabled | boolean | no | true | Whether this job is active |
| machine | identifier | no | -- | The machine the job runs on; must be in \`machines { }\` (V122) |
| carrier | string | no | -- | What fires the job: \`session\`, \`cron\`, \`launchd\`, \`cloud\` or \`calendar\` (V124) |
| survives | string | no | -- | What the job outlives: \`pane-close\`, \`reboot\` or \`away\` (V124). \`carrier: session\` with any \`survives:\` is an error: a session cron dies with its session and after 7 days (V125) |

## Validation Rules

- **V20**: \`cron\` and \`every\` are mutually exclusive -- use one or the other
- **V20**: Job must reference a declared agent or action node
- **V136**: warning, a job runs a decision, report or inline action, or one with no kind, with no \`commands:\` (done in conversation, so the job does nothing)

## Example

\`\`\`at
schedule {
  job daily-report {
    cron: "0 9 * * 1-5"
    agent: reporter
  }

  job health-check {
    every: "30 minutes"
    action: check-health
    enabled: true
  }

  job weekly-cleanup {
    cron: "0 0 * * 0"
    action: cleanup
    enabled: false
  }
}
\`\`\`

## Notes

- Cron uses standard 5-field format: minute, hour, day-of-month, month, day-of-week.
- Disabled jobs (\`enabled: false\`) are parsed but not executed.
`,
  },

  // -------------------------------------------------------------------------
  // 28. interfaces
  // -------------------------------------------------------------------------
  interfaces: {
    name: "interfaces",
    description: "External interface definitions -- webhooks, HTTP, SSE",
    content: () => `# interfaces

The \`interfaces\` block defines external communication endpoints for the topology.

## Syntax

\`\`\`at
interfaces {
  NAME {
    type: webhook
    url: "https://hooks.example.com/incoming"
    channel: "#alerts"
  }
}
\`\`\`

## Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| id | identifier | yes | -- | Interface identifier (the NAME) |
| type | string | no | -- | "webhook", "http", "sse", "email" |
| config | key-value | no | -- | All non-type fields (free-form) |

## Interface Endpoints

A separate \`interface\` block (singular) defines composition entry/exit points:

\`\`\`at
interface {
  entry: first-agent
  exit: last-agent
}
\`\`\`

## Example

\`\`\`at
interfaces {
  slack-notify {
    type: webhook
    url: "\${SLACK_WEBHOOK_URL}"
    channel: "#deployments"
  }

  health-endpoint {
    type: http
    port: "8080"
    path: "/health"
  }
}
\`\`\`

## Validation Rules

- **V21**: Sensitive fields (URLs with credentials, tokens) must use \`\${ENV_VAR}\` syntax
`,
  },

  // -------------------------------------------------------------------------
  // 29. checkpoint
  // -------------------------------------------------------------------------
  checkpoint: {
    name: "checkpoint",
    description: "Durable execution and checkpoint configuration",
    content: () => `# checkpoint

The \`checkpoint\` block configures durable execution -- persisting topology state for resumability, replay, and time-travel debugging.

## Syntax

\`\`\`at
checkpoint {
  backend: "redis"
  connection: "\${REDIS_URL}"
  strategy: "after-each-agent"
  ttl: "7d"

  replay {
    enabled: true
    max-history: 100
    branch: true
  }
}
\`\`\`

## Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| backend | string | yes | -- | Storage backend (e.g. "redis", "postgres", "s3") |
| connection | string | no | -- | Connection string or secret reference |
| strategy | string | yes | -- | When to checkpoint (e.g. "after-each-agent") |
| ttl | string | no | -- | Time-to-live for checkpoint data (e.g. "7d", "30d") |

## Replay Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| enabled | boolean | yes | -- | Enable replay/time-travel |
| max-history | number | no | -- | Max historical states to retain |
| branch | boolean | no | false | Allow branching from a historical state |

## Notes

- Requires \`durable: true\` in the topology \`meta\` block.
- Connection strings should use \`\${ENV_VAR}\` or \`secret\` syntax for credentials.
- Replay allows re-executing from any checkpointed state, useful for debugging failures.
`,
  },

  // -------------------------------------------------------------------------
  // 30. artifacts
  // -------------------------------------------------------------------------
  artifacts: {
    name: "artifacts",
    description: "Artifact definitions for asset lineage tracking",
    content: () => `# artifacts

The \`artifacts\` block defines named outputs with types, storage, retention, and dependency tracking.

## Syntax

\`\`\`at
artifacts {
  artifact NAME {
    type: "markdown"
    path: "output/report.md"
    retention: "30d"
    depends-on: [source-data, analysis]
  }
}
\`\`\`

## Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| id | identifier | yes | -- | Artifact identifier (the NAME) |
| type | string | yes | -- | File type (e.g. "markdown", "json", "csv", "pdf") |
| path | string | no | -- | Storage path or prefix |
| retention | string | no | -- | How long to keep (e.g. "30d", "1y") |
| depends-on | string[] | no | -- | IDs of upstream artifacts |

## Agent Integration

Agents reference artifacts via \`produces\` and \`consumes\`:

\`\`\`at
agent writer {
  produces: [draft]
  consumes: [research-notes]
}
\`\`\`

## Example

\`\`\`at
artifacts {
  artifact research-notes {
    type: "markdown"
    path: "workspace/research/"
    retention: "90d"
  }

  artifact draft {
    type: "markdown"
    path: "workspace/drafts/"
    retention: "30d"
    depends-on: [research-notes]
  }

  artifact final-report {
    type: "pdf"
    path: "output/"
    retention: "1y"
    depends-on: [draft]
  }
}
\`\`\`

## Notes

- \`depends-on\` creates an explicit lineage graph between artifacts.
- Retention durations use human-readable strings: "30d", "6m", "1y".
- Artifact type is informational -- it does not enforce file format.
`,
  },

  // -------------------------------------------------------------------------
  // walls (never-reads and secrets)
  // -------------------------------------------------------------------------
  secrets: {
    name: "secrets",
    description: "Per-agent walls: never-reads on an agent and the top-level secrets block",
    content: () => `# secrets

Per-agent walls on what can be read. \`never-reads\` on an agent lists path globs that agent may not read. A \`secrets\` entry names a path glob and the readers that may read it.

## Syntax

\`\`\`at
secrets {
  secret prod-config { path: "config/prod/**", readers: [deployer, main] }
}
agent reviewer {
  model: sonnet
  never-reads: [".env", "private/**"]
}
\`\`\`

- \`readers\` are agent ids, or \`main\` for the main session. Any other agent, and the main session unless \`main\` is listed, is refused.
- A glob is project-relative. \`**\` and \`*\` match across folders; a pattern with no \`/\` also matches a file name anywhere.
- A path may start with \`~/\` (the home folder) or \`//\` (absolute, from the filesystem root): the forms Claude Code's Read and Edit rules use (https://code.claude.com/docs/en/permissions, "Read and Edit"). A single leading \`/\` stays the project root.
- \`ask-reads: [paths]\` on an agent makes a Read ask instead of refuse. It compiles to \`permissions.ask\` \`Read(...)\` rules (\`~/x\` stays \`~/x\`, \`//x\` stays \`//x\`, \`notes/**\` becomes \`Read(/notes/**)\`). That is a permission rule (strong, Claude Code applies it) but it holds for the whole session, not one agent. The same path in \`never-reads\` and \`ask-reads\` is V163.
- The \`before-read.sh\` hook is a text check (weaker): it reads the paths a call names and the words of a Bash command.

## What it compiles to (claude-code)

One generated PreToolUse hook on \`Read|Grep|Glob|Bash\` (\`before-read.sh\`) that exits 2 on a match. The calling agent is \`agent_type\` in the hook input: Claude Code sets it when the call comes from a subagent or from a session started with \`--agent\`, and leaves it out in the plain main session.

Checked: Read \`file_path\`, Grep \`path\` and \`glob\`, Glob \`path\` and \`pattern\`, and the words of a Bash command.

Not seen in a Bash command: a path built in a variable or substitution, one reached after \`cd\`, one a script opens itself, a search from a folder above the protected one.

## Validation Rules

- **V153**: a reader must be a declared agent or \`main\`
- **V154**: a secret needs a \`path\`
- **V163**: the same path in \`never-reads\` and \`ask-reads\`
`,
  },

  // -------------------------------------------------------------------------
  // boundary
  // -------------------------------------------------------------------------
  boundary: {
    name: "boundary",
    description: "boundary blocks: a read-only path, no direct push, outbound hosts",
    content: () => `# boundary

\`boundary <id> { path, in, out, outbound }\` says what may cross the edge of a path.

## Syntax

\`\`\`at
boundary vendor {
  path: "vendor/**"
  in: read-only
  out: pr
  outbound: [api.example.com]
}
\`\`\`

- \`path\` (required): a project path, \`~/...\` (home) or \`//...\` (absolute); the same forms as \`never-reads\`.
- \`in: read-only | read-write\`: read-only refuses edits of the path.
- \`out: none | pr | direct\`: \`none\` refuses every \`git push\`; \`pr\` refuses a push to main or master (and to the optional \`branch: <name>\`), so changes go through a branch and \`gh pr create\`; \`direct\` restricts nothing.
- \`outbound: [hosts]\`: hosts the work may reach. With a human that has a go word, the sandbox block is generated and they are written to its \`sandbox.network.allowedDomains\` (your own extensions entries are kept beside them). Without one they are listed in \`boundaries.md\` only, and V166 says so.

## What it compiles to (claude-code)

- A **permission rule** (strong, Claude Code applies it): \`in: read-only\` writes \`Edit(<path>)\` deny rules in \`.claude/settings.json\`. Edit rules cover Edit, Write, MultiEdit and NotebookEdit (https://code.claude.com/docs/en/permissions, "Read and Edit").
- A **text check** (weaker): \`before-boundary.sh\`, a PreToolUse hook on \`Edit|Write|MultiEdit|NotebookEdit|Bash\`. It refuses an edit tool's path under a read-only path, a Bash command that writes one (a redirect, tee, cp, mv, rm, touch, sed -i ...), and a \`git push\` the boundary forbids. There is no permission rule for pushing to a branch, so the push checks are text checks only.
- Not seen by the text check: a path or branch built in a variable or substitution, a path reached after \`cd\`, a write a script or program does itself, a push under a git alias. Ordinary work passes: git commit, a push to a feature branch, \`gh pr create\`, git status, npm test.
- \`boundaries.md\` records each boundary, how it is enforced, and the outbound hosts.

## Validation Rules

- **V164**: a boundary needs a \`path\`
- **V165**: an unknown \`in\` or \`out\` value, an outbound entry that is not a host name, a bad \`branch\`, a repeated id
- **V166** (warning): outbound hosts are listed but no sandbox block is generated (no go word)
`,
  },

  // -------------------------------------------------------------------------
  // 31. composition
  // -------------------------------------------------------------------------
  composition: {
    name: "composition",
    description: "Imports, includes, params, fragments, and libraries",
    content: () => `# composition

AgenTopology supports composing topologies from reusable parts: imports, includes, params, fragments, and libraries.

## import

Import another topology and use it as a sub-topology:

\`\`\`at
import reviewer from ./review.at
import linter from registry:@org/linter@1.2.0
import auditor from ./audit.at sha256 "abc123..."
\`\`\`

### Import with Overrides

\`\`\`at
use reviewer {
  model: opus
  timeout: "30m"
}
\`\`\`

## include

Include a fragment file, merging its contents into the current topology:

\`\`\`at
include "./shared/common-hooks.at"
\`\`\`

The path is read relative to the including file. Nodes, flow edges, hooks, triggers, skills, tools, schedules, schemas, artifacts, records, stores, providers, mcp-servers, env and roles are merged. A name declared in both files is a V8 error naming both. One-per-topology sections (settings, defaults, depth, memory, metering, context, extensions, params, interface, ...) and \`import\` in a fragment are a V8 error naming the section: write them in the including file. Paths in the fragment are project paths, as anywhere else.

## params

Declare typed parameters for a composable topology:

\`\`\`at
params {
  param model {
    type: string
    default: "sonnet"
  }

  param max-retries {
    type: number
    default: 3
  }

  param strict-mode {
    type: boolean
  }
}
\`\`\`

### Param Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| name | identifier | yes | Parameter name |
| type | string | yes | "string", "number", "boolean" |
| default | value | no | Default value (if absent, param is required) |

## fragment

A fragment is a partial topology for inclusion. Uses \`fragment\` instead of \`topology\`:

\`\`\`at
fragment {
  agent shared-reviewer {
    model: opus
    tools: [Read, Grep]
  }

  hooks {
    hook log-all {
      on: AgentStop
      run: "scripts/log.sh"
      type: command
    }
  }
}
\`\`\`

## library

A library defines reusable agent definitions:

\`\`\`at
library shared-agents {
  agent reviewer {
    model: opus
    tools: [Read, Grep, Glob]
  }
}
\`\`\`

## interface (entry/exit)

Define composition endpoints for a topology:

\`\`\`at
interface {
  entry: first-agent
  exit: last-agent
}
\`\`\`

## Integrity

SHA-256 hashes ensure import integrity:

\`\`\`at
import reviewer from ./review.at sha256 "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
\`\`\`

## Validation Rules

- **V8**: Import paths must resolve to existing files
- **V1**: Imported names must be globally unique
`,
  },

  // -------------------------------------------------------------------------
  // 32. validation
  // -------------------------------------------------------------------------
  validation: {
    name: "validation",
    description: "All validation rules with descriptions and fixes",
    content: () => `# validation

AgenTopology enforces 82 validation rules during parsing. Errors prevent compilation; warnings are informational.

## Rules

### V1: Unique Names (error)
All node names must be globally unique across agents, actions, gates, orchestrators, groups, and humans.

**Violation:** Two nodes named \`reviewer\`.
**Fix:** Rename one to a unique identifier.

### V2: No Keyword Names (error)
Node names cannot match reserved keywords.

**Violation:** \`agent flow { ... }\` (\`flow\` is reserved).
**Fix:** Choose a non-reserved name.

### V3: Flow Resolves (error)
Every node referenced in a flow edge must be declared.

**Violation:** \`analyzer -> checker\` where \`checker\` is not declared.
**Fix:** Declare the missing node or fix the typo.

### V4: No Orphans (error)
Every agent must appear in at least one flow edge, or have \`invocation: manual\`. The \`meta { entry }\` agent is exempt: it is the session itself (V134).

**Violation:** An agent declared but never referenced in flow.
**Fix:** Add the agent to the flow or set \`invocation: manual\`.

### V5: Outputs Exist (error)
\`[when x.y == z]\` conditions must reference declared output fields with valid values.

**Violation:** \`[when reviewer.verdict == pass]\` but \`verdict\` only has \`approve | reject\`.
**Fix:** Use a declared output value.

### V6: Bounded Loops (error)
Back-edges (loops) must have \`[max N]\` to prevent infinite iteration.

**Violation:** \`reviewer -> writer\` without \`[max N]\`.
**Fix:** Add \`[max N]\`: \`reviewer -> writer [max 3]\`.

### V7: Model Required (error)
Every agent and orchestrator must have a \`model\` field.

**Violation:** \`agent reviewer { tools: [Read] }\` (no model).
**Fix:** Add \`model: MODEL\`.

### V8: Imports Resolve (error)
Import source paths must point to existing files.

**Violation:** \`import x from ./nonexistent.at\`.
**Fix:** Correct the path or create the file.

### V9: Actions Handled (error)
Actions referenced in flow must appear in the orchestrator's \`handles\` list.

**Violation:** \`intake -> agent\` but \`handles\` doesn't include \`intake\`.
**Fix:** Add the action to \`handles: [intake, ...]\`.

### V10: Prompts Exist (warning)
Prompt blocks should not be empty.

**Violation:** \`prompt {}\` with no content.
**Fix:** Add prompt text or remove the empty block.

### V11: Reads/Writes Consistent (error)
Data dependencies (\`reads\`/\`writes\`) must be consistent with flow order. An agent cannot read a key that no upstream agent writes.

**Violation:** Agent B reads "output.md" but no upstream agent writes it.
**Fix:** Ensure an upstream agent writes the key, or remove the read.

### V12: Edge Attribute Order (error)
Edge attributes must appear in order: \`when\`, \`max\`, \`per\`.

**Violation:** \`[max 3, when x.y == z]\`.
**Fix:** Reorder to \`[when x.y == z, max 3]\`.

### V13: Gate Placement (error)
Gate \`after\` and \`before\` fields must reference declared nodes.

**Violation:** \`after: nonexistent-agent\`.
**Fix:** Reference a declared node.

### V14: Tool Exclusivity (error)
An agent cannot have both \`tools\` and \`disallowed-tools\`.

**Violation:** \`tools: [Read] disallowed-tools: [Bash]\`.
**Fix:** Use one or the other.

### V15: Exhaustive Conditions (error)
Conditional edges from a node must cover all declared output values.

**Violation:** Agent has \`verdict: approve | revise | reject\` but only edges for approve and revise.
**Fix:** Add an edge for the \`reject\` case.

### V16: API Key Env Vars (error)
Provider \`api-key\` must use \`\${ENV_VAR}\` syntax, never inline secrets.

**Violation:** \`api-key: "sk-abc123"\`.
**Fix:** Use \`api-key: "\${ANTHROPIC_API_KEY}"\`.

### V17: Single Default Provider (error)
At most one provider can be marked \`default: true\`.

**Violation:** Two providers with \`default: true\`.
**Fix:** Remove \`default: true\` from one.

### V18: Model in Provider (warning)
Agent model identifiers should exist in a declared provider's \`models\` list.

**Violation:** \`model: gpt-5\` but no provider lists \`gpt-5\`.
**Fix:** Add the model to a provider's \`models\` list.

### V19: Unique Provider Names (error)
Provider names must be unique.

**Violation:** Two providers named \`anthropic\`.
**Fix:** Use unique names.

### V20: Schedule Job References (error)
Scheduled jobs must reference declared agent or action nodes. \`cron\` and \`every\` are mutually exclusive.

**Violation:** \`agent: nonexistent\` or both \`cron\` and \`every\` specified.
**Fix:** Reference a declared node; use only one of cron/every.

### V21: Interface Secret Detection (error)
Sensitive interface fields (URLs, tokens) must use \`\${ENV_VAR}\` syntax.

**Violation:** Inline URL with embedded credentials.
**Fix:** Use \`\${ENV_VAR}\` references.

### V22: Fallback Chain Models (warning)
Models in \`fallback-chain\` should exist in a declared provider.

**Violation:** \`fallback-chain: [nonexistent-model]\`.
**Fix:** Add the model to a provider.

### V23: Duplicate Sections (error/warning)
Sections such as meta, memory, flow, settings and mcp-servers should appear once. A second copy is a warning: only the first is used. \`hooks {}\` may be written more than once: every block's hooks are used, in file order. A hook name used in two \`hooks {}\` blocks is an error; twice in one block, a warning.

**Violation:** Two \`flow {}\` blocks; a hook \`guard\` in two \`hooks {}\` blocks.
**Fix:** Merge the sections into one block; give each hook its own name.

### V24: Unknown Memory Sub-Blocks (warning)
Memory sub-blocks should be known names (workspace, domains, references, external-docs, metrics).

**Violation:** \`memory { custom-block { ... } }\`.
**Fix:** Use a recognized sub-block name or move to extensions.

### V25: Bounce-Back Enforcement (warning, conditional)
\`on-fail: bounce-back\` enforcement depends on the gate's \`after\` target:

- **claude-code, \`after\` is an agent or group node**: compiles to a SubagentStop hook whose exit 2 prevents the subagent from stopping. Enforceable. No warning.
- **claude-code, \`after\` is a human/action/orchestrator or missing**: cannot be wired as a SubagentStop hook (matcher must be an agent id). Warning fires; invoke the gate script from your orchestrator playbook instead.
- **Other CLI bindings**: enforcement varies; orchestrator cooperation may be required.

**Violation:** \`on-fail: bounce-back\` with a non-agent \`after\` target.
**Fix:** Either move the gate to run after an agent, or invoke its script from a slash-command playbook so the orchestrator (not a hook) drives enforcement.

### V26: Action Kind Enum (error)
Action \`kind\` must be: external, git, decision, inline, or report.

**Violation:** \`kind: custom\`.
**Fix:** Use a recognized kind value.

### V27: Agent Permissions Enum (warning)
Agent \`permissions\` should be a recognized mode: autonomous, supervised/plan, interactive/confirm, unrestricted/bypass, auto (Claude Code's auto mode, see V132), or one of Claude Code's own values (default, acceptEdits, dontAsk, bypassPermissions).

**Violation:** \`permissions: custom-mode\`.
**Fix:** Use a recognized permission mode.

### V28: Metering Format Enum (error)
Metering \`format\` must be: json, jsonl, or csv.

**Violation:** \`format: xml\`.
**Fix:** Use json, jsonl, or csv.

### V29: Metering Pricing Enum (warning)
Metering \`pricing\` should be a recognized model: anthropic-current, custom, or none.

**Violation:** \`pricing: azure-current\`.
**Fix:** Use a recognized pricing model.

### V87: Orchestrator Delegation Enum (error)
\`orchestrator.delegation\` must be one of:

- \`subagent\` (default) — orchestrator spawns each agent via the platform's subagent / Task-tool mechanism.
- \`inline\` — orchestrator drives every agent step in its own session context; no subagent is ever spawned. The claude-code binding suppresses \`SubagentStop\` hooks in this mode and emits a "Gates to invoke" cheat sheet in the trigger playbook. A gate the playbook runs is \`strength: hope\`; one left to refuse is a V135 error unless a script step is in its \`before:\`.

**Violation:** \`delegation: hybrid\`.
**Fix:** Use \`subagent\` or \`inline\`.

### V134: Entry Agent (error/warning)
\`meta { entry }\` names the agent every session starts as; Claude Code reads it from the settings.json \`agent\` key, which names a subagent. It must be a declared agent that claude-code writes as a subagent.

**Violation (error):** \`entry: ghost\` (no such node); \`entry: intake\` where intake is an action, gate, human, group or orchestrator; an agent with \`runs: inline\` or \`runs: fork\` (written as a skill); an agent marked \`execution: workflow\` (run by the workflow script).
**Violation (error):** \`entry:\` with no value, or a list (\`entry: [a, b]\`).
**Violation (warning):** \`extensions { claude-code { agent: other } }\` names a different agent. The extension value is written. If it names a declared node Claude Code cannot start, it is not written.
**Violation (warning):** a gate \`after:\` the entry agent. The entry agent is the session, so SubagentStop never fires for it; the hook is not written, and guard --check grades the gate hope.
**Violation (warning):** the entry agent has a \`tools\` list without \`Agent\` (or \`Task\`) while other agents exist: its tools are the session's, so the session cannot start them.
**Fix:** Point \`entry\` at a subagent, and remove the extension's \`agent\` or make it agree. Anchor a gate on a subagent or a script step. Add \`Agent\`, or \`Agent(worker, reviewer)\`, to the entry agent's tools.

### V135: Refusing Gate No Hook Runs (error)
A gate meant to refuse (its \`run:\` names a script, not advisory, \`strength\` refuse or not written) must have a moment Claude Code or Codex can hook: every \`after:\` a subagent (SubagentStop), a subagent in \`before:\` (before-agent.sh), or a script step, an action with \`commands:\`, in \`before:\` (before-action.sh). Under \`delegation: inline\` only the script step wires. Anything else got a wrapper script nothing calls, a scaffold warning, and a passing validate. An edge between its anchors that cites (\`guard:\`) a declared blocking hook with \`strength: refuse\` credits it, and so does such a hook that runs the gate's own \`run:\` command (a V135 warning then names it with its matcher and \`if:\`, since guard --check grades that gate hope, or cited with \`at:\`); a cited \`at:\` does not. A blocking hook is a command hook, not async, on an event the platform blocks on (the list guard --check reads). On Claude Code an \`execution: workflow\` agent is not a subagent. Applies with no target, claude-code and codex, including in scaffold, guard --target and imported files; not cursor (a hook for every gate) or claude-workflow, and \`plan\` does not stop on it. On Codex a gate run only by SubagentStop passes V135 but cannot hold the next step (CX9-noblock warns).

**Violation:** \`gate numbers { before: finish, run: "bash tools/check.sh" }\`, where \`finish\` is a report step and there is no \`after:\`.
**Fix:** Give it a subagent in \`after:\` or \`before:\`, or a script step in \`before:\`; if a playbook runs it by hand, write \`strength: hope\`; for a cited gate, drop \`run:\` and keep the citation as the claim. \`agentopology fix <file.at>\` lists every V135 error with the edit and, when the flow has one, an anchor that would make the gate refuse; \`--write\` adds \`strength: hope\` to those gates and changes nothing else.

### V139: Record Fields (error)
A record's \`fields:\`, \`schema:\`, \`writer:\` or \`kind:\` is wrong: a field type that is not string, number, boolean or ts, a \`schema:\` no \`schemas { }\` declares, a \`writer:\` that names no declared action or agent and is no safe project-relative script path, a \`kind:\` other than \`run-state\`, or \`kind: run-state\` with \`fields:\`.

**Violation:** \`record trace { path: "t.jsonl", fields: [n: integer] }\`
**Fix:** Use one of string, number, boolean, ts.

### V140: Records Not Written (warning)
With \`--target codex\` or \`--target cursor\`, a record that declares fields, a schema, a writer or a kind gets no record script, no step ledger row and no records list; only claude-code writes them.

**Fix:** Use claude-code, or leave the record a path a gate reads.

### V136: Scheduled Routing Action (warning)
A schedule job runs a \`decision\`, \`report\` or \`inline\` action, or an action with no \`kind:\`, that has no \`commands:\`. The orchestrator does such an action in conversation, so its script has nothing to run and the job, which runs with no orchestrator, does nothing. The warning names the job, the action and its kind (or "no kind"). Every target; an \`external\` or \`git\` action with no commands is a stub, not reported.

**Violation:** \`job nightly { cron: "0 3 * * *", action: finish }\`, where \`finish\` is \`kind: report\` with no \`commands:\`.
**Fix:** Give the action \`commands: [...]\`, or schedule the agent that does the work.

### V137: Observability Env Override (warning)
\`observability { }\` compiles to the telemetry env keys Claude Code reads (see the observability topic). A key the topology also writes in \`env { }\` with a different value keeps the \`env { }\` value; the warning names the key and both values. Also a warning when \`attributes { service.name }\` sits next to \`service:\` (service is written). No target or claude-code only.

**Violation:** \`observability { endpoint: "http://127.0.0.1:4318" }\` with \`env { OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" }\`.
**Fix:** Drop one of the two, or make them agree.

### V138: Threat Model (error/warning)
The \`threat-model { }\` block must name what it can compile. Errors: an \`untrusted\` entry that is not \`web\`, \`mcp:<id>\` of a declared server, or a path glob; a \`lift:\` that names no declared human; a \`refuse-after-untrusted\` string that is not a permission rule; a server with \`trust:\` other than \`untrusted\` or \`trusted\`. Warnings: rules with nothing untrusted (or the reverse), \`outside-sandbox\` with the sandbox off, and on codex and cursor that the block is not written. See the **threat-model** topic.

### V141: Gate and Hook Tests (error)
\`tests { refuse: [...] allow: [...] }\` on a gate or a hook is run by \`agentopology guard <file> --test\`. A gate's tests need a generated check that holds it: before-action.sh (a script step, an action with \`commands:\`, in \`before:\`) or before-agent.sh (a subagent in \`before:\` with a \`run:\` script). A hook's tests are Bash commands fed to its own script as a PreToolUse payload, so the hook must be a command hook on PreToolUse with a \`run:\`. A tests block with no rows, or an empty row, is an error too.

**Violation:** \`gate g { after: a  before: b  run: "scripts/g.sh"  tests { refuse: ["b"] } }\` where \`a\` and \`b\` are subagents: a SubagentStop hook runs it, and no check runs before something.
**Fix:** Give the gate a script step or a subagent in \`before:\`, or drop \`tests\`.

### V142: Gate Mode and Let-Go (error)
\`mode\` on a gate is \`shadow\` or \`refuse\`; \`let-go\` is \`once\`. Both change what the generated check does, so an unread value is an error, and so is \`mode: shadow\` or \`let-go\` on a gate no generated check holds (they would do nothing). \`let-go: once\` needs a human to give it (\`lift: <human id>\`, or a human in \`after:\`) and a ledger to read the human's row from; a gate that holds a subagent launch needs a ledger path with no \`{unit}\`. \`lift:\` without \`let-go\` and \`mode\` or \`let-go\` on a hook are errors: a hook runs your own script.

**Violation:** \`gate g { after: render, before: publish, let-go: once }\` with no human anywhere.
**Fix:** Add \`lift: <human id>\`, or drop \`let-go\`.

### V143: Rules Block (error)
A \`rules { }\` block holds rules with unique ids and non-empty text. A repeated id, an empty id, or a rule with no \`text:\` is an error.

**Violation:** \`rules { rule "R-1" { text: "a" }  rule "R-1" { text: "b" } }\`
**Fix:** Give each rule its own id and write its text.

### V144: Rule Citation (error)
A gate or hook that cites \`rule: "<id>"\` must name a rule the \`rules { }\` block declares.

**Violation:** \`gate g { after: a, run: "scripts/g.sh", rule: "R-9" }\` with no rule "R-9".
**Fix:** Declare the rule, or cite one that exists.

### V145: Context Include Missing (warning)
A \`context { includes }\` path does not exist in the project. Checked only with \`validate --dir <project>\`. The generated \`@<path>\` import in the context file would point at nothing.

**Fix:** Create the file or correct the path.

### V146: Context File Too Long (warning)
The context file (the generated block plus your own lines) is longer than \`context { max-lines }\`.

**Fix:** Shorten the file or raise \`max-lines\`.

### V147: Island Owner (error)
An island in the top-level \`islands { }\` block has no \`path:\`, no \`owner:\`, or an owner that is not a declared \`person\`. An island covers the project files its glob matches: \`validate --inventory\` counts them as accounted for and lists the island with its owner; \`guard --check\` lists its \`test:\` command (it is never run). With \`inventory { strict: true }\`, \`validate --inventory\` exits 1 when a live file is in neither the .at nor an island.

**Violation:** \`islands { island core { path: "harness/**", owner: bob } }\` with no \`person bob\`.
**Fix:** Declare \`person bob { }\`, or name a declared person.

### V148: Requires Range (error)
\`meta { requires: "<range>" }\` is not a version range. A range is one or more comparators separated by blanks; a comparator is \`>=\`, \`<=\`, \`>\`, \`<\`, \`=\` or \`^\` before \`x.y.z\`. Every command that reads the file exits 1 when the running agentopology is outside the range.

**Violation:** \`meta { requires: "newer" }\`.
**Fix:** \`requires: ">=0.13.0"\`, \`"^0.13.0"\` or \`">=0.13.0 <1.0.0"\`.

### V149: Finish Edge Target (error)
A \`[finish]\` edge closes the run and hands the line back to the entry agent, so it must point at \`meta { entry }\`, and the topology must declare one. A finish edge is an end, not a loop: V6 does not apply, so it needs no \`[max N]\`.

**Violation:** \`builder -> checker [finish]\` where the entry is \`lead\`.
**Fix:** \`builder -> lead [finish]\`.

### V150: Outpoints (error/warning)
\`meta { outpoints: [..] }\` lists the nodes a run may end at. An outpoint that is not a declared node is an error. Once the list is written, a flow node with no outgoing edge that is not listed warns.

**Fix:** Declare the node or remove it from the list; add a dead-end node to \`outpoints\` or give it an edge.

### V151: Write Anchor (error/warning)
A gate's \`before: write "<glob>"\` names a non-empty path glob (error), and the gate has a ledger or a \`run:\` to check (warning when it has neither: the edit is never refused).

**Violation:** \`gate src-open { before: write "", ledger: trace }\`.
**Fix:** \`before: write "src/**"\`.

### V152: Meta Target (error)
\`meta { target }\` is a directory path, absolute or relative to the project, with letters, digits and \`. _ @ + - /\` and spaces only.

**Violation:** \`target: "a;b"\` or \`target: ""\`.
**Fix:** \`target: "app"\`.

### V153: Secret Readers (error)
A \`secrets\` reader must be a declared agent, or \`main\` for the main session.

**Violation:** \`secret s { path: "x/**", readers: [ghost] }\` with no agent \`ghost\`.
**Fix:** Name a declared agent, or \`main\`.

### V154: Secret Path (error)
A \`secrets\` entry needs a \`path\` glob; with none it guards nothing.

**Violation:** \`secret s { readers: [deployer] }\`.
**Fix:** Add \`path: "<glob>"\`.

### V155: CI Block (error)
A top-level \`ci { }\` block: the \`ci\` block isn't part of this package; a plugin can provide it. With a loaded plugin that owns the \`ci\` keyword, the plugin reads the block and V155 is not raised.

**Violation:** \`ci { provider: github, gates: [publish-ready] }\` with no plugin that reads it.
**Fix:** Remove the block, or load a plugin that provides it.

### V156: Caps (error/warning)
\`max-subagents\` on an agent must be a positive whole number, and \`max-cost\` (on an agent, or in \`metering\`, where \`cap:\` is its alias) a positive number of US dollars; anything else is an error. A \`max-cost\` that is set is a warning: \`max-cost is advisory, not enforced: Claude Code hooks do not see spend; it is written to the metering output for reporting\`. \`max-subagents\` and \`timeout\` are enforced on claude-code by generated hooks.

**Violation:** \`agent lead { max-subagents: 0 }\`.
**Fix:** \`max-subagents: 3\`.

### V157: Field Swallowed Into A Value (error)
In a \`checkpoint\`, \`interface\`, \`defaults\`, \`observability\` or \`metering\` block, a value still holds \`, <field>:\` where \`<field>\` is a field of the same block. A comma between fields on one line separates them, but not inside quotes, \`[..]\`, \`{..}\` or \`(..)\`; an unclosed one hides the next field, which was then lost. The message names the block and the field.

**Violation:** \`checkpoint { backend: sqlite, ttl: (7d, strategy: x }\`
**Fix:** Close the bracket or quote, or put the field on its own line.

### V158: Record Daily Cap (error)
A record's \`max-per-day\` must be a positive whole number, and the record's path must not hold \`{unit}\` (the cap counts the rows of one file). The message names the record.

**Violation:** \`record events { path: "logs/events.jsonl", max-per-day: 0 }\`
**Fix:** \`max-per-day: 20\`

### V159: Output Into A Record (error/warning)
An agent's \`output-into: <record-id>\` must name a declared record whose path has no \`{unit}\`, and the agent must have an \`output-schema\` (the SubagentStop hook copies the fields the schema declares). With \`--target codex\` or \`cursor\` it is a warning: only claude-code writes the hook.

**Violation:** \`agent reviewer { output-into: results }\` with no \`output-schema\`.
**Fix:** Add an \`output-schema { verdict: ok | fail }\` block to the agent.

### V160: Stop Word (error)

A human's \`stop-word:\` needs \`word:\`, must be one non-empty line, must differ from the word, and neither may open with the other (the go hook reads a prompt that opens with a word as that word, so one prompt would give the go and the stop).

### V161: Wall Time (error)

\`wall-time: <duration>\` (\`4h\`, \`90m\`) caps the whole session, so it sits on the entry agent (\`meta { entry: <agent> }\`) only; on any other agent, or with no entry named, it is an error (a subagent's own limit is \`timeout\`). The value must be a positive whole number and \`s\`, \`m\`, \`h\` or \`d\`. \`renew-on: <human-id>\` beside it needs \`wall-time:\` on the entry agent and names a human with a \`word:\`.

### V162: Egress (error)

The \`egress { gate, covers }\` block needs a \`gate\` naming a human with a \`word:\` or a record whose path has no \`{unit}\`, and a non-empty \`covers\` of \`observability\`, \`web\`, \`network\`, \`mcp\`.

### V163: Never-reads And Ask-reads Overlap (error)
The same path is in \`never-reads\` and in \`ask-reads\`. One refuses and the other asks; \`ask-reads\` is a session-wide permission rule, so both cannot hold. Compared by anchor (\`~/\`, \`//\`, project) and path, across all agents.

**Violation:** \`never-reads: ["private/**"]\` and \`ask-reads: ["private/**"]\`.
**Fix:** Keep one.

### V164: Boundary Path (error)
A \`boundary\` needs a \`path\`; with none it is about nothing.

**Violation:** \`boundary b { in: read-only }\`.
**Fix:** Add \`path: "<path>"\`.

### V165: Boundary Values (error)
\`in\` is \`read-only\` or \`read-write\`; \`out\` is \`none\`, \`pr\` or \`direct\`; an \`outbound\` entry is a host name (not a URL); \`branch\` is a branch name and needs \`out: pr\`; a boundary id is declared once.

**Violation:** \`boundary b { path: "x", out: push }\`.
**Fix:** Use one of the listed values.

### V166: Boundary Outbound Without Sandbox (warning)
\`outbound\` hosts are listed, but no sandbox block is generated (only a human with a go word turns it on), so they are not written to \`sandbox.network.allowedDomains\`. They are in \`boundaries.md\`. With a go word they are written to the sandbox's allow-list and this rule is silent.

### V167: Plugin Not Loaded (error)
EXPERIMENTAL. \`uses-plugins: [<id>, ...]\` names a plugin that this run did not load (plugins load only by \`--plugin <module>\` or the project package.json, never from the .at). Each top-level block no core section and no loaded plugin owns is reported as needing it, instead of V102; with no such block, the unloaded plugin is. Without \`uses-plugins\` an unknown block stays V102. See the plugins topic.

**Violation:** \`uses-plugins: [acme]\` and \`widget w1 { a: 1 }\`, run without the plugin: \`block widget needs plugin acme; run with --plugin acme\`.
**Fix:** Run with \`--plugin <module>\`, or list it in package.json \`agentopology.plugins\`.

### V168: OTLP Protocol (error)
\`observability { protocol }\` must be one of the values Claude Code documents for \`OTEL_EXPORTER_OTLP_PROTOCOL\`: \`http/json\`, \`http/protobuf\` or \`grpc\`.

**Violation:** \`observability { protocol: http/xml }\`
**Fix:** \`protocol: http/json\`

### V169: Stop Words (error)
Each of a human's stop words is a non-empty word on one line, no word is listed twice (case aside), none is the go word (compared without regard to case and surrounding punctuation), and none holds a character the stop reader cuts the first word at (a comma, a full stop, a quote ...), since it could never match. \`stop-from:\` takes the one value \`any\` and needs a \`stop-word:\`.

**Violation:** \`stop-word: [stop, Stop]\`, or \`stop-word: "stop, now"\`
**Fix:** \`stop-word: [stop, halt]\`

## Summary

| Rule | Severity | Name |
|------|----------|------|
| V1 | error | Unique Names |
| V2 | error | No Keyword Names |
| V3 | error | Flow Resolves |
| V4 | error | No Orphans |
| V5 | error | Outputs Exist |
| V6 | error | Bounded Loops |
| V7 | error | Model Required |
| V8 | error | Imports Resolve |
| V9 | error | Actions Handled |
| V10 | warning | Prompts Exist |
| V11 | error | Reads/Writes Consistent |
| V12 | error | Edge Attribute Order |
| V13 | error | Gate Placement |
| V14 | error | Tool Exclusivity |
| V15 | error | Exhaustive Conditions |
| V16 | error | API Key Env Vars |
| V17 | error | Single Default Provider |
| V18 | warning | Model in Provider |
| V19 | error | Unique Provider Names |
| V20 | error | Schedule Job References |
| V21 | error | Interface Secret Detection |
| V22 | warning | Fallback Chain Models |
| V23 | error/warning | Duplicate Sections |
| V24 | warning | Unknown Memory Sub-Blocks |
| V25 | warning | Bounce-Back Advisory |
| V26 | error | Action Kind Enum |
| V27 | warning | Agent Permissions Enum |
| V28 | error | Metering Format Enum |
| V29 | warning | Metering Pricing Enum |
| V87 | error | Orchestrator Delegation Enum |
| V134 | error/warning | Entry Agent |
| V135 | error | Refusing Gate No Hook Runs |
| V136 | warning | Scheduled Routing Action |
| V137 | warning | Observability Env Override |
| V138 | error/warning | Threat Model |
| V139 | error | Record Fields |
| V140 | warning | Records Not Written |
| V141 | error | Gate and Hook Tests |
| V142 | error | Gate Mode and Let-Go |
| V143 | error | Rules Block |
| V144 | error | Rule Citation |
| V145 | warning | Context Include Missing |
| V146 | warning | Context File Too Long |
| V147 | error | Island Owner |
| V148 | error | Requires Range |
| V149 | error | Finish Edge Target |
| V150 | error/warning | Outpoints |
| V151 | error/warning | Write Anchor |
| V152 | error | Meta Target |
| V153 | error | Secret Readers |
| V154 | error | Secret Path |
| V155 | error | CI Block |
| V156 | error/warning | Caps |
| V157 | error | Field Swallowed Into A Value |
| V158 | error | Record Daily Cap |
| V159 | error/warning | Output Into A Record |
| V160 | error | Stop Word |
| V161 | error | Wall Time |
| V162 | error | Egress |
| V163 | error | Never-reads And Ask-reads Overlap |
| V164 | error | Boundary Path |
| V165 | error | Boundary Values |
| V166 | warning | Boundary Outbound Without Sandbox |
| V167 | error | Plugin Not Loaded |
| V168 | error | OTLP Protocol |
| V169 | error | Stop Words |
`,
  },

  // -------------------------------------------------------------------------
  // 33. patterns
  // -------------------------------------------------------------------------
  patterns: {
    name: "patterns",
    description: "All 10 topology patterns with descriptions and examples",
    content: () => `# patterns

AgenTopology supports 10 built-in patterns. Patterns are declared in the topology header and document the system's coordination style.

## pipeline

**Description:** Linear sequence of agents, each feeding the next.
**When to use:** Sequential workflows where each step depends on the previous.

\`\`\`at
flow {
  intake -> researcher
  researcher -> writer
  writer -> reviewer
  reviewer -> done
}
\`\`\`

## supervisor

**Description:** A central agent oversees and delegates to worker agents.
**When to use:** When one agent needs to coordinate and review others' work.

\`\`\`at
flow {
  intake -> supervisor
  supervisor -> [worker-a, worker-b]
  worker-a -> supervisor
  worker-b -> supervisor
  supervisor -> done [max 3]
}
\`\`\`

## blackboard

**Description:** Agents read/write to a shared data store and react to changes.
**When to use:** Loosely coupled agents that collaborate through shared state.

\`\`\`at
flow {
  trigger -> [analyzer, monitor, updater]
  analyzer -> blackboard-sync
  monitor -> blackboard-sync
  updater -> blackboard-sync
  blackboard-sync -> done
}
\`\`\`

## orchestrator-worker

**Description:** An orchestrator generates plans and dispatches work to agents.
**When to use:** Complex workflows where a planner delegates specialized tasks.

\`\`\`at
flow {
  intake -> planner
  planner -> [coder, tester, documenter]
  coder -> review
  tester -> review
  documenter -> review
  review -> done
}
\`\`\`

## debate

**Description:** Multiple agents argue opposing positions to reach a conclusion.
**When to use:** Decision-making that benefits from adversarial reasoning.

\`\`\`at
flow {
  topic -> [advocate, critic]
  advocate -> judge
  critic -> judge
  judge -> advocate [when judge.verdict == continue, max 3]
  judge -> done     [when judge.verdict == resolved]
}
\`\`\`

## market-routing

**Description:** Incoming work is routed to the best-suited agent based on criteria.
**When to use:** Multi-domain systems where different agents handle different request types.

\`\`\`at
flow {
  intake -> router
  router -> specialist-a [when router.domain == legal]
  router -> specialist-b [when router.domain == technical]
  router -> specialist-c [when router.domain == financial]
  specialist-a -> done
  specialist-b -> done
  specialist-c -> done
}
\`\`\`

## consensus

**Description:** Multiple agents must agree before proceeding.
**When to use:** High-stakes decisions requiring agreement from multiple perspectives.

\`\`\`at
flow {
  proposal -> [reviewer-a, reviewer-b, reviewer-c]
  reviewer-a -> aggregator
  reviewer-b -> aggregator
  reviewer-c -> aggregator
  aggregator -> done
}
\`\`\`

## fan-out

**Description:** Work is split across parallel agents, then merged.
**When to use:** Independent subtasks that can run concurrently.

\`\`\`at
flow {
  intake -> [analyzer, scanner, checker]
  analyzer -> merger
  scanner -> merger
  checker -> merger
  merger -> done
}
\`\`\`

## event-driven

**Description:** Agents react to events rather than following a fixed flow.
**When to use:** Systems that respond to external signals, webhooks, or schedules.

\`\`\`at
flow {
  webhook-event -> dispatcher
  dispatcher -> handler-a [when dispatcher.type == deploy]
  dispatcher -> handler-b [when dispatcher.type == alert]
  handler-a -> done
  handler-b -> done
}
\`\`\`

## human-gate

**Description:** Human approval is required at one or more points in the flow.
**When to use:** Workflows that need human oversight before critical actions.

\`\`\`at
flow {
  draft -> review
  review -> human-approval
  human-approval -> publish [when human-approval.decision == approve]
  human-approval -> draft   [when human-approval.decision == revise, max 2]
}
\`\`\`

## Combining Patterns

Patterns are often combined. Declare multiple in the header:

\`\`\`at
topology code-review : [pipeline, fan-out, human-gate] {
  # ...
}
\`\`\`
`,
  },

  // -------------------------------------------------------------------------
  // 34. keywords
  // -------------------------------------------------------------------------
  keywords: {
    name: "keywords",
    description: "Complete keyword reference organized by category",
    content: () => `# keywords

Reserved keywords cannot be used as agent, action, or gate identifiers. They are organized into block keywords, field keywords, and wave keywords.

## Block Keywords (41)

These introduce grammar constructs:

\`\`\`
topology    library     import      from        use
agent       action      orchestrator meta       roles
memory      flow        gates       gate        depth
batch       environments triggers   command     event
level       hooks       hook        settings    mcp-servers
metering    tools       tool        scale       skill
context     env         extensions  providers   schedule
job         interfaces  defaults    schemas     schema
observability fragment  interface   params      threat-model
egress
\`\`\`

## Field Keywords (100+)

These are used as field names or enum values:

### Node & Agent Fields
\`\`\`
model       tools       disallowed-tools  reads     writes
outputs     skip        retry             isolation phase
kind        role        version           description
permissions prompt      generates         handles   argument
behavior    invocation  background        skills    sandbox
fallback-chain max-turns   max-lines   glossary
max-subagents max-cost output-into
\`\`\`

### Flow & Edge Fields
\`\`\`
when        max         parallel    per         manual
advisory    blocking    min         join        all
any         all-done    none-failed tolerance   race
wait        weight      error-handler
\`\`\`

### Scale Fields
\`\`\`
batch-size  batch-count doc-count   token-volume source-count
fixed       config
\`\`\`

### Metering Fields
\`\`\`
track       tokens-in   tokens-out  cost        wall-time
agent-count format      pricing     anthropic-current
custom      none        json        jsonl       csv
\`\`\`

### Gate Fields
\`\`\`
pass        fail        plan-gap    bounce-back halt
on-fail     after       before      run         checks
load-when
\`\`\`

### Permission Modes
\`\`\`
autonomous  supervised  interactive unrestricted
\`\`\`

### Memory Fields
\`\`\`
path        mode        files       routing     protocol
structure   blueprints  domains     references  external-docs
metrics     workspace   conflicts   detect      resolve
sequential-rebase source commands   append-only
\`\`\`

### Hook Events
\`\`\`
AgentStart    AgentStop       ToolUse           Error
SessionStart  SessionEnd      PreToolUse        PostToolUse
PostToolUseFailure SubagentStart SubagentStop   Stop
UserPromptSubmit   InstructionsLoaded           PermissionRequest
Notification  TeammateIdle    TaskCompleted     ConfigChange
PreCompact    WorktreeCreate  WorktreeRemove
\`\`\`

### Other Fields
\`\`\`
on          matcher     timeout     command     prompt
allow       deny        ask         http        stdio
sse         args        env         url         script
lang        bash        python      node        worktree
user        project     local       inherit
external    git         decision    inline      report
not         ticket      true        false
disable-model-invocation user-invocable allowed-tools
domain      fork        api-key     base-url    default
cron        every       enabled     webhook     channel
auth        port        docker      network-only
\`\`\`

### Pattern Keywords
\`\`\`
pipeline    supervisor  blackboard  orchestrator-worker
debate      market-routing consensus fan-out
event-driven human-gate
\`\`\`

## Wave 1: Error Handling, Model Config, Secrets
\`\`\`
backoff     interval    max-interval jitter
non-retryable exponential linear
temperature max-tokens  top-p       top-k       stop
seed        thinking    thinking-budget
off         low         medium      high
sensitive   log-level   debug       info        warn
error       output-format json-schema text
\`\`\`

## Wave 2: Flow Enhancements
\`\`\`
join        all         any         all-done    none-failed
tolerance   race        wait        weight      error-handler
\`\`\`

## Wave 3: Infrastructure
\`\`\`
input-schema output-schema array      of          optional
exporter    endpoint    service     sample-rate capture
prompts     completions tool-args   tool-results spans
agents      otlp        langsmith   datadog     stdout
secret      vault       op          awssm       ssm
gcpsm       azurekv
\`\`\`

## Wave 4: Composition
\`\`\`
as          with        include     entry       exit
sha256
\`\`\`

## Wave 5: Advanced Patterns
\`\`\`
circuit-breaker threshold window     cooldown
compensates    human     checkpoint  durable
\`\`\`

## Wave 7: Group Chat, Reflection, Rate Limiting
\`\`\`
group       members     speaker-selection max-rounds
termination round-robin random      reflection  rate-limit
\`\`\`

## Roadmap Reserved
\`\`\`
event
\`\`\`

## Not Reserved

These are free-form values and can be used as names:

\`\`\`
branch      render      supabase    target-branch
\`\`\`

Environment block field names, custom role names, and user-defined enum values are not reserved.
`,
  },

  // -------------------------------------------------------------------------
  // 35. examples
  // -------------------------------------------------------------------------
  examples: {
    name: "examples",
    description: "Full annotated .at examples -- pipeline, fan-out, advanced",
    content: () => `# examples

Complete, annotated AgenTopology examples demonstrating common patterns.

## Example 1: Simple 3-Agent Pipeline

A minimal content pipeline: research, write, review.

\`\`\`at
topology content-pipeline : [pipeline] {

  meta {
    version: "1.0.0"
    description: "Research, write, and review content"
  }

  # Orchestrator coordinates the flow
  orchestrator {
    model: sonnet
    handles: [start, finish]
  }

  # Entry and exit actions
  action start {
    kind: inline
    description: "Parse user request"
  }

  action finish {
    kind: report
    description: "Deliver final content"
  }

  # Three agents in sequence
  agent researcher {
    model: gpt-4o
    permissions: supervised
    phase: 1
    tools: [Read, Grep, WebSearch]
    writes: ["workspace/research.md"]
    prompt {
      Research the given topic thoroughly.
      Compile findings with citations.
    }
  }

  agent writer {
    model: sonnet
    permissions: autonomous
    phase: 2
    tools: [Read, Write]
    reads: ["workspace/research.md"]
    writes: ["workspace/draft.md"]
    prompt {
      Write a polished draft based on the research.
    }
  }

  agent reviewer {
    model: opus
    permissions: supervised
    phase: 3
    tools: [Read]
    reads: ["workspace/draft.md"]
    outputs: {
      verdict: approve | revise
    }
    prompt {
      Review the draft for accuracy and clarity.
    }
  }

  # Linear flow with one revision loop
  flow {
    start -> researcher
    researcher -> writer
    writer -> reviewer
    reviewer -> writer  [when reviewer.verdict == revise, max 2]
    reviewer -> finish  [when reviewer.verdict == approve]
  }

  memory {
    workspace {
      path: "workspace/"
      structure: [research, drafts]
    }
  }
}
\`\`\`

## Example 2: Fan-Out with Conditional Edges

Parallel analysis agents feeding into a reviewer with conditional routing.

\`\`\`at
topology code-review : [fan-out, human-gate] {

  meta {
    version: "1.0.0"
    description: "Parallel code analysis with conditional review"
  }

  orchestrator {
    model: opus
    handles: [intake, done]
  }

  action intake {
    kind: external
    source: "github-pr"
    description: "Fetch PR diff"
  }

  action done {
    kind: report
    description: "Post review results"
  }

  # Parallel analyzers (phase 1)
  agent static-analyzer {
    model: sonnet
    permissions: autonomous
    phase: 1
    tools: [Read, Grep, Glob]
    writes: ["workspace/static-analysis.md"]
    outputs: {
      risk: low | medium | high
    }
    prompt {
      Analyze code complexity and dependencies.
    }
  }

  agent security-scanner {
    model: sonnet
    permissions: autonomous
    phase: 1
    tools: [Read, Grep]
    writes: ["workspace/security.md"]
    behavior: advisory
    outputs: {
      has-issues: yes | no
    }
    prompt {
      Scan for security vulnerabilities.
    }
  }

  # Reviewer combines results (phase 2)
  agent reviewer {
    model: opus
    permissions: supervised
    phase: 2
    tools: [Read, Grep]
    reads: ["workspace/static-analysis.md", "workspace/security.md"]
    outputs: {
      verdict: approve | request-changes | reject
    }
    prompt {
      Review all findings and make a final decision.
    }
  }

  flow {
    # Fan-out to parallel analyzers
    intake -> [static-analyzer, security-scanner]

    # Both feed into reviewer
    static-analyzer -> reviewer
    security-scanner -> reviewer

    # Conditional routing based on verdict
    reviewer -> done    [when reviewer.verdict == approve]
    reviewer -> done    [when reviewer.verdict == request-changes]
    reviewer -> done    [when reviewer.verdict == reject]
  }

  gates {
    gate human-check {
      after: reviewer
      before: done
      run: "scripts/human-approve.sh"
      on-fail: halt
    }
  }
}
\`\`\`

## Example 3: Advanced Topology

Demonstrates hooks, gates, metering, scale, providers, and MCP servers.

\`\`\`at
topology data-pipeline : [pipeline, fan-out] {

  meta {
    version: "2.0.0"
    description: "Production data processing pipeline"
    domain: data-engineering
    timeout: "4h"
    durable: true
  }

  providers {
    anthropic {
      api-key: "\${ANTHROPIC_API_KEY}"
      models: [opus, sonnet, haiku]
      default: true
    }
  }

  defaults {
    temperature: 0.3
    max-tokens: 8192
    thinking: medium
    log-level: info
  }

  orchestrator {
    model: opus
    handles: [ingest, deliver]
  }

  action ingest {
    kind: external
    source: "s3"
    description: "Pull documents from S3"
    timeout: "5m"
  }

  action deliver {
    kind: report
    description: "Upload results"
  }

  agent extractor {
    model: sonnet
    permissions: autonomous
    phase: 1
    tools: [Read, Write, extract-pdf]
    writes: ["workspace/extracted/"]
    background: true
    retry {
      max: 3
      backoff: exponential
      interval: "5s"
    }
    scale {
      mode: auto
      by: doc-count
      min: 2
      max: 10
      batch-size: 25
    }
  }

  agent classifier {
    model: haiku
    permissions: autonomous
    phase: 2
    tools: [Read, Write]
    reads: ["workspace/extracted/"]
    writes: ["workspace/classified/"]
    rate-limit: "100/min"
  }

  agent synthesizer {
    model: opus
    permissions: autonomous
    phase: 3
    tools: [Read, Write]
    reads: ["workspace/classified/"]
    writes: ["workspace/output.json"]
    timeout: "30m"
    on-fail: retry
    outputs: {
      quality: complete | partial | failed
    }
  }

  flow {
    ingest -> extractor
    extractor -> classifier
    classifier -> synthesizer
    synthesizer -> deliver    [when synthesizer.quality == complete]
    synthesizer -> deliver    [when synthesizer.quality == partial]
    synthesizer -> extractor  [when synthesizer.quality == failed, max 2]
  }

  gates {
    gate quality-gate {
      after: classifier
      before: synthesizer
      run: "scripts/validate.sh"
      checks: [completeness, schema]
      retry: 1
      on-fail: bounce-back
    }
  }

  tools {
    tool extract-pdf {
      script: "scripts/extract-pdf.py"
      args: [input, output]
      lang: python
      description: "Extract text from PDFs"
    }
  }

  mcp-servers {
    storage {
      type: stdio
      command: "npx"
      args: ["-y", "storage-server"]
    }
  }

  hooks {
    hook track-cost {
      on: AgentStop
      run: "scripts/track-cost.sh"
      type: command
    }

    hook block-delete {
      on: PreToolUse
      matcher: "Bash(rm *)"
      run: "exit 1"
      type: command
    }
  }

  metering {
    track: [tokens-in, tokens-out, cost, wall-time]
    per: [agent, run, phase]
    output: "metrics/"
    format: jsonl
    pricing: anthropic-current
  }

  checkpoint {
    backend: "redis"
    connection: "\${REDIS_URL}"
    strategy: "after-each-agent"
    ttl: "7d"
    replay {
      enabled: true
      max-history: 50
    }
  }

  memory {
    workspace {
      path: "workspace/"
      structure: [extracted, classified, output]
    }
  }

  settings {
    allow: ["Read", "Write", "Glob", "Grep"]
    deny: ["Bash(rm -rf *)"]
  }
}
\`\`\`
`,
  },

  // -------------------------------------------------------------------------
  // 36. bindings
  // -------------------------------------------------------------------------
  bindings: {
    name: "bindings",
    description: "All binding targets and what they generate",
    content: () => `# bindings

AgenTopology compiles to platform files via bindings. Claude Code is the supported target; the others are experimental. Each binding reads the parsed AST and generates platform-specific configuration files.

## Available Bindings

### claude-code

**Target:** Anthropic Claude Code CLI
**Generates:** \`AGENTS.md\`, \`.claude/settings.json\`, \`.claude/commands/\`, hook scripts
**Description:** Full-featured binding for Claude Code multi-agent workflows. Generates agent markdown files with prompts, tool permissions, and coordination instructions. Supports hooks, gates (as positioned hooks), triggers (as slash commands), and MCP server configuration.

### codex

**Target:** OpenAI Codex CLI
**Generates:** \`codex.yaml\`, agent configuration files
**Description:** Generates Codex CLI configuration for OpenAI-powered agent workflows. Maps AgenTopology permissions to Codex approval modes (suggest, auto-edit, full-auto).

### Experimental

\`codex\`, \`cursor\` and \`claude-workflow\` are kept but experimental: they are not verified against their platform the way \`claude-code\` is. \`gemini-cli\`, \`copilot-cli\`, \`openclaw\` and \`kiro\` were removed in 0.10.0; use agentopology 0.9.x for them.

## Usage

\`\`\`bash
# Scaffold a project for a specific binding
npx agentopology scaffold --target claude-code topology.at

# List available targets
npx agentopology targets
\`\`\`

## Notes

- All bindings read the same .at file -- write once, deploy to any platform.
- Bindings use the \`extensions\` block for platform-specific configuration that doesn't fit the universal model.
- Unknown extension namespaces are silently ignored, so a single .at file can target multiple platforms.
`,
  },
  // -------------------------------------------------------------------------
  // interpreted-mode
  // -------------------------------------------------------------------------
  "interpreted-mode": {
    name: "interpreted-mode",
    description: "Run a topology directly, with no scaffolded files",
    content: () => `# interpreted-mode

A \`.at\` file has two lifecycles, and they are the same declaration with two
execution backends.

| | \`scaffold\` | \`plan\` |
|---|---|---|
| Who executes | the platform, later | this session's coding agent, now |
| On disk | \`.claude/\`, \`.codex/\`, ... | nothing |
| Lifetime | outlives the session | dies with it |
| Portable | 8 targets | wherever the host agent runs |
| Gates | real hooks, mechanically enforced | evidence contract |
| Cost to change | regenerate and reconcile | free |

Not a strategy choice. A lifetime choice.

## The command

\`\`\`bash
agentopology plan <file>.at --mode plan|execute|auto [--brief] [--log <path>]
\`\`\`

**A CLI cannot spawn subagents**, so \`plan\` does not run anything. It is a
linter and an orderer: it validates the topology (the agent that wrote the file
can write an illegal one), applies the spec's defaults, resolves execution
order, and emits a brief that a host coding agent follows.

It prints two things: an ASCII flow graph for you, then the brief for the agent.
\`--brief\` prints only the brief.

## The autonomy notch

One knob, governing two moments — before the run, and when the plan changes
mid-run.

| notch | before the run | mid-run rewrite |
|---|---|---|
| \`plan\` | show the render, wait for a word | show the diff, wait |
| \`execute\` *(default)* | run | announce, keep going |
| \`auto\` | run | silent, report at the end |

A topology can carry its own default without any grammar change, since
\`extensions\` is untyped passthrough:

\`\`\`at
extensions {
  interpreted { autonomy: execute }
}
\`\`\`

The invocation flag always wins.

## What interpreted mode cannot do

Five features are platform **registrations**, not steps in a run. They cannot
work without files on any vendor:

| ⛔ needs \`scaffold\` |
|---|
| \`triggers\` / slash commands |
| \`schedules\` / cron |
| \`mcp-servers\` |
| \`hooks\` |
| per-agent \`tools\` / \`permissions\` |

The last one is the constraint that shapes everything: a subagent's tool grant
cannot be set at runtime. So ephemeral is a spectrum **per role**, not a mode
per topology. \`plan\` names every role that loses a restriction rather than
pretending it applied.

## Gates without hooks

Four tiers. Interpreted mode reaches only the last.

| tier | mechanism | portable | fileless |
|---|---|---|---|
| preventive | tool allowlist | all | needs a file |
| enforced verify | hook, exit code 2 | 3 of 4 vendors | needs a file |
| fileless verify | Workflow script | Claude Code only | yes |
| **evidence contract** | the check's exit code is reported and inspected | all | yes |

An evidence contract does not *stop* a skip. It makes a skip **loud** — the exit
code is missing rather than fabricated. For a deterministic check, loud is close
to stopped and costs zero platform features.

If a gate must be unskippable, that topology wants \`scaffold\`.

## The ambiguity log

\`--log <path>\` records every place the host had to guess what to pass between
roles: session scratchpad only, one JSON object per line. Six kinds are detected
statically and pre-filled by \`plan\`, each carrying a concrete \`.at\` edit that
would remove the guess.

That \`fix\` field is the point. With it the log is a patch queue for the source
topology. Without it, a diary.

## See also

\`\`\`bash
agentopology plan examples/code-review.at          # try it
agentopology docs flow                             # the control graph
agentopology docs gate                             # gates and enforcement
\`\`\`
`,
  },
  // -------------------------------------------------------------------------
  // plugins
  // -------------------------------------------------------------------------
  plugins: {
    name: "plugins",
    description: "Compile-time plugins: extra blocks, rules and scaffold output (EXPERIMENTAL)",
    content: () => `# plugins

**EXPERIMENTAL: may change before 1.0.**

A plugin is a JavaScript module that adds top-level blocks to the language,
checks them, and adds files and hooks to a target's scaffold.

## Security

A plugin is code that runs with your rights at compile time. Load only plugins
you trust. Every load is printed, on stderr:

\`\`\`
loaded plugin <id>@<version> from <path>
\`\`\`

## Loading

Only two things load a plugin, and an \`.at\` file is neither:

- the repeatable CLI flag \`--plugin <module>\`, on validate, fix, scaffold,
  sync, visualize, export, plan, info and guard;
- \`"agentopology": { "plugins": ["<module>", ...] }\` in the package.json of
  the project folder: \`--dir\` when given, else the folder you run the
  command in. Never the folder of the \`.at\`: naming an \`.at\` in a folder
  you cloned does not run the plugins its package.json lists.

\`--no-plugins\` loads no plugin at all, neither \`--plugin\` nor the
package.json list, on every command. A gate \`before: write "**/*.at"\`
reads an agentopology call on a \`.at\` as a read only with it.

\`<module>\` is an explicit path (\`./x.mjs\`, \`../x.mjs\` or an absolute path;
a single bundled file needs no package.json), loaded from where it is, or a
package name, resolved from the project folder. A package name that resolves
outside node_modules and the project is refused. A plugin written for an
\`apiVersion\` other than 1 is an error.

## uses-plugins

\`\`\`at
topology t : [pipeline] {
  uses-plugins: [acme]
  widget w1 { a: "one" }
  ...
}
\`\`\`

\`uses-plugins\` is a check only; it never loads code. When a plugin it names
is not loaded, V167 is an error: \`block widget needs plugin acme; run with
--plugin acme\` for each block no loaded plugin owns, or \`uses-plugins names
plugin acme, which is not loaded\` when there is none. Without
\`uses-plugins\`, an unknown block is V102, as always.

## Rules

A plugin's findings carry namespaced rule ids, \`<id>/<name>\` (letters, digits
and \`-\`), such as \`acme/widget-needs-a\`. Any other rule id is an error that
names the plugin.

## The API (\`agentopology/plugins\`)

\`\`\`ts
import type { AtPlugin } from "agentopology/plugins";

const plugin: AtPlugin = {
  id: "acme",
  version: "1.0.0",            // optional; printed when it loads
  apiVersion: 1,
  blocks: {
    // keyword -> { multiplicity: "single" | "repeated", fields?, parse?(body, ctx) }
    widget: { multiplicity: "repeated", fields: ["a", "b"] },
  },
  // data: Record<block, unknown[]>; view: the topology's name and frozen nodes
  validate(data, view, ctx) { return []; },
  scaffold: {
    "claude-code": (data, view) => ({
      files: [],          // { path, content, executable? }
      settingsHooks: {},  // event -> settings.json hook entries
      gateRuns: {},       // gate id -> check command
    }),
  },
};
export default plugin;
\`\`\`

- A block with \`fields\` reports any other name inside it as V102. Without
  \`parse\`, a block's data is \`{ id?, ...fields }\`. \`parse(body, ctx)\` gets
  \`ctx.line(at)\` and \`ctx.id\`, the name after the keyword (absent when none).
- \`view\` is a frozen copy: \`name\`, \`nodes\` (each with \`type\`), \`records\`
  (id, path), \`persons\` and \`skills\`; nodes and skills carry their
  \`extensions\`, so a plugin reads \`extensions { <id> { … } }\` on either.
- \`gateRuns\` sets the check of a gate that carries \`extensions { <id> { } }\`
  and has no \`run:\`. It is wired through the gate wiring a \`run:\` gets, so
  V135 and \`guard --check\` see it. The check runs with \`AT_TOOL\` set to the
  matcher of the hook that runs the gate, the tools the guarded call is one
  of: \`Bash|Monitor|PowerShell\` before a script step, \`Agent|Task\` before a
  subagent launch, empty after a subagent stops (a stop, not a tool call).
- \`settingsHooks\` entries are checked against the Claude Code hook contract.

These are errors that name the plugin: a block keyword that is a core section;
a file path or a hook the core scaffold writes; a rule id outside the plugin's
namespace.

## Commands and report rows

\`\`\`ts
const plugin: AtPlugin = {
  id: "acme",
  apiVersion: 1,
  blocks: {},
  commands: {
    // agentopology acme:hello a b   ->   args = ["a", "b"]
    hello: (args, ctx) => { console.log("hi", args, ctx.projectDir); return 0; },
  },
  guardReport: (data, view, ctx) => ["widgets: 2"],
};
\`\`\`

- A command runs as \`agentopology <pluginId>:<name> [args...]\`, with the plugin
  loaded (\`--plugin <module>\`, or the project's package.json). The name is a
  lower-case word. The colon keeps it apart from the core commands: a plugin
  command never replaces one. It returns the exit code, a whole number from 0 to
  255; anything else is an error. \`ctx\` has \`pluginId\`, \`cwd\` and \`projectDir\`
  (\`--dir\`, else \`cwd\`).
- \`guardReport\` rows are printed by \`guard --check\` after the core's rows, one
  line each: \`plugin <id> claimed: <row>\`. They are what the plugin claims, not
  what the core checked: they are never counted in the core's enforcement
  total, and the exit code stays the core's. A \`guardReport\` that throws prints
  one row that says so.

## The refusal event (read-only)

A plugin may read what the guards refused. Only the core writes it. It is on
when the topology says \`meta { refusal-events: true }\`, or when a loaded
plugin declares \`reads: ["refusals"]\`. Then every generated claude-code guard
script that refuses adds one JSON line to
\`.claude/agentopology/events/refusals.jsonl\`, just before its exit 2:

\`\`\`
{"v":1,"ts":"2026-01-01T00:00:00Z","guard":"before-action.sh","gate":"accept-ready","rule":null,"tool":"Bash","reason":"a gate refused the call"}
\`\`\`

\`\`\`ts
import type { RefusalEvent } from "agentopology/plugins";   // read-only, EXPERIMENTAL
\`\`\`

- \`gate\` and \`rule\` are null when the guard does not know them. \`reason\` is a
  short fixed label. It never holds the refused command's text, and never the
  tool's input.
- A guard that another guard runs (a gate's wrapper) writes nothing: the guard
  that ran it writes the one line.
- A failed append (the folder cannot be made, the disk is full) changes
  nothing: the script still exits 2. The refusal is never turned into a pass.
- The before-edit guard refuses the Edit, Write, MultiEdit and NotebookEdit
  tools on the file.
- Without the opt-in, every generated file is byte for byte what it was.
`,
  },
};