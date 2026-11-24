/**
 * An agent's `permission-mode:` reaches its subagent file.
 *
 * Measured on 0.12.6: `permission-mode: plan` on a subagent was parsed, read
 * only for a session agent's start line, and written nowhere on the agent
 * file. `permissions:` was the only field that wrote frontmatter permissionMode.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { bindings } from "../../bindings/index.js";

const topo = (fields: string) => `topology pm : [pipeline] {
  meta {
    version: "0.1.0"
    description: "permission-mode on a subagent"
  }
  orchestrator {
    model: sonnet
  }
  agent worker {
    model: haiku
    invocation: manual
${fields}
    prompt {
      probe
    }
  }
}
`;

const agentFile = (src: string) => {
  const f = bindings["claude-code"].scaffold(parse(src)).find((x) => x.path === ".claude/agents/worker/AGENT.md" || x.path === ".claude/agents/worker.md");
  expect(f).toBeDefined();
  return f!.content;
};
const frontmatter = (content: string) => content.split("---")[1];

afterEach(() => vi.restoreAllMocks());

describe("permission-mode on a subagent writes frontmatter permissionMode", () => {
  it("permission-mode: plan writes permissionMode: plan", () => {
    expect(frontmatter(agentFile(topo("    permission-mode: plan")))).toMatch(/^permissionMode: plan$/m);
  });

  it("permission-mode: default writes no key (the default)", () => {
    expect(agentFile(topo("    permission-mode: default"))).not.toContain("permissionMode");
  });

  it("a looser mode warns as permissions: does", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(frontmatter(agentFile(topo("    permission-mode: acceptEdits")))).toMatch(/^permissionMode: acceptEdits$/m);
    expect(warn.mock.calls.flat().join("\n")).toMatch(/worker.*permission-mode: acceptEdits.*permissionMode acceptEdits/);
  });

  it("an unknown value is a V113 error and is never written", () => {
    const src = topo("    permission-mode: yolo");
    expect(validate(parse(src)).some((r) => r.rule === "V113" && r.level === "error" && r.message.includes("yolo"))).toBe(true);
    expect(agentFile(src)).not.toContain("yolo");
  });

  it("permissions and permission-mode that agree write one key", () => {
    const src = topo("    permissions: supervised\n    permission-mode: plan");
    expect(validate(parse(src)).filter((r) => r.level === "error" && /permission/.test(r.message))).toEqual([]);
    const fm = frontmatter(agentFile(src));
    expect(fm.match(/^permissionMode:/gm)).toHaveLength(1);
    expect(fm).toMatch(/^permissionMode: plan$/m);
  });

  it("permissions and permission-mode that differ are an error naming both", () => {
    const src = topo("    permissions: supervised\n    permission-mode: acceptEdits");
    const hit = validate(parse(src)).find((r) => r.level === "error" && r.message.includes("permissions: supervised") && r.message.includes("permission-mode: acceptEdits"));
    expect(hit).toBeDefined();
    expect(hit!.node).toBe("worker");
  });

  it("permissions: autonomous (no key) and permission-mode: plan differ too", () => {
    const src = topo("    permissions: autonomous\n    permission-mode: plan");
    expect(validate(parse(src)).some((r) => r.level === "error" && r.message.includes("permission-mode: plan") && r.message.includes("permissions: autonomous"))).toBe(true);
  });
});
