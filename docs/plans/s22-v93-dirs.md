# S-22: V93 counts a folder write as a handoff

**Premise (measured).** A writer with `writes: ["x/{LANG}/"]` and a reader with
`reads: ["x/{LANG}/file.md"]` on one edge: `validate` warns V93 and `plan` lists
`handoff-overlap-empty`, though the reader reads a file inside the writer's folder.
Both compare paths as exact strings.

**Change.** One helper, `writeCovers(write, read)` in `src/parser/paths.ts`, used by
V93 (`src/parser/validator.ts`) and the brief's handoffs (`src/plan/brief.ts`).
A write crosses the edge when it covers at least one read. No new V-number.

**Rules** (compared segment by segment, split on `/`):
1. Equal strings cover (today's rule, unchanged).
2. A write ending in `/` is a folder: it covers every read under it, at any depth,
   and the same folder.
3. A write without a trailing `/` is a file: it covers only a read with the same
   segments. The grammar does not say an extension-less path is a folder, so `out`
   does not cover `out/a.md`; write `out/` for that.
4. `{NAME}` is a placeholder (as `{unit}` in a ledger path): it stands for one
   segment value, so it matches any one segment on either side. A placeholder
   inside a segment (`report-{unit}.md`) matches the same text with any value in
   its place. A placeholder never matches across a `/`.
5. `*` and `**` have no meaning in `path-list` (grammar §2 types it as a string);
   they are literal characters. No glob matching.
6. A read folder does not make a write under it count (`reads: [out/]`,
   `writes: [out/a.md]` still warns). Not in this ticket.

**Done.** Fixture above: no V93, no `handoff-overlap-empty`. A read outside the
folder still fires both. Every rule above has a test in each of validate and plan.

## S-34: a folder read is satisfied by a write under it (reading A)

**Change.** Rule 6 is reversed. A read ending in `/` is a folder, and any write
under it covers it (`reads: [out/]`, `writes: [out/report.md]` is a handoff).
Same helper, `writeCovers`, so V93 and plan agree. No new V-number.
**Rules.** Rules 2 to 5 mirrored for the read: the folder needs a trailing `/`;
`{NAME}` matches one segment; no globs; `out/` does not cover `outside/a.md`.
**Risk.** This proves a handoff exists, not that the whole folder is handed over.
**Done.** The example both ways; `out/` + `outside/a.md` still fires both;
`x/{LANG}/` + `x/en/f.md` is covered; S-22 cases pass; examples' output unchanged.

## S-33: an empty side is not declared; V93 and plan both skip the edge

**Premise (measured).** `examples/company-brain-team.at`, edge `librarian -> auditor`:
neither agent declares `reads` or `writes`. `validate` gives no V93; `plan` flags
`handoff-overlap-empty`. Same for `memory-system.at` and `simple-pipeline.at`.
**Rule.** spec/validation.md (V93) scopes the rule: "An edge between two agents that
both declare paths should declare a handoff", and "`plan` reports the same rule as
`handoff-overlap-empty`". The grammar defaults `reads`/`writes` to `[]`. So an empty
`writer.writes` or `reader.reads` means not declared: nothing to check, both skip.
**Change.** One predicate, `handoffMissing(writes, reads)` in `src/parser/paths.ts`,
called by V93 and by plan's pre-flag. Plan still lists the edge under handoffs.
**Done.** Reader with no reads, writer with no writes, both empty: neither fires.
The company-brain-team edge: neither fires. A non-empty, non-covering pair fires both.
