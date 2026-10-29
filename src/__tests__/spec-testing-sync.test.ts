/**
 * spec/testing.md and the tests cannot drift apart.
 *
 * Every guarantee id in the spec must name at least one test, and every id a
 * test claims must be in the spec, as a guarantee or as an open finding. Same
 * idea as spec-sync.test.ts for validation rules: drift is a missing test, not
 * a discipline problem.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const spec = readFileSync(resolve(root, "spec/testing.md"), "utf8");

const section = (title: string) => {
  const start = spec.indexOf(title);
  const next = spec.indexOf("\n## ", start + title.length);
  return spec.slice(start, next === -1 ? undefined : next);
};
const idsIn = (md: string) => [...md.matchAll(/^\| ([A-Z]+\d+) \|/gm)].map((m) => m[1]);

const guarantees = idsIn(section("## Guarantees"));
const open = idsIn(section("## Open findings"));

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : testFiles(p);
    return e.name.endsWith(".test.ts") ? [p] : [];
  });
}
const sources = testFiles(resolve(root, "src")).map((f) => readFileSync(f, "utf8"));
const realTags = new Set(sources.flatMap((s) =>
  [...s.matchAll(/\b(?:it|it\.each\([^)]*\)|describe(?:\.skipIf\([^)]*\))?)\(\s*["'`]\[([A-Z]+\d+)\]/g)].map((m) => m[1]),
));
const todoTags = new Set(sources.flatMap((s) => [...s.matchAll(/it\.todo\(\s*["'`]\[([A-Z]+\d+)\]/g)].map((m) => m[1])));

describe("spec/testing.md tracks the tests", () => {
  it("lists guarantees and open findings", () => {
    expect(guarantees.length).toBeGreaterThan(0);
    expect(open.length).toBeGreaterThan(0);
  });

  it("every guarantee has a real test carrying its id", () => {
    const missing = guarantees.filter((id) => !realTags.has(id));
    expect(missing, `guarantees with no test: ${missing.join(", ")}`).toEqual([]);
  });

  it("every open finding is a visible todo", () => {
    const missing = open.filter((id) => !todoTags.has(id));
    expect(missing, `open findings with no it.todo: ${missing.join(", ")}`).toEqual([]);
  });

  it("no test claims an id the spec does not list", () => {
    const known = new Set([...guarantees, ...open]);
    const unknown = [...realTags, ...todoTags].filter((id) => !known.has(id));
    expect(unknown, `ids not in spec/testing.md: ${unknown.join(", ")}`).toEqual([]);
  });

  it("a fixed finding is not still listed as open", () => {
    const both = open.filter((id) => realTags.has(id));
    expect(both, `real tests exist for open ids (move them to Guarantees): ${both.join(", ")}`).toEqual([]);
  });
});
