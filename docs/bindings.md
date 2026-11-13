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

**Known gap: the agent can write a gate's ledger (F-4).** A gate's ledger (`records { record trace { path: "logs/{unit}/trace.jsonl" } }`) and the Codex approval record (`.codex/state/approvals.jsonl`) are files in the workspace, and the guards trust an ok line in them. On both targets the generated guards narrow this: `before-action.sh` refuses a `Bash` command that names a ledger (its path with `{unit}` as `*`, or the letters of its file name anywhere in the command, so `tr""ace.jsonl` and `f=trace.jsonl; echo x >> logs/ep1/$f` are caught) unless every program in it only reads its arguments and it holds no `>` and no `tee` (`cat` and `jq .` still run); `before-edit.sh`, a `PreToolUse` hook on `Write|Edit|MultiEdit|NotebookEdit` on Claude Code and on `apply_patch` on Codex (every `*** Add File`, `Update File`, `Delete File` and `Move to` path in the patch), refuses an edit of a ledger. Both are written whenever a gate has a ledger, or a Codex approval step exists, with or without a guarded step. A write through a path the guard cannot see (a variable set elsewhere, another script) still gets through, so `guard --check` and the generated docs say so on the grade itself: `refuse, ledger agent-writable until the signed gate` on Claude Code, `unverified, ledger agent-writable until the signed gate` on Codex. The signed gate in the next release closes this.

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
4. Make a `strength: refuse` hook fail closed: where the platform lets a hook that cannot start or times out through, the binding asks for the strongest block it has

On Claude Code, the script scaffold writes for a gated step (`.claude/skills/<topology>/scripts/action-<step>.sh`) checks the step's gates itself before it runs anything: it hands each of its commands, with the script's arguments (the unit), to `before-action.sh`, the same check the `PreToolUse` hook on Bash makes, and exits 2 when that refuses. Running the script by hand, or from another script, does not skip the gate. It needs `jq`, and without it the step does not run.

On Claude Code, every `PreToolUse` hook with `strength: refuse` (in `hooks {}` or on an agent), and every generated guard, gets `"onFailure": "block"`: a hook that cannot start, times out or exits other than 0 or 2 then blocks the call. Claude Code reads that field from 2.1.295; `validate` warns with `CC-onfailure` when the Claude Code it checks against (the installed one) is older. `before-agent.sh` normalizes `subagent_type` before it compares, as on Codex (format characters, case, space, a leading path, trailing punctuation).

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
| `claude-code` | **Stable** | Claude Code | Generates `.claude/agents/`, `.claude/settings.json`, `.mcp.json` — the event-driven HOST layer; a gate that reads a ledger is graded `refuse, ledger agent-writable until the signed gate` |
| `claude-workflow` | Experimental | Claude Workflow | Compiles the deterministic fan-out phases into `<topology>.workflow.js`, plus SEAM/README/LOSSY-REPORT companion files |
| `codex` | Experimental | Codex | Codex agent definitions and config; every guard is graded `unverified` in release 1, `none` where Codex has no blocking event; a gate that reads a ledger, and an approval step, read `unverified, ledger agent-writable until the signed gate` |
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
| Gate check scripts | Each gate's `run:` script, as a failing stub, at the path the gate wrapper runs: a project path (`checks/review.sh`) is created there once and never overwritten, a bare name (`scripts/review.sh`) goes to `.codex/scripts/review.sh`, an absolute path is never touched |
| Tool scripts | Each `tool`'s stub at its declared `script:` path (a project path is created once and never overwritten; a bare name goes to `.codex/scripts/`) |
| Gate check scripts | Each gate's `run:` script as a failing stub, at the path the gate runs it from: a project path (`tools/checks/ready.sh`) is created once and never overwritten, a bare name goes to `.codex/scripts/`. A `.py` stub is Python and a `.js`/`.mjs` stub is node, on both targets, so an unwritten check fails on purpose (exit 2), not through a syntax error. A stub whose `run:` names `sh` or `dash` (a hook's too) is POSIX sh, so dash runs it |
| `.codex/rules/<topology>.rules` | `settings { allow / ask / deny }` entries of the form `Bash(command *)` as `prefix_rule(...)` |
| `scripts/schedule-<job>.sh`, `crontab.fragment` | Schedule jobs with `carrier: cron` that run an agent, through `codex -a never exec --sandbox <mode>` |

What to know:

- **Models.** Codex runs no Claude model. `scaffold --target codex` refuses `opus`, `sonnet`, `haiku`, `fable` and `claude-*`, names the agent, exits 1 and writes nothing. Set a Codex model such as `gpt-5.2`.
- **One approval policy per project.** Codex has no per-agent approval policy or sandbox: an agent file cannot override either. When agents differ in `permissions`, the strictest applies to all and scaffold warns. `sandbox:` and `mcp-servers:` on an agent are not written to its file; MCP servers are written once in `config.toml`.
- **Hooks need trust.** Codex skips a new or changed hook until you review it with `/hooks`. A matcher that names Claude tools is rewritten to Codex's names: `Edit`, `Write`, `MultiEdit` to `apply_patch`, `Task`, `Agent` to `collaborationspawn_agent`; a Claude tool with no Codex equivalent (`Read`, `Grep`, `WebFetch`, ...) gets a `CX8-tool` warning. The names are rewritten in a plain list (`Edit|Write`) and in one held between anchors or in one group (`^Write$`, `(Write|Edit)`, `^(?:Task|Agent)$`). A matcher that is a real regex (`Ed.*`, `Task.*`, `(Write|Edit)+`) is kept as written; when it matches a Claude tool's name but not that tool's Codex name, `validate --target codex` reports `CX8-regex`: an ERROR for a `strength: refuse` hook (its refusal could never happen on Codex), a warning otherwise. A hook's `if: "Tool(pattern)"` is kept through `.codex/scripts/at-if.sh`, which needs `jq`. On `Bash` it reads the command the way `before-action.sh` reads a step: the pattern's literal words (`git push*` is `git`, then `push`) are found in any segment, behind a prefix, at any path, in any case, with flags between them, and on a `strength: refuse` hook a mention of the tool it cannot read (an expansion or glob) counts as a match. On `apply_patch` it matches every path the patch adds, updates, deletes or moves to, relative to the project root. Each path is made canonical first, by its letters alone (no file is read): a relative path is taken from the current folder, `/proc/self/cwd` is the project root, `.`, `..` and `//` are resolved, and the project root is stripped, so `$ROOT/./.env`, `$ROOT//.env`, `sub/../.env`, `./.env` and `/proc/self/cwd/.env` are all `.env`. A pattern with no slash (`.env*`) names a file at any depth and is also matched against the file's name (`deep/dir/.env.local` matches); a pattern with a slash (`config/*.json`) is matched against the whole project path only; on a `strength: refuse` hook, input it cannot read, or a command that cannot run, blocks. A hook on an event Codex lacks, a `prompt` / `agent` / `http` handler, or a per-agent hook gets a warning and no entry. Codex itself calls tool hooks a guardrail, not a complete enforcement boundary.
- **Providers are not written.** A project `.codex/config.toml` may not set `model_providers`, `notify`, `profiles`, `otel` and a few other keys; set them in your user config.
- **What Codex cannot express** (sampling settings, a thinking token budget, output format, max turns, fallback chain, rate limit and more) gives one `validate` warning per field. Run `agentopology validate <file> --target codex` (its last line names the Codex CLI version the output was checked against), or read the warnings `scaffold` prints.
- **Inventory.** `validate --inventory` on a Codex project maps the agent files, skills, hook entries, rules, MCP servers and the scaffold manifest. A project with `.codex/` and no `.claude/` is not told that the Claude Code files are "not scaffolded".
- **`codex exec` is read-only by default.** A scheduled job whose agent writes, in a topology that names no sandbox, gets a warning and runs with `--sandbox read-only`. Set `settings { sandbox: workspace-write }`.

### Gates and approvals on Codex

Gates are held by hook scripts, written by the same library as for Claude Code and registered in `.codex/hooks.json`. A guard's hook timeout is 120 seconds, or more when its gates can run longer (timeout x attempts, plus a margin; `validate` warns with `CX9-timeout`), and the hook command cuts the run 10 seconds before that timeout and exits 2, because Codex lets a timed-out hook's call run. The deadline uses GNU `timeout` or `gtimeout`, and without either (stock macOS) a shell watchdog that sends TERM at the deadline and KILL two seconds later. The guard's own output goes to temp files that are copied to the hook's stdout and stderr after the run ends or is cut, so a check that ignores TERM or leaves a background process behind cannot hold the pipe Codex reads past the deadline (plus the two-second KILL stage); the watchdog's own `sleep` ends with the hook. Any non-zero exit of the run, a cut included, is exit 2:

- `before-action.sh` (a `PreToolUse` hook on `Bash`) refuses a script step's command, also inside an `&&` or `;` chain, a subshell, `$(…)` or backticks, behind a prefix (`if`, `!`, `sudo`, `nice`, `env -i`, `xargs`, `bash -c`, `eval`), with extra spaces or quotes, or by another path to the program, until the gate's ledger shows its `after:` step finished ok for the same unit (a gate with a `run:` script and no ledger: until that script passes; `AGENTS.md` names which). It over-blocks on purpose: `echo ./tool publish ep1` is refused too while the gate is unmet. A step named through a variable, an alias or another script is not seen. **Where it looks, and what it refuses:** a backslash line continuation is joined first, and redirections (`>out`, `2>&1`, `<<<x`) are dropped before the command is cut. The tool is looked for where bash runs a program: after variable assignments and `if`, `then`, `while`, `until`, `do`, `!`, `{`, `time`, or as an interpreter's script (`python3 harness/bin/post.py`, under any interpreter name), at any path and in any letter case; the step's words follow it in order, flags allowed between them. A program that only reads or prints its arguments (`cat`, `ls`, `head`, `tail`, `wc`, `grep`, `rg`, `echo`, `printf`, `diff`, `stat`, and `git status`/`diff`/`log`/`show`/`add`/`commit`/`blame`/...) runs no step, unless a flag can make it run one (`-c`, `-x`, `--exec`, `--pre`, `alias`, `git bisect run`); a program that can run its arguments (`sudo`, `xargs`, `env`, `timeout`, `nohup`, `watch`, `find -exec`, `bash -c`, `eval`) and any program it does not know is scanned for the tool. **Deny on doubt:** an expansion or glob among the tool's own words, a program that is itself an expansion naming the tool, a variable the command sets to the tool, or a command substitution hiding a mention of the tool makes the step unreadable: refused when it has a unit ("write the step as a plain command"), checked as a step otherwise. When one command runs the step twice, every unit it names needs its own ok record. `<step> --help`, `-h` or `--version` as the whole tail is no step. A step reached through a variable set elsewhere, an alias, a function or another script is not seen. **Measured:** a differential fuzzer (`scripts/guard-fuzz.py`) composes commands from a grammar of shell forms and runs every command the guard allows with real bash against a logging stand-in tool; on the 0.11.0 candidate it found 0 bypasses in 20,000 commands on each target (the earlier candidate: 295 in 600). **Placeholders:** a step's command is matched on its words up to the first placeholder, and the placeholder and everything after it are left out. A placeholder is an ALL-CAPS word (`EP`, `PID`, `SLUG`, or `OUT.mp4`-style `UPPER.ext`) or a word holding `<`, `>`, `{`, `}`, `[` or `]`. So `commands: ["./media episode render EP.json OUT.mp4"]` refuses `./media episode render show/ep7/ep.json out.mp4` and lets `./media episode list` run. `validate` warns (`AG-placeholder`) for each guarded command it cuts this way, naming the words it matches on. The same rule holds on Claude Code.
- `before-agent.sh` (a `PreToolUse` hook on the subagent spawn tool, `collaborationspawn_agent`) runs the gate scripts that stand before an agent. It matches on `agent_type`, which Codex sets to the agent file's `name`, after normalizing it: zero-width and other format characters (U+200B, U+FEFF, U+00AD, bidi marks) dropped, surrounding space trimmed, lowercased, trailing punctuation (`reviewer:`) dropped, and a leading path (`./`, `agents/`) or `plugin:` prefix dropped. A spawn with no `agent_type`, or `null`, is Codex's default agent, not one of the topology's: it is let through on purpose.
- `gate-<id>.sh` runs when the agent it follows stops (`SubagentStop`). Codex cannot block a stop, so that hook only reports. A gate between two agents (`after: writer, before: reviewer`) is held by `before-agent.sh` instead: it refuses to spawn `reviewer` until the gate script passes. A gate that no Codex event marks (inline delegation, or no agent on either side) reads `hope` in both `AGENTS.md` and `guard --check`: run its `gate-<id>.sh` by hand. A gate after the last agent, with no agent or script step after it, has no blocking event at all: it is graded `none`, `AGENTS.md` says so, and `validate` / `scaffold` warn with `CX9-noblock`.

Every script scaffold writes as a placeholder (a tool's script, a hook's or gate's check, on both targets) carries the `AGENTOPOLOGY_STUB` marker and fails until it is written: exit 2 for a check that must refuse, exit 1 otherwise, so a gate that runs an unwritten script blocks instead of passing. A placeholder is written in the language of the interpreter its hook or gate command runs it with: the one `run:` names, else the extension's (`.py` python3, `.js` / `.mjs` / `.cjs` node, anything else bash). A script run by `sh` gets a POSIX sh body, since bash's `set -o pipefail` makes dash exit 2 and block every call. Codex lets a command run when a `PreToolUse` hook exits 1, exits 127 or times out. Only exit 2 blocks. Every generated guard therefore turns any error of its own into exit 2 with a reason on stderr: a missing `jq`, input that is not JSON, an unreadable ledger, a gate script that cannot start. The hook command itself climbs from the repository root (or the current folder) to find its script, so a nested git repository or a project outside git still runs the guard; a script found nowhere above exits 2. The topology's own hooks use the same launcher. A `strength: refuse` hook on `PreToolUse` (with or without `if:`) is held like a guard: it always gets a hook timeout (its own, else 120 s) and a deadline under it, and a missing script, any launcher failure or a run past the deadline is exit 2; an inline `run:` command with `strength: refuse` turns any failure into exit 2. Any other hook climbs to its script the same way, and a script found nowhere exits 1, an error that does not block.

**An approval step cannot ask.** A Codex `PreToolUse` hook may answer only `allow` or `deny`; `ask` makes the hook fail, and no generated script prints it. A `human` step before an agent instead blocks the spawn (exit 2) until `.codex/state/approvals.jsonl` holds an approval record as the step's last line: `{"step":"<id>","ok":true,"at":"<time>"}`. The block message, which the model reads, says a person must add the record and names no command. The generated `AGENTS.md` (Human Checkpoints) describes the record in words: the file, the fields `step`, `ok` and `at`, and what each means. `AGENTS.md` is loaded into the model's context too, so it holds no command line that writes the record. Under `workspace-write`, Codex does not let the agent write inside `.codex/` (measured on 0.156.1), so the agent cannot approve itself there. Under `danger-full-access`, or with no sandbox and `approval_policy = "never"`, it can, and `validate --target codex` warns with `CX11-forgeable`.

**Every Codex guard is unverified in release 1.** `AGENTS.md`, the gate wrappers and `guard --check` grade every Codex guard `unverified`, never `hook` or `refuse`, and `none` where Codex has no event that can block. Three facts measured live on Codex CLI 0.156.1 (13 Nov 2026) are why:

1. The hooks of an untrusted project are skipped silently, with no message on the `--json` stream or on stderr (probe P7). A guard holds only after you trust the hooks: open `/hooks` in Codex and trust the hooks in `.codex/hooks.json` after every scaffold (the generated `AGENTS.md` names this step). agentopology never writes a trust entry.
2. `codex exec` waits on stdin ("Reading additional input from stdin...") unless stdin is closed, so a scripted run needs `< /dev/null`.
3. A quoted project trust override, `-c 'projects."<path>".trust_level="trusted"'`, is ignored as an "unrecognized configuration setting". The unquoted `projects.<path>.trust_level` form is the one the probe script uses.

Until a live run proves a guard holds under those conditions, none is graded `refuse`. Hooks also see only the tools Codex runs through its hook layer: `apply_patch` and MCP tools need their own matchers, and a hook is a guardrail, not a sandbox.

A gate that cites the code refusing it (`at:`, with `match:` and `bypass:`) gets `Refused by` and `Bypass` lines in `AGENTS.md`, and `guard --check --target codex` checks the citation on disk as it does on Claude Code: a missing file, a line past the end, or a `match:` text no longer near the line reads `none`; a gate no hook holds is credited with its declared strength, "cited, not proven", with the bypass in its notes.

`agentopology guard <file.at> --check [--target codex] [--dir <project>]` grades a Codex project from `.codex/hooks.json` and `.codex/scripts/` (it is picked without `--target` when the project has `.codex/` and no `.claude/`). It writes nothing, on any target. A guard whose entry and scripts are on disk reads `unverified`; one that is missing reads `none` and the exit is 1; a gate with no blocking event reads `none` but does not fail the check, since no file can fix it.

`agentopology guard <file.at> --target codex [--dir <project>]` writes only these guards into a project built by hand: the guard scripts and their `hooks.json` entries, merged with the hooks already there. It also writes the check script each gate runs, as a failing stub, when it is missing; an existing one is never overwritten. It does not touch `AGENTS.md`, `config.toml`, agent files or skills, and a second run changes nothing. On a rescaffold, `hooks.json` is merged: a group whose command names one of the topology's `.codex/scripts/…` files is replaced by what the topology generates now, and every other group is kept. Claude Code's `settings.json` is merged the same way: a group whose command names one of the topology's scripts, as a bare path or right after `$CLAUDE_PROJECT_DIR/` (the form scaffold writes), is replaced; a group naming any other script is the user's and is kept.

### Conformance tests for Codex

`src/__tests__/e2e/f-batch-b.test.ts` holds tests that kill three mutants of the guards: no KILL stage in the watchdog, an `if:` filter that skips `*** Delete File:`, and a GNU `timeout` path that passes a check's own exit code through.

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
