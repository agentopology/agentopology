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

