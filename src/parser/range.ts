/**
 * A small version-range check for `meta { requires }`: one or more
 * comparators separated by blanks, all of which must hold. A comparator is
 * `>=`, `<=`, `>`, `<`, `=` or `^` followed by `x.y.z`. No dependency.
 */

type Op = ">=" | "<=" | ">" | "<" | "=" | "^";
type Version = [number, number, number];
interface Comparator { op: Op; version: Version }

const COMPARATOR = /^(>=|<=|>|<|=|\^)?(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;

/** The comparators of a range, or null when it is not a valid range. A bare `x.y.z` means `=`. */
export function parseRange(range: string): Comparator[] | null {
  const words = range.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  const out: Comparator[] = [];
  for (const w of words) {
    const m = COMPARATOR.exec(w);
    if (!m) return null;
    out.push({ op: (m[1] as Op | undefined) ?? "=", version: [Number(m[2]), Number(m[3]), Number(m[4])] });
  }
  return out;
}

function cmp(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

/** The first version `^v` does not allow: the next major, or the next minor (or patch) while the leading parts are 0. */
function caretCeiling(v: Version): Version {
  if (v[0] > 0) return [v[0] + 1, 0, 0];
  if (v[1] > 0) return [0, v[1] + 1, 0];
  return [0, 0, v[2] + 1];
}

/** Whether `version` (`x.y.z`, a pre-release suffix is ignored) satisfies every comparator of `range`. False for an invalid range or version. */
export function satisfiesRange(version: string, range: string): boolean {
  const comparators = parseRange(range);
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!comparators || !m) return false;
  const v: Version = [Number(m[1]), Number(m[2]), Number(m[3])];
  return comparators.every(({ op, version: want }) => {
    const c = cmp(v, want);
    switch (op) {
      case ">=": return c >= 0;
      case "<=": return c <= 0;
      case ">": return c > 0;
      case "<": return c < 0;
      case "=": return c === 0;
      case "^": return c >= 0 && cmp(v, caretCeiling(want)) < 0;
    }
  });
}
