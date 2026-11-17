/**
 * One meaning per `permissions:` word.
 *
 * Each word compiles to one Claude Code `permissionMode` (or none), and a word
 * whose compile differs from what it reads as says so (V132):
 * - `auto` is Claude Code's auto mode (a classifier approves actions without
 *   asking). It is not a short form of `autonomous`, which leaves the mode to
 *   the session.
 * - `interactive` asks, as documented: it no longer compiles to `acceptEdits`
 *   (which approved file edits without asking), and the warning says how to
 *   keep the old value.
 * Claude Code's own values pass through unchanged and without a warning.
 */

import { describe, it, expect } from "vitest";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { claudeCodeBinding } from "../claude-code.js";
import { topics } from "../../docs/content.js";

const topo = (perm: string) => `topology t : [pipeline] {
  meta {
    version: "1.0.0"
    description: "x"
  }
  orchestrator {
    model: opus
    handles: [intake]
  }
  action intake {
    kind: inline
    description: "in"
  }
  agent a {
    model: sonnet
    description: "worker"
    permissions: ${perm}
    prompt { Do the work. }
  }
  flow {
    intake -> a
  }
}`;

function build(perm: string) {
  const ast = parse(topo(perm));
  const results = validate(ast);
  const files = claudeCodeBinding.scaffold(ast);
  const agent = files.find((f) => f.path === ".claude/agents/a/AGENT.md")?.content ?? "";
  const fm = agent.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  const mode = fm.match(/^permissionMode:\s*(.+)$/m)?.[1]?.trim();
  return { ast, results, agent, fm, mode, v132: results.filter((r) => r.rule === "V132"), v27: results.filter((r) => r.rule === "V27") };
}

const AUTO_WARNING =
  'Agent "a": `permissions: auto` is Claude Code\'s auto mode (a classifier approves actions without asking), not `autonomous`; write `autonomous` for the session\'s own mode.';
const INTERACTIVE_WARNING =
  'Agent "a": `permissions: interactive` now leaves permissionMode out, so Claude Code asks as documented; it compiled to `permissionMode: acceptEdits` before (file edits and common filesystem commands approved without asking). Write `permissions: acceptEdits` to keep it.';

describe("permissions: auto stays Claude Code's auto mode and says so", () => {
  it("compiles to permissionMode: auto", () => {
    expect(build("auto").mode).toBe("auto");
  });

  it("warns (V132) that auto is not autonomous", () => {
    const b = build("auto");
    expect(b.v132).toHaveLength(1);
    expect(b.v132[0]).toMatchObject({ level: "warning", node: "a", message: AUTO_WARNING });
    expect(b.v27).toEqual([]);
  });
});

describe("permissions: interactive asks, and the change is loud", () => {
  it("writes no permissionMode", () => {
    const b = build("interactive");
    expect(b.mode).toBeUndefined();
    expect(b.fm).not.toContain("acceptEdits");
  });

  it("warns (V132) naming acceptEdits as the old value and how to keep it", () => {
    const b = build("interactive");
    expect(b.v132).toHaveLength(1);
    expect(b.v132[0]).toMatchObject({ level: "warning", node: "a", message: INTERACTIVE_WARNING });
    expect(b.v132[0].message).toContain("permissions: acceptEdits");
  });
});

describe("Claude Code's own values pass through without a warning", () => {
  for (const [word, mode] of [
    ["acceptEdits", "acceptEdits"],
    ["dontAsk", "dontAsk"],
    ["bypassPermissions", "bypassPermissions"],
    ["plan", "plan"],
    ["default", undefined],
  ] as const) {
    it(`permissions: ${word} -> ${mode ?? "omitted"}, no V132, no V27`, () => {
      const b = build(word);
      expect(b.mode).toBe(mode);
      expect(b.v132).toEqual([]);
      expect(b.v27).toEqual([]);
    });
  }
});

describe("the full table of words is pinned", () => {
  const table: Array<[string, string | undefined, boolean]> = [
    // word, permissionMode, V132 warns
    ["autonomous", undefined, false],
    ["auto", "auto", true],
    ["interactive", undefined, true],
    ["confirm", undefined, false],
    ["supervised", "plan", false],
    ["plan", "plan", false],
    ["unrestricted", "bypassPermissions", false],
    ["bypass", "bypassPermissions", false],
    ["acceptEdits", "acceptEdits", false],
  ];
  for (const [word, mode, warns] of table) {
    it(`${word} -> ${mode ?? "omitted"}${warns ? " (V132)" : ""}`, () => {
      const b = build(word);
      expect(b.mode).toBe(mode);
      expect(b.v132.length > 0).toBe(warns);
      expect(b.v27).toEqual([]);
    });
  }

  it("an agent with no permissions writes no permissionMode and no V132", () => {
    const ast = parse(topo("autonomous").replace("    permissions: autonomous\n", ""));
    expect(validate(ast).filter((r) => r.rule === "V132")).toEqual([]);
    const agent = claudeCodeBinding.scaffold(ast).find((f) => f.path === ".claude/agents/a/AGENT.md")?.content ?? "";
    expect(agent).not.toMatch(/^permissionMode:/m);
  });
});

describe("docs: auto is not the short form of autonomous", () => {
  const agentDoc = topics["agent"]?.content() ?? "";

  it("the agent topic does not pair autonomous with auto", () => {
    expect(agentDoc).not.toMatch(/\|\s*autonomous\s*\|\s*auto\s*\|/);
  });

  it("the agent topic says what auto is and names V132", () => {
    expect(agentDoc).toMatch(/`?auto`?[^\n]*classifier/);
    expect(agentDoc).toContain("V132");
  });

  it("the agent topic says interactive asks (no acceptEdits) and how to keep acceptEdits", () => {
    expect(agentDoc).toMatch(/interactive[^\n]*acceptEdits/);
  });

  it("the V27 entry no longer lists autonomous/auto as one mode", () => {
    const all = Object.values(topics).map((t) => t.content()).join("\n");
    expect(all).not.toContain("autonomous/auto");
  });
});
