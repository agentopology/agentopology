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
| durable | boolean | no | false | Enable durable execution (requires checkpoint block) |

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
| maxTurns | number | no | -- | Max agentic turns before stopping |
| sandbox | string or boolean | no | -- | "docker", "none", "network-only", true, false |
| skip | string | no | -- | Skip condition: "not identifier" or "identifier.identifier op value" |

### Prompt & Output

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| prompt | string | no (V10) | -- | Multi-line via \`prompt {}\` block or file path string |
| outputs | OutputsMap | no | -- | Enum outputs: \`{ field: val1 \\| val2 }\` (V5) |
| outputFormat | string | no | "text" | "text", "json", "json-schema" |
| inputSchema | SchemaFieldDef[] | no | -- | Typed input schema fields |
| outputSchema | SchemaFieldDef[] | no | -- | Typed output schema fields |

### Tools & Data

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| tools | string[] | no | -- | Allowed tools (supports wildcards like \`mcp.server.*\`) |
| disallowedTools | string[] | no | -- | Denied tools (mutually exclusive with tools -- V14) |
| skills | string[] | no | -- | Skill IDs this agent can use |
| reads | string[] | no | -- | Memory keys this agent reads (V11) |
| writes | string[] | no | -- | Memory keys this agent writes (V11) |
| mcpServers | string[] | no | -- | MCP server names this agent uses |
| produces | string[] | no | -- | Artifact IDs this agent produces |
| consumes | string[] | no | -- | Artifact IDs this agent consumes |

### Behavior & Flow

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| behavior | string | no | -- | "advisory" or "blocking" |
| join | string | no | -- | Fan-in: "all", "any", "all-done", "none-failed" |
| onFail | string | no | -- | "halt", "retry", "skip", "continue", "fallback <agent-id>" |
| timeout | string | no | -- | Duration: "5m", "2h" |
| fallbackChain | string[] | no | -- | Ordered model IDs to try (V22) |
| compensates | string | no | -- | Agent ID (saga pattern compensation) |

### Retry & Resilience

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| retry | number or RetryConfig | no | -- | Simple count or structured config |
| circuitBreaker | CircuitBreakerConfig | no | -- | \`{ threshold, window, cooldown }\` |
| rateLimit | string | no | -- | "60/min", "1000/hour", "5/sec" |

### Sampling Parameters

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| temperature | number | no | -- | Sampling temperature (0-2) |
| maxTokens | number | no | -- | Max tokens to generate |
| topP | number | no | -- | Nucleus sampling (0-1) |
| topK | number | no | -- | Top-k sampling |
| stop | string[] | no | -- | Stop sequences |
| seed | number | no | -- | Random seed for reproducibility |
| thinking | string | no | -- | "off", "low", "medium", "high", "max" |
| thinkingBudget | number | no | -- | Token budget for reasoning (min 1000) |

### Observability

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| logLevel | string | no | -- | "debug", "info", "warn", "error" |

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

| Long form | Short form | Description |
|-----------|------------|-------------|
| autonomous | auto | Agent acts without human approval |
| supervised | plan | Agent presents a plan, then executes after approval |
| interactive | confirm | Agent asks for confirmation on each action |
| unrestricted | bypass | No safety checks (use with caution) |

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
| commands | string[] | no | -- | Shell commands to execute |
| timeout | string | no | -- | Duration string (e.g. "5m", "2h") |
| on-fail | string | no | -- | "halt", "retry", "skip", "continue", "fallback <agent-id>" |
| join | string | no | -- | Fan-in: "all", "any", "all-done", "none-failed" |

## Action Kinds

| Kind | Description |
|------|-------------|
| external | External API call or service invocation |
| git | Git operation (commit, branch, PR) |
| decision | Routing decision point |
| inline | Inline logic, no external side effects |
| report | Compile and deliver output |

## Validation Rules

- **V26**: \`kind\` must be one of: external, git, decision, inline, report
- **V9**: Actions in the flow must be listed in the orchestrator's \`handles\`

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

## Validation Rules

- **V13**: \`after\` and \`before\` must reference declared nodes
- **V25**: \`on-fail: bounce-back\` is advisory on CLI platforms (warning)

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
| per | \`[per agent-id]\` | Scoping per agent instance |
| tolerance | \`[tolerance N]\` or \`[tolerance "33%"]\` | Fan-out failure tolerance |
| race | \`[race]\` | First-to-finish wins |
| wait | \`[wait 30s]\` | Timer delay before edge fires |
| weight | \`[weight 0.7]\` | Routing probability (0-1) |
| reflection | \`[reflection]\` | Marks an evaluator/reflection loop |

Multiple attributes can be combined:

\`\`\`at
reviewer -> writer [when reviewer.verdict == revise, max 3]
\`\`\`

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
    description: "Memory block -- workspace, domains, references, metrics",
    content: () => `# memory

The \`memory\` block declares the shared data layer for the topology. It defines where agents read and write data.

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

## Validation Rules

- **V11**: Agent \`reads\` and \`writes\` must be consistent with flow order
- **V24**: Only known sub-block names are expected (warning)

## Notes

- Memory paths are relative to the topology's root directory.
- Agents declare which memory keys they access via \`reads\` and \`writes\` fields.
- The workspace structure is informational -- it documents expected folders but does not create them.
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
    timeout: 5000
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
| matcher | string | no | -- | Pattern to match against event payload |
| run | string | yes | -- | Command or script to execute |
| type | string | no | -- | "command" or "prompt" |
| timeout | number | no | -- | Timeout in milliseconds |
| extensions | Record | no | -- | Binding-specific fields |

## Events (23 total)

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

## Example

\`\`\`at
hooks {
  hook block-dangerous-tools {
    on: PreToolUse
    matcher: "Bash(rm -rf *)"
    run: "exit 1"
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

- \`type: command\` runs a shell command; \`type: prompt\` injects text into the agent's context.
- The \`matcher\` field filters events by payload pattern (e.g. tool name for ToolUse events).
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

The \`tools\` block defines custom tools implemented as scripts that agents can invoke.

## Syntax

\`\`\`at
tools {
  tool NAME {
    script: "path/to/script.py"
    args: [arg1, arg2]
    lang: python
    description: "What this tool does"
  }
}
\`\`\`

## Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| id | identifier | yes | -- | Tool identifier (the NAME) |
| script | string | yes | -- | Path to the implementing script |
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
    script: "scripts/run-tests.sh"
    lang: bash
    description: "Run the test suite and return results"
  }
}
\`\`\`

## Notes

- Custom tools are referenced by name in agent \`tools\` lists.
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
# Topology-level
extensions {
  claude-code {
    project-type: "monorepo"
  }
}

# Agent-level
agent reviewer {
  model: opus
  extensions {
    claude-code {
      worktree-base: "reviews/"
    }
  }
}
\`\`\`

## Notes

- Unknown binding namespaces are silently ignored. This allows a single .at file to target multiple platforms.
- Extension fields are free-form key-value pairs -- they are not validated by the parser.
- Each binding defines its own set of recognized extension fields.
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
| service | string | no | -- | Service name for trace attribution |
| sample-rate | number | no | 1.0 | Sampling rate (0-1) |

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

## Validation Rules

- **V20**: \`cron\` and \`every\` are mutually exclusive -- use one or the other
- **V20**: Job must reference a declared agent or action node

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
  NAME {
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
  research-notes {
    type: "markdown"
    path: "workspace/research/"
    retention: "90d"
  }

  draft {
    type: "markdown"
    path: "workspace/drafts/"
    retention: "30d"
    depends-on: [research-notes]
  }

  final-report {
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
    description: "All 29 validation rules with descriptions and fixes",
    content: () => `# validation

AgenTopology enforces 29 validation rules during parsing. Errors prevent compilation; warnings are informational.

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
Every agent must appear in at least one flow edge, or have \`invocation: manual\`.

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

### V23: Duplicate Sections (warning)
Singleton sections (meta, memory, flow, etc.) should appear at most once.

**Violation:** Two \`flow {}\` blocks.
**Fix:** Merge into a single block.

### V24: Unknown Memory Sub-Blocks (warning)
Memory sub-blocks should be known names (workspace, domains, references, external-docs, metrics).

**Violation:** \`memory { custom-block { ... } }\`.
**Fix:** Use a recognized sub-block name or move to extensions.

### V25: Bounce-Back Advisory (warning)
\`on-fail: bounce-back\` is advisory on CLI platforms -- enforcement varies by binding.

**Violation:** None (this is informational).
**Fix:** Be aware that bounce-back may not be enforced on all platforms.

### V26: Action Kind Enum (error)
Action \`kind\` must be: external, git, decision, inline, or report.

**Violation:** \`kind: custom\`.
**Fix:** Use a recognized kind value.

### V27: Agent Permissions Enum (warning)
Agent \`permissions\` should be a recognized mode: autonomous/auto, supervised/plan, interactive/confirm, unrestricted/bypass.

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
| V23 | warning | Duplicate Sections |
| V24 | warning | Unknown Memory Sub-Blocks |
| V25 | warning | Bounce-Back Advisory |
| V26 | error | Action Kind Enum |
| V27 | warning | Agent Permissions Enum |
| V28 | error | Metering Format Enum |
| V29 | warning | Metering Pricing Enum |
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

## Block Keywords (40)

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
observability fragment  interface   params
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
fallback-chain max-turns
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

AgenTopology compiles to multiple target platforms via bindings. Each binding reads the parsed AST and generates platform-specific configuration files.

## Available Bindings

### claude-code

**Target:** Anthropic Claude Code CLI
**Generates:** \`AGENTS.md\`, \`.claude/settings.json\`, \`.claude/commands/\`, hook scripts
**Description:** Full-featured binding for Claude Code multi-agent workflows. Generates agent markdown files with prompts, tool permissions, and coordination instructions. Supports hooks, gates (as positioned hooks), triggers (as slash commands), and MCP server configuration.

### codex

**Target:** OpenAI Codex CLI
**Generates:** \`codex.yaml\`, agent configuration files
**Description:** Generates Codex CLI configuration for OpenAI-powered agent workflows. Maps AgenTopology permissions to Codex approval modes (suggest, auto-edit, full-auto).

### gemini-cli

**Target:** Google Gemini CLI
**Generates:** \`.gemini/\` configuration directory, agent files
**Description:** Generates Gemini CLI configuration. Maps tools to Gemini function declarations and supports Gemini-specific model identifiers.

### copilot-cli

**Target:** GitHub Copilot CLI
**Generates:** \`.github/copilot/\` configuration
**Description:** Generates GitHub Copilot CLI agent configuration. Maps AgenTopology concepts to Copilot's instruction and tool systems.

### openclaw

**Target:** OpenClaw framework
**Generates:** OpenClaw project configuration
**Description:** Generates configuration for the OpenClaw multi-agent framework. Supports OpenClaw's native agent orchestration model.

### kiro

**Target:** Anthropic Kiro
**Generates:** \`.kiro/\` configuration directory with specs
**Description:** Generates Kiro project configuration. Maps agents to Kiro specs with steering prompts and tool configurations.

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
};
