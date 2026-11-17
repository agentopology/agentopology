/**
 * How `scaffold --allow-invalid` attributes validation errors, and which
 * planned writes it turns into skips.
 */

import { describe, it, expect } from "vitest";
import { parse } from "../../parser/index.js";
import type { ValidationResult } from "../../parser/validator.js";
import { agentOwnedPaths, scopeErrors, scopePlan, WHILE_ERRORS_OPEN } from "../invalid-scope.js";
import type { FileAction } from "../types.js";

const AT = `topology t : [pipeline] {
  meta { version: "1.0.0"
    description: "attribution" }
  orchestrator { model: sonnet }
  agent a { model: sonnet
    prompt { A. }
    hooks {
      hook a-check {
        on: PreToolUse
        matcher: "Bash"
        run: "scripts/a-check.sh"
        type: command
      }
    }
  }
  agent b { model: sonnet
    prompt { B. } }
  agent c { model: sonnet
    file: .claude/agents/c.md }
  action ship { kind: report
    description: "ship" }
  flow { a -> b
    b -> c
    c -> ship }
  gates {
    gate check-b {
      after: a
      before: b
      run: "scripts/check-b.sh"
    }
  }
  hooks {
    hook log {
      on: AgentStop
      run: "scripts/log.sh"
      type: command
    }
  }
}
`;
const ast = parse(AT);
const err = (rule: string, node?: string): ValidationResult => ({ rule, level: "error", message: "x", ...(node ? { node } : {}) });

describe("scopeErrors", () => {
  it("an agent's own name, a dotted name under it, and its hook's name reach that agent", () => {
    expect([...scopeErrors(ast, [err("V15", "a")]).erroredAgents]).toEqual(["a"]);
    expect([...scopeErrors(ast, [err("V23", "b.notes")]).erroredAgents]).toEqual(["b"]);
    expect([...scopeErrors(ast, [err("V96", "a-check")]).erroredAgents]).toEqual(["a"]);
  });

  it("a gate reaches the agents it is placed on", () => {
    expect([...scopeErrors(ast, [err("V30", "check-b")]).erroredAgents].sort()).toEqual(["a", "b"]);
  });

  it("an action or a topology hook reaches no agent (its files are shared and wait anyway)", () => {
    const s = scopeErrors(ast, [err("V40", "ship"), err("V96", "log")]);
    expect(s.topologyLevel).toEqual([]);
    expect(s.erroredAgents.size).toBe(0);
  });

  it("no node, the orchestrator, or an undeclared name is topology level", () => {
    expect(scopeErrors(ast, [err("V17")]).topologyLevel).toHaveLength(1);
    expect(scopeErrors(ast, [err("V7", "orchestrator")]).topologyLevel).toHaveLength(1);
    expect(scopeErrors(ast, [err("V3", "ghost")]).topologyLevel).toHaveLength(1);
  });
});

describe("scopePlan", () => {
  const owners = agentOwnedPaths(ast, "claude-code");

  it("owns each agent's file, its file: path and its own hook scripts, nothing shared", () => {
    expect(owners.get(".claude/agents/a/AGENT.md")).toBe("a");
    expect(owners.get(".claude/skills/t/scripts/a-a-check.sh")).toBe("a");
    expect(owners.get(".claude/agents/c.md")).toBe("c");
    expect(owners.has(".claude/settings.json")).toBe(false);
    expect(owners.has(".claude/skills/t/scripts/check-b.sh")).toBe(false);
  });

  it("turns every write the errors touch into a skip, keeps clean agents' writes and every non-write", () => {
    const actions: FileAction[] = [
      { type: "create", path: ".claude/agents/a/AGENT.md", content: "" },
      { type: "update", path: ".claude/agents/b/AGENT.md", content: "", detail: "regenerated" },
      { type: "patch", path: ".claude/agents/c.md", content: "---\n---\n", changes: ["model"], notes: [], fields: {} },
      { type: "update", path: ".claude/settings.json", content: "{}", detail: "config merged" },
      { type: "create", path: ".mcp.json", content: "{}" },
      { type: "unchanged", path: ".claude/rules/t.md" },
      { type: "delete", path: ".claude/agents/old/AGENT.md" },
    ];
    const noPrune = scopePlan(actions, owners, new Set(["a"]), false);
    expect(noPrune.actions.map((x) => [x.type, x.path, x.type === "blocked" ? x.detail : ""])).toEqual([
      ["blocked", ".claude/agents/a/AGENT.md", "not written: node a has validation errors"],
      ["update", ".claude/agents/b/AGENT.md", ""],
      ["patch", ".claude/agents/c.md", ""],
      ["blocked", ".claude/settings.json", WHILE_ERRORS_OPEN],
      ["blocked", ".mcp.json", WHILE_ERRORS_OPEN],
      ["unchanged", ".claude/rules/t.md", ""],
      ["delete", ".claude/agents/old/AGENT.md", ""],
    ]);
    // With --prune a delete is a write too, and it waits.
    const pruned = scopePlan(actions, owners, new Set(["a"]), true);
    expect(pruned.actions[6]).toEqual({ type: "blocked", path: ".claude/agents/old/AGENT.md", detail: WHILE_ERRORS_OPEN });
    expect(pruned.skipped).toEqual([".claude/agents/a/AGENT.md", ".claude/settings.json", ".mcp.json", ".claude/agents/old/AGENT.md"]);
  });
});
