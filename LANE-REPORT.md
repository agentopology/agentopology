# Lane report: versioned package names in step gates

Status: STOPPED. The fix works (new rows green), but it moves a frozen row (`as0112-blocks`) and the recorded golden, so I did not edit either, did not run the full suite, and did not add a CHANGELOG-only follow-up. Needs a decision.

Branch: `fix/0.13.2-versioned-names` (from v0.13.1), pushed. One commit:

- `69e6af5` Read a package spec with a version, a tag or an npm alias as its bare name in step gates (guards.ts, new test file, CHANGELOG 0.13.2 entry).

## Red first (v0.13.1 as-is, before any code change)

New file `src/__tests__/e2e/step-gate-versioned-names.test.ts`, first run: 91 failed, 87 passed of 178. Controls (5, 6, `./node_modules/.bin/agentopology scaffold`, `cd sub && agentopology scaffold`, `pnpm dlx agentopology scaffold`, `pnpm exec agentopology scaffold`, `yarn dlx agentopology scaffold`) already passed, as expected. Failing lines (each exit 0 where 2 was wanted, shown for the plain topology; ledger, go and two-gate fixtures failed the same rows):

- `refused: npx -y agentopology@0.13.1 --no-plugins scaffold probe.at --target claude-code --dir .`
- `refused: npx agentopology@latest scaffold probe.at`
- `refused: pnpm dlx agentopology@0.13.1 scaffold probe.at`
- `refused: npx --yes agentopology@0.13.1 scaffold probe.at`, `pnpm exec agentopology@0.13.1 ...`, `yarn dlx agentopology@0.13.1 ...`, `bunx agentopology@0.13.1 ...`, `bunx --bun agentopology@latest ...`, `npm exec -- agentopology@0.13.1 ...`, `npx agentopology@npm:agentopology@0.13.1 ...`, `pnpm dlx some-alias@npm:agentopology@0.13.1 ...`, and the same inside `echo hi && ...`, `FOO=1 ...`, `cd sub && ...`, `timeout 60 ...`
- two-gate fixture, validate step before its sign (row 4): `npx agentopology@0.13.1 validate gated.at` (with and without `--no-plugins`), `npx -y agentopology@latest validate ...`, `pnpm dlx`, `yarn dlx`, `bunx`, `npm exec --` forms.

After the change: 211 of 211 green in that file (four topologies plus a fifth fixture, two step gates and a write gate).

## What changed

All matching of a program or package by name, and what I did with each:

| Place (guards.ts) | Matches | Action |
|---|---|---|
| `_seg_steps` (step gates, the claude runner check in go-entry, the typed-only-programs check) | program or runner word, by `at_names` | changed: segment read through new `at_pkg_seg` first |
| `at_stdin_fed` (inside `_seg_steps`, stdin runner check) | compares the written segment with the words read | changed: reads the written segment through `at_pkg_seg` too, else every rewritten segment reads as doubt |
| `at_keys_seg` (keys typed into a terminal; typists) | program word | changed: reads its segment through `at_pkg_seg` |
| `stepKey` (declared step's tool, used by step gates, git step list, records) | declared command | changed: `pkgName` on a runner's package, `bunx`/`pnpx` are runners, `dlx` skipped |
| `at_names` itself | basename, any path | unchanged on purpose (a general `@` strip would read `ssh git@github.com` as git) |
| `at_pw_atread`, `at_pw_npseg` (write gate's read list) | `agentopology`, `npx agentopology[@X.Y.Z]` | unchanged on purpose, per the 0.13.1 rules (a tag, an alias, pnpm dlx are still not a read there) |
| `at_stdin_tool`, `at_stdin_runner`, `at_defer_prog`, crontab, tmux/screen, `at_glob_program` (no-jq glob check) | system programs, not packages | reviewed, unchanged |
| no-jq letters check | letters of the whole command | reviewed: already catches `agentopology@0.13.1`, no change |
| route/launch guard, go gates, protected script tools | agent names, ledger paths, go word, script paths | not program-name matches; reviewed, unchanged |
| `CHILD_PROGRAMS` (at_resolve doubt list) | npx npm pnpm yarn, not bunx/pnpx/bun | reviewed, left alone (resolution doubt, a different question) |
| `at_claude_pkg` (the existing claude-code package rule) | `anthropic-ai/claude-code` any version | unchanged; the new code is the same shape |

New shell functions: `at_pkgname SPEC` (drops `@version`/`@tag`, resolves `npm:` alias, keeps a leading scope) and `at_pkg_seg SEGMENT` (rewrites the package after npx, pnpx, bunx, `pnpm|yarn|npm|bun dlx|exec|x`, `-p`, `--package`, `--package=`, and the word after `--`). Only a runner's package is rewritten; other words such as `git@github.com` stay as written. A scope is kept, so `@scope/agentopology@1` is read by its basename as `agentopology`, like `@scope/agentopology` already was. A bare `agentopology@0.13.1 scaffold` (no runner) is not rewritten: it is not a runnable command.

Write-gate coexistence rows (fixture with a go gate, a sign gate and a write gate over `**/*.at`): `npx agentopology@0.13.1 info x.at --no-plugins` passes; `npx agentopology@0.13.1 scaffold x.at --dry-run --no-plugins` and `... validate x.at --no-plugins` are a read for the write gate and still refused by the step gate; `@latest`, no `--no-plugins`, `--plugin`, `pnpm dlx` stay refused as not a read.

## Gates (with the change)

- tsc: clean.
- Run together: guard-proof, every `guard-*.test.ts`, go-entry, human-go-word, guards-golden, differential-0112, merge-differential-0112, hook-differential-0112, as0112-blocks, spec-sync: 686 passed, 3 failed, 3 todo.
- Failures (all pass on v0.13.1 in this container):
  1. `as0112-blocks` > "each script holds its no-jq head and tail, and the reader blocks, exactly once": `before-action.sh: at_stdin_runner: expected +0 to be 1`. FROZEN row moved.
  2. `as0112-blocks` > "a script missing a block, or holding one twice, makes the undo throw": same cause (`as0112: at_stdin_runner occurs 0 times`).
  3. `guards-golden` > "hashes of every example and fixture output match the recorded golden": expected, every generated `before-action.sh` changed. Not edited.
- Cause of 1 and 2: I edited two lines of `at_stdin_fed`, which sits inside the frozen stdin reader block (`STDIN_JQ_FUNCTIONS`, found by as0112-blocks as text). Without that edit, a rewritten segment no longer equals the written one and reads as doubt, which refuses a harmless `npx agentopology@X validate`.
- Not run: the full suite (`npx vitest run`), because of the stop rule. The golden was not edited.

## Speed (action-guard-speed, best of 1, slowest before-action.sh shape)

- v0.13.1: 95 ms ("assignment then &&" and "doubted: upper-case name"); plain command 38 ms.
- With the change: 93 ms; plain command 39 ms. The new work is skipped unless the segment holds an `@`. Its one failure, "the same with no timeout program on PATH", is the known PATH shim row in this container.

## Decision needed

To land this without moving a frozen row, `at_stdin_fed` must stay byte-identical. Options: (a) move the normalisation out of `at_stdin_fed` by having `_seg_steps` hold the written words in a variable that `at_stdin_fed` reads (needs a new line in `_seg_steps`, outside the frozen block); (b) accept a deliberate, named change to the frozen block and its pin. I did not choose (b) on my own. Then the golden edit (diff is exactly the regenerated before-action.sh outputs) can be done by hand per the standing rules.

Other notes: the CLI refused my test `.at` files (V90, V157 style errors) because the test fixtures use one-line `meta { ... }`, as the existing tests do; the tests use `parse` only.
