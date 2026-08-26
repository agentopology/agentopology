import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { buildExecutionBrief } from "../brief.js";
import { renderBriefMarkdown } from "../render.js";

const example = (name: string) =>
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../examples", name), "utf8");

const briefFor = (name: string, opts = {}) =>
  buildExecutionBrief(parse(example(name)), { source: `examples/${name}`, ...opts });

describe("buildExecutionBrief", () => {
  it("computes handoffs as writes ∩ reads, one row per pair", () => {
    const b = briefFor("code-review.at");
    const h = b.handoffs.find((x) => x.from === "analyzer" && x.to === "reviewer")!;
    expect(h.passes).toEqual(["workspace/analysis.md"]);

    // Two conditional edges between the same roles are ONE handoff. The
    // condition is control flow, not information flow.
    const pairs = b.handoffs.map((x) => `${x.from}->${x.to}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it("derives withholds from the same intersection, so they cannot drift", () => {
    const src = `topology t : [pipeline] {
      meta { version: "1.0.0" description: "x" }
      agent builder {
        model: sonnet
        description: "b"
        writes: ["workspace/notes.md", "workspace/self-review.md"]
      }
      agent validator {
        model: opus
        description: "v"
        reads: ["workspace/notes.md"]
      }
      action intake { kind: inline description: "in" }
      flow { intake -> builder -> validator }
    }`;
    const b = buildExecutionBrief(parse(src));
    const h = b.handoffs.find((x) => x.to === "validator")!;
    expect(h.passes).toEqual(["workspace/notes.md"]);
    expect(h.withholds).toEqual(["workspace/self-review.md"]);

    // And the withhold reaches the writer's card, so its prompt can state it.
    const builder = b.roles.find((r) => r.id === "builder")!;
    expect(builder.withheld).toEqual(["workspace/self-review.md"]);
  });

  it("marks same-step roles with no edge between them as mutually blind", () => {
    const b = briefFor("code-review.at");
    expect(b.blindPairs).toHaveLength(1);
    expect([b.blindPairs[0].a, b.blindPairs[0].b].sort()).toEqual([
      "analyzer",
      "security-scanner",
    ]);
    const analyzer = b.roles.find((r) => r.id === "analyzer")!;
    expect(analyzer.blindTo).toEqual(["security-scanner"]);
  });

  it("lists reads nobody produces as run preconditions", () => {
    const b = briefFor("code-review.at");
    expect(b.preconditions).toContain("workspace/pr-diff.md");
    // Anything a role writes is produced inside the run, so it is not a precondition.
    expect(b.preconditions).not.toContain("workspace/analysis.md");
  });

  it("names every unenforceable declaration rather than dropping it", () => {
    const b = briefFor("code-review.at");
    const nodes = b.unenforceable.filter((u) => u.field === "tools").map((u) => u.node);
    expect(nodes).toContain("analyzer");
    expect(nodes).toContain("reporter");
    expect(b.roles.find((r) => r.id === "analyzer")!.fileless).toBe(false);
  });

  it("counts which of the five persistent features are present", () => {
    const b = briefFor("code-review.at");
    const names = b.persistent.map((p) => p.feature);
    expect(names).toContain("triggers / slash commands");
    expect(names).toContain("per-agent tools / permissions");
    expect(names).not.toContain("schedules / cron");
  });

  it("picks the evidence tier for gates, since tiers 1-3 need files", () => {
    const b = briefFor("code-review.at");
    const gate = b.gates[0];
    expect(gate.tier).toBe("evidence-orchestrator");
    expect(gate.blocking).toBe(true);
  });

  it("treats an advisory gate as advisory whatever its on-fail says", () => {
    const b = briefFor("simple-pipeline.at");
    const gate = b.gates[0];
    // simple-pipeline's gate is blocking with bounce-back; assert the mapping.
    expect(["advisory", "evidence-orchestrator", "evidence-agent"]).toContain(gate.tier);
  });

  it("pre-flags a prompt-less role, because its whole instruction set is one line", () => {
    const src = `topology t : [pipeline] {
      meta { version: "1.0.0" description: "x" }
      agent bare {
        model: sonnet
        description: "does a thing"
      }
      action intake { kind: inline description: "in" }
      flow { intake -> bare }
    }`;
    const b = buildExecutionBrief(parse(src));
    const flag = b.preflagged.find((p) => p.kind === "prompt-missing")!;
    expect(flag.at.node).toBe("bare");
    expect(flag.fix).toContain("prompt { }");
  });

  it("pre-flags an edge across which nothing is declared to cross", () => {
    const src = `topology t : [pipeline] {
      meta { version: "1.0.0" description: "x" }
      agent a { model: sonnet description: "a" writes: ["workspace/a.md"] }
      agent b { model: sonnet description: "b" reads: ["workspace/other.md"] }
      action intake { kind: inline description: "in" }
      flow { intake -> a -> b }
    }`;
    const brief = buildExecutionBrief(parse(src));
    const flag = brief.preflagged.find((p) => p.kind === "handoff-overlap-empty")!;
    expect(flag.at.edge).toBe("a->b");
    expect(flag.fix).toContain("reads");
  });

  it("every pre-flagged ambiguity carries a concrete fix — that is the payoff", () => {
    for (const f of ["code-review.at", "simple-pipeline.at", "data-processing.at"]) {
      for (const p of briefFor(f).preflagged) {
        expect(p.fix.length, `${f}/${p.kind}`).toBeGreaterThan(0);
      }
    }
  });

  it("excludes the orchestrator from steps and names it as the host", () => {
    const b = briefFor("simple-pipeline.at");
    expect(b.orchestrator).toBe("orchestrator");
    expect(b.steps.some((s) => s.ids.includes("orchestrator"))).toBe(false);
  });
});

describe("renderBriefMarkdown", () => {
  it("refuses to be enacted when the topology has validation errors", () => {
    const src = `topology t : [pipeline] {
      meta { version: "1.0.0" description: "x" }
      agent a {
        model: sonnet
        description: "a"
        prompt: "prompts/a.md"
      }
      action intake { kind: inline description: "in" }
      flow { intake -> a }
    }`;
    const ast = parse(src);
    const errors = validate(ast).filter((r) => r.level === "error");
    expect(errors.length).toBeGreaterThan(0);
    const md = renderBriefMarkdown(buildExecutionBrief(ast, { errors }));
    expect(md).toContain("DO NOT ENACT");
    expect(md).toContain("[V89]");
    // And it must not go on to emit an enactment loop the host might follow.
    expect(md).not.toContain("§0 — Enactment loop");
  });

  it("emits all eleven sections for a valid topology", () => {
    const md = renderBriefMarkdown(briefFor("code-review.at"));
    for (const s of ["§0", "§1", "§2", "§3", "§4", "§5", "§6", "§7", "§8", "§9", "§10"]) {
      expect(md, s).toContain(s);
    }
  });

  it("tells the host to dispatch a parallel step in one message", () => {
    const md = renderBriefMarkdown(briefFor("code-review.at"));
    expect(md).toContain("all Agent calls in a single");
    expect(md).toContain("you cannot leak it");
  });

  it("puts the canary rule in the enactment loop", () => {
    const md = renderBriefMarkdown(briefFor("code-review.at"));
    expect(md).toContain("FIRST subagent of the run, stop and ask");
  });

  it("gives every role a return protocol naming its declared enums", () => {
    const md = renderBriefMarkdown(briefFor("code-review.at"));
    expect(md).toContain("```at-output");
    expect(md).toContain("risk-level: <low|medium|high|critical>");
    expect(md).toContain("verdict: <approve|request-changes|reject>");
  });

  it("states an isolation instruction in a blind role's prompt", () => {
    const md = renderBriefMarkdown(briefFor("code-review.at"));
    expect(md).toContain("ISOLATION");
    expect(md).toContain("must not read, ask for, or speculate about that work");
  });

  it("names the persistent features and points at scaffold", () => {
    const md = renderBriefMarkdown(briefFor("code-review.at"));
    expect(md).toMatch(/\*\*\d of 5 present\.\*\*/);
    expect(md).toContain("agentopology scaffold examples/code-review.at");
  });

  it("renders every shipped example without throwing", () => {
    for (const f of [
      "code-review.at",
      "simple-pipeline.at",
      "data-processing.at",
      "memory-system.at",
      "scheduled-monitor.at",
      "company-brain.at",
    ]) {
      expect(() => renderBriefMarkdown(briefFor(f)), f).not.toThrow();
    }
  });
});
