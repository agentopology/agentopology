/**
 * A named exception to merge-differential-0112, refuse-stub-regenerated
 * (approved for 0.13.0). A hook declared `strength: refuse` whose script is
 * not written yet now gets a stub that blocks its call (exit 2, or a deny
 * decision on PermissionRequest) where 0.11.2's stub exited 1 and let the call
 * through. So when an edit adds `strength: refuse` to such a hook, the next
 * scaffold regenerates its stub: it prints one `~ <path> (script regenerated)`
 * line per stub, and its counts line moves that many files from unchanged to
 * updated. Nothing else may differ: the exit code and settings.json are still
 * compared byte for byte by the caller, and every other output line must be
 * 0.11.2's. Each regenerated path must also be listed in that scaffold's stub
 * summary, so only a stub qualifies, never a written script.
 */

const REGENERATED = /^  ~ (\S+) \(script regenerated\)$/;
const COUNTS = /^(\s+)(\d+) created, (\d+) updated, (\d+) unchanged, (\d+) conflicts$/;

/**
 * True when `now` (ruled output) differs from `was` (0.11.2's, ruled) only by
 * regenerated stub lines and the counts they move; `rawNow` is the unruled
 * output, whose stub summary must list every regenerated path.
 */
export function refuseStubRegenerated(was: string, now: string, rawNow: string): boolean {
  const lines = now.split("\n");
  const paths = lines.map((l) => REGENERATED.exec(l)?.[1]).filter((p): p is string => p !== undefined);
  if (paths.length === 0) return false;
  const stubs = new Set(rawNow.split("\n").map((l) => /^\s+· (\S+)$/.exec(l)?.[1]).filter(Boolean));
  if (!paths.every((p) => stubs.has(p))) return false;
  const n = paths.length;
  const back = lines
    .filter((l) => !REGENERATED.test(l))
    .map((l) => {
      const m = COUNTS.exec(l);
      if (!m) return l;
      return `${m[1]}${m[2]} created, ${Number(m[3]) - n} updated, ${Number(m[4]) + n} unchanged, ${m[5]} conflicts`;
    });
  return back.join("\n") === was;
}
