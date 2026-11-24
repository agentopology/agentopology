# Lane report 0.13.2 r3

Branch fix/0.13.2-r3, started from fbf186c. Final head: cc33e74.

## Red lines (before the fix, 60 rows failed in step-gate-versioned-names, i.e. the gate let them pass)
Refuse expected, exit 0 seen, on every fixture (scaffold) and on the two-gate fixture (validate):
- `a='agentopology@1 scaffold probe.at'; npx $a`
- `a='agentopology@1 scaffold probe.at'; npx -y $a`
- `a='agentopology@1 scaffold probe.at'; command $a`
- `a='-y agentopology@1 scaffold probe.at'; npx $a`
- `echo 'scaffold probe.at' | xargs npx -y agentopology@1`
- `echo 'scaffold probe.at' | xargs npx agentopology@1`
- validate twins: `a='agentopology@1 validate gated.at'; npx $a`, `echo 'validate gated.at' | xargs npx agentopology@1`
- `. <(echo 'agentopology scaffold probe.at')`
- `git rebase -x 'agentopology scaffold probe.at' HEAD~1`, `git rebase --exec='...' HEAD~1`
- `npm pkg set 'scripts.x=agentopology scaffold probe.at'`, `npm set-script x '...'`

Already refused before the fix (not red): `. /dev/stdin <<< 'agentopology scaffold probe.at'` (the here-string text is read on its own line) and `printf 'agentopology@1\nscaffold\nprobe.at\n' | xargs npx -y`.

## Commits
- cc33e74: whole-command reading when a command holds an unquoted expansion or xargs; dot, git rebase -x/--exec, npm pkg set / set-script read as code; rows; CHANGELOG.

## Golden entries changed
None. The guards-golden test passes unchanged (no example or fixture has a coarse agentopology step). guards-golden.json not touched.

## Frozen proof
STDIN_JQ_FUNCTIONS and STDIN_JQ_CHECK diff against v0.13.1: empty. `git diff v0.13.1 HEAD -- src/bindings/lib/guards.ts | grep -c at_stdin_` = 0. No old assertion and no frozen differential row moved.

## Gates
- tsc --noEmit: clean
- step-gate-versioned-names: 1079 passed (new rows included; new must-pass rows `a=docs; ls $a`, `echo hi | xargs echo`, `git commit -m "agentopology scaffold notes"` pass; the two new known false refusals refuse)
- golden, guard-*, go-entry, human-go-word, the three differentials, as0112-blocks, surface-map: 15 files, 701 passed, 3 todo
- readme-sync, spec-sync, spec-testing-sync: 13 passed
- speed file alone: slowest before-action.sh shape is "here-string", 131 ms
- npm run build, dist grep for 'S-2', 'HV-', 'AT-1': 0 files

## Full suite (`npx vitest run`)
8210 passed, 2 failed, 24 skipped, 22 todo (8258). Test files: 238 passed, 2 failed, 3 skipped.
Failures, both the ones known on v0.13.1 in this container:
- import-project [I5] (runs as root)
- action-guard-speed, "the same with no timeout program on PATH (stock macOS)" (PATH rm shim)
v0.13.1 was not re-run separately; the two are the failures named as known there.
