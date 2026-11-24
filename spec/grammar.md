# AgenTopology Language Specification v1.0

Created by Nadav Naveh

**Extension:** `.at`
**Language:** AgenTopology

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

Everything after `#` until end-of-line is ignored, braces included: a `{` or `}` in a comment never opens or closes a block. A `#` starts a comment at the start of a line or after whitespace, outside a quoted string and outside a `prompt { }` block (there it is text, such as a Markdown heading); a `#` inside a word, as in a URL fragment, is not a comment.

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

**Rule: one field per line.** Key-value fields are newline-separated. Writing two
on one line makes the first key take the rest of the line as its value:

```
# WRONG — `model` becomes the string "sonnet retry: 3"
agent a { model: sonnet retry: 3 }

# RIGHT
agent a {
  model: sonnet
  retry: 3
}
```

This is not a parser limitation to route around — some unquoted values are
legitimately multi-token (`on-fail: fallback reviewer`), so whitespace could not
separate fields without ambiguity. V90 rejects the collapsed form, in `meta` and in every node block.

A comma does separate fields: `checkpoint { backend: sqlite, strategy: every-node, ttl: 7d }`
reads the same as the three-line form. A comma separates only at the top level of
the block and only before a `key:`; a comma inside `[..]`, `{..}`, `(..)` or quotes
stays part of the value. V157 refuses a value in `checkpoint`, `interface`,
`defaults`, `observability` or `metering` that still holds `, <field>:`.

**Exception:** free-prose fields (`description`, `role`, `generates`,
`termination`) are exempt once their quotes have been stripped by the parser,
because a colon in English is ordinary — `description: "Demo: agent pipeline"`.
Where quotes survive parsing the check is still sharp: one well-formed quoted
token followed by more content means a field was eaten.

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

A quoted list item is one item whatever it holds: `[`, `]` and `,` inside
quotes are text (`deny: ["Bash(rm [a-z]*)", "Read(./.env)"]`). Outside quotes,
brackets nest, so `[Bash(rm [a-z]*), Read]` is two items. A list may span
lines. A list whose `]` never comes, a quoted item not closed on its line, or
text after the closing `]` that is not another `key:` field is a parse error:
part of a list is never kept. Text inside a `prompt { }` block or a quoted
string is prose and is never checked as a list; when a field and prose both
hold a key, the field is read.

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
| `fragment` | A part merged into a topology by `include` (§4.3a) | `blocks/brain.at` |

### 3.1 Path Resolution

All string paths in `.at` files are **relative to the output directory** scaffolded from the topology. The exact output structure depends on the binding (see Section 11: Bindings).

| `.at` field | Example value | Resolves to |
|-------------|---------------|-------------|
| `tools.tool.script` | `"scripts/ocr-pipeline.sh"` | `<output-dir>/scripts/ocr-pipeline.sh` |
| `gates.gate.run` | `"scripts/validate.sh"` | `<output-dir>/scripts/validate.sh` |
| `hooks.hook.run` | `"scripts/emit-event.sh"` | `<output-dir>/scripts/emit-event.sh` |
| `agent.prompt` | `prompt { ... }` | Inline content (not a file path) |
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
                 | hooks | settings | mcp-servers | metering | tools | context | env
                 | schedule | interfaces | inventory | needs | threat-model | egress | islands
```

**Ordering:** Sections may appear in any order. Each of `meta`, `orchestrator`, `roles`, `memory`, `flow`, `gates`, `depth`, `batch`, `environments`, `triggers`, `settings`, `mcp-servers`, `metering`, `tools`, `context`, `env`, `schedule`, `interfaces`, `inventory`, `needs`, `threat-model`, and `islands` (and the other sections listed in `src/parser/sections.ts`) may appear **at most once**: a second copy is a V23 warning and only the first is used. `hooks` may appear more than once: every block's hooks are used, in file order; a hook name used in two blocks is a V23 error. `action`, `agent`, `skill-decl`, and `use-stmt` may appear multiple times.

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
                  | 'behavior' ':' ('advisory' | 'blocking')
                  | 'description' ':' string)*
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

> **Note for binding authors:** Bindings may alias these to platform-specific terms. For example, the Claude Code binding writes no `permissionMode` for `autonomous` (the session's own mode) and `plan` for `supervised`. Short aliases (`plan`, `confirm`, `bypass`) are also accepted by the parser for backward compatibility. `auto` is not a short form of `autonomous`: it is Claude Code's auto mode (a classifier approves actions without asking), compiles to `permissionMode: auto`, and validation warns (V132).

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
| `brain` | Agent-maintained, Obsidian-portable markdown knowledge graph |

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

### 4.3a `include` and `fragment`

```ebnf
include         = 'include' string
fragment        = 'fragment' identifier? '{' topology-body '}'
```

```agenttopology
# blocks/brain.at
fragment {
  hooks {
    hook header-gate {
      on: PreToolUse
      matcher: "Edit|Write"
      run: "bash tools/knowledge/header-gate.sh"
      strength: refuse
    }
  }
}

# main.at
topology my-team : [pipeline] {
  include "./blocks/brain.at"
  agent builder { model: sonnet }
}
```

`include` merges a fragment file into the topology. The path is read relative to the file that writes the include (a fragment may include another). The name after `fragment` is optional.

**What is merged:** nodes (agents, actions, gates, ...), flow edges, `hooks`, `triggers`, skills, tools, schedules, `schemas`, `artifacts`, `records`, stores, retrievals, providers, interfaces, `machines`, persons, `mcp-servers`, `env`, roles, `decisions` and inventory roots. `validate`, `scaffold`, `guard --check`, `plan` and `export` all see the merged topology. Paths the fragment writes (a hook's `run:`, ...) are project paths, as in §3.1, not relative to the fragment.

**What is refused (V8 error):** a section with one value per topology (`settings`, `defaults`, `depth`, `memory`, `batch`, `environments`, `metering`, `observability`, `checkpoint`, `context`, `extensions`, `params`, `interface`, `needs`, `pin-models`, and `meta` fields other than `version` and `description`) and `import` inside a fragment; the error names the section and the fragment. Write these in the including file. A name declared both by the including file and by a fragment, or by two fragments, is a V8 error naming both files, never an override. A missing file, a parse error, an include cycle and an included `topology` (not a `fragment`) are V8 errors too. A fragment reached by two includes is merged once.

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
| `domain` | identifier | no | -- |
| `entry` | agent-id | no | -- |
| `outpoints` | node-id list | no | -- |
| `target` | path | no | the project root |

**`outpoints`** -- `outpoints: [builder, checker]` lists the nodes a run may end at. Each must be a declared node (V150 error). Once the list is written, a flow node with no outgoing edge that is not on it warns (V150). With no `outpoints`, nothing is checked. claude-code compiles a `[finish]` edge into the generated flow text (`[finish]` on the edge, plus a line saying the edge closes the run and hands back to the entry agent); when the topology declares a `records` entry, that line also tells the step before the edge to append `{"run": "closed", "ts": "<ISO time>"}` to the run ledger when it closes ok. No generated script writes step rows (a step's own script does), so the closed row is an instruction in the text, not a hook.

**`target`** -- The directory the generated hooks resolve project paths against, absolute or relative to the project: a gate's ledger, its `run:` check, a project-relative `run:` script of a hook, and the globs of `before: write "<glob>"`. Claude Code only (Codex finds its scripts from their own place and ignores it). The hooks still live in the project's `.claude/`; only the work is found in the target. A target that does not exist blocks the check (exit 2). V152: a value that is empty or holds characters a directory path does not is an error.

**`domain`** -- Optional domain identifier (e.g., `legal`, `marketing`, `engineering`). Used by bindings and tooling for categorization and routing.

**`entry`** -- The agent every session starts as:

```agenttopology
meta {
  version: "1.0.0"
  description: "Release desk"
  entry: lead
}
```

- **claude-code** writes `"agent": "<name>"` into `.claude/settings.json`, Claude Code's key that starts every session as that subagent, with its prompt, tools and model (code.claude.com/docs/en/sub-agents; `claude --agent <name>` overrides it for one session). Claude Code resolves the key by the agent file's frontmatter `name`, so the value is the name the binding writes there: the agent's `extensions { claude-code { name } }` when set, else its id. An agent with a hand-written `file:` keeps that file's own `name`; when it differs from the id, state it as `extensions { claude-code { name: <name> } }` (import does this for the entry agent). When `extensions { claude-code { agent } }` names a different agent, that value is written, as the more specific, and V134 warns naming both; when that value names a declared node Claude Code cannot start (the cases below), it is not written and V134 warns. A name the topology does not declare (a plugin's agent, say) is written as is.
  - **A `.claude/settings.json` that already sets `agent` keeps its value**, like every other key the merge does not replace, and the run says so (`.claude/settings.json agent: file has "lead", the .at states "worker" — not changed`). This includes the value an earlier scaffold wrote: after changing or removing `entry`, delete the `agent` key from `.claude/settings.json` (or set it by hand) and run scaffold again, which then writes the new value. When the file holds `agent` and the .at states no entry, scaffold says so too (`agent: file has "lead", the .at states none — not changed`). The binding cannot see the file, so with no entry it compiles a gate after that agent to SubagentStop as usual; `guard --check` reads `agent` from the settings.json on disk and grades such a gate `hope`, naming the file's value.
  - **The entry agent is the session, not a subagent.** Claude Code runs a Stop hook for it, never SubagentStop (measured with `claude --agent`, which the settings key is the same mechanism as). A gate `after:` the entry agent is therefore not written as a SubagentStop hook for it: other `after:` anchors that are subagents keep theirs (`after: [worker, lead]` hooks worker only); with no other anchor, when its `before:` names an agent it runs before that agent launches instead, otherwise the playbook runs it. V134 warns on the gate, and `guard --check` grades it `hope` (or `refuse` on the other anchors, with a note naming the entry agent). The entry agent is also never launched, so a gate `before:` it and a human step whose flow goes into it have no launch to hook: V134 warns on each, and `guard --check` grades them `hope` with that reason.
  - **The entry agent's `tools` are the whole session's tools.** An entry agent with a `tools` list that has no `Agent` (or the older `Task`) cannot start any other agent; V134 warns when it has flow edges to agents or the topology has other subagents. Add `Agent`, or `Agent(worker, reviewer)` to allow only those (code.claude.com/docs/en/sub-agents, "Restrict which subagents can be spawned"). No `tools` list means every tool.
- **codex** has no setting that starts a session as a named agent (its `agents.*` keys declare roles for spawned agents only): nothing is written, and `validate --target codex` says so (CX5-entry).
- **cursor** has no such setting either: nothing is written, and scaffold warns.
- **claude-workflow** lists it in its LOSSY report: the workflow script runs inside the session and cannot choose which agent that session is.

The entry must be a declared agent that claude-code writes as a subagent: not an action, gate, human, group or orchestrator, not `runs: inline` or `runs: fork` (written as a skill), and not an `execution: workflow` agent (V134). An empty value or a list is a V134 error too: `entry` takes one agent id. It needs no flow edge (V4 does not apply to it, unless V134 refuses it). Import reads a settings.json `agent` back as `entry` when it matches an imported agent's frontmatter `name` or its id, and does not mark that agent `invocation: manual`.

`entry` here is the session's agent; `interface { entry: <id>, exit: <id> }` (composition) is a fragment's flow entry point. They are separate fields.

---

### 4.5 `orchestrator`

The coordinator that runs the flow. Handles actions inline, spawns agents.

```agenttopology
orchestrator {
  model: opus
  generates: "commands/ship.md"
  handles: [intake, classify, context]
  delegation: subagent
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
| `delegation` | `subagent` \| `inline` | no | `subagent` |
| `outputs` | typed-map | no | `{}` |

**Orchestrator outputs** are referenced in flow as `orchestrator.<output>`.

**Delegation modes:**

- `subagent` (default): the orchestrator spawns each agent step via the platform's subagent / Task-tool mechanism. Each agent runs in its own context window. On claude-code, `SubagentStop` hooks fire when each subagent completes — gates with `after:` an agent compile to those hooks.
- `inline`: the orchestrator drives every agent step in its own session context. Agent `AGENT.md` files are read as prompt fragments by the main session; no subagent is ever spawned. On claude-code, `SubagentStop` hooks would never fire, so the binding suppresses them entirely and emits a "Gates to invoke" cheat sheet in the trigger playbook instead. A gate before a script step still runs from `before-action.sh`; any other gate with a `run:` script is one the playbook runs, so write `strength: hope` on it, or validate reports V135. Use this mode for orchestrator-driven pipelines that don't actually delegate.

Setting an unrecognized value is a topology error (V87).

---

### 4.6 `agent`

```ebnf
agent           = 'agent' identifier '{' agent-fields '}'
agent-fields    = agent-field*
agent-field     = 'role' ':' identifier
                | 'model' ':' model-id
                | 'permissions' ':' perm-enum
                | 'prompt' '{' raw-text '}'
                | 'phase' ':' number
                | 'tools' ':' tool-list
                | 'disallowed-tools' ':' tool-list
                | 'never-reads' ':' string-list
                | 'reads' ':' path-list
                | 'writes' ':' path-list
                | 'outputs' ':' typed-map
                | 'skip' ':' skip-expr
                | 'retry' ':' number
                | 'isolation' ':' 'worktree'
                | 'invocation' ':' ('manual' | 'auto')
                | 'behavior' ':' ('advisory' | 'blocking')
                | 'memory' ':' name-list
                | 'retrieval' ':' identifier
                | 'skills' ':' name-list
                | 'mcp-servers' ':' name-list
                | 'background' ':' boolean
                | 'description' ':' string
                | 'max-turns' ':' number
                | 'max-subagents' ':' number
                | 'max-cost' ':' number
                | 'wall-time' ':' duration
                | 'sandbox' ':' (boolean | identifier)
                | 'fallback-chain' ':' name-list
                | agent-extensions
                | agent-hooks
                | agent-scale
agent-extensions = 'extensions' '{' binding-ext-block* '}'
binding-ext-block = identifier '{' (identifier ':' value)* '}'
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
| `file` | string | no | -- | Project-relative path of the hand-written file holding this node's internals. Bindings reference it and never generate it or write its body; scaffold patches in only the frontmatter keys the `.at` states (V97, §4.20a). `import` sets it on every file it did not generate, so a hand-built system comes in without losing anything. |
| `role` | identifier | no | -- | Maps to a role defined in the `roles` block |
| `model` | model-id | yes | -- | LLM model identifier (e.g., `opus`, `gpt-4o`, `gemini-pro`) |
| `permissions` | perm-enum | no | `autonomous` | Permission mode |
| `prompt` | block | no | -- | Inline agent instructions (multi-line text **block**). A key-value `prompt: "path"` is NOT valid on an agent — that form belongs to `skill` — and is rejected by V89. |
| `phase` | number | no | -- | Pipeline position (ordering by numeric value) |
| `tools` | tool-list | no | all | Tool allowlist |
| `disallowed-tools` | tool-list | no | `[]` | Explicit deny-list |
| `never-reads` | string-list | no | `[]` | Path globs this agent may not read (see 4.32) |
| `reads` | path-list | no | `[]` | Input artifacts |
| `writes` | path-list | no | `[]` | Output artifacts |
| `outputs` | typed-map | no | `{}` | Values that affect flow |
| `skip` | skip-expr | no | -- | Skip condition |
| `retry` | number | no | `0` | Max validation rounds |
| `isolation` | `worktree` | no | -- | Git worktree isolation |
| `invocation` | `manual` / `auto` | no | `auto` | User-triggered only |
| `runs` | `subagent` / `session` / `inline` / `fork` | no | `subagent` | How the node runs: its own agent, a skill in the caller's context, or a skill in a fresh forked context (V101). `session` is its own named Claude Code session that can message other sessions |
| `place` | identifier | no | -- | Where a session agent lives; agents sharing a place run together (V113) |
| `decides` | list | no | -- | Decisions this agent holds the seat for; one seat per decision (V116) |
| `permission-mode` | `default` / `acceptEdits` / `plan` / `auto` / `dontAsk` / `bypassPermissions` | no | -- | Claude Code permission mode, as written. On a subagent it is the agent file's `permissionMode` (`default` writes none); on a session agent it is the start line's `--permission-mode`. With `permissions:` too, both must map to the same mode (V113). Differing modes across a talk edge warn (V113, V118) |
| `independent` | boolean | no | `false` | Must not see the author's reasoning: gets only the artifacts it reads; cannot run inline (V101) |
| `color` | string | no | -- | Display color in the agent list |
| `initial-prompt` | string | no | -- | First user turn when the agent runs as the main session agent |
| `omit-claude-md` | boolean | no | -- | Leave the project's CLAUDE.md out of the agent's context |
| `behavior` | `advisory` / `blocking` | no | `blocking` | Advisory never blocks flow |
| `memory` | name-list | no | `[]` | Store IDs this agent can access (V35) |
| `retrieval` | identifier | no | -- | Retrieval strategy ID for memory queries (V35) |
| `custodian-of` | name-list `{ does: name-list }?` | no | -- | Store IDs this agent **maintains** (not just reads). The primitive behind the `brain` pattern. Optional `does:` declares maintenance verbs (e.g. `link, tag, index, dedupe`). Refs validated by V88. |
| `skills` | name-list | no | `[]` | Skills to preload |
| `mcp-servers` | name-list | no | `[]` | MCP servers available |
| `background` | boolean | no | `false` | Run in background |
| `description` | string | no | -- | Human-readable purpose of this agent |
| `max-turns` | number | no | -- | Maximum agentic turns before stopping |
| `max-subagents` | number | no | -- | Most subagents this agent may have open at once; a positive whole number (V156). On claude-code a PreToolUse hook on `Agent\|Task` refuses a launch at the cap, counted per session from a log the SubagentStart and SubagentStop hooks write |
| `wall-time` | duration | no | -- | Wall-clock cap on the whole session, such as `4h` or `90m`; on the entry agent (`meta { entry }`) only, V159 refuses it on any other agent (a subagent's own limit is `timeout`). On claude-code a `SessionStart` hook, `wall-start.sh`, records the session's start time in `.claude/state/wall-time/<session_id>` (once: a resume or compact keeps the first start), and `wall-time.sh`, a PreToolUse hook on every tool, refuses each tool call, a subagent's too, once more than the cap has passed, with a reason naming the cap. With no start recorded (the file is gone, jq missing, no usable session id) it refuses too. A text check of elapsed time between tool calls: it does not interrupt a call already running, and a command that rewrites the state file is not seen (only the sandbox stops that) |
| `max-cost` | number | no | -- | Spend cap in US dollars (V156). Advisory, not enforced: Claude Code hooks do not see spend; the value is written to the metering output for reporting |
| `scale` | agent-scale | no | -- | Dynamic scaling configuration (see below) |
| `hooks` | agent-hooks | no | -- | Per-agent hooks (scoped to agent lifetime). May be written more than once: the first block's hooks belong to the agent; a second and later block's hooks are project hooks (settings.json), as in 0.11.4. A hook name in two of its blocks is a V23 error |
| `sandbox` | string \| boolean | no | -- | Execution sandbox (true, false, docker, none, network-only) |
| `fallback-chain` | name-list | no | `[]` | Ordered model fallback list |
| `extensions` | agent-extensions | no | -- | Platform-specific extension fields (see below) |

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

**Backward compatibility:** An agent without `scale` behaves as `scale { mode: fixed, min: 1, max: 1 }` -- exactly one instance, identical to current behavior.

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
| `unit-from` | string (regex) | no | -- | One capture group that reads the unit (an episode id, a ticket) from the command line, e.g. `"./tool publish (\S+)"`. Needs a capture group (V111). Write one backslash: a string keeps its backslashes as written, so `\\` matches a literal backslash (V111 warns) |

**action-kind:** `external` | `git` | `decision` | `inline` | `report`

An action with `commands:` runs them as written, whatever its kind. With none, an `inline`, `decision` or `report` action is done by the orchestrator in conversation, so scaffold writes no stub for it; an `external` or `git` action with no commands scaffolds a stub that fails until it is written. A schedule job that runs a `decision`, `report` or `inline` action, or an action with no kind, with no commands does nothing, and validate warns (V136).

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
memory          = 'memory' '{' (memory-sub-block | store-block | retrieval-block)* '}'
memory-sub-block = identifier '{' (identifier ':' (string | identifier | name-list))* '}'
store-block     = 'store' identifier '{' store-field* '}'
retrieval-block = 'retrieval' identifier '{' retrieval-field* '}'
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

Memory sub-blocks are named blocks with known field schemas. The `store` and `retrieval` blocks are typed named blocks parsed into `StoreNode[]` and `RetrievalNode[]` on the AST. Other unknown sub-block names produce a warning (V24).

#### 4.9.1 `store`

A named memory store declaration. Stores define the infrastructure for a specific type of agent memory -- backend, embedding model, indexing, ingestion, search, and lifecycle management.

```ebnf
store-block     = 'store' identifier '{' store-field* '}'
store-field     = 'type' ':' store-type
                | 'description' ':' string
                | 'scope' ':' scope-enum
                | 'isolation' ':' isolation-enum
                | 'backend' ':' backend-enum
                | 'path' ':' string
                | 'connection' ':' secret-string
                | 'extraction' ':' extraction-enum
                | embedding-block
                | index-block
                | ingestion-block
                | search-block
                | lifecycle-block
                | backend-config-block
store-type      = 'semantic' | 'episodic' | 'procedural' | 'entity'
                | 'graph' | 'user' | 'session' | 'temporal' | 'brain'
scope-enum      = 'agent' | 'user' | 'session' | 'org' | 'global'
isolation-enum  = 'strict' | 'soft' | 'none'
backend-enum    = 'lancedb' | 'sqlite-vec' | 'chroma' | 'kuzu' | 'falkordb'
                | 'mongodb' | 'pinecone' | 'qdrant' | 'pgvector' | 'neo4j' | 'sqlite'
                | 'duckdb'
extraction-enum = 'llm' | 'regex' | 'hybrid'
secret-string   = 'secret'? string
```

```agenttopology
memory {
  store codebase-knowledge {
    type: semantic
    description: "Indexed codebase documentation and patterns"
    scope: agent
    isolation: strict
    backend: lancedb
    path: ".memory/semantic/"
    extraction: llm

    embedding {
      provider: ollama
      model: "nomic-embed-text"
      dimensions: 768
    }

    index {
      collection: "chunks"
      metric: cosine
    }

    ingestion {
      sources: ["docs/", "references/"]
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

  store user-preferences {
    type: user
    description: "Per-user preferences and corrections"
    scope: user
    isolation: soft
    backend: sqlite
    path: ".memory/user.db"
  }

  store session-context {
    type: session
    description: "Short-lived conversation context"
    scope: session
    isolation: none
    backend: sqlite-vec
    path: ".memory/session/"
  }

  store knowledge-graph {
    type: graph
    description: "Entity relationships across the codebase"
    scope: global
    backend: kuzu
    path: ".memory/graph/"

    search {
      strategy: graph
      top-k: 20
    }
  }

  store cloud-vectors {
    type: semantic
    description: "Cloud-hosted vector store"
    scope: org
    backend: pinecone
    connection: secret "PINECONE_URL"

    embedding {
      provider: openai
      model: "text-embedding-3-large"
      dimensions: 3072
      endpoint: secret "OPENAI_EMBEDDING_URL"
    }
  }
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `type` | store-type | yes | -- | Memory type classification |
| `description` | string | no | -- | Human-readable purpose |
| `scope` | scope-enum | no | -- | Access scope (V32 warning if omitted) |
| `isolation` | isolation-enum | no | -- | Isolation level between scopes |
| `backend` | backend-enum | yes | -- | Storage backend (V30 enum check). For `type: brain`, defaults to `files` and is exempt from the enum check (V81). |
| `path` | string | no | -- | File system path for local backends |
| `connection` | secret-string | no | -- | Connection URI for remote backends (V34) |
| `extraction` | extraction-enum | no | -- | Entity/fact extraction method |
| `format` | string | no | -- | File format/convention for file-native stores. For `brain`, typically `obsidian` ([[wikilinks]], #tags, YAML frontmatter) — a promise the store round-trips as a real Obsidian vault. |
| `owner` | agent id | no | -- | The one agent that may share this store. Two other agents writing it (listing it under `memory:`, `custodian-of:` or `writes:`) is an error naming both, unless one of the two is the owner (V121). An owner that is no agent is an error. |
| `sources` | sources-block | no | -- | **Presentation only** — provenance styling for the brain graph view. Maps a note's `source:` frontmatter to a color/icon. Visualizer-only; bindings ignore it. See below. |
| `embedding` | embedding-block | no | -- | Embedding configuration (V31 warning if omitted for semantic/episodic/procedural) |
| `index` | index-block | no | -- | Index/collection configuration |
| `ingestion` | ingestion-block | no | -- | Data ingestion configuration |
| `search` | search-block | no | -- | Search/query configuration |
| `lifecycle` | lifecycle-block | no | -- | Memory lifecycle management |
| `backend-config` | backend-config-block | no | -- | Backend-specific passthrough |

**`connection` and secrets:** The `connection` field supports the `secret` modifier, parsed identically to `checkpoint.connection`. When `secret` is present, the string value is treated as a secret reference (e.g., `secret "PINECONE_URL"` references the `PINECONE_URL` secret).

**`backend-config`:** A passthrough block for backend-specific key-value pairs not covered by the standard fields. Stored as `Record<string, unknown>` on the AST. Same pattern as `ProviderDef.extra`.

**The `brain` store type (file-native).** A `brain` store is the file-native memory primitive behind the `brain` pattern: a folder of Obsidian-format markdown where the graph is a *projection* of the files, not a separate database. It is deliberately backend-less — its `backend` defaults to `files` and is exempt from the backend-enum check (V81), it needs no embedding (V82), and it compiles to direct file access (no MCP server). Edges come from inline `[[wikilinks]]` and `#tags`; backlinks are computed. Because the format is Obsidian, a `brain` store round-trips as a real Obsidian vault — agents build it, a human opens it in Obsidian for the graph view, and an existing vault becomes an agent-readable brain with zero migration. Heavyweight stores (`semantic`, `graph`, `entity`) remain available as an opt-in power-up alongside a brain. See `docs/company-brain-design.md`.

**Custody (`custodian-of`).** Custody is the one new primitive the brain pattern needs. `memory:` grants an agent *read* access to a store; `custodian-of:` makes the agent *responsible for the store's upkeep* — wiring dropped files into the graph (resolving mentions into `[[wikilinks]]`, assigning `#tags`, updating index/hub notes, flagging ghost nodes and duplicates). The optional `does:` sub-list declares the maintenance verbs as visible architecture (like an optional type annotation); omitting it lets the agent infer its duties from its prompt. The verb *names* are language vocabulary; *how* each verb is performed well is an implementation/skill concern, not part of the spec. V88 validates that every `custodian-of` reference resolves to a declared store and warns when custody targets a non-brain store.

**Provenance styling (`sources`).** A presentation-only sub-block on a brain store that colors the graph view by where each note came from. Each named entry maps a source key (matching a note's `source:` frontmatter, stamped by its ingester) to a `color` (hex) and/or `icon` (a file path):

```
store brain {
  type: brain
  path: "brain/"
  sources {
    gmail {
      color: "#EA4335"
      icon: "./logos/gmail.svg"
    }
    slack {
      color: "#4A154B"
    }
  }
}
```

This is **strictly cosmetic and affects only the `visualize-brain` rendering** — it never touches ingestion, agents, files, or binding output. Bindings emit nothing for it; delete it and the brain behaves identically (the graph just falls back to category coloring). The language stores **no image bytes** — only the path string; the visualizer reads the icon file at generate-time and inlines it as a `data:` URI, keeping the output a single self-contained HTML file. When a node's `source` matches a `sources` key, it is colored/iconed accordingly; otherwise it falls back to category-based coloring (person/org/topic inferred from tag namespaces).

**Local vs remote backends:** Backends `lancedb`, `sqlite-vec`, `sqlite`, `kuzu`, and `chroma` are local-first (use `path`). Backends `pinecone`, `qdrant`, `pgvector`, `neo4j`, `mongodb`, and `falkordb` are remote (require `connection`, V34).

##### `embedding` sub-block

```ebnf
embedding-block = 'embedding' '{' embedding-field* '}'
embedding-field = 'provider' ':' embedding-provider
                | 'model' ':' string
                | 'dimensions' ':' number
                | 'endpoint' ':' secret-string
embedding-provider = 'ollama' | 'local' | 'voyage' | 'openai' | 'gemini'
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `provider` | embedding-provider | no | -- | Embedding provider |
| `model` | string | no | -- | Model identifier |
| `dimensions` | number | no | -- | Vector dimensions |
| `endpoint` | secret-string | no | -- | Endpoint URL or secret reference |

##### `index` sub-block

```ebnf
index-block     = 'index' '{' index-field* '}'
index-field     = 'collection' ':' string
                | 'metric' ':' metric-enum
metric-enum     = 'cosine' | 'euclidean' | 'dot-product'
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `collection` | string | no | -- | Collection or table name |
| `metric` | metric-enum | no | -- | Distance metric for vector similarity |

##### `ingestion` sub-block

```ebnf
ingestion-block = 'ingestion' '{' ingestion-field* '}'
ingestion-field = 'sources' ':' string-list
                | 'chunking' ':' chunking-enum
                | 'chunk-size' ':' number
                | 'overlap' ':' number
chunking-enum   = 'recursive' | 'sentence' | 'paragraph' | 'fixed'
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `sources` | string-list | no | `[]` | Source paths or globs to ingest |
| `chunking` | chunking-enum | no | -- | Chunking strategy |
| `chunk-size` | number | no | -- | Target chunk size in tokens or characters |
| `overlap` | number | no | -- | Overlap between chunks |

##### `search` sub-block

```ebnf
search-block    = 'search' '{' search-field* '}'
search-field    = 'strategy' ':' strategy-enum
                | 'rerank' ':' boolean
                | 'top-k' ':' number
strategy-enum   = 'vector' | 'keyword' | 'hybrid' | 'graph'
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `strategy` | strategy-enum | no | -- | Search strategy |
| `rerank` | boolean | no | `false` | Whether to apply reranking |
| `top-k` | number | no | -- | Number of top results to return |

##### `lifecycle` sub-block

```ebnf
lifecycle-block = 'lifecycle' '{' lifecycle-field* '}'
lifecycle-field = 'retention' ':' duration
                | 'decay-half-life' ':' duration
                | 'consolidation' ':' number
                | 'contradiction' ':' contradiction-enum
                | 'audit-log' ':' boolean
duration        = [0-9]+ ('d' | 'h' | 'm' | 'y')
contradiction-enum = 'overwrite' | 'preserve' | 'bi-temporal'
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `retention` | duration | no | -- | Retention period (e.g., `90d`, `1y`) |
| `decay-half-life` | duration | no | -- | Half-life for memory decay scoring |
| `consolidation` | number (0-1) | no | -- | Consolidation threshold |
| `contradiction` | contradiction-enum | no | -- | Contradiction resolution strategy |
| `audit-log` | boolean | no | `false` | Whether to maintain an audit log |

##### `backend-config` sub-block

```ebnf
backend-config-block = 'backend-config' '{' (identifier ':' value)* '}'
```

A passthrough block for backend-specific configuration. All key-value pairs are stored as-is in `StoreNode.backendConfig` without schema validation.

#### 4.9.2 `retrieval`

A named retrieval strategy declaration. Retrieval blocks define how an agent queries across one or more stores -- source selection, scoring weights, budget constraints, and cache-hit routing.

```ebnf
retrieval-block = 'retrieval' identifier '{' retrieval-field* '}'
retrieval-field = 'sources' ':' name-list
                | 'budget' ':' number
                | 'paths' ':' name-list
                | 'rerank' ':' boolean
                | 'diversity' ':' boolean
                | 'cache-hit-threshold' ':' number
                | 'cache-hit-action' ':' cache-hit-enum
                | scoring-block
cache-hit-enum  = 'short-circuit' | 'augment' | 'pass-through'
scoring-block   = 'scoring' '{' scoring-field* '}'
scoring-field   = 'recency-weight' ':' number
                | 'semantic-weight' ':' number
                | 'importance-weight' ':' number
```

```agenttopology
memory {
  retrieval balanced {
    sources: [codebase-knowledge, user-preferences, knowledge-graph]
    budget: 4096

    scoring {
      recency-weight: 0.3
      semantic-weight: 0.5
      importance-weight: 0.2
    }

    paths: [semantic, episodic, graph]
    rerank: true
    diversity: true

    cache-hit-threshold: 0.92
    cache-hit-action: short-circuit
  }

  retrieval fast-lookup {
    sources: [session-context]
    budget: 1024
    rerank: false

    cache-hit-threshold: 0.95
    cache-hit-action: short-circuit
  }
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `sources` | name-list | no | `[]` | Store IDs to draw from (V33 reference check) |
| `budget` | number | no | -- | Token budget for retrieved context |
| `paths` | name-list | no | `[]` | Retrieval paths to activate |
| `rerank` | boolean | no | `false` | Whether to apply cross-source reranking |
| `diversity` | boolean | no | `false` | Whether to enforce diversity across results |
| `cache-hit-threshold` | number (0-1) | no | -- | Similarity threshold for cache-hit detection |
| `cache-hit-action` | cache-hit-enum | no | -- | Action on cache hit |
| `scoring` | scoring-block | no | -- | Scoring weight configuration |

**`scoring` sub-block:** Weights should sum to 1.0 but this is not enforced at parse time. Bindings may normalize weights at runtime.

| Scoring Field | Type | Required | Default | Description |
|---------------|------|----------|---------|-------------|
| `recency-weight` | number (0-1) | no | -- | Weight for recency in scoring |
| `semantic-weight` | number (0-1) | no | -- | Weight for semantic similarity |
| `importance-weight` | number (0-1) | no | -- | Weight for importance/frequency |

**Memory-gated routing:** The `cache-hit-threshold` and `cache-hit-action` fields enable memory-gated routing -- when a query closely matches existing memories, the retrieval strategy can short-circuit (skip the LLM call), augment (add cached answer to context), or pass through (proceed normally). This is a first-class declarative primitive for BudgetMem-style memory optimization.

#### 4.9.3 Agent-Level Memory References

Agents reference stores and retrieval strategies via two new fields on the `agent` block:

```agenttopology
agent researcher {
  model: sonnet
  memory: [codebase-knowledge, session-context]
  retrieval: balanced
}

agent assistant {
  model: haiku
  memory: [user-preferences, session-context]
  retrieval: fast-lookup
}
```

The `memory` field is a name-list of store IDs. The `retrieval` field is a single identifier referencing a retrieval strategy. Both are validated against declared stores and retrievals (V35).

---

### 4.10 `flow`

```ebnf
flow            = 'flow' '{' flow-statement* '}'
flow-statement  = node ('->' node)+ edge-attrs?
                | 'talk' ':' ('all' | 'hub' identifier) message-attr?
message-attr    = '[' 'message' ':' ('ticket' | 'report' | 'ask') ']'
node            = identifier | '[' identifier (',' identifier)+ ']'
edge-attrs      = '[' attr (',' attr)* ']'
attr            = 'when' condition | 'max' number | 'per' identifier
                | 'message' ':' ('ticket' | 'report' | 'ask')
condition       = identifier '.' identifier op value
```

`talk: all` and `talk: hub <name>` are shorthand for the edges between session agents (`runs: session`): all makes an edge each way between every pair, hub makes `<name> <-> x` for every other session agent. The parser expands them into plain edges. An edge already written in the flow keeps its own attributes.

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
| `[finish]` | Finish edge: `builder -> lead [finish]` closes the run and hands the line back to the entry agent. An end, not a loop, so it needs no `[max N]` (V6 does not apply). It must point at `meta { entry }` (V149). Combine as `[when x.y == z, finish]` |
| `[per ticket]` | One instance per unit (currently only `ticket` is valid) |
| `[strength: none]` | Enforcement written down: `refuse`, `detect`, `hope` or `none` (V104), so an absence is declared, not implied |
| `[at: "story/SKILL.md"]` | Where the enforcement, or the prose that hopes, lives (V106) |
| `[guard: lock-bash]` / `[guard: [a, b]]` | The hooks or gates that guard this edge, by id (V105) |

**Enforcement.** `strength` says what stops a step: code or a hook **refuses** it, a critic **detects** it after the fact, prose **hopes**, or **none**. `by` names the mechanism (`code`, `hook`, `settings`, `gate`); `at` cites it, `match` is the text expected there, and `bypass` names the way around it. A gate or hook carries the evidence; an edge cites it with `guard:` or writes its strength down. Hooks take `strength` and `bypass`. validate checks the words and the references (V104 to V106) and never reads the project. Reading the cited files (does the line exist, is the `match` text there) is `guard --check`'s job, and lands with it in 0.10.0.

**Chained flows:** `a -> b -> c [when x]` desugars to `a -> b` + `b -> c [when x]`. Edge attributes apply to the **last edge only**.

**Edge attribute order:** `[when <condition>, max <N>, per <unit>]`. Parser error on wrong order.

**Condition format:** `<source>.<output> <op> <value>`
- Source must be an agent name or `orchestrator`
- Output must be declared in that source's `outputs` block
- Operators: `==` `!=` `>=` `<=` `>` `<`

**Exhaustive conditions:** When a node has ONLY conditional outgoing edges, the conditions must be exhaustive over the output's enum values that are **reachable** at that node. If no condition matches at runtime, it is a **runtime error** (flow halts). Validation rule 15 checks for exhaustiveness at parse time, accounting for upstream routing that eliminates certain values.

**Unconditional edges:** An edge without `[when]` is always taken. If a node has both unconditional and conditional edges, the unconditional edge is always taken regardless of conditions.

**What a `when` edge compiles to (claude-code).** An edge whose condition is `<agent>.<field> == <value>`, where `<field>` is an enum the agent or orchestrator `<agent>` declares in `outputs:` and `<value>` is one of its values, is a *route*. When every edge into a subagent is a route, and each route's owner can run Bash (an orchestrator, or an agent with no `tools` list or one that names Bash), the binding writes:

- `.claude/skills/<topology>/scripts/route.sh <agent> <field> <value>`. The router runs it to record its choice: it appends one JSON line, `{"agent": "<agent>", "field": "<field>", "value": "<value>", "ts": "<ISO time>"}`, to `.claude/state/routes-<topology>.jsonl`. A routed output it does not know, a value the output does not declare, or a wrong number of words exits 2 and writes nothing. The owner's agent file (for the orchestrator, SKILL.md's Flow section) gets the command and the route table, each value with the nodes its edges lead to.
- a route check in `before-agent.sh`, the PreToolUse hook on `Agent|Task`. Before the subagent starts, the last record for each `<agent>.<field>` that routes to it must hold a value whose edge leads to it. Otherwise the hook exits 2 and says which value the last record holds (or that there is no record) and which edge the launch needed. A record file that cannot be read blocks. A subagent that no route leads to is not affected.
- in `before-edit.sh` (PreToolUse on `Write|Edit|MultiEdit|NotebookEdit`), a refusal of any edit of the route record.

- for a script step (an action with `commands:`) every edge into which is a route, the same route check in `before-action.sh`, before the step's command runs (and in the step's own `action-<id>.sh`, which hands its commands to that check). It exits 2 naming the recorded value and the edge it needed. This holds under inline delegation too.
- in `before-action.sh` (PreToolUse on `Bash|Monitor|PowerShell`), the gate-ledger check applied to the route record: a command that names it and does more than read it (a redirect, `tee`, `cp`, `mv`, `rm`) exits 2. Reading it, and running `route.sh`, pass.

Every other `when` edge keeps its line in SKILL.md's Flow list and is not enforced. Where it promises a refusal that is not made, `validate` (no target, or `--target claude-code`) warns, naming the edge and why (rule id `CC-route`): a condition of another form; an edge to an action with no `commands:` (done in conversation, so there is no step to refuse); a route whose owner has no Bash in its tools; inline delegation. A route into an agent that an edge without a condition also reaches is not checked (the launch cannot tell which edge it follows) and does not warn. Codex, Cursor and claude-workflow do not compile routes.

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
| `description` | string | no | -- | What the gate checks, in words. Prose goes here, never in `run` (V96) |
| `strength` | `refuse` / `detect` / `hope` / `none` | no | -- | What stops the step, as written down (V104). See "Enforcement" below |
| `by` | `code` / `hook` / `settings` / `gate` | no | -- | Which mechanism refuses (V104) |
| `at` | `"path"` or `"path:line"` | no | -- | The code that refuses, project-relative (V106) |
| `match` | string | no | -- | Text expected within 5 lines of `at`, so a refactor that removes the check is caught. Needs `at` (V106) |
| `bypass` | string | no | -- | The declared way around it (an env switch, a flag) |
| `ledger` | record id | no | the only record | The record a gate before a script step reads. Omitted, a topology with exactly one `record` uses it (V112) |
| `tests` | block | no | -- | `tests { refuse: ["<command>", ..]  allow: ["<command>", ..] }`. Each row is a Bash command the guarded check is fed as a PreToolUse payload (before a subagent, an agent name instead); `agentopology guard <file> --test` runs every row through the real generated script (before-action.sh, before-agent.sh) and exits 1 on a row that is not refused (`refuse`) or not allowed (`allow`). Needs a generated check that holds the gate, a script step or a subagent in `before:` (V141). Also allowed on a `hook` (a command hook on `PreToolUse`): the rows are fed to its own `run:` command |
| `mode` | `shadow` / `refuse` | no | `refuse` | `shadow`: the generated check logs what it would refuse to `logs/shadow.jsonl` (`{gate, at, command, reason}`) and exits 0. Works where `tests` does (V142) |
| `let-go` | `once` | no | -- | One override per step. A refusal is lifted for one run when the gate's human has an ok ledger row for it: in the gate's ledger, `step` is the human's id, `ok: true`, `gate` is this gate's id, `"let-go": true`, and `at` is newer than the gate's last refusal (`logs/refused.jsonl`) and than the row of the last use. The use is written to `logs/let-go.jsonl`, so the row lifts one run. Needs a human and a ledger (V142) |
| `lift` | human id | no | the human in `after:` | The human whose row lets the gate go. Needs `let-go` (V142) |
| `rule` | string | no | -- | The id of a `rules { }` entry this gate enforces; an unknown id is an error (V144). Written into the gate's section and listed by `guard --check` |

**Tests, mode and let-go (0.13).** `tests` is enforced by running: `guard --test` scaffolds into a temp folder (or `--dir`, keeping files already there) and feeds each row to the generated script as the host would (a gate holding a script step gets the row as a Bash command, a gate holding a subagent launch gets it as the agent's name, a hook gets the row through its `run:` command), printing `refused` or `allowed` per row. A gate in `mode: shadow` exits 0 whatever it would refuse; `--test` counts a row it logged as refused and says so. `mode: shadow` and `let-go: once` are compiled into before-action.sh and before-agent.sh only; on a gate those scripts do not hold (a SubagentStop gate) they are errors (V142), not silent text. `let-go` reads the human's row from the gate's own ledger, which the ledger guard keeps the model from writing; a refusal with no row is logged to `logs/refused.jsonl`, and only a row newer than that logged refusal lifts it.

**Gates before a script step.** A gate whose `before:` is an `action` with `commands:` refuses that step in Claude Code sessions. The claude-code binding writes one script, `before-action.sh`, wired as a `PreToolUse` hook on `Bash|Monitor|PowerShell` (every Claude Code tool that runs a shell command; Monitor from Claude Code 2.1.314) with `onFailure: "block"`. A PowerShell command is read the same way, a backslash as a path separator, and a mention of the tool not read as a declared step is refused; a Monitor call with no `command` passes. When the command starts with one of the action's `commands:` (leading `VAR=value` words are ignored), the script checks the gate: if it has a ledger, the **last** line for the `after:` step (and the same unit, when the command names one with `unit-from`) must have `ok: true`; if it has `run:`, that wrapper must exit 0. Anything else exits 2 and says which gate, step, unit and ledger path refused. A gate with neither a ledger nor `run:` has nothing to check (V110).

**The stop: a typed stop word.** A `human` step with `word:` may also carry `stop-word: "<stop word>"` (V158: it differs from `word:`, and neither opens with the other, since the go hook reads a prompt that opens with a word as that word). On claude-code, a prompt the person typed that is the stop word (same typed test and same anchoring as the go word: alone, or followed by a space or one of `, . : ; ! ?`) makes the go hook append `{"step": "<human id>", "ok": false, "halt": true, "word": "<stop word>", "ts": "<UTC ISO time>"}` to the same ledgers as the go row. `go-halt.sh`, a generated PreToolUse hook on every tool, refuses each tool call while the last row for that human in the ledger is a halt; the reason names the stop word and the go word. The go hook is a prompt hook, so the halt never blocks the person typing the next go; the go row it writes ends the halt. A gate after the human refuses too, as its last row is `ok: false`. This is a text check of the ledger and of who typed the prompt: it stops tool calls the host routes through hooks, not a process already running, and a halt the hook could not write (a ledger that is a symlink, or has a second hard link) is not recorded.

**The go: a typed word.** A `human` step may carry `word: "<go word>"` (a string) and `binds: [<project paths>]` (a list). On claude-code the human gets a generated `UserPromptSubmit` hook, `go-<human>.sh`. When a prompt the person typed is the word, after leading and trailing spaces are trimmed, or starts with the word followed by a space or one of `, . : ; ! ?` (`go release, notes look right`; a longer word such as `go released` does not count), the hook appends the go row to the ledger of every gate whose `after:` names the human: `{"step": "<human id>", "ok": true, "word": "<word>", "ts": "<UTC ISO time>", "binds": {"<path>": "<sha256>"}}`. A bound file that is missing is recorded as `null`. The word is matched case-sensitively. The hook never blocks a prompt. Claude Code also runs `UserPromptSubmit` for prompts nobody typed (a message from another session, a scheduled task, a background subagent reporting back), and its input does not say where a prompt came from. So the hook uses the same typed test as a deciding session's prompt log: a prompt that opens with `<cross-session-message` arrived from another session, and one that holds a `<task-notification` envelope anywhere is a background report; neither writes a row. A session-scoped scheduled task or `/loop` prompt arrives as written, with no envelope, so one that starts with the word would count; the model schedules those with the CronCreate and ScheduleWakeup tools, and `before-schedule.sh`, a generated PreToolUse hook on `CronCreate|ScheduleWakeup`, refuses one whose prompt starts with the word (the go hook's match, after a leading `/loop` and interval). In `before-action.sh`, a gate after such a human counts the go row only while every bound file's current sha256 equals the one in the row (a changed or deleted file fails the gate and names the file), and, when the human has `valid:`, only while today is not past the window's end and the row's `ts` (or `at`) falls inside the window. What is enforced against the agent writing the row: an edit of the ledger, and a Bash command that writes it, are refused, and so are an edit of the go hook and a command that runs or changes it. A Bash command that runs `claude` (a new session, whose prompt the go hook would read as typed) is refused when it holds the go word anywhere, or when it matches no runner step the topology declares (an action whose `commands:` run `claude`, its words in order after `claude`, or a schedule job's `claude -p ... --agent <agent>`). Within a command that runs `claude`, the go word matches as a whole word anywhere, so a runner prompt that merely mentions it is refused too (rare, and it fails closed). A Bash command that runs a keystroke tool (tmux, screen, xdotool, osascript, wtype, ydotool, or a program listed in the human's optional `typed-only-programs: [<program>, ...]`) and holds the go word as a whole word is refused. These are refused when the hook, the ledger or the go word appears in the command; a command built at run time can still reach them. V127: `word:` needs a ledger to write to (a gate after the human, with a record whose path has no `{unit}`); `binds:` needs `word:`, and its paths must be inside the project; `typed-only-programs:` needs `word:`, and each entry is a program name with no path.

```agenttopology
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
```

**Gates before a write of a path.** `before: write "<glob>"` holds an edit of a matching path until the gate holds, the way a gate before a script step holds that step: its ledger (the last line for its `after:` step must be ok) and its `run:` check, both as `before-action.sh` checks them. It is a path anchor, not a node id; a gate has one `before:` line, so a gate that stands before both a step and a path is written as two gates. The claude-code binding writes `before-edit.sh` (the hook on `Write|Edit|MultiEdit|NotebookEdit`, which already refuses an edit of a gate's ledger) so that it refuses an edit whose path, made relative to the project root (or to `meta { target }`), matches the glob, until the gate holds. `before-action.sh` refuses a Bash command that names a matching path and does more than read it (a `>` or `tee`, or a program that is not known to only read its arguments) until the gate holds; a path reached through a variable set elsewhere, or another script, is not seen. `*` and `**` both match across folders; `**/` also matches no folder; a glob with no wildcard names a path or the folder under it. Without jq the edit hook refuses every edit. V151: an empty glob is an error, and a gate with neither a ledger nor a `run:` has nothing to check (warning). Codex gets the same scripts through its `apply_patch` hook.

**A gate that refuses needs a moment a hook can mark (V135).** On Claude Code (and Codex, which wires gates the same way) a gate's `run:` script runs from a hook in three cases: every `after:` is a subagent (an `agent` without `runs: inline/fork`, or a `group`), so a `SubagentStop` hook runs it; a `before:` is a subagent, so `before-agent.sh` runs it before that agent starts; or a `before:` is a script step, so `before-action.sh` runs it before the step's command. With `orchestrator { delegation: inline }` no subagent runs, and only the script step wires. Any other gate gets its wrapper script and nothing that calls it. When such a gate is meant to refuse (its `run:` names a script, it is not `behavior: advisory`, and its `strength` is `refuse` or not written), validate reports a V135 error naming each anchor and what it is, unless an edge between its anchors cites (`guard:`) a declared hook with `strength: refuse` that can block, or another gate a hook runs, or a declared hook with `strength: refuse` that can block runs the gate's own `run:` command (then a V135 warning names that hook, its matcher and `if:`: it runs only on the calls they select, and `guard --check` grades the gate hope, or cited with `at:`, never refuse). A hook can block when it is a command hook, not async, on an event the platform blocks on (the list `guard --check` reads). Fix the anchor, or write `strength: hope` when a playbook runs the gate by hand; a cited gate may instead drop `run:` and keep the citation as the claim. A citation (`at:`) does not exempt it: only the gate's own generated hook makes it refuse. On Claude Code an `execution: workflow` agent is not a subagent (it runs in the workflow script). On Codex a gate run only by SubagentStop passes V135 but cannot hold the next step (CX9-noblock warns). Cursor writes a hook for every gate and is not checked; `plan` (interpreted mode) places the gate by its anchors and does not stop on V135.

```agenttopology
records {
  record trace { path: "logs/{unit}/trace.jsonl" }
}
```

`records { record <id> { path: "<project-relative path>" } }` declares ledgers. `path` may contain `{unit}`. `append-only` and `written-by` are reserved and not implemented.

A record may also say what a row holds. Write one field per line:

```agenttopology
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
```

| Field | Value | Required | Description |
|-------|-------|----------|-------------|
| `path` | string | yes | Project-relative file, may contain `{unit}` (V112) |
| `fields` | `[<name>: <type>, ..]` | no | The fields a row must hold. Types: `string`, `number`, `boolean`, `ts` (an ISO 8601 time) (V139) |
| `schema` | schema id | no | A schema declared in `schemas { }` (V139) |
| `writer` | action id, agent id or project-relative script path | no | What writes the record (V139) |
| `kind` | `run-state` | no | A run-state record has the fixed fields `target` and `step` (both `string`); it takes no `fields:` (V139) |

On `claude-code` a record that declares any of these compiles to: (1) `.claude/skills/<topology>/scripts/record-<id>.sh '<json>'`, which appends a row only when it holds every declared field with the declared type, otherwise exits 2 naming the missing or mistyped field and writes nothing, and adds `ts` when missing; a row `{step, ok: "n/a", reason}` goes through it and `reason` is required; (2) when a gate reads the record and its `after:` step is an action with `commands:`, `after-action.sh`, a `PostToolUse` hook on `Bash` that appends `{step, ok: true, ts, model}` (and the unit, when the step has one) when the step's command succeeded. It reads the command with the same step matcher `before-action.sh` uses. `PostToolUse` fires only for a call that succeeded (a failed `Bash` call fires `PostToolUseFailure`, whose `error` starts `Exit code N`), and the hook also skips a payload that says it failed; it writes nothing for a command joined with `;`, `|`, `||` or a single `&`, since the exit status is then not the step's. (3) `.claude/records.json` lists every record, with its id, path, fields, writer and the gates that read it (`readBy`), so a record no gate reads is still written down. Codex and cursor write none of this; `validate --target codex` and `--target cursor` warn (V140).

**Ledger line format** (JSON Lines, one object per line). The step's own script appends the line when it finishes; agentopology only reads it:

```json
{"step": "<node id>", "unit": "<unit, omitted when none>", "ok": true, "at": "<ISO time>"}
```

A hook only covers Claude Code sessions. A step run from a terminal or a scheduler checks itself, by calling `agentopology step check <file.at> <step-id> [--unit U] [--dir D]` at its start (`by: code`): it exits 0 when every gate before that step is satisfied and 1 otherwise, naming each failing gate and why. A gate is satisfied when its ledger shows the `after:` step ok (for the unit, if given) **and**, if it has `run:`, that command exits 0 from `--dir` (default `.`); a gate with neither is unsatisfiable ("nothing to check"). A step no gate guards exits 0 with `no gate guards <step>`. It reads and runs check scripts; it never writes. The hook sees a step inside a chained command (`cd dir && cmd`, `a; cmd`, `a || cmd`, `a | cmd`, a later line) and checks each segment; it does not see one run indirectly (`bash -c`, `eval`, a script that calls the step).

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
command-fields  = 'pattern' ':' string ('argument' ':' template-var)? ('file' ':' string)?
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
| `file` | string | no | -- |

---

### 4.16 `hooks`

```ebnf
hooks           = 'hooks' '{' hook-decl* '}'
hook-decl       = 'hook' identifier '{' hook-fields '}'
hook-fields     = ('on' ':' hook-event | 'matcher' ':' string | 'run' ':' string
                  | 'type' ':' hook-type | 'flag' ':' env-name | 'timeout' ':' number)*
hook-event      = <universal-event> | <platform-event> | <engine-event>
hook-type       = 'command' | 'prompt' | 'mod'
engine-event    = 'tool.call' | 'prompt.submit' | 'prompt.context' | 'session.start'
                | 'session.end' | 'model.complete' | 'message.received'

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
| `if` | permission rule | no (tool events only) | -- |
| `run` | string | command, prompt, agent, mod | -- |
| `type` | hook-type | no | `command` |
| `url` | string | http | -- |
| `server`, `tool` | string | mcp_tool | -- |
| `async` | boolean | no (command only) | `false` |
| `model` | identifier | no (prompt, agent) | -- |
| `flag` | env-name | no (mod only) | -- |
| `timeout` | number | no | `600` |
| `tests` | block | no | -- | `tests { refuse: ["<command>", ..] allow: ["<command>", ..] }`: Bash commands `guard --test` feeds the hook's own `run:` command as PreToolUse payloads; exit 2 is refused (V141). A command hook on `PreToolUse` only. `mode` and `let-go` are gate fields (V142) |

`hook-type` is `command` (a shell command), `prompt` or `agent` (a model or a
subagent judges the event; `run:` is the prompt), `http` (the event is POSTed
to `url:`), `mcp_tool` (`tool:` on `server:` is called) or `mod`. V100 checks
that each has its fields and that a prompt or agent judge sits on an event
Claude Code runs judges for.

A `type: mod` hook is a TypeScript module loaded inside the engine (Claude
Code function hooks). Its `on:` is an `engine-event` (V95); a command or
prompt hook takes a PascalCase event. `flag:` names the env variable that
switches the Mod on. Fields are one per line (V90).

A `matcher` is tested against the tool name (or agent type, or path) alone, the
way Claude Code reads it: only letters, digits, `_`, `-`, spaces, `,` and `|`
mean an exact name or a list; any other character makes it an unanchored
regex. An MCP tool is `mcp__<server>__<tool>`. Permission-rule syntax
(`Bash(rm -rf *)`) goes in `if:`, which Claude Code reads on tool events only.
V107 refuses a matcher that can never match and an `if:` that is never read.
`run: "exit 2"` runs as written; only exit 2 blocks, and V108 warns on any
other code. V109 warns when a hook with `strength: refuse` guards a server but
its matcher misses one of the server's tools that the topology names.

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

`settings` also takes `sandbox` (§4.28) and `fallback-chain` (§4.29). Any other key is a V102 error: it would be written nowhere.

---

### 4.18 `mcp-servers`

```ebnf
mcp-servers     = 'mcp-servers' '{' mcp-decl* '}'
mcp-decl        = identifier '{' mcp-fields '}'
mcp-fields      = ('type' ':' mcp-type | 'url' ':' string
                  | 'command' ':' string | 'args' ':' string-list
                  | 'env' ':' env-map
                  | 'from' ':' 'plugin' string | 'server' ':' string)*
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

**A plugin's server (`from: plugin "<plugin>"`).** A server a Claude Code plugin provides is declared with `from: plugin "<plugin-name>"` and, when the plugin's server name differs from the block key, `server: "<server-name>"` (default: the key). It takes no `type`, `command` or `url`: the plugin configures it, so no `.mcp.json` entry is written. Every reference to it compiles to Claude Code's plugin names: `mcp.<key>.<tool>` is `mcp__plugin_<plugin>_<server>__<tool>`, `mcp.<key>.*` is `mcp__plugin_<plugin>_<server>__*` and `mcp.<key>` is `mcp__plugin_<plugin>_<server>`, where any character outside `A-Za-z0-9_-` in the plugin or server name becomes `_`. This holds in an agent's `tools` and `disallowed-tools`, a skill's `allowed-tools` and `disallowed-tools`, `settings { allow ask deny }`, and in a hook `matcher` or `if:` written with the key (`mcp__<key>__.*` becomes `mcp__plugin_<plugin>_<server>__.*`). An `mcp_tool` hook's `server` naming it is the plugin server's registered name, `plugin:<plugin>:<server>`. An agent's `mcp-servers` entry naming it is left out of the agent's `mcpServers` for now (V130 notes it): the scoped name is not yet verified there, and the agent's `tools` already reach the server, since a plugin's servers are session-wide. A server with no `from` is a project server and compiles as before.

```agenttopology
mcp-servers {
  playwright {
    from: plugin "playwright"   # tools: [mcp.playwright.*] -> mcp__plugin_playwright_playwright__*
  }
}
```

Any other `from:` value is a V133 error naming the expected form. Codex and Cursor have no Claude Code plugins: they write no entry for such a server and say so (`validate --target codex`: CX5-mcp-plugin; Cursor: a scaffold warning).

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
                | ('max-cost' | 'cap') ':' number
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
| `max-cost` | number | no | -- | Spend cap in US dollars; `cap:` is accepted as an alias. Advisory, not enforced (V156): written to the metering output for reporting |

Any other key in `metering` is a V102 error: it would be written nowhere.

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

### 4.19a `observability`

Telemetry for the topology's runs. On Claude Code it compiles to the telemetry env keys in `.claude/settings.json` (see the `observability` docs topic for the key table).

```ebnf
observability       = 'observability' '{' observability-field* '}'
observability-field = 'enabled' ':' ('true' | 'false')
                    | 'level' ':' ('debug' | 'info' | 'warn' | 'error')
                    | 'exporter' ':' ('otlp' | 'langsmith' | 'datadog' | 'stdout' | 'none')
                    | 'endpoint' ':' string
                    | 'service' ':' string
                    | 'sample-rate' ':' number
                    | 'attributes' '{' attribute-pair* '}'
                    | 'capture' '{' (('prompts' | 'completions' | 'tool-args' | 'tool-results') ':' ('true' | 'false'))* '}'
                    | 'spans' '{' (('agents' | 'tools' | 'gates' | 'memory') ':' ('true' | 'false'))* '}'
attribute-pair      = attribute-key ':' (string | identifier)
attribute-key       = [A-Za-z0-9_.-]+
```

```agenttopology
observability {
  enabled: true
  exporter: otlp
  endpoint: "http://127.0.0.1:4318"
  service: "my-topology"
  attributes {
    team.id: "platform"
    cost_center: "eng-123"
  }
  capture {
    prompts: false
    tool-args: false
  }
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `enabled` | boolean | no | `true` | `false` writes no telemetry key |
| `exporter` | enum | no | `otlp` | Backend exporter (V49) |
| `endpoint` | string | no | -- | Collector endpoint URL |
| `service` | string | no | -- | Written as the `service.name` resource attribute |
| `attributes` | block of `key: value` | no | -- | Resource attributes, in file order after `service.name`; a key may hold dots (`team.id`). Added in 0.13.0 |
| `capture` | block | no | all `false` | What content is logged; a switch left out is off |
| `spans` | block | no | agents, tools, gates `true`; memory `false` | Span kinds (no Claude Code key) |

---

### 4.20 `tools`

Topology-level declaration of custom script-based tools. Agents reference these by name in their `tools` field. Any runtime maps them to executable tool definitions.

```ebnf
tools-block     = 'tools' '{' tool-decl* '}'
tool-decl       = 'tool' identifier '{' tool-decl-fields '}'
tool-decl-fields = ('script' ':' string
                   | 'command' ':' string
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
| `script` | string | no (one of `script`, `command`) | -- |
| `command` | string | no (one of `script`, `command`) | -- |
| `args` | name-list | no | `[]` |
| `description` | string | no | -- |
| `lang` | tool-lang | no | `auto` |

**`script`** -- Path to the script file. A path with a folder other than `scripts/` (`tools/render.py`, `./x.sh`) is a project path; a bare name or `scripts/<name>` lives in the topology skill's scripts folder (claude-code: `.claude/skills/<topology>/scripts/`). Scaffold writes a stub there that fails until it is written (a project path is create-only).

**`command`** -- The shell command that runs the tool, as `command: "npm test"`. A tool with a command needs no script, and no stub is written for it. When a tool has both, the command is the call that is allowed.

**`lang`** -- Runtime hint. `auto` (default) infers from file extension (`.sh` -> bash, `.py` -> python, `.js`/`.ts` -> node). Explicit values override inference.

**`args`** -- Named arguments the script accepts. These become the tool's input schema when mapped to any platform.

**Agents reference custom tools by name:**
```agenttopology
agent processor {
  tools: [Read, Write, run-tests, extract-data]
}
```

**How a repo tool compiles on claude-code.** Claude Code's subagent `tools:` field takes Claude Code tool names (`Read, Grep, Bash`), MCP entries (`mcp__github__*`) and `Agent(<type>)` (code.claude.com/docs/en/sub-agents); a repo tool's name is none of these, so it is never written there. A tool with a `command:` or a `script:` runs through Bash:

- An agent whose `tools` names it gets `Bash` in its `tools:` (added once, unless the list already has it).
- For a `command:` tool, `.claude/settings.json` gets the permission allow rule `Bash(<command> *)` after the rules in `settings { allow }`, so it runs without a prompt (the rule also matches the bare command, code.claude.com/docs/en/permissions; a command that holds a `*` is written as is).
- A `script:` tool gets no allow rule and prompts as any Bash call does. The generator never widens a capability: the agent can edit the script, so a rule on it would let the agent run anything without a prompt.
- A skill's `allowed-tools` (and a `runs: inline` or `runs: fork` agent's `tools`, written as `allowed-tools`) naming a command tool gets its allow rule in its place; a script tool there is left out.
- A tool with neither `script:` nor `command:` compiles to nothing: it adds no `Bash` and no rule, and its name is left out (V130 warns). When it is an agent's only tool, the list is kept as written, since an empty `tools:` would give the agent every tool.
- **Never widen.** A skill with `disallowed-tools: [Bash]` (or a `Bash(...)` entry, which removes the whole tool on Claude Code) that names a command or script tool in `scripts:` or `allowed-tools`, and an agent with such `disallowed-tools` whose skill does, are V14 errors naming the agent, the skill and the tool.

Codex and Cursor write the tool's name in the agent's instructions as before, and its stub script when it has a script (none for a command-only tool).

**LL(2) note:** `tools` is a block keyword. The parser sees `tools` `{` and enters the tools-block production. Inside, each `tool` `<identifier>` `{` starts a tool-decl. No ambiguity -- `tools` as a field keyword (in agent-fields) is always followed by `:`, while `tools` as a block keyword is followed by `{`.

---

### 4.20a `file:` — hand-written internals

Any node (`agent`, `group`, `human`, ...), any `skill` and any trigger `command` may carry `file: "<project-relative path>"`. It says: the structure is described here, the internals live in that file, and they are the author's. A binding never generates a file so marked and never writes its body; for a skill it leaves the rest of the skill folder alone, for a group its skill and runtime folder too. Gates and hooks still wire to the node by name. `agentopology import` sets `file:` on every file it finds that no scaffold manifest lists as generated, which is what makes import followed by scaffold lossless.

The `.at` owns structure, the file owns content. For an agent, skill or command file that already exists (one marked `file:`, a hand-written one at a generated path, or a scaffolded one the user edited), `scaffold` writes into its frontmatter exactly the keys the `.at` states for that node (for an agent: `description`, `model`, `tools`, `disallowedTools`, `skills`, `permissionMode` and the other keys the binding emits; never `name`, which is the file's identity, and never keys held under `extensions`). Every other key, comment, key order, quoting, line ending and the whole body stay byte for byte. The scaffold manifest records, per file, the value each key had when scaffold last applied it (`fields`), and each key follows a three-way rule:

| The `.at` vs the file | What `scaffold` does |
|---|---|
| equal | nothing |
| no recorded value yet | writes the `.at` value and prints `~ <path>: <key> <old> → <new>` |
| only the `.at` changed | writes the `.at` value, printed the same way |
| only the file changed | keeps the file's value, prints `! <path>: <key> is <file> in the file, <at> in the .at` |
| both changed | keeps the file's value, prints `! <path>: <key> changed on both sides: .at …, file …, last applied …` |
| the `.at` stopped stating a recorded key | removes it when the file still holds the recorded value; otherwise keeps it and says so |

`--force` takes the `.at` value for a kept key and never touches the body. A file whose frontmatter cannot be edited safely (text with no frontmatter, anchors or aliases, a second YAML document, a duplicate key, a value whose end cannot be found) is left as it is and reported with the reason. A scaffolded file nobody edited is regenerated whole, as before.

### 4.21 `skill` (declarations)

Topology-level skill declarations. Each `skill` block declares a self-contained application that bundles executable scripts, domain knowledge, reference docs, and instructions into a coherent capability. Agents load skills via their `skills` field.

When **no `skill` blocks are declared**, the scaffold generates a single default skill named after the topology. When **one or more `skill` blocks are declared**, each generates its own directory with its own scripts, domains, and references.

```ebnf
skill-decl      = 'skill' identifier '{' skill-fields '}'
skill-fields    = ('description' ':' string
                  | 'scripts' ':' name-list
                  | 'domains' ':' path-list
                  | 'references' ':' path-list
                  | 'prompt' ':' string
                  | 'prompt' '{' text '}'
                  | 'disable-model-invocation' ':' boolean
                  | 'user-invocable' ':' boolean
                  | 'context' ':' identifier
                  | 'agent' ':' identifier
                  | 'allowed-tools' ':' tool-list
                  | skill-extensions)*
skill-extensions = 'extensions' '{' binding-ext-block* '}'
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
| `file` | string | no | -- |
| `description` | string | no | -- |
| `scripts` | name-list | no | `[]` |
| `domains` | path-list | no | `[]` |
| `references` | path-list | no | `[]` |
| `prompt` | string or block | no | -- |
| `disable-model-invocation` | boolean | no | -- |
| `user-invocable` | boolean | no | -- |
| `context` | identifier | no | -- |
| `agent` | identifier | no | -- |
| `allowed-tools` | tool-list | no | `[]` |
| `disallowed-tools` | tool-list | no | `[]` |
| `when-to-use` | string | no | -- |
| `argument-hint` | string | no | -- |
| `arguments` | name-list | no | `[]` |
| `paths` | glob-list | no | `[]` |
| `shell` | `bash` / `powershell` | no | -- |
| `model` | identifier | no | -- |
| `thinking` | effort level | no | -- |
| `extensions` | skill-extensions | no | -- |

A skill's `prompt { }` block is its SKILL.md instructions; `prompt: "path"` names a file holding them, and the SKILL.md tells Claude to read and follow it.

**`disable-model-invocation`** -- When `true`, prevents the skill from automatically invoking the model. Useful for skills that only run scripts.

**`user-invocable`** -- When `true`, the skill appears in user-facing menus and can be triggered directly.

**`context`** -- Context mode for the skill. `fork` creates an isolated subagent context.

**`agent`** -- Agent type to use when `context` is `fork`. References an agent defined in the topology.

**`allowed-tools`** -- Tools that can be used without permission prompts when this skill is active.

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

### 4.22 `context`

Singleton block. Configures the context/instructions file generated by bindings (e.g., `CLAUDE.md` for Claude Code, `CODEX.md` for Codex, `copilot-instructions.md` for Copilot).

```ebnf
context         = 'context' '{' context-fields '}'
context-fields  = ('file' ':' string | 'includes' ':' string-list
                  | 'max-lines' ':' integer | glossary)*
glossary        = 'glossary' '{' (string ':' string)* '}'
```

```agenttopology
context {
  file: "CLAUDE.md"
  includes: ["docs/architecture.md", "docs/conventions.md"]
  max-lines: 200
  glossary {
    "ticket": "A unit of customer work"
  }
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `file` | string | no | none | The context file the binding writes a block into |
| `includes` | string-list | no | `[]` | Project files the block imports |
| `max-lines` | integer | no | none | Longest the context file may be; V146 warns above it |
| `glossary` | block of `"term": "definition"` | no | none | Terms the block defines |

**Claude Code binding:** only when `file:` is declared, that file is written with ONE block between `<!-- agentopology:context:begin ... -->` and `<!-- agentopology:context:end -->` markers. The block holds the entry agent's name (`meta { entry }`) with an instruction to start as it and the sentence `If no agent is named, start as <entry>.`, one `@<path>` import line per include, and the glossary as a `- term: definition` list. A missing file is created. In an existing file only the text between the markers is replaced, every other line stays as the user wrote it, and a file with no block gets it appended. Without `file:` no CLAUDE.md is written. The topology's full description always goes to `.claude/rules/<topology>.md`. An include that is not in the project is a warning (V145, `validate --dir`); a file longer than `max-lines` is a warning (V146).

**Backward compatibility:** A topology without `context` generates a default context file. Existing `.at` files continue to work unchanged.

---

### 4.23 `env`

Free-form key-value pairs defining environment variables for the topology. Supports `${VAR}` syntax for referencing external environment variables.

```ebnf
env             = 'env' '{' env-field* '}'
env-field       = identifier ':' string
```

```agenttopology
env {
  NODE_ENV: "development"
  API_KEY: "${API_KEY}"
  LOG_LEVEL: "debug"
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `<identifier>` | string | -- | -- | Environment variable name and value |

**`${VAR}` syntax:** Values containing `${...}` reference external environment variables. These are resolved at runtime by the binding, not at parse time. This allows secrets and deployment-specific values to remain outside the `.at` file.

**Binding behavior:** How env variables are applied depends on the binding. Claude Code merges them into `settings.json` under an `env` key. Other bindings may write `.env` files or pass them directly to processes.

**Backward compatibility:** A topology without `env` simply has no environment variable configuration. Existing `.at` files continue to work unchanged.

---

### 4.24 `extensions`

Namespaced extension blocks for binding-specific configuration. Each binding reads its own namespace; unknown namespaces are silently ignored. This enables platform-specific features without polluting the core language.

```ebnf
extensions      = 'extensions' '{' binding-ext-block* '}'
binding-ext-block = identifier '{' (identifier ':' value)* '}'
```

```agenttopology
agent explorer {
  model: opus
  permissions: autonomous
  description: "Deep codebase analysis"
  max-turns: 25
  extensions {
    claude-code {
      memory: project
      autoCompactWindow: 200000
    }
    codex {
      sandbox: true
    }
  }
}
```

**Scope:** `extensions` can appear inside `agent`, `skill`, `gate`, and `hook` blocks.

**Semantics:** Each named sub-block inside `extensions` corresponds to a binding name. The binding reads only its own namespace and ignores all others. Fields inside a binding namespace are opaque to the core parser -- they are stored as `Record<string, unknown>` and passed through to the binding.

**The `claude-code` namespace is checked (V130).** Its keys are Claude Code's own, held in `src/bindings/claude-code-schema.ts`: on the topology, settings.json keys (a dotted path such as `permissions.defaultMode`, or a `permissions` / `sandbox` key by its own name, which lands under that object); on an agent, agent frontmatter keys; on a skill or a `runs: inline/fork` agent, skill frontmatter keys. A key may hold dots and digits. Each value is written in its documented type (a list as a list, a number as a number). An unknown key, a mistyped value, a settings key a project file cannot set, or a `claude-code` extension on a hook or gate is not written, and validation warns, naming the nearest known key.

**Why extensions:** The core `.at` language defines universal constructs that work across all platforms. Extensions allow bindings to expose platform-specific features (e.g., Claude Code's `memory: project`, Codex's `sandbox: true`) without adding fields to the core spec that only one platform uses. This keeps the language clean while remaining fully extensible.

**Seam marker for the hybrid:** `extensions { claude-workflow { execution: workflow } }` on an agent marks its phase for the embedded-workflow rung — the deterministic fan-out compiled by the `claude-workflow` binding while the rest of the topology compiles to the `claude-code` host. Unmarked topologies compile to pure `claude-code`, unchanged (the hybrid is opt-in). See `docs/AT_VS_WORKFLOW_STRATEGY.md`.

**LL(2) note:** `extensions` is a block keyword. The parser sees `extensions` `{` and enters the extensions production. Inside, each `<identifier>` `{` starts a binding namespace block. No ambiguity -- `extensions` only appears inside other blocks, never at the top level.

---

### 4.25 `providers`

Declares API provider credentials, base URLs, and model routing. The `providers` block is **optional** — omitting it means the topology uses subscription-based authentication (the default for CLI tools like Claude Code and Gemini CLI).

```ebnf
providers-block = 'providers' '{' { provider-def } '}' ;
provider-def    = IDENT '{' { provider-field } '}' ;
provider-field  = 'api-key' ':' string-value
                | 'base-url' ':' string-value
                | 'models' ':' '[' model-id { ',' model-id } ']'
                | 'default' ':' boolean
                | IDENT ':' value ;
```

```agenttopology
providers {
  anthropic {
    api-key: "${ANTHROPIC_API_KEY}"
    models: [opus, sonnet, haiku]
    default: true
  }
  openai {
    api-key: "${OPENAI_API_KEY}"
    base-url: "https://api.openai.com/v1"
    models: [gpt-4o, o4-mini]
  }
  ollama {
    base-url: "http://localhost:11434/v1"
    models: [llama-3.1-70b, mistral-7b]
  }
}
```

**Security:** `api-key` values MUST be `${ENV_VAR}` references. Literal API keys are a validation error (V16).

**Semantics:**
- `api-key` — environment variable reference for the provider's API key. Must use `${VAR_NAME}` syntax.
- `base-url` — custom endpoint URL. Optional; providers like Anthropic and OpenAI have well-known defaults.
- `models` — model identifiers this provider can serve. Used for routing and validation.
- `default` — at most one provider may be marked as default. When a model is available from multiple providers, the default provider is preferred.
- Extra fields are stored in `ProviderDef.extra` for forward compatibility.

**LL(2) note:** `providers` is a top-level block keyword. The parser sees `providers` `{` and enters the providers production. Inside, each `<identifier>` `{` starts a named provider sub-block. No ambiguity.

---

### 4.26 `schedule`

Declares scheduled jobs -- recurring tasks that trigger agents or actions on a cron schedule. This is a **first-class capability section**: bindings that support scheduling (e.g., OpenClaw, GitHub Actions) generate native cron configuration. Bindings that don't support scheduling emit documentation or skip the section with a warning.

```ebnf
schedule        = 'schedule' '{' schedule-entry* '}'
schedule-entry  = 'job' identifier '{' schedule-fields '}'
schedule-fields = ('cron' ':' string)
                | ('every' ':' string)
                | ('agent' ':' identifier)
                | ('action' ':' identifier)
                | ('enabled' ':' boolean)
```

```agenttopology
schedule {
  job daily-digest {
    cron: "0 9 * * *"
    agent: summarizer
  }
  job weekly-report {
    every: "monday 9:00"
    agent: reporter
    enabled: true
  }
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `cron` | string | one of cron/every | -- | Standard cron expression (5-field) |
| `every` | string | one of cron/every | -- | Human-readable schedule ("daily", "monday 9:00") |
| `agent` | identifier | one of agent/action | -- | Agent to trigger |
| `action` | identifier | one of agent/action | -- | Action to trigger |
| `enabled` | boolean | no | `true` | Whether the job is active |

**Mutual exclusivity:** A job must have exactly one of `cron` or `every` -- not both (V20). A job must reference exactly one of `agent` or `action`.

**Validation:** Every `agent` or `action` referenced must be declared in the topology (V20).

**Binding behavior:** OpenClaw maps jobs to `cronJobs` in `openclaw.json`. GitHub Copilot maps `cron` expressions to `schedule:` triggers in GitHub Actions workflows. Other bindings document the schedules in their instructions files.

---

### 4.27 `interfaces`

Declares external interfaces -- how the agent topology connects to the outside world. Interfaces define input/output surfaces such as webhooks, HTTP APIs, messaging channels, and email endpoints.

```ebnf
interfaces      = 'interfaces' '{' interface-entry* '}'
interface-entry = identifier '{' interface-fields '}'
interface-fields = ('type' ':' identifier)?
                 | (identifier ':' value)*
```

```agenttopology
interfaces {
  slack {
    type: webhook
    webhook: "${SLACK_WEBHOOK_URL}"
  }
  api {
    type: http
    port: 8080
    auth: "${API_TOKEN}"
  }
  discord {
    type: webhook
    webhook: "${DISCORD_WEBHOOK_URL}"
    channel: "agent-updates"
  }
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `type` | identifier | no | -- | Interface type (webhook, http, sse, email) |
| `*` | value | no | -- | Additional config fields (opaque, passed to binding) |

**Security:** Fields named `webhook`, `auth`, `token`, or `secret` that contain literal values (not `${ENV_VAR}` references) are a validation error (V21). This reuses the same secret detection pattern as provider `api-key` fields (V16).

**Binding behavior:** OpenClaw maps interfaces to `channels` in `openclaw.json`. Other bindings document interfaces in their instructions files. The interface block is intentionally open-ended -- bindings may interpret or ignore any field.

---

### 4.28 `sandbox` (settings and agent field)

The `sandbox` field specifies execution sandboxing for the topology or individual agents. It appears as a field inside `settings {}` (topology-wide default) or directly on an `agent {}` block (per-agent override).

```agenttopology
settings {
  sandbox: docker
  allow: [Read, Write, Bash]
}

agent analyzer {
  model: sonnet
  sandbox: network-only
}
```

**Valid values:** `true`, `false`, `docker`, `none`, `network-only`

**Binding behavior:** Claude Code maps `settings { sandbox: true | false }` to `sandbox.enabled` in `.claude/settings.json`; another value, and an agent's `sandbox` (Claude Code has no per-agent sandbox), is not written there (V130 warning). Finer sandbox keys go in `extensions { claude-code { sandbox.<key>: value } }`. Codex maps to `[sandbox] type` in `codex.toml`. OpenClaw maps to `sandboxDefaults` in `openclaw.json`. Gemini CLI maps to the `sandbox` field in `.gemini/settings.json`. Other bindings include it in agent frontmatter or documentation.

**Agent override:** When `sandbox` appears on an agent, it overrides the topology-level default for that agent only.

---

### 4.29 `fallback-chain` (settings and agent field)

The `fallback-chain` field specifies an ordered list of model identifiers to try when the primary model is unavailable. It appears as a field inside `settings {}` (topology-wide default) or directly on an `agent {}` block (per-agent override).

```agenttopology
settings {
  fallback-chain: [opus, sonnet, haiku]
}

agent expensive-thinker {
  model: opus
  fallback-chain: [sonnet, haiku]
}
```

**Semantics:** When the primary model (from the `model` field) fails or is unavailable, the binding should attempt models in the fallback chain in order. This is distinct from `providers` -- providers define WHERE to route, fallback-chain defines WHAT to try.

**Validation:** When providers are declared, every model in a fallback chain should exist in at least one provider's `models` list (V22, warning level).

**Binding behavior:** Claude Code maps the `settings` chain to `fallbackModel` in `.claude/settings.json` when every entry is a Claude Code model (Claude Code uses the first three). Claude Code has no per-agent chain, so an agent's `fallback-chain` is not written there (V130 warning). OpenClaw maps to `modelFallbackChain` in `openclaw.json`. Other bindings document the chain in their instructions or agent files.

### 4.30 `inventory`

```ebnf
inventory       = 'inventory' '{' (roots-field | strict-field)* '}'
roots-field     = 'roots' ':' string-list
strict-field    = 'strict' ':' ('true' | 'false')
```

```agenttopology
inventory { roots: ["harness/", "scripts/"] }
```

With `strict: true`, `validate --inventory` exits 1 when a live file is not in the .at and not covered by an island (4.32); today it lists them and exits 0. Hooks, servers, scripts and jobs are not files and do not count.

Extra project folders whose files a run really reads. `agentopology inventory --at <file.at>` and `validate --inventory` list every file under each root as a live thing of kind `file` (id `file:<path>`), and a file counts as mapped when the topology points at it (a hook's or gate's `run:`, `file:`, `at:`, a tool's `script:`). A root that is not a folder on disk is reported as missing (exit 1). Each root must be a path inside the project: absolute paths, home paths (`~`) and `..` are a validate error (V128). Bindings emit nothing for it.

`validate --inventory DIR a.at b.at` measures several topologies against one project: the per-file numbers print first, then one union number in which a live thing is mapped when any file maps it. `--user` (on `validate --inventory` and on `inventory`) also lists the user-level tree (`~/.claude/agents`, `skills`, `commands` and the hooks in `~/.claude/settings.json`), tagged user-level (`scope: "user"`, ids prefixed `user:`) and counted apart from the project numbers.

### 4.31 `needs`

```ebnf
needs           = 'needs' '{' (memory-field | connectors-field | user-skills-field | plugins-field)* '}'
memory-field    = 'memory' ':' string
connectors-field = 'connectors' ':' name-list
user-skills-field = 'user-skills' ':' name-list
plugins-field   = 'plugins' ':' name-list
```

```agenttopology
needs {
  memory: "~/notes/agent-memory"
  connectors: [gmail, calendar]
  user-skills: [writer]
  plugins: [my-plugin]
}
```

What the topology needs that lives outside the repo. `validate` lists every entry under "declared outside the repo". `memory` is a path under the user's home, written `~/<path>`; `user-skills` are skills expected at `~/.claude/skills/<name>`; `connectors` are account connectors. Validate rejects a memory path that is absolute (other than `~/`) or holds `..`, and a skill or connector name that is a path (V129). With `validate --inventory ... --user`, a declared user skill and a memory path count as mapped when they exist under the home folder and as missing (exit 1) when they do not; connectors cannot be checked locally and print `not checked (account connector)`, never mapped. Without `--user` the home folder is not read. Bindings emit nothing for it.

`plugins` names plugins expected under `~/.claude/plugins`; a name is a bare name (V129). With `--user`, each is reported `installed` when `installed_plugins.json` lists it (`<name>` or `<name>@<marketplace>`) or a folder of that name is under `~/.claude/plugins/` or `~/.claude/plugins/cache/<marketplace>/`, and `missing` (exit 1, as for a missing user skill) when not.

### 4.32 `threat-model`

```ebnf
threat-model    = 'threat-model' '{' (untrusted-field | outside-field | refuse-field | lift-field)* '}'
untrusted-field = 'untrusted' ':' '[' untrusted-entry (',' untrusted-entry)* ']'
untrusted-entry = 'web' | 'mcp:' identifier | string          (* a path glob *)
outside-field   = 'outside-sandbox' ':' string-list
refuse-field    = 'refuse-after-untrusted' ':' string-list    (* permission rules, as in settings { deny } *)
lift-field      = 'lift' ':' identifier                       (* a human step *)
```

```agenttopology
threat-model {
  untrusted: [web, mcp:crm, "inbox/**"]
  refuse-after-untrusted: ["Bash(git push *)", "SendMessage"]
  outside-sandbox: ["npm"]
  lift: owner
}
```

Inputs the session cannot trust, and what is held back once one has been read. `web` is the WebFetch and WebSearch tools; `mcp:<id>` is every tool of a server declared in `mcp-servers { }`; a quoted path glob is a read of a matching file by Read, Grep or Glob. An MCP server written `trust: untrusted` is added to the list (`trust:` takes `untrusted` or `trusted`). Entries of `refuse-after-untrusted` are permission-rule strings in the `settings { deny }` form (`Tool` or `Tool(specifier)`).

claude-code writes two hooks. `taint-mark.sh` (PostToolUse, on the untrusted tools) writes `.claude/state/taint/<session_id>` with the source and time, reading the session id from the hook's stdin JSON. `taint-guard.sh` (PreToolUse, on the tools the rules name) refuses with exit 2, naming the source, a call that matches a rule while the session's mark exists. The mark ends only in a new session (a new session id has no mark), or for one act when the human named in `lift:` has an ok row in `.claude/state/approvals.jsonl` whose `act` equals the rule string and whose `at` is not older than the mark; a later untrusted read marks again. There is no blanket clear. The mark folder and the approvals file are refused to the agent by the before-edit and before-action guards. `outside-sandbox` entries that are commands go to `sandbox.excludedCommands`, and entries that are paths (a leading `/` or `~`, a trailing `/`, or a `*`) to `sandbox.filesystem.allowWrite`; Claude Code reads them only with `settings { sandbox: true }`. An agent's `sandbox:` field is still not written (V130).

Validate (V138) errors on an `untrusted` entry that is none of the three forms, an `mcp:<id>` naming no declared server, a `lift` naming no declared human, and a refuse rule that is not a permission rule. Codex and Cursor write nothing for it; `validate --target codex|cursor` warns.

### 4.32a `egress`

```ebnf
egress          = 'egress' '{' gate-field covers-field '}'
gate-field      = 'gate' ':' identifier                       (* a human with word:, or a record *)
covers-field    = 'covers' ':' '[' cover (',' cover)* ']'
cover           = 'observability' | 'web' | 'network' | 'mcp'
```

```agenttopology
egress {
  gate: owner-go
  covers: [observability, web, network, mcp]
}
```

What leaves the machine is held until the gate clears; local work is not. The gate is a human with a `word:` (cleared when the last row for its step in every go ledger is ok and not a halt) or a record (cleared by any row in its file; V160 refuses a record path with `{unit}`). claude-code writes `egress-guard.sh`, a PreToolUse hook, which refuses until then: `web`: WebFetch and WebSearch; `mcp`: every `mcp__*` tool; `network`: a Bash command whose program, by its first word, is `curl`, `wget`, `nc`, `ncat`, `netcat`, `ssh`, `scp`, `sftp`, `telnet`, `ftp`, `rsync` with a host (`host:path`, `rsync://`), `git push|fetch|pull|clone`, or `npm publish|install|i|ci|add`, after assignments, shell keywords and wrappers (sudo, env, timeout, xargs, ...), read through `sh -c`, `bash -c` and `eval`, with quotes honored and heredoc bodies skipped unless fed to a shell. `observability`: the telemetry env of `observability { }` is left out of `.claude/settings.json`; `egress-observability.sh` (SessionStart) merges it into `.claude/settings.local.json` once the gate has cleared, so the export begins with the next session. `git status`, `git commit`, `npm test`, `ls` and the like are never held. This is a text check of a tool name and a first word, not a firewall: it does not see pnpm, yarn, pip, a script that runs curl, an interpreter opening a socket, or a program an expansion hides; those are the sandbox's class. V160 refuses a missing or unknown gate and an empty or unknown `covers`.

### 4.33 `rules`

```ebnf
rules           = 'rules' '{' rule-decl* '}'
rule-decl       = 'rule' string '{' 'text' ':' string ('source' ':' string)? '}'
```

```agenttopology
rules {
  rule "R-7.6" {
    text: "Never publish a draft without a second read."
    source: "editorial handbook, section 7"
  }
}
```

Conduct rules traced to their ids. The id is a quoted string and may hold dots; each id appears once, and `text` is required and never empty (V143). `source` says where the rule comes from. A second `rules { }` block is ignored with a V23 warning.

A gate or a hook may cite a rule with `rule: "<id>"`; an id the block does not declare is an error (V144). The citation is a trace, not enforcement.

claude-code writes a `## Rules` section, one entry per rule with its id, between `<!-- agentopology:rules -->` markers into the entry agent's file (the `meta { entry }` agent), or into the topology skill when there is no entry agent; text outside the markers is the user's. A cited rule is written as `Rule: <id>` in the gate's section and listed beside the gate by `guard --check`. codex writes the same section into AGENTS.md. `validate` prints `rules: N declared (<ids>)`.

### 4.34 `islands`

```ebnf
islands         = 'islands' '{' island* '}'
island          = 'island' id '{' path-field owner-field test-field? '}'
path-field      = 'path' ':' string
owner-field     = 'owner' ':' id
test-field      = 'test' ':' string
```

```agenttopology
person ana { away: "2026-01-01..2026-01-02" }
islands {
  island core {
    path: "harness/core/**"
    owner: ana
    test: "npm run test:core"
  }
}
```

A region of the project one person owns. `path` is a glob over project-relative paths: `**` crosses folders, `*` and `?` stay in one. A live file the glob matches counts as accounted for in `validate --inventory`, which lists each island with its owner and file count. The owner must be a declared `person`, and a path is required (V147). `test` is a command: `guard --check` lists it and never runs it. Bindings emit nothing for it.

### 4.35 `meta { requires }`

`meta { requires: ">=0.13.0" }` names the agentopology versions the file is written for: comparators `>=`, `<=`, `>`, `<`, `=` or `^` before `x.y.z`, separated by blanks, all of which must hold (`^0.13.0` is `>=0.13.0 <0.14.0`; `^1.2.3` is `>=1.2.3 <2.0.0`). Every command that reads the file checks it against the running package first and exits 1 with a message naming both when it does not match. A value that is not a range is a V148 error, reported by `validate`.

### 4.36 `secrets` and `never-reads`

```ebnf
secrets         = 'secrets' '{' secret* '}'
secret          = 'secret' id '{' 'path' ':' string ','? 'readers' ':' name-list '}'
```

```agenttopology
secrets {
  secret prod-config { path: "config/prod/**", readers: [deployer, main] }
}
agent reviewer {
  never-reads: [".env", "private/**"]
}
```

Per-agent walls on what can be read. `never-reads` on an agent lists path globs that agent may not read. A `secret` names a path glob (project-relative; `**` and `*` match across folders, a pattern with no `/` also matches a file name anywhere) and the `readers` that may read it: agent ids, or `main` for the main session. Every other agent, and the main session unless `main` is listed, is refused. A reader that is not a declared agent or `main` is an error (V153); a secret with no `path` is an error (V154).

Claude Code compiles this to one generated PreToolUse hook on `Read|Grep|Glob|Bash` (`before-read.sh`) that exits 2 on a match. The calling agent is `agent_type` in the hook input, which Claude Code sets when the call comes from a subagent or from a session started with `--agent`, and leaves out in the plain main session. The paths checked are Read `file_path`, Grep `path` and `glob`, Glob `path` and `pattern`, and the words of a Bash command. A Bash command can hide a path from this check: one built in a variable or substitution, one reached after `cd`, one a script opens itself, a search from a folder above the protected one. Other targets write nothing for it.

### 4.37 `ci`

```agenttopology
ci {
  provider: github
  on: [pull_request, push]
  gates: [publish-ready]
}
```

`ci { provider: github, on: [<event>, ...], gates: [<gate id>, ...] }` runs the gates in CI. Fields sit one per line or, on one line, apart by commas. `provider` is required and must be `github`. `on` lists the events that start the workflow; it defaults to `[pull_request, push]`. `gates` lists declared gates, each with a `before:` step. For the claude-code target, scaffold writes `.github/workflows/agentopology-gates.yml`: it checks out the repo, sets up Node and runs `npx agentopology@<the running version> step check <file.at> <step>` for the step after each listed gate (each step once). Scaffold regenerates the file while it is as scaffold wrote it and keeps it once you edit it. A provider other than `github`, an undeclared gate id, or a gate with no step after it is an error (V155).

---

## 5. Validation Rules

See `validation.md` for the complete list of 35 validation rules with examples.

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
| `agent` | `memory` | `[]` |
| `agent` | `retrieval` | -- (none) |
| `agent` | `skills` | `[]` |
| `agent` | `mcp-servers` | `[]` |
| `agent` | `background` | `false` |
| `agent` | `hooks` | -- (none) |
| `agent` | `max-turns` | -- (none) |
| `agent` | `max-subagents` | -- (no cap) |
| `agent` | `max-cost` | -- (no cap) |
| `agent` | `wall-time` | -- (no cap) |
| `agent` | `sandbox` | -- (none) |
| `agent` | `fallback-chain` | `[]` |
| `agent` | `extensions` | -- (none) |
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
| `settings` | `sandbox` | -- (none) |
| `settings` | `fallback-chain` | `[]` |
| `schedule.job` | `enabled` | `true` |
| `mcp-server` | `url` | -- (none) |
| `mcp-server` | `command` | -- (none) |
| `mcp-server` | `args` | `[]` |
| `mcp-server` | `env` | `{}` |
| `tool` | `args` | `[]` |
| `tool` | `lang` | `auto` |
| `tool` | `description` | -- (none) |
| `context` | `file` | binding-dependent |
| `context` | `includes` | `[]` |
| `skill` | `disable-model-invocation` | -- (none) |
| `skill` | `user-invocable` | -- (none) |
| `skill` | `context` | -- (none) |
| `skill` | `agent` | -- (none) |
| `skill` | `allowed-tools` | `[]` |
| `skill` | `extensions` | -- (none) |
| `gate` | `extensions` | -- (none) |
| `hook` | `extensions` | -- (none) |
| `meta` | `domain` | -- (none) |
| `meta` | `entry` | -- (none: Claude Code's own main agent) |

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

| Universal | Claude Code `permissionMode` | Description |
|-----------|-------------|-------------|
| `autonomous` | omitted (the session's own mode) | Read-write without confirmation |
| `supervised` | `plan` | Read-only, proposes changes |
| `interactive` | omitted (asks; `acceptEdits` before 0.12.2) | Asks before each action |
| `unrestricted` | `bypassPermissions` | No permission checks |
| `auto` | `auto` | Claude Code's auto mode, not a short form of `autonomous` (V132) |

Claude Code's own values (`default`, `acceptEdits`, `dontAsk`, `plan`, `auto`, `bypassPermissions`) pass through as written.

### Available bindings

| Binding | Status | Target |
|---------|--------|--------|
| `claude-code` | Stable | Claude Code agent files, settings, MCP config (the event-driven HOST layer) |
| `claude-workflow` | Experimental | Claude Workflow tool script (`<topology>.workflow.js`) for the deterministic fan-out rung, plus SEAM/README/LOSSY-REPORT companion files |
| `codex` | Experimental | Codex agent definitions and config |
| `cursor` | Experimental | Cursor rules and agent config |
| `gemini-cli`, `copilot-cli`, `openclaw`, `kiro` | Removed in 0.10.0 | Use agentopology 0.9.x |
| `agent-sdk` | Planned | Anthropic Agent SDK tool definitions |
| `e2b` | Planned | E2B sandbox configuration |
| `openai-swarm` | Planned | OpenAI Swarm agent definitions |

**The `claude-code` + `claude-workflow` hybrid.** A single `.at` topology can compile to BOTH targets. `claude-code` is the HOST — the event-driven layer that owns agents, hooks, the Blackboard, concurrent observability, and the human/gate/branching nodes. `claude-workflow` is the embedded DETERMINISTIC rung — the parallel fan-out phases. They couple through the Blackboard files (`memory.workspace`): the host launches the rung and observes its Blackboard writes via a `PostToolUse` hook, giving concurrent observability the Workflow runtime can't do internally. The seam is opt-in: a phase joins the rung only when its agents carry `extensions { claude-workflow { execution: workflow } }`. Topologies with no such marker compile to pure `claude-code` exactly as before (backward compatible). See `docs/AT_VS_WORKFLOW_STRATEGY.md` for the rationale and `docs/bindings/claude-workflow-mapping.md` for the full primitive mapping.

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
