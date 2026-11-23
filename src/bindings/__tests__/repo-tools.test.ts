/**
 * A repo's own tool (`tools { tool <id> { ... } }`) is a real allowed call on
 * Claude Code, not a made-up tool name.
 *
 * Claude Code's subagent `tools:` field takes tool names (Read, Grep, Bash),
 * MCP entries (mcp__github__*) and Agent(type) (code.claude.com/docs/en/sub-agents);
 * a repo tool's id is none of these. A tool with a `command:` or a `script:`
 * runs through Bash, so the agent gets `Bash` and settings.json gets the
 * permission allow rule that runs the call without a prompt
 * (code.claude.com/docs/en/permissions: `Bash(ls *)` also matches bare `ls`).
 */

import { describe, it, expect, vi } from "vitest";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { bindings } from "../index.js";
import type { GeneratedFile } from "../types.js";

function scaffold(src: string): GeneratedFile[] {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    return bindings["claude-code"].scaffold(parse(src)) as GeneratedFile[];
  } finally {
    warn.mockRestore();
  }
}
const file = (files: GeneratedFile[], p: string) => files.find((f) => f.path === p);
/** A frontmatter line as `key: value`, the value's YAML quotes (written only when needed) left out. */
const frontmatterLine = (content: string, key: string) => {
  const line = content.split("\n").find((l) => l.startsWith(`${key}:`));
  return line?.replace(/^([^:]+): "(.*)"$/, "$1: $2");
};
const allowOf = (files: GeneratedFile[]) => {
  const s = file(files, ".claude/settings.json");
  return s ? ((JSON.parse(s.content).permissions?.allow ?? []) as string[]) : [];
};

// The shape of the outside reviewer's probe (a script tool named in an agent's tools).
const P13 = `topology p13 : [pipeline] {
  meta { version: "0.1.0" description: "Repo tools" }
  agent builder {
    model: sonnet
    description: "Builds"
    invocation: manual
    tools: [Read, Bash, run-tests]
    skills: [ticketing]
    prompt { Build. }
  }
  tools {
    tool run-tests {
      script: "scripts/run-tests.sh"
      lang: bash
      description: "Run the suite"
    }
  }
  skill ticketing {
    description: "Tickets"
    scripts: [run-tests]
    allowed-tools: ["Read", "Bash(python3 tools/tickets/*)"]
  }
}`;

const commandTool = (agentTools: string, extra = "") => `topology cmd : [pipeline] {
  meta { version: "0.1.0" description: "Command tool" }
  agent builder {
    model: sonnet
    description: "Builds"
    invocation: manual
    ${agentTools}
    prompt { Build. }
  }
  tools {
    tool run-tests {
      command: "npm test"
      description: "Run the suite"
    }
  }
  ${extra}
}`;

describe("a repo tool in an agent's tools", () => {
  it("p13's shape writes no repo tool name into the agent's tools:", () => {
    const files = scaffold(P13);
    const agent = file(files, ".claude/agents/builder/AGENT.md")!;
    const line = frontmatterLine(agent.content, "tools")!;
    expect(line).toBe("tools: Read, Bash");
    expect(line).not.toContain("run-tests");
  });

  it("a script tool allows running its script by its project path", () => {
    const files = scaffold(P13);
    expect(allowOf(files)).toContain("Bash(.claude/skills/p13/scripts/run-tests.sh *)");
    // The stub is still written where the script lives.
    expect(file(files, ".claude/skills/p13/scripts/run-tests.sh")).toBeDefined();
  });

  it("a command tool compiles to Bash in tools: (added once) and a Bash allow rule", () => {
    const files = scaffold(commandTool("tools: [Read, run-tests]"));
    const agent = file(files, ".claude/agents/builder/AGENT.md")!;
    expect(frontmatterLine(agent.content, "tools")).toBe("tools: Read, Bash");
    expect(allowOf(files)).toEqual(["Bash(npm test *)"]);
    // A command needs no script: no stub is written for it.
    expect(files.some((f) => f.stub === "tool")).toBe(false);
  });

  it("the allow rule is added after settings { allow } as written", () => {
    const files = scaffold(commandTool("tools: [Bash, run-tests]", `settings { allow: ["Read"] }`));
    expect(frontmatterLine(file(files, ".claude/agents/builder/AGENT.md")!.content, "tools")).toBe("tools: Bash");
    expect(allowOf(files)).toEqual(["Read", "Bash(npm test *)"]);
  });

  it("a skill's allowed-tools naming a command tool gets its allow rule", () => {
    const files = scaffold(commandTool("tools: [Read]", `skill t {\n    description: "T"\n    allowed-tools: ["Read", "run-tests"]\n  }`));
    const skill = file(files, ".claude/skills/t/SKILL.md")!;
    expect(frontmatterLine(skill.content, "allowed-tools")).toBe("allowed-tools: Read, Bash(npm test *)");
  });
});

describe("never widen", () => {
  it("an agent with disallowed-tools [Bash] whose skill uses a command tool is a V14 error naming both", () => {
    const ast = parse(commandTool("disallowed-tools: [Bash]\n    skills: [t]", `skill t {\n    description: "T"\n    scripts: [run-tests]\n  }`));
    const errs = validate(ast).filter((r) => r.rule === "V14" && r.level === "error");
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toContain('"builder"');
    expect(errs[0].message).toContain('"t"');
    expect(errs[0].message).toContain('"run-tests"');
    expect(errs[0].message).toContain("Bash");
  });

  it("a skill with disallowed-tools [Bash] that names a command tool is a V14 error", () => {
    const ast = parse(commandTool("tools: [Read]", `skill t {\n    description: "T"\n    scripts: [run-tests]\n    disallowed-tools: [Bash]\n  }`));
    const errs = validate(ast).filter((r) => r.rule === "V14" && r.level === "error");
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toContain('"t"');
    expect(errs[0].message).toContain('"run-tests"');
  });
});

describe("a tool with neither script nor command", () => {
  const NONE = `topology none : [pipeline] {
  meta { version: "0.1.0" description: "Nothing" }
  agent builder {
    model: sonnet
    description: "Builds"
    invocation: manual
    tools: [Read, noop]
    prompt { Build. }
  }
  tools {
    tool noop {
      description: "Does nothing yet"
    }
  }
}`;

  it("warns (V130) that it compiles to nothing", () => {
    const warns = validate(parse(NONE), { target: "claude-code" }).filter((r) => r.rule === "V130");
    expect(warns.some((w) => w.level === "warning" && w.message.includes('"noop"') && w.message.includes("compiles to nothing"))).toBe(true);
  });

  it("adds no Bash and no allow rule, and its name is not written", () => {
    const files = scaffold(NONE);
    expect(frontmatterLine(file(files, ".claude/agents/builder/AGENT.md")!.content, "tools")).toBe("tools: Read");
    expect(allowOf(files)).toEqual([]);
  });
});
