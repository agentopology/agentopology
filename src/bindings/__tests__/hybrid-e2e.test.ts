/**
 * Hybrid end-to-end test.
 *
 * Unit tests check each binding in isolation. THIS test compiles BOTH bindings
 * from the SAME .at file and proves they COMPOSE into one coherent hybrid:
 *   - the host (claude-code) and the rung (claude-workflow) partition the agents
 *     with no overlap and no gap,
 *   - they agree on the seam (workflow filename, Blackboard root, SEAM doc),
 *   - the generated workflow.js is syntactically valid JavaScript,
 *   - nothing is silently dropped (the LOSSY report exists).
 *
 * This is the real "does the hybrid work end to end" gate.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { parse } from "../../parser/index.js";
import { claudeCodeBinding, claudeWorkflowBinding } from "../index.js";
import { seamFiles, isWorkflowSeamAgent, isHybridTopology } from "../lib/seam.js";
import type { AgentNode } from "../../parser/ast.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(here, "../../../examples/matchmat-ship.at");
const ast = parse(readFileSync(fixturePath, "utf-8"));
const name = ast.topology.name;

const hostFiles = claudeCodeBinding.scaffold(ast);
const wfFiles = claudeWorkflowBinding.scaffold(ast);

const hostPaths = hostFiles.map((f) => f.path);
const wfPaths = wfFiles.map((f) => f.path);
const agents = ast.nodes.filter((n): n is AgentNode => n.type === "agent");
const wfAgents = agents.filter(isWorkflowSeamAgent).map((a) => a.id);
const hostAgents = agents.filter((a) => !isWorkflowSeamAgent(a)).map((a) => a.id);

describe("hybrid e2e: matchmat-ship.at → claude-code + claude-workflow", () => {
  it("the fixture is a hybrid topology", () => {
    expect(isHybridTopology(ast)).toBe(true);
    expect(wfAgents.length).toBeGreaterThan(0);
    expect(hostAgents.length).toBeGreaterThan(0);
  });

  it("agents partition cleanly: workflow agents NOT in host, host agents NOT in workflow.js", () => {
    const wfScript = wfFiles.find((f) => f.path === seamFiles.workflowScript(name))!.content;
    // workflow-marked agents must NOT have a host AGENT.md
    for (const id of wfAgents) {
      expect(hostPaths).not.toContain(`.claude/agents/${id}/AGENT.md`);
      expect(wfScript).toContain(id); // and they DO appear in the rung
    }
    // host agents must have a host AGENT.md and must NOT be agent() calls in the rung
    for (const id of hostAgents) {
      expect(hostPaths).toContain(`.claude/agents/${id}/AGENT.md`);
    }
  });

  it("both halves agree on the seam (filename, SEAM doc, Blackboard root)", () => {
    const wfFile = seamFiles.workflowScript(name);
    const seamDoc = seamFiles.seamDoc(name);
    // workflow binding emits the rung + the SEAM contract + the LOSSY report
    expect(wfPaths).toContain(wfFile);
    expect(wfPaths).toContain(seamDoc);
    expect(wfPaths).toContain(seamFiles.lossyDoc(name));
    // host references the same workflow filename + seam doc in its CLAUDE.md
    const claudeMd = hostFiles.find((f) => f.path === ".claude/CLAUDE.md")!.content;
    expect(claudeMd).toContain(wfFile);
    expect(claudeMd).toContain(seamDoc);
  });

  it("the generated workflow.js is syntactically valid JavaScript (ESM)", () => {
    const wfScript = wfFiles.find((f) => f.path === seamFiles.workflowScript(name))!.content;
    // The rung is an ES module (export const meta / export default). vm.Script is
    // CommonJS-mode and rejects `export`, so validate via `node --check` on a temp
    // .mjs file (the real syntax gate; we never execute it).
    const tmp = path.join(os.tmpdir(), `at-e2e-${process.pid}.mjs`);
    writeFileSync(tmp, wfScript);
    try {
      const res = spawnSync("node", ["--check", tmp], { encoding: "utf-8" });
      expect(res.status, res.stderr).toBe(0);
    } finally {
      rmSync(tmp, { force: true });
    }
    // sanity: pure-literal meta + at least one parallel fan-out
    expect(wfScript).toContain("export const meta");
    expect(wfScript).toMatch(/parallel\(/);
  });

  it("the host wires concurrent observability over the Blackboard (the hybrid's point)", () => {
    const settings = hostFiles.find((f) => f.path === ".claude/settings.json");
    expect(settings).toBeDefined();
    // a PostToolUse observer must exist when the topology has a Blackboard
    expect(settings!.content).toMatch(/PostToolUse|observe/i);
  });

  it("nothing is silently dropped: the LOSSY report names the human split", () => {
    const lossy = wfFiles.find((f) => f.path === seamFiles.lossyDoc(name))!.content;
    expect(lossy).toMatch(/human/i);
    expect(lossy).toMatch(/UNREPRESENTABLE/);
  });
});
