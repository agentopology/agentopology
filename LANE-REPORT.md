# Lane report 0.13.2 r4

Branch fix/0.13.2-r3 (fast-forward from cc33e74). Final head: f22d589.

## Red lines (rows added on cc33e74, run before the fix: 82 failed of 1166 in step-gate-versioned-names)
Refuse expected, exit 0 seen, on every fixture (scaffold) and the two-gate fixture (validate twins):
1. Alias:
   - `shopt -s expand_aliases\nalias a='agentopology scaffold probe.at'\na`
   - `shopt -s expand_aliases; alias a='agentopology scaffold probe.at'; a`
   - `alias a='npx agentopology@1 scaffold probe.at'; a`
2. Fragments inside code strings:
   - `a=agen; eval "${a}topology scaffold probe.at"`
   - `sh -c 'agento$0 scaffold probe.at' pology`
   - `bash -c '$0$1 scaffold probe.at' agento pology`
   - `xargs -I{} {}pology scaffold probe.at <<< agento`
   - `echo agento | xargs -I{} {}pology scaffold probe.at`
   - `echo agento | xargs -I{} npx {}pology@1 scaffold probe.at`
   - `echo agento | xargs -I{} sh -c '{}pology scaffold probe.at'`
   - `compgen -c | xargs -I{} {} scaffold probe.at`
   - `ls | xargs -I{} {} scaffold probe.at`
3. False refusals (pass expected, exit 2 seen), on every fixture:
   - `git commit -m "agentopology scaffold fix" && echo $HOME`
   - `grep -rl 'agentopology scaffold' . | xargs wc -l`
   - `echo $HOME; git log --grep "agentopology scaffold"`
   - `echo 'agentopology scaffold' | xargs echo` (was a documented false refusal; now passes and is a must-pass row)

## Commits
- cc8e171: rows for the three items (red).
- d9350fb: fix in guards.ts: alias value read as code; at_posexp (expansion, $0, {} where a program, a runner's package or a code string's program stands); at_xargs (xargs trigger only for a runner, shell, code program, template or no command); the whole-command reading uses both; xargs no longer marks every command as code.
- f22d589: CHANGELOG: alias and code-string lines, narrower trigger, false refusals updated, residuals list.

## Golden entries changed
None. guards-golden test passes unchanged; guards-golden.json not touched.

## Frozen proof
STDIN_JQ_FUNCTIONS and STDIN_JQ_CHECK: diff against v0.13.1 empty (30 lines each side). `git diff v0.13.1 HEAD -- src/bindings/lib/guards.ts | grep -c at_stdin_` = 0. No old assertion and no frozen differential row moved (all pass).

## Gates
- tsc --noEmit: clean
- step-gate-versioned-names: 1166 passed (all round-3 rows and earlier refusing rows still refuse; all must-pass rows pass)
- guards-golden: 1 passed
- guard-*, go-entry, human-go-word, the three differentials, as0112-blocks, surface-map, spec-sync, readme-sync, spec-testing-sync: 24 files, 931 passed, 3 todo, 1 failed (the known no-timeout speed row)
- speed file alone: slowest before-action.sh shape is "here-string", 133 ms
- npm run build; dist grep for 'S-2', 'HV-', 'AT-1': 0 files

## Full suite (`npx vitest run`)
8297 passed, 2 failed, 24 skipped, 22 todo (8345). Test files: 238 passed, 2 failed, 3 skipped.
Failures, both known on v0.13.1 in this container:
- import-project [I5] (runs as root)
- action-guard-speed, "the same with no timeout program on PATH (stock macOS)" (PATH rm shim)

## Notes
- Double-quoted text holding an expansion (`eval "$a"`, `sh -c "$a"`) now counts as an expansion in the whole-command reading; before it was dropped with the quoted text. It is refused only when the whole command also holds the step's program and subcommand words.
- Still a documented false refusal: `a=x; echo $a agentopology scaffold` and the earlier ones in the CHANGELOG.
