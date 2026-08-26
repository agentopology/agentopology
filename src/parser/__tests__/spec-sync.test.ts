/**
 * The spec must not drift from the implementation.
 *
 * `spec/validation.md` documented 35 rules while `validator.ts` implemented 89.
 * Fifty-four rules existed only in source. Nobody noticed because nothing
 * compared them — which is the actual bug. Documentation drift is not a
 * discipline problem, it is a missing test.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

/** Rule numbers the validator actually registers, from its `validate()` spread. */
function implementedRules(): number[] {
  const src = read("src/parser/validator.ts");
  const body = src.slice(src.indexOf("export function validate("));
  const fns = [...body.matchAll(/\.\.\.(v(\d+)[A-Za-z0-9_]*)\(ast\)/g)];
  return [...new Set(fns.map((m) => Number(m[2])))].sort((a, b) => a - b);
}

/** Rule numbers documented in the spec's summary table. */
function documentedRules(): number[] {
  const md = read("spec/validation.md");
  const rows = [...md.matchAll(/^\|\s*V(\d+)\s*\|/gm)];
  return [...new Set(rows.map((m) => Number(m[1])))].sort((a, b) => a - b);
}

describe("spec/validation.md tracks the validator", () => {
  it("documents every implemented rule", () => {
    const impl = implementedRules();
    const docs = documentedRules();
    const undocumented = impl.filter((n) => !docs.includes(n));
    expect(
      undocumented,
      `implemented but undocumented: ${undocumented.map((n) => "V" + n).join(", ")}`
    ).toEqual([]);
  });

  it("documents no rule the validator does not implement", () => {
    const impl = implementedRules();
    const docs = documentedRules();
    const phantom = docs.filter((n) => !impl.includes(n));
    expect(
      phantom,
      `documented but not implemented: ${phantom.map((n) => "V" + n).join(", ")}`
    ).toEqual([]);
  });

  it("numbers rules contiguously from V1", () => {
    const impl = implementedRules();
    const gaps: number[] = [];
    for (let i = 1; i <= Math.max(...impl); i++) if (!impl.includes(i)) gaps.push(i);
    expect(gaps, `gaps in rule numbering: ${gaps.join(", ")}`).toEqual([]);
  });

  it("states the same rule count in prose as it lists in the table", () => {
    const md = read("spec/validation.md");
    const docs = documentedRules();
    // The prose above the table names the count; a stale number is exactly the
    // drift this file exists to catch.
    const claimed = [...md.matchAll(/All (\d+) rules/g)].map((m) => Number(m[1]));
    expect(claimed.length, "spec should state its rule count").toBeGreaterThan(0);
    for (const n of claimed) expect(n).toBe(docs.length);
  });
});
