# Lane report 0.13.3 (words, clock, stop), second run: DONE

Final head sha of feat/0.13.3-words-clock-stop: 5ef5bb2 (branch started at v0.13.2 = 8cc73bc). Pushed: that branch and this one only.

## Commits (feature branch)

| sha | what |
| --- | --- |
| b82e212 | card 1 red: go-words.test.ts, plus the pre-cleared moved assertions in human-go-word.test.ts |
| d73e5b5 | card 1 green: whole-message go word, first-word stop word, `stop-word:` list, V169, docs, CHANGELOG |
| acc1ee2 | card 2 red: wall-renew.test.ts |
| 185aec5 | card 2 green: `renew-on:` on the entry agent, renewal in the go hook, V161 additions, docs |
| 7607801 | card 3 red: go-stop-from.test.ts |
| 5ef5bb2 | card 3 green: `stop-from: any`, V169 additions, docs |

## Red lines per card (before the green commit)

- Card 1: go-words.test.ts 45 of 70 failed; human-go-word.test.ts 2 of 12 failed (the two tests holding the moved assertions).
- Card 2: wall-renew.test.ts 8 of 16 failed (5 validation rows, the renew row, the second renewal, the per-session row); the 8 negative rows already held on the old code, as they should.
- Card 3: go-stop-from.test.ts 8 of 19 failed (3 validation rows, 4 relayed-stop rows, the relayed-stop-then-go row); the without-the-field and relayed-go rows already held.

## Moved old assertions (old -> new), all pre-cleared, all in src/__tests__/e2e/human-go-word.test.ts

Line numbers are as at v0.13.2.

- 202 `Go Release`: writes no row -> writes the go row (case-insensitive). Now asserted with rows length 1.
- 205 `go release now`: counts -> does not count.
- 212 `go release, notes look right`: counts -> does not count (moved to the does-not-count list).
- 215 `go release: ship it`: counts -> does not count (same).
- 216 `go release; thanks`: counts -> does not count (same).

No other old assertion moved. Rows that stayed: `go release.`, `go release!`, `go release?`, `go release` (count); `go released`, `please go release, ok`, `go release-candidate`, `go release/x`, `go release_ok`, the cross-session and task-notification rows (do not count). go-entry.test.ts lines 385-386 (before-schedule.sh on `go release now`, `go release, notes look right`) are unchanged: before-schedule.sh keeps its stricter old rule (noted in the CHANGELOG).

## Golden entries

None changed: guards-golden.test.ts passes against the unmodified guards-golden.json (no example or fixture has a human with a go word that reaches the changed hook text). No hash was written.

## The frozen proof

- `git diff -U0 v0.13.2 -- src/bindings/lib/guards.ts` hunks all start at line 3953 or later, plus the import on line 20. STDIN_JQ_FUNCTIONS (line 722) and STDIN_JQ_CHECK (line 750) are untouched: byte-identical to v0.13.2.
- differential-0112, merge-differential-0112, hook-differential-0112 and as0112-blocks pass unchanged and unedited.

## Gates

- `tsc --noEmit`: clean after each card.
- Card gates (after card 3): go-words, human-go-word, go-stop-word, go-stop-from, go-entry, wall-time, wall-renew, readme-sync, spec-sync, guards-golden, spec-testing-sync: 11 files, 209 tests, all pass.
- Guard batch (every src/__tests__/e2e/guard-*.test.ts, the three differentials, as0112-blocks, surface-map, guards-golden, readme-sync, spec-sync, spec-testing-sync): 15 files, 670 passed, 3 todo; the two failures in that run (rule counts in README and spec/validation.md) were the docs not yet updated, fixed in d73e5b5 and passing after.
- `npm run build`: ok. dist grep for `S-2`, `HV-`, `AT-1`: 0 hits.
- Full suite, one run, `timeout 1800 npx vitest run`: 246 files (2 failed, 241 passed, 3 skipped); 8528 tests (2 failed, 8480 passed, 24 skipped, 22 todo).
  - Failure 1: action-guard-speed.test.ts, "the same with no timeout program on PATH (stock macOS)" (the PATH rm shim row; known on v0.13.1 and v0.13.2).
  - Failure 2: import-project.test.ts [I5] (running as root; known on v0.13.1 and v0.13.2).

## What was built

1. Words. The go hook compares with `at_trim` and `at_first`/`at_norm`/`at_stop`, written with quoted patterns (a multibyte character is removed whole, in any locale; `tr` runs on ASCII letters only, `LC_ALL=C tr A-Z a-z`, no `${,,}`, so bash 3.2 works). Stop word: first word, trimmed of whitespace and `. , ; : ! ? ' " * / ) ( - _` backtick `…` `–` `—`; the first word ends at whitespace or one of `, ; : ! ? . " * / ( ) backtick < > … – —`, so `stop—now` and `stop…` halt while `stopwatch`, `don't stop`, `please stop` do not. A stop word of several words matches its words in order at the start. A word with a non-ASCII character is matched with no case folding. Go word: the whole message, compared word by word with single spaces, ASCII case folded. `stop-word:` accepts a list (AST `stopWords`, round-trips). V169 (the next free rule number; V167 is the plugin rule): empty word, duplicate (case aside), equal to the go word, a word holding a cut character; the old V160 rows are untouched for the string form.
2. Clock. `renew-on: <human-id>` beside `wall-time:` on the entry agent. Only that human's go hook carries the renewal: past the cap, after a typed go row, it resets `.claude/state/wall-time/<session_id>` to now and appends `{ts, human, previous_start}` to each go ledger. No recorded start, not past the cap, a relayed go, or another human: nothing. V161 refuses it without wall-time, off the entry agent, naming a non-human or a human with no go word. Without it the go hook text is identical (asserted).
3. Stop from anywhere. `stop-from: any` (V169 refuses other values and the field with no stop word). With it the go hook skips the early typed exit, reads the text after the envelope of a relayed prompt (the body of a cross-session message, or what follows `</task-notification>`), and still exits before the go check unless typed. Without it the old early exit is the same line.

## Notes for the reviewer

- A relayed stop is read after its envelope only for the two envelopes the typed test knows. A relayed stop inside other text halts only when it is the first word of that text.
- Renewal rows have no `step` field (as specified); the guard, halt and gate scripts all passed with such rows in the ledger.
- Docs touched: spec/grammar.md (go paragraph, stop paragraph, wall-time and renew-on rows, grammar line), the human and agent field tables and V160/V161/V169 text in src/docs/content.ts, spec/validation.md, README rule count (169), CHANGELOG `## [0.13.3] - unreleased`.
