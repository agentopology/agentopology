/**
 * A second copy of a single section (two `gates { }` blocks, two
 * `orchestrator { }` blocks) is a V23 warning: only the first copy is used.
 * Its nodes are not in the parse because the parser reads the first copy,
 * not because a brace is out of place, so V131 must stay quiet about them and
 * the result must be the V23 warning alone (exit 0 on the CLI).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../index.js";
import { validate } from "../validator.js";
import { findLostStructure } from "../lost-structure.js";

const here = dirname(fileURLToPath(import.meta.url));
const twoGates = readFileSync(resolve(here, "fixtures/duplicate-gates.at"), "utf8");

const strip = (rs: ReturnType<typeof validate>) => rs.map((r) => ({ rule: r.rule, level: r.level, message: r.message }));

describe("a duplicate section's nodes are not lost structure", () => {
  it("two gates { } blocks: the V23 warning alone, worded as in 0.12.0", () => {
    expect(strip(validate(parse(twoGates)))).toEqual([
      {
        rule: "V23",
        level: "warning",
        message: 'Duplicate "gates" block detected (found 2) — only the first occurrence is used',
      },
    ]);
  });

  it("two gates { } blocks: the first block's gate is a node, the second's is not", () => {
    const ids = parse(twoGates).nodes.map((n) => n.id);
    expect(ids).toContain("g1");
    expect(ids).not.toContain("g2");
  });

  it("three gates { } blocks: still only V23", () => {
    const third = "  gates {\n    gate g3 {\n      after: alpha\n      run: \"scripts/check3.sh\"\n    }\n  }\n}\n";
    const src = twoGates.replace(/\}\n$/, third);
    const rules = validate(parse(src)).map((r) => r.rule);
    expect(rules).toEqual(["V23"]);
  });

  it("two orchestrator { } blocks: the V23 warning alone", () => {
    const src = twoGates.replace(
      "  agent alpha {",
      "  orchestrator {\n    model: sonnet\n  }\n  orchestrator {\n    model: opus\n  }\n  agent alpha {",
    );
    const rs = validate(parse(src));
    expect(rs.filter((r) => r.rule === "V131")).toEqual([]);
    expect(rs.filter((r) => r.rule === "V23").map((r) => r.message)).toEqual([
      'Duplicate "orchestrator" block detected (found 2) — only the first occurrence is used',
      'Duplicate "gates" block detected (found 2) — only the first occurrence is used',
    ]);
  });

  it("a node missing while every brace balances is never blamed on a brace", () => {
    // No source found yet makes the parser drop a node with balanced braces;
    // this hands the check a parse without "beta" to pin what it would say.
    const found = findLostStructure(twoGates, "topology", new Set(["alpha", "g1"]));
    expect(found.map((f) => f.node)).toEqual(["beta"]);
    expect(found[0].message).not.toMatch(/brace/);
  });

  it("a stray brace in the second gates block is still lost structure", () => {
    const src = twoGates.replace('run: "scripts/check2.sh"', 'run: "scripts/check2.sh }"');
    const v131 = validate(parse(src)).filter((r) => r.rule === "V131");
    expect(v131.length).toBeGreaterThan(0);
    expect(v131[0].message).toContain("quoted string on line 33");
  });
});
