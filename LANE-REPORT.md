# Lane report 0.13.3 (words, clock, stop): STOPPED before any change

Head sha of feat/0.13.3-words-clock-stop: 8cc73bc (v0.13.2, no commits added; nothing pushed on that branch).

## Why I stopped

The rules say: stop and report, changing nothing, if an OLD assertion (present at v0.13.0) has to move, except the one
pre-cleared class (old assertions that test a go followed by a trailing clause).

Card 1 makes the go word case-insensitive ("Go" must count). One old assertion asserts the opposite and is NOT a
trailing-clause assertion, so it is outside the pre-cleared class:

- `src/__tests__/e2e/human-go-word.test.ts:202` (present at v0.13.0, test "(2) the word followed by a space and more counts; any other prompt writes nothing"):
  `expect(run(goCmd(), prompt("Go Release")).status).toBe(0);` followed by `expect(rows()).toHaveLength(0);` at line 204.
  It encodes "the go word is case-sensitive: `Go Release` writes no row". Under the new rule, `Go Release` is the whole
  message, so it must count and the row count at line 204 changes from 0 to 1.

There is no way to satisfy both that assertion and the required "Go" / "Go release." must-count rows.

## The pre-cleared moves I expect (not done), for the manager's review

All in `src/__tests__/e2e/human-go-word.test.ts`:

- line 205: `go release now` counts (rows 1) -> would become "does not count".
- line 212: `go release, notes look right` counts -> "does not count".
- line 215: `go release: ship it` counts -> "does not count".
- line 216: `go release; thanks` counts -> "does not count".
- lines 214, 217, 218 (`go release.`, `go release!`, `go release?`) still count (surrounding punctuation is trimmed).
- line 231: `go release, <task-notification>...` still does not count.
- other tests (go-stop-word, go-entry, egress, wall-time) have no go-with-clause or case assertions; the stop rows in
  go-stop-word.test.ts (lines 177-187) already agree with the new first-word stop matching.

## Decision needed

Approve moving `human-go-word.test.ts:202` (`Go Release`: no row -> a row is written) as part of the pre-cleared class,
then re-run this lane. Cards 1, 2 and 3 are otherwise unstarted: no red lines, no commits, no golden entries, no gates,
no full suite run (only `npm ci` was run to prepare the container).

Code reading done for the next run: the go hook is `goHook()` in `src/bindings/lib/guards.ts` (around line 3959, matching
at 3990-4005); `before-schedule.sh` (line 2682) still matches the old "starts with the word" rule and is conservative, so
it can stay; wall-time scripts are in `src/bindings/lib/controls.ts` (lines 33-90).
