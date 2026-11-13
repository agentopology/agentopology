# Build spec: compose, records and the signed human gate (SP-1 to SP-13, T-05)

Three features with one build plan:

- **A. Compose.** A master file made of lane files, resolved into one topology that every command reads.
- **B. Records.** Files that only named programs may write, with generated guards and an append-only check.
- **C. The signed human gate.** A human step whose yes is bound to file hashes, recorded by an instrument, optionally signed, and graded on two lines.

## Base rules for every build lane

- **Base branch:** `origin/integrate/sp`. The orchestrator creates it from the latest integration branch. Every lane branches from it, or from the commit of another lane named in "Lanes" below.
- **Test names** start with the ticket id and, when there is one, the planted test id, in brackets. Example: `it("[SP-2][A3] include merges the fragment's agent into the master", ...)`.
- **Red first.** Each planted test is written and seen red on the base before the code that turns it green.
- **The specs are agreed. Build them as written.** The decisions in A.3, B.3 and C.3 are settled; do not reopen them in a lane. If a lane finds a spec line that cannot be built, it stops that ticket and reports the line, it does not pick a new design.
- `npx vitest run` and `npx tsc --noEmit` pass before every push.
- Fixtures named below are new public files under `src/__tests__/e2e/fixtures/`. Each holds only made-up content.

---

# Spec A: Compose (a master file made of lane files)

## A.2 Spec

### The problem

A real project is more than one file. One file says how a piece of work is made. Another says who runs what and where the person who approves stops it. Today a file can import another, and the import is checked: the file must exist, its hash must match a declared pin, and its own errors are reported. That is all. The importing file cannot point at a node inside the imported one, so the two graphs never join. Scaffold, export and the visualizer see only the importing file. A shared fragment named by `include` is never merged. Two files can declare the same id and nothing warns. The result is two maps of one project, joined by a comment.

Measured on 0.10.1 with planted files: `manager -> making.writer` gives `V3 Flow references undeclared node "making.writer"`; an edge to an included fragment's agent gives V3; a master and a lane that both declare `writer` pass validation (while `src/docs/content.ts` says imported names must be globally unique); `scaffold --dry-run` of the master writes 4 files, none from the lane; the JSON export of the master holds 0 lane nodes; the Claude Code binding only prints the import as a line of text in a rules file.

### The syntax (no new block, one new top-level field)

```at
import making from "./making.at" sha256 "9c1f...e07a"

topology release-ops : [human-gate, event-driven, pipeline] {
  pin-imports: true

  agent ops-manager {
    runs: session
    place: ops
    decides: [publish-approval]
  }
  agent video-lane {
    runs: session
    place: video
  }

  flow {
    talk: hub ops-manager
    make-ticket -> video-lane                 [message: ticket]
    video-lane -> making.main                 # the lane runs the making file
    making.approve -> ops-manager             [message: report]
    making.mark-published -> daily-report
  }

  gates {
    gate report-needs-publish {
      after: making.mark-published
      before: daily-report
    }
  }
}
```

| Piece | Meaning |
|---|---|
| `import <alias> from "<path>" [sha256 "<hex>"]` | Unchanged spelling. The file is a **lane file**. The importing file is the **master**. |
| `<alias>.<node-id>` | A node of the lane, usable in the master's `flow`, in a gate's `after:` and `before:`, in `[guard: ...]` and in `decides:`. Only the master uses the alias. |
| `include "<path>"` | A `fragment` file. Its nodes, hooks and records join the master with no alias. |
| `pin-imports: true` | Top level, next to `pin-models`. Every local import must carry a `sha256`. |
| `agentopology pin FILE.at` | New command. Writes or refreshes the `sha256` on every local import line. No hash is typed by hand. |

A lane file stays a whole file. It validates, scaffolds and draws alone, exactly as today. It does not know it is imported.

### What "resolved" means

Before any command runs, a resolver builds one resolved topology: the master's own content, every included fragment, and every imported lane (and the lanes those import). Every command reads the resolved topology.

| Command | On a master file |
|---|---|
| `validate` | Runs every rule on the resolved graph. A finding inside a lane names the lane file. |
| `scaffold`, `guard` | Write one tree for the whole resolved project, with one manifest. |
| `guard --check` | Grades every gate, human step and guard, the lane's too. Each line names its file. |
| `export`, `visualize` | Hold every node. Each imported node carries `from: "<lane path>"`. |
| `validate --inventory` | One coverage number for the union. The per-file numbers print under it. |

### Validation rules

| Rule | Level |
|---|---|
| `alias.node` must name a node that exists in that lane | error, names the lane file |
| An id must be unique across the resolved set. Generated files keep the lane's own ids (no prefix), so a clash would overwrite a file | error, names both files |
| An included fragment's ids clash with the master's | error, names both files |
| Import cycle, missing file, wrong pin, an error inside the lane | error (V8, as today) |
| An import path that leaves the project root | error: "outside the project, not composed" |
| `pin-imports: true` and an import with no `sha256` | error |
| No `pin-imports` and an import with no `sha256` | no finding. `validate` prints one line: "imports: 1, pinned: 0" |
| The lane declares `interface { entry exit }` and the master points at another node | warning: "reaches past the lane's interface" |
| `with { }` overrides, `use`, and registry imports | parsed, not resolved. `validate` prints "not resolved yet" for each. No silent pass |

### What the Claude Code binding generates

Nothing new in kind. It generates what it generates today, from the resolved topology.

- One `.claude/` tree. Agent files, skills, hook scripts and guards of every lane, under each node's own id.
- A cross-file gate (`after: making.mark-published`) compiles like any gate.
- A talk guard built from the resolved flow, so an edge between a master session and a lane node is known to it.
- The manifest records each lane file's sha256 at generation time.

### The honest grade

Compose enforces nothing. It is a way to write. So it gets no strength of its own, and the tool says three plain things.

| Line | When |
|---|---|
| `imports: 2, pinned: 2, all match` | every pin equals the file's bytes |
| `imports: 2, pinned: 0` | no pin: the lane can change and the master will not notice |
| `stale: making.at changed since these guards were generated` | `guard --check` compares the manifest's hash with the file. Exit 1. This is **detect, by code**. Nothing stops a session from running old guards |

A pin proves the bytes of a file at validate time. It does not prove who changed the file or that the change was reviewed.

### Planted tests (each is red on 0.10.1, then green)

Fixtures live under `src/__tests__/e2e/fixtures/compose/`: a master file, a lane file `making.at` (agents `main`, `writer`, a human step `approve`, an action `mark-published`), a fragment file with one agent, and the planted variants each test needs.

| # | Planted case | Red today | Green |
|---|---|---|---|
| A1 | Master flow edge `manager -> making.writer` | V3 undeclared node | passes |
| A2 | Master and lane both declare `writer` | passes | error naming both files |
| A3 | `include` a fragment, edge to its agent | V3 | passes |
| A4 | `scaffold --dry-run` on the master | 4 files, none from the lane | lists the lane's agent file too |
| A5 | `export --format json` on the master | 0 lane nodes | lane nodes present, each with `from` |
| A6 | `pin-imports: true`, import with no hash | passes | error. Then `agentopology pin` writes the hash and it passes |
| A7 | After the pin, change one byte in the lane file | V8 mismatch (already green, kept as a regression) | same |
| A8 | Run `guard`, then change the lane file | no finding | `guard --check` prints the stale line, exit 1 |
| A9 | A gate with `after: making.approve` on the master | V-error on the anchor | `guard --check` grades it and names the lane |
| A10 | Import path `../other-repo/x.at` | resolves or passes | error "outside the project" |
| A11 | The lane file validated alone, before and after the change | n/a | byte-identical output (regression) |
| A12 | The end-to-end fixture `src/__tests__/e2e/fixtures/compose/full/`: a master file with 2 lane files, both imports pinned with `sha256`, 1 `include` of a fragment, and two cross-file flow edges (one into each lane) | V3 | 0 errors, and `validate --inventory` prints one union number with two per-file numbers under it |

## A.3 Decisions (settled)

| # | Decision |
|---|---|
| A-Q1 | The proof is a master file with its first lane file, both real full files, not a thin wrapper: the A12 fixture. No lane file is split first. |
| A-Q2 | A master may reach any node of a lane by `alias.node`. A warning is printed only when the lane declares an `interface` and the master goes past it. |
| A-Q3 | The pin is optional. A missing pin is an error only under `pin-imports: true`. The `pin` command writes it. The hash stays on the import line (no separate lock file). |
| A-Q4 | Files in another repo are out of 0.11. A path that leaves the project is an error that says so. Other repos are later work (T-16). |
| Defaults | One tree and one manifest per master. Generated files keep the lane's ids with no prefix. `with`, `use` and registry imports stay parsed and print "not resolved yet". |

---

# Spec B: Records (files only scripts may write)

## B.2 Spec

### The problem

A project rests on a few files that are evidence: the approvals of the person who approves, the trail of steps, the list of refusals, the log of what the person typed. A gate reads such a file and opens or stays shut. If an agent can edit the file, the gate proves nothing. Today the language can name a record and its path, and a gate can read it. It cannot say who may write it, or that it only grows. Projects that care build the protection by hand and describe it in a comment. The tool then grades the gate "refuse" while the file under it is open.

Measured on 0.10.1: a `record` takes one field, `path` (may hold `{unit}`); a gate names it with `ledger:`, and `step check` and the generated Bash guard read it. `written-by` and `append-only` are reserved and refused: `V102 record "approvals" has written-by:, which is not a record field`.

### The syntax

```at
records {
  record approvals {
    path: "records/approvals.jsonl"
    written-by: ["scripts/approve.py"]
    append-only: true
    guard: [protect-records, protect-bash]   # hand-built guards, cited (optional)
  }
  record trace {
    path: "work/{unit}/trace.jsonl"
    written-by: ["scripts/trace.py", "maker"]
    append-only: true
  }
  record refusals {
    path: "records/refusals.jsonl"
    written-by: ["scripts/approve.py"]
    append-only: true
  }
  record inputs {
    path: "records/inputs.jsonl"
    written-by: ["hooks/input-capture.sh"]
    append-only: true
  }
}
```

| Field | Meaning |
|---|---|
| `path` | As today. Project-relative. `{unit}` stands for one path segment. |
| `written-by` | The programs allowed to write this file. Project-relative paths. Everything else is refused or reported. |
| `append-only` | The file only grows. A changed or removed earlier line is a finding. |
| `guard` | Ids of declared hooks that already protect this record in a hand-built project. The tool checks them instead of generating its own. Same word as `[guard: ...]` on a flow edge. |
| `description` | Free text. |

Two words, two things. A **store** is memory that agents read and write. A **record** is a file that only named programs write. The tool itself never writes a record. The one exception is the log of a guard the tool generated (the talk log), which is a record whose `written-by` is that guard.

### Validation rules

| Rule | Level |
|---|---|
| A `written-by` program that is not on disk | error (the "missing" class) |
| A record with no `written-by` | warning: "anyone may write this record" |
| A gate's `ledger:` or a human step's `record:` that names no declared record | error (V112, extended) |
| A record id equal to a store id | warning: "declared as a store agents write and as a record only programs write" |
| A `guard:` id that is not a declared hook | error |
| A cited guard hook whose matcher misses a file-writing tool known for the checked platform version | warning that names the tool |
| A `path` that is absolute, leaves the project, or has an unsafe `{unit}` | error (as today) |
| `append-only: true` on a record no gate or human step reads | no finding |

### What the Claude Code binding generates

| # | Piece | Works on |
|---|---|---|
| 1 | `record-guard.sh`, a PreToolUse hook on every file-writing tool (the list comes from the conformance facts for the checked version, never a list typed in the binding). It normalises the target path, matches it against every record path, and exits 2. Empty or broken input exits 2 | direct tool writes |
| 2 | A Bash check: a command that names a record path after a write shape, and does not run a `written-by` program, exits 2 | plain shell writes |
| 3 | `agentopology record check FILE.at [id] [--unit U]`. It keeps a small head file per record (line count and the sha256 of those lines) under `.agentopology/records/`. If the first N lines no longer hash the same, exit 1. Else it moves the head forward. Head files are protected by guard 1 | rewrites and truncation |
| 4 | `step check` and the generated step guard run check 3 before they read a ledger. A damaged ledger never opens a gate | every gate that reads a record |
| 5 | With `guard:` cited, pieces 1 and 2 are not generated. `guard --check` verifies the cited hooks exist, are wired in settings, and match | hand-built projects |

Whether the installed Claude Code still has a `MultiEdit` tool is not checked. That is why the file-writing tool list comes from the conformance facts and is never typed in the binding.

### The honest grade

One record gets one line per way in. No single grade is printed, because the ways in differ.

| Way into the record | Grade | Printed note |
|---|---|---|
| A file-writing tool | **refuse, by hook** | "unverified" until the conformance suite proves the hook on the installed version |
| A shell command that names the path | **detect** | "a pattern on the command text" |
| A shell command that builds the path at run time, an interpreter one-liner, a script an agent wrote | **none** | printed as the bypass line under every record |
| A process outside Claude Code (a scheduler, a terminal) | **none** | same bypass line |
| A rewrite found later by `record check` | **detect, by code** | "found at the next check, not stopped" |

The bypass line is fixed text: "a program running as the same OS user can still write this file; only a signature or another OS user closes that". The tool never prints "protected".

### Planted tests (red on 0.10.1, then green)

Fixtures live under `src/__tests__/e2e/fixtures/records/`.

| # | Planted case | Red today | Green |
|---|---|---|---|
| B1 | A record with `written-by` and `append-only` | 2 V102 errors | parses; both fields in the JSON export |
| B2 | `written-by: ["nope.py"]`, file absent | V102 | error "missing" naming the record |
| B3 | A record with no `written-by` | passes silently | one warning |
| B4 | Planted tool JSON on stdin: Edit on `records/approvals.jsonl` → exit 2. Edit on `README.md` → 0. Write on `work/abc/trace.jsonl` (the `{unit}` form) → 2. The path written as `./records/../records/approvals.jsonl` → 2. Empty stdin → 2 | no guard exists | all 5 as stated |
| B5 | The 8 shell shapes on a record: `>`, `>>`, `tee`, `tee -a`, `sed -i`, `cp` onto, `mv` onto, `truncate`. Then 3 that must pass: the `written-by` program, `cat` of the record, a heredoc that only mentions the path | no guard exists | 8 refused, 3 allowed |
| B6 | The honesty test: an interpreter one-liner that builds the path from two strings passes the guard, and `guard --check` prints the bypass line under that record | no line | the line is present; the test fails if it is ever removed |
| B7 | `record check`: after one appended line → 0. After one earlier line edited → 1. After truncation → 1. `step check` on a gate that reads that ledger → 1 in both bad cases | no command | as stated |
| B8 | The end-to-end fixture `src/__tests__/e2e/fixtures/records/hand-built/`: a topology with the 4 records above (approvals, trace, refusals, inputs), each with `written-by`, `append-only: true` and `guard: [protect-records, protect-bash]`; two declared hooks, `protect-records` (PreToolUse on the file-writing tools) and `protect-bash` (PreToolUse on Bash), wired in a fixture `.claude/settings.json`; the `written-by` programs present as stub files | V102 | `guard --check` prints 4 records, tools "refuse by hook (cited)", shell "detect", plus the bypass line |
| B9 | A cited hook whose matcher lacks one file-writing tool from the conformance facts | no finding | a warning that names the tool |

## B.3 Decisions (settled)

| # | Decision |
|---|---|
| B-Q1 | The tool never writes a record. It reads and guards. Only the log of a guard it generated is written, by that guard. |
| B-Q2 | A record that names no writer gets a warning: "anyone may write this record". |
| B-Q3 | Two words: a store is what agents write, a record is what only programs write. |
| B-Q4 | The first declared set, for the proof, is the four records above: approvals, trace, refusals, inputs (the B8 fixture). |
| Defaults | The shell path is graded detect, never refuse. Head files live in the repo, so git history is the outside witness. The list of file-writing tools comes from the conformance facts. |

---

# Spec C: The signed human gate

## C.2 Spec

### The problem

Some steps wait for a person's yes, and what follows cannot be undone: a post goes out, a release ships. Three questions decide what that yes is worth. What refuses when the yes is missing? What exactly did the yes cover, and is it still the same thing? Who was able to create the yes? Today the language answers none of them. A human step has a description and a timeout. The tool grades it by one rule: if an agent follows, the session will ask; if not, it is prose. A hand-built lock that binds a yes to file hashes and refuses on every path is graded "hope". And a yes that an agent typed from memory looks the same as one the person gave.

Measured: on the base a `human` node takes `file`, `description`, `timeout`, `on-timeout`, `who` and `valid`. `answered-by`, `covers`, `record` and `signed` are V102 errors. `guard --check` grades a human by one rule (an agent follows it → "refuse by hook", else "hope by prose"). The generated step guard reads a ledger with bash and jq and cannot verify a signature.

### The syntax

```at
human approve {
  description: "One yes per unit covers the whole package on every channel."
  who: owner
  answered-by: instrument
  instrument: "scripts/approve.py"
  record: approvals
  covers: ["work/kits/{unit}/*", "!work/kits/{unit}/kit.json", "!work/kits/{unit}/KIT.md"]
  signed: ed25519
  key: "keys/approve.pub"
  timeout: 1d
  on-timeout: halt
}

records {
  record approvals {
    path: "records/approvals.jsonl"
    written-by: ["scripts/approve.py"]
    append-only: true
  }
}

gates {
  gate lock-publish {
    after: approve
    before: publish
    strength: refuse
    by: code
    at: "scripts/publish.py"
    match: "require_yes(files, caption"
  }
}
```

| Field on `human` | Values | Meaning |
|---|---|---|
| `answered-by` | `relay` · `session` · `instrument` | Who creates the record of the answer. `relay`: an agent passes on what the person said. `session`: the person answers the platform's own prompt. `instrument`: a named program outside the agent's tools records it. |
| `instrument` | a project-relative path | The program that records the answer. Required with `answered-by: instrument`. |
| `record` | a record id | Where the answer is kept. One row per answer. |
| `covers` | a list of globs, `{unit}` allowed, `!` excludes | The files this yes is about. The yes holds only while exactly these files exist with these bytes. |
| `signed` | `ed25519` | The row carries a signature that the public key verifies. |
| `key` | a project-relative path | The **public** key. The private key is never in the project. |
| `strength`, `by`, `at`, `match`, `bypass` | as on a gate | For a hand-built lock: where the code that refuses is. (This part is ticket T-05.) |

A human step with none of the new fields behaves as today.

### The row (one JSON line in the record)

```json
{"shape":"at-yes-v1","step":"approve","unit":"U300","ok":true,"at":"2026-12-22T14:26:00Z",
 "by":"owner","files":[{"path":"work/kits/U300/U300-v1.mp4","sha256":"..."}],
 "key":"3fa9c0d1","sig":"<base64>"}
```

The signature is over the row's canonical bytes without `sig` (keys sorted, no spaces). `key` is the first 8 hex characters of the public key's sha256. `ok` keeps the row readable by today's ledger check. Files are hashed by bytes, with sha256. Equality by pixels or by normalised text is not in this version.

### What the check does

`agentopology step check FILE.at <step> --unit U`, and every generated guard on a gate that stands after the human step, hold only when all of these are true. Each failure prints one reason and exits 1 (the hook exits 2).

| # | Condition | Reason printed |
|---|---|---|
| 1 | The record holds a row for this step and unit. The latest one counts | "no yes on record" |
| 2 | `signed`: the signature verifies with the declared public key | "the yes is not signed by the declared key" |
| 3 | `covers`: the files under the globs now are exactly the files in the row | "added after the yes: X" · "missing: X" |
| 4 | `covers`: every file has the sha256 in the row | "changed after the yes: X" |
| 5 | `valid` (when declared): today is inside the window | "the yes is not valid for this date" |
| 6 | The record passes its append-only check | "the record was rewritten" |

Left to hand-built locks, cited and not generated: matching an image by pixels, matching a caption by normalised text, checks on where the person's words came from, and any rule that a preview must exist before a yes is recorded.

### Validation rules

| Rule | Level |
|---|---|
| `answered-by: instrument` with no `instrument`, or an instrument file not on disk | error |
| `record:` names no declared record | error |
| The instrument is not in the record's `written-by` | error |
| `signed` with no `key`, or a key file not on disk | error |
| The `key` file holds a private key | error: "a private key is in the project" |
| `covers` with no `record` | error: nothing can hold the hashes |
| A `covers` glob that leaves the project | error |
| `answered-by: relay`, or no `answered-by`, on a human step that is the last stop before an `action` with `kind: external` | warning: "a relayed yes opens a step that cannot be undone" |
| An agent with `decides:` and an incoming talk edge, where the decision's human step is not `answered-by: instrument` | warning (exists since 0.10.1; now it names the fix) |

### What the Claude Code binding generates

| # | Piece |
|---|---|
| 1 | For `answered-by: session`: today's ask before the next agent launches. Unchanged. |
| 2 | For `instrument` with `covers` or `signed`: `verify-yes.mjs`, one small script with no dependencies, written next to the other generated hooks. The step guard calls it. It runs the 6 conditions. If the runtime is missing, the guard blocks. |
| 3 | The record guards of Spec B on the human step's record, and on the public key file. |
| 4 | Nothing that signs. The binding never holds a private key and never creates a yes. |

That an ed25519 check fits the hook's time limit on a loaded machine is inferred from the platform's built-in crypto, not measured. SP-11 measures it.

### The honest grade: two lines per human step

`guard --check` prints two grades, because they are two facts.

**Line 1, holds: what refuses when the yes is missing or stale.**

| Case | Grade |
|---|---|
| Gates after the step compile to guards, or cite code that refuses (`strength: refuse`, `by`, `at`, `match` verified) | refuse, by hook or by code |
| The step is followed only by prose | hope |

**Line 2, answer: who can create the yes.**

| `answered-by` | Grade | Note printed |
|---|---|---|
| not declared, or `relay` | **hope** | "an agent can write the yes" |
| `session` | **refuse, in an interactive session** | "in a headless run nobody can answer, so it is denied" |
| `instrument`, not signed | **detect** | the record's own grade: tools refused, shell detected, same-user code not seen |
| `instrument`, `signed: ed25519` | **refuse, by code** | bypass: "whoever holds the private key. The tool cannot see where that key is kept" |

Any "refuse" reads "unverified" on a platform version the conformance suite has not proven. The second line never prints above "detect" without a signature, however strong the first line is.

### Planted tests (red on 0.10.1, then green)

Fixtures live under `src/__tests__/e2e/fixtures/human/`. Test keys are an ed25519 key pair generated inside the test at run time; no private key file is committed.

| # | Planted case | Red today | Green |
|---|---|---|---|
| C1 | A human with `answered-by`, `instrument`, `record`, `covers`, `signed`, `key` | one V102 error per new field (4 measured on the fields planted) | parses; all fields in the JSON export |
| C2 | Seven bad declarations, one each: no instrument; instrument not in `written-by`; unknown record; `signed` with no key; a private key in the key file; `covers` with no record; a glob leaving the project | V102 only | 7 distinct errors |
| C3 | A valid signed row and untouched files | no check exists | `step check` exits 0 |
| C4 | Then, one at a time: change one byte in a covered file; add a file under the glob; delete a covered file; strip `sig`; sign with another key; a row for another unit only; a valid old row followed by a newer bad row; one non-JSON line in the record | no check exists | exit 1 each, 8 distinct reasons |
| C5 | The forgery test, three roads to a fake row. (a) Planted tool JSON: Write on the record. (b) Planted shell: `echo ... >>` the record. (c) The row placed in the file directly, as same-user code would | no guard, no check | (a) exit 2. (b) exit 2. (c) the guards do not see it, and `step check` still exits 1: no valid signature. With `signed` removed from the file, (c) exits 0 and `guard --check` line 2 reads "detect" |
| C6 | `guard --check` on four planted humans: relay, session, instrument unsigned, instrument signed | one grade each, "hope" or "refuse" | two lines each, as the table above |
| C7 | A relay human as the last stop before a `kind: external` action | no finding | one warning |
| C8 | A fake platform version on PATH | n/a for humans | every "refuse" on both lines carries "unverified" |
| C9 | The end-to-end fixture `src/__tests__/e2e/fixtures/human/hand-built-lock/`: a human step `approve` with `answered-by: instrument`, `instrument`, `record`, `covers`, and no `signed`; the instrument as a stub script listed in the record's `written-by`; 5 gates after `approve`, each with `strength: refuse`, `by: code`, `at:` one of 5 stub publish scripts and `match:` a refusing call present in that script. A baseline of the 5 gate lines is captured before `approve` gains the new fields | `approve hope by: prose` | line 1 "refuse, by code" with the lock cited; line 2 "detect"; the 5 gate lines equal the baseline |

## C.3 Decisions (settled)

| # | Decision |
|---|---|
| C-Q1 | Two grade lines per human step. On a hand-built lock whose yes row is unsigned this prints holds **refuse**, answer **detect**, until the row is signed. A done-when that says a human step is "graded refuse" means line 1. |
| C-Q2 | The signature is a public key only (ed25519). The private key stays off every machine an agent runs on. No shared-secret (HMAC) and no OS-keychain option in this version. |
| C-Q3 | AgenTopology ships the checker and the row format, not the thing that signs. The signing instrument belongs to the project's owner. |
| C-Q4 | A relayed yes before a step that cannot be undone is a warning, never an error. Declaring the truth is never punished with an error. |
| Defaults | Hashes are sha256 over bytes. The latest row wins. The verifier is a generated script with no dependencies. Pixel and text equality stay in hand-built locks. |

---

# Tickets

Sizes are builder-days for one cloud lane driving a red planted test first, then green. Two tickets that share a file never run at once; the edge says which is the base. T-05 is listed for its edges and its done-when; it is built in lane S3.

| id | title | size | files it touches | blocked by | blocks | done when (planted, red then green) |
|---|---|---|---|---|---|---|
| SP-1 | Grammar base for the three specs. Parse and keep: record `written-by`, `append-only`, `guard`, `description`; human `answered-by`, `instrument`, `record`, `covers`, `signed`, `key`; top-level `pin-imports`; `alias.node` as a legal name in flow and gate anchors. Three empty rule modules with their call sites. One row each in the visualizer rules table | 1.5 | `src/parser/known-fields.ts`, `src/parser/ast.ts`, `src/parser/index.ts`, `src/parser/validator.ts` (3 call sites), `src/compose/index.ts` (new), `src/records/index.ts` (new), `src/human/index.ts` (new), `src/visualizer` rules table, `spec/grammar.md` | none (the specs are agreed) | SP-2, SP-6, SP-7, SP-8, SP-10, T-05 | Tests B1 and C1: the 6 V102 errors measured today become 0, and every new field is in the JSON export |
| SP-2 | The resolver: one resolved topology from master, includes and lanes; `alias.node` lookup; unique ids; the outside-project error; "not resolved yet" lines | 2.5 | `src/compose/resolve.ts` (new), `src/parser/imports.ts`, `src/compose/index.ts`, `src/cli/index.ts` (load path) | SP-1 | SP-3, SP-4, VZ-12, T-16 | Tests A1, A2, A3, A10, A11 |
| SP-3 | Pins: `pin-imports`, the `pin` command, the "imports: n, pinned: k" line | 1 | `src/compose/pin.ts` (new), `src/cli/index.ts` (one command), `src/docs/content.ts` (composition topic) | SP-2 | SP-5, SP-8 (same file `src/cli/index.ts`) | Tests A6, A7 |
| SP-4 | Every writing and drawing command reads the resolved topology: scaffold, guard, export, visualize data, union coverage; the manifest keeps lane hashes. (The `guard --check` lines for compose are in SP-9, so that one file has one editor at a time) | 2 | `src/bindings/claude-code.ts`, `src/guard/target.ts`, `src/exporters/*`, `src/scaffold/*` (manifest), `src/inventory/*` | SP-2; SP-7 (same file `src/bindings/claude-code.ts`, SP-7 is the base); T-08 (already on the base) | SP-5, SP-9, VZ-12 | Tests A4, A5 |
| SP-5 | Compose end to end and docs: the A12 fixture; the composition docs rewritten so every sentence has a test; CHANGELOG | 1 | `src/__tests__/e2e/*` (compose fixtures), `src/docs/content.ts`, `README.md`, `CHANGELOG.md`, `spec/` | SP-3, SP-4 | SP-13 | Test A12, and the spec-sync test fails if the docs claim an unchecked rule |
| SP-6 | Record rules in validate | 1 | `src/records/validate.ts` (new), `src/records/index.ts` | SP-1 | SP-9, T-14 | Tests B2, B3, B9, and the store/record same-id warning |
| SP-7 | Generated record guards (tool path and shell path), fail closed, with the file-writing tool list in the conformance facts | 2 | `src/records/guard.ts` (new), `src/bindings/claude-code.ts` (one call; SP-4 is the later editor), `src/conformance/claude-code.ts`, `src/conformance/extract.ts` | SP-1 | T-05, SP-4 (same file), SP-9, T-14 | Tests B4, B5, B6 |
| SP-8 | Append-only: `record check`, head files, and `step check` refusing a rewritten ledger | 1.5 | `src/records/head.ts` (new), `src/step/check.ts`, `src/cli/index.ts` (one command; after SP-3) | SP-1; SP-3 (same file `src/cli/index.ts`, SP-3 is the base) | T-05 (same file `src/step/check.ts`), SP-9 | Test B7 |
| SP-9 | Records and compose in `guard --check`: one line per way into a record, the bypass line, cited hand-built guards; each line names its lane file; the stale line; records end to end on the B8 fixture; docs | 2 | `src/guard/check.ts`, `src/records/report.ts` (new), `src/docs/content.ts`, `CHANGELOG.md` | SP-6, SP-7, SP-8, SP-4, T-05 (same file `src/guard/check.ts`, T-05 is the base) | SP-12, SP-13, VZ-7 (record chips) | Tests B8, B9, A8, A9 |
| SP-10 | Human-gate rules in validate | 1 | `src/human/validate.ts` (new), `src/human/index.ts` | SP-1 | T-05, SP-11 | Tests C2, C7 |
| T-05 | The release key as a first-class thing: `strength`, `by`, `at`, `match`, `bypass` on a human; the `covers` hash check and the `at-yes-v1` row in `step check`; line 1 of the human grade on a hand-built lock | 3 | `src/step/check.ts`, `src/human/covers.ts` (new), `src/guard/check.ts`, `src/guard/citations` | SP-1, SP-7, SP-10, SP-8 (base for `src/step/check.ts`) | SP-11, SP-9 (same file `src/guard/check.ts`) | See "T-05's own done-when" below |
| SP-11 | The signature: canonical row bytes, ed25519 verify in `step check`, the generated `verify-yes.mjs`, the key rules | 2 | `src/human/verify.ts` (new), `src/step/check.ts`, `src/bindings/claude-code.ts` | T-05; SP-4 (same file `src/bindings/claude-code.ts`, SP-4 is the base) | SP-12 | The last 5 cases of C4; road (c) of C5 |
| SP-12 | Two grades per human in `guard --check`, bypass notes, conformance, the forgery test end to end on the C9 fixture; docs topic "human gates"; CHANGELOG | 1.5 | `src/guard/check.ts`, `src/human/report.ts` (new), `src/__tests__/e2e/*` (human fixtures), `src/docs/content.ts`, `CHANGELOG.md` | SP-11, SP-9 | SP-13, VZ-7 (the pen badge), VZ-8 | Tests C5 (all three roads), C6, C8, C9 |
| SP-13 | The gate for the three: one attack review of the new guards and tests, its P0 and P1 findings fixed, the full suite in the cloud, all three end-to-end fixture runs (A12, B8, C9) | 1.5 | whatever the attack finds; `src/__tests__/open-findings.test.ts` for what stays open | SP-5, SP-9, SP-12 | the 0.11 release | Every A, B and C test is green in one cloud run; each attack finding has a planted test that was red first |

**Count: 13 SP tickets, 20.5 builder-days.** With T-05's 3 days the path is 23.5. The critical path is SP-1, SP-7, T-05, SP-11, SP-12, SP-13: 11.5 builder-days.

### T-05's own done-when, on public fixtures

All four hold on the fixture `src/__tests__/e2e/fixtures/human/release-key/`: a human step `approve` with `strength: refuse`, `by: code`, `at:` a stub lock script and `match:` a refusing call present in that script, `answered-by: instrument`, `instrument:` a stub script, `record: approvals`, and `covers:` a glob over a `work/kits/{unit}/` folder holding 3 small files; the `approvals` record with the instrument in its `written-by`.

1. **[T-05]** A `human` node takes `strength`, `by`, `at`, `answered-by: instrument` and `covers: [paths]`: the fixture validates with 0 errors and every field is in the JSON export.
2. **[T-05]** `guard --check` on the fixture grades `approve` line 1 "refuse, by code" with the cited lock script and match named. (Line 2 reads "detect": the row is unsigned. The signed case is SP-11.)
3. **[T-05][C3][C4]** With a valid row for the unit, `step check` exits 0. Changing one byte of one covered file after the yes makes `step check` exit 1 ("changed after the yes"). Adding a file under the glob exits 1 ("added after the yes"). Deleting a covered file exits 1 ("missing").
4. **[T-05][C5]** Road (a): a yes row written from an agent tool call (planted tool JSON, Write on `records/approvals.jsonl`) is refused, exit 2.

### Edges into the rest of the plan

| From | To | Kind | Why |
|---|---|---|---|
| SP-1, SP-7, SP-10 | T-05 | hard | T-05 needs the fields, the rule that the instrument is the record's writer, and the guard that refuses a tool-written row |
| SP-8 | T-05 | file | same file: `src/step/check.ts`. SP-8 is the base |
| T-05 | SP-9, then SP-12 | file | same file: `src/guard/check.ts`. One editor at a time, in that order |
| T-08 (coverage) | SP-4 | file | both edit `src/inventory`. **T-08 is already built on the base**; SP-4 gives the union through a master on top of it |
| T-09 (`who`, `valid` on a human) | T-05, SP-11 | soft | condition 5 of the check reads `valid`. **Already built on the base** |
| T-10 (`owner:` on a store) | SP-6 | soft | the store/record same-id warning builds on it. **Already built on the base** |
| T-04 (talk log) | SP-6 | soft | the talk log becomes a record whose writer is the generated guard. **Already built on the base** |
| SP-9, SP-12 | VZ-7 guards lens | soft | VZ-7 can ship first; the record chip and the two human grades are rows added after |
| SP-4 | VZ-12 compose drill-in (0.12) | hard | the drill-in draws the resolved topology |
| SP-6, SP-7 | T-14 request record (0.12) | hard | a request record is a record with a writer |
| SP-2 | T-16 other repos (later) | hard | the outside-project error is where T-16 starts |
| SP-7, SP-11 | the Codex binding | soft | the record guards and the verifier are Claude Code pieces; the Codex binding must port them or grade them "none" |

---

# Lanes

Four build lanes, each a sequence. A lane pushes after each ticket, so the next lane can start from that commit.

| Lane | Starts | Sequence | Days |
|---|---|---|---|
| **S1** compose | on `origin/integrate/sp` | SP-1, SP-2, SP-3, SP-4, SP-5 | 8 |
| **S2** records | after SP-1 is pushed, on S1's SP-1 commit | SP-6, SP-7, SP-8 | 4.5 |
| **S3** human gate | after S2's SP-8 is pushed, on that commit | SP-10, T-05, SP-11 | 6 |
| **S4** reports and the gate | after S1, S2 and S3 are pushed, on a merge of the three | SP-9, SP-12, SP-13 | 5 |

The requested split holds. Most file edges fall inside one lane or between lanes that already run in order (S2 then S3 for `src/step/check.ts`; S3 then S4 for `src/guard/check.ts`; S1 then S4 for `src/docs/content.ts` and `CHANGELOG.md`). Two files cross the parallel lanes, and the source's edges fix their order, so the lanes add three sync points instead of a different split:

1. **`src/cli/index.ts` (SP-3 base, SP-8 later).** S2 builds SP-8 last. Before it edits `src/cli/index.ts`, it rebases onto S1's pushed SP-3 commit (waiting for it if needed). SP-8's other files do not wait.
2. **`src/bindings/claude-code.ts` (SP-7 base, SP-4 later).** S1 starts SP-4 only after S2's SP-7 is pushed, and rebases onto it first. On the expected timing SP-7 lands before S1 reaches SP-4, so this rarely waits.
3. **`src/bindings/claude-code.ts` (SP-4 base, SP-11 later).** S3 rebases onto S1's pushed SP-4 commit before it edits `src/bindings/claude-code.ts` in SP-11.

### Files owned

**S1 (compose):**
- SP-1: `src/parser/known-fields.ts`, `src/parser/ast.ts`, `src/parser/index.ts`, `src/parser/validator.ts`, `src/compose/index.ts`, the stubs `src/records/index.ts` and `src/human/index.ts`, the `src/visualizer` rules table, `spec/grammar.md`
- SP-2 to SP-5: `src/compose/resolve.ts`, `src/compose/pin.ts`, `src/parser/imports.ts`, `src/guard/target.ts`, `src/exporters/*`, `src/scaffold/*`, `src/inventory/*`, `src/__tests__/e2e/fixtures/compose/`, `README.md`, `spec/`
- Shared, in order: `src/cli/index.ts` (load path, `pin` command; base for SP-8), `src/bindings/claude-code.ts` (SP-4; after SP-7, base for SP-11), `src/docs/content.ts` and `CHANGELOG.md` (compose entries; S4 edits after)

**S2 (records):**
- `src/records/validate.ts`, `src/records/guard.ts`, `src/records/head.ts`, `src/records/index.ts` (after SP-1), `src/conformance/claude-code.ts`, `src/conformance/extract.ts`, `src/__tests__/e2e/fixtures/records/` (B1 to B7, B9 cases)
- Shared, in order: `src/step/check.ts` (SP-8; base for T-05), `src/bindings/claude-code.ts` (one call in SP-7; base for SP-4), `src/cli/index.ts` (the `record check` command; after SP-3)

**S3 (human gate):**
- `src/human/validate.ts`, `src/human/index.ts` (after SP-1), `src/human/covers.ts`, `src/human/verify.ts`, `src/guard/citations`, `src/__tests__/e2e/fixtures/human/release-key/` and the C2 to C4, C7 cases
- Shared, in order: `src/step/check.ts` (T-05, then SP-11; after SP-8), `src/guard/check.ts` (T-05; base for SP-9), `src/bindings/claude-code.ts` (`verify-yes.mjs` in SP-11; after SP-4)

**S4 (reports and the gate):**
- `src/records/report.ts`, `src/human/report.ts`, `src/__tests__/e2e/fixtures/records/hand-built/` (B8), `src/__tests__/e2e/fixtures/human/hand-built-lock/` (C9), `src/__tests__/open-findings.test.ts`
- Shared, in order: `src/guard/check.ts` (SP-9, then SP-12; after T-05), `src/docs/content.ts` and `CHANGELOG.md` (records and human topics; after SP-5), any file the SP-13 attack review names
