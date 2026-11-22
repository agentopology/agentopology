/**
 * `agentopology fix`: the V135 errors of a topology, each with the edit that
 * grades the gate honestly (`strength: hope`) and, when the flow has one, the
 * anchor that would make it refuse (a suggestion, never applied).
 *
 * The edit is minimal: one inserted line per gate (after its `run:` line), or
 * the word `refuse` replaced in a `strength: refuse` line. Every other byte of
 * the file stays as written.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import type { GateNode } from "../../parser/ast.js";
import { hooklessGateReason } from "../../bindings/lib/guards.js";
import { planV135Fixes, applyV135Fixes } from "../v135.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "fixtures/v135-fix.at");
const source = readFileSync(FIXTURE, "utf8");

const V135_GATES = ["needs-source", "after-approval", "claimed", "orphan-check"];

/** The fixture with exactly the edits fix makes, written out by hand. */
const expected = source
  .replace(`      run: "scripts/source.sh"   # checks the citations\n`, `$&      strength: hope\n`)
  .replace(`      run: "scripts/approval.sh"\n`, `$&      strength: hope\n`)
  .replace(`      strength: refuse   # we thought so\n`, `      strength: hope   # we thought so\n`) // gate claimed
  .replace(`      run: "scripts/orphan.sh"\n`, `$&      strength: hope\n`);

const v135Errors = (src: string, target?: string) =>
  validate(parse(src), target ? { target } : {}).filter((r) => r.rule === "V135" && r.level === "error");

describe("fix: plan (dry run)", () => {
  it("the fixture is what it claims: four V135 errors and one V135 warning", () => {
    expect(v135Errors(source).map((r) => r.node)).toEqual(V135_GATES);
    const warn = validate(parse(source)).filter((r) => r.rule === "V135" && r.level === "warning");
    expect(warn.map((r) => r.node)).toEqual(["lint-gate"]);
    expect(expected).not.toBe(source);
  });

  it("lists exactly the gates V135 errors on, in source order", () => {
    const plan = planV135Fixes(source);
    expect(plan.applies).toBe(true);
    expect(plan.fixes.map((f) => f.gate)).toEqual(V135_GATES);
  });

  it("does not list the V135 warning (a declared hook runs the gate's command), nor fine gates", () => {
    const gates = planV135Fixes(source).fixes.map((f) => f.gate);
    for (const fine of ["lint-gate", "draft-ok", "deploy-ok", "style", "by-hand"]) expect(gates).not.toContain(fine);
  });

  it("gives V135's own reason and line for each gate", () => {
    const ast = parse(source);
    const errors = v135Errors(source);
    for (const fix of planV135Fixes(source).fixes) {
      const gate = ast.nodes.find((n) => n.id === fix.gate) as GateNode;
      expect(fix.reason).toBe(hooklessGateReason(ast, gate));
      const err = errors.find((e) => e.node === fix.gate)!;
      expect(fix.line).toBe(err.line);
      expect(fix.message).toBe(err.message);
    }
  });

  it("the edit is an inserted strength: hope line, or refuse replaced by hope", () => {
    const byGate = Object.fromEntries(planV135Fixes(source).fixes.map((f) => [f.gate, f]));
    expect(byGate["needs-source"].edit).toMatchObject({ kind: "insert", text: "      strength: hope\n" });
    expect(byGate["after-approval"].edit).toMatchObject({ kind: "insert", text: "      strength: hope\n" });
    expect(byGate["orphan-check"].edit).toMatchObject({ kind: "insert", text: "      strength: hope\n" });
    expect(byGate["claimed"].edit).toMatchObject({ kind: "replace", text: "hope" });
  });

  it("suggests an anchor from the flow that would make the gate refuse, never one the topology lacks", () => {
    const byGate = Object.fromEntries(planV135Fixes(source).fixes.map((f) => [f.gate, f.suggestions]));
    // needs-source is before: finish; reviewer is the subagent right before finish.
    expect(byGate["needs-source"].join("\n")).toContain("after: reviewer");
    // after-approval is after: approve; reviewer is the subagent right after approve.
    expect(byGate["after-approval"].join("\n")).toContain("before: reviewer");
    // claimed is after: finish; deploy is the script step right after finish.
    expect(byGate["claimed"].join("\n")).toContain("before: deploy");
    // orphan-check names no anchor: nothing next to it in the flow.
    expect(byGate["orphan-check"]).toEqual([]);
  });

  it("every suggestion, applied by hand, would leave no V135 error on that gate", () => {
    const ast = parse(source);
    for (const fix of planV135Fixes(source).fixes) {
      const gate = ast.nodes.find((n) => n.id === fix.gate) as GateNode;
      for (const s of fix.anchors) {
        expect(hooklessGateReason(ast, { ...gate, ...s })).toBeNull();
      }
    }
  });

  it("does not touch the source", () => {
    const copy = String(source);
    planV135Fixes(copy);
    expect(copy).toBe(source);
  });

  it("V135 does not apply to cursor or claude-workflow: nothing to fix", () => {
    for (const target of ["cursor", "claude-workflow"]) {
      const plan = planV135Fixes(source, { target });
      expect(plan.applies).toBe(false);
      expect(plan.fixes).toEqual([]);
    }
  });

  it("judges codex as V135 does", () => {
    expect(planV135Fixes(source, { target: "codex" }).fixes.map((f) => f.gate))
      .toEqual(v135Errors(source, "codex").map((r) => r.node));
  });
});

describe("fix: apply (--write)", () => {
  it("changes only the inserted lines and the replaced word", () => {
    expect(applyV135Fixes(source, planV135Fixes(source))).toBe(expected);
  });

  it("the result has no V135 error, and every fixed gate reads strength: hope", () => {
    const out = applyV135Fixes(source, planV135Fixes(source));
    expect(v135Errors(out)).toEqual([]);
    const ast = parse(out);
    for (const id of V135_GATES) expect((ast.nodes.find((n) => n.id === id) as GateNode).strength).toBe("hope");
  });

  it("the result validates as cleanly as the fixture did, less the V135 errors", () => {
    const before = validate(parse(source)).filter((r) => r.level === "error" && r.rule !== "V135");
    const after = validate(parse(applyV135Fixes(source, planV135Fixes(source)))).filter((r) => r.level === "error");
    expect(after).toEqual(before);
  });

  it("running it twice is a no-op", () => {
    const once = applyV135Fixes(source, planV135Fixes(source));
    const plan = planV135Fixes(once);
    expect(plan.fixes).toEqual([]);
    expect(applyV135Fixes(once, plan)).toBe(once);
  });

  it("keeps CRLF line endings: the inserted line ends as its neighbours do", () => {
    const crlf = source.replace(/\n/g, "\r\n");
    const out = applyV135Fixes(crlf, planV135Fixes(crlf));
    expect(out).toBe(expected.replace(/\n/g, "\r\n"));
  });

  it("a gate whose run: shares the header line is reported for a hand edit", () => {
    const shared = source.replace(
      `    gate orphan-check {\n      run: "scripts/orphan.sh"\n    }`,
      `    gate orphan-check { run: "scripts/orphan.sh"\n    }`,
    );
    const orphan = planV135Fixes(shared).fixes.find((f) => f.gate === "orphan-check")!;
    expect(orphan.edit).toBeUndefined();
    expect(orphan.manual).toMatch(/by hand/);
  });

  it("a gate that cites code (at:) gets V135's fix, drop run: and keep the citation, by hand; no strength: hope next to it", () => {
    const cited = source.replace(`      by: hook\n`, `      by: hook\n      at: "tools/checks.py"\n`);
    const plan = planV135Fixes(cited);
    const gate = plan.fixes.find((f) => f.gate === "claimed")!;
    expect(gate.edit).toBeUndefined();
    expect(gate.manual).toMatch(/drop run: and keep the citation/);
    expect(gate.manual).toMatch(/by hand/);
    const out = applyV135Fixes(cited, plan);
    expect(out).toContain(`      strength: refuse   # we thought so\n      by: hook\n      at: "tools/checks.py"\n`);
    expect(v135Errors(out).map((r) => r.node)).toEqual(["claimed"]);
  });

  it("a gate written on one line is reported for a hand edit, not rewritten", () => {
    const oneLine = source.replace(
      `    gate orphan-check {\n      run: "scripts/orphan.sh"\n    }`,
      `    gate orphan-check { run: "scripts/orphan.sh" }`,
    );
    const plan = planV135Fixes(oneLine);
    const orphan = plan.fixes.find((f) => f.gate === "orphan-check")!;
    expect(orphan.edit).toBeUndefined();
    expect(orphan.manual).toMatch(/by hand/);
    const out = applyV135Fixes(oneLine, plan);
    expect(out).toContain(`    gate orphan-check { run: "scripts/orphan.sh" }`);
    expect(v135Errors(out).map((r) => r.node)).toEqual(["orphan-check"]);
  });
});

describe("fix: a V135 error in an imported file", () => {
  const parent = `topology p : [pipeline] {
  meta {
    version: "1.0.0"
    description: "imports a file with V135 gates"
  }
  orchestrator {
    model: sonnet
    handles: [a]
  }
  agent a {
    model: sonnet
    description: "d"
  }
  import "./shared.at" as shared
  flow {
    orchestrator -> a
  }
}
`;
  it("is reported as relayed, with the imported file named, and never planned as an edit of the importer", () => {
    const dir = mkdtempSync(join(tmpdir(), "at-fix-unit-"));
    try {
      writeFileSync(join(dir, "shared.at"), source);
      const plan = planV135Fixes(parent, { filePath: join(dir, "p.at") });
      expect(plan.fixes).toEqual([]);
      expect(plan.relayed.length).toBe(V135_GATES.length);
      expect(plan.relayedFiles).toEqual([join(dir, "shared.at")]);
      expect(applyV135Fixes(parent, plan)).toBe(parent);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
