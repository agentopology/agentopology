/**
 * The generator never widens a capability. A repo tool's `script:` is a file
 * the agent can edit, so an allow rule on it would let the agent run anything
 * without a prompt: a script tool gets `Bash` in the agent's tools: and no
 * allow rule, so it prompts as any Bash call does, and no new guard is written
 * for it. A `command:` tool runs a fixed command and gets `Bash(<command> *)`.
 */
import { describe, it, expect, vi } from "vitest";
import { parse } from "../../parser/index.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import type { GeneratedFile } from "../../bindings/types.js";

// No gates, no ledgers, no hooks.
const P13 = `topology p13 : [pipeline] {
  meta {
    version: "0.1.0"
    description: "Repo tools"
  }
  agent builder {
    model: sonnet
    description: "Builds"
    invocation: manual
    tools: [Read, run-tests]
    prompt { Build. }
  }
  tools {
    tool run-tests {
      script: "scripts/run-tests.sh"
      lang: bash
      description: "Run the suite"
    }
  }
}`;

const COMMAND = P13.replace('script: "scripts/run-tests.sh"\n      lang: bash', 'command: "npm test"');

function generate(src: string): GeneratedFile[] {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try { return claudeCodeBinding.scaffold(parse(src)) as GeneratedFile[]; } finally { warn.mockRestore(); }
}
const settingsOf = (files: GeneratedFile[]) => JSON.parse(files.find((f) => f.path === ".claude/settings.json")?.content ?? "{}");
const guards = (files: GeneratedFile[]) => files.filter((f) => f.path.endsWith("/before-edit.sh") || f.path.endsWith("/before-action.sh"));
const toolsLine = (files: GeneratedFile[]) =>
  files.find((f) => f.path === ".claude/agents/builder/AGENT.md")!.content.split("\n").find((l) => l.startsWith("tools:"));

describe("a script tool is never auto-allowed", () => {
  it("a script tool gets Bash in tools: and no allow rule", () => {
    const files = generate(P13);
    expect(toolsLine(files)).toBe("tools: Read, Bash");
    expect(settingsOf(files).permissions?.allow ?? []).toEqual([]);
  });

  it("a script tool gets no new guard (no before-edit.sh, no before-action.sh, no hooks)", () => {
    const files = generate(P13);
    expect(guards(files)).toEqual([]);
    expect(settingsOf(files).hooks).toBeUndefined();
  });

  it("a script tool in a skill's allowed-tools is left out, not pre-approved", () => {
    const files = generate(P13.replace("  tools {", '  skill t {\n    description: "T"\n    allowed-tools: ["Read", "run-tests"]\n  }\n  tools {'));
    const skill = files.find((f) => f.path === ".claude/skills/t/SKILL.md")!;
    expect(skill.content.split("\n").find((l) => l.startsWith("allowed-tools:"))).toBe("allowed-tools: Read");
  });

  it("a command tool gets Bash and its allow rule, and no guard", () => {
    const files = generate(COMMAND);
    expect(toolsLine(files)).toBe("tools: Read, Bash");
    expect(settingsOf(files).permissions?.allow).toEqual(["Bash(npm test *)"]);
    expect(guards(files)).toEqual([]);
    expect(settingsOf(files).hooks).toBeUndefined();
  });
});
