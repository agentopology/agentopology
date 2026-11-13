/**
 * Date windows written `"YYYY-MM-DD..YYYY-MM-DD"` (a person's `away:`, a
 * human's `valid:`), and today's date.
 *
 * @module
 */

export interface DateWindow { start: string; end: string }

const WINDOW = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/;

function realDate(s: string): boolean {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Read a window; null when it is malformed, not a real date, or ends before it starts. */
export function parseWindow(text: string | undefined): DateWindow | null {
  const m = text?.trim().match(WINDOW);
  if (!m || !realDate(m[1]) || !realDate(m[2]) || m[1] > m[2]) return null;
  return { start: m[1], end: m[2] };
}

/** Today as YYYY-MM-DD. `AT_TODAY` overrides it, so a run can be reproduced. */
export function today(): string {
  const fixed = process.env.AT_TODAY;
  if (fixed && realDate(fixed)) return fixed;
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
