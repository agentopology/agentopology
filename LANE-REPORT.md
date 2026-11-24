# Lane report 0.13.2 r5

Branch fix/0.13.2-r3 (fast-forward from f22d589). Final head: d20e537.

## Red lines (rows added on f22d589, run before the fix: 49 failed of 1244 in step-gate-versioned-names)
Refuse expected, exit 0 seen, on every fixture (scaffold), and the validate twins on the two-gate fixture:
- `alias a='npx -y agentopology@1'\na scaffold probe.at`
- `alias a='npx -y agentopology@1'; a scaffold probe.at`
- `echo agento | xargs -I% %pology scaffold probe.at`
- `echo agento | xargs -IX Xpology scaffold probe.at`
- `echo agento | xargs --replace=Q Qpology scaffold probe.at`
- `a=agento; exec -a x ${a}pology scaffold probe.at`
- `a=agento; env -u X ${a}pology scaffold probe.at`
- `a=agento; timeout -s KILL 5 ${a}pology scaffold probe.at`
- `a=agento; sudo -u root ${a}pology scaffold probe.at`
- validate twins of the alias `;` form, the `-I%` form and the `exec -a` form
New documented false refusals (refuse expected, pass seen): `ls $DIR; echo scaffold`, `echo scaffold | xargs echo`.
Must-pass rows (already passing, kept): `git commit -m "agentopology scaffold fix" && echo $HOME`, `grep -rl 'agentopology scaffold' . | xargs wc -l`, `echo $HOME; git log --grep "agentopology scaffold"`, `echo 'agentopology scaffold' | xargs echo`.

## Commits
- b52924d: rows for the subcommand rule (red).
- d20e537: fix in guards.ts: at_expand_cmd reads the command with all quoted text left out (AT_UQ) and sets AT_RB when it holds an unquoted expansion, an alias definition, xargs, eval or a shell given -c; at_rule checks the step's subcommand word as a bare word; the whole-command gate reads at_whole OR at_rule (an addition, nothing removed). CHANGELOG 0.13.2: the rule in plain words, the new false refusals and what to do, residuals list kept with the separate-OS-user sentence.

## Golden entries changed
None. guards-golden passes unchanged; guards-golden.json not touched.

## Frozen proof
STDIN_JQ_FUNCTIONS (guards.ts line 722) and STDIN_JQ_CHECK (line 750) lie before the first changed hunk (line 853) of `git diff v0.13.1 HEAD -- src/bindings/lib/guards.ts`, so they are byte-identical to v0.13.1. `git diff v0.13.1 HEAD -- src/bindings/lib/guards.ts | grep -c at_stdin_` = 0. No old assertion and no frozen differential row moved (all pass).

## Gates
- tsc --noEmit: clean
- step-gate-versioned-names: 1244 passed
- guard-*, go-entry, human-go-word, the three differentials, as0112-blocks, surface-map, spec-sync, readme-sync, guards-golden, spec-testing-sync: 16 files, 697 passed, 3 todo, 0 failed
- speed file alone: 8 passed, 1 failed (the known no-timeout-on-PATH row); before-action.sh shapes between 70 and 153 ms (slowest listed: here-string, 153 ms, in the output seen)
- npm run build clean; dist grep for 'S-2', 'HV-', 'AT-1': 0 files

## Full suite (`timeout 1800 npx vitest run`)
8375 passed, 2 failed, 24 skipped, 22 todo (8423). Test files: 238 passed, 2 failed, 3 skipped.
Failures, both known on v0.13.1 in this container:
- import-project [I5] (runs as root)
- action-guard-speed, "the same with no timeout program on PATH (stock macOS)" (PATH rm shim)

## Notes
- The rule is a union with every earlier reading; the round-3 quoted-subcommand rows keep refusing through the whole-command reading.
- Dependencies were installed with `npm ci` in this clone before the first test run.
