import { describe, it, expect } from "vitest";
import { parse } from "../index.js";
import { validate } from "../validator.js";

const SRC = (extra = "", agentExtra = "", toolFields = "") => `topology t : [pipeline] {
  orchestrator {
    model: opus
    handles: [a]
  }
  action a { kind: inline }
  agent reviewer {
    model: opus
    ${toolFields}
    ${agentExtra}
  }
  agent writer {
    model: opus
  }
  flow { a -> reviewer -> writer }
  ${extra}
}`;

describe("per-agent walls: parsing", () => {
  it("reads never-reads on an agent", () => {
    const ast = parse(SRC("", `never-reads: [".env", "secrets/**"]`));
    const agent = ast.nodes.find((n) => n.id === "reviewer") as { neverReads?: string[] };
    expect(agent.neverReads).toEqual([".env", "secrets/**"]);
  });

  it("reads a secrets block", () => {
    const ast = parse(SRC(`secrets {
    secret prod-keys { path: "config/prod/**", readers: [writer, main] }
  }`));
    expect((ast as { secrets?: unknown }).secrets).toEqual([{ id: "prod-keys", path: "config/prod/**", readers: ["writer", "main"] }]);
  });

  it("does not report never-reads or secrets as unknown", () => {
    const ast = parse(SRC(`secrets { secret s { path: "x/**", readers: [writer] } }`, `never-reads: ["a"]`));
    const res = validate(ast);
    expect(res.filter((r) => /unknown|not a (known )?field/i.test(r.message))).toEqual([]);
  });
});

describe("per-agent walls: validation", () => {
  it("V137: a reader that is not a declared agent is an error", () => {
    const ast = parse(SRC(`secrets { secret s { path: "x/**", readers: [ghost] } }`));
    const v = validate(ast).filter((r) => r.rule === "V137");
    expect(v).toHaveLength(1);
    expect(v[0].level).toBe("error");
    expect(v[0].message).toContain("ghost");
  });

  it("V137: main and declared agents are accepted", () => {
    const ast = parse(SRC(`secrets { secret s { path: "x/**", readers: [main, writer] } }`));
    expect(validate(ast).filter((r) => r.rule === "V137")).toEqual([]);
  });

  it("V138: a secret with no path is an error", () => {
    const ast = parse(SRC(`secrets { secret s { readers: [writer] } }`));
    const v = validate(ast).filter((r) => r.rule === "V138");
    expect(v).toHaveLength(1);
    expect(v[0].level).toBe("error");
  });
});

describe("tools and disallowed-tools together", () => {
  it("[I4] are no longer refused, and both are written to the agent file", async () => {
    const ast = parse(SRC("", "", `tools: [Read, Grep]\n    disallowed-tools: [Bash]`));
    expect(validate(ast).filter((r) => r.rule === "V14")).toEqual([]);
    const { claudeCodeBinding } = await import("../../bindings/claude-code.js");
    const files = claudeCodeBinding.scaffold(ast);
    const f = files.find((x) => x.path === ".claude/agents/reviewer/AGENT.md")!;
    expect(f.content).toMatch(/^tools: Read, Grep$/m);
    expect(f.content).toMatch(/^disallowedTools: Bash$/m);
  });

  it("warns when the same tool is in both lists", () => {
    const ast = parse(SRC("", "", `tools: [Read, Bash]\n    disallowed-tools: [Bash]`));
    const v = validate(ast).filter((r) => r.rule === "V14");
    expect(v).toHaveLength(1);
    expect(v[0].level).toBe("warning");
    expect(v[0].message).toContain("Bash");
  });
});
