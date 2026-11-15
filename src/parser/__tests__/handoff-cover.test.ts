/**
 * S-22: a folder write is a handoff. One rule, `writeCovers`, decides it for
 * both V93 (validate) and `handoff-overlap-empty` (plan), so they cannot disagree.
 * S-34: a folder read is satisfied by a write under it (rule 6).
 * S-33: an empty side is not declared, so neither V93 nor plan fires.
 * Rules: docs/plans/s22-v93-dirs.md and spec/validation.md (V93).
 */
import { describe, it, expect } from "vitest";
import * as paths from "../paths.js";
import { parse } from "../index.js";
import { validate } from "../validator.js";
import { buildExecutionBrief } from "../../plan/brief.js";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** `undefined` omits the field; `[]` writes it out empty. */
function topo(writes: string[] | undefined, reads: string[] | undefined): string {
  const list = (xs: string[]) => `[${xs.map((x) => JSON.stringify(x)).join(", ")}]`;
  const field = (k: string, xs: string[] | undefined) => (xs === undefined ? [] : [`    ${k}: ${list(xs)}`]);
  return [
    "topology t : [pipeline] {",
    "  meta {",
    '    version: "1.0.0"',
    '    description: "x"',
    "  }",
    "  agent w {",
    "    model: sonnet",
    '    description: "w"',
    ...field("writes", writes),
    "  }",
    "  agent r {",
    "    model: sonnet",
    '    description: "r"',
    ...field("reads", reads),
    "  }",
    "  action i {",
    "    kind: inline",
    '    description: "in"',
    "  }",
    "  flow { i -> w",
    "         w -> r }",
    "}",
  ].join("\n");
}

/** Both verdicts for one edge: does validate warn V93, does plan flag it. */
function verdicts(writes: string[] | undefined, reads: string[] | undefined) {
  const ast = parse(topo(writes, reads));
  const v93 = validate(ast).filter((x) => x.rule === "V93").length > 0;
  const plan = buildExecutionBrief(ast).preflagged.some((p) => p.kind === "handoff-overlap-empty");
  return { v93, plan };
}

const CASES: Array<[rule: string, write: string, read: string, covers: boolean]> = [
  ["1 equal strings", "out/a.md", "out/a.md", true],
  ["1 different files", "out/a.md", "out/b.md", false],
  ["2 folder covers a file under it", "out/", "out/a.md", true],
  ["2 folder covers any depth", "out/", "out/en/a.md", true],
  ["2 folder covers itself", "out/", "out/", true],
  ["2 a read outside the folder", "out/", "other/a.md", false],
  ["2 a sibling with the folder's name as prefix", "out/", "outside/a.md", false],
  ["3 no trailing slash is a file, not a folder", "out", "out/a.md", false],
  ["4 the original false V93", "x/{LANG}/", "x/{LANG}/file.md", true],
  ["4 write placeholder, literal read", "x/{LANG}/", "x/en/file.md", true],
  ["4 literal write, read placeholder", "x/en/", "x/{LANG}/file.md", true],
  ["4 placeholder, other prefix", "x/{LANG}/", "y/en/file.md", false],
  ["4 a placeholder is one segment, not zero", "x/{LANG}/", "x/file.md", false],
  ["4 a placeholder never spans a slash", "{unit}", "a/b", false],
  ["4 placeholder inside a segment", "out/report-{unit}.md", "out/report-42.md", true],
  ["4 placeholder inside a segment, other text", "out/report-{unit}.md", "out/summary-42.md", false],
  ["5 '*' is literal, not a glob", "out/*.md", "out/a.md", false],
  ["5 '*' equal to '*'", "out/*.md", "out/*.md", true],
  ["5 '**' is literal, not a glob", "out/**", "out/a/b.md", false],
  // S-34 (reading A): a read folder is satisfied by any write under it.
  ["6 a read folder takes a file write under it", "out/report.md", "out/", true],
  ["6 a read folder takes a write at any depth", "out/en/a.md", "out/", true],
  ["6 a read folder takes a folder write under it", "out/en/", "out/", true],
  ["6 a read folder, a write outside it", "other/a.md", "out/", false],
  ["6 a read folder, a sibling with its name as prefix", "outside/a.md", "out/", false],
  ["6 a read without a trailing slash is a file", "out/a.md", "out", false],
  ["6 a placeholder read folder takes a literal write", "x/en/f.md", "x/{LANG}/", true],
  ["6 a placeholder read folder, other prefix", "y/en/f.md", "x/{LANG}/", false],
  ["6 a placeholder read folder is one segment, not zero", "x/f.md", "x/{LANG}/", false],
  ["6 a read folder, '*' is literal", "out/a.md", "*/", false],
];

describe("writeCovers (S-22)", () => {
  for (const [rule, w, r, covers] of CASES) {
    it(`rule ${rule}: ${w} ${covers ? "covers" : "does not cover"} ${r}`, () => {
      expect(paths.writeCovers(w, r)).toBe(covers);
    });
  }
});

describe("validate V93 and plan handoff-overlap-empty agree (S-22)", () => {
  for (const [rule, w, r, covers] of CASES) {
    it(`rule ${rule}: ${w} -> ${r} ${covers ? "is a handoff" : "still fires both"}`, () => {
      expect(verdicts([w], [r])).toEqual({ v93: !covers, plan: !covers });
    });
  }

  it("S-34 spec example: writer writes out/report.md, reader reads out/", () => {
    expect(verdicts(["out/report.md"], ["out/"])).toEqual({ v93: false, plan: false });
    const ast = parse(topo(["out/report.md", "log.txt"], ["out/"]));
    const h = buildExecutionBrief(ast).handoffs.find((x) => x.from === "w" && x.to === "r")!;
    expect(h.passes).toEqual(["out/report.md"]);
    expect(h.withholds).toEqual(["log.txt"]);
  });

  it("S-34: a write outside the read folder still fires both", () => {
    expect(verdicts(["outside/a.md"], ["out/"])).toEqual({ v93: true, plan: true });
  });

  it("the brief lists a covering folder under passes, the rest under withholds", () => {
    const ast = parse(topo(["x/{LANG}/", "log.txt"], ["x/{LANG}/file.md"]));
    const h = buildExecutionBrief(ast).handoffs.find((x) => x.from === "w" && x.to === "r")!;
    expect(h.passes).toEqual(["x/{LANG}/"]);
    expect(h.withholds).toEqual(["log.txt"]);
  });
});

describe("an empty side is not declared: V93 and plan both skip (S-33)", () => {
  const EMPTY: Array<[name: string, writes: string[] | undefined, reads: string[] | undefined]> = [
    ["reader declares no reads", ["out/a.md"], undefined],
    ["reader declares reads: []", ["out/a.md"], []],
    ["writer declares no writes", undefined, ["out/a.md"]],
    ["writer declares writes: []", [], ["out/a.md"]],
    ["both declare nothing", undefined, undefined],
    ["both declare []", [], []],
  ];
  for (const [name, w, r] of EMPTY) {
    it(`${name}: neither fires`, () => {
      expect(verdicts(w, r)).toEqual({ v93: false, plan: false });
    });
  }

  it("a declared pair that does not overlap still fires both", () => {
    expect(verdicts(["out/a.md"], ["out/b.md"])).toEqual({ v93: true, plan: true });
  });

  it("plan still lists the edge under handoffs, passing nothing", () => {
    const h = buildExecutionBrief(parse(topo(["out/a.md"], undefined))).handoffs.find(
      (x) => x.from === "w" && x.to === "r"
    )!;
    expect(h).toEqual({ from: "w", to: "r", passes: [], withholds: ["out/a.md"] });
  });

  it("handoffMissing is the one predicate", () => {
    const { handoffMissing } = paths;
    expect(handoffMissing([], ["a"])).toBe(false);
    expect(handoffMissing(["a"], [])).toBe(false);
    expect(handoffMissing(["a"], ["b"])).toBe(true);
    expect(handoffMissing(["out/"], ["out/a.md"])).toBe(false);
  });

  it("company-brain-team.at, librarian -> auditor: neither fires", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const ast = parse(readFileSync(resolve(here, "../../../examples/company-brain-team.at"), "utf8"));
    const v93 = validate(ast).filter((x) => x.rule === "V93" && x.message.includes('"librarian -> auditor"'));
    const plan = buildExecutionBrief(ast).preflagged.filter(
      (p) => p.kind === "handoff-overlap-empty" && p.at.edge === "librarian->auditor"
    );
    expect({ v93: v93.length, plan: plan.length }).toEqual({ v93: 0, plan: 0 });
  });
});
