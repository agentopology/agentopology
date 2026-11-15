# S-23..S-27: five false positives found by scan

Each ticket: reproduction, rule change, source. Red test first, then the fix.

## S-23 cc.hooks.cwd: `${CLAUDE_PROJECT_DIR:-.}/x.sh` is anchored
- Repro: `unanchoredScript('/bin/sh "${CLAUDE_PROJECT_DIR:-.}/scripts/x.sh"')` returns the path
  (src/conformance/claude-code.ts `unanchoredScript`; guard --check uses it via `commandProblem`).
- Rule: a script word that starts with the project-dir variable in any form the parser
  already reads as the project (`$CLAUDE_PROJECT_DIR`, `${CLAUDE_PROJECT_DIR}`,
  `${CLAUDE_PROJECT_DIR:-<default>}`, quoted or not) is anchored. One regex: `PROJECT_DIR`
  in src/parser/run.ts (S-01), exported, not a second copy. A bare relative path still fails.
- Source: Claude Code sets CLAUDE_PROJECT_DIR for every hook; the `:-` default only applies when
  it is unset.

## S-24 cx unanchored-script: a variable set from the repo root in the same command
- Repro: `repo_root="$(git rev-parse --show-toplevel)" && "$repo_root/.claude/hooks/x.sh"` is flagged
  (src/conformance/codex.ts `unanchoredScript`).
- Rule: a variable assigned exactly `$(git rev-parse --show-toplevel ...)` (quoted or not) earlier in
  the same command string is the root; `$NAME/...` and `${NAME}/...` after that assignment are
  anchored. Any other variable, or a use before the assignment, is still flagged.
- Source: the existing ROOT_EXPR rule (the root expression inline is already anchored).

## S-25 cx.config: `[agents] max_threads = N`
- Repro: `checkConfigAgainstSchema({agents:{max_threads:4}}, schema)` says
  "agents.max_threads: expected object": the 0.168.0 schema snapshot has no `max_threads`
  property, so the key falls to `additionalProperties` (an agent role table).
- Docs: https://developers.openai.com/codex/config-reference (now learn.chatgpt.com/docs/config-file/config-reference),
  row `agents.max_threads` (number): "Legacy alias for `agents.max_concurrent_threads_per_session`."
- Rule: a documented legacy alias is checked against the property it aliases (type integer,
  so `max_threads = "four"` still fails), not as a role. The snapshot stays verbatim; the
  alias table lives in src/conformance/surface.ts with the doc URL.
- Test change: RW-2's planted config used `max_threads = 4` as its drift; it becomes
  `max_threads = "four"` (same id, a real type error), so the drift mechanism is still tested.

## S-26 read-only commands print "[codex] .codex/hooks.json written"
- Repro: `validate x.at --inventory <dir>` on a .at with a hook prints the line; coverage()
  (src/inventory/index.ts) calls `codexBinding.scaffold` in memory. Nothing is written.
- Rule: the binding exports an in-memory scaffold that does not print the "written" notice;
  coverage uses it. `scaffold --target codex` prints exactly what it prints today.

## S-27 guard.untied on an imported bare-tool hook
- Repro: settings.json Stop runs `chunk validate`; import writes `run: "command chunk validate"`
  (S-11: a PATH tool is prefixed with the `command` builtin so it is not stubbed). The binding
  emits `command chunk validate`, so neither the declared-command match nor the script-name
  match ties it: reported untied.
- Verdict from the code: a false positive. The .at declares the same event and the same
  command; `command X` runs X (POSIX `command` builtin).
- Rule: the declared-command match compares commands with a leading `command ` removed.
