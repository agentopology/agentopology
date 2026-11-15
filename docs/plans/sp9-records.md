# SP-9 (records half): records in `guard --check`, and the hook reads the heads

Spec B (records) in the SP plan. The compose half of SP-9 (each line names its
lane file, the stale line, tests A8 and A9) waits for SP-4 and is not here.

## 1. `guard --check` prints records (src/records/report.ts)

One block per declared record, under the gate and step lines. No single grade:
one line per way in.

| Line | Generated guard (`written-by`, no `guard:`) | Cited guard (`guard: [..]`) | No `written-by` |
|---|---|---|---|
| tools | `refuse, by hook (generated)`: before-edit.sh wired on the file-writing tools and holding the record's line | `refuse, by hook (cited)`: the cited PreToolUse hooks in settings.json | `none`: anyone may write this record |
| shell | `detect`: before-action.sh wired on Bash and holding `record_guard` for it | `detect`: a cited PreToolUse hook that matches Bash is in settings.json | `none` |
| later | `detect, by code` (record check), only with `append-only: true` | same | same |
| other | `none`, followed by the fixed bypass line | same | same |

- A tools refuse carries "unverified": no conformance fact proves the hook on the installed version.
- B9: the cited PreToolUse matchers miss a file-writing tool of the conformance facts: a warning naming it.
- A missing generated piece, or a cited hook absent from settings.json, grades `none` and counts as missing (exit 1).
- A cited set with no hook on Bash grades shell `none`, as a warning: the file chose that, nothing is missing.
- Lines on a record name no lane file (that is the compose half).
- Codex: `guard --check --target codex` gets the same block for the generated guards, graded `unverified` like every Codex guard.

## 2. The generated hook refuses a rewritten append-only ledger

Measured today: before-action.sh's `check_ledger` reads only the last line for the step.
A ledger whose earlier line was edited (its last line still ok) passes the hook; only
`step check` refuses it. Fix: for a gate ledger with `append-only: true`, the hook first runs
`check_head`, the same check as `checkRecordHead` (src/records/head.ts), in bash:

- head path `.agentopology/records/<id>.head`, or `<id>/<unit>.head` when a unit is read (as step check);
- no head: write one (complete lines, sha256 of them); allow;
- fewer complete lines than the head, or the file gone with lines seen: truncated, exit 2;
- the first N lines hash differently: rewritten, exit 2;
- a head that is not the JSON step check writes: exit 2;
- grown: move the head forward (temp file, then mv; never through a symlink); allow.
- No sha256 tool (`sha256sum`, `shasum -a 256`): exit 2.

The head file the hook writes is byte-identical to the one step check writes.

## 3. Head files on the shell path

Measured today: before-edit.sh refuses a tool write to `.agentopology/records/`, but nothing
refuses `echo x > .agentopology/records/approvals.head` or `rm` of it from the shell; removing a
head makes the next check a first run, which accepts a rewritten ledger. Fix: before-action.sh
treats the head folder as a record no shell command writes (`record_guard` on
`.agentopology/records/*`, no programs). Both guards protect the heads whenever the topology has
an append-only record, not only when a record is generated-guarded. Grade: detect, as the shell path.
Spec B piece 3 says "head files are protected by guard 1"; it now reads guards 1 and 2.

## Tests (red first)

- B8: fixture `src/__tests__/e2e/fixtures/records/hand-built/` (4 records, 2 cited hooks wired in
  `.claude/settings.json`, stub writers): `guard --check` prints 4 records, tools cited refuse,
  shell detect, the bypass line; exit 0.
- B9: the b9 fixture through `guard --check`: a warning naming NotebookEdit.
- Execution: scaffold, plant ledgers (intact, appended ok, rewritten, truncated, deleted, bad head,
  no head), run before-action.sh with bash on the gated command: exit 2 or 0 as above; head bytes
  equal step check's. Shell writes to a head: exit 2; `cat` of a head: exit 0.
