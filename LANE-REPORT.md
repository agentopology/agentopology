# Lane report: watchdog (0.13.1)

## Cause (measured in this container, GNU coreutils 9.4, PID 1 = `process_api`)

The hook is correct. The check IS dead at the deadline. The TEST's probe was wrong.

- `timeout -s KILL N <check>` kills the check, then sends KILL to its whole process group. The group
  includes `timeout` itself, and KILL cannot be ignored, so `timeout` dies too.
- Nobody is left to reap the check. It becomes a zombie child of PID 1. A container's PID 1 does not
  reap it promptly, or at all. A zombie still answers `kill -0`, so the old probe called it "running".
- Evidence (8 of 8 runs): `timeout -s KILL 1 bash -c 'trap "" TERM; echo $$; sleep 31.5'`, then
  `kill -0 pid` -> alive, and `ps -o pid,ppid,stat,comm -p pid` -> `ppid 1, stat Z`. The zombies were
  still there 2 s later. Run directly, `timeout` reports `Killed` (rc 137): it was killed by its own group KILL.
- Why it is flaky: the test fails or passes by whether init reaps in time (1 fail, 1 pass in two
  runs of the unchanged test). On a WSL2 desktop init reaps at once.
- Not the cause: TERM-only signalling (the hook already sends KILL to the group), a missing `-k`,
  subshell or pipeline pid mismatch (the pid file holds the check's own `$$`).

Not a security hole: no member of the check's tree keeps running after the hook returns. The generated
hook is unchanged; macOS needs nothing new (no `setsid` used; the POSIX path walks the tree with pgrep as before).

## Commits (branch `fix/0.13.1-watchdog`, from aec197c)

- `f85243a` The probe reads the process state (`ps -o stat=`) and counts a zombie as dead. A new row per
  mode (POSIX watchdog, GNU timeout): a check that ignores TERM and starts a grandchild sleep; both pids
  must be not running when the hook returns. CHANGELOG entry under `## [0.13.1] - unreleased`.

## Red then green

- Red: the existing row (`-t "GNU timeout"`) failed 1 of 2 runs here with
  "check <pid> still running after the hook returned". My new rows cannot be red against the hook,
  because the hook is right. They use the corrected probe, so they pass at once.
- Green: `-t F9d`, 3 runs: 4/4 passed each time (2 old rows, 2 new rows).

## Gates

- tsc: clean.
- cx-review-fixes: pass. Golden (guards-golden), the three differentials, as0112-blocks and spec-sync:
  all pass in the full suite. No golden or pin was edited, and no frozen differential moved.
- Deadline/hook tests: all in the full suite; the only deadline-related failure is listed below.

## Full suite (`timeout 1800 npx vitest run`)

2 failed | 6536 passed | 24 skipped | 22 todo (216 of 218 files passed). Both failures also fail on origin/rc/0.13.0 in this container (2 of 2 runs):

1. `action-guard-speed.test.ts` > "the same with no timeout program on PATH (stock macOS)": expected stderr
   to contain "its check took over 4 s, so the step …". It is about the POSIX no-`timeout` path and is
   NOT fixed here. I did not diagnose it. It deserves a look: it may be the same zombie, or a real gap in the fallback.
2. `import-project.test.ts` [I5]: "Not read: .claude/agents/locked.md" is expected, but nothing is
   unreadable because this container runs as root (chmod 000 does not stop root). An environment issue.

## Stopped on

Nothing. One slip: I ran an empty `python3` heredoc once. It wrote nothing and ran no script.
