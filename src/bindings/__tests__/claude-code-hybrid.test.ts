import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parse } from "../../parser/index.js";
import { claudeCodeBinding, claudeWorkflowBinding } from "../index.js";
import type { GeneratedFile } from "../types.js";

// ---------------------------------------------------------------------------
// Hybrid-awareness of the claude-code binding (host half of the host+workflow
// model). Fixture: examples/matchmat-ship.at — builder (phase 2) is
// execution:workflow; phases 1 & 3 + the human node are host-side.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(here, "../../../examples/matchmat-ship.at");
const source = readFileSync(fixturePath, "utf-8");
const ast = parse(source);
const files: GeneratedFile[] = claudeCodeBinding.scaffold(ast);

function find(suffix: string): GeneratedFile | undefined {
  return files.find((f) => f.path.endsWith(suffix));
}

describe("claude-code binding — HYBRID awareness (matchmat-ship)", () => {
  // (a) workflow-marked agent (builder) is NOT emitted as a host subagent.
  it("does NOT emit .claude/agents/builder/AGENT.md (builder is execution:workflow)", () => {
    const builderAgent = files.find((f) => f.path === ".claude/agents/builder/AGENT.md");
    expect(builderAgent).toBeUndefined();
  });

  // (b) host phase-1 + phase-3 agents ARE still emitted as subagents.
  it("still emits AGENT.md for host phase-1 and phase-3 agents", () => {
    const expected = [
      ".claude/agents/contract-scout/AGENT.md",
      ".claude/agents/blast-radius-mapper/AGENT.md",
      ".claude/agents/boundary-drafter/AGENT.md",
      ".claude/agents/security-verifier/AGENT.md",
      ".claude/agents/contract-verifier/AGENT.md",
      ".claude/agents/closed-loop-verifier/AGENT.md",
    ];
    for (const p of expected) {
      expect(files.find((f) => f.path === p), `expected ${p} to be emitted`).toBeDefined();
    }
  });

  // (c) a launch-workflow stub/skill artifact for the build phase IS emitted.
  it("emits a launch-<phase>-workflow.sh stub for the workflow phase", () => {
    const launch = find("launch-builder-workflow.sh");
    expect(launch).toBeDefined();
    expect(launch!.path).toBe(".claude/skills/matchmat-ship/scripts/launch-builder-workflow.sh");
    expect(launch!.executable).toBe(true);
    // It's a detectable scaffold stub.
    expect(launch!.content).toContain("# AGENTOPOLOGY_STUB");
    // It documents launching the SAME workflow.js filename the sibling binding emits.
    expect(launch!.content).toContain("matchmat-ship.workflow.js");
    expect(launch!.content).toContain("/workflow matchmat-ship.workflow.js");
    // It points at the shared Blackboard root + the seam doc.
    expect(launch!.content).toContain("workspace/");
    expect(launch!.content).toContain("matchmat-ship-SEAM.md");
  });

  // (d) CLAUDE.md carries the hybrid run-order block referencing the workflow.js.
  it("emits a Hybrid run order block in CLAUDE.md referencing the workflow.js", () => {
    const ctx = files.find((f) => f.path === ".claude/CLAUDE.md");
    expect(ctx).toBeDefined();
    expect(ctx!.content).toContain("## Hybrid run order");
    expect(ctx!.content).toContain("matchmat-ship.workflow.js");
    expect(ctx!.content).toContain("Host launches");
    // host phases described as in-session; workflow phase described as launched.
    expect(ctx!.content).toContain("phase 1 (contract-scout, blast-radius-mapper, boundary-drafter)");
    expect(ctx!.content).toContain("phase 2 (builder)");
    expect(ctx!.content).toContain("phase 3 (security-verifier, contract-verifier, closed-loop-verifier)");
    // points at the seam doc both bindings honor.
    expect(ctx!.content).toContain("matchmat-ship-SEAM.md");
  });

  it("also mirrors the Hybrid run order block into the topology SKILL.md", () => {
    const skill = files.find((f) => f.path === ".claude/skills/matchmat-ship/SKILL.md");
    expect(skill).toBeDefined();
    expect(skill!.content).toContain("## Hybrid run order");
    expect(skill!.content).toContain("matchmat-ship.workflow.js");
  });

  // (e) the observe-hook is in settings.json (host-layer concurrent observer).
  it("emits a PostToolUse(Write) observe-blackboard hook in settings.json", () => {
    const settings = files.find((f) => f.path === ".claude/settings.json");
    expect(settings).toBeDefined();
    const parsed = JSON.parse(settings!.content) as {
      hooks?: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
    };
    const postToolUse = parsed.hooks?.PostToolUse;
    expect(postToolUse, "PostToolUse hooks present").toBeDefined();
    const observe = postToolUse!.find(
      (h) => h.matcher === "Write" && h.hooks.some((x) => x.command.includes("observe-blackboard.sh")),
    );
    expect(observe, "observe-blackboard PostToolUse(Write) hook present").toBeDefined();
  });

  it("emits the observe-blackboard.sh script the hook points at", () => {
    const observe = find("observe-blackboard.sh");
    expect(observe).toBeDefined();
    expect(observe!.path).toBe(".claude/skills/matchmat-ship/scripts/observe-blackboard.sh");
    expect(observe!.executable).toBe(true);
    expect(observe!.content).toContain("# AGENTOPOLOGY_STUB");
    // documents the Blackboard root it watches.
    expect(observe!.content).toContain("workspace/");
  });
});

describe("claude-code binding — non-hybrid topologies are unaffected", () => {
  // A topology with no execution:workflow agent must not get any hybrid artifacts.
  const plain = parse(`topology plain-pipe : [pipeline] {
    roles { worker: "do the work" }
    agent worker { role: worker phase: 1 prompt { Do the thing. } }
    flow { worker -> worker }
  }`);
  const plainFiles = claudeCodeBinding.scaffold(plain);

  it("still emits the agent AGENT.md (no workflow seam)", () => {
    expect(plainFiles.find((f) => f.path === ".claude/agents/worker/AGENT.md")).toBeDefined();
  });

  it("emits no launch-*-workflow.sh stub", () => {
    expect(plainFiles.find((f) => f.path.includes("launch-") && f.path.endsWith("-workflow.sh"))).toBeUndefined();
  });

  it("emits no Hybrid run order block", () => {
    const ctx = plainFiles.find((f) => f.path === ".claude/CLAUDE.md");
    if (ctx) expect(ctx.content).not.toContain("## Hybrid run order");
  });

  it("emits no synthesized observe-blackboard hook (no Blackboard)", () => {
    expect(plainFiles.find((f) => f.path.endsWith("observe-blackboard.sh"))).toBeUndefined();
  });
});

describe("claude-code + claude-workflow — the two bindings AGREE on the seam", () => {
  const hostFiles = claudeCodeBinding.scaffold(ast);
  const wfFiles = claudeWorkflowBinding.scaffold(ast);

  it("host omits builder/AGENT.md while the workflow.js OWNS builder", () => {
    expect(hostFiles.find((f) => f.path === ".claude/agents/builder/AGENT.md")).toBeUndefined();
    const wf = wfFiles.find((f) => f.path.endsWith(".workflow.js"));
    expect(wf).toBeDefined();
    expect(wf!.content).toContain("{ phase: 2, agents: ['builder'] }");
  });

  it("both reference the same workflow.js filename", () => {
    const wf = wfFiles.find((f) => f.path.endsWith(".workflow.js"))!;
    expect(wf.path).toBe("matchmat-ship.workflow.js");
    const ctx = hostFiles.find((f) => f.path === ".claude/CLAUDE.md")!;
    expect(ctx.content).toContain("matchmat-ship.workflow.js");
  });

  it("both reference the same Blackboard workspace root and SEAM doc", () => {
    const seam = wfFiles.find((f) => f.path.endsWith("-SEAM.md"))!;
    const ctx = hostFiles.find((f) => f.path === ".claude/CLAUDE.md")!;
    // workspace root
    expect(seam.content).toContain("`workspace/`");
    expect(ctx.content).toContain("`workspace/`");
    // seam doc filename
    expect(seam.path).toBe("matchmat-ship-SEAM.md");
    expect(ctx.content).toContain("matchmat-ship-SEAM.md");
  });

  it("both use the same 'Host launches ... LIVE' run-order phrasing", () => {
    const seam = wfFiles.find((f) => f.path.endsWith("-SEAM.md"))!;
    const ctx = hostFiles.find((f) => f.path === ".claude/CLAUDE.md")!;
    expect(seam.content).toContain("Host launches");
    expect(ctx.content).toContain("Host launches");
    expect(seam.content).toContain("observe those writes LIVE");
    expect(ctx.content).toContain("observe those writes LIVE");
  });
});
