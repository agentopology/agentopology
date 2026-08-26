/**
 * Run state is DERIVED from the filesystem, never stored.
 *
 * A topology already declares what each role writes. Whether those files exist
 * IS the run state. A sidecar would record "I finished"; the filesystem records
 * "the artifact exists", and only the second survives a crash between stamping
 * and writing.
 *
 * `undecidable` is a first-class answer here, not a failure — a gate leaves no
 * artifact and an agent may declare no outputs. Saying so beats guessing.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "../../parser/index.js";
import { buildExecutionBrief } from "../brief.js";
import { renderBriefMarkdown } from "../render.js";

const SRC = `topology t : [pipeline] {
  meta {
    version: "1.0.0"
    description: "x"
  }
  agent first {
    model: sonnet
    description: "f"
    writes: ["out/first.md"]
  }
  agent second {
    model: sonnet
    description: "s"
    reads: ["out/first.md"]
    writes: ["out/second.md"]
  }
  agent silent {
    model: sonnet
    description: "declares no writes"
    reads: ["out/second.md"]
  }
  action intake {
    kind: inline
    description: "in"
  }
  gates {
    gate check {
      after: second
      run: "true"
    }
  }
  flow { intake -> first
         first -> second
         second -> silent }
}`;

let dir: string;
const briefIn = (root: string) =>
  buildExecutionBrief(parse(SRC), { root, source: "t.at" });
const evidenceOf = (root: string, id: string) =>
  briefIn(root).steps.find((s) => s.ids.includes(id))!.evidence;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "at-evidence-"));
  mkdirSync(join(dir, "out"), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("derived run state", () => {
  it("reports missing when a step's declared output is absent", () => {
    expect(evidenceOf(dir, "first")).toBe("missing");
  });

  it("reports present once the declared output exists", () => {
    writeFileSync(join(dir, "out/first.md"), "done");
    expect(evidenceOf(dir, "first")).toBe("present");
  });

  it("treats a PARTIALLY written step as missing — half a handoff is not a handoff", () => {
    const src = SRC.replace(
      '    writes: ["out/first.md"]',
      '    writes: ["out/first.md", "out/first-notes.md"]'
    );
    writeFileSync(join(dir, "out/first.md"), "done");
    const b = buildExecutionBrief(parse(src), { root: dir });
    expect(b.steps.find((s) => s.ids.includes("first"))!.evidence).toBe("missing");
  });

  it("calls a step undecidable when its agent declares no writes", () => {
    expect(evidenceOf(dir, "silent")).toBe("undecidable");
  });

  it("calls a gate undecidable — a gate leaves no artifact", () => {
    expect(evidenceOf(dir, "check")).toBe("undecidable");
  });

  it("calls an action undecidable rather than guessing", () => {
    expect(evidenceOf(dir, "intake")).toBe("undecidable");
  });

  it("never mutates the .at — state is read, never written", () => {
    // The invariant: a .at file never contains a fact about a specific run.
    // buildExecutionBrief must be a pure read of AST + disk.
    const before = parse(SRC);
    writeFileSync(join(dir, "out/first.md"), "done");
    buildExecutionBrief(before, { root: dir });
    const first = before.nodes.find((n) => n.id === "first") as unknown as Record<string, unknown>;
    expect(first.status).toBeUndefined();
    expect(first.evidence).toBeUndefined();
    expect(first.completed).toBeUndefined();
  });

  it("states its own limits in the brief instead of implying certainty", () => {
    writeFileSync(join(dir, "out/first.md"), "done");
    const md = renderBriefMarkdown(briefIn(dir));
    expect(md).toContain("| evidence |");
    expect(md).toMatch(/\d of \d steps have their declared outputs on disk/);
    expect(md).toContain("evidence, not a record");
    expect(md).toContain("git log");
    // And it must NOT offer to skip anything on this basis.
    expect(md).not.toContain("--resume");
  });
});
