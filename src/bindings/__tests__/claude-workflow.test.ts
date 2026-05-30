import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parse } from "../../parser/index.js";
import { bindings, claudeWorkflowBinding } from "../index.js";
import type { GeneratedFile } from "../types.js";

// ---------------------------------------------------------------------------
// Fixture: the dogfood topology (examples/matchmat-ship.at)
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(here, "../../../examples/matchmat-ship.at");
const source = readFileSync(fixturePath, "utf-8");
const ast = parse(source);
const files: GeneratedFile[] = claudeWorkflowBinding.scaffold(ast);

function find(suffix: string): GeneratedFile | undefined {
  return files.find((f) => f.path.endsWith(suffix));
}

describe("claude-workflow binding — registry", () => {
  it("is registered under the 'claude-workflow' key with a matching name", () => {
    expect(bindings["claude-workflow"]).toBeDefined();
    expect(bindings["claude-workflow"].name).toBe("claude-workflow");
  });

  it("scaffold returns a non-empty array of GeneratedFile", () => {
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(f.path).toBeTruthy();
      expect(typeof f.content).toBe("string");
    }
  });
});

describe("claude-workflow binding — workflow.js emission (matchmat-ship)", () => {
  // (a) a *.workflow.js file is emitted
  it("emits a <topology>.workflow.js file", () => {
    const wf = find(".workflow.js");
    expect(wf).toBeDefined();
    expect(wf!.path).toBe("matchmat-ship.workflow.js");
  });

  const wf = find(".workflow.js")!;

  // (b) STRICT SEAM: meta.phases contains ONLY the workflow-marked phase (2 / builder).
  it("contains `export const meta` as a pure literal with ONLY the workflow-marked phase", () => {
    expect(wf.content).toContain("export const meta");
    expect(wf.content).toContain("phases:");
    // The meta literal must not contain computed/nondeterministic values
    expect(wf.content).not.toContain("Date.now");
    expect(wf.content).not.toContain("Math.random");
    // Only phase 2 (builder) — not phase 1 or 3.
    expect(wf.content).toContain("{ phase: 2, agents: ['builder'] }");
    expect(wf.content).not.toContain("phase: 1");
    expect(wf.content).not.toContain("phase: 3");
  });

  it("uses parallel(...) for the builder fan-out", () => {
    expect(wf.content).toContain("parallel(");
  });

  it("uses phase() to title the workflow phase", () => {
    expect(wf.content).toContain("phase('Phase 2')");
  });

  it("compiles ONLY the builder (scaled) phase with isolation:'worktree'", () => {
    expect(wf.content).toContain("isolation: 'worktree'");
    // builder has scale {max: 6} → deterministic Array.from fan-out, no random
    expect(wf.content).toContain("Array.from({ length: 6 }");
    expect(wf.content).toMatch(/label: `builder-\$\{i\}`/);
  });

  // STRICT SEAM: the host-side verifier phase (3) must NOT be in the workflow.js.
  it("does NOT contain the host phase-1 agents (contract-scout, blast-radius-mapper, boundary-drafter)", () => {
    expect(wf.content).not.toContain("contract-scout");
    expect(wf.content).not.toContain("blast-radius-mapper");
    expect(wf.content).not.toContain("'boundary-drafter'");
  });

  it("does NOT contain the host phase-3 verifier agents (security-verifier, etc.)", () => {
    expect(wf.content).not.toContain("security-verifier");
    expect(wf.content).not.toContain("contract-verifier");
    expect(wf.content).not.toContain("closed-loop-verifier");
  });

  it("does NOT contain a verifier verdict schema (phase 3 is HOST-side)", () => {
    // The verdict enum belongs to the phase-3 verifiers, which are host-side now.
    expect(wf.content).not.toContain("verdict:");
  });

  it("embeds the builder's Blackboard read/write paths in its prompt (no filesystem)", () => {
    // builder reads contract-delta/blast-radius/contracts-touched, writes build-report.
    expect(wf.content).toContain("workspace/contract-delta.md");
    expect(wf.content).toContain("workspace/build-report.md");
  });

  // STRICT SEAM: verify-gate is between phase 3 and ship-report (host) → NOT in the workflow.
  it("does NOT contain the host-side verify-gate (it sits outside the workflow span)", () => {
    expect(wf.content).not.toContain("bounce-back");
    expect(wf.content).not.toContain("verify-gate");
    expect(wf.content).not.toContain("for (let attempt");
  });

  // (d) the workflow.js does NOT contain the human node — neither as an agent nor a boundary block.
  it("does NOT contain the human 'promote' node as an agent() call", () => {
    expect(wf.content).not.toMatch(/agent\([^)]*label: 'promote'/);
    // Strict seam: the human is host-side downstream — no in-script HUMAN BOUNDARY block.
    expect(wf.content).not.toContain("HUMAN BOUNDARY");
    // It is still surfaced loud as an UNREPRESENTABLE comment, though.
    expect(wf.content).toContain("UNREPRESENTABLE: human 'promote'");
  });
});

describe("claude-workflow binding — human split (matchmat-ship)", () => {
  // (c) a human-split README is emitted (topology has a `human promote` node)
  it("emits a <topology>-README.md documenting the human handoff", () => {
    const readme = find("-README.md");
    expect(readme).toBeDefined();
    expect(readme!.path).toBe("matchmat-ship-README.md");
    expect(readme!.content).toContain("promote");
    expect(readme!.content.toLowerCase()).toContain("human");
    expect(readme!.content.toLowerCase()).toContain("downstream");
  });

  it("notes regression is a separate downstream workflow", () => {
    const readme = find("-README.md")!;
    expect(readme.content.toLowerCase()).toContain("separate");
  });
});

describe("claude-workflow binding — LOSSY report (matchmat-ship)", () => {
  it("emits a <topology>-LOSSY-REPORT.md", () => {
    const report = find("-LOSSY-REPORT.md");
    expect(report).toBeDefined();
    expect(report!.path).toBe("matchmat-ship-LOSSY-REPORT.md");
  });

  it("classifies the human node as UNREPRESENTABLE", () => {
    const report = find("-LOSSY-REPORT.md")!;
    expect(report.content).toContain("UNREPRESENTABLE");
    expect(report.content).toContain("human");
  });

  it("classifies the host-side verify-gate as LOSSY (not in the workflow.js)", () => {
    const report = find("-LOSSY-REPORT.md")!;
    expect(report.content).toContain("verify-gate");
    expect(report.content).toContain("HOST-side");
  });

  it("classifies agent.scale as LOSSY", () => {
    const report = find("-LOSSY-REPORT.md")!;
    expect(report.content).toContain("LOSSY");
    expect(report.content).toContain("agent.scale");
  });

  // STRICT SEAM: phases 1 & 3 are correct HOST phases, NOT 'folded-in lossy' entries.
  it("does NOT contain 'execution:host' folded-in LOSSY entries (strict seam)", () => {
    const report = find("-LOSSY-REPORT.md")!;
    expect(report.content).not.toContain("execution:host");
    expect(report.content).not.toContain("folded");
  });
});

describe("claude-workflow binding — Blackboard seam contract (matchmat-ship)", () => {
  it("emits a <topology>-SEAM.md describing the file-based hand-off", () => {
    const seam = find("-SEAM.md");
    expect(seam).toBeDefined();
    expect(seam!.path).toBe("matchmat-ship-SEAM.md");
  });

  it("documents the workspace root and per-agent reads/writes", () => {
    const seam = find("-SEAM.md")!;
    expect(seam.content).toContain("workspace/");
    expect(seam.content).toContain("builder");
    expect(seam.content).toContain("contract-delta.md");
  });

  it("states the host .claude/ files are emitted by the claude-code binding, not this one", () => {
    const seam = find("-SEAM.md")!;
    expect(seam.content).toContain("claude-code");
  });

  it("documents the strict run order: host phase 1 → launch workflow build → host phase 3/gate → human promote", () => {
    const seam = find("-SEAM.md")!;
    expect(seam.content).toContain("STRICT SEAM");
    // The workflow rung is the build; host runs the surrounding phases.
    expect(seam.content).toContain("Host launches `matchmat-ship.workflow.js`");
    expect(seam.content).toContain("build rung");
    expect(seam.content).toContain("phase 1 (contract-scout");
    expect(seam.content).toContain("phase 3 (security-verifier");
    expect(seam.content).toContain("human `promote`");
  });
});

describe("claude-workflow binding — UNREPRESENTABLE never dropped silently", () => {
  const wf = find(".workflow.js")!;

  it("surfaces UNREPRESENTABLE primitives as in-script comments", () => {
    expect(wf.content).toContain("// UNREPRESENTABLE:");
  });
});

// ---------------------------------------------------------------------------
// Edge case: a topology with NO seam marker → no workflow.js, loud note
// ---------------------------------------------------------------------------

describe("claude-workflow binding — no execution:workflow marker", () => {
  const NO_SEAM = `
topology no-seam : [pipeline] {
  meta { version: "1.0.0" description: "no workflow phase" }
  orchestrator { model: opus handles: [intake] }
  action intake { kind: external source: "user" }
  agent solo {
    model: sonnet
    phase: 1
    tools: [Read, Write]
    reads: ["workspace/in.md"]
    writes: ["workspace/out.md"]
    permissions: autonomous
  }
  flow { intake -> solo }
}
`;
  const noSeamAst = parse(NO_SEAM);
  const noSeamFiles = claudeWorkflowBinding.scaffold(noSeamAst);

  it("emits no workflow.js but still emits a LOSSY report explaining why", () => {
    const wf = noSeamFiles.find((f) => f.path.endsWith(".workflow.js"));
    expect(wf).toBeUndefined();
    const report = noSeamFiles.find((f) => f.path.endsWith("-LOSSY-REPORT.md"));
    expect(report).toBeDefined();
    expect(report!.content).toContain("execution");
  });
});
