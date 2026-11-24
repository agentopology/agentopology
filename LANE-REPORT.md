# Lane report: plugin seam (feat/0.13.1-plugin-seam)

Finished: both steps are done and pushed to `feat/0.13.1-plugin-seam` (head 851ceb7). Nothing else was pushed except this report branch.

## Commits

- a07a251: Merge rc/0.13.0 (aec197c) into the seam branch. The seam's plugin rule is now V158.
- 0b09633: Test (red): the refusal event rows, plus the `RefusalEvent` type and the plugin's `reads` field.
- 969aa73: A topology that opts in gets one refusal event per refusal (green), with docs, grammar and changelog.
- e657ed8: Test (red): a plugin's commands and its `guard --check` rows, with the acme fixture extended.
- 851ceb7: A plugin can add commands and `guard --check` rows (green), with docs and changelog.

## Merge conflicts and how they were resolved

The clone was shallow; `git fetch --unshallow` fixed it. The branch was at 4412be7 as required. `npm ci` worked.

The merge had conflicts in 23 files. rc/0.13.0 holds the 0.13 work as different commits than the seam branch's base (merge base 08aa910), so the same files differed on both sides. I took rc's version of every conflicted file. I then re-applied only the seam's own four commits (the diff 586e5b8..4412be7) on top, using a three-way apply. Hand-merged:

- CHANGELOG.md: a `## [0.13.1] - unreleased` section above `## [0.13.0] - 2026-11-24`.
- README.md, spec/grammar.md, spec/validation.md: rule counts are now 158, the grammar keeps rc's `threat-model` and `islands` and adds the seam's `uses-plugins` and plugin blocks.
- src/cli/index.ts: kept the seam's plugin loading, rc's `--version` check (moved into the entry block), and rc's `tested` marks in `guard --check`.
- src/docs/content.ts, src/parser/validator.ts, src/parser/index.ts: kept both sides.
- Rule number: rc already uses V138 for the threat-model rule (and V139 to V157). The seam's "plugin not loaded" rule is renumbered V158 everywhere, tests included.
- Files rc added that the seam never touched (the AA conflicts, such as the hook-record differential and silent-accepts): rc's version, unchanged.

No frozen differential, golden or old assertion moved.

## Step 2A: refusal event

- `meta { refusal-events: true }` or a loaded plugin with `reads: ["refusals"]` turns it on. Both are off by default.
- With it on, each generated claude-code `.sh` that has `exit 2` gets a small function after its first line. Each `exit 2` becomes `{ at_refusal_event 2>/dev/null || :; exit 2; }`. The write inside is `{ printf … >> "$LOG"; } 2>/dev/null || true`. A failed append never changes the exit code (tested with the events folder replaced by a file).
- One line per refusal: a guard that another guard runs (a gate's wrapper) stays silent, so the outer guard writes the one line.
- The line is `{v:1, ts, guard, gate|null, rule|null, tool, reason}`. `rule` is always null for now. `reason` is a fixed label. The refused command's text and the tool input are never written (tested).
- The before-edit guard refuses Edit and Write on the event file, and is generated when the opt-in is on.
- Not covered: stub scripts the user writes, and Codex (claude-code only).
- Without the opt-in every generated file is byte-identical: guards-golden and the frozen differentials did not move.

## Step 2B: plugin commands and report rows

- `commands` run as `agentopology <pluginId>:<name> [args...]`. A plugin that is not loaded, a missing name, a name that is not a lower-case word, or a return that is not a whole number from 0 to 255 is an error. The colon keeps them from shadowing a core command (tested with `acme:validate`).
- `guardReport` rows print after all core rows in `guard --check` as `plugin <id> claimed: <row>`. They are not counted in the core total. The core output and exit code are identical with and without the rows (tested).
- Docs topic `plugins` and the `## [0.13.1] - unreleased` changelog section are updated.

## Gates

All of these passed after the last commit: tsc; src/plugins; guards-golden; differential-0112, merge-differential-0112, hook-differential-0112; as0112-blocks; spec-sync; surface-map; the CLI tests; docs and parser tests (48 files, 1779 tests).

## Full suite (`npx vitest run`)

```
Test Files  3 failed | 222 passed | 3 skipped (228)
     Tests  4 failed | 6589 passed | 24 skipped | 22 todo (6639)
```

The 4 failures:

- src/__tests__/e2e/action-guard-speed.test.ts: "the same with no timeout program on PATH (stock macOS)"
- src/__tests__/e2e/cx-review-fixes.test.ts: "POSIX watchdog: a check that ignores TERM is dead when the hook exits 2" (`check 24488 still running after the hook returned`) and the GNU timeout twin
- src/__tests__/e2e/import-project.test.ts: "[I5] an unreadable file, an unreadable folder, …" (`expected 'Importing from claude-code files in /…' to contain 'Not read: .claude/agents/locked.md (E…'`)

I ran those three files on the merge commit a07a251, before any step 2 change. The same one test in each file fails there (the second cx-review-fixes row passed that time, so it looks flaky). They are about process timing and about file permissions as root in this container, and they have nothing to do with the opt-in. I did not fix them.

## Stopped on

Nothing. One thing to know: the first `tsc` run after step 2A's red commit needed the `RefusalEvent` type and `reads` field for the build to pass, so the red commit includes those types.
