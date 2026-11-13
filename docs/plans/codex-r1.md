# Codex binding, release 1: build spec for the cloud lanes

Base for every Codex lane: `origin/integrate/codex`. The facts below were measured on Codex CLI 0.156.1 and its docs (learn.chatgpt.com/docs, read 2026-11-13). Line numbers in `src/bindings/codex.ts` refer to main at 151789e; they may have moved, find the code by content. Test names start with the ticket id in brackets, e.g. "[CX-7] ...". Tests never call a model and never need a Codex login; where a test needs the `codex` binary and it is not installed, skip that test with a clear message (try `npm i -g @openai/codex@0.156.1` first and record whether it worked). Docs ship in the same branch: README or `docs/bindings.md` where user-facing, CHANGELOG under `## [Unreleased]`.

Release 1 holds CX-1 to CX-11, CX-13 to CX-15, CX-17, CX-18, CX-20 and CX-23. Codex stays marked experimental in release 1, and no Codex guard is graded "refuse".

## 1. What I measured

### 1.1 Codex 0.156.1 on a developer machine

| Fact | Evidence |
|---|---|
| Version is `codex-cli 0.156.1` | MEASURED: `codex --version` |
| `--ask-for-approval` accepts only `on-request` and `never` | MEASURED: `codex --help` |
| `--sandbox` accepts `read-only`, `workspace-write`, `danger-full-access` | MEASURED: `codex --help` |
| Hooks are a stable feature, on by default | MEASURED: `codex features list` prints `hooks  stable  true` |
| `multi_agent` is stable and on. `multi_agent_v2` is stable and off. `agent_message_board` is under development | MEASURED: `codex features list` |
| There is a flag `--dangerously-bypass-hook-trust`, so hooks need trust | MEASURED: `codex exec --help` |
| No `--agent` flag and no `--name` flag at launch | MEASURED: `codex --help`, `codex exec --help` |
| `codex queue --thread <uuid or exact session name> --message <text>` sends a message to an existing session | MEASURED: `codex queue --help` |
| `codex agents` browses all sessions on the local daemon | MEASURED: `codex agents --help` |
| `codex execpolicy check` tests a command against `.rules` files with no model call | MEASURED: `codex execpolicy --help` |
| `codex sandbox [COMMAND]` runs a command under the sandbox with no model call, and takes `-P <permission profile>` | MEASURED: `codex sandbox --help` |
| `--strict-config` errors on config fields this Codex does not know | MEASURED: `codex --help` |
| `-p <name>` loads `$CODEX_HOME/<name>.config.toml` | MEASURED: `codex --help` |
| `codex cloud exec` exists and is marked EXPERIMENTAL | MEASURED: `codex cloud --help` |
| A real `hooks.json` here has the shape `{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"...","timeout":10}]}]}}` | MEASURED: a user-level `hooks.json` |
| Trust is stored as `[hooks.state."<hooks.json path>:session_start:0:0"] trusted_hash = "sha256:..."` in the user config | MEASURED: a user-level `config.toml` |
| User agents here are `~/.codex/agents/*.toml` with `name`, `description`, `developer_instructions` | MEASURED: user-level agent files |

### 1.2 Codex docs, read 2026-11-13

`developers.openai.com/codex/*` now answers 308 to `learn.chatgpt.com/docs/*` (MEASURED). All pages below are on that host.

| Topic | What the docs say | Page |
|---|---|---|
| Hook files | `<repo>/.codex/hooks.json` or `[hooks]` in `<repo>/.codex/config.toml`. Project hooks load only when the project `.codex/` layer is trusted | MEASURED: `/docs/hooks.md` |
| Hook events (14) | `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `UserPromptSubmit`, `SubagentStop`, `Stop`, `PreModelRequest`, `PostModelRequest`, `Interrupt`, `SessionStart`, `SubagentStart`, `SessionEnd` | MEASURED: `/docs/hooks.md` |
| Matchers | Tool name on the 3 tool events. Trigger on compact events. Source on `SessionStart`. Agent type on `SubagentStart` and `SubagentStop`. Ignored on `UserPromptSubmit`, `Stop`, `Interrupt`, `PreModelRequest`, `PostModelRequest` | MEASURED: `/docs/hooks.md` |
| Handler types | `command` and `mcp_tool` run. `prompt` and `agent` are parsed and skipped | MEASURED: `/docs/hooks.md` |
| Exit 2 | Blocks on `PreToolUse` and `UserPromptSubmit`. On `Stop` and `SubagentStop` it continues the turn. On `PostToolUse` it replaces the result and undoes nothing | MEASURED: `/docs/hooks.md` |
| `PreToolUse` output | `permissionDecision` may be `deny` or `allow`. `ask` is unsupported and makes the hook run fail | MEASURED: `/docs/hooks.md` |
| Tools a hook sees | Shell (as `Bash`), `exec_command`, `apply_patch` (also `Edit`/`Write`), MCP tools as `mcp__server__tool`, other local function tools. Not hosted tools such as web search. `write_stdin` does not fire it again | MEASURED: `/docs/hooks.md` |
| The vendor's own caveat | Tool hooks are "a useful guardrail, not a complete enforcement boundary" | MEASURED: `/docs/hooks.md` |
| Hook trust | A non-managed hook must be reviewed and trusted (`/hooks`). Trust is tied to the hook's hash. A new or changed hook is skipped until trusted | MEASURED: `/docs/hooks.md` |
| Hook stdin | Common: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`. `PreToolUse` adds `turn_id`, `tool_name`, `tool_use_id`, `tool_input`, `permission_mode` | MEASURED: `/docs/hooks.md` |
| `SubagentStart` cannot block | It accepts `systemMessage` and ignores `continue: false`. Exit 2 is not documented for it | MEASURED: `/docs/hooks.md` |
| Timeout | In seconds, default 600 | MEASURED: `/docs/hooks.md` |
| Custom agents | One TOML file per agent in `.codex/agents/`. Required: `name`, `description`, `developer_instructions`. Optional: `model`, `model_reasoning_effort`, and feature switches such as `features.shell_tool = false` | MEASURED: `/docs/agent-configuration/subagents.md` |
| What an agent file cannot set | `sandbox_mode`, `approval_policy`, `model_provider`, `mcp_servers` "don't override the parent configuration when placed in a custom agent file" | MEASURED: same page |
| "Do not edit" in prose | "Custom instructions asking an agent to avoid edits don't create a read-only sandbox" | MEASURED: same page |
| `[agents]` keys | `enabled`, `max_concurrent_threads_per_session`, `max_threads` (legacy alias), `default_subagent_model`, `default_subagent_reasoning_effort`, `interrupt_message`, `agents.<name>.description`, `agents.<name>.config_file`. No `max_depth` | MEASURED: `/docs/config-file/config-reference.md` (first 100,000 of 152,772 characters read) |
| Approval policy | `on-request`, `never`, or `{ granular = {...} }`. `untrusted` is unsupported. `on-failure` is deprecated | MEASURED: config reference, and `/docs/sandboxing.md` |
| Providers | `model_provider` plus `[model_providers.<id>]`. No `[[providers]]` | MEASURED: config reference |
| Project config limits | A project `.codex/config.toml` cannot set `model_provider`, `model_providers`, `notify`, `profile`, `profiles`, `otel` and 4 URL keys. Codex ignores them with a warning | MEASURED: `/docs/config-file/config-advanced.md` |
| Keys that do not exist | `disable_response_storage`, `history.max_conversations`, `temperature`, `max_tokens` | MEASURED: not on the config reference (in the part read) |
| Reasoning effort | "such as" `low`, `medium`, `high`, `xhigh`, `max`, `ultra` | MEASURED: config reference |
| MCP | `[mcp_servers.<id>]` with `command`, `args`, `env` (a table), `url`, `bearer_token_env_var`, `enabled_tools`, `disabled_tools`, `tools.<tool>.approval_mode`. Allowed in a trusted project config. No `type` key | MEASURED: `/docs/extend/mcp.md`, config reference |
| Skills | `<repo>/.agents/skills/<name>/SKILL.md`, frontmatter `name` and `description`. Optional `agents/openai.yaml` with `policy.allow_implicit_invocation` | MEASURED: `/docs/build-skills.md` |
| AGENTS.md | One file per directory from the project root down to the working directory. Combined cap `project_doc_max_bytes`, default 32 KiB. Codex stops adding files at the cap | MEASURED: `/docs/agent-configuration/agents-md.md` |
| Rules | `<repo>/.codex/rules/*.rules`, `prefix_rule(pattern, decision = allow, prompt or forbidden)`. Strictest wins. A script with redirection, variables or control flow is judged as one `bash -lc` command, not split | MEASURED: `/docs/agent-configuration/rules.md` |
| Sandbox | macOS Seatbelt, Linux bubblewrap. `read-only`, `workspace-write`, `danger-full-access` | MEASURED: `/docs/sandboxing.md` |
| Exec mode | Read-only sandbox by default. `--json` gives a JSONL event stream. `--output-schema` exists. No exit codes are documented | MEASURED: `/docs/non-interactive-mode.md` |
| Session names | `/rename <name>` inside a session. No launch flag. `codex queue --thread` accepts the exact name | MEASURED: `/docs/developer-commands.md` |
| Scheduled tasks | Desktop app, web and team tasks only. "Codex CLI doesn't provide the Scheduled management interface." No repo file format | MEASURED: `/docs/automations.md` |
| Codex Cloud | The page does not say whether hooks, `.codex/config.toml`, skills or rules are honored in a cloud task | MEASURED: `/docs/cloud.md` (absence) |

### 1.3 What the binding writes today

MEASURED: `node dist/cli/index.js scaffold kitchen-sink.at --target codex --output <scratchpad>/cx-out` wrote 27 files. The built `dist` is this checkout's. Key output:

```
model = "opus"
approval_policy = "on-request"
sandbox_mode = "read-only"
[[providers]]
name = "anthropic"
...
[mcp_servers.log-search]
type = "sse"
url = "https://mcp.logs.example.com/sse"

sandbox-mode = "workspace-write"

[agents]
max_threads = 5
max_depth = 1
```

- No `hooks.json` and no `[hooks]` table were written. The scaffold has 0 registered hooks.
- `.codex/scripts/exit` was written. It comes from a hook declared `run: "exit 2"` (`kitchen-sink.at:539`), named `block-dangerous-commands`, on `PreToolUse` with matcher `Bash`. Its content is `echo "TODO: implement block-dangerous-commands hook"`. A hook that refuses became a file that does nothing and is never called.
- All scripts are mode `-rw-r--r--`, not executable.
- `AGENTS.md` is 11,057 bytes for 5 agents.


## 2. What is wrong or missing in `src/bindings/codex.ts`

All lines are in `src/bindings/codex.ts` at commit 151789e unless another file is named. "Docs" refers to section 1.2.

### 2.1 Wrong: Codex 0.156.1 rejects it, ignores it, or reads something else

| # | Where | What it does | Why it is wrong | Evidence |
|---|---|---|---|---|
| W1 | `:66-99` | Maps `supervised`, `interactive`, `plan`, `confirm`, `suggest` and every unknown value to `approval_policy = "untrusted"`. Passes `on-failure` through | `untrusted` is unsupported and `on-failure` is deprecated. The "safe default" at `:98` is a value Codex no longer takes | MEASURED: `codex --help`, config reference |
| W2 | `bindings.test.ts:949` | The test pins `approval_policy` to `(untrusted|on-request|on-failure|never)` | The test holds the bug in place | MEASURED |
| W3 | `:236-288` | Writes `[[providers]]` tables | The key does not exist. The real one is `[model_providers.<id>]`, and a project config may not set it at all | MEASURED: scaffold output, config-advanced |
| W4 | `:316-334` after `:290-307` | Writes extension keys as top-level keys after the MCP tables | In TOML they land inside the last table. The run put `sandbox-mode = "workspace-write"` inside `[mcp_servers.log-search]` | MEASURED: scaffold output |
| W5 | `:181`, `:188`, `:656`, `:1652` | Passes the `.at` model through. Default is `o4-mini`. The comment at `:177` says `gpt-4o` | The run wrote `model = "opus"` and `model = "haiku"`. No Codex model has that name. `bindings.test.ts:980-990` asserts `"opus"` is there | MEASURED: scaffold output. INFERRED: that Codex fails on it at the first model call |
| W6 | `:340-341` | Writes `max_threads` and `max_depth` | `max_threads` is a legacy alias. `max_depth` is not in the reference | MEASURED: config reference |
| W7 | `:1657-1659` | Writes `sandbox_mode` into each agent file | An agent file cannot override it. The agent "detector" reads as read-only and is not | MEASURED: subagents page |
| W8 | `:1677-1696` | Writes `[mcp_servers.*]` into each agent file | Same. Per-agent MCP scoping is a no-op | MEASURED: subagents page |
| W9 | `:291-307`, `:1683-1692` | Copies MCP keys as given, strings, numbers, booleans and arrays only | A nested `env` table is dropped without a word. `type = "stdio"` is copied and is not a Codex key | MEASURED: code and scaffold output. INFERRED: `--strict-config` would reject `type` |
| W10 | `:193-197`, `:212-222` | Writes `disable_response_storage` and `[history] max_conversations` from extensions | Neither key is in the reference | MEASURED |
| W11 | `:1505-1572` | Writes skills to `.codex/skills/<id>.md` | Codex reads `.agents/skills/<name>/SKILL.md` with `name` and `description` frontmatter. These files are never loaded | MEASURED: build-skills page |
| W12 | `:1285`, `:1308`, `:1338` | Derives a script file name from `run:` by cutting at the last slash and the first space | An inline command becomes a file named after its first word (`exit`). Two scripts with one basename collide | MEASURED: `.codex/scripts/exit` |
| W13 | `:1309-1323`, `:1339-1352` | Hook stubs are `echo "TODO"` and exit 0 | They do not use `shellStub`, so they carry no stub marker and would fail open if ever wired | MEASURED |
| W14 | `:1286-1290`, `:1324-1328` | No `executable: true` on any script | Files are written mode 644 | MEASURED: `ls -la` |
| W15 | `:1649` | Wraps the prompt in `"""` with no escaping | A prompt holding `"""` or a backslash breaks the file | INFERRED from the TOML rules |
| W16 | `:186`, comment `:165` | The comment says "the most permissive agent's approval policy". The code takes `agents[0]` | One agent's setting silently becomes everyone's | MEASURED |
| W17 | `:227-229`, `:373-387` | `sandbox: true` maps to `read-only`. An unknown word maps to `read-only` | Not wrong for safety. It makes a write-heavy topology unable to write, with no message | MEASURED: scaffold output has `sandbox_mode = "read-only"` beside 5 writing agents |
| W18 | `:1674` | Writes `nickname_candidates` | Not in the docs read today | INFERRED: stale or undocumented |

### 2.2 Missing: the Claude Code binding has it, the Codex binding has nothing

| # | 0.10.1 feature | Claude Code binding | Codex binding today | Evidence |
|---|---|---|---|---|
| M1 | Hooks registered | `settingsHooksOf` (`claude-code.ts:2561`) writes `settings.json` | No `hooks.json`. Stubs only (`:1302-1362`) | MEASURED |
| M2 | Gate before an agent | `generateBeforeAgentScript` (`claude-code.ts:247`) | Prose: "run gate script manually between agents" (`:948`) | MEASURED |
| M3 | Guard on a script step | `generateBeforeActionScript` (`claude-code.ts:345`) | Nothing | MEASURED |
| M4 | Gate wrappers, ledger checks | `generateGateWrapperScripts` (`claude-code.ts:2169`) | A bare stub (`:1278-1295`) | MEASURED |
| M5 | Human approval | `approvalTargets` (`claude-code.ts:230`), `PreToolUse` asks | Prose (`:880-900`) | MEASURED |
| M6 | `runs: session` | `generateSessionFiles` (`lib/session.ts`) | One warning line, "session agents: experimental, not compiled" (`:1719`, `lib/session.ts:31`) | MEASURED |
| M7 | Talk guard, spawn guard, prompt log | `lib/session.ts:182-320` | Nothing | MEASURED |
| M8 | `guard --check` grades | `src/guard/check.ts` | Not reachable. `check.ts:26-28` imports only the Claude Code binding and contract. It reads `.claude/settings.json` (`check.ts:138`) | MEASURED |
| M9 | `guard --target` | `src/guard/target.ts` | Refused: "guard --target supports claude-code only" (`cli/index.ts:1269-1270`) | MEASURED |
| M10 | Honest version line | `installedStatus` runs `claude --version` (`conformance/claude-code.ts:46`) | No line for Codex. `cli/index.ts:525` and `:1232` print it for `claude-code` only | MEASURED |
| M11 | Conformance suite | `src/conformance/claude-code.ts`, `e2e/conformance.test.ts`, `spec/claude-code/hooks-contract.json`, `npm run drift` | None. The 6 Codex test cases check that files exist and hold a word | MEASURED: `bindings.test.ts:940-991` |
| M12 | Inventory and coverage | Walks `.claude`, `settings.json`, `.mcp.json` (`inventory/index.ts:111-135`) | Sees nothing of `.codex`, `.agents`, `AGENTS.md` | MEASURED |
| M13 | Import a project | `readClaudeProject` (`cli/index.ts:1167`) | `null` for every other target | MEASURED |
| M14 | Schedules | `generateScheduleScripts` (`claude-code.ts:3022`) writes a cron fragment and scripts | Prose in AGENTS.md (`:596-611`) | MEASURED |
| M15 | Commands and triggers | `generateCommandFiles` (`claude-code.ts:3084`) | Prose (`:977-987`) | MEASURED |
| M16 | Permission rules | `permissions.allow/deny` in `settings.json` | Nothing. `.codex/rules/` is never written | MEASURED |
| M17 | User's own file kept | Managed sections and `createOnly` | `AGENTS.md` is written whole (`:1231-1235`). A user's AGENTS.md is replaced or conflicts | INFERRED from the category, not run |
| M18 | Silent-drop guard | The zero-drop test from 0.10.1 covers the Claude Code path | No list of what Codex cannot express. Temperature and max tokens become TOML comments (`:202-209`) | MEASURED |
| M19 | Size of the instruction file | Not needed on CC | Every agent prompt is inlined into AGENTS.md (`:741-746`). At 11 KB per 5 agents the 32 KiB cap is hit near 15 agents, and Codex then stops reading | MEASURED size. INFERRED threshold |


## 4. The conformance suite for Codex

It mirrors `src/conformance/claude-code.ts` and `e2e/conformance.test.ts`. Five tiers. Tiers A to D cost no model call. Tier E costs model calls and runs only on a maintainer machine.

### 4.1 The contract module: `src/conformance/codex.ts`

| Constant | Value | Source |
|---|---|---|
| `VERIFIED_ON` | `"0.156.1"` | MEASURED: `codex --version`, docs read 2026-11-13 |
| `MINIMUM_VERSION` | Equal to `VERIFIED_ON` until CX-2 finds the first version where hooks are stable and on by default | INFERRED: not looked up |
| `HOOK_EVENTS` | The 14 names in section 1.2 | MEASURED |
| `NO_MATCHER_EVENTS` | `UserPromptSubmit`, `Stop`, `Interrupt`, `PreModelRequest`, `PostModelRequest` | MEASURED |
| `RUNNING_HANDLERS` | `command`, `mcp_tool` | MEASURED |
| `SKIPPED_HANDLERS` | `prompt`, `agent` | MEASURED |
| `BLOCKING_EVENTS` | `PreToolUse`, `UserPromptSubmit` | MEASURED |
| `PRE_TOOL_DECISIONS` | `allow`, `deny` | MEASURED |
| `APPROVAL_POLICIES` | `on-request`, `never` | MEASURED |
| `SANDBOX_MODES` | `read-only`, `workspace-write`, `danger-full-access` | MEASURED |
| `PROJECT_FORBIDDEN_KEYS` | The 10 keys a project config cannot set | MEASURED |
| `CODEX_HOOKS_PROVEN` | `{ bash: false, applyPatch: false, mcp: false, spawn: false, queue: false, subagentStop: false }` | All false until tier E |

The version line: `checked against Codex CLI 0.156.1 (supports 0.156.1 and later)`.

The installed mark, same four states as Claude Code: nothing when it matches · `installed 0.157.0: unverified` · `unknown version: unverified` · `Codex CLI not installed`. It parses `codex-cli (\d+\.\d+\.\d+)` from `codex --version` with a 3 second timeout.

### 4.2 The tiers

| Tier | What it checks | How | Model call |
|---|---|---|---|
| A. Config shape | Every key in the generated `.codex/config.toml` and agent files is in the snapshot key list. No forbidden project key. Approval and sandbox values are legal. The file parses as TOML and no key sits in the wrong table | A TOML parser in the test plus `spec/codex/config-keys.json` | No |
| B. Hook shape | `checkHooks` for Codex: event is one of 14, no matcher on a no-matcher event, handler type runs, timeout is in seconds, the script path is anchored | Static, on the generated `hooks.json` | No |
| C. Planted stdin | Every generated command hook is run with the Codex payload for its event, from a subfolder, with no Claude variable set. Exit code and stdout are checked. A deny payload must give exit 2. A `PreToolUse` stdout must never say `ask` | The same runner as `conformance.test.ts`, with `payloadFor` for Codex | No |
| D. Platform tools | Each generated rule is run through `codex execpolicy check --rules <file> -- <command>` and must return the declared decision. A write outside the workspace is run through `codex sandbox` and must fail. The generated config is loaded with `--strict-config` by a command that starts no model (to be found in CX-3) | Skipped with a clear message when `codex` is not installed | No |
| E. Live proof | A temp git repo, the scaffold of a small fixture, `codex exec --json --dangerously-bypass-hook-trust` with a prompt that makes Codex attempt one planted action per guard. The JSONL stream and the ledger show that the guard refused. One run per key of `CODEX_HOOKS_PROVEN` | `src/__tests__/live/codex.live.test.ts`, off unless `CODEX_LIVE=1` | Yes, about 10 short runs |


## 5. Tickets

Sizes are builder-days for one agent builder with tests. "Red today" says why the planted test fails on main at 151789e.  

| id | title | size | files it touches | blocked by | blocks | done when (planted test, red then green) |
|---|---|---|---|---|---|---|
| CX-1 | The platform seam: version line and installed mark per target | 1 | `src/conformance/index.ts` (new), `src/conformance/claude-code.ts`, `src/cli/index.ts` | none | CX-16, CX-21 | With a fake `codex` on PATH that prints `codex-cli 0.999.0`, `targets` and `scaffold --target codex` print "installed 0.999.0: unverified". Red today: `cli/index.ts:525` and `:1232` print a line for `claude-code` only. Claude Code output stays byte-identical |
| CX-2 | The Codex contract: constants, snapshot, extractor | 2 | `src/conformance/codex.ts` (new), `src/conformance/extract-codex.ts` (new), `spec/codex/hooks-contract.json`, `spec/codex/config-keys.json`, `spec/codex/features.json`, `scripts/codex-drift.mjs`, `package.json` | none | CX-4, CX-8, CX-15, CX-21 | A planted `hooks.json` with event `Notification`, a `prompt` handler and a matcher on `Stop` gives exactly 3 violations. A drift test holds the constants to the snapshot. Red today: the module does not exist |
| CX-3 | The probe pack: 10 facts the docs do not state | 2 | `spec/codex/probes.md`, `spec/codex/probes.json`, `scripts/codex-probes.sh` | the live probe runs | CX-9, CX-12, CX-21 | A test requires a dated record with a Codex version for each probe id P1 to P10. Red today: no record. Probes: P1 exit 2 on `Bash` blocks in `exec` · P2 the tool name of `apply_patch` · P3 the tool name and input of a subagent spawn · P4 `agent_type` equals the agent file's `name` · P5 a queued message fires `UserPromptSubmit`, and how it is marked · P6 `-c developer_instructions=` sets a session's role · P7 a project hook runs in `exec` without trust, or not · P8 `.codex/` is writable under `workspace-write`, or not · P9 a no-model command that honors `--strict-config` · P10 what exit 1, exit 127 and a timeout do on `PreToolUse` |
| CX-4 | A correct `config.toml` | 2 | `src/bindings/codex.ts`, `src/bindings/lib/toml.ts` (new), `src/bindings/__tests__/bindings.test.ts`, `src/bindings/__tests__/defaults-agreement.test.ts`, `package.json` (a TOML parser as a dev dependency) | CX-2 | CX-5, CX-14, CX-15 | The scaffold of `kitchen-sink.at` parses as TOML, every key is in `config-keys.json`, no key is in `PROJECT_FORBIDDEN_KEYS`, and `approval_policy` is `on-request` or `never`. Red today on 5 counts: `untrusted` (W1), `[[providers]]` (W3), `sandbox-mode` inside an MCP table (W4), `max_depth` (W6), `type` in MCP (W9) |
| CX-5 | Honest agent files and model names | 1 | `src/bindings/codex.ts`, `src/parser/validator.ts` | CX-4 | CX-23 | An agent with `sandbox: read-only`, `mcp-servers` and `model: opus` scaffolds an agent file with none of the three, plus 3 warnings naming the agent, and scaffold exits 1 on the Claude model name. A prompt holding `"""` round-trips through a TOML parser. Red today: W5, W7, W8, W15 |
| CX-6 | A small, merged `AGENTS.md` | 1.5 | `src/bindings/codex.ts`, `src/scaffold/merge.ts`, `src/sync/index.ts` | none | CX-22 | (a) A fixture with 40 agents scaffolds an `AGENTS.md` under 24 KiB with no agent prompt in it. (b) A user's line above the managed block survives a second scaffold. (c) `sync` still finds every prompt, now from the agent files. Red today: prompts are inlined at `:741-746`, and the file is written whole |
| CX-7 | Skills and triggers where Codex reads them | 1 | `src/bindings/codex.ts`, `src/scaffold/manifest.ts` | none | CX-18 | Each skill is at `.agents/skills/<id>/SKILL.md` with `name` and `description`. `disable-model-invocation` writes `agents/openai.yaml` with `allow_implicit_invocation: false`. No file under `.codex/skills/`. Red today: W11 |
| CX-8 | Hooks compile to `.codex/hooks.json` | 2 | `src/bindings/codex.ts`, `src/bindings/lib/codex-hooks.ts` (new), `src/parser/validator.ts` | CX-2 | CX-9, CX-12, CX-15, CX-17 | The `kitchen-sink.at` hook with `run: "exit 2"` on `PreToolUse` and `Bash` appears in `hooks.json` as that inline command, and no file named `exit` is written. A hook on an event Codex lacks gives one validate warning and no entry. Scripts are executable and anchored. Red today: M1, W12, W13, W14 |
| CX-9 | Gates on Codex | 3 | `src/bindings/codex.ts`, `src/bindings/lib/guards.ts`, `src/step/check.ts` | CX-3, CX-8, CX-10 | CX-11, CX-15, CX-16, CX-17 | On the gate fixture: a planted `PreToolUse` payload for a guarded command exits 2 while the gate's ledger has no ok record, and exits 0 after one is added. The same for a guarded command inside a `&&` chain. A missing `jq` exits 2. Red today: no script exists (M2, M3, M4) |
| CX-10 | One guard-script library for both bindings | 2 | `src/bindings/lib/guards.ts` (new), `src/bindings/claude-code.ts`, `src/bindings/lib/session.ts` | none | CX-9, CX-12 | A golden test: the Claude Code scaffold of every example and fixture is byte-identical before and after. A second test builds the same guards with the Codex platform record and finds no `CLAUDE_PROJECT_DIR` in them. Red today: the second test cannot be written, the scripts are built inline in `claude-code.ts:247-440` |
| CX-11 | The human gate without "ask" | 1 | `src/bindings/codex.ts`, `src/bindings/lib/guards.ts` | CX-9 | CX-16 | A planted `PreToolUse` on a step behind a `human` node exits 2 with the reason and the command the person runs. After an approval record it exits 0. No generated script prints `"ask"`. Red today: M5 |
| CX-12 | Session agents on Codex | 3 | `src/bindings/codex.ts`, `src/bindings/lib/session.ts`, `src/bindings/lib/guards.ts` | CX-3, CX-8, CX-10 | CX-16, CX-22 | On a public 4-session hub fixture: 4 start lines of the form `AT_SESSION=<id> codex ...`. A planted `Bash` payload holding `codex queue --thread <lane> --message x` from another lane exits 2. To the hub it exits 0. The same inside `a && codex queue ...` exits 2. Both are logged. Red today: `:1719` prints "not compiled" |
| CX-13 | Permission rules and the sandbox | 2 | `src/bindings/codex.ts`, `src/bindings/lib/codex-rules.ts` (new) | CX-2 | CX-15, CX-16 | A topology that forbids `git push` writes `.codex/rules/<name>.rules` whose own `match` example is `git push origin main`. Where `codex` is installed, `codex execpolicy check` returns `forbidden` for it. Agents that differ in `permissions` give one warning naming the strictest. Red today: M16, W16 |
| CX-14 | MCP tables in full | 1 | `src/bindings/codex.ts`, `src/bindings/lib/toml.ts`, `src/conformance/codex.ts` | CX-4 | CX-15 | A server with an `env` map and a `url` server with a bearer variable both round-trip through a TOML parser with every field. `matcherProblem` for Codex flags a dotted `mcp.server.tool` matcher. Red today: `env` is dropped (W9) |
| CX-15 | Conformance v0 for Codex, tiers A to D | 2.5 | `src/__tests__/e2e/codex-conformance.test.ts` (new), `src/conformance/codex.ts`, `src/__tests__/e2e/fixtures/` | CX-2, CX-4, CX-8, CX-9, CX-13, CX-14 | CX-16, CX-21 | For every example and fixture: 0 violations in tiers A and B, and every command hook exits as declared in tier C. Planted: a relative script path, a `prompt` handler and an `ask` output each fail one named check. Red today: the suite does not exist, and tier A alone fails on 5 counts |
| CX-16 | `guard --check` on Codex | 3 | `src/guard/check.ts`, `src/guard/platform.ts` (new), `src/cli/index.ts` | CX-1, CX-9, CX-11, CX-13, CX-15 | CX-21, CX-22 | On a scaffolded temp project with a fake user config: every gate is graded. No line reads "refuse" while `CODEX_HOOKS_PROVEN` is false. Removing the `[hooks.state]` entry turns that guard to "none: not trusted". Every hook guard carries the bypass line. Claude Code output is unchanged. Red today: `check.ts:138` reads `.claude/settings.json` only |
| CX-17 | `guard --target codex` | 1 | `src/guard/target.ts`, `src/cli/index.ts` | CX-8, CX-9 | CX-22 | In a hand-built project with its own `AGENTS.md` and `hooks.json`: the guards are merged in, the user's hook entry and file are still there, and a second run changes nothing. Red today: `cli/index.ts:1269` refuses the target |
| CX-18 | Inventory and coverage for a Codex project | 1.5 | `src/inventory/index.ts`, `src/cli/index.ts` | CX-7 | CX-22 | On a scaffolded temp project, `inventory` lists the agent files, skills, hook entries, rules and MCP servers, and `validate --inventory` maps all of them. One planted hand-made hook shows as unmapped. Red today: `inventory/index.ts:111` walks `.claude` only, so the count is 0 |
| CX-19 | Import a Codex project | 2 | `src/import/`, `src/cli/index.ts` | CX-4, CX-7, CX-8 | none | `import --target codex` on the CX-22 fixture's scaffold gives a `.at` that validates and whose re-scaffold differs in 0 files. Red today: `cli/index.ts:1167` returns `null` |
| CX-20 | Schedules that run Codex | 1 | `src/bindings/codex.ts` | CX-4, T-06 (job carriers, in PR 47) | none | A job with `carrier: cron` scaffolds a line that calls `codex exec` with an explicit `--sandbox` and `-a never`. A job with `carrier: session` and `survives: away` is an error on this target too. A writing job with no sandbox word gives a warning: "exec is read-only by default". Red today: M14 |
| CX-21 | The live proof and the drift watch | 2 | `src/__tests__/live/codex.live.test.ts` (new), `src/conformance/codex.ts`, `scripts/codex-drift.mjs` | CX-1, CX-3, CX-15, CX-16, the live probe runs | CX-22 | With `CODEX_LIVE=1`: one run per key of `CODEX_HOOKS_PROVEN`. A key turns true only with a dated record. After it, `guard --check` on the same project prints "refuse" for the proven guards and "unverified" for the rest. Red today: every key is false. The drift script, given a planted snapshot with one event removed, prints that one difference |
| CX-22 | The parity proof and the label | 1.5 | `examples/parity.at` (new, public), `src/__tests__/e2e/parity.test.ts` (new), `docs/bindings.md`, `src/bindings/index.ts`, `CHANGELOG.md` | CX-6, CX-12, CX-16, CX-17, CX-18, CX-21, the support decision | none | One `.at` scaffolds for both targets. A table test holds, per concept of section 3, that the Codex grade is equal to the Claude Code grade or is the lower grade the table declares. The `experimental` mark on `codex` is removed in the same commit. Red today: no table, and `bindings/index.ts:54` marks it experimental |
| CX-23 | Zero drop on Codex | 1.5 | `src/bindings/codex.ts`, `src/bindings/lib/not-expressible.ts` (new), `src/__tests__/e2e/codex-zero-drop.test.ts` (new) | CX-5 | CX-22 | Every field set in `kitchen-sink.at` is either found in the Codex output or is on the "not expressible on codex" list, and each listed field gives one validate warning. Planted: a new AST field with neither fails the test. Red today: `temperature` and `max-tokens` become TOML comments (`:202-209`) with no warning |

**Count: 23 tickets. Total: 40.5 builder-days.**

Sum check: 1 + 2 + 2 + 2 + 1 + 1.5 + 1 + 2 + 3 + 2 + 1 + 3 + 2 + 1 + 2.5 + 3 + 1 + 1.5 + 2 + 1 + 2 + 1.5 + 1.5 = 40.5.

### The edges, as a picture

```
CX-1 ------------------------------------------+
CX-2 --+--> CX-4 --+--> CX-5 --> CX-23 ---------|------------------+
       |           +--> CX-14 --+               |                  |
       |           +--> CX-20   |               v                  v
       +--> CX-8 --+--> CX-9 ---+--> CX-15 --> CX-16 --> CX-21 --> CX-22
       +--> CX-13 -|------^-----+      ^         ^         ^         ^
CX-10 -------------+--> CX-9           |         |         |         |
CX-3 (D2) ---------+--> CX-9, CX-12 ---|---------+---------+         |
CX-9 --> CX-11 ------------------------+--> CX-16                    |
CX-8, CX-9 --> CX-17 ------------------------------------------------+
CX-7 --> CX-18 ------------------------------------------------------+
CX-6 ----------------------------------------------------------------+
CX-12 ---------------------------------------------------------------+
CX-4, CX-7, CX-8 --> CX-19
```

Critical path: CX-2 (2) → CX-8 (2) → CX-9 (3) → CX-15 (2.5) → CX-16 (3) → CX-21 (2) → CX-22 (1.5) = 16 builder-days. It cannot fit before 27 Nov with review time. That is why there are two releases.

### The two releases

| Release | When | Tickets | What the user gets | What it says about enforcement |
|---|---|---|---|---|
| R1 | By Fri 27 Nov | CX-1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14, 15, 17, 18, 20, 23 (29 builder-days) | A scaffold Codex 0.156.1 accepts, registered hooks, gates, rules, the version line, conformance tiers A to D | Codex stays "experimental". Every guard prints "unverified". No "refuse" anywhere |
| R2 | From Mon 21 Dec, target Tue 22 Dec | CX-12, 16, 19, 21, 22 (11.5 builder-days) | Session agents, `guard --check`, import, the live proof, the parity table | Proven guards print "refuse" on the verified version. The experimental label comes off |
## Lanes, wave 1

### CXa: CX-6 and CX-7 (a small merged AGENTS.md; skills where Codex reads them)
Build the two tickets exactly as their rows in the table above say. Also fix W11 (it is CX-7's red). Keep every existing Codex test that is not pinning a bug green; a test that pins a bug (for example the old `.codex/skills/` path) is changed in the same commit with the reason in the commit message.
Files owned: `src/bindings/codex.ts`, `src/scaffold/merge.ts`, `src/scaffold/manifest.ts`, `src/sync/index.ts`, the Codex cases in `src/bindings/__tests__/bindings.test.ts`.

### CXb: CX-10 (one guard-script library for both bindings)
Move the guard-script builders (before-agent, before-action, gate wrappers, approval targets, and the session talk/spawn guard builders where they share code) out of `src/bindings/claude-code.ts` and `src/bindings/lib/session.ts` into `src/bindings/lib/guards.ts`, parameterized by a platform record (project-dir variable, hook payload field names, how a block is signalled). First write the golden test: scaffold every file in `examples/` and every `.at` under `src/__tests__/e2e/fixtures/` with the claude-code target into temp dirs and record a hash of every output file; after the move the hashes are identical. Then the second test from the CX-10 row (a Codex platform record yields scripts with no `CLAUDE_PROJECT_DIR`). Do not wire anything into the Codex binding yet.
Files owned: `src/bindings/lib/guards.ts` (new), `src/bindings/claude-code.ts`, `src/bindings/lib/session.ts`.

### CXc: CX-2 (the Codex contract)
Build `src/conformance/codex.ts` with the constants of section 4.1, `src/conformance/extract-codex.ts`, `spec/codex/hooks-contract.json`, `spec/codex/config-keys.json`, `spec/codex/features.json`, and `scripts/codex-drift.mjs`, as the CX-2 row says. Fill the snapshot files from the facts in sections 1.1 and 1.2; if learn.chatgpt.com is reachable from your sandbox, extract from the live pages and report any difference from section 1.2; if it is not, say so and build from section 1.2. `PROJECT_FORBIDDEN_KEYS`: the 6 named keys plus the 4 URL keys if you can read them from the config-advanced page; otherwise the 6 and a TODO naming the gap in the report. Do not edit `package.json` (another lane owns it); the report names the npm script line to add. Do not edit `src/conformance/claude-code.ts`.
Files owned: `src/conformance/codex.ts`, `src/conformance/extract-codex.ts`, `spec/codex/*`, `scripts/codex-drift.mjs`, a new test file `src/__tests__/e2e/codex-contract.test.ts`.

## Lanes, wave 2 (base: `origin/feat/icx-candidate`, which merges the rest of 0.11 and wave 1: CX-2, CX-6, CX-7, CX-10)

First run the full gate on your base. If anything is red besides the known root-only [I5], fix it at its cause before your own tickets, in its own commit ("fix(integration): ..."), and list it in the report.

### CXd: the Codex config and hook chain: CX-4, CX-5, CX-14, CX-23, CX-20, CX-8, CX-13 (in this order)
Build each ticket exactly as its row says, one commit or more per ticket, pushing after each green ticket. The facts are in sections 1.1, 1.2 and 4.1; the defects (W1-W18, M1-M19) are in section 2. Use the constants in `src/conformance/codex.ts` (built by CX-2) instead of new copies. For CX-4 add a small TOML parser as a devDependency (for tests only; the binding writes TOML itself in `src/bindings/lib/toml.ts`). CX-5: the Codex scaffold refuses a Claude model name (`opus`, `sonnet`, `haiku`, `fable`, any `claude-*`) with exit 1 and a message naming the agent; it does not invent a Codex model. CX-13: where the `codex` binary is not installed, the `execpolicy` part of the test is skipped with a message; the rest runs. Fix W1-W18 as their tickets cover them; a test that pins one of those bugs (for example `bindings.test.ts` pinning `untrusted` or `"opus"`) is changed in the same commit with the reason.
Files owned: `src/bindings/codex.ts`, `src/bindings/lib/toml.ts`, `src/bindings/lib/codex-hooks.ts`, `src/bindings/lib/codex-rules.ts`, `src/bindings/lib/not-expressible.ts`, `src/conformance/codex.ts`, `src/parser/validator.ts` (Codex warnings only), `package.json`, `package-lock.json`, the Codex tests.

### CXe: the version line per target and Codex inventory: CX-1, CX-18
Build both as their rows say. CX-1: the Claude Code output stays byte-identical (the text-pin tests prove it). CX-18 builds on the inventory roots that T-08 added.
Files owned: `src/conformance/index.ts` (new), `src/conformance/claude-code.ts`, `src/cli/index.ts`, `src/inventory/index.ts`, their tests.
