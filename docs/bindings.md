# Creating AgenTopology Bindings

Created by Nadav Naveh

A binding is a code module that reads a parsed `.at` topology and generates platform-specific output. The `.at` spec defines WHAT to generate. Bindings define HOW for each platform.

---

## The BindingTarget Interface

Every binding implements the `BindingTarget` interface:

```typescript
interface BindingTarget {
  /** Unique identifier for this binding (e.g., "claude-code", "agent-sdk") */
  name: string;

  /** Generate all platform-specific files from a parsed topology */
  scaffold(topology: ParsedTopology, outputDir: string): GeneratedFiles;

  /** Map an abstract model identifier to a platform-specific model string */
  resolveModel(modelId: string): string;

  /** Map a universal permission to a platform-specific permission mode */
  resolvePermission(permission: string): string;

  /** Map a universal hook event to platform-specific event name(s) */
  resolveHookEvent(event: string): string | string[];

  /** Validate that the topology is compatible with this platform */
  validate(topology: ParsedTopology): ValidationError[];
}
```

---

## What scaffold() Should Generate

The `scaffold()` method produces all the files a platform needs to run the topology. At minimum, a binding generates:

1. **Agent definitions** -- one file per agent with model, tools, permissions, and instructions
2. **Orchestrator logic** -- the flow graph translated to the platform's execution model
3. **Permission configuration** -- the `settings` block mapped to the platform's permission system
4. **MCP server configuration** -- the `mcp-servers` block mapped to the platform's integration format
5. **Hook configuration** -- the `hooks` block mapped to the platform's event system

The `scaffold()` method returns a `GeneratedFiles` object:

```typescript
interface GeneratedFiles {
  files: Array<{
    path: string;        // relative to outputDir
    content: string;     // file contents
    overwrite: boolean;  // whether to replace existing files
  }>;
}
```

---

## Mapping Blocks to Platform Files

Here is how each `.at` block type maps to platform output. A binding must handle all of these:

### Agents

Each `agent` block produces one agent definition file. The binding maps:

| `.at` field | What to generate |
|-------------|-----------------|
| `model` | Platform's model selection field |
| `tools` | Tool allowlist in platform format |
| `disallowed-tools` | Tool denylist in platform format |
| `permissions` | Platform's permission mode |
| `prompt` | Body content of the agent file |
| `isolation` | Platform's isolation mechanism |
| `memory` | Platform's persistent memory config |
| `skills` | Platform's skill/plugin loading |
| `mcp-servers` | Platform's MCP server access |
| `background` | Platform's background execution |
| `hooks` | Per-agent hooks in platform format |

### Flow

The `flow` block defines the execution graph. Bindings translate this into:
- Sequential execution logic
- Conditional branching based on outputs
- Fan-out parallel execution
- Loop handling with max bounds

### Gates

Gates are injected between flow nodes. The binding generates:
- Script execution at the gate point
- Retry logic
- Failure handling (halt or bounce-back)

### Settings

The `settings` block maps to the platform's global permission configuration:
- `allow` -> tools that run without confirmation
- `deny` -> tools that are blocked
- `ask` -> tools that require confirmation

### MCP Servers

The `mcp-servers` block produces the platform's MCP configuration file. Each server entry maps to a server definition with type, command/url, args, and env.

### Hooks

The `hooks` block maps to the platform's event system. The binding must:
1. Map universal events (`AgentStart`, `AgentStop`, `ToolUse`, etc.) to platform events
2. Handle platform-specific events if accepted
3. Generate hook configuration in the platform's format

---

## Model Resolution

Bindings map model identifiers to platform-specific strings. The `.at` spec allows any identifier matching `[a-z][a-z0-9-/.]*` as a model.

A binding should:
1. Recognize its own model aliases (e.g., a Claude binding knows `opus`, `sonnet`, `haiku`)
2. Pass through unknown identifiers (e.g., `gpt-4o` passes through in an OpenAI binding)
3. Map `inherit` to the orchestrator's model

Example model resolution:

```typescript
function resolveModel(modelId: string): string {
  const aliases: Record<string, string> = {
    "opus": "claude-opus-4-20250514",
    "sonnet": "claude-sonnet-4-20250514",
    "haiku": "claude-haiku-3-5-20241022",
  };
  return aliases[modelId] || modelId;
}
```

---

## Permission Resolution

The spec defines four universal permission levels. Bindings map these to platform-specific modes:

| Universal | Meaning |
|-----------|---------|
| `autonomous` | Read and write without confirmation |
| `supervised` | Read freely, propose writes for approval |
| `interactive` | Confirm all actions |
| `unrestricted` | No permission checks |

Example:

```typescript
function resolvePermission(permission: string): string {
  const mapping: Record<string, string> = {
    "autonomous": "auto",
    "supervised": "plan",
    "interactive": "confirm",
    "unrestricted": "bypass",
    // Accept short aliases too
    "auto": "auto",
    "plan": "plan",
    "confirm": "confirm",
    "bypass": "bypass",
  };
  return mapping[permission] || permission;
}
```

---

## Hook Event Resolution

Universal events must be mapped to platform-specific event names:

| Universal | Example platform mapping |
|-----------|------------------------|
| `AgentStart` | `SubagentStart` (Claude Code) |
| `AgentStop` | `SubagentStop` (Claude Code) |
| `ToolUse` | `PreToolUse`, `PostToolUse` (Claude Code) |
| `Error` | `PostToolUseFailure` (Claude Code) |
| `SessionStart` | `SessionStart` (Claude Code) |
| `SessionEnd` | `Stop` (Claude Code) |

Note that `ToolUse` may map to multiple platform events. The binding decides whether to register for pre-use, post-use, or both.

---

## Example: Mapping an Agent Block

Given this `.at` agent:

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
    confidence: high | medium | low
  }
}
```

A Claude Code binding would generate `.claude/agents/writer/AGENT.md`:

```markdown
---
model: claude-sonnet-4-20250514
permissionMode: auto
tools:
  - Read
  - Write
  - Glob
description: "Draft content based on research findings"
---

[contents of prompts/writer.md]
```

An Agent SDK binding would generate `agents/writer.json`:

```json
{
  "name": "writer",
  "model": "claude-sonnet-4-20250514",
  "tools": ["Read", "Write", "Glob"],
  "instructions_file": "prompts/writer.md",
  "outputs": {
    "confidence": ["high", "medium", "low"]
  }
}
```

---

## Existing Bindings

| Binding | Status | Target | Description |
|---------|--------|--------|-------------|
| `claude-code` | **Stable** | Claude Code | Generates `.claude/agents/`, `.claude/settings.json`, `.mcp.json` — the event-driven HOST layer |
| `claude-workflow` | Experimental | Claude Workflow | Compiles the deterministic fan-out phases into `<topology>.workflow.js`, plus SEAM/README/LOSSY-REPORT companion files |
| `codex` | Experimental | Codex | Codex agent definitions and config; every guard is graded `unverified` in release 1, `none` where Codex has no blocking event |
| `cursor` | Experimental | Cursor | Cursor rules and agent config |
| `gemini-cli`, `copilot-cli`, `openclaw`, `kiro` | Removed in 0.10.0 | — | Use agentopology 0.9.x |
| `agent-sdk` | Planned | Anthropic Agent SDK | Tool definitions and agent configs for the Agent SDK |
| `e2b` | Planned | E2B | Sandbox configuration and tool registration |
| `openai-swarm` | Planned | OpenAI Swarm | Swarm agent definitions and handoff logic |

---

## The `codex` Binding

`codex` is experimental. It is written against Codex CLI 0.156.1. A project scaffolded with `--target codex` gets:

| File | What it holds |
|------|---------------|
| `.codex/config.toml` | `model`, `approval_policy` (`on-request` or `never`), `sandbox_mode`, `[mcp_servers.<id>]` (with `env` as its own table), `[agents]` |
| `.codex/agents/<id>.toml` | `name`, `description`, `developer_instructions`, and `model` / `model_reasoning_effort` when set |
| `.codex/hooks.json` | The topology's `hooks {}` block, for the events and handler types Codex runs |
| `.codex/scripts/<topology>/before-action.sh`, `before-agent.sh`, `gate-<id>.sh` | The guards for gates and approval steps, registered in `hooks.json` (see "Gates and approvals" below) |
| `.codex/rules/<topology>.rules` | `settings { allow / ask / deny }` entries of the form `Bash(command *)` as `prefix_rule(...)` |
| `scripts/schedule-<job>.sh`, `crontab.fragment` | Schedule jobs with `carrier: cron` that run an agent, through `codex -a never exec --sandbox <mode>` |

What to know:

- **Models.** Codex runs no Claude model. `scaffold --target codex` refuses `opus`, `sonnet`, `haiku`, `fable` and `claude-*`, names the agent, exits 1 and writes nothing. Set a Codex model such as `gpt-5.2`.
- **One approval policy per project.** Codex has no per-agent approval policy or sandbox: an agent file cannot override either. When agents differ in `permissions`, the strictest applies to all and scaffold warns. `sandbox:` and `mcp-servers:` on an agent are not written to its file; MCP servers are written once in `config.toml`.
- **Hooks need trust.** Codex skips a new or changed hook until you review it with `/hooks`. A matcher that names Claude tools is rewritten to Codex's names: `Edit`, `Write`, `MultiEdit` to `apply_patch`, `Task`, `Agent` to `collaborationspawn_agent`; a Claude tool with no Codex equivalent (`Read`, `Grep`, `WebFetch`, ...) gets a `CX8-tool` warning. A hook's `if: "Tool(pattern)"` is kept through `.codex/scripts/at-if.sh`, which needs `jq`. On `apply_patch` it matches every path the patch adds, updates, deletes or moves to, relative to the project root; on a `strength: refuse` hook, input it cannot read, or a command that cannot run, blocks. A hook on an event Codex lacks, a `prompt` / `agent` / `http` handler, or a per-agent hook gets a warning and no entry. Codex itself calls tool hooks a guardrail, not a complete enforcement boundary.
- **Providers are not written.** A project `.codex/config.toml` may not set `model_providers`, `notify`, `profiles`, `otel` and a few other keys; set them in your user config.
- **What Codex cannot express** (sampling settings, a thinking token budget, output format, max turns, fallback chain, rate limit and more) gives one `validate` warning per field. Run `agentopology validate` with a Codex target, or read the warnings `scaffold` prints.
- **`codex exec` is read-only by default.** A scheduled job whose agent writes, in a topology that names no sandbox, gets a warning and runs with `--sandbox read-only`. Set `settings { sandbox: workspace-write }`.

### Gates and approvals on Codex

Gates are held by hook scripts, written by the same library as for Claude Code and registered in `.codex/hooks.json`. A guard's hook timeout is 120 seconds, or more when its gates can run longer (timeout x attempts, plus a margin; `validate` warns with `CX9-timeout`), and the hook command cuts the run 10 seconds before that timeout and exits 2, because Codex lets a timed-out hook's call run. The deadline uses GNU `timeout` or `gtimeout`; without either, only the hook timeout bounds the run:

- `before-action.sh` (a `PreToolUse` hook on `Bash`) refuses a script step's command, also inside an `&&` or `;` chain, a subshell, `$(…)` or backticks, behind a prefix (`if`, `!`, `sudo`, `nice`, `env -i`, `xargs`, `bash -c`, `eval`), with extra spaces or quotes, or by another path to the program, until the gate's ledger shows its `after:` step finished ok for the same unit. It over-blocks on purpose: `echo ./tool publish ep1` is refused too while the gate is unmet. A step named through a variable, an alias or another script is not seen. **Placeholders:** a step's command is matched on its words up to the first placeholder, and the placeholder and everything after it are left out. A placeholder is an ALL-CAPS word (`EP`, `PID`, `SLUG`, or `OUT.mp4`-style `UPPER.ext`) or a word holding `<`, `>`, `{`, `}`, `[` or `]`. So `commands: ["./media episode render EP.json OUT.mp4"]` refuses `./media episode render show/ep7/ep.json out.mp4` and lets `./media episode list` run. `validate` warns (`AG-placeholder`) for each guarded command it cuts this way, naming the words it matches on. The same rule holds on Claude Code.
- `before-agent.sh` (a `PreToolUse` hook on the subagent spawn tool, `collaborationspawn_agent`) runs the gate scripts that stand before an agent. It matches on `agent_type`, which Codex sets to the agent file's `name`, trimmed and lowercased.
- `gate-<id>.sh` runs when the agent it follows stops (`SubagentStop`). Codex cannot block a stop, so that hook only reports. A gate between two agents (`after: writer, before: reviewer`) is held by `before-agent.sh` instead: it refuses to spawn `reviewer` until the gate script passes. A gate after the last agent, with no agent or script step after it, has no blocking event at all: it is graded `none`, `AGENTS.md` says so, and `validate` / `scaffold` warn with `CX9-noblock`.

Every script scaffold writes as a placeholder (a tool's script, a hook's or gate's check, on both targets) carries the `AGENTOPOLOGY_STUB` marker and fails until it is written: exit 2 for a check that must refuse, exit 1 otherwise, so a gate that runs an unwritten script blocks instead of passing. Codex lets a command run when a `PreToolUse` hook exits 1, exits 127 or times out. Only exit 2 blocks. Every generated guard therefore turns any error of its own into exit 2 with a reason on stderr: a missing `jq`, input that is not JSON, an unreadable ledger, a gate script that cannot start. The hook command itself climbs from the repository root (or the current folder) to find its script, so a nested git repository or a project outside git still runs the guard; a script found nowhere above exits 2.

**An approval step cannot ask.** A Codex `PreToolUse` hook may answer only `allow` or `deny`; `ask` makes the hook fail, and no generated script prints it. A `human` step before an agent instead blocks the spawn (exit 2) until `.codex/state/approvals.jsonl` holds an approval record as the step's last line: `{"step":"<id>","ok":true,"at":"<time>"}`. The block message, which the model reads, says a person must add the record and names no command; the command is in the generated `AGENTS.md` under Human Checkpoints. Under `workspace-write`, Codex does not let the agent write inside `.codex/` (measured on 0.156.1), so the agent cannot approve itself there. Under `danger-full-access`, or with no sandbox and `approval_policy = "never"`, it can, and `validate --target codex` warns with `CX11-forgeable`.

**Every Codex guard is unverified in release 1.** `AGENTS.md`, the gate wrappers and `guard --check` grade every Codex guard `unverified`, never `hook` or `refuse`, and `none` where Codex has no event that can block. Three facts measured live on Codex CLI 0.156.1 (13 Nov 2026) are why:

1. The hooks of an untrusted project are skipped silently, with no message on the `--json` stream or on stderr (probe P7). A guard holds only after you trust the hooks: open `/hooks` in Codex and trust the hooks in `.codex/hooks.json` after every scaffold (the generated `AGENTS.md` names this step). agentopology never writes a trust entry.
2. `codex exec` waits on stdin ("Reading additional input from stdin...") unless stdin is closed, so a scripted run needs `< /dev/null`.
3. A quoted project trust override, `-c 'projects."<path>".trust_level="trusted"'`, is ignored as an "unrecognized configuration setting". The unquoted `projects.<path>.trust_level` form is the one the probe script uses.

Until a live run proves a guard holds under those conditions, none is graded `refuse`. Hooks also see only the tools Codex runs through its hook layer: `apply_patch` and MCP tools need their own matchers, and a hook is a guardrail, not a sandbox.

`agentopology guard <file.at> --check [--target codex] [--dir <project>]` grades a Codex project from `.codex/hooks.json` and `.codex/scripts/` (it is picked without `--target` when the project has `.codex/` and no `.claude/`). It writes nothing, on any target. A guard whose entry and scripts are on disk reads `unverified`; one that is missing reads `none` and the exit is 1; a gate with no blocking event reads `none` but does not fail the check, since no file can fix it.

`agentopology guard <file.at> --target codex [--dir <project>]` writes only these guards into a project built by hand: the guard scripts and their `hooks.json` entries, merged with the hooks already there. It also writes the check script each gate runs, as a failing stub, when it is missing; an existing one is never overwritten. It does not touch `AGENTS.md`, `config.toml`, agent files or skills, and a second run changes nothing. On a rescaffold, `hooks.json` is merged: a group whose command names one of the topology's `.codex/scripts/…` files is replaced by what the topology generates now, and every other group is kept.

### Conformance tests for Codex

`src/__tests__/e2e/codex-conformance.test.ts` checks every example and fixture, with no model call: **A** the generated `config.toml` and agent files against the key list in `spec/codex/config-keys.json`; **B** `hooks.json` against the hook contract (events, matchers, handler types, timeouts, anchored script paths); **C** every generated command hook run from a subfolder with Codex's hook payload; **D** `codex execpolicy check` for each generated rule, `codex sandbox` for a write outside the workspace, and `--strict-config` on the generated config. Tier D is skipped, with a message, when `codex` is not installed.

---

## The `claude-workflow` Binding

`claude-workflow` is the second half of a **hybrid** that pairs with `claude-code`. One `.at` topology can compile to both targets.

```bash
agentopology scaffold my-team.at --target claude-workflow
```

**What it emits:**

- `<topology>.workflow.js` — a Claude Workflow tool script (`export const meta`, `parallel()` / `agent()` calls, `schema`, `isolation: 'worktree'`) for the deterministic fan-out phases.
- `<topology>-SEAM.md` — the Blackboard hand-off contract between the host and the rung.
- `<topology>-README.md` — the human-node split (what the host owns vs. what the rung runs).
- `<topology>-LOSSY-REPORT.md` — a loud, explicit list of anything that couldn't be translated to the Workflow model. Nothing is silently dropped.

**The seam marker.** A phase joins the deterministic rung only when its agents carry:

```agenttopology
extensions {
  claude-workflow {
    execution: workflow
  }
}
```

**The hybrid model.** `claude-code` is the HOST — the event-driven layer that owns agents, hooks, the Blackboard, concurrent observability, and the human/gate/branching nodes. `claude-workflow` is the embedded DETERMINISTIC rung — the parallel fan-out. They couple through the Blackboard files (`memory.workspace`): the host launches the rung and observes its Blackboard writes via a `PostToolUse` hook, giving concurrent observability the Workflow runtime can't do internally.

**Backward compatible.** Topologies with no `execution: workflow` marker compile to pure `claude-code`, exactly as before — the hybrid is opt-in.

See [`docs/bindings/claude-workflow-mapping.md`](bindings/claude-workflow-mapping.md) for the full primitive mapping and [`docs/AT_VS_WORKFLOW_STRATEGY.md`](AT_VS_WORKFLOW_STRATEGY.md) for the rationale. The dogfood example is [`examples/matchmat-ship.at`](../examples/matchmat-ship.at).

---

## Testing a Binding

To verify your binding works correctly:

1. **Round-trip test** -- scaffold a topology, then verify the generated files parse correctly on the target platform
2. **Validation test** -- ensure `validate()` catches incompatibilities (e.g., platform doesn't support `isolation: worktree`)
3. **Model resolution test** -- verify all common model identifiers resolve correctly
4. **Permission resolution test** -- verify all four universal permissions map to valid platform modes
5. **Hook event test** -- verify all six universal events map to platform events

```bash
agentopology scaffold examples/simple-pipeline.at --target your-binding --dry-run
```

The `--dry-run` flag prints generated files without writing them, useful for testing.
