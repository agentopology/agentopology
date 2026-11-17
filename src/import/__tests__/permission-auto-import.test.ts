/**
 * Import keeps Claude Code's auto mode.
 *
 * `permissionMode: auto` is Claude Code's auto mode (a classifier approves
 * actions without asking). Importing it as `autonomous` lost it: `autonomous`
 * writes no permissionMode, so import then scaffold dropped auto mode without
 * a message. It imports as `auto`, compiles back to `permissionMode: auto`,
 * and validation says what it is (V132).
 */

import { describe, it, expect } from "vitest";
import { importClaudeCode, parseAgentMd } from "../claude-code.js";
import { serializeAST } from "../serializer.js";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import type { PlatformFile } from "../../sync/index.js";

const agentMd = (mode: string) => `---
name: worker
description: "Does the work"
model: sonnet
permissionMode: ${mode}
---

## Instructions
Do work.
`;

function roundTrip(mode: string) {
  // The manifest marks the agent file as one an earlier scaffold generated,
  // so scaffold writes it again instead of referencing it with `file:`.
  const files: PlatformFile[] = [
    { path: "agents/worker/AGENT.md", content: agentMd(mode) },
    { path: ".scaffold-manifest.json", content: JSON.stringify({ files: { "agents/worker/AGENT.md": "x" } }) },
  ];
  const imported = importClaudeCode(files, "rt");
  const source = serializeAST(imported);
  const ast = parse(source);
  const results = validate(ast);
  const out = claudeCodeBinding.scaffold(ast);
  const agentFile = out.find((f) => /\.claude\/agents\/worker(\/AGENT)?\.md$/.test(f.path))?.content ?? "";
  const fm = agentFile.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  return { source, results, agentFile, mode: fm.match(/^permissionMode:\s*(.+)$/m)?.[1]?.trim() };
}

describe("import keeps permissionMode: auto", () => {
  it("parseAgentMd reads permissionMode: auto as permissions: auto, not autonomous", () => {
    expect((parseAgentMd("worker", agentMd("auto")) as { permissions?: string }).permissions).toBe("auto");
  });

  it("import -> scaffold writes permissionMode: auto back, and V132 warns", () => {
    const rt = roundTrip("auto");
    expect(rt.source).toMatch(/permissions: auto\b/);
    expect(rt.agentFile).not.toBe("");
    expect(rt.mode).toBe("auto");
    const v132 = rt.results.filter((r) => r.rule === "V132");
    expect(v132).toHaveLength(1);
    expect(v132[0]).toMatchObject({ level: "warning", node: "worker" });
  });

  it("the other Claude Code values still round-trip as before", () => {
    expect(roundTrip("plan").mode).toBe("plan");
    expect(roundTrip("bypassPermissions").mode).toBe("bypassPermissions");
    expect(roundTrip("acceptEdits").mode).toBe("acceptEdits");
    expect(roundTrip("dontAsk").mode).toBe("dontAsk");
  });
});
