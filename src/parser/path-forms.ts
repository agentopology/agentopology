/**
 * The path forms `never-reads`, `secrets`, `ask-reads` and `boundary` accept, and how each is written
 * as a Claude Code permission rule.
 *
 * Source: https://code.claude.com/docs/en/permissions ("Read and Edit": rules use gitignore pattern
 * syntax with four pattern types):
 *
 * | written in .at   | meaning                            | written in a Read/Edit rule                          |
 * | ---------------- | ---------------------------------- | ---------------------------------------------------- |
 * | `~/x`            | under the home folder              | `~/x`                                                |
 * | `//x`            | absolute, from the filesystem root | `//x`                                                |
 * | `x`, `./x`, `/x` | under the project root (as before) | `/x`; a bare name with no `/` stays `x` (any depth)  |
 *
 * A single leading `/` is NOT an absolute path in a rule ("anchors at the settings source"), so in .at
 * it keeps its old meaning, the project root. `//x` is the absolute form.
 *
 * @module
 */

export type PathAnchor = "home" | "abs" | "project";

export interface PathForm {
  anchor: PathAnchor;
  /** The path below its anchor, without `./`, with no leading `/`. */
  rest: string;
}

/** Splits a path as written in the .at source into its anchor and the rest. */
export function pathForm(written: string): PathForm {
  const p = written.trim();
  if (p.startsWith("~/")) return { anchor: "home", rest: p.slice(2).replace(/^\/+/, "") };
  if (p.startsWith("//")) return { anchor: "abs", rest: p.replace(/^\/+/, "") };
  return { anchor: "project", rest: p.replace(/^\.\//, "").replace(/^\/+/, "") };
}

/** A path the way two entries are compared: same anchor, same rest. */
export function samePathKey(written: string): string {
  const f = pathForm(written);
  return `${f.anchor}:${f.rest}`;
}

/** The path as the argument of a Claude Code `Read(...)` or `Edit(...)` permission rule. */
export function permissionRulePath(written: string): string {
  const f = pathForm(written);
  if (f.anchor === "home") return `~/${f.rest}`;
  if (f.anchor === "abs") return `//${f.rest}`;
  // A name with no slash (`.env`) or one that starts with `**/` matches at any depth, as in gitignore.
  if (!f.rest.replace(/\/+$/, "").includes("/") || f.rest.startsWith("**/")) return f.rest;
  return `/${f.rest}`;
}
