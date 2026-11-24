# Lane report: refusal event rule (0.13.2)

## Red line
`src/plugins/__tests__/refusal-events.test.ts` > "the row carries the rule the refusing gate states, and null when the gate states none" failed on v0.13.1 code: `expected null to be 'no-unchecked-accept'`.

## Commits (branch fix/0.13.2-rule-null, from v0.13.1)
- 5eaf526: Carry the gate's rule into the refusal event row. The event function gets a per-gate `case` mapping gate id to its rule (JSON string); gates without `rule:` write null. Only emitted when some gate states a rule, so every other generated file is byte-identical. CHANGELOG gets `## [0.13.2] - unreleased` with `### Fixed`.

## Goldens edited
None. guards-golden.json is untouched.

## Gates
- tsc --noEmit: clean
- refusal-events tests: 9/9 pass
- guard-proof, guards-golden, differential-0112, merge-differential-0112, hook-differential-0112, as0112-blocks, spec-sync: 7 files, 574 passed, 3 todo, 0 failed
- Frozen differentials and old assertions did not move.

## Full suite (`timeout 1800 npx vitest run`)
7123 passed, 2 failed, 24 skipped, 22 todo (7171). 237 files passed, 2 failed.
Failures, both the known container ones (root permissions, PATH rm shim); in files this change does not touch. I did not re-run them on v0.13.1:
- action-guard-speed.test.ts > "the same with no timeout program on PATH (stock macOS)"
- import-project.test.ts > "[I5] an unreadable file, an unreadable folder, a broken link and an oversized file ..."

## Stopped on
Nothing.
