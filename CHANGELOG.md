# Changelog

All notable changes to agentopology are documented here.

## [Unreleased]

### [fix] Fixed: a project with several topology skills imports one orchestrator that handles all their actions (S-13)

- `import` kept the flow of every topology skill in `.claude/skills/*/SKILL.md` but only the first skill's `Handles:` line, so each action another skill's flow uses failed V9 ("used in flow but not in orchestrator.handles"). The one orchestrator now handles the union of every topology skill's `Handles:`, first skill first.

### [fix] Fixed: a hook that runs the user's script inside an authored skill folder stays in settings.json (S-12)

- Found while proving S-11: a hook such as `python3 "$CLAUDE_PROJECT_DIR/.claude/skills/<skill>/references/guard.py"` was removed from the scaffolded `settings.json` when that skill was imported with `file:`. The stub for the user's script (written only if missing) sat in the authored folder, so it was dropped, and the hook naming it was dropped with it. Now only a generated file the hook needs (a gate wrapper) takes its hook with it. A stub the user owns does not, and nothing is written inside their folder.

### [fix] Fixed: a hook that is plain shell scaffolds as written, not as a stub script (S-11)

- Scaffold read the first word of every command hook as a script of the topology: `jq -r ... | ...` became `bash "$CLAUDE_PROJECT_DIR/.claude/skills/<t>/scripts/jq" ...` with a TODO stub named `jq`, so the hook stopped working while `validate` passed. In the 12-repo scan this hit 14 of 32 imported hooks in 6 repos. A `run:` is now emitted as written, with no stub, when its first word is a shell builtin or keyword (`for`, `if`, `case`, `while`, `until`, `cd`, `export`, `source`, `.`, `eval`, `exec`, `command`, and the earlier `exit`, `true`, `echo`, ...), an assignment, or a package runner (`uv`, `npx`, `pnpm`, `yarn`, `bunx`, `pipx`, `poetry`, `bun`, `deno`), or when it holds `|`, `&&`, `||`, `;`, `>`, `<`, `$(` or a backtick outside quotes, on Claude Code and Codex. A bare name keeps its meaning (the topology's `scripts/<name>`); `import` writes a bare PATH tool that is not a file in the project as `command <tool> ...`.

### [fix] Fixed: a hook that opens with a shell assignment validates and scaffolds as written (S-10)

- Found in the same scan: an inline settings.json hook such as `branch=$(git rev-parse ...); if [ ... ]; then ...; fi` failed V96 ("its first word is not a command or path"), and a binding would have stubbed a script named after it. A `run:` whose first word is a variable assignment (`NAME=...`) is now a shell command run as written, like `exit 2`; the unquoted-text checks (non-ASCII, arrows, a bare parenthesis) still apply.

### [fix] Fixed: an imported agent's output-format is never a markdown fence (S-09)

- The importer read `Output format:` from an agent file's body with a pattern that crossed the newline, so a brief that says "Output format:" above a fenced example imported as `output-format: ```` and failed V36. The value must now be on the same line and be one of `text`, `json`, `json-schema`; any other value is dropped, and the import says so in its header (`# Import warning: agent x: "Output format: markdown" is not text, json or json-schema; dropped`). The body is still read, because scaffold writes `Output format: json` there.

### [fix] Fixed: hook commands with quotes and variables survive import exactly (S-01)

- The serializer wrote a `"` inside a value as `\"`, but the parser never decoded it, so `node "$CLAUDE_PROJECT_DIR/a.mjs"` came back as `node \"$CLAUDE_PROJECT_DIR/a.mjs\"`. A quoted value now decodes `\"` and `\\`, and the serializer escapes `\` as well as `"`, so import → serialize → parse gives the same command. `\"` inside a quoted value now reads as `"`, and `\\` as one backslash: an existing .at with `\"` in a description reads more correctly; no .at in this repo holds `\\`.
- V96 read `"$CLAUDE_PROJECT_DIR"/.claude/hooks/x.sh` as "not a command or path", and took the script of `node "$CLAUDE_PROJECT_DIR/x.mjs"` to be `x.mjs"`. A word that starts with the project-dir variable (quoted or not, `$CLAUDE_PROJECT_DIR`, `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_PROJECT_DIR:-.}`) is now read as the project path `./…` by V96 and the bindings. Prose is still refused; other variables (`"$HOME"/x.sh`) are unchanged.

### [fix] Fixed: an imported hook's id is a valid identifier, from its event and matcher (S-02)

- `import --target claude-code` named a settings.json hook after the last path segment of its command, raw: `hook guard.py" --flag {`, `hook uv run --project "$CLAUDE_PROJECT_DIR" tool {`, and `hook null 2>&1 || true {` when the command named no script. The parser then lost the hooks block (V102, V98, V95, V100). The id is now the script's name when the command runs a script file with a clean name, else the event and matcher (`pre-tool-use-edit-write`, `session-start-startup`), lower case, de-duplicated with `-2`, `-3`. In a scan of 12 public repos this took 6 imports from failing to V96 only, and 2 to passing.

## [0.11.1] - 2026-11-13


### [fix] Fixed: the workflow binding's README, seam and lossy report describe only the topology (O-006)

- The `claude-workflow` binding printed one pipeline's wording into every generated `-README.md`, `-SEAM.md` and `-LOSSY-REPORT.md` (named phases and report files that belong to no other topology). They now say only what the topology itself declares. The example hybrid harness is replaced by a new neutral one, `examples/hybrid-release.at`.

### [fix] Fixed: the step and ledger guards fire for PowerShell and Monitor

- Fixed: the step and ledger guards fire for PowerShell and Monitor. On PowerShell setups (Windows without Git Bash, or pwsh enabled), 0.11.0's step and ledger guards did not fire; on Claude Code before 2.1.314 a Bash hook does not fire for Monitor, and guard --check now says so.
- `before-action.sh` is registered on `Bash|Monitor|PowerShell` (was `Bash`), still with `"onFailure": "block"`. A Monitor call with no command (a `ws` input) passes. A PowerShell command is read the same way as a Bash one, with a backslash read as a path separator (`.\tool publish ep1`), and any mention of the tool not read as a declared step (`& ./tool @(...)`, `Start-Process ./tool -ArgumentList "publish","ep1"`, `.\tool.exe`) is refused as doubt. `Get-Content`, `gc`, `Select-String` and `sls` count as reading only, so `Get-Content` of a ledger passes the ledger guard.
- `guard --check` grades a before-action gate `refuse (Bash), unverified (PowerShell: not measured)`: the PowerShell payload is from the Claude Code docs, not measured. Below Claude Code 2.1.314, or with the version unknown, the line adds `Monitor commands not checked on …`. A project scaffolded by 0.11.0 reads `none (PowerShell: not in the matcher; rerun guard --target claude-code)`. The generated SKILL.md Enforcement line of a ledger gate says the same.
- Scaffold output changes for every topology with a before-action guard: `.claude/settings.json` (the matcher), `before-action.sh` (the header and the PowerShell reading) and the skill's `SKILL.md` (the Enforcement line). Rerun `scaffold` or `guard --target claude-code`.

## [0.11.0] - 2026-11-13

### [fix] Fixed: a generated action script finds its gate check from where it sits, not from CLAUDE_PROJECT_DIR (D-10)

- `action-<step>.sh` located the project, and with it the `before-action.sh` it asks, through `CLAUDE_PROJECT_DIR` when set. A caller could point that at another folder. The script now uses only its own location (`.claude/skills/<topology>/scripts/`, four folders below the project). Found in the second design review (rated plausible, read only); a reproduction was not run, so this is hardening, pinned by a test of the property.

### [fix] Fixed: a Codex gate held by cited code grades unverified, not refuse (D-9)

- `guard --check --target codex` gave a gate with an `at:` citation its declared strength, so a cited refusal read `refuse` on Codex, where release 1 grades every guard `unverified` or `none`. It now reads `unverified`, with the citation ("cited, not proven") and the bypass kept in the notes; a broken citation still reads `none`.

### [fix] Fixed: guard --check says on the grade line when a refuse fails open or sits on a stop event (D-8)

- A `PreToolUse` guard entry without `"onFailure": "block"` kept the grade `refuse`, with only a ⚠ note below it, though Claude Code lets the call run when such a hook crashes. Its grade now reads `refuse, fails open on a crash (no onFailure: block)` (the before-action, before-agent, approval and session guards, and a cited hook). A gate held at `SubagentStop` reads `refuse, a stop event: it cannot block a call`, with a note that exit 2 keeps the agent working. The `guard --check` text pins for every example with a SubagentStop gate change.

### [fix] Fixed: before-edit.sh refuses a ledger edit in any letter case (D-7)

- `before-edit.sh` compared an edit's path with the ledger's pattern case-sensitively, so on a case-insensitive disk (macOS) a `Write` to `logs/ep1/TRACE.JSONL` reached the ledger. Path and pattern are now compared lower-cased, on both targets. Every `before-edit.sh` changes.

### [fix] Fixed: the ledger note appears wherever a grade is shown (D-6)

- The F-4 note (`ledger agent-writable until the signed gate`) was on the `guard --check` grade line and in the visualizer's node panel, but the Guards lens table showed a bare `refuse` chip, and the counts (`enforcement: N of M steps refuse`, the visualizer headline, `visualize --print-summary`) counted ledger gates unqualified. The Guards lens row now carries the note under the chip, and each refuse count adds `(K with an agent-writable ledger)` when K > 0.

### [fix] Fixed: a Codex refuse hook that can never fire, or never block, is a validate error (D-5)

- Five hook shapes compiled for Codex with no error and then never refused: a regex over tools Codex lacks (`Web.*`), a list with spaces (`Edit , Write`, kept as written), `if: "Read(secrets/**)"` with no matcher (the filter passes every call), `on: PostToolUse` with `strength: refuse`, and a regex with lookaround. Now a list with spaces is trimmed and rewritten (`apply_patch`); for `strength: refuse`, a regex matching no Codex tool (`CX8-regex`), a plain list or an `if:` naming a tool Codex lacks (`CX8-tool`; the `if:` hook gets no entry) and an event that cannot block (`CX8-event`) are `validate --target codex` ERRORs, warnings on other hooks; lookaround is a `CX8-regex` warning.

### [fix] Fixed: two approval steps before one agent make one ask decision (D-4)

- With two `human` steps before one agent, `before-agent.sh` printed two `ask` JSON objects, which is not one JSON document, so Claude Code could ignore the decision and launch the agent. The script now collects each step's reason and prints a single decision whose reason joins them. Every Claude Code `before-agent.sh` with an approval step changes.

### [fix] Fixed: guard --check credits a cited hook's refuse only when it can block (D-3)

- A gate credited by a hook its edge cites read `refuse` whenever that hook declared `strength: refuse` and sat in `.claude/settings.json`, whatever its event: a `PostToolUse`, `async: true` hook printed `refuse`. Now a cited hook gives `refuse` only as a non-async `command` hook on `PreToolUse`, `UserPromptSubmit` or `PermissionRequest`; on an event that cannot block a call, or async, the gate grades `none` with a note naming why; a `prompt`/`agent`/`http` hook grades `unverified`. `validate` warns (V104) for `strength: refuse` on an event that cannot block, or with `async: true`.

### [fix] Fixed: a unit-from step on a flat ledger needs its own unit (D-2)

- With `record trace { path: "logs/trace.jsonl" }` (no `{unit}`) and a step with `unit-from`, a command the guard saw as the step but read no unit from (`./tool -v publish ep1`) was checked with an empty unit, and the ledger filter then took the last record of any unit. An empty capture was dropped rather than denied. Now, on both targets, a `unit-from` step with no unit read, or an empty one, is refused whatever the ledger path; `agentopology step check` asks for `--unit` for such a step; and `validate` warns (V111) when a `unit-from` step's gate ledger path has no `{unit}`, naming the step, the gate and the path. Every `before-action.sh` with a `unit-from` step changes.

### [fix] Fixed: a gated step's action script checks what it runs, with no usage exemption (D-1)

- The F-6 gate check in `.claude/skills/<t>/scripts/action-<step>.sh` handed `before-action.sh` the step's words plus the script's arguments, then ran the declared commands without them. So `bash action-publish.sh --help` was checked as `./tool publish --help`, the usage exemption passed it, and the script ran `./tool publish` with no ledger. The check now runs with `AT_NO_USAGE=1` (honored by `before-action.sh`: no usage exemption), and the arguments count only as the unit: a step with `unit-from` takes exactly one plain unit name and refuses `--help`, `-h`, `--version`, no argument or two; a step without one leaves its arguments out of the check. The `action-<step>.sh` of every gated step changes.

### [fix] Fixed: at a guard's deadline nothing the check started is left running (F-17)

- A mutation pass on the release candidate found that no test checked the deadline's kill stage, and a new test showed why it mattered: a gate check that ignored TERM was still running after the hook returned, on both paths. GNU `timeout -k` sends its KILL only when its direct child survives, and the watchdog walked the process tree from a launcher that had already exited. The deadline now sends KILL at once (`timeout -s KILL`, which signals the whole process group; the watchdog kills the tree while the run is alive), so the hook returns only when every process the check started is gone. The call was refused in both cases; what changes is the leftover process.
- New behaviour tests also kill three mutants that only the golden hash caught: `--help` inside a step's words (still a step), a second mention of the tool hidden in a command substitution, and a unit of `..`.

### [fix] Known gap, narrowed: the agent can write a gate's ledger (F-4)

- In 0.11.0 a gate's ledger (`records { record trace { path: "logs/{unit}/trace.jsonl" } }`) and the Codex approvals file (`.codex/state/approvals.jsonl`) are files in the workspace, and the agent could write an ok line into them. The guards now refuse commands and edits that name them: `before-action.sh` refuses a `Bash` command that names a ledger unless it only reads it (`cat` and `jq .` still run; `>`, `tee`, `cp`, `sed -i`, `python3 -c` and the like are refused), and a new `before-edit.sh` refuses a `Write`/`Edit`/`MultiEdit`/`NotebookEdit` (Claude Code) or an `apply_patch` (Codex) that touches one. `guard --check` says so on the grade itself: `refuse, ledger agent-writable until the signed gate` on Claude Code, `unverified, ledger agent-writable until the signed gate` on Codex.
- A determined agent can still write them through a path the guard can't see (a variable set elsewhere, another script). The signed gate in the next release closes this.

- The visualizer's Guards lens and node panel show the same note on the grade (`refuse, ledger agent-writable until the signed gate`), as `guard --check` prints it.

### [fix] Fixed: the step guard looks for the tool where bash runs it, so reading a script is no step (P1-d)

- The deny-on-doubt matcher refused 18 of 42 ordinary commands on a real topology while a gate was unmet: `cat`, `ls`, `grep`, `git diff`/`log`/`add`/`commit` on the step's script, and commands whose letters merely held the tool's name (`docs/media-engine/*.py`, `echo $HOME immediately`). The guard now looks for the tool where bash runs a program, or as an interpreter's script; a program that only reads or prints its arguments runs no step unless a flag can make it run one; a program that can run its arguments, or one it does not know, is still scanned; doubt comes from an expansion or glob among the tool's own words, not from letters anywhere in the command. `echo ./tool publish ep1` is no step again ([N42] AG23).
- Measured before release by a differential fuzzer (not shipped in the package): 0 bypasses in 20,000 commands on each target, each allowed command run with real bash against a logging stand-in tool. The fuzzer found the one gap of this change before release (a wrapper between `find -exec` and the tool) and a test pins it.

### [fix] Fixed: a gate's code citation (`at`, `match`, `bypass`) reaches the Codex output and `guard --check` (F-23)

- On Codex, `gate.at`, `gate.match` and `gate.bypass` were dropped with no warning, and `guard --check --target codex` ignored them while the Claude Code check reported them. `AGENTS.md` now names the cited code, the text expected there and the bypass, and the Codex check reads the citation on disk the way the Claude Code one does. The Codex zero-drop test has a gate that sets all three.

### [fix] Fixed: a gated step's generated action script checks the gate itself (F-6)

- Claude Code scaffold writes `.claude/skills/<t>/scripts/action-<step>.sh`, whose body runs the step's commands. Only the `PreToolUse` hook on Bash checked the gate, so `bash .claude/skills/ship/scripts/action-publish.sh ep1` reached `./tool publish` with no ledger at all. The script of a gated step now hands each command, with its arguments, to `before-action.sh` (the same check, reused, not copied) and exits 2 before running anything when a gate is not met. The `action-<step>.sh` of every gated step in the examples and fixtures changes.

### [fix] Fixed: a Claude Code rescaffold replaces a gate's old SubagentStop group (F-13)

- R-8 ownership read a Claude Code command as whitespace tokens equal to a script path, but scaffold writes `bash "$CLAUDE_PROJECT_DIR/.claude/skills/<t>/scripts/x.sh"`, which has no such token. After a gate's `after:` moved, the rescaffold kept the stale group next to the new one, and the gate ran on both agents. A path right after `$CLAUDE_PROJECT_DIR/` is now read too. The new test scaffolds with the CLI, moves `after: writer` to `after: editor`, rescaffolds, and finds exactly one group for the gate, with the user's own group untouched; the old test fed a form the generator never writes.

### [fix] Fixed: three mutants of the Codex guards no longer survive the suite (F-17)

- Deleting the watchdog's KILL stage, the `if:` filter no longer reading `*** Delete File:`, and the GNU `timeout` path returning a check's raw exit code instead of 2 each left every test green. New tests fail under each: a TERM-ignoring check must free the hook's pipe within deadline + 3 s on the POSIX path; a patch that updates one file and deletes `.env` must be refused; a check that exits 3 must come out as exit 2. Each was proven by applying the mutation in a copy of the tree and seeing that test fail.

### [fix] Fixed: a Codex refuse hook blocks when its script is missing, the cwd is a nested repo, or it runs too long (F-8, F-16, F-26)

- A `strength: refuse` hook that was not one of the built-in guards, with or without `if:`, ran its script by `$(git rev-parse --show-toplevel)/…`: from a nested repository, or with the script deleted, it exited 127 and Codex let the call run. It also had no hook timeout and no deadline, and a timed-out hook lets the call run too. Every refuse `PreToolUse` hook now goes through the guard launcher: it climbs to its script, a missing script or any launcher failure is exit 2, and it carries a hook timeout (its own, else 120 s) with the R-3 deadline under it. The `if:` filter is launched the same way and runs the hook's script from the root it found.
- Hooks that are not refuse had the same 127 from a nested repository. They now climb to their script the same way, and a missing script exits 1, which does not block.

### [fix] Fixed: the Codex guard deadline frees the hook's output pipe on time (F-9, F-20b)

- The deadline returned exit 2 on time, but a check that ignored SIGTERM, or left a background process, kept the hook's stdout and stderr open 9 to 15 s past it; Codex reads to EOF and could reach its own hook timeout, which lets the call run. Both the GNU `timeout` path and the POSIX watchdog now send the run's output to temp files and copy them out after the run ends or is cut. When the deadline fires, the watchdog's KILL stage runs to its end, and the watchdog's own `sleep` is killed with it, so it never outlives the hook. In the GNU path a KILL after `-k` (137) also reports the deadline, and any non-zero exit is exit 2. An absolute script path is run where it is, with no climb.

### [fix] Fixed: a Codex refuse hook whose matcher is a regex of Claude tool names no longer goes silent (F-7)

- A matcher such as `(Write|Edit)`, `^Write$`, `Ed.*` or `Task.*` was written to `.codex/hooks.json` unchanged with no warning, so it never fired on Codex, which calls those tools `apply_patch` and `collaborationspawn_agent`. Names inside one group or between `^` and `$` are now rewritten (`(apply_patch)`, `^apply_patch$`). A real regex that matches a Claude tool but not its Codex name gets `CX8-regex` from `validate --target codex`: an ERROR for `strength: refuse`, a warning for any other strength.

### [fix] Fixed: a Claude Code `strength: refuse` hook blocks when it cannot run (F-14)

- Only the generated guards carried `"onFailure": "block"`. A user's `PreToolUse` hook with `strength: refuse`, in `hooks {}` or on an agent, had none, so a script that could not start or timed out let the call run. Every such hook now gets it; no existing `onFailure` is removed. `validate` warns with `CC-onfailure` when the installed Claude Code is older than 2.1.295, which ignores the field.
- Claude Code `before-agent.sh` compared `subagent_type` as sent, so ` Reviewer `, `REVIEWER` or `agents/reviewer:` launched a gated agent. It now normalizes the name as Codex does (F-15). The Claude Code `before-agent.sh` of `codex-gates.at` and `compile.at` changes.

### [fix] Fixed: Codex `before-agent.sh` holds an agent however its name is spelled (F-15)

- The spawn guard compared `agent_type` after trimming and lowercasing only, so `re\u200bviewer`, `\ufeffreviewer`, `./reviewer`, `agents/reviewer` and `reviewer:` started a gated agent. It now drops format characters (`\p{Cf}`), a leading path, trailing punctuation and a `plugin:` prefix too. A missing or `null` `agent_type` is still let through: it is Codex's default agent, and the docs now say so.

### [fix] Fixed: the Codex `if:` filter sees `.env` however an `apply_patch` spells its path (F-12)

- `at-if.sh` compared a patch's paths as written, so `$ROOT/./.env`, `$ROOT//.env`, `sub/../.env`, `./.env` and `/proc/self/cwd/.env` passed a `strength: refuse` hook with `if: "Write(.env*)"`. Each path is now made canonical by its letters (relative paths from the current folder, `/proc/self/cwd` as the project root, `.`, `..` and `//` resolved, the root stripped; glob characters in a path are not expanded). A pattern with no slash, such as `.env*`, now also matches the file's name at any depth.

### [fix] Fixed: a stub runs under the interpreter its hook or gate command uses (F-24, F-25)

- A hook with `run: "sh scripts/x.sh"` got a bash stub (`set -euo pipefail`), and the hook command ran it with `sh`. Dash rejects `-o pipefail` and exits 2, so on both targets a fresh scaffold blocked every matching call by accident. A stub now has a POSIX sh body when `sh` runs it, and a hook stub that is not `strength: refuse` exits 1 as designed.
- A gate whose `run:` names a `.py` file got a bash stub (a Python `SyntaxError`, exit 1), and a `.js` / `.mjs` one was run with bash. Gate and hook stubs are now written in the file's language (Python for `.py`, JavaScript for `.js` / `.mjs` / `.cjs`) and run by the matching interpreter. On Claude Code a non-project `.py` script is now run by python3, not bash. The Claude Code stub for `compile.at`'s `docs/tools/check.py` changes.

### [fix] Fixed: a Codex gate's check stub is written where the gate runs it (F-22)

- A gate with `run: "checks/review.sh"` got its stub at `.codex/scripts/review.sh`, while `gate-<id>.sh` runs `checks/review.sh`. Filling in the stub never let the gate pass. The stub is now written at the declared project path (created once, never overwritten), as on Claude Code; a bare name still goes to `.codex/scripts/`, and an absolute path is never stubbed.

### [fix] Fixed: Codex `AGENTS.md` says what holds a gate in the words `guard --check` grades it (F-29)

- A gate before a script step with a `run:` script and no ledger read "refuses the step's command until the ledger shows the gate held", though it has no ledger. The line now names what `before-action.sh` checks: the ledger of the `after:` step, the gate script, or both.
- A gate no Codex event marks read "script-level" in `AGENTS.md` and `hope` in `guard --check`. It now reads `hope` in both, with the script to run by hand.

### [fix] Fixed: Codex `AGENTS.md` no longer hands the model a command that approves a human step (F-10)

- `AGENTS.md`, which Codex loads into the model's context, held a ready-to-run `printf ... >> .codex/state/approvals.jsonl` line under Human Checkpoints, so the model had its own approval one paste away. It now describes the record for the person in words (the file, the fields `step`, `ok`, `at` and what they mean) and holds no line that writes it. The R-11 test checks that neither `AGENTS.md` nor any guard's stderr has a `printf`, `echo`, `tee` or `>>` line naming `approvals.jsonl`.

### [fix] Fixed: inventory on a Codex-only scaffold counts nothing scaffold wrote as unmapped (F-28)

- `validate --inventory` on a project scaffolded only with `--target codex` listed `.codex/.scaffold-manifest.json` as unmapped and every Claude Code file as "not scaffolded". The scaffold manifest (either target, shared or per topology) is now mapped, and a project with a Codex tree and no `.claude/` is not told to scaffold the Claude Code files.

### [fix] Fixed: `validate --target codex` names the Codex version, not Claude Code's (F-20, F-27)

- `agentopology validate <file> --target codex`, with or without `--inventory`, ended with `checked against Claude Code 2.1.323`. It now prints the target's own line (`checked against Codex CLI 0.156.1 ...`); with no `--target` it still prints the Claude Code line, and a target with no conformance facts prints none.
### [fix] Fixed: a Codex `if: "Bash(...)"` filter reads the command the way the step guard does (F-11)

- `if: "Bash(git push*)"` on a refuse hook matched the whole command against the glob only, so ` git push`, `cd . && git push`, `git  push`, `git -C . push`, `command git push`, `true; git push`, `GIT_TRACE=1 git push` and `/usr/bin/git push` all ran. The filter now shares the step guard's reading: the glob's literal words (`git`, then `push`) are found in any segment, behind a prefix, at any path, in any case, with flags between them; the whole-command glob test still holds; and a refuse hook treats a mention of the tool it cannot read (an expansion or glob) as a match.

### [fix] Fixed: the step guard refuses what it cannot read, and reads interpreter steps by their script (F-1, F-2, F-3, F-5, F-19, F-21)

- An adversarial review of the 0.11.0 candidate ran guarded steps past `before-action.sh` (both targets) in ordinary shell forms: a backslash line continuation, a redirect glued to or between the words (`./tool publish>/dev/null ep1`, `./tool 2>&1 publish ep1`), an expansion or glob inside the words (`${IFS}`, `$'...'`, `{publish,}`, `pub*lish`, `./to?l`), upper case (`./TOOL`, a bypass on a case-insensitive disk), and a second step in the same command riding the first step's ok record. A step run through an interpreter (`python3 harness/bin/post.py`) passed as `python3 ./harness/bin/post.py`, by an absolute path, or as `python post.py`.
- The guard now joins line continuations, drops redirections before it cuts the command, matches the tool in any case and at any path (for an interpreter step, the script under any interpreter), and lets flags sit between the step's words. What it cannot read it refuses: a command that holds an expansion or glob and names the tool more often than the step can be read plainly, or a glob or brace word that could expand to the tool, is refused for a step with a unit. Every unit a command names needs its own ok record. `<step> --help` alone is no step.
- This over-blocks more than before while a gate is unmet: a command that mixes the tool with `$`, a glob or `~` is refused, as is a mention of the tool's name in a command with an expansion. The shipped Claude Code `before-action.sh` changes.

### [feature] `validate --target <binding>` (E-6)

- The Codex warnings (`CX5-*`, `CX8-*`, `CX9-*`, `CX11-*`, `CX13`, `CX20`, `CX23`) appeared only at scaffold, though the CX-23 entry says `validate` with a Codex target shows them. `agentopology validate <file> --target codex` now adds them; plain `validate` stays target-neutral.

### [fix] Fixed: the Codex scaffold drops no gate description, gate behavior or tool script path (E-4)

- The `AGENTS.md` gate section never printed a gate's `description` or `behavior`, and a tool's stub was written to `.codex/scripts/<id>.<ext>` instead of its declared `script:` path. Both gate fields are now printed, and the tool stub is written where `script:` says, as on Claude Code: a project path is created once and never overwritten, an absolute path is never touched. The Codex zero-drop test now also checks tool scripts, with a fixture that sets all three.

### [fix] Fixed: a guarded step's command with placeholders matches the real call (E-3)

- `before-action.sh` (both targets) compared a step's command literally, so `commands: ["./media episode render EP.json OUT.mp4"]` never matched the real call `./media episode render show/ep7/ep.json out.mp4`, and the gate never held. Now the command is matched on its words before the first placeholder: an ALL-CAPS word (`EP`, `PID`, `OUT.mp4`) or a word holding `< > { } [ ]`, and everything after it. `validate` warns with `AG-placeholder` and names the words matched. The Claude Code `before-action.sh` of such a topology changes too.

### [fix] Fixed: every generated stub fails closed; 0.10.1 and earlier (0.9.x included) graded an unwritten tool stub "refuse" while its gate passed (E-1)

- In 0.10.1 and earlier (0.9.x included: the Claude Code binding predates 0.10), a tool's script stub (and the hook, metering and workflow-seam stubs) printed a TODO line and exited 0. A gate whose check was such an unwritten stub therefore passed, and `before-action.sh` let the step run, while `guard --check` graded the gate `refuse` and said the stub "blocks every run". In 0.11.0 every generated stub, on both targets and in every language (bash, python, node), carries the `AGENTOPOLOGY_STUB` marker and fails closed: a check that must refuse exits 2, every other stub exits 1 (an error that does not block a stop event), so a gate that runs it blocks. Codex tool stubs now carry the marker too. This changes the Claude Code stub scripts; `guards-golden.json` is re-blessed in its own commit.

### [fix] Fixed: Codex guards are graded unverified, and a gate with no blocking event reads none (R-1)

- `AGENTS.md` called every Codex gate "Enforcement: hook". No live Codex run has proven a guard holds yet, and Codex skips an untrusted project's hooks silently, so every Codex guard on disk now reads `unverified` in `AGENTS.md`, in the gate wrapper's comment and in `guard --check`, never `hook` or `refuse`. A gate whose only event is `SubagentStop` (after the last agent, with nothing after it to hold) reads `none`, and `validate` / `scaffold` warn with `CX9-noblock`.

### [fix] Fixed: `guard --check --target codex` wrote files (E-2)

- With `--target`, `guard` took the write path before it looked at `--check`, so `guard <file> --check --target codex` wrote the guards into the project. `--check` now never writes, on any target.

### [feature] `guard --check` grades a Codex project (E-5)

- On a Codex scaffold `guard --check` graded `.claude/` only: it printed "0 of 4 refuse", listed missing `.claude` entries and exited 1. `guard --check --target codex`, or a project with `.codex/` and no `.claude/`, now reads `.codex/hooks.json` and `.codex/scripts/<topology>/`: a guard on disk reads `unverified`, a missing one `none` (exit 1), a gate with no blocking event `none` without failing, and the version line names Codex CLI. It exits 0 when nothing is missing.

### [fix] The Codex human gate does not hand the model its own approval (R-11)

- When an approval step blocked a spawn, `before-agent.sh` printed the exact `printf … >> .codex/state/approvals.jsonl` command to stderr, which Codex shows the model. With `permissions: unrestricted` (so `sandbox_mode = "danger-full-access"`), or no sandbox and `approval_policy = "never"`, the model could run it and approve itself. Now stderr says a person must add the record and the model must not; the record format and the command are in `AGENTS.md` under Human Checkpoints. `validate --target codex` (and scaffold) warns with `CX11-forgeable` when a human step stands before an agent and the sandbox lets the model write `.codex/`.

### [fix] Fixed: the guard matcher refuses a gated step however the command is spaced, wrapped or quoted, and the shipped Claude Code hook scripts change (R-4)

- `before-action.sh` (shared by Claude Code and Codex) let these run a gated step with exit 0 when the gate's ledger had no ok record: double spaces or a tab between words, `if …; then` / `while …; do` / `! …`, `$(…)` and backticks, a `command` / `nice -n 5` / `sudo -u x` / `env -i` / `xargs` prefix, quotes (`"./tool" publish`, `./tool 'publish'`), and the tool named by an absolute path. The matcher now refuses every one of those forms (exit 2). It also cuts the command at `(`, `)`, `$(` and backticks, drops quotes and backslashes, makes whitespace single spaces, and finds the step's words anywhere in a segment, its program also by any path ending in its name; `bash -c '…'` and `eval …` with the step written out are refused too. It over-blocks on purpose: `echo ./tool publish ep1` is now refused while the gate is unmet (it used to pass). A step named through a variable, an alias, a function or another script is still not seen.
- **The shipped Claude Code hook scripts change:** every generated `.claude/skills/<t>/scripts/before-action.sh` is different. The fix wins over byte-identical output (decision 2026-11-13), because the old matcher let a gated step run; `guards-golden.json` is re-blessed in its own commit.

### [fix] The Codex if: filter runs its command as argv (R-7)

- `at-if.sh` ran the hook's command with `sh -c "$*"`, which joins the words again: in a project whose path holds a space ("fx 3") the script path split, the run exited 127, and Codex let the call run. The filter now runs the command as given (`"$@"`); an inline shell command such as `exit 2` is passed as one `sh -c` word. On a `strength: refuse` hook, a command that cannot be found or run (126, 127) blocks with exit 2, and the filter itself is found the way the guards are (R-2).

### [fix] The Codex if: filter reads the paths of an apply_patch (R-6)

- On `apply_patch`, `.codex/scripts/at-if.sh` read `.tool_input.file_path` / `.path`. Codex sends the patch text in `.tool_input.command`, with absolute paths, so `if: "Write(.env*)"` never fired; input that was not JSON also passed (exit 0). Now every `*** Add File:`, `*** Update File:`, `*** Delete File:` and `*** Move to:` path in the patch is made relative to the project root and matched. On a `strength: refuse` hook, input that is empty, not JSON, or a patch with no readable path blocks (exit 2).

### [fix] Claude tool names in a Codex hook matcher are rewritten (R-5)

- A hook with `matcher: "Edit|Write"` or `"Task"` was written to `.codex/hooks.json` as is. Codex calls those tools `apply_patch` and `collaborationspawn_agent`, so the hook, a `strength: refuse` one included, never fired, with no warning. Now `Edit`, `Write` and `MultiEdit` become `apply_patch`, `Task` and `Agent` become `collaborationspawn_agent`, and `Bash` stays. A Claude tool Codex has no hook-visible tool for (`Read`, `Grep`, `WebFetch` and others) gets a `CX8-tool` warning; a matcher left with no name gets no entry.

### [fix] A slow gate check cannot outlast the Codex hook timeout (R-3)

- Every guard was registered with a 120 second hook timeout and the gate wrapper had no deadline of its own. A check longer than that, or a gate with `timeout: 10m retry: 2`, was cut off by Codex, and Codex lets a timed-out call run. Now a guard's hook timeout is never below its gates' worst case (timeout x attempts, plus the pauses, plus a margin), and the hook command cuts the run 10 seconds before that timeout and exits 2 ("ran past its deadline"). `validate --target codex` warns (`CX9-timeout`) when a gate's worst case raises the hook timeout.
- Where neither GNU `timeout` nor `gtimeout` is installed (stock macOS), the deadline is kept by a shell watchdog: it stops the check and everything the check started, and the guard exits 2.

### [fix] Codex before-agent.sh reads agent_type trimmed and lowercased (R-12)

- `before-agent.sh` on Codex compared `agent_type` exactly, so `" Reviewer "` missed the `reviewer` case and the spawn went through. It is now trimmed and lowercased the way the spawn guard reads it.

### [fix] A gate between two agents holds the second agent on Codex (R-1)

- A gate `after: writer, before: reviewer` compiled only to a `SubagentStop` hook on `writer`. Codex cannot block a `SubagentStop`, so `reviewer` was spawned whether the gate passed or failed, while `AGENTS.md` said "Enforcement: hook". Now `before-agent.sh`, a `PreToolUse` hook on `collaborationspawn_agent`, refuses to spawn `reviewer` (exit 2) until the gate script passes. The `SubagentStop` hook still runs and only reports. A gate after the last agent, with no agent after it, is now described as reported only. The Codex gate wrapper also changes to the project root first, so its check is found from the session's folder.

### [fix] A Codex rescaffold removes the topology's stale hook groups (R-8)

- When `.codex/hooks.json` was merged, a group counted as the topology's only when a whitespace-separated word of its command equalled a generated script path. A Codex command names the script after a root expression (`"$(git rev-parse …)/.codex/scripts/<t>/x.sh"`), so no group was ever recognized: moving a gate's anchor left both `SubagentStop` groups, and a removed gate kept firing. Now any `.codex/scripts/…` path in the command counts, the stale group is replaced, and the user's own groups stay. Claude Code ownership is unchanged.

### [fix] A Codex guard blocks when its script is not found (R-2)

- A guard's hook command was `bash "$(git rev-parse --show-toplevel || pwd)/.codex/scripts/<t>/<guard>.sh"`. From a nested git repository, or from a subfolder of a project outside git, that path does not exist, bash exits 127, and Codex lets the call run. The command now starts at the repository root (else the current folder) and climbs until it finds the script; if it is nowhere above, it prints the reason and exits 2, and any other non-zero exit of the run becomes 2.

### [fix] `guard --target codex` writes the gate's check script and names Codex (R-9)

- `guard --target codex` did not write the check script a gate runs (such as `.codex/scripts/render-check.sh`): the gate wrapper names it by a bare root-relative path, which the discovery did not read, so in a fresh project the gate always failed with "exit code 127". It also printed "checked against Claude Code". Now the check is written as a failing stub when it is missing (an existing one is never overwritten) and the output carries the Codex CLI version line.

### [fix] A verified-list entry counts only with a clean suite (R-10)

- `spec/claude-code/verified.json` entries were checked for shape only, so an entry whose suite had `failed: 12`, or had no suite at all, made that Claude Code version read "verified". Now an entry counts only when its proof carries a suite with `failed: 0`; any other entry is reported as a problem and the version reads unverified.

### [fix] The Codex surface map knows where the guards live (RW-2, CX-9)

- Guard scripts are written to `.codex/scripts/<topology>/`. The surface map now reads that folder as a name (`.codex/scripts/*/*.sh`) and holds one entry for it, graded `check`: a guard that is not where `hooks.json` points exits 127, and Codex lets the call through.

### [feature] Gates on Codex (CX-9)

- On `--target codex`, gates are now enforced by hook scripts instead of a note to run them by hand. `before-action.sh` refuses a script step's command until the gate's ledger shows the step finished ok, also inside an `&&` chain. `before-agent.sh` runs the gates that stand before an agent when Codex spawns it, and `gate-<id>.sh` runs when the agent it follows stops. All are registered in `.codex/hooks.json` with a 120 second timeout.
- Codex lets a command through when a hook exits 1, exits 127 or times out; only exit 2 blocks. Every generated guard turns its own failure into exit 2 with a reason: a missing `jq`, input that is not JSON, an unreadable ledger, a gate script that cannot start. A gate script nobody has written yet fails instead of passing.
- A project hook is skipped until it is trusted, with no warning, so every Codex guard is unverified. `AGENTS.md` now names the `/hooks` step. agentopology never writes a trust entry.

### [feature] The human gate on Codex, without "ask" (CX-11)

- Codex cannot ask from a `PreToolUse` hook, so an approval step before an agent now blocks the spawn with exit 2 until `.codex/state/approvals.jsonl` ends with an approval record for that step. The message gives the person the command that writes it. No generated script prints `ask`.

### [feature] `guard --target codex` (CX-17)

- `agentopology guard <file.at> --target codex` writes only the guard scripts and their `.codex/hooks.json` entries into a project built by hand. The user's own hook entries and files stay, `AGENTS.md` is not touched, and a second run changes nothing. `hooks.json` now merges on a scaffold too, instead of being reported as a conflict.

### [feature] Conformance tests for Codex, tiers A to D (CX-15)

- A new test file checks every example and fixture against the Codex contract with no model call: the config and agent files against a key list, `hooks.json` against the hook contract (now including timeouts and anchored script paths), every generated command hook run from a subfolder, and, where `codex` is installed, `codex execpolicy`, `codex sandbox` and `--strict-config`.

### [fix] Codex inventory test used Claude model names (CX-18)

- The Codex inventory test scaffolded fixtures that name Claude models, which the Codex scaffold refuses; it now uses a Codex model name.

### [feature] Surface map for Claude Code (RW-1)

- `spec/surface/claude-code.surface.json` lists everything the Claude Code binding writes or relies on: hook events, handler fields, payload fields, frontmatter keys, settings keys, permission modes, written paths and CLI flags. Each entry names its contract page, where the binding uses it, the test that proves it, and what breaks if it changes. A test scaffolds `kitchen-sink.at` and the session-agents fixture and fails on any generated item that has no entry, so the map cannot fall behind the binding.

### [feature] Surface map for Codex, with a schema snapshot (RW-2)

- `spec/surface/codex.surface.json` does the same for the Codex binding, and `spec/codex/config.schema.json` is a copy of Codex's `config.toml` schema at tag `rust-v0.168.0`. A check compares every key and value in a generated `config.toml` with the schema. A known mismatch is excused only by a `knownDrift` entry that carries a ticket id; any other mismatch fails.

### [feature] The tick: new versions from the npm registry (RW-3)

- `scripts/release-watch/tick.mjs` reads the registry entry for Claude Code or Codex and lists every stable version published since the last one seen, by walking the registry's publish times. Skipped version numbers do not matter, and for Codex, prerelease and per-platform builds are dropped. It exits 0 when nothing is new, 10 when there are new versions, and 2 when the registry answer cannot be read.

### [feature] The red-green gate (RW-11)

- `scripts/release-watch/red-green.mjs` checks that a planted test fails at its own commit and passes at HEAD, working in a clone. It exits 1 and says "never red" when the test already passes at its own commit.

### [feature] The verified Claude Code versions become a list with proofs (RW-7)

- `spec/claude-code/verified.json` lists the Claude Code versions the output was checked on, each with a proof (run id, date, suite counts). `validate` and `guard --check` no longer mark an installed version as unverified when it is on the list. An entry with no proof does not count. With no readable list, the single `VERIFIED_ON` version behaves as before.

### [feature] Permission rules for Codex (CX-13)

- `settings { allow / ask / deny }` entries of the form `Bash(command *)` now scaffold `.codex/rules/<topology>.rules` as `prefix_rule(...)` calls: deny is `forbidden`, ask is `prompt`, allow is `allow`. Each rule carries a `match` example (for `git push`, `git push origin main`) that Codex checks when it loads the file; where the `codex` binary is installed the test runs `codex execpolicy check` against it. When one command is in two lists, the strictest decision is written.
- An entry a command-prefix rule cannot hold (a tool name such as `WebFetch`, a wildcard inside the command) is reported with a warning instead of dropped.
- When agents differ in `permissions`, the one warning now names the agents that set the strictest policy. A new "The `codex` binding" section in `docs/bindings.md` describes what is written and what is not.

### [feature] Hooks compile to .codex/hooks.json (CX-8)

- On `--target codex`, the topology's `hooks {}` block is now registered in `.codex/hooks.json` in the shape Codex reads. Before, the scaffold wrote no hook file at all. A hook with `run: "exit 2"` is written as that command; it no longer becomes a stub file named `exit` that exits 0.
- Every hook command finds the repository root at run time, so it works from a subfolder. Scripts are written executable, and a stub for a `strength: refuse` hook exits 2 until it is written. Two scripts with the same file name no longer collide.
- A hook's `if: "Tool(pattern)"` is kept through a small `at-if.sh` filter, so a hook meant for `rm -rf *` does not block every shell call. Without `jq` the filter blocks.
- Hooks Codex cannot run get a warning and no entry: an event Codex lacks (for example `Error` or `Notification`), a `prompt`, `agent`, `http` or `mod` handler, an `if:` that is not `Tool(pattern)`, or run text that is prose. A matcher on an event that ignores it warns. Per-agent hooks are listed as not expressible, since Codex hooks are project-wide. Codex skips a new hook until it is trusted with `/hooks`, and scaffold says so.

### [feature] Scheduled jobs that run Codex (CX-20)

- On `--target codex`, a schedule job with `carrier: cron` (or none) that runs an agent now scaffolds an executable `scripts/schedule-<id>.sh` and a `crontab.fragment` line. The script runs `codex -a never exec --sandbox <mode>` with an explicit sandbox: the agent's, the project's, or `read-only`.
- A job whose agent writes files while no sandbox is named gets a warning that `codex exec` is read-only by default, so the job cannot write. A job with another carrier (cloud, launchd, calendar, session) or one that runs an action gets a warning and no script. `carrier: session` with `survives:` is still an error (V125).

### [feature] Codex says what it cannot express (CX-23)

- `validate` with a Codex target (and `scaffold --target codex`) now gives one warning for each field Codex has no key for: sampling settings (temperature, max tokens, top-p, top-k, stop, seed), a thinking token budget, output format, max turns, log level, fallback chain, rate limit, circuit breaker, background and isolation on an agent, the same sampling settings under `defaults`, and `providers`. Each warning names the field, why, and which agents set it.
- Temperature and max tokens are no longer left as commented-out lines in `config.toml`.
- A zero-drop test holds every field set in `kitchen-sink.at` to "found in the Codex output" or "on the not-expressible list".

### [feature] Full MCP tables for Codex (CX-14)

- A Codex `[mcp_servers.<id>]` table now carries every field of the server: `env` as its own table, `args` and tool lists as arrays, `startup_timeout_sec` as a number, and `bearer_token_env_var` for a URL server. The Claude Code `type` key is left out.
- A new `matcherProblem` for Codex hooks flags the dotted `mcp.server.tool` matcher (a Codex hook sees `mcp__server__tool`) and a matcher on an event that ignores it.

### [feature] Honest Codex agent files and model names (CX-5)

- `scaffold --target codex` now refuses a Claude model name (`opus`, `sonnet`, `haiku`, `fable` or any `claude-*`) on an agent or the orchestrator. It prints which agent uses which name, exits 1 and writes nothing. It does not pick a Codex model for you; set one such as `gpt-5.2`.
- A Codex agent file no longer holds `sandbox_mode`, `mcp_servers` or `nickname_candidates`: Codex ignores the first two in an agent file and does not document the third. An agent that sets `sandbox` or `mcp-servers` gets a warning naming it, and `validate` with a Codex target gives the same warnings. MCP servers are written once in `config.toml`.
- A prompt with `"""`, backslashes or quotes now survives in the agent file: it is written as a literal TOML string, or escaped when it holds `'''` or a control character, and `sync` reads it back either way.

### [fix] A Codex config.toml that Codex 0.156.1 accepts (CX-4)

- `approval_policy` is now `on-request` or `never`. The words `supervised`, `plan`, `confirm`, `interactive` and `suggest` used to become `untrusted`, which Codex no longer takes. With agents that differ in `permissions`, the strictest policy applies to the project and scaffold warns.
- Providers are no longer written as `[[providers]]` tables: Codex has no such key, and a project config may not set `model_providers`. Scaffold warns that they are dropped. The keys `disable_response_storage`, `history.max_conversations` and `max_depth` are no longer written either, and `[agents]` uses `max_concurrent_threads_per_session`.
- Extension keys now sit at the top of the file instead of inside the last MCP table, MCP `env` maps are written as `[mcp_servers.<id>.env]`, and the Claude Code `type` key is no longer copied into MCP tables.

### [feature] The version line and installed mark per target (CX-1)

- `targets` and `scaffold --target codex` now print the Codex line ("checked against Codex CLI ...") and, when the installed `codex` is not the checked version, a mark such as "installed 0.999.0: unverified". The Claude Code output is unchanged.
- The line and the mark come from one per-target seam, `src/conformance/index.ts`, so a new target adds one entry instead of another branch in the CLI.

### [feature] Inventory and coverage for a Codex project (CX-18)

- `inventory` and `validate --inventory` now read a Codex project: the agent files under `.codex/agents`, the skills under `.agents/skills`, each entry in `.codex/hooks.json`, the files under `.codex/rules`, and the MCP servers in `.codex/config.toml`. Before, only the `.claude` tree was walked, so a Codex project counted 0.
- Coverage maps them to the `.at` the same way as Claude Code files. A hook added by hand shows as unmapped.

### [feature] Flow lens: what sits on the flow is drawn where it sits (VZ-5)

- A gate is a chip on the edge it guards, with its grade (shape and word) beside it. Human steps sit in one "seats" lane, stores sit on a rail with a read tick and a write tick per agent, and jobs and triggers carry flags on the step they start.
- Loop, wait and error edges differ by dash pattern and by a word ("loop max 3", "wait 30s", "error"), not only by color. Agents that share a phase open collapsed into one stage block; a click opens it.
- Every label in the page is at least 11 px. `kitchen-sink.at` opens with 13 blocks and no overlapping boxes.

### [feature] Sessions lens (VZ-6)

- Places are titled boxes holding their session agents, with subagents nested under the session that spawns them. Each talk edge carries its message kind as a chip, `talk: hub` draws the hub, `decides:` shows a badge, and a session with no talk guard on disk is hatched "unguarded". The send and spawn guard grades come from the embedded facts.

### [feature] Seats lens (VZ-8)

- One row per human step and per declared decision: where it sits, what it releases, its timeout and on-timeout, and its grade from `guard --check`.

### [feature] Coverage lens (VZ-9)

- Mapped, unmapped and missing by kind, read from `validate --inventory` (including `inventory { roots }`, the `--user` tree and `needs`). A click on a number lists the items. With no project folder the lens reads "not checked". The embedded inventory facts now carry the per-kind lists, the roots, the user tree and the outside needs.

### [feature] Index lens with the source embedded (VZ-10)

- Every node, edge, store, command, hook, job, skill, tool and decision is a row with its line in the `.at`. The `.at` text is embedded in the page (escaped like the rest of the data) with an anchor per line, and a click on a row, or `#lens=index&line=12`, jumps to it.

### [fix] A visualizer test no longer depends on the installed Claude Code version (VZ-7)

- The check that the page counts `unverified` guards ran under the verified version, where nothing reads unverified. It now loads the facts under a version that is not the verified one.

### [feature] Verified on Claude Code 2.1.323 (VO-323)

- The version the output is checked against is now 2.1.323. A live check on that version, recorded on 2026-11-13, found that PreToolUse fires on the SendMessage tool and exit code 2 blocks the call, that `claude --agent X` resolves `.claude/agents/X/AGENT.md`, and that the SendMessage tool input carries the target as both `to` and `recipient`.
- `guard --check` now grades the talk guard and the spawn guard `refuse` when the installed Claude Code is 2.1.323, and still `unverified` on any other version or when none is installed.
- The hook contract snapshot was regenerated from the live docs page: no contract change, only the version and fetch date moved. The text-output snapshots changed only in the version line (36 lines).

### [fix] The package no longer depends on itself (N47)

- `package.json` listed `agentopology ^0.2.0` under `dependencies`, so every install pulled an old copy as a nested package. The entry and its lockfile record are removed, and a test fails if the package ever lists its own name again.

### [feature] Inventory covers folders a run reads, other .at files, and the user's home (T-08)

- A top-level `inventory { roots: ["harness/", "scripts/"] }` block lists extra project folders. `inventory --at <file.at>` and `validate --inventory` list every file under them (kind `file`) and report a root that does not exist as missing. An absolute path, a home path or `..` in a root is a validate error (V128).
- `inventory --user` and `validate --inventory ... --user` add `~/.claude/agents`, `skills`, `commands` and the hooks in `~/.claude/settings.json`, tagged user-level and counted apart from the project.
- `validate --inventory DIR a.at b.at` prints the per-file numbers, then one union number in which a live thing is mapped when any file maps it. With one file the output is unchanged.

### [feature] Declare what lives outside the repo (L-4)

- A top-level `needs { memory: "~/path"  connectors: [name]  user-skills: [name] }` block parses, round-trips and is listed by `validate` under "declared outside the repo". A bad memory path or a path used as a name is a validate error (V129).
- With `validate --inventory ... --user`, a declared user skill (`~/.claude/skills/<name>`) and a declared memory path count as mapped when they exist and as missing (exit 1) when they do not. Connectors cannot be checked locally and print `not checked (account connector)`.
- README and spec now say 129 rules (V1-V129).

### [feature] The visualizer is one offline page with themes, lenses and deep links (VZ-4)

- The generated page holds no web address at all: dagre and every script are inline, fonts are the system stack, and there is no `<link>` or `@import`. A test reads the page text and fails on any `http://` or `https://` outside comments.
- Light and dark themes come from CSS variables, follow `prefers-color-scheme`, and a Theme button sets `data-theme` (remembered in the browser when storage allows).
- A lens bar (Flow, Sessions, Guards, Seats, Coverage, Index): Flow and Guards work, the others show a "coming" panel. A headline strip shows seven facts: agents, session agents, gates, guards graded refuse / hope / none, coverage, validate results and the Claude Code version stamp. Facts that were not read say "not checked".
- The legend is built from the projection rules table (one row per node kind, plus the guard grades), not written by hand.
- `#node=<id>` opens that node's inspector and `#lens=guards` opens a lens (they combine with `&`). Search matches ids and labels.

### [feature] A Guards lens that grades every guard without relying on color (VZ-7)

- Each gate, approval step, permission rule, talk guard and spawn guard gets a chip from the embedded `guard --check` facts. Shape, word and color go together: refuse is a solid square, hope a hollow circle, none a dashed outline, and unverified is the refuse shape with a "?".
- A ledger lists every graded item worst first (none, hope, detect, unverified, refuse) and lists hooks that no step ties to under "untied".
- Clicking a headline number such as "hope 3" shows only those items.
- With no project folder every chip reads "not checked". The counts in the page equal the counts `guard --check` prints for the same folder.

### [feature] A small AGENTS.md for Codex that keeps your own text (CX-6)

- The Codex `AGENTS.md` no longer holds agent prompts. Each prompt lives in `.codex/agents/<id>.toml`, between the prompt markers, so a 40-agent topology scaffolds an `AGENTS.md` well under Codex's size cap.
- The generated part of `AGENTS.md` sits between `agentopology:begin` and `agentopology:end` markers. A re-scaffold replaces only that block and keeps any text you wrote above or below it.
- `sync` reads prompts from the agent files. An `AGENTS.md` scaffolded earlier is still read for agents the files do not cover.

### [fix] Codex skills are written where Codex reads them (CX-7)

- Each skill is now `.agents/skills/<id>/SKILL.md` with `name` and `description` frontmatter. Nothing is written under `.codex/skills/` any more, since Codex never loaded those files.
- A skill with `disable-model-invocation` also gets `agents/openai.yaml` with `policy.allow_implicit_invocation: false`.

### [feature] One guard-script library for the bindings (CX-10)

- The before-agent, before-action and gate-wrapper scripts, and the session spawn, talk and prompt-log guards, are now built in `src/bindings/lib/guards.ts` from a platform record (project-dir variable, folders, hook payload field names, whether a hook can ask). The Claude Code scaffold is byte-identical to before for every example and fixture, held by a golden test. A Codex platform record builds the same guards with no `CLAUDE_PROJECT_DIR` and no `.claude` paths in them. Nothing is wired into the Codex binding yet.

### [feature] The Codex contract: constants, snapshots and a drift watch (CX-2)

- A new module holds what Codex CLI 0.156.1 documents: the 14 hook events, which of them ignore a matcher, which handler types run and which are skipped, the legal approval and sandbox values, and the keys a project config may not set. `checkHooks` reports an unknown event, a matcher on an event that ignores it, and a handler that Codex skips.
- Snapshots of the hook contract, the config keys and the feature flags are committed under `spec/codex/`. A test holds the constants to them, and `scripts/codex-drift.mjs` compares the snapshot with the live hooks page and prints each difference.
- The four URL keys that a project config may not set are not yet listed, because the page that names them could not be read when this was written.

### [feature] Codex probe pack (CX-3)

- `spec/codex/probes.json` and `spec/codex/probes.md` record ten facts about Codex CLI 0.156.1 that its docs do not state, each with its evidence and the date it was measured.
- Exit 2 from a `PreToolUse` hook blocks a shell command in `codex exec`. Exit 1, exit 127 and a timeout let the command run, with no warning.
- File edits reach hooks as `apply_patch`, and a subagent spawn as `collaborationspawn_agent`. A subagent's `agent_type` is the `name` in its agent file.
- Project hooks do not run without hook trust, and Codex does not say it skipped them. `.codex/` is read-only to the agent under `workspace-write`.
- `codex exec --strict-config` is the one command that rejects unknown config keys before any model call. A message sent with `codex queue` reaches an interactive session as a plain `UserPromptSubmit`, and never reaches a `codex exec` session.
- `scripts/codex-probes.sh` reruns the probes in temp repos. It is off unless `CODEX_LIVE=1`.
- A `[CX-3]` test fails unless every probe P1 to P10 has a dated record with a Codex version.

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
  hybrid seam in an example hybrid harness (now `examples/hybrid-release.at`).

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
- An example hybrid harness topology (now `examples/hybrid-release.at`).

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
