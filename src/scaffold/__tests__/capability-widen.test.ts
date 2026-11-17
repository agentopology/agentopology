/**
 * Scaffold never widens a capability key over a value it did not write.
 *
 * A capability key is one that decides what an agent, skill or command may
 * do: an agent's tools, disallowedTools, mcpServers and permissionMode, a
 * skill's or command's allowed-tools and disallowed-tools. When the file's
 * value is not one scaffold applied (no base recorded, or the file differs
 * from it) and the .at's value grants more, the file's value is kept and
 * said, and only --force writes the .at's. A narrowing is written as before,
 * and so is a widening over a value scaffold itself applied.
 */

import { describe, it, expect } from "vitest";
import { planStructurePatch } from "../structure.js";
import type { StructureSpec } from "../../bindings/types.js";
import type { FieldValue } from "../frontmatter-patch.js";
import type { FileAction } from "../types.js";

type Kind = StructureSpec["kind"];

const fm = (lines: string[]) => `---\n${lines.join("\n")}\n---\n`;

function plan(
  kind: Kind,
  at: Record<string, string>,
  file: Record<string, string>,
  opts: { base?: Record<string, FieldValue>; force?: boolean } = {},
): Extract<FileAction, { type: "patch" }> {
  const id = "scout";
  const path = kind === "agent" ? `.claude/agents/${id}.md` : kind === "skill" ? `.claude/skills/${id}/SKILL.md` : `.claude/commands/${id}.md`;
  const spec: StructureSpec = {
    path,
    kind,
    id,
    content: fm([`name: ${id}`, ...Object.entries(at).map(([k, v]) => `${k}: ${v}`)]) + "\nGENERATED\n",
    owned: Object.keys(at),
    authored: true,
  };
  const existing = fm([`name: ${id}`, "description: mine", ...Object.entries(file).map(([k, v]) => `${k}: ${v}`)]) + "\nMY BODY\n";
  const action = planStructurePatch(spec, existing, opts.base, !!opts.force, null);
  expect(action.type).toBe("patch");
  return action as Extract<FileAction, { type: "patch" }>;
}

const kept = (a: Extract<FileAction, { type: "patch" }>, key: string) => {
  expect(a.content).toBeNull();
  expect(a.changes).toEqual([]);
  const row = (a.rows ?? []).find((r) => r.key === key);
  expect(row?.state).toBe("kept-narrower");
  expect(row?.detail).toBe(a.notes[0]);
  expect(a.fields[key]).toBeUndefined();
  return a.notes;
};

const applied = (a: Extract<FileAction, { type: "patch" }>, key: string) => {
  expect(a.content).not.toBeNull();
  expect(a.changes.some((c) => c.startsWith(`${key} `))).toBe(true);
  expect((a.rows ?? []).some((r) => (r.state as string) === "kept-narrower")).toBe(false);
  expect(a.notes).toEqual([]);
};

describe("agent tools", () => {
  it("a wildcard over named tools of the same server is kept: the case the harness hit", () => {
    const a = plan(
      "agent",
      { tools: "Read, mcp__playwright__*" },
      { tools: "Read, mcp__playwright__browser_navigate, mcp__playwright__browser_snapshot, mcp__playwright__browser_click, mcp__playwright__browser_take_screenshot" },
    );
    expect(kept(a, "tools")).toEqual([
      "tools kept as written: the .at would widen them (+mcp__playwright__*); --force applies the .at's",
    ]);
  });

  it("a bare tool over its parameterised form is kept", () => {
    const a = plan("agent", { tools: "Read, Bash" }, { tools: "Read, Bash(git log:*)" });
    expect(kept(a, "tools")).toEqual(["tools kept as written: the .at would widen them (+Bash); --force applies the .at's"]);
  });

  it("an unknown tool name counts as wider", () => {
    const a = plan("agent", { tools: "Read, Frobnicate" }, { tools: "Read" });
    expect(kept(a, "tools")).toEqual(["tools kept as written: the .at would widen them (+Frobnicate); --force applies the .at's"]);
  });

  it("removing a tool is applied", () => {
    applied(plan("agent", { tools: "Read" }, { tools: "Read, Write" }), "tools");
  });

  it("named tools under the file's wildcard are applied", () => {
    applied(plan("agent", { tools: "Read, mcp__playwright__browser_click" }, { tools: "Read, mcp__playwright__*" }), "tools");
  });

  it("a parameterised form under the file's bare tool is applied", () => {
    applied(plan("agent", { tools: "Bash(git log:*)" }, { tools: "Bash" }), "tools");
  });

  it("stating tools over a file that omits them (every tool inherited) is applied", () => {
    applied(plan("agent", { tools: "Read" }, {}), "tools");
  });

  it("a widening over the value scaffold applied (the file still holds it) is the .at's to make", () => {
    applied(plan("agent", { tools: "Read, mcp__playwright__*" }, { tools: "Read" }, { base: { tools: "Read" } }), "tools");
  });

  it("--force writes the widening", () => {
    applied(plan("agent", { tools: "Read, mcp__playwright__*" }, { tools: "Read" }, { force: true }), "tools");
  });
});

describe("a value that already means every tool", () => {
  it('tools: "*" is every tool, like an omitted key: narrowing it to a list is applied, with no widening line', () => {
    const a = plan("agent", { tools: "Read" }, { tools: '"*"' });
    applied(a, "tools");
    expect(a.changes).toEqual(["tools [*] → [Read]"]);
  });

  it("an .at stating tools: \"*\" over a named list is wider", () => {
    const a = plan("agent", { tools: '"*"' }, { tools: "Read" });
    expect(kept(a, "tools")).toEqual(["tools kept as written: the .at would widen them (+*); --force applies the .at's"]);
  });

  it("mcp__* covers every MCP server's tools (the docs' entry for all MCP tools)", () => {
    applied(plan("agent", { tools: "Read, mcp__github__get_issue" }, { tools: "Read, mcp__*" }), "tools");
    const a = plan("agent", { tools: "Read, mcp__*" }, { tools: "Read, mcp__github__*" });
    expect(kept(a, "tools")).toEqual(["tools kept as written: the .at would widen them (+mcp__*); --force applies the .at's"]);
  });

  it("disallowedTools: dropping mcp__* for one server's wildcard is kept; the reverse is applied", () => {
    kept(plan("agent", { disallowedTools: "mcp__github__*" }, { disallowedTools: "mcp__*" }), "disallowedTools");
    applied(plan("agent", { disallowedTools: "mcp__*" }, { disallowedTools: "mcp__github__*" }), "disallowedTools");
  });
});

describe("agent disallowedTools", () => {
  it("dropping a denial is kept", () => {
    const a = plan("agent", { disallowedTools: "Bash" }, { disallowedTools: "Bash, Write" });
    expect(kept(a, "disallowedTools")).toEqual([
      "disallowedTools kept as written: the .at would widen access by denying less (-Write); --force applies the .at's",
    ]);
  });

  it("adding a denial is applied", () => {
    applied(plan("agent", { disallowedTools: "Bash, Write" }, { disallowedTools: "Bash" }), "disallowedTools");
  });

  it("a denial with a specifier removes the whole tool, so the bare tool denies the same", () => {
    applied(plan("agent", { disallowedTools: "Bash, Write" }, { disallowedTools: "Bash(git push *)" }), "disallowedTools");
  });
});

describe("agent mcpServers", () => {
  it("adding a server is kept", () => {
    const a = plan("agent", { mcpServers: "[playwright, github]" }, { mcpServers: "[playwright]" });
    expect(kept(a, "mcpServers")).toEqual(["mcpServers kept as written: the .at would widen them (+github); --force applies the .at's"]);
  });

  it("adding servers to a file that names none is kept", () => {
    const a = plan("agent", { mcpServers: "[playwright]" }, {});
    expect(kept(a, "mcpServers")).toEqual(["mcpServers kept as written: the .at would widen them (+playwright); --force applies the .at's"]);
  });

  it("removing a server is applied", () => {
    applied(plan("agent", { mcpServers: "[playwright]" }, { mcpServers: "[playwright, github]" }), "mcpServers");
  });
});

describe("agent permissionMode", () => {
  it("default to acceptEdits is kept", () => {
    const a = plan("agent", { permissionMode: "acceptEdits" }, { permissionMode: "default" });
    expect(kept(a, "permissionMode")).toEqual([
      "permissionMode kept as written: the .at would widen it (default → acceptEdits); --force applies the .at's",
    ]);
  });

  it("anything to bypassPermissions is kept", () => {
    kept(plan("agent", { permissionMode: "bypassPermissions" }, { permissionMode: "auto" }), "permissionMode");
  });

  it("dontAsk to default is kept: dontAsk denies what default would ask about", () => {
    kept(plan("agent", { permissionMode: "default" }, { permissionMode: "dontAsk" }), "permissionMode");
  });

  it("a mode over an omitted one (the session's, inherited) is kept unless it is dontAsk", () => {
    kept(plan("agent", { permissionMode: "acceptEdits" }, {}), "permissionMode");
    applied(plan("agent", { permissionMode: "dontAsk" }, {}), "permissionMode");
  });

  it("plan cannot be ranked against default, so it counts as wider", () => {
    const a = plan("agent", { permissionMode: "plan" }, { permissionMode: "default" });
    expect(kept(a, "permissionMode")).toEqual([
      "permissionMode kept as written: the .at's plan cannot be ranked against the file's default, so it counts as wider; --force applies the .at's",
    ]);
  });

  it("lowering a mode is applied", () => {
    applied(plan("agent", { permissionMode: "default" }, { permissionMode: "acceptEdits" }), "permissionMode");
    applied(plan("agent", { permissionMode: "plan" }, { permissionMode: "auto" }), "permissionMode");
    applied(plan("agent", { permissionMode: "dontAsk" }, { permissionMode: "manual" }), "permissionMode");
  });
});

describe("skill and command tool keys", () => {
  it("a skill's allowed-tools gaining a tool is kept", () => {
    const a = plan("skill", { "allowed-tools": "Read, Bash" }, { "allowed-tools": "Read" });
    expect(kept(a, "allowed-tools")).toEqual(["allowed-tools kept as written: the .at would widen them (+Bash); --force applies the .at's"]);
  });

  it("a command's allowed-tools over a file that has none (nothing pre-approved) is kept", () => {
    kept(plan("command", { "allowed-tools": "Bash(git status:*)" }, {}), "allowed-tools");
  });

  it("a skill's allowed-tools losing a tool is applied", () => {
    applied(plan("skill", { "allowed-tools": "Read" }, { "allowed-tools": "Read Bash" }), "allowed-tools");
  });

  it("a skill's disallowed-tools losing a denial is kept, gaining one is applied", () => {
    kept(plan("skill", { "disallowed-tools": "Bash" }, { "disallowed-tools": "Bash, Write" }), "disallowed-tools");
    applied(plan("skill", { "disallowed-tools": "Bash, Write" }, { "disallowed-tools": "Bash" }), "disallowed-tools");
  });
});

describe("keys that grant nothing are patched as before", () => {
  it("model over a file with no base is written", () => {
    applied(plan("agent", { model: "opus" }, { model: "haiku" }), "model");
  });
});

describe("a value scaffold cannot compare counts as wider", () => {
  it("one inline server definition against another is kept", () => {
    const spec: StructureSpec = {
      path: ".claude/agents/scout.md",
      kind: "agent",
      id: "scout",
      content: fm(["name: scout", "mcpServers:", "  - playwright:", "      command: npx"]),
      owned: ["mcpServers"],
      authored: true,
    };
    const existing = fm(["name: scout", "mcpServers:", "  - github:", "      command: npx"]) + "\nBODY\n";
    const a = planStructurePatch(spec, existing, undefined, false, null);
    expect(a.type).toBe("patch");
    if (a.type !== "patch") return;
    expect(a.content).toBeNull();
    expect(a.notes).toEqual([
      "mcpServers kept as written: the .at's value cannot be compared with the file's, so it counts as wider; --force applies the .at's",
    ]);
  });
});
