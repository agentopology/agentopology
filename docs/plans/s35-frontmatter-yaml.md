# S-35: import reads frontmatter values that span lines

## Problem
`parseFrontmatter` (`src/import/claude-code.ts`) reads agent, skill and command
frontmatter one trimmed line at a time. A value written over several lines comes
out truncated or empty, and the closing fence is the first `---` anywhere, so a
value that contains `---` ends the frontmatter early.

## Rule (YAML 1.2)
- Closing fence: the first line that is exactly `---` (trailing spaces allowed).
- Block scalars (8.1, "Block Scalar Styles"): `key: |` keeps line breaks
  ("Literal Style", 8.1.2); `key: >` joins lines with a space and keeps a blank
  line as a paragraph break ("Folded Style", 8.1.3). Clip (default) keeps one
  final newline, strip `-` keeps none ("Block Chomping Indicator", 8.1.1.2).
  Keep `+` keeps trailing newlines; an indentation digit is read. The .at file
  holds one line per field, so the serializer writes a line break as a space.
- Plain multi-line scalars (7.3.3, "Plain Style"; 6.5 "Line Folding"): more-indented
  lines after `key: value` continue the value, joined with a space.
- Quoted scalars over several lines (7.3.1 "Double-Quoted Style", 7.3.2
  "Single-Quoted Style"): line breaks fold to a space, a blank line to a newline.

Out of scope: nested maps, flow collections, anchors, double-quote escapes.

Proof: unit tests per shape (red first); every currently-correct parse is identical; the
12 public pilots parse the same before and after for every file without these shapes.
