import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parse } from "../../parser/index.js";
import { bindings, claudeWorkflowBinding } from "../index.js";
import type { GeneratedFile } from "../types.js";

// ---------------------------------------------------------------------------
// Fixture: the example hybrid topology (examples/hybrid-release.at)
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(here, "../../../examples/hybrid-release.at");
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

describe("claude-workflow binding — workflow.js emission (hybrid-release)", () => {
  // (a) a *.workflow.js file is emitted
  it("emits a <topology>.workflow.js file", () => {
    const wf = find(".workflow.js");
    expect(wf).toBeDefined();
    expect(wf!.path).toBe("hybrid-release.workflow.js");
  });

  const wf = find(".workflow.js")!;

  // (b) STRICT SEAM: meta.phases contains ONLY the workflow-marked phase (2 / packager).
  it("contains `export const meta` as a pure literal with ONLY the workflow-marked phase", () => {
    expect(wf.content).toContain("export const meta");
    expect(wf.content).toContain("phases:");
    // The meta literal must not contain computed/nondeterministic values
    expect(wf.content).not.toContain("Date.now");
    expect(wf.content).not.toContain("Math.random");
    // Only phase 2 (packager) — not phase 1 or 3.
    expect(wf.content).toContain("{ phase: 2, agents: ['packager'] }");
    expect(wf.content).not.toContain("phase: 1");
    expect(wf.content).not.toContain("phase: 3");
  });

  it("uses parallel(...) for the packager fan-out", () => {
    expect(wf.content).toContain("parallel(");
  });

  it("uses phase() to title the workflow phase", () => {
    expect(wf.content).toContain("phase('Phase 2')");
  });

  it("compiles ONLY the packager (scaled) phase with isolation:'worktree'", () => {
    expect(wf.content).toContain("isolation: 'worktree'");
    // packager has scale {max: 4} → deterministic Array.from fan-out, no random
    expect(wf.content).toContain("Array.from({ length: 4 }");
    expect(wf.content).toMatch(/label: `packager-\$\{i\}`/);
  });

  // STRICT SEAM: the host-side phase 3 must NOT be in the workflow.js.
  it("does NOT contain the host phase-1 agents (change-lister, dependency-auditor)", () => {
    expect(wf.content).not.toContain("change-lister");
    expect(wf.content).not.toContain("dependency-auditor");
  });

  it("does NOT contain the host phase-3 agents (smoke-tester, license-checker)", () => {
    expect(wf.content).not.toContain("smoke-tester");
    expect(wf.content).not.toContain("license-checker");
  });

  it("does NOT contain the phase-3 outputs schema (phase 3 is HOST-side)", () => {
    // The pass|fail result enum belongs to the phase-3 agents, which are host-side.
    expect(wf.content).not.toContain("result:");
    expect(wf.content).not.toContain("pass | fail");
  });

  it("embeds the packager's Blackboard read/write paths in its prompt (no filesystem)", () => {
    // packager reads changes/dependencies, writes artifacts.
    expect(wf.content).toContain("workspace/changes.md");
    expect(wf.content).toContain("workspace/artifacts.md");
  });

  // STRICT SEAM: release-check is between phase 3 and release-notes (host) → NOT in the workflow.
  it("does NOT contain the host-side release-check gate (it sits outside the workflow span)", () => {
    expect(wf.content).not.toContain("bounce-back");
    expect(wf.content).not.toContain("release-check");
    expect(wf.content).not.toContain("for (let attempt");
  });

  // (d) the workflow.js does NOT contain the human node — neither as an agent nor a boundary block.
  it("does NOT contain the human 'approve-release' node as an agent() call", () => {
    expect(wf.content).not.toMatch(/agent\([^)]*label: 'approve-release'/);
    // Strict seam: the human is host-side downstream — no in-script HUMAN BOUNDARY block.
    expect(wf.content).not.toContain("HUMAN BOUNDARY");
    // It is still surfaced loud as an UNREPRESENTABLE comment, though.
    expect(wf.content).toContain("UNREPRESENTABLE: human 'approve-release'");
  });
});

describe("claude-workflow binding — human split (hybrid-release)", () => {
  // (c) a human-split README is emitted (topology has a `human approve-release` node)
  it("emits a <topology>-README.md documenting the human handoff", () => {
    const readme = find("-README.md");
    expect(readme).toBeDefined();
    expect(readme!.path).toBe("hybrid-release-README.md");
    expect(readme!.content).toContain("approve-release");
    expect(readme!.content.toLowerCase()).toContain("human");
    expect(readme!.content.toLowerCase()).toContain("downstream");
  });

  it("notes regression is a separate downstream workflow", () => {
    const readme = find("-README.md")!;
    expect(readme.content.toLowerCase()).toContain("separate");
  });
});

describe("claude-workflow binding — LOSSY report (hybrid-release)", () => {
  it("emits a <topology>-LOSSY-REPORT.md", () => {
    const report = find("-LOSSY-REPORT.md");
    expect(report).toBeDefined();
    expect(report!.path).toBe("hybrid-release-LOSSY-REPORT.md");
  });

  it("classifies the human node as UNREPRESENTABLE", () => {
    const report = find("-LOSSY-REPORT.md")!;
    expect(report.content).toContain("UNREPRESENTABLE");
    expect(report.content).toContain("human");
  });

  it("classifies the host-side release-check gate as LOSSY (not in the workflow.js)", () => {
    const report = find("-LOSSY-REPORT.md")!;
    expect(report.content).toContain("release-check");
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

describe("claude-workflow binding — Blackboard seam contract (hybrid-release)", () => {
  it("emits a <topology>-SEAM.md describing the file-based hand-off", () => {
    const seam = find("-SEAM.md");
    expect(seam).toBeDefined();
    expect(seam!.path).toBe("hybrid-release-SEAM.md");
  });

  it("documents the workspace root and per-agent reads/writes", () => {
    const seam = find("-SEAM.md")!;
    expect(seam.content).toContain("workspace/");
    expect(seam.content).toContain("packager");
    expect(seam.content).toContain("changes.md");
  });

  it("states the host .claude/ files are emitted by the claude-code binding, not this one", () => {
    const seam = find("-SEAM.md")!;
    expect(seam.content).toContain("claude-code");
  });

  it("[O-006] the README and SEAM docs describe this topology only: no pipeline wording from another harness is built in", () => {
    for (const f of [find("-SEAM.md")!, find("-README.md")!, find("-LOSSY-REPORT.md")!]) {
      for (const w of ["contract research", "adversarial verify", "ship-report", "build-report", "build rung", "the human promotes"]) {
        expect(f.content, `${f.path} holds "${w}"`).not.toContain(w);
      }
    }
  });

  it("documents the strict run order: host phase 1 → launch workflow build → host phase 3/gate → human approval", () => {
    const seam = find("-SEAM.md")!;
    expect(seam.content).toContain("STRICT SEAM");
    // The workflow rung is the build; host runs the surrounding phases.
    expect(seam.content).toContain("Host launches `hybrid-release.workflow.js`");
    expect(seam.content).toContain("workflow rung");
    expect(seam.content).toContain("phase 1 (change-lister");
    expect(seam.content).toContain("phase 3 (smoke-tester");
    expect(seam.content).toContain("human `approve-release`");
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
  meta {
    version: "1.0.0"
    description: "no workflow phase"
  }
  orchestrator {
    model: opus
    handles: [intake]
  }
  action intake {
    kind: external
    source: "user"
  }
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
