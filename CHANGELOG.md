# Changelog

All notable changes to agentopology are documented here.

## [Unreleased]

### [feature] A small AGENTS.md for Codex that keeps your own text (CX-6)

- The Codex `AGENTS.md` no longer holds agent prompts. Each prompt lives in `.codex/agents/<id>.toml`, between the prompt markers, so a 40-agent topology scaffolds an `AGENTS.md` well under Codex's size cap.
- The generated part of `AGENTS.md` sits between `agentopology:begin` and `agentopology:end` markers. A re-scaffold replaces only that block and keeps any text you wrote above or below it.
- `sync` reads prompts from the agent files. An `AGENTS.md` scaffolded earlier is still read for agents the files do not cover.

### [fix] Codex skills are written where Codex reads them (CX-7)

- Each skill is now `.agents/skills/<id>/SKILL.md` with `name` and `description` frontmatter. Nothing is written under `.codex/skills/` any more, since Codex never loaded those files.
- A skill with `disable-model-invocation` also gets `agents/openai.yaml` with `policy.allow_implicit_invocation: false`.

### [fix] README rule count matches the registered rules (I011)

- README.md and spec/validation.md now say 127 rules, the number the validator registers (V1-V127).

### [fix] Text-output snapshots no longer depend on the machine (I011)

- Setting `AGENTOPOLOGY_CLAUDE_VERSION` to a version (or `none`) replaces the `claude --version` check, so validate and guard --check print the same lines on every machine. The text-output snapshot test sets it to the verified version, and the snapshots are re-recorded with the padded strength column.

### [feature] People who are away, and approvals that expire (T-09)

- A top-level `person <id> { away: "2026-01-31..2026-02-14" }` block. A `human` takes `who: <person>`.
  Validate warns for every human step whose person is away today or later, with what the step does on
  timeout (V126). An unknown person or a malformed window is an error (V127).
- A human may declare `valid: "YYYY-MM-DD..YYYY-MM-DD"`. `step check` refuses a step that human guards
  once today is past the window.

### [feature] Schedule jobs say what carries them and what they survive (T-06)

- A schedule `job` takes `carrier: session | cron | launchd | cloud | calendar` and
  `survives: pane-close | reboot | away`. Other values are a validate error (V124).
- `carrier: session` with any `survives:` is an error (V125): a session cron dies with its session and
  after 7 days.
- `inventory` now lists launchd plists and crontab lines whose command points into the project folder,
  counted as the machine's and never required.

### [feature] Machines, and home-folder paths are an error (T-07)

- A top-level `machines { machine mac { os: macos } }` block, and `machine:` on session agents, schedule
  jobs and stores. A machine that is not declared is a validate error (V122).
- A hook, gate, tool or action command with an absolute path into one person's home folder
  (`/Users/<name>/`, `/home/<name>/`, `C:\Users\`) is a validate error (V123), because it only works
  on that machine.

### [feature] A store can name its owner (T-10)

- `owner: <agent>` on a store. If two agents that are not the owner both write the store, validate now
  reports an error (V121) that names both. An owner that is not an agent is an error too. Stores with no
  owner are checked as before.

### [fix] The validate inventory knows the talk log (N44c)

- `validate --inventory` no longer lists `.claude/state/talk.jsonl` as unmapped when the topology declares
  session agents, since the generated talk guard writes it.

### [feature] The visualizer page carries check results (VZ-3)

- `validate`, `guard --check`, `validate --inventory` and the Claude Code version stamp now have
  functions that return their results as data. The terminal text is unchanged, pinned byte for byte
  over every example.
- `visualize --dir <project>` reads those results and embeds them in the page, keyed by item id, with
  the sha256 of the `.at` source and the time they were read. A node's panel shows them under "Checks".
  With no `--dir`, every fact reads "not checked".

### [feature] `visualize` is quicker to run (VZ-11)

- With no file argument, `visualize` draws the only `.at` in the current directory, or in
  `.claude/topologies/`. With none or several it says so and lists them.
- The page is written to `~/.cache/agentopology/visualize/` unless `--output` is given.
- New flags: `--no-open` (write only), `--no-check` (ignore `--dir`, every fact "not checked") and
  `--print-summary` (node counts and facts on stdout). `visualize-brain` also honours `--no-open`.
- The browser opener is `open` on macOS, `xdg-open` on Linux, `start` on Windows and `wslview` under WSL.

## [0.10.1] - 2026-11-13

### [fix] Review fixes for the 0.10.1 session and import work (N44e)

- The talk guard now accepts a flow target whose id has letters, digits, `_` and `-` (for example a subagent `code_reviewer` or `Helper2`), matched exactly as declared. Session ids stay lowercase kebab-case and match exactly.
- `place:` must be lowercase (`a-z`, `0-9`, `-`, starting with a letter); `place: Ops` is now a V113 error instead of silently dropping the session from `.claude/sessions.md`.
- `talk: hub <name>` with a name that is not a session agent, and any `talk:` line that is not `all` or `hub <name>`, is now a V113 error naming the line.
- `scaffold`, `plan`, `export`, `brief` and `visualize` now resolve imports the way `validate` does, so a missing or mismatched import is reported instead of compiled over.
- The visualizer escapes `<`, `>`, `&`, U+2028 and U+2029 in the data it inlines, so a field containing `</script>` can no longer break out of the page script.
- An `import` that follows a brace inside a quoted string or a `#` comment is no longer dropped.
- Import checking reads and validates each imported file once, so a deep diamond of imports finishes quickly, and an imported `fragment` is checked for parse errors and its own names only, not as a whole topology.
- `guard --check` pads its strength column to the longest strength word, so `unverified` lines up.
- The README rule count check counts every registered rule, including those that take options.

### [fix] Talk guard reads both target fields (N44d)

- Claude Code sends the `SendMessage` target twice, as `to` and `recipient`. The talk guard now uses `to`, or `recipient` when `to` is absent, so a send that names only `recipient` is checked against the talk edges instead of slipping through. When both are present and differ after removing a `[ref]` suffix, trimming and lowercasing, the send is refused with `talk guard: to and recipient disagree` and logged as refused.

### [fix] Session guards: second review follow-ups (N44c)

- A `permission-mode` with characters other than letters, digits and `-` is no longer written into `.claude/sessions.md` or `scripts/start-sessions.sh`, even with `--allow-invalid`; the launcher is not written and the session gets no start line.
- The launcher skips a session only when herdr lists its exact name, so `lane-build-old` no longer hides `lane-build`, and an error banner that names the ids does not count as a listing.
- The talk guard refuses to write through a hard-linked `talk.jsonl`. When the log cannot be written (hard link, symlink, or an unwritable folder) an allowed send still goes through and prints `talk log not written` to stderr.
- A `[ref]` suffix on a `SendMessage` target must be only letters, digits, `_` and `-`, otherwise the send is refused. The spawn guard now refuses `subagent_type: false` and any other non-string value. A place name with unsafe characters is not printed in the `sessions.md` heading. `scaffold --prune` removes a stale `scripts/start-sessions.sh` when no session agents remain.

### [fix] Every documented import form is read, at the top of the file too (T02b)

- `import reviewer from ./review.at`, the quoted path, `import linter from registry:@org/linter@1.2.0`
  and `import auditor from ./audit.at sha256 "<hex>"` (also `sha256: "<hex>"`) now parse. Before, only
  `import "./f.at" as x` did and the others were dropped with no message.
- Imports written above the `topology` line are read, and checked like the ones inside it.
- A line starting with `import` that matches no form is a V8 error ("unrecognized import form").
- A registry import is not read from disk; `validate` prints a warning "registry import not checked".
- Converting a topology back to `.at` writes the `from` form and keeps every import.

### [fix] The import check reads the imported files (N43, T-02)

- `validate` now resolves each local `import "./f.at" as x` relative to the importing file. A missing file,
  a `sha256` that does not match the file, an import cycle, and any error inside the imported file are
  errors (V8) and make `validate` exit 1; errors from the imported file are shown with its path.
  Validating a string with no file path cannot resolve anything, so it warns `imports not checked`.

### [feature] Warn on bare model aliases when models are pinned (L-3)

- With `pin-models: true` at the top level, V119 warns once per alias (`opus`, `sonnet`, `haiku`, `fable`)
  used as a `model:`: an alias resolves differently over time, so use the exact id for a pinned run.
  `inherit` and exact ids are fine. Without `pin-models`, nothing changes.

### [feature] The visualizer draws session agents (VZ-1)

- A `runs: session` agent wears a "session" mark, and each `place` is a titled box around its sessions.
  Talk edges show their `[message: ...]` kind, and the inspector lists runs, place, decides and permission mode.
- Stores sit in their own band under the flow, and memory edges are faint until you hover them.
- On load the graph fits to the screen, including the place boxes, and leaves room for the open panel on narrow windows.

### [fix] Manual agents stay in the flow layout (N45)

- Agents with `invocation: manual` are laid out with the rest of the flow and keep their edges. Only a manual agent
  with no flow edge at all is parked at the side. The page data now carries every parsed field, including `runs`,
  `place`, `decides`, `permissionMode`, an edge's `message` and the topology's `decisions`.

### [fix] Session guards: fail-open and wrong-refusal fixes (N44b)

- The spawn guard now blocks when its input is empty, `{}` or has no object `tool_input`; a spawn with no `subagent_type` is still an ordinary spawn. It lowercases and trims the value, strips a `<prefix>:` namespace, refuses a non-string `subagent_type`, and refuses a `name` that equals a session id.
- The talk guard strips a trailing ` [ref]` (the mark ListAgents adds to duplicate names) before matching, lets a session message its own flow targets (such as its subagents) and `main`, refuses any target that is not `a-z`, `0-9` and `-` (so a newline or NUL no longer passes), and logs every refusal, including an oversize target or an unreadable payload.
- The prompt log writes `kind: unknown` for empty or malformed input, and ignores leading whitespace before `<cross-session-message`.
- The guards log to `$CLAUDE_PROJECT_DIR`, or to the project root found from the script's own path, and never append through a symlink. `talk.jsonl` is a trail, not evidence: whoever can write files can edit it, and `guard --check` says so.
- `guard --check` grades a spawn or talk guard `none` when the script no longer holds its generated `exit 2` line and `jq -er` read.
- The launcher single-quotes every value it interpolates and is not written when a place or session id is not `a-z`, `0-9` and `-`. It skips a session herdr already lists, warns that a rerun duplicates sessions when herdr cannot list them, and says in its header that the herdr subcommands are unproven.

### [feature] Session agents: scaffold, guards and launcher (N44b)

- `scaffold --target claude-code` writes each `runs: session` agent's file as for any agent, plus
  `.claude/sessions.md` with one start line per session (`AT_SESSION=<id> claude --agent <id> -n <id>`,
  with `--permission-mode` when declared) and `scripts/start-sessions.sh`, a plain POSIX launcher that
  opens one herdr tab per `place:` and one pane per session, or prints the start lines when herdr is not installed.
- A spawn guard (a PreToolUse hook on `Agent|Task`, `onFailure: "block"`) refuses to launch a session agent as a subagent.
- A talk guard (a PreToolUse hook on `SendMessage`) refuses, with exit 2, a send to a session the current
  session has no talk edge to. The current session is `$AT_SESSION`, set by the start line. When it is unset
  the send passes with a note on stderr; when it is set the guard fails closed on any parse error.
  Every send is appended to `.claude/state/talk.jsonl` as `allowed`, `refused` or `unguarded`.
- `guard --check` lists both guards and grades them `unverified`, not `refuse`, until the conformance facts
  mark PreToolUse on `SendMessage` and `Agent` as proven. Under the talk guard it says that a send through a
  terminal command, a shared file or a session outside the repo is not seen.
- Other targets (codex, cursor, claude-workflow) validate and draw session agents and print
  "session agents: experimental, not compiled".

### [feature] Decision seats see typed versus arrived input (T-04)

- New rule V120: an agent with `decides:` that a talk edge points at gets a warning, because a decision can
  arrive there as a message. Messages are not refused by keyword. Instead scaffold writes a UserPromptSubmit
  hook for that agent's session (active only when `AT_SESSION` is its id) that logs each prompt to
  `.claude/state/talk.jsonl` as `kind: arrived` when it starts with `<cross-session-message` and `kind: typed`
  otherwise, so a human-gate script can tell the two apart. The hook never blocks.

### [feature] Session agents: grammar and validate (N44a)

- An agent takes `runs: session` (beside `subagent`, `inline` and `fork`), `place: <name>`,
  `decides: [<decision>, ...]` and `permission-mode: default | acceptEdits | plan | bypassPermissions | auto`.
  A session agent's id is also its session name and message address, so validate requires it to be kebab-case.
- Who may talk is the flow edges between two session agents. `talk: all` and `talk: hub <name>` write them;
  the parser expands them into plain edges, so `export --format json` shows ordinary edges.
  `[message: ticket | report | ask]` on an edge records what crosses it. Talk edges are not checked as loops.
- New validate rules V113 to V118: field forms, `talk not declared: unguarded` when sessions have no talk edge,
  a `hub` pattern broken by an edge, two agents claiming one decision (and a topology-level `decisions: [...]`
  entry nobody claims), fields a session ignores (`background`, `skills`, `permissions`), and a talk edge between
  sessions in different permission modes.
- `agentopology docs agent` and `docs flow` cover the new fields; `parse -> serialize -> parse` keeps them.

### [fix] The version line reports the Claude Code that is actually installed (T-01)

- `validate` and `guard --check` now read `claude --version` (once per run, 3 second limit) and
  print `installed X: unverified` when X is not the version the output was checked against. If the
  version cannot be read, they print `unknown version: unverified`; if there is no `claude` on
  PATH, they print `Claude Code not installed`. Exit codes do not change. In `guard --check`, every
  line that reads "refuse" carries the same mark when the installed version is not the verified
  one. With the verified version installed, the output is unchanged.

### [feature] The visualizer builds its page data in one place (VZ-2)

- `src/visualizer/project.ts` holds `project(ast, facts)`, a pure function from the parsed topology to the data the page draws. Each node kind has one row in a rules table that lists the fields it carries and the fields it drops on purpose; a node kind with no row is drawn with a default rule that keeps every field.
- A new test checks that every field on every parsed node and edge in `kitchen-sink.at` and the examples reaches the page data or is claimed as dropped in the table, and that it fails on a field nobody claimed. Fields the page used to leave out silently (for example `timeout`, `join`, `custodianOf`, `extensions`, group members) now reach the page data.
- The page looks the same: the node ids and edges in the data are unchanged for every example.

## [0.10.0] - 2026-11-11

### [fix] A guarded script step is found inside a chained command (N42)

- `before-action.sh` tested whether the whole Bash command started with the step's command, so
  `cd repo && ./tool publish ep1`, `true; ./tool publish ep1` and `make x || ./tool publish ep1`
  ran the step with its gate unmet while `guard --check` reported the gate as refuse. The command
  is now split on `&&`, `||`, `;`, `|`, `&` and newlines; each segment, after a leading `(`, `{`,
  `then`, `do`, `exec`, `time`, `nohup`, `env` and `VAR=value` are stripped, is matched against the
  guarded steps, `unit-from` reads from that segment, and every matching segment is checked.
  Quoting is not parsed, which can only over-block. A command that runs the step indirectly
  (`bash -c`, `eval`, a script that calls it) is still not seen; `guard --check` now says so.
- The segments are read from a separate file descriptor and every child in the loop runs with stdin
  from `/dev/null`, so a gate's check script that reads stdin cannot swallow the later segments.

### [fix] `@types/node` is a devDependency

- It was missing, so on a fresh `npm ci` `npx tsc --noEmit` failed with hundreds of TS2307 errors
  (`Cannot find module 'node:fs'`); machines that had it installed by accident never saw it.

### [feature] `step check`: a script step asks whether its gates hold

- `agentopology step check <file.at> <step-id> [--unit U] [--dir D]` exits 0 when every gate with
  `before: <step-id>` holds, else 1, naming each failing gate and why. Hooks guard Claude Code
  sessions only; a script run from a terminal or a scheduler calls this at its start (`by: code`).
- A gate holds when its ledger's last record for the `after:` step (same unit, if given) is ok,
  and its `run:` (if any) exits 0 from D. A gate with neither is unsatisfiable ("nothing to
  check", the case V110 warns about). A step no gate guards exits 0 ("no gate guards <step>");
  a step that is no node exits 1. It reads ledgers and runs check scripts; it never writes.
- The ledger line format is documented in the gate grammar and the `gate` docs topic.

### [feature] Guards for script steps: a gate before an action refuses in Claude Code

- A gate whose `before:` is an action with `commands:` used to compile to nothing (V25: "invoke
  it from your playbook"), so a session ran the step whether or not the gate held. It now
  compiles to `before-action.sh`, a `PreToolUse` hook on `Bash` with `onFailure: "block"`.
  Exit 2 when the ledger has no ok record for the gate's `after:` step and unit, or its
  `run:` check fails; a command that matches no guarded step goes through.
- New, all optional: action `unit-from: "<regex, one capture group>"` reads the unit from the
  command line; top-level `records { record trace { path: "logs/{unit}/trace.jsonl" } }`; gate
  `ledger: <record id>` (omitted, the only record). A ledger is JSON Lines:
  `{"step": "<node id>", "unit": "<unit>", "ok": true, "at": "<ISO time>"}`, appended by the
  step's own script; the last line for the step decides.
- V110 (no ledger and no `run:`: nothing to check), V111 (bad `unit-from`), V112 (unknown
  ledger, unsafe record path, ambiguous ledger). V25 no longer warns for a compiled gate.
- `guard --check` reports such a gate as refuse by hook, noting it covers Claude Code sessions
  only.

### [breaking] Claude Code is the supported target; four bindings are removed

- **Removed:** `gemini-cli`, `copilot-cli`, `openclaw` and `kiro` (bindings), and the OpenClaw
  importer (`import --target openclaw`). `scaffold --target <one of them>` now says it was removed
  in 0.10.0 and to use 0.9.x. 125 tests that covered them went with them.
- **Experimental:** `codex`, `cursor` and `claude-workflow` stay. `targets` labels them and
  scaffold warns, because they are not verified against their platform the way claude-code is.
  `claude-workflow` is kept: it is a Claude target, the theory runs used it, and it feeds the
  hybrid seam in `examples/matchmat-ship.at`.

### [feature] `guard --target claude-code` writes only the guards

- `agentopology guard <file.at> --target claude-code [--dir D] [--dry-run]` adds the enforcement
  to a project built by hand: the hook scripts, the gate wrappers they call, the checks the gates
  run, and the `hooks` and `permissions` of settings.json, merged with what is there. Nothing
  else scaffold writes (agents, skills, commands, rules, .mcp.json, CLAUDE.md) is touched.
- The set is found by following script paths from settings.json, so a new hook script is picked
  up with no list to update. Edited scripts and checks that are no longer stubs are kept and
  named. A rerun changes nothing. It ends with the `guard --check` report and exits like it.

### [feature] `validate` says which Claude Code it was checked against

- Every `validate` run ends with `checked against Claude Code 2.1.319 (supports 2.1.295 and later)`,
  on success, warnings, errors and `--inventory`. `scaffold --target claude-code` and
  `targets` print it too. The numbers are read from the conformance constants, never retyped.

### [feature] Claude Code's hook contract as a snapshot, and a drift check

- `spec/claude-code/hooks-contract.json` is extracted from the hooks reference page: 33 events,
  10 with no matcher support, the matcher rules, the five handler types' fields, and each
  "Requires Claude Code vX". `hooks-contract.2.1.295.json` is the same contract at the minimum
  supported version, derived by dropping what needs a newer one.
- Tests hold the code to the snapshot. They found `CwdChanged` missing from the no-matcher
  events, where a matcher is silently ignored. They also check that every event and handler
  field the binding writes exists at 2.1.295.
- `npm run drift` fetches the page and exits 1 when the contract moved. `--write` accepts it.

### [fix] Hook matchers are checked the way Claude Code reads them; `if:` and `exit 2` work

- **V107 (error):** a matcher that can never match. Examples: permission-rule syntax
  (`Bash(rm -rf *)`; the argument filter belongs in the new `if:`), the dotted
  `mcp.chrome.*`, a bare `mcp__chrome`, and a regex that does not compile. An `if:` on an event
  that is not a tool event is also an error, because Claude Code never runs that hook.
- **`if:` on hooks:** a permission-rule filter on the tool's arguments, written on the
  settings.json handler and in agent frontmatter.
- **`run: "exit 2"`** (any shell builtin) is written as the command itself. It used to scaffold
  a stub named `exit` that exited 0, so the hook never blocked. **V108 (warning):** `exit 1`
  does not block; only exit 2 does.
- **V109 (warning):** a hook with `strength: refuse` guards an MCP server, but its matcher misses
  a tool of that server the topology names. `validate --inventory` also checks the tool names
  an owner lists in inventory.json (`"kind": "mcp-tool"`) and prints them as `matcher gaps`.
- The hooks doc topic taught `matcher: "Bash(rm -rf *)"` and `run: "exit 1"`. Neither works:
  the example now uses `matcher: "Bash"`, `if:` and `exit 2`, and gives the timeout in seconds.

### [feature] `inventory` and `validate --inventory`: how much of a project the .at accounts for

- `agentopology inventory [<dir>]` prints, as JSON, what is live in a project: every file in the
  .claude tree with its sha256, each settings.json hook handler, each .mcp.json server and each
  package.json script. It writes nothing; save it as `inventory.json` and settle its tags by hand.
- `agentopology validate <file> --inventory <dir or inventory.json> [--dir <project>]` adds
  `coverage: k of n live things are in the .at`. A live thing is accounted for when scaffold
  would write it from the .at, or the .at points at it (`file:`, a hook's or gate's `run:`, a
  tool's `script:`, `at:`, an mcp server, a skill folder it declares). It lists what nothing
  accounts for (unmapped, a warning) and what the .at points at that is not on disk (missing,
  exit 1). Things tagged `e` (the platform, the machine; `settings.local.json` is suggested as
  one) are counted apart.

### [feature] `guard --check` reads citations and credits cited guards

- A gate's `at: "path:line"` is checked on disk: the file exists, the line is in it, and `match:`
  appears within 5 lines. A citation that no longer holds is `none`, and the command exits 1, so a
  refactor that moves or removes the check is caught.
- A gate the binding gives no hook (one between two script steps, for example) is credited by the
  hook its edge cites, `[guard: lock-bash]`, when that hook is in `.claude/settings.json` and
  declares `strength:`. The credit reads "cited, not proven", and its `bypass:` is printed.
- An edge's written `[strength: none]` is reported as declared, never as a failure.
- A declared hook's settings entry is attributed however its interpreter is spelled, so it is no
  longer listed as a hand-built hook.

### [feature] Enforcement written in the file: `strength`, `by`, `at`, `match`, `bypass`, `guard`

Optional and additive, so no existing file changes meaning.
- A gate takes `strength: refuse | detect | hope | none`, `by: code | hook | settings | gate`,
  `at: "path:line"` (the code that refuses), `match:` (the text expected there) and `bypass:`.
- A hook takes `strength` and `bypass`.
- A flow edge takes `[strength: none]`, `[at: "story/SKILL.md"]` and `[guard: lock-bash]` or
  `[guard: [a, b]]`, alone or after `when`. An absence of enforcement can now be declared.
- New rules (106 in all): **V104**, the words; **V105**, a `guard:` names a declared hook or gate;
  **V106**, `at:` is a safe project-relative `path[:line]`, and `match:` needs an `at:`.
  validate never reads the project; checking the cited lines is `guard --check`'s job, which comes next.

### [feature] `guard <file> --check`: what a project enforces today

Read-only. For every gate, approval step and deny/ask rule, it works out what the claude-code
binding compiles it to, then looks in the project:
- **refuse**: its hook or settings rule is on disk, anchored to `$CLAUDE_PROJECT_DIR`.
- **none**: the binding generates one, but the project lacks it or names its script by a relative
  path. The command exits 1.
- **hope**: no Claude Code hook exists for it (an advisory gate, inline delegation, a gate between
  two script steps); only the playbook's prose asks for it.

Notes flag a check script that is a stub or missing (it blocks every run), a before-agent entry
without `onFailure: "block"`, and an approval step that `claude -p` denies. It prints
`enforcement: k of m steps refuse` and lists any hook in settings.json it can't tie to a step: a
hand-built guard it can't credit yet. That waits for the strength and `guard:` citation work.

### [fix] Generated hooks run from any directory (conformance v0)

Claude Code runs a hook in the session's current directory, not the project root, and that
directory moves when Claude changes directory. Every generated hook command except the
before-agent guard named its script by a relative path (`bash .claude/skills/...`). Run from a
subfolder, the script was not found, the shell exited 127, and 127 does not block, so the hook
was skipped. That included every SubagentStop gate. Measured on all 13 corpus topologies: 16 hooks.
- Every generated hook command is now `bash "$CLAUDE_PROJECT_DIR/.claude/skills/<topology>/scripts/<file>"`.
- New: `src/conformance/claude-code.ts` holds Claude Code's hook contract (33 events, matcher
  support, handler fields, `onFailure`, the PreToolUse decision schema), checked against the docs
  on Claude Code 2.1.319. `e2e/conformance.test.ts` scaffolds every example and fixture, checks
  their hooks against it, and runs each command hook from a subfolder with the event's JSON on stdin.
- Found and left open: a hook `run: "exit 1"` scaffolds a stub that exits 0 (N29), and a matcher
  in permission-rule syntax, such as `Bash(rm -rf *)`, never matches a tool name (N30).

## [0.9.2] - 2026-11-09

### [fix] Generated gates fail closed

Claude Code blocks only on exit 2. On 0.9.1 a gate could fail open: with `CLAUDE_PROJECT_DIR`
unset `before-agent.sh` exited 1, with `jq` missing 127, and a gate script nobody had written
exited 0. In each case the agent launched with its gate and approval step skipped.
- `before-agent.sh` and every gate wrapper now exit 2 on any error. An EXIT trap with a
  done-flag catches it, because macOS `/bin/bash` 3.2 hands the trap status 0 after an
  unset-variable error.
- A gate script stub exits 2 until it is written, the way action stubs already fail.
- The guard's settings entry sets `onFailure: "block"` (Claude Code 2.1.295+), so a hook that
  cannot start or times out blocks too. Older versions may ignore the field (undocumented);
  the scripts' own trap still holds there.
- Logging and observability hooks are unchanged: exit 2 there would stop a subagent from
  finishing.

## [0.9.1] - 2026-11-09

### [fix] A gate's `description:` is read, as V96 asks

- V96 tells you to put a gate's explanation in `description:`, but the parser never read that
  field on a gate, so 0.9.0's V102 rejected it. It's now a gate field: parsed, kept by import
  and serialize, and documented in `docs gate` and the grammar. Found on the content harness:
  all 17 V102 errors in its two files were gate descriptions.

## [0.9.0] - 2026-11-09

**Breaking: a file with a field or block the parser does not read now fails `validate` (V102),
and so does an agent's or gate's `behavior:` other than `advisory`/`blocking` (V103).** On 0.8.0
those names were dropped in silence and validate passed. This release also carries the import fix
(PR #27): import reads only what it needs on a repo root, always ends, and recovers the flow.

### [fix] An unknown field or block is an error, never dropped in silence

- **V102 (error).** Every field and block name in a node (orchestrator, agent, action, gate,
  human, group), `meta`, a hook, job, artifact, tool or skill, and every topology section, must be
  one the parser reads. A typo (`modle:` → "did you mean `model`?"), a field of another node type
  (`produces:` on an action → "it is a field of agent") or a block the language does not have
  (`contract c1 { }`) used to vanish from the AST while validate printed "All validation rules
  passed" and scaffold dropped it. On 0.8.0, 15 of 17 probe cases were dropped this way.
- **V103 (error).** An agent's or gate's `behavior:` must be `advisory` or `blocking`; any other
  value was emitted into the scaffold unchecked.
- **Breaking for files that relied on the silence.** A file with a name the parser ignored now
  fails validate with exit 1. Words the language does not have yet (`serves`, `strength`,
  `state`) are errors until they are added.
- **The docs taught dropped forms.** `docs agent` listed 15 fields by their AST names
  (`maxTurns`, `onFail`, ...), which the parser ignores; they are now the names you write
  (`max-turns`, `on-fail`). `docs artifacts` showed `NAME { }`; the parser reads
  `artifact NAME { }`. `kitchen-sink.at` and two examples carried such fields and are fixed
  (an orchestrator `plan:` and an undeclared `hooks { PostToolUse { } }` that the binding
  already synthesizes are removed).
- Not checked yet (open findings N25, N26): an agent's `role:` is still not read, and V102 does
  not look inside free-form blocks (`settings`, `env`, `memory`, `providers`, `flow`, ...).

### [fix] Import works on a repo root, and recovers the flow

- **Reads only what it needs.** For Claude Code: the root `.claude` folder's Markdown, JSON and
  shell files, `.mcp.json`, and `.at` files. `.worktrees`, `.claude/worktrees`, `dist`, `build`,
  `coverage` and the source tree are never read, so an `agents/x.md` in the source is no longer
  an agent. A skill the author named `build` is kept. Symlink cycles end. On a client repo with
  31 agents 0.8.0 tried to hold 1,061,701 files (16.4 GB), ran 656 seconds and was terminated with
  no output; the read is now 143 files.
- **Always ends, and says why.** An unreadable, broken or oversized (over 5 MB) file is skipped and
  named; a link at the root is not followed out of the project; past 256 MB the read stops with a
  message and exit 1. The first line prints before any read.
- **Recovers the flow.** A `.at` that shares at least 2 agents, and half of its own, supplies its
  edges, actions, humans, gates and orchestrator; an agent's own file wins. That repo's export
  went from `edges: []` to 52 edges. Scaffolding such an import wires the recovered gates into
  settings.json (hooks are added, the user's are kept).
- **Says what it does not know.** The CLI and the top of the `.at` report sources used and
  skipped, agents wired and unknown, agents declared with no file, and possible handoffs. No edge
  is invented; names that match only by suffix are reported, not mapped.
- An agent with no `model:` imports as `model: inherit`; a gate heading with a note gives a clean id.

## [0.8.0] — 2026-10-30

### [feat] The language says what Claude Code can do, out loud

- **How a node runs is on the node.** `runs: subagent | inline | fork`: `inline` and `fork`
  compile to a skill (fork with `context: fork`, a fresh context), never a subagent, and the
  playbook says how to call each. `independent: true` marks a critic or judge: it is told to
  judge only its artifacts, the playbook hands it nothing else, and it cannot run inline.
  New rule **V101**.
- **Hooks are a typed union:** `command`, `prompt`, `agent`, `http` (`url:`), `mcp_tool`
  (`server:`, `tool:`), `mod`, plus `async:` on a command and `model:` on a judge. New rule
  **V100**: each type has its fields, and a judge sits on an event Claude Code runs judges for.
- **First-class fields.** Agent: `color`, `initial-prompt`, `omit-claude-md`; `thinking`
  compiles to Claude Code's `effort` (one word for one concept, as decided in 0.5.0). Skill:
  `when-to-use`, `argument-hint`, `arguments`, `paths`, `shell`, `model`, `thinking`,
  `disallowed-tools`. Import reads them first-class.
- **Permission warning.** An agent asking for `acceptEdits`, `auto`, `dontAsk` or
  `bypassPermissions` is warned at scaffold: a subagent cannot widen its session's permissions.

Proven by `e2e/compile.test.ts` (every phase-4 test fails on 0.7.0) and live L3 (real Claude Code
registers `runs: fork`/`inline` nodes as skills, and holds back a skill with `paths:`).

## [0.7.0] — 2026-10-30

### [fix] What scaffold writes, Claude Code reads as meant

Each of these compiled to config Claude Code skipped, misread or never fired. Proven by
`src/__tests__/e2e/compile.test.ts` (each test fails on 0.6.0) and live tests L3 to L5 in
real Claude Code.

- **Gates after an action or a human are enforced.** They compiled to no hook. When `before:`
  names an agent, the gate now runs in a PreToolUse hook on the Agent tool: a failing gate
  blocks the launch and shows its reason.
- **A human node is an approval step.** It compiled to an agent file Claude Code ignores. Now
  Claude Code asks the user before launching the next agent, and the playbook says to ask.
- **Hooks fire.** `type: prompt` hooks compile to prompt handlers (were commands); `AgentStop`,
  `AgentStart`, `ToolUse` and `Error` map to Claude Code events; a regex matcher no longer
  breaks the agent file's YAML.
- **Agents register.** A manual agent keeps its description (Claude Code skips one without);
  `confirm` and `bypass` map to real permission modes; `yes`-like values are quoted; a model
  Claude Code does not have is omitted with a warning.
- **MCP and permissions.** A url server gets `type: http`; MCP names convert in whole-server,
  wildcard and dotted forms, permission rules included; `ask` rules are emitted.
- **Run lines.** The script is the word after the interpreter, never an argument; a project
  script runs in place from the project root with its arguments.
- **Skills, actions, tools, schedules.** A skill's `prompt:` reaches the model (and a skill may
  hold a `prompt { }` block); an action's `commands:` are emitted for every kind; a tool's stub
  goes where its `script:` points; schedules run headless from the project root and `every:`
  converts to cron.
- **The topology context** goes to `.claude/rules/<topology>.md`, so it never competes with the
  project's own CLAUDE.md.
- **Sync is a fixed point.** The prompt is marked in the agent file; scaffold then sync no longer
  grows the prompt, and an edit comes back once.
- `scaffold --dry-run` shows what a settings.json or .mcp.json merge would change, key by key.
- Output is byte-stable (no date in stubs).

### [feat] Two new rules

- **V98** (error): a `gate`, `hook`, `tool`, `job`, `command` or `level` written outside its
  container block was dropped with no message.
- **V99** (warning): an agent's `skills:` / `mcp-servers:` or a skill's `agent:` names nothing
  the topology declares.

## [0.6.0] — 2026-10-30

### [fix] Scaffold only changes what it owns (#22)

Scaffold used to write every file on the first run, so it overwrote hand-written files and,
through a symlinked skill folder, wrote into a second repository. Now every run goes through
one plan: a file scaffold did not create is a conflict and is kept (unless `--force`), a
symlink is never written or deleted through, an unsafe path aborts the whole run, and
`--prune` deletes only files still exactly as scaffold left them. `settings.json` merges:
every permission and every hook the user wrote is kept. Each topology keeps its own manifest
(`.scaffold-manifest.<source>.json`). Settings `env` no longer carries `${VAR}` text, which
Claude Code applied literally ("Invalid API key" in 6 of the 10 examples). New rule **V96**:
a `run:` must be a command, not prose.

### [feat] A hand-built system comes into .at without losing anything (#23)

New field **`file:`** on any agent, human, group, skill or command: the internals live in that
hand-written file, and scaffold never generates it. `import` sets it on every file no scaffold
created. On this repo's own `.claude/`, import then scaffold now leaves 73 of 73 files
byte-identical, also with `--force` (before: 0 of 72 identical, 37 missing). New rule **V97**
(`file:` is a project-relative path). `--allow-invalid` compiles despite errors; `--force` alone
no longer does. Import fixes: permissions read from `permissions{}`, `tools: Read, Grep` string
form, flowless agents imported as `invocation: manual`, and an agent's extensions no longer
leak into project-wide settings. A hook's own script is never overwritten.

### [feat] Hooks can be Mods; project hooks run by their interpreter (#20, #21)

`type: mod` hooks scaffold as a Claude Code plugin (rules **V94**, **V95**). A project hook
runs through `$CLAUDE_PROJECT_DIR` by its interpreter, and a `run:` may name one.

### Tests

A regression suite indexed in `spec/testing.md`, and live tests (`AT_LIVE=1`) that start real
Claude Code on every scaffolded example and on an imported hand-built project: 12 of 12 pass.

## [0.5.2] — 2026-09-23

### [fix] A gate is drawn on the path it guards

A gate declared with both `after` and `before` was placed at the midpoint between its two
nodes with no lines at all, so it looked like it floated free of the flow; two gates on the
same pair were drawn on top of each other. Seen on a real 28-node topology.

Now the visualizer draws `after → gate` and `gate → before` (following `afterAll`/`beforeAll`),
places gates that share a pair side by side in declaration order, and highlights a gate's
`before` anchor on hover. The planner was always right (`agentopology plan` splices gates
correctly); only the drawing was wrong.

Proven by `src/visualizer/__tests__/gate-connectors.test.ts` (runs the page's own script in a
node vm), with two red controls: connectors off → the path assertion fails; the side-by-side
offset off → the overlap assertion fails.

## [0.5.1] — 2026-08-26

### [feat] The validator teaches the fix, not just the failure

The package shipped 41 documentation topics and 93 validation rules, and the two
never met. A rule told you a field was wrong; nothing showed the right form.

Now every rule whose fix is a **shape** carries a worked example, printed inline
when it fires:

```
  ERROR [V89] agent "a" uses `prompt:` as a key-value field, but agent
              prompts must be a `prompt { }` block — this value is ignored

  ── how to write it ──────────────────────────────────

  [V89]
    agent analyzer {
      model: sonnet
      prompt {
        Read the diff at workspace/pr-diff.md.
      }
    }
    → agentopology docs agent
```

Deduplicated by rule and capped at three, so a badly broken file cannot produce
more teaching than output — twelve V90 errors get the lesson once. `plan` shows
the same on its refusal path.

**Why in the tool rather than beside it:** a skill loads its prose up front
whether you need it or not and only works on one vendor. A CLI serves the right
snippet at the moment of the mistake, in a few hundred bytes, on Codex and
Gemini too.

### [feat] `agentopology docs --agent`

The compact path for writing a `.at` from scratch: **2 KB**, against 104 KB for
`docs --all`. The shape, plus the five rules that actually bite in practice.
Nobody should load a hundred kilobytes to write one topology.

### [test] The lessons cannot teach a mistake

Every example a lesson presents as correct is parsed and validated, and must be
clean under the rule it teaches. It caught two on its first run: V13's snippet
referenced undeclared nodes (a V13 violation), and the agent guide's own
topology failed V15 — it did not cover the `approve` branch, which is trap #4
in the guide's own list.

1513 tests.

## [0.5.0] — 2026-08-26

Everything here came from **first contact**: a session that orchestrated ~20
agent lanes, wrote the remaining four days as a topology, and filed one bug and
seven capability asks. Their framing set the direction — *"closing the loop
between the plan, the run, and the next plan."*

Two of the seven were built as asked. Two were built differently, because
measuring them first showed the ask was aimed at the wrong thing. Two were
deferred. One turned out to be already solved.

### [feat] `plan` reports what the filesystem says about each step

A topology already declares what each role writes. Whether those files exist on
disk **is** the run state. `plan` now reports per step — outputs present,
outputs missing, or undecidable — and stops there.

Deliberately **not** built: a run-state sidecar, `status:` fields in the `.at`,
or `--resume`. A sidecar would record *"I finished"*; the filesystem records
*"the artifact exists"*, and only the second survives a crash between stamping
and writing. And skipping a step on this evidence would make a judgement on the
agent's behalf and hide it — a truncated file counts as present. **Report, don't
decide.** The brief says so and points at `git log`.

The invariant this protects: **a `.at` file never contains a fact about a
specific run.** A test asserts the brief never mutates the AST.

### [feat] V93 — an edge should declare what crosses it

For an edge between two agents that both declare paths, `writer.writes ∩
reader.reads` must be non-empty. Empty means the receiver runs after the sender
with none of its output.

A **warning**: passing a result inline is legitimate. Skipped entirely when
either side declares nothing — undecidable, not wrong.

It fired on 26 edges across six real files on its first run, and two were
genuine design bugs **in our own examples**: `simple-pipeline`'s revision loop
sent the writer back to revise without giving it the review, and
`data-processing`'s back-edge re-ran the synthesizer without the report. Both
fixed.

### [feat] Multi-anchor gates — `after: [a, b, c]`

One declaration, many attachment points, one gate step per anchor. A repeated
verification ritual copied per lane will drift, and the whole value of a ritual
is that it is identical everywhere.

Not an agent capability — the brief gets the same gate steps and `scaffold`
emits the same hook entries either way. What changes is that they can no longer
disagree.

`gateAnchors()` is the single normalisation point. An audit mapped every read
site first: TypeScript catches four, and ~18 more would have accepted an array
**silently** — a hook matcher shipping `["a","b"]` into `settings.json` where the
hook simply never fires, `g.after === id` never matching, ~12 lookups inside the
visualizer's untyped browser-JS template literal, and a serializer emitting
`after: a,b` which re-parses as the single id `"a,b"`. Each class now has a test
verified to fail without its fix.

### [fix] Cursor's `preToolUse` matcher named the wrong node

Found by byte-diffing all 10 examples across all 8 bindings before and after:
1208 of 1213 files identical, and the five that differed were a bug. Cursor
selects `preToolUse` **because** `before` is set, then matched on `after` — so
`after: writer, before: reviewer` emitted `matcher: "writer"` and the pre-hook
fired before the wrong node.

### [feat] `thinking` gains `xhigh`, and `max` stops collapsing

The ask was an `effort` field beside `model`. `AgentNode.thinking` already
existed and codex already compiled it to `model_reasoning_effort` — so `effort`
would have been a second word for one concept. Instead:

- `xhigh` added to the enum
- codex mapped `max → "high"`, leaving `max` and `xhigh` with no distinct value
- `claude-workflow` emitted nothing for reasoning and never read
  `agent.thinking` at all — on the one target whose runtime accepts `effort` as
  a literal `agent()` option. It now emits it.

A test asserts no `effort` field exists, so the decision cannot quietly reverse.

### [fix] An error back-edge no longer breaks reachability *(shipped in 0.4.3)*

### Honest KPI result

The derived-run-state target was **missed**, and the miscalibration was mine: a
70% target set from an *agent-level* measurement, applied to a *step-level*
metric that also counts actions, gates and human nodes — undecidable by
construction. On the steps evidence can apply to it is 77%; across all steps,
39%.

More importantly: **0% on the topology of the person who asked for it**, because
it declares no `writes` anywhere. The feature works as designed and is useless
without the data.

1505 tests, up from 1474. 93 rules, V1-V93 contiguous.

## [0.4.3] — 2026-08-26

### [fix] An error edge pointing backward made the whole downstream unreachable

Reported on first contact: a 13-step topology that **validates clean** rendered
eleven nodes as "unreachable from the entry point".

`-x->` error edges were skipped by back-edge detection but still handed to the
ranker. So `take6-staging -x-> oom-fix` looked like a genuine cycle
(`oom-fix → take6-staging → oom-fix`), Kahn could not rank it, and everything
downstream fell to depth −1.

An error edge is an exception route, not a step — a catch, not part of the happy
path. It no longer contributes to ranking at all.

The report attributed this to the second root of a parallel fan-out. That part
was already correct; there is now a test pinning it so the fix cannot regress it.

### [docs] `docs/FEEDBACK-FIRST-CONTACT.md`

The seven capability asks from that session, each checked against what the
package actually supports today and ranked by value over cost. Two are small
(multi-anchor gates, an `effort` field), one is Phase 2's first honest step
(edge schema compatibility — the schemas already exist, nothing compares them),
and the largest names an axis the roadmap did not have: **a topology can
describe intention and has no vocabulary for what actually happened.**

## [0.4.2] — 2026-08-26

### [feat] `agentopology/plan`, `/render`, `/resolve` subpath exports

The interpreted-mode modules were shipped but not reachable — `package.json`
exported only `.`, `./parser`, `./bindings` and `./visualizer`, so
`import { buildExecutionBrief } from "agentopology/plan"` threw. Now exported,
with `renderBriefMarkdown` re-exported from `plan` so both halves are one import.

### [docs] README covers both lifecycles

The hero and the "What It Does" diagram still described a one-way compiler:
`.at` in, platform configs out. It now shows the fork — `scaffold` to files, or
`plan` to a brief your coding agent enacts — plus a section on interpreted
execution with a real render, the four questions the brief answers, and the
three autonomy notches.

Corrected a stale "29 built-in rules" (it is 92) and the programmatic API
example, which imported subpaths that did not exist.

### [test] The README is now checked against the package

`src/docs/__tests__/readme-sync.test.ts` fails if the README imports a subpath
`package.json` does not export, states a rule count the validator disagrees
with, points at a `docs` topic that does not exist, or contains an `.at` snippet
that does not parse and validate. Documentation drift is not a discipline
problem — it is a missing test, the same shape as the spec drift fixed in 0.4.0.

## [0.4.1] — 2026-08-26

### [fix] `plan` dropped every gate from the rendered flow

`0.4.0` held nodes with no edges out of the terminal spine, so a topology's
manual-invocation agents would not read as concurrent work. But a **gate** never
appears in an edge either — it binds through `after`/`before`, which is the
whole reason `resolve/order.ts` splices them by anchor. So every gate was
classified as "declared but not in the flow" and vanished from the render.

Only the ASCII render was affected. The execution brief, the order resolver and
all 8 bindings were correct throughout — a scaffolded gate still compiled to its
hook.

The test that should have caught this compared the gate's line POSITION against
the agent it gates. When the gate was dropped from the spine, its name still
appeared in the "declared but not in the flow" line further down, so the
positional assertion held. It now asserts the gate is present in the spine by
its glyph, before comparing anything.

## [0.4.0] — 2026-08-26

### [feat] `agentopology plan` — interpreted mode, a second lifecycle for a topology

A `.at` file has always compiled to a persisted harness. It can now also be
**enacted directly**, by the coding agent already in your session, with nothing
written outside the session scratchpad.

```bash
agentopology plan <file>.at --mode plan|execute|auto [--task "..."] [--brief]
```

The premise: **the host coding agent is already the runtime.** It plans, spawns
subagents, runs them in parallel, reads files, retries and re-plans. It does not
need generated agent files to do any of that. So `plan` does not run anything —
a CLI cannot spawn subagents. It is a **linter and an orderer**: it validates
(the agent that wrote the file can write an illegal one), applies the spec's
defaults, resolves execution order, and emits an **execution brief** — a
Markdown program in eleven fixed sections that a host agent follows.

The brief resolves what a host would otherwise guess: handoffs as
`writes ∩ reads`, what each reader **must not** read, which same-step roles are
mutually blind, gate tiers, loop budgets, and every declaration that cannot be
honoured at runtime. Nine ambiguity kinds are detected statically and pre-filled,
each carrying a concrete `.at` edit that would remove the guess.

Not a replacement for `scaffold`. The same declaration, two execution backends —
a **lifetime** choice, not a strategy one. `agentopology docs interpreted-mode`
explains which to reach for.

### [feat] Terminal flow renderer, and two new export formats

`plan` prints an ASCII flow graph ranked by real execution order — gates spliced
where their `after`/`before` puts them, exclusive branches drawn as branches with
their conditions, loops with their budgets. Also available as
`--format ascii` and `--format brief`.

### [fix] Gates were ranked as graph sources

Gates bind through `after`/`before`, never through edges, so their in-degree is
zero and a topological sort ranks them **first**. On `examples/code-review.at` a
post-review gate sat next to the entry action. Execution order is now resolved
with gates spliced at their anchors, including gate-to-gate anchors regardless of
declaration order.

### [fix] An unphased agent no longer sorts differently on every target

Seven consumers each chose their own sentinel for an undeclared `agent.phase`:
`MAX_SAFE_INTEGER` in claude-code and claude-workflow, `999` in gemini-cli, `0`
in openclaw, kiro, mermaid and the markdown exporter. The same topology put the
same agent **first on four targets and last on three** — the exact failure
"write once, deploy to any platform" exists to prevent. `src/resolve/phase.ts` is
now the single definition, and a test fails if any consumer reintroduces its own.

### [fix] `codex` no longer defaults `permissions` to the strictest policy

The spec's default is `autonomous`, which maps to Codex `on-request`. The binding
used `supervised`, which maps to `untrusted`. Omitting the field produced an
agent that asked permission for everything.

### [fix] `settings.json` hook merging was written, tested, and unreachable

`deepMergeSettingsJson` handles union-merged permissions, merged env, and
topology-owned hooks. The scaffold pipeline routed `settings.json` to the generic
JSON merge instead, which cannot update an existing `hooks[event]` array and can
never remove one — so scaffolding a hook into settings that already declared that
event silently dropped it.

### [feat] Four new validation rules, and the spec now tracks the validator

| Rule | Catches |
|---|---|
| **V89** | `agent.prompt` written as `prompt: "path"` — the string form belongs to `skill`. Two shipped examples did this on eight agents, pointing at a directory that never existed, and those agents scaffolded with their own description as their entire instruction set. |
| **V90** | A field value that swallowed the next field. Fields are one per line; the grammar never said so, and `{ model: sonnet retry: 3 }` made `model` the string `"sonnet retry: 3"`. |
| **V91** | A required field satisfied by a parser-injected placeholder. V7 is named *Model required* and passed on an orchestrator with no model, because the parser had substituted `"unknown"`. |
| **V92** | An edge's attributes split across two brackets. `[when ...] [max N]` produced the condition string `a.verdict == fail] [max 3`, silently. |

`spec/validation.md` documented 35 rules while the validator implemented 89 —
fifty-four existed only in source, because nothing compared them. The table is
now generated from the registry and a test fails if the two ever diverge. **92
rules, V1-V92, contiguous.**

### [feat] `docs/KPIS.md` and `docs/PRIOR_ART.md`

29 metrics across four layers, each naming the instrument that measures it. And
the priority record: `agentopology@0.1.0` was published to npm on **2026-03-19**,
four months before "graph engineering" became the name for the practice. Three
copy-pasteable commands let a stranger verify that without trusting us.

### Notes

Every fix above was found by **using the tool on itself** — a stranger's topology
run through `plan`, and a review topology whose verifier stage reproduced each
claim against the real CLI before accepting it. 22 findings acted on. The compile
path is unchanged: all 8 bindings produce byte-identical output.

1467 tests, up from 1351.

## [0.2.5] — 2026-05-30

### [feat] `claude-workflow` binding — compile topologies to the Claude Workflow runtime

The first binding whose output **executes** (a Claude Workflow script) rather than
only configuring a project. `agentopology scaffold <file>.at --target claude-workflow`
compiles the **deterministic fan-out phases** of a topology — the phases whose
agents are marked `extensions { claude-workflow { execution: workflow } }` — into a
`<topology>.workflow.js` (a Claude Workflow tool script using `export const meta`,
`parallel()`, `agent()`, the `schema` option, and `isolation: 'worktree'`). It also
emits a `<topology>-SEAM.md` (the Blackboard hand-off contract), a
`<topology>-README.md` (human-node split), and a `<topology>-LOSSY-REPORT.md` that
loudly lists every primitive that could not be translated — nothing is dropped
silently. `human` nodes force a workflow split; session-fixed concerns
(permissions, providers) are reported, not faked.

### [feat] Hybrid model — `claude-code` host + `claude-workflow` rung from one topology

One `.at` topology can compile to **two coupled targets at once**. `claude-code` is
the **host** (the event-driven layer: agents, hooks, the Blackboard, concurrent
observability, the human/gate/branching nodes). `claude-workflow` is the embedded
**deterministic rung** (the parallel fan-out phases). They couple through the
Blackboard files (`memory.workspace`): the host launches the rung and observes its
writes live via a `PostToolUse` hook — giving concurrent observability the Workflow
runtime cannot express on its own. The `claude-code` binding is now hybrid-aware:
agents marked `execution: workflow` are NOT emitted as host subagents (the rung owns
them); instead the host emits the launch glue + the observe hook + a "Hybrid run
order" block in `CLAUDE.md`.

The hybrid is **opt-in and backward-compatible**: a topology with no
`execution: workflow` marker compiles to pure `claude-code`, unchanged.

### [internal] `src/bindings/lib/seam.ts` — single source of truth for the seam

The `claude-code` and `claude-workflow` bindings share one module for the seam
namespace, the `execution: workflow` predicate, the generated-artifact filenames,
and the Blackboard root — so the two halves cannot drift.

### [test] hybrid end-to-end test

`hybrid-e2e.test.ts` compiles both bindings from one `.at` file and proves they
compose: agents partition cleanly, both agree on the seam, the generated
`workflow.js` is valid ES module syntax (`node --check`), the host wires the
observer, and the LOSSY report names the human split. (1310 tests total.)

### [docs] strategy + mapping

- `docs/AT_VS_WORKFLOW_STRATEGY.md` — why `.at` is the runtime-agnostic standard
  (Terraform-for-agents) and Claude Workflow is its first compile target.
- `docs/bindings/claude-workflow-mapping.md` — the complete bidirectional mapping:
  every `.at` primitive + design pattern classified CLEAN / LOSSY / UNREPRESENTABLE.
- `examples/matchmat-ship.at` — the dogfood hybrid topology.

## [0.2.4] — 2026-05-19

### [feat] `orchestrator { delegation: inline | subagent }` field (#7)

Topologies can now declare how the orchestrator runs the agent nodes. The
new `delegation` field on the orchestrator block has two values:

- `subagent` (default): the orchestrator spawns each agent via the platform's
  subagent / Task-tool mechanism. Each agent runs in its own context window.
  On claude-code, `SubagentStop` hooks fire and gates compile to those hooks
  (the behavior every version up to 0.2.3 shipped).
- `inline`: the orchestrator drives every agent step in its own session
  context. Agent `AGENT.md` files are read as prompt fragments by the main
  session; no subagent is ever spawned via Task.

### [fix] claude-code: suppress dead `SubagentStop` hooks in inline mode (#7)

When `orchestrator.delegation: inline` is declared, the claude-code binding:

- Skips emitting `SubagentStop` hooks for every gate, regardless of whether
  the gate's `after:` target is a registered subagent_type — no subagent
  ever runs, so the hook would never fire.
- Skips emitting any global `hook { on: SubagentStop }` / `SubagentStart`
  declaration with a one-line warning explaining why.
- Updates the gate-wrapper script header to say "Enforcement: NOT wired as
  a SubagentStop hook (orchestrator.delegation is 'inline'). Invoke this
  script from your /<topology> playbook at the right step."
- Adds a **"Gates to invoke (inline-orchestrator)"** section to each
  generated `.claude/commands/<trigger>.md` listing every blocking gate
  with a copy-pasteable `bash` invocation, the `after:` step name, and the
  `on-fail` semantic. This is the cheat sheet pattern the youtube-flywheel
  topology in `agentopology-content` arrived at by hand.

Default behavior is unchanged: topologies without `delegation:` continue
to compile gates to `SubagentStop` hooks exactly as in 0.2.3.

### [feat] New validator rule V87 — orchestrator delegation enum

`orchestrator.delegation` must be one of `subagent` or `inline`. Any other
value (including typos like `inlined`, `delegate`, etc.) is a hard error.

### Migration

If your topology drives every agent step from a slash-command playbook and
the scaffolded `SubagentStop` hooks have always been dead config for you,
add one line to your `orchestrator` block:

```at
orchestrator {
  model: opus
  delegation: inline   // <-- add this
  handles: [start, finish]
}
```

After re-scaffolding, your `settings.json` will have no `SubagentStop`
entries and the trigger playbook (e.g. `.claude/commands/<topology>.md`)
will contain a ready-to-paste cheat sheet for invoking each gate at the
right step.

## [0.2.3] — 2026-05-19

### [refactor] Lift `shellStub` to shared `src/bindings/lib/stub.ts` (#4)

The `shellStub()` function was duplicated across five binding files
(claude-code, codex, gemini-cli, kiro, openclaw) and declared but unused in
cursor.ts. Each copy now lives in one place: `src/bindings/lib/stub.ts`.
Cursor's dead copy was removed.

### [feat] Machine-readable `AGENTOPOLOGY_STUB` marker in stubs (#4)

Every script produced by `shellStub()` now contains the literal line
`# AGENTOPOLOGY_STUB — fill this in before relying on this script`. The
marker is:

- A comment, so it never affects script behavior at runtime.
- Removed by the user once they implement the script — that single action
  flips the file out of "stub" state for all downstream tooling.
- Pinned by a unit test so downstream gate-runners or CI scripts can match
  on it reliably across minor versions.

Use `isStubContent(content)` from `agentopology/bindings` (exported via
`src/bindings/lib/stub.ts`) to detect stubs programmatically.

### [feat] `agentopology scaffold` reports stub count and paths to stderr (#4)

After a successful scaffold run, the CLI now emits a yellow warning to
stderr listing every generated file that contains the `AGENTOPOLOGY_STUB`
marker. Output looks like:

```
  3 stub(s) need implementation before this topology can run:
    · .claude/skills/yt/scripts/validate-brief.sh
    · .claude/skills/yt/scripts/qa-render.sh
    · .claude/skills/yt/scripts/check-platform-auth.sh
  Search for "# AGENTOPOLOGY_STUB — fill this in before relying on this script" — remove that line when each script is implemented.
```

stdout is unchanged so existing automation that captures the file list keeps
working.

### [feat] New `agentopology stubs <project-dir>` command (#4)

Scan an already-scaffolded project for unimplemented stubs. Walks the
directory (skipping `node_modules`, `.git`, `dist`), greps each file for the
marker, and prints a sorted list. Exits 1 if any stubs remain, 0 if clean —
designed for CI:

```sh
# In your CI pipeline:
npx agentopology stubs ./
```

### [fix] claude-code: gate SubagentStop hooks only emitted for agent/group targets (#3)

The `SubagentStop` hook's `matcher` field is matched against the registered
`agent_type` (the name of a `.claude/agents/<name>/AGENT.md` subagent). Only
`agent` and `group` nodes scaffold a frontmatter-bearing AGENT.md and register
as subagent_types — `human`, `action`, and `orchestrator` nodes do not.

Before this fix, the scaffolder emitted `SubagentStop` entries for any gate
with an `after:` target, including human checkpoints. Those hooks silently
never fired because no subagent ever ran by that name.

Now the scaffolder:

- Emits a `SubagentStop` hook only when `gate.after` resolves to an agent or
  group node.
- Warns to stderr when a blocking gate targets a non-agent node, explaining
  that the gate wrapper script must be invoked from an orchestrator playbook
  or slash command.
- Still generates the wrapper script for non-agent-targeted gates (with a
  header comment documenting the limitation), so the orchestrator can call it
  directly.
- The gate wrapper script's header now accurately describes whether the gate
  is enforced by a hook (agent target) or must be invoked by the orchestrator
  (non-agent target).

`V25` is rewritten: the rule now fires only for `on-fail: bounce-back` gates
with non-agent (or missing) `after` targets. Gates with agent/group targets
are not flagged because they ARE enforced by the SubagentStop hook on
claude-code (exit 2 prevents the subagent from stopping).

## [0.2.2] — 2026-04-21

### [feat] Observability hook shortcut — SubagentStop in global `hooks {}` block

Global hooks with `on: SubagentStop` now use the declared `run:` path verbatim when it
starts with `.` or `/`, instead of being rewritten into `.claude/skills/<name>/scripts/`.
This enables clean per-agent finish logging without fake gates:

```at
hooks {
  hook log-subagent-finish {
    on: SubagentStop
    matcher: "amitai-cos|nadav-cos|ops-agent"
    run: ".claude/scripts/log-subagent.sh"
    type: command
    timeout: 5000
  }
}
```

The `matcher` and `timeout` are preserved verbatim in the generated `settings.json`.

### [feat] `agentopology info` warns about observability gaps

If a topology has one or more agents but no `SubagentStop`/`Stop` hook (and no
enforced gates, which compile to `SubagentStop`), `agentopology info` now emits a
`[warning]` suggestion with the agent count and a ready-to-paste `hooks {}` snippet.

### [feat] Non-destructive scaffold — `deepMergeSettingsJson`

New `deepMergeSettingsJson` function in the scaffold merge layer handles
`.claude/settings.json` with domain-aware logic:

- `permissions.allow`: union-merged (existing entries survive re-scaffold)
- `permissions.deny`: union-merged (existing entries survive re-scaffold)
- `env`: shallow-merged (generated wins on key conflict, user-only keys preserved)
- `hooks`: rewritten entirely from topology (topology owns hooks)
- All other top-level keys (e.g. `model`, `theme`): existing value wins

Re-scaffold without `--force` calls `deepMergeSettingsJson` for `settings.json`
via the `shared-config` incremental category (already in place). Invalid existing
JSON now throws a descriptive error instead of silently reverting to the existing
file.

### [feat] Agent-scoped env var injection in hook stubs (Change 4)

Generated hook stub scripts now extract `AGENT_TYPE` and `SESSION_ID` from the
Claude Code stdin JSON payload (`agent_type` and `session_id` fields), making the
variables available to the user's implementation:

```bash
PAYLOAD=$(cat)
AGENT_TYPE=$(echo "$PAYLOAD" | jq -r '.agent_type // "unknown"')
SESSION_ID=$(echo "$PAYLOAD" | jq -r '.session_id // ""')
```

### [feat] Hook stub generation for observability scripts (Change 5)

When `scaffold` generates a hook pointing at a path that starts with `.` or `/`
(i.e. an observability-style script, not a skills-directory script), it emits an
executable stub at that exact path. The stub:

- Has a `#!/usr/bin/env bash` shebang
- Contains an auto-generated header (hook name, event, matcher, date)
- Extracts `AGENT_TYPE` from stdin (Change 4 integration)
- Appends a structured JSON line to `.claude/memory/metrics.jsonl`
- Is flagged `executable: true` in the `GeneratedFile` so `executeActions` writes
  it with `chmod 0755`

### [fix] Multi-line suggestions rendered correctly in `agentopology info`

Suggestion messages with embedded newlines (e.g. the observability gap snippet)
are now printed with proper indentation — continuation lines are prefixed with
four spaces.

### Breaking: none

All existing `.at` files validate and scaffold identically. The path-rewriting
change for global hooks only activates when `hook.run` begins with `.` or `/`
(a pattern that was previously broken anyway — it would generate scripts in the
wrong directory).

---

## [0.2.1] — 2026-04

- 10 claude-code binding syntax fixes validated by battle test topology

## [0.2.0] — 2026-04

- OpenClaw importer added
- Gates compile to SubagentStop hooks (not PreToolUse/Task)
