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
