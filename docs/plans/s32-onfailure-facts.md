# S-32: what onFailure "block" covers

Source: https://code.claude.com/docs/en/hooks.md, read 2026-11-15 (Claude Code 2.1.323 snapshot, no other drift).

## The premise
`onFailureWarnings` (src/conformance/claude-code.ts) and the guard note on an entry without `onFailure: "block"`
say a hook "cannot start or times out". The docs list five failures ("Each of these counts as a failure:"):
can't start, an exit code other than 0 or 2 (even with JSON that allows the action), an HTTP error, a timeout,
invalid output. Our text names two of them.

## What changes
1. The snapshot `spec/claude-code/hooks-contract.json` gains `onFailure`, extracted from the page by
   `extractHookContract`, so `npm run drift` sees it move:
   - `onFailure.failures.<case>`: each bullet of the failure list, verbatim, with its line;
   - `onFailure.block`: the "With `"block"` set" sentence; `onFailure.noEffect`: the hooks it does not apply to;
   - `onFailure.exitTable`: the stdout x exit-code table of "Exit code output", rows as written;
   - `onFailure.exit1`: the exit-1 warning. Quotes keep the markdown as written. Lines are not diffed.
   - `contractAt` drops the section below the version `command.onFailure` requires (2.1.295 = ON_FAILURE_SINCE).
2. `PRE_TOOL_USE_OUTCOME` in src/conformance/claude-code.ts: the table as data, and `preToolUseOutcome(exit, stdout, onFailure)`
   reading it. Tested rows: block + exit 1 + JSON allow blocks; no onFailure + exit 1 + JSON: the fields decide;
   no onFailure + exit 1 + no valid JSON: the call goes ahead.
3. Wording: the CC-onfailure warning, the guard note and docs/bindings.md name the documented cases.

## Grades
Fails-open is decided by whether the entry carries `onFailure: "block"`, not by the case list: no grade moves.
Only the note's text changes.

## Not changed
Generated guard scripts (no comment names the cases); the CX-10 golden stays. CHANGELOG history stays.
