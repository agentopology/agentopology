/**
 * The finish edge: `builder -> lead [finish]` closes the run and hands the
 * line back to the entry agent. It is an end, not a loop, so it needs no
 * [max N]. `meta { outpoints: [...] }` lists the nodes a run may end at.
 */

import { describe, it, expect } from "vitest";
import { parse } from "../index.js";
import { validate } from "../validator.js";
import { claudeCodeBinding } from "../../bindings/index.js";
import { resolveOrder } from "../../resolve/order.js";
import { buildExecutionBrief } from "../../plan/brief.js";
import { renderBriefMarkdown } from "../../plan/render.js";
import type { EdgeDef } from "../ast.js";

const topo = (opts: { meta?: string; flow?: string; records?: string } = {}) => `topology t : [pipeline] {
  meta {
    version: "1.0.0"
    description: "x"
    ${opts.meta ?? "entry: lead"}
  }
  orchestrator {
    model: opus
    handles: [intake]
  }
  action intake {
    kind: inline
    description: "in"
  }
  agent lead {
    model: sonnet
    description: "Leads the session"
    prompt { Lead. }
  }
  agent builder {
    model: sonnet
    description: "Builds"
    prompt { Build. }
  }
  agent checker {
    model: sonnet
    description: "Checks"
    prompt { Check. }
  }
  ${opts.records ?? ""}
  flow {
${opts.flow ?? "    intake -> lead\n    lead -> builder\n    builder -> lead [finish]"}
  }
}`;

const finishOf = (e: EdgeDef) => (e as { finish?: boolean }).finish;
const rules = (src: string, rule: string) => validate(parse(src)).filter((r) => r.rule === rule);

describe("[finish] parses", () => {
  it("marks the edge finish and leaves max empty", () => {
    const edge = parse(topo()).edges.find((e) => e.from === "builder")!;
    expect(finishOf(edge)).toBe(true);
    expect(edge.maxIterations).toBeNull();
  });

  it("combines with a condition", () => {
    const edge = parse(topo({ flow: "    intake -> lead\n    lead -> builder\n    builder -> lead [when builder.ok == yes, finish]" })).edges.find((e) => e.from === "builder")!;
    expect(finishOf(edge)).toBe(true);
    expect(edge.condition).toBe("builder.ok == yes");
  });

  it("an edge without it is not a finish edge", () => {
    expect(finishOf(parse(topo()).edges.find((e) => e.from === "lead")!)).toBeFalsy();
  });
});

describe("meta { outpoints } parses", () => {
  it("reads the list", () => {
    const ast = parse(topo({ meta: "entry: lead\n    outpoints: [builder, checker]" }));
    expect((ast.topology as { outpoints?: string[] }).outpoints).toEqual(["builder", "checker"]);
  });
});

describe("a finish edge needs no [max N] (V6)", () => {
  it("passes V6 and V3", () => {
    const res = validate(parse(topo()));
    expect(res.filter((r) => r.rule === "V6" || r.rule === "V3")).toEqual([]);
  });

  it("the same back-edge without [finish] still fails V6", () => {
    const res = validate(parse(topo({ flow: "    intake -> lead\n    lead -> builder\n    builder -> lead" })));
    expect(res.filter((r) => r.rule === "V6").length).toBeGreaterThan(0);
  });
});

describe("V137: a finish edge must point at the entry agent", () => {
  it("is clean when it does", () => {
    expect(rules(topo(), "V137")).toEqual([]);
  });

  it("errors when it points at another agent", () => {
    const r = rules(topo({ flow: "    intake -> lead\n    lead -> builder\n    builder -> checker [finish]" }), "V137");
    expect(r.length).toBe(1);
    expect(r[0].level).toBe("error");
    expect(r[0].message).toContain("lead");
  });

  it("errors when the topology has no entry agent", () => {
    const r = rules(topo({ meta: "" }), "V137");
    expect(r.length).toBe(1);
    expect(r[0].level).toBe("error");
    expect(r[0].message).toContain("entry");
  });
});

describe("V138: outpoints", () => {
  it("errors on an undeclared node", () => {
    const r = rules(topo({ meta: "entry: lead\n    outpoints: [builder, ghost]" }), "V138");
    expect(r.filter((x) => x.level === "error").length).toBe(1);
    expect(r[0].message).toContain("ghost");
  });

  it("warns on a node with no outgoing edge that is not listed", () => {
    const src = topo({ meta: "entry: lead\n    outpoints: [builder]", flow: "    intake -> lead\n    lead -> builder\n    lead -> checker" });
    const r = rules(src, "V138").filter((x) => x.level === "warning");
    expect(r.map((x) => x.node)).toEqual(["checker"]);
  });

  it("is quiet when every end is listed, and when no outpoints are declared", () => {
    const flow = "    intake -> lead\n    lead -> builder\n    lead -> checker";
    expect(rules(topo({ meta: "entry: lead\n    outpoints: [builder, checker]", flow }), "V138")).toEqual([]);
    expect(rules(topo({ flow }), "V138")).toEqual([]);
  });
});

describe("the generated flow text marks finish edges", () => {
  const text = (src: string) =>
    claudeCodeBinding.scaffold(parse(src)).map((f) => f.content).join("\n");

  it("writes [finish] on the edge", () => {
    expect(text(topo())).toMatch(/builder -> lead \[finish\]/);
  });

  it("with a ledger, tells the step before a finish edge to write the closed row", () => {
    const src = topo({ records: `records {\n    record trace { path: "logs/trace.jsonl" }\n  }` });
    const out = text(src);
    expect(out).toContain('{"run": "closed"');
    expect(out).toContain("logs/trace.jsonl");
  });

  it("without a ledger, writes no closed row", () => {
    expect(text(topo())).not.toContain('"run": "closed"');
  });
});

describe("plan and order treat a finish edge as an end, not a loop", () => {
  it("resolveOrder reports no loop and no unreachable node", () => {
    const o = resolveOrder(parse(topo()));
    expect(parse(topo()).edges.some((e) => e.from === "builder" && e.to === "lead")).toBe(true);
    expect(o.loops).toEqual([]);
    expect(o.unreachable).toEqual([]);
  });

  it("the plan says No loops", () => {
    expect(renderBriefMarkdown(buildExecutionBrief(parse(topo())))).toContain("No loops.");
  });
});
