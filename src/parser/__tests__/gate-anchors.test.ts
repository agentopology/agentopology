/**
 * Multi-anchor gates — one declaration, many attachment points.
 *
 * A repeated verification ritual copied per lane will drift, and the whole
 * value of a ritual is that it is identical everywhere. `after: [a, b, c]`
 * makes it one declaration.
 *
 * **The risk this file exists for is SILENCE.** An audit found ~18 sites that
 * would accept an array without complaint and mis-handle it: a hook matcher
 * would ship `["a","b"]` into settings.json and never fire, `g.after === id`
 * would never match, ~12 lookups inside the visualizer's untyped browser-JS
 * template literal would miss, and the round-trip serializer would emit
 * `after: a,b` which re-parses as the single id `"a,b"`.
 *
 * TypeScript catches 4 of those. These tests cover the rest.
 */

import { describe, it, expect } from "vitest";
import { parse } from "../index.js";
import { validate } from "../validator.js";
import { gateAnchors } from "../ast.js";
import { resolveOrder } from "../../resolve/order.js";
import { bindings } from "../../bindings/index.js";
import { serializeAST } from "../../import/serializer.js";
import { generateVisualization } from "../../visualizer/index.js";
import type { GateNode } from "../ast.js";

const MULTI = `topology t : [pipeline] {
  meta {
    version: "1.0.0"
    description: "one ritual, three lanes"
  }
  agent lane-a {
    model: sonnet
    description: "a"
  }
  agent lane-b {
    model: sonnet
    description: "b"
  }
  agent lane-c {
    model: sonnet
    description: "c"
  }
  action start {
    kind: inline
    description: "in"
  }
  gates {
    gate supervisor-verify {
      after: [lane-a, lane-b, lane-c]
      run: "scripts/verify.sh"
      on-fail: bounce-back
    }
  }
  flow { start -> [lane-a, lane-b, lane-c] }
}`;

const SINGLE = MULTI.replace("after: [lane-a, lane-b, lane-c]", "after: lane-a");

describe("gateAnchors normalises the union", () => {
  it("returns a list for both forms", () => {
    expect(gateAnchors({ after: "a" }, "after")).toEqual(["a"]);
    expect(gateAnchors({ after: ["a", "b"] }, "after")).toEqual(["a", "b"]);
    expect(gateAnchors({}, "after")).toEqual([]);
  });

  it("parses the list form, and the scalar form still works", () => {
    const multi = parse(MULTI).nodes.find((n) => n.type === "gate") as GateNode;
    expect(gateAnchors(multi, "after")).toEqual(["lane-a", "lane-b", "lane-c"]);
    const single = parse(SINGLE).nodes.find((n) => n.type === "gate") as GateNode;
    expect(gateAnchors(single, "after")).toEqual(["lane-a"]);
  });

  it("validates every element, not just the first", () => {
    const bad = MULTI.replace("after: [lane-a, lane-b, lane-c]", "after: [lane-a, nowhere]");
    const v13 = validate(parse(bad)).filter((r) => r.rule === "V13");
    expect(v13).toHaveLength(1);
    expect(v13[0].message).toContain("nowhere");
    // and the valid form stays clean
    expect(validate(parse(MULTI)).filter((r) => r.rule === "V13")).toEqual([]);
  });
});

describe("one gate step per anchor", () => {
  it("splices the gate after each named node", () => {
    const gateSteps = resolveOrder(parse(MULTI)).steps.filter((s) => s.kind === "gate");
    expect(gateSteps).toHaveLength(3);
    for (const s of gateSteps) expect(s.ids).toEqual(["supervisor-verify"]);
  });

  it("a single-anchor gate still splices exactly once", () => {
    expect(resolveOrder(parse(SINGLE)).steps.filter((s) => s.kind === "gate")).toHaveLength(1);
  });
});

describe("SILENT class 1 — a hook matcher must stay a string", () => {
  it("claude-code emits one SubagentStop entry per anchor, each a string", () => {
    // An array here type-checks clean through Record<string, unknown>, lands in
    // settings.json, and the hook simply never fires. The gate looks wired.
    const settings = bindings["claude-code"]
      .scaffold(parse(MULTI))
      .find((f) => f.path.endsWith("settings.json"))!;
    const json = JSON.parse(settings.content) as {
      hooks?: Record<string, Array<{ matcher?: unknown }>>;
    };
    const stop = json.hooks?.SubagentStop ?? [];
    const matchers = stop.map((e) => e.matcher);

    for (const m of matchers) {
      expect(typeof m, `matcher must be a string, got ${JSON.stringify(m)}`).toBe("string");
    }
    expect(matchers).toEqual(expect.arrayContaining(["lane-a", "lane-b", "lane-c"]));
  });
});

describe("SILENT class 2 — reference equality still matches", () => {
  it("the visualizer payload carries a STRING its browser code can look up", () => {
    // Everything downstream of the payload is a template literal TypeScript
    // never checks — `positions[gate.after]` and `g.after === nodeId`. An array
    // coerces to "a,b" on lookup and never satisfies the equality, so the gate
    // silently disappears from the graph.
    const out = generateVisualization(parse(MULTI));
    const m = /"id":\s*"supervisor-verify"[^}]*?"after":\s*("(?:[^"\\]|\\.)*"|\[)/.exec(out);
    expect(m, "gate payload should contain an after field").not.toBeNull();
    expect(m![1].startsWith("["), `after must be a string, got ${m![1]}`).toBe(false);
    // the full list is still available under a separate key
    expect(out).toContain("afterAll");
  });
});

describe("SILENT class 3 — the round trip does not corrupt", () => {
  it("re-parses a multi-anchor gate as a LIST, not one id", () => {
    // `after: a,b` would come back as the single id "a,b".
    const round = parse(serializeAST(parse(MULTI)));
    const gate = round.nodes.find((n) => n.type === "gate") as GateNode;
    expect(gateAnchors(gate, "after")).toEqual(["lane-a", "lane-b", "lane-c"]);
  });

  it("re-parses a single-anchor gate unchanged", () => {
    const round = parse(serializeAST(parse(SINGLE)));
    const gate = round.nodes.find((n) => n.type === "gate") as GateNode;
    expect(gateAnchors(gate, "after")).toEqual(["lane-a"]);
  });
});

describe("every binding survives a multi-anchor gate", () => {
  it("scaffolds without throwing, and never emits a joined 'a,b,c' anywhere", () => {
    const ast = parse(MULTI);
    for (const [name, binding] of Object.entries(bindings)) {
      const files = binding.scaffold(ast);
      expect(files.length, name).toBeGreaterThan(0);
      for (const f of files) {
        expect(
          f.content.includes("lane-a,lane-b,lane-c"),
          `${name}/${f.path} joined the anchors into one string`
        ).toBe(false);
      }
    }
  });
});

describe("cursor's preToolUse matcher names the node it runs BEFORE", () => {
  it("matches the before-anchor, not the after-anchor", () => {
    // Found by byte-diffing scaffold output across this change. Cursor selects
    // `preToolUse` BECAUSE `before` is set, then matched on `after` — so a
    // pre-hook fired before the wrong node. `simple-pipeline`'s quality-check
    // is `after: writer, before: reviewer` and emitted `matcher: "writer"`.
    const src = `topology t : [pipeline] {
      meta {
        version: "1.0.0"
        description: "x"
      }
      agent writer {
        model: sonnet
        description: "w"
      }
      agent reviewer {
        model: opus
        description: "r"
      }
      action start {
        kind: inline
        description: "in"
      }
      gates {
        gate quality {
          after: writer
          before: reviewer
          run: "scripts/q.sh"
        }
      }
      flow { start -> writer
             writer -> reviewer }
    }`;
    const hooks = bindings["cursor"]
      .scaffold(parse(src))
      .find((f) => f.path.endsWith("hooks.json"))!;
    const json = JSON.parse(hooks.content) as {
      hooks: Record<string, Array<{ matcher?: string }>>;
    };
    expect(json.hooks.preToolUse?.[0].matcher).toBe("reviewer");
  });
});
