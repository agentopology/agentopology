/**
 * The generated flow-map SKILL.md carries `entry: <agent id>` when
 * `meta { entry }` names an agent, so a tool can recognise the flow map.
 *
 * Claude Code's skills docs (https://code.claude.com/docs/en/skills): "Claude
 * Code ignores a field it doesn't recognize without reporting an error", so an
 * extra key is safe in Claude Code.
 */

import { describe, it, expect, vi } from "vitest";
import { parse } from "../../parser/index.js";
import { bindings } from "../index.js";

function topo(meta: string, extra = ""): string {
  return `
topology entry-probe : [pipeline] {
  meta {
    version: "0.1.0"
    description: "Entry"
${meta}
  }
  agent lead {
    model: sonnet
    description: "Leads"
    invocation: manual
    prompt {
      Lead.
    }
  }
${extra}
}
`;
}

function skill(src: string): string {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const files = bindings["claude-code"].scaffold(parse(src));
    return files.find((f) => f.path === ".claude/skills/entry-probe/SKILL.md")!.content;
  } finally {
    warn.mockRestore();
  }
}

const fm = (s: string) => s.split("---")[1];

describe("SKILL.md entry key", () => {
  it("an agent entry is written as entry: <agent id>", () => {
    expect(fm(skill(topo("    entry: lead")))).toMatch(/^entry: "?lead"?$/m);
  });
  it("no meta entry writes no entry key", () => {
    expect(fm(skill(topo("")))).not.toMatch(/^entry:/m);
  });
  it("an entry that is not a declared agent writes no entry key", () => {
    expect(fm(skill(topo("    entry: ghost")))).not.toMatch(/^entry:/m);
  });
});
