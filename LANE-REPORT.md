# Lane report: body re-scaffold, upgrade rule (c') (0.13.1)

Branch `fix/0.13.1-body-rescaffold`, from 02412e4. Finished; nothing stopped on.

## Commits

- `32b9835` Rewrite an unedited file from a 0.13.0 manifest from the .at (src/scaffold/incremental.ts, the card's rows, CHANGELOG upgrade note, getting-started text).

## Red, then green

- Red (new (c') rows against the old code): 4 failed, 12 passed (16 rows in the file).
- Green: 16 passed.

## The change

`incremental.ts`: a body-tracked file with a manifest entry and no body hash is decided by its whole-file hash.

- Hash matches → unedited: the body is written from the .at and the body hash is recorded.
- Hash differs → user-owned: the prompt-region merge, the managed-block merge and the section regeneration are skipped, so the file is kept byte for byte (a rules file says `user edited — kept`; an agent or skill with nothing for the frontmatter patch to change is unchanged, as in (b)).
- No manifest entry → kept as before.
- The `body kept — written before bodies were recorded` branch is gone. The constant is still exported because the CLI imports it.

## Rows ((c') in body-rescaffold.test.ts)

1. unedited agent and skill get the new prompt, manifest records their body hash
2. regression: an unedited rules file follows the .at again
3. edited agent (appended text, and prompt-only edit), skill and rules file kept byte for byte; rules file says `user edited — kept`; nothing recorded
4. a file with no manifest entry is kept byte for byte
5. a second scaffold with no .at change: `0 created, 0 updated`, nothing said as kept, whole tree and manifest (minus timestamp) identical
6. deleting a file has it written fresh and recorded

## Own-row changes (body-rescaffold.test.ts)

- The two old (c) rows (kept all bodies and recorded nothing; delete-then-regenerate) are replaced by the six (c') rows above. The header comment is updated.
- Row 3 asserts the `user edited — kept` line for the rules file only: an agent or skill that scaffold has nothing to patch gets no line.

No other test, golden or pin changed. No OLD assertion and no FROZEN differential row moved.

## Gates

- `npx tsc`: clean.
- scaffold-owns, manifest-corrupt, structure-drift, structure-patch, session-binding, codex-scaffold-cx-warnings, differential-0112, merge-differential-0112, hook-differential-0112, as0112-blocks, surface-map, surface-map-codex, body-rescaffold: 13 files, 338 passed.
- guards-golden, binding and spec-sync tests: run as part of the full suite, no failures.
- Full suite once (`timeout 1800 npx vitest run`): 217 files passed, 2 failed (3 skipped); 6550 tests passed, 2 failed, 24 skipped, 22 todo.

Full-suite failures, both also failing on `origin/rc/0.13.0` in this container (checked in a worktree):

- `import-project.test.ts` [I5] an unreadable file … (runs as root, so permissions are not enforced).
- `action-guard-speed.test.ts` "the same with no timeout program on PATH (stock macOS)".
