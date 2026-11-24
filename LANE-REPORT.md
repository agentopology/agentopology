# Lane report: feat/0.13.1-at-reads

Status: fix and rows done; STOPPED on the guards-golden gate and the full suite (see below).

## Commits (branch feat/0.13.1-at-reads, from rc/0.13.0 aec197c)

- 59c9500 Read agentopology's read-only subcommands as reads in a write gate (guards.ts, guard-proof.test.ts, CHANGELOG)

## The cause and fix

The write-gate check (`writeGateGuardLines`) used `at_only_reads`, which refuses any command with a `>` and reads only `AT_READS` programs. I added `AT_PW_AT_READS` and `at_pw_atread` (own variable, path reading only; `AT_LEAD` and `AT_READS` untouched), wired into `at_pw_seg` and `at_reads_segs`, and `at_at_reads` in the write gate: it applies only when the command mentions agentopology, runs `at_reads_plain` (so a redirect into a matching path is still a write). A form with --output, -o, --force, --prune, --fix or --write stays a write. The `node <path>/dist/cli/index.js` form is not added: the guard does not recognize it today.

## Rows (guard-proof.test.ts, topologies: plain, ledger gate, go word, each plus `before: write "**/*.at"`)

| topology | must-pass | must-refuse |
|---|---|---|
| plain | 12 | 7 |
| ledger gate | 12 | 7 |
| go word | 12 | 7 |

Red first: before the fix all 36 must-pass rows failed and the 21 must-refuse rows passed. After: guard-proof 242 passed, 3 todo. The new rows use copies of the three topologies, so existing rows are unchanged.

## Gates

- tsc: clean
- guard-proof, guard-check, guard-ordinary, guard-protect, guard-protect-schedule, guard-target: pass
- go-entry, human-go-word: pass
- differential-0112, merge-differential-0112, hook-differential-0112, as0112-blocks: pass (none moved)
- spec-sync, surface-map, surface-map-codex: pass
- guards-golden: FAILS, expected. Four before-action.sh hashes moved, all files my change touches (the shared PATH_FUNCTIONS block and the write gate):
  - examples/openclaw-assistant.at:.claude/skills/personal-assistant/scripts/before-action.sh
  - src/__tests__/e2e/fixtures/codex-gates.at:.claude/skills/ship/scripts/before-action.sh
  - src/__tests__/e2e/fixtures/p10-router.at:.claude/skills/p10-router/scripts/before-action.sh
  - inline:action-gate:.claude/skills/ship/scripts/before-action.sh

## Stopped on

1. guards-golden.json is NOT updated. The new hashes need the test's own regenerate command (`UPDATE_GOLDEN=1`); running it was denied by the permission classifier, and I did not work around that. Please regenerate or approve it, then check `git diff` shows exactly those four lines. The feat branch is pushed with this gate red.
2. The full suite (`timeout 1500 npx vitest run`) was not run: the golden gate is red, and one command in this container was killed for memory. Run it after the golden update.
