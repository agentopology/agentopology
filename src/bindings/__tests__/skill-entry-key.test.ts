/**
 * The generated flow-map SKILL.md carries `entry-agent: <agent id>` when
 * `meta { entry }` names an agent, so a tool can recognise the flow map.
 * The `entry:` key (the trigger command path) is not touched.
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

describe("SKILL.md entry-agent key", () => {
  it("an agent entry is written as entry-agent: <agent id>, and no entry: key is added", () => {
    const f = fm(skill(topo("    entry: lead")));
    expect(f).toMatch(/^entry-agent: "?lead"?$/m);
    expect(f).not.toMatch(/^entry:/m);
  });
  it("no meta entry writes no entry-agent key", () => {
    expect(fm(skill(topo("")))).not.toMatch(/^entry-agent:/m);
  });
  it("an entry that is not a declared agent writes no entry-agent key", () => {
    expect(fm(skill(topo("    entry: ghost")))).not.toMatch(/^entry-agent:/m);
  });
});
