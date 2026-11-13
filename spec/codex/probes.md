# Codex probe pack (CX-3)

Ten facts about Codex CLI that its docs do not state, measured on Codex CLI 0.156.1 on 2026-11-13.
The machine-readable copy is `probes.json`; `src/__tests__/e2e/codex-probes.test.ts` keeps the two complete.

How they were measured: `scripts/codex-probes.sh` (off unless `CODEX_LIVE=1`). Each probe runs in a fresh
temp git repo with a `.codex/hooks.json` whose command hook logs its stdin as one JSON line and exits as the
probe needs. Project trust is given on the command line (`-c projects.<repo>.trust_level="trusted"`) and
hook trust with `--dangerously-bypass-hook-trust`, except in P7. P8 and P9 start no model. 11 live runs.

| Id | Question | Answer | Evidence |
|---|---|---|---|
| P1 | Does exit 2 from a project `PreToolUse` hook on `Bash` block the command in `codex exec`? | yes | The command did not run. stderr: `Command blocked by PreToolUse hook: probe: blocked with exit 2. Command: echo PROBE_EXIT2 > out-exit2.txt`. No `PostToolUse`, and no `command_execution` item in the `--json` stream for it. `codex exec` exit 0 |
| P2 | What tool name does `apply_patch` show in the hook payload? | `apply_patch` | `{"tool_name":"apply_patch","tool_input":{"command":"*** Begin Patch\n*** Add File: <redacted>/hello.txt\n+hello\n*** End Patch"}}`. The patch is in `tool_input.command`, with absolute paths. A `Bash` matcher does not see it |
| P3 | What tool name and input does a subagent spawn show? | `collaborationspawn_agent`, input `task_name`, `agent_type`, `message`, `fork_turns` | `{"tool_name":"collaborationspawn_agent","tool_input":{"task_name":"probe","agent_type":"probe_reviewer","message":"<encrypted>","fork_turns":"none"}}`. The message is encrypted. Waiting is `collaborationwait_agent` with `{"timeout_ms":10000}`. In an `--ephemeral` session the spawn fails: `no thread with id` |
| P4 | Does `agent_type` equal the agent file's `name`? | yes | File `probe-file.toml` with `name = "probe_reviewer"`. `SubagentStart`: `{"agent_id":"<redacted>","agent_type":"probe_reviewer"}`. `SubagentStop` adds `agent_transcript_path`, `last_assistant_message`, `stop_hook_active` |
| P5 | Does a message queued with `codex queue` fire `UserPromptSubmit`, and how is it marked? | yes in an interactive session, as a new turn after the running one, with no mark. No in `codex exec` | Interactive: a second `UserPromptSubmit` with `"prompt":"PROBE_QUEUED: reply with QUEUED-OK"` and a new `turn_id` fired after the first turn's `Stop`. Same keys as a typed prompt. In `codex exec` the queue call also said `Queued message ...` (exit 0) but the message never arrived, not even on `codex exec resume` |
| P6 | Does `-c developer_instructions=...` set a session's role? | yes | `-c 'developer_instructions="Your role code is ZEBRA-42. ..."'`, prompt "What is your role code?" -> `ZEBRA-42` |
| P7 | Does a project hook run in `exec` without trust? | no | Without `--dangerously-bypass-hook-trust` no hook ran (no log file) and the command ran. Nothing in the stream or stderr said hooks were skipped |
| P8 | Is `.codex/` writable under `workspace-write`? | no | `codex sandbox -P :workspace`: `touch .codex/w1: Operation not permitted`, also `.git/`; `sub/` is writable. Live, `codex exec -s workspace-write`: `touch .codex/probe-write: Operation not permitted` |
| P9 | Which command that starts no model honors `--strict-config`? | `codex exec --strict-config`, which fails at config load (exit 1) before any model request. No other | `features`, `mcp`, `sandbox`: "`--strict-config` is not supported". `doctor` takes the flag and exits 0 with a warning. `exec`: `unknown configuration field 'bogus_probe_key'` exit 1, for a `-c` key and for a trusted project `.codex/config.toml`. Point `exec` at a dead provider so a valid config reaches no model. An untrusted project layer is not loaded, so it is not checked |
| P10 | What do exit 1, exit 127 and a timeout do on `PreToolUse`? | all three fail open: the command runs | Exit 1 and exit 127: command ran, `PostToolUse` fired. Timeout 3 s on a hook that sleeps 20 s then exits 2: command ran, the hook was ended (no after-sleep line). No warning anywhere. Only exit 2 blocks |

## What this means for the binding

- A Codex guard must exit 2 to refuse. Any crash (exit 1), missing interpreter (exit 127) or slow check
  (timeout) lets the command through, silently.
- A guard on `Bash` does not cover file edits: `apply_patch` has its own tool name. Guard both.
- Hooks do nothing until trusted, and Codex says nothing when it skips them (P7).
- `.codex/` and `.git/` are read-only to the agent's shell under `workspace-write`, so anything the agent
  itself must write (a step ledger, for one) cannot live in `.codex/`.
- `codex exec --ephemeral` cannot spawn subagents.
- A queued message is a plain `UserPromptSubmit`; a talk guard cannot tell it from a typed prompt by its payload.
- The `-c projects."<path>".trust_level` form with quotes does not trust the project; the unquoted dotted form does.
