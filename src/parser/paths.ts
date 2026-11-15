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

/**
 * Does a `writes:` path hand the downstream agent a `reads:` path (S-22)?
 *
 * The one rule behind V93 (validate) and `handoff-overlap-empty` (plan):
 * - equal paths cover;
 * - a write ending in `/` is a folder and covers every read under it, and itself;
 * - a write without a trailing `/` is a file: same segments only (`out` is not a folder);
 * - `{NAME}` matches one segment on either side, never across a `/`;
 * - `*` and `**` are literal: the grammar gives paths no glob syntax.
 *
 * @param write - One entry of the upstream agent's `writes:`
 * @param read - One entry of the downstream agent's `reads:`
 */
export function writeCovers(write: string, read: string): boolean {
  if (write === read) return true;
  const folder = write.endsWith("/");
  const w = (folder ? write.slice(0, -1) : write).split("/");
  const readFolder = read.endsWith("/");
  const r = (readFolder ? read.slice(0, -1) : read).split("/");
  if (folder) {
    // Under the folder: more segments, or the folder itself.
    if (r.length < w.length || (r.length === w.length && !readFolder)) return false;
  } else if (r.length !== w.length || readFolder) {
    return false;
  }
  return w.every((seg, i) => segmentsMatch(seg, r[i]));
}
