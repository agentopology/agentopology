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
  it("V153: a reader that is not a declared agent is an error", () => {
    const ast = parse(SRC(`secrets { secret s { path: "x/**", readers: [ghost] } }`));
    const v = validate(ast).filter((r) => r.rule === "V153");
    expect(v).toHaveLength(1);
    expect(v[0].level).toBe("error");
    expect(v[0].message).toContain("ghost");
  });

  it("V153: main and declared agents are accepted", () => {
    const ast = parse(SRC(`secrets { secret s { path: "x/**", readers: [main, writer] } }`));
    expect(validate(ast).filter((r) => r.rule === "V153")).toEqual([]);
  });

  it("V154: a secret with no path is an error", () => {
    const ast = parse(SRC(`secrets { secret s { readers: [writer] } }`));
    const v = validate(ast).filter((r) => r.rule === "V154");
    expect(v).toHaveLength(1);
    expect(v[0].level).toBe("error");
  });
});
