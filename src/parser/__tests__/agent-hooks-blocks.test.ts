/**
 * An agent may write `hooks { }` more than once. Placement is 0.11.4's: the
 * first block's hooks belong to the agent (its file's frontmatter); a second
 * and later block's hooks go to settings.json under the script name
 * `<hook>.sh`, beside the top-level hooks, in file order. A second block
 * used to validate and vanish from every file.
 * A hook name used in two of one agent's blocks is an error (V23), twice in
 * one block a warning, the same rule as top-level hooks.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "../index.js";
import { validate } from "../validator.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import type { AgentNode } from "../ast.js";

const hook = (name: string, on: string): string =>
  `      hook ${name} {\n        on: ${on}\n        matcher: "Bash"\n        run: "scripts/${name}.sh"\n      }\n`;
const block = (...hs: string[]): string => `    hooks {\n${hs.join("")}    }\n`;

const topo = (agentHooks: string, extra = ""): string => `topology t : [pipeline] {
  meta {
    version: "1.0.0"
    description: "agent hooks"
  }
  agent alpha {
    description: "Alpha"
    model: sonnet
${agentHooks}    prompt {
      x
    }
  }
  agent beta {
    model: haiku
    prompt {
      Do beta.
    }
  }
${extra}
  flow {
    alpha -> beta
  }
}
`;

const alpha = (src: string): AgentNode => parse(src).nodes.find((n) => n.id === "alpha") as AgentNode;
const files = (src: string) => claudeCodeBinding.scaffold(parse(src));

describe("two hooks { } blocks inside one agent", () => {
  const src = topo(block(hook("a1", "PreToolUse")) + block(hook("a2", "PostToolUse")));

  it("the first block's hooks are the agent's, the second block's are project hooks (as in 0.11.4)", () => {
    expect(alpha(src).hooks?.map((h) => h.name)).toEqual(["a1"]);
    expect(parse(src).hooks.map((h) => h.name)).toEqual(["a2"]);
  });

  it("validate has no error and no warning about them", () => {
    const rs = validate(parse(src)).filter((r) => /a1|a2|hooks/.test(r.message));
    expect(rs).toEqual([]);
  });

  it("scaffold is byte for byte 0.11.4's for the same file", () => {
    const golden = JSON.parse(
      readFileSync(new URL("../../__tests__/e2e/differential/agent-hooks-0114.json", import.meta.url), "utf-8"),
    ) as { at: string; files: Record<string, string> };
    const out = Object.fromEntries(claudeCodeBinding.scaffold(parse(golden.at)).map((f) => [f.path, f.content]));
    for (const [p, content] of Object.entries(golden.files)) expect(out[p], p).toBe(content);
    // Nothing beyond 0.11.4's files: no agent-scoped copy of the second block's hook.
    expect(Object.keys(out).filter((p) => p.startsWith(".claude/") && !(p in golden.files))).toEqual([]);
  });

  it("three blocks with other fields between them: none is dropped", () => {
    const s = topo(block(hook("a1", "PreToolUse")) + "    tools: [Read]\n" + block(hook("a2", "PostToolUse")) + block(hook("a3", "Stop")));
    expect(alpha(s).hooks?.map((h) => h.name)).toEqual(["a1"]);
    expect(parse(s).hooks.map((h) => h.name)).toEqual(["a2", "a3"]);
    expect(alpha(s).tools).toEqual(["Read"]);
  });

  it("an empty first block: the second block's hooks are project hooks (as in 0.11.4)", () => {
    const s = topo(block() + block(hook("a2", "PostToolUse")));
    expect(alpha(s).hooks).toBeUndefined();
    expect(parse(s).hooks.map((h) => h.name)).toEqual(["a2"]);
  });

  it("a hook name in two of one agent's blocks is a V23 error naming the agent and the hook", () => {
    const s = topo(block(hook("a1", "PreToolUse")) + block(hook("a1", "PostToolUse")));
    const errs = validate(parse(s)).filter((r) => r.level === "error" && r.rule === "V23");
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toContain('"a1"');
    expect(errs[0].message).toContain('"alpha"');
  });

  it("a name in an agent's second and third block is one V23 error, not two", () => {
    const s = topo(block(hook("a1", "PreToolUse")) + block(hook("a2", "PostToolUse")) + block(hook("a2", "Stop")));
    expect(validate(parse(s)).filter((r) => r.rule === "V23")).toHaveLength(1);
  });

  it("a hook name twice in one agent block stays a warning, and both hooks are kept (as in 0.11.4)", () => {
    const s = topo(block(hook("a1", "PreToolUse"), hook("a1", "PostToolUse")));
    const rs = validate(parse(s)).filter((r) => r.rule === "V23");
    expect(rs.map((r) => r.level)).toEqual(["warning"]);
    expect(alpha(s).hooks?.map((h) => h.on)).toEqual(["PreToolUse", "PostToolUse"]);
  });

  it("the same hook name in two different agents is not a duplicate", () => {
    const s = topo(block(hook("g", "PreToolUse"))).replace("  agent beta {\n    model: haiku\n", `  agent beta {\n    model: haiku\n${block(hook("g", "PreToolUse"))}`);
    expect(validate(parse(s)).filter((r) => r.rule === "V23")).toEqual([]);
  });

  it("a top-level hooks block beside them: both arrive in settings.json, in file order", () => {
    const top = `  hooks {\n${hook("t1", "Stop").replace(/^ {2}/gm, "")}  }\n`;
    const s = topo(block(hook("a1", "PreToolUse")) + block(hook("a2", "PostToolUse")), top);
    expect(parse(s).hooks.map((h) => h.name)).toEqual(["a2", "t1"]);
    expect(alpha(s).hooks?.map((h) => h.name)).toEqual(["a1"]);
    const settings = files(s).find((f) => f.path === ".claude/settings.json")!.content;
    expect(settings).toContain("scripts/a2.sh");
    expect(settings).toContain("scripts/t1.sh");
  });

  it("a top-level hook named like an agent's second-block hook is a V23 error", () => {
    const top = `  hooks {\n${hook("a2", "Stop").replace(/^ {2}/gm, "")}  }\n`;
    const s = topo(block(hook("a1", "PreToolUse")) + block(hook("a2", "PostToolUse")), top);
    expect(validate(parse(s)).filter((r) => r.rule === "V23" && r.level === "error")).toHaveLength(1);
  });
});
