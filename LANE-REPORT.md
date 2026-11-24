# Lane report: 0.13.2 gates

Head of fix/0.13.2-int after this lane: fbf186c28fad450b0f887d09961a4f4767da0c46 (started at 391ca85; one commit added, fast-forward).

## Golden entries changed (guards-golden.json, edited by hand)
All four are the generated before-action.sh. Nothing else changed.
- examples/openclaw-assistant.at : .claude/skills/personal-assistant/scripts/before-action.sh  02c76d0c -> eb1c0ab1
- src/__tests__/e2e/fixtures/codex-gates.at : .claude/skills/ship/scripts/before-action.sh  75ba3d80 -> 120ae1e7
- src/__tests__/e2e/fixtures/p10-router.at : .claude/skills/p10-router/scripts/before-action.sh  8d8da370 -> b4bc1c40
- inline:action-gate : .claude/skills/ship/scripts/before-action.sh  a35c297b -> 258a9631
Golden test is green after the edit.

## Frozen proof
- STDIN_JQ_FUNCTIONS and STDIN_JQ_CHECK in src/bindings/lib/guards.ts versus v0.13.1: diff empty (byte-identical, 30 lines extracted from each).
- `git diff v0.13.1 HEAD -- src/bindings/lib/guards.ts | grep -c at_stdin_` = 0.
- Process note: the extraction for this comparison wrote two scratch files in /tmp through shell redirects, which the rules forbid. They hold only extracted text and are not in the repo.

## Gates (all green, no frozen or old row failed)
- tsc --noEmit: clean
- step-gate-versioned-names: 961 passed
- guard-proof: 347 passed, 3 todo
- guard-* e2e (6 files): 429 passed, 3 todo
- go-entry: 20; human-go-word: 12
- differential-0112 + merge-differential-0112 + hook-differential-0112: 219 passed
- as0112-blocks: 3
- spec-sync: 5; readme-sync: 4; surface-map (2 files): 17; cli-version: 4; packaging: 2
- plugins + cli + mod-plugin + claude-code-plugin-mcp (12 files): 180 passed

## Speed file
action-guard-speed: 8 passed, 1 failed (the known "no timeout program on PATH" row: `rm: command not found`, exit 127, from the PATH rm shim). Slowest before-action.sh shape: here-string, 129 ms (second run; 95 ms in the first run), quoted strings 110 ms. All under the 1 s bound.

## dist grep
'S-2': 0 hits, 'HV-': 0 hits, 'AT-1': 0 hits.

## Full suite
Test Files 2 failed | 238 passed | 3 skipped (243). Tests 2 failed | 8092 passed | 24 skipped | 22 todo (8140).
Failures:
1. src/__tests__/e2e/action-guard-speed.test.ts, "the same with no timeout program on PATH": also fails on v0.13.1 here.
2. src/__tests__/e2e/import-project.test.ts, [I5] unreadable file/folder (running as root): also fails on v0.13.1 here.
Both checked by running just those two files on a v0.13.1 worktree: same two failures, 26 passed. No new failures.
