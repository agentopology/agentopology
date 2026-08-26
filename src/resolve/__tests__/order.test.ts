import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import { computeLayers } from "../../analyzer/index.js";
import { resolveOrder } from "../order.js";

const example = (name: string) =>
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../examples", name), "utf8");

describe("resolveOrder", () => {
  it("does NOT leave gates at depth 0 the way raw computeLayers does", () => {
    // Regression for the whole reason this module exists. Gates bind by
    // after:/before:, never by edges, so their in-degree is 0 and Kahn ranks
    // them as sources. Measured: `human-approval` lands in layer 0 next to the
    // entry action, which would run a post-review gate before any review.
    const ast = parse(example("code-review.at"));
    const allIds = new Set(ast.nodes.map((n) => n.id));
    const raw = computeLayers(ast.edges, allIds);
    expect(raw[0].nodes).toContain("human-approval");

    const { steps } = resolveOrder(ast);
    const gateStep = steps.find((s) => s.kind === "gate")!;
    const reviewerStep = steps.find((s) => s.ids.includes("reviewer"))!;
    expect(gateStep.index).toBeGreaterThan(reviewerStep.index);
  });

  it("splices a gate immediately after its `after` anchor", () => {
    const ast = parse(example("simple-pipeline.at"));
    const { steps } = resolveOrder(ast);
    const writer = steps.find((s) => s.ids.includes("writer"))!;
    const gate = steps.find((s) => s.ids.includes("quality-check"))!;
    expect(gate.index).toBe(writer.index + 1);
    expect(gate.depth).toBeNull();
  });

  it("groups a parallel layer into one step", () => {
    const { steps } = resolveOrder(parse(example("code-review.at")));
    const fanout = steps.find((s) => s.ids.length > 1)!;
    expect(fanout.kind).toBe("spawn");
    expect(fanout.ids.sort()).toEqual(["analyzer", "security-scanner"]);
  });

  it("never mixes node kinds in one step", () => {
    for (const f of ["code-review.at", "simple-pipeline.at", "data-processing.at"]) {
      const ast = parse(example(f));
      const byType = new Map(ast.nodes.map((n) => [n.id, n.type]));
      for (const step of resolveOrder(ast).steps) {
        const types = new Set(step.ids.map((id) => byType.get(id)));
        expect(types.size, `${f} step ${step.index}`).toBe(1);
      }
    }
  });

  it("excludes the orchestrator from steps and names it as the host", () => {
    const { steps, orchestrator } = resolveOrder(parse(example("simple-pipeline.at")));
    expect(orchestrator).toBe("orchestrator");
    expect(steps.some((s) => s.ids.includes("orchestrator"))).toBe(false);
  });

  it("reports every loop with its traversal budget", () => {
    const { loops } = resolveOrder(parse(example("simple-pipeline.at")));
    const revise = loops.find((l) => l.from === "reviewer" && l.to === "writer")!;
    expect(revise.budget).toBe(2);
    expect(revise.condition).toContain("revise");
  });

  it("numbers steps contiguously from 1", () => {
    const { steps } = resolveOrder(parse(example("code-review.at")));
    expect(steps.map((s) => s.index)).toEqual(steps.map((_, i) => i + 1));
  });

  it("places a gate anchored to nothing resolvable last, rather than dropping it", () => {
    const src = `topology t : [pipeline] {
      meta {
        version: "1.0.0"
        description: "x"
      }
      agent a {
        model: sonnet
        description: "a"
      }
      action intake {
        kind: inline
        description: "in"
      }
      gates {
        gate orphan {
          after: nowhere
          run: "true"
        }
      }
      flow { intake -> a }
    }`;
    const { steps } = resolveOrder(parse(src));
    expect(steps[steps.length - 1].ids).toEqual(["orphan"]);
  });

  const BRANCH = `topology t : [pipeline] {
    meta {
      version: "1.0.0"
      description: "one decision, two exclusive outcomes"
    }
    agent judge {
      model: opus
      description: "j"
      outputs: {
        verdict: pass | fail
      }
    }
    agent onpass {
      model: sonnet
      description: "p"
    }
    agent onfail {
      model: sonnet
      description: "f"
    }
    action i {
      kind: inline
      description: "in"
    }
    flow { i -> judge
           judge -> onpass [when judge.verdict == pass]
           judge -> onfail [when judge.verdict == fail] }
  }`;

  it("marks mutually exclusive branches as exclusive, not parallel", () => {
    // Regression: two conditional outcomes of ONE decision sat at the same
    // depth, so they were reported as a parallel fan-out. The brief then marked
    // them mutually blind and told the host to dispatch BOTH in one message —
    // running every branch of a decision instead of taking one.
    const step = resolveOrder(parse(BRANCH)).steps.find((s) => s.ids.length > 1)!;
    expect(step.exclusive).toBe(true);
    expect(step.branchOn?.map((b) => b.id).sort()).toEqual(["onfail", "onpass"]);
    for (const b of step.branchOn!) expect(b.condition).toContain("judge.verdict");
  });

  it("does not mark a genuine parallel fan-out exclusive", () => {
    const step = resolveOrder(parse(example("code-review.at"))).steps.find(
      (s) => s.ids.length > 1
    )!;
    expect(step.exclusive).toBe(false);
  });

  it("does not report a forward edge carrying [max N] as a loop", () => {
    // A forward edge may legitimately carry a bound. Treating any [max N] as a
    // back-edge reported straight-line flows as cycles.
    const src = `topology t : [pipeline] {
      meta {
        version: "1.0.0"
        description: "x"
      }
      agent a {
        model: sonnet
        description: "a"
      }
      agent b {
        model: sonnet
        description: "b"
      }
      action i {
        kind: inline
        description: "in"
      }
      flow { i -> a
             a -> b [max 3] }
    }`;
    expect(resolveOrder(parse(src)).loops).toEqual([]);
  });

  it("still reports a real back-edge as a loop, with its budget", () => {
    const { loops } = resolveOrder(parse(example("simple-pipeline.at")));
    expect(loops.length).toBeGreaterThan(0);
    expect(loops.find((l) => l.from === "reviewer" && l.to === "writer")!.budget).toBe(2);
  });
});
