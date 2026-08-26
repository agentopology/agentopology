/**
 * `thinking` IS the reasoning-effort field.
 *
 * First-contact feedback asked for an `effort` field beside `model`. An audit
 * found `AgentNode.thinking` already existed AND that codex already compiled it
 * to `model_reasoning_effort`. Adding a second field would have given the
 * language two words for one concept — the exact failure mode the anti-KPIs
 * name. So: zero new vocabulary, three real fixes.
 */

import { describe, it, expect } from "vitest";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { bindings } from "../index.js";

const at = (thinking: string, extra = "") => `topology t : [pipeline] {
  meta {
    version: "1.0.0"
    description: "x"
  }
  agent a {
    model: opus
    description: "a"
    thinking: ${thinking}${extra}
  }
  action i {
    kind: inline
    description: "in"
  }
  flow { i -> a }
}`;

const WORKFLOW_EXT = `
    extensions {
      claude-workflow {
        execution: workflow
      }
    }`;

describe("thinking accepts the full effort ladder", () => {
  it("accepts xhigh, which modern routing exposes and the enum lacked", () => {
    expect(validate(parse(at("xhigh"))).filter((r) => r.rule === "V35")).toEqual([]);
  });

  it("still accepts every previously valid level", () => {
    for (const t of ["off", "low", "medium", "high", "max"]) {
      expect(validate(parse(at(t))).filter((r) => r.rule === "V35"), t).toEqual([]);
    }
  });

  it("still rejects a level that does not exist", () => {
    expect(validate(parse(at("ludicrous"))).filter((r) => r.rule === "V35")).toHaveLength(1);
  });
});

describe("codex maps every level to a DISTINCT value", () => {
  const effortOf = (thinking: string) => {
    const f = bindings["codex"]
      .scaffold(parse(at(thinking)))
      .find((x) => x.path.endsWith("agents/a.toml"))!;
    return /model_reasoning_effort = "(\w+)"/.exec(f.content)?.[1];
  };

  it("no longer collapses max onto high", () => {
    // `max` returned "high", so max and xhigh had no distinct Codex value.
    expect(effortOf("max")).toBe("max");
    expect(effortOf("xhigh")).toBe("xhigh");
    expect(effortOf("high")).toBe("high");
    expect(new Set(["max", "xhigh", "high"]).size).toBe(3);
  });

  it("omits the key entirely for off", () => {
    expect(effortOf("off")).toBeUndefined();
  });
});

describe("claude-workflow emits effort — the option its runtime accepts", () => {
  const script = (thinking: string) =>
    bindings["claude-workflow"]
      .scaffold(parse(at(thinking, WORKFLOW_EXT)))
      .find((f) => f.path.endsWith(".js"))?.content ?? "";

  it("passes thinking through as the agent() effort option", () => {
    // This binding emitted nothing for it and never read agent.thinking at all,
    // so a declared reasoning level was dropped on the one target that can
    // honour it natively.
    expect(script("xhigh")).toContain("effort: 'xhigh'");
  });

  it("omits effort when thinking is off", () => {
    const s = script("off");
    expect(s.length).toBeGreaterThan(0);
    expect(s).not.toContain("effort:");
  });
});

describe("no `effort` field was added to the language", () => {
  it("rejects `effort` as an agent field rather than silently accepting it", () => {
    // Two words for one concept is the failure mode. If someone writes
    // `effort:` expecting it to work, they should find out.
    const src = at("high").replace("thinking: high", "effort: high");
    const ast = parse(src);
    const agent = ast.nodes.find((n) => n.id === "a") as unknown as Record<string, unknown>;
    expect(agent.effort, "no effort field should exist on the AST").toBeUndefined();
  });
});
