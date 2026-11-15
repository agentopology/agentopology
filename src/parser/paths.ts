/**
 * Which project-relative paths are safe to write or to name as a node's file.
 *
 * Shared by scaffold (every generated path) and the validator (every `file:`),
 * so a path the language accepts is a path scaffold can honour.
 *
 * @module
 */

/** One path segment a binding may produce. Junk like `E;`, `fail:`, `x)` fails. */
const SAFE_SEGMENT = /^[A-Za-z0-9_.@+-]+$/;

/**
 * Why a generated relative path is unsafe to write, or null when it is fine.
 *
 * @param relPath - Path relative to the project root, as a binding emits it
 */
export function unsafePathReason(relPath: string): string | null {
  if (relPath.trim() === "") return "empty path";
  if (relPath.endsWith("/")) return "ends in '/' (no file name)";
  if (relPath.startsWith("/")) return "absolute path";
  const segments = relPath.split("/");
  for (const seg of segments) {
    if (seg === "") return "empty path segment";
    if (seg === "..") return "climbs out of the project ('..')";
    if (!SAFE_SEGMENT.test(seg)) return `unsafe name "${seg}"`;
  }
  return null;
}


/** A `{NAME}` placeholder, as `{unit}` in a ledger path. */
const PLACEHOLDER = /\{[A-Za-z_][A-Za-z0-9_-]*\}/g;

/** A regex for one segment: literal text, each placeholder one or more non-`/` chars. */
function segmentPattern(seg: string): RegExp {
  const parts = seg.split(PLACEHOLDER).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${parts.join("[^/]+")}$`);
}

/** Two segments can name the same thing: equal, or one's placeholders fill to the other. */
function segmentsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const hasA = a.search(PLACEHOLDER) >= 0;
  const hasB = b.search(PLACEHOLDER) >= 0;
  return (hasA && segmentPattern(a).test(b)) || (hasB && segmentPattern(b).test(a));
}

/** Segments of a path, and whether it names a folder (a trailing `/`). */
function split(path: string): { segs: string[]; folder: boolean } {
  const folder = path.endsWith("/");
  return { segs: (folder ? path.slice(0, -1) : path).split("/"), folder };
}

/** Is `inner` the folder `outer` itself, or under it at any depth? `outer` ends in `/`. */
function underFolder(outer: string, inner: string): boolean {
  const o = split(outer).segs;
  const i = split(inner);
  if (i.segs.length < o.length || (i.segs.length === o.length && !i.folder)) return false;
  return o.every((seg, k) => segmentsMatch(seg, i.segs[k]));
}

/**
 * Does a `writes:` path hand the downstream agent a `reads:` path (S-22, S-34)?
 *
 * The one rule behind V93 (validate) and `handoff-overlap-empty` (plan):
 * - equal paths cover;
 * - a write ending in `/` is a folder and covers every read under it, and itself;
 * - a read ending in `/` is a folder and is satisfied by any write under it (S-34):
 *   this proves a handoff exists, not that the whole folder is handed over;
 * - a path without a trailing `/` is a file: same segments only (`out` is not a folder);
 * - `{NAME}` matches one segment on either side, never across a `/`;
 * - `*` and `**` are literal: the grammar gives paths no glob syntax.
 *
 * @param write - One entry of the upstream agent's `writes:`
 * @param read - One entry of the downstream agent's `reads:`
 */
export function writeCovers(write: string, read: string): boolean {
  if (write === read) return true;
  const w = split(write);
  const r = split(read);
  if (w.folder && underFolder(write, read)) return true;
  if (r.folder && underFolder(read, write)) return true;
  if (w.folder || r.folder || w.segs.length !== r.segs.length) return false;
  return w.segs.every((seg, i) => segmentsMatch(seg, r.segs[i]));
}

/**
 * Does an edge from a writer to a reader lack a declared handoff (S-33)?
 *
 * The one verdict behind V93 (validate) and `handoff-overlap-empty` (plan).
 * An empty `writes` or `reads` is not declared (spec/validation.md V93: "both
 * declare paths"), so there is nothing to check: false. Otherwise true when no
 * write covers any read (`writeCovers`).
 */
export function handoffMissing(writes: readonly string[], reads: readonly string[]): boolean {
  if (writes.length === 0 || reads.length === 0) return false;
  return !writes.some((w) => reads.some((r) => writeCovers(w, r)));
}
