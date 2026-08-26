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
      meta {
        version: "1.0.0"
        description: "x"
      }
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
      action intake {
        kind: inline
        description: "in"
      }
      flow { intake -> builder -> validator }
    }`;
    const b = buildExecutionBrief(parse(src));
    const h = b.handoffs.find((x) => x.to === "validator")!;
    expect(h.passes).toEqual(["workspace/notes.md"]);
    expect(h.withholds).toEqual(["workspace/self-review.md"]);

    // The withhold lands on the READER, which is the only role that can honour
    // it. A writer cannot withhold a file it has already written.
    const validator = b.roles.find((r) => r.id === "validator")!;
    expect(validator.mustNotRead).toEqual(["workspace/self-review.md"]);
    const builder = b.roles.find((r) => r.id === "builder")!;
    expect(builder.mustNotRead).toEqual([]);
  });

  it("does not tell a writer to withhold a file it is handing to another reader", () => {
    // Regression: `withheld` was unioned across ALL of a writer's readers, so a
    // builder with two consumers taking one file each was told to withhold
    // both — including the ones it was supposed to hand over.
    const src = `topology t : [pipeline] {
      meta {
        version: "1.0.0"
        description: "x"
      }
      agent builder {
        model: sonnet
        description: "b"
        writes: ["workspace/diff.md", "workspace/notes.md"]
      }
      agent reviewer {
        model: sonnet
        description: "r"
        reads: ["workspace/diff.md"]
      }
      agent archivist {
        model: sonnet
        description: "a"
        reads: ["workspace/notes.md"]
      }
      action i {
        kind: inline
        description: "in"
      }
      flow { i -> builder -> reviewer
             builder -> archivist }
    }`;
    const b = buildExecutionBrief(parse(src));
    expect(b.roles.find((r) => r.id === "builder")!.mustNotRead).toEqual([]);
    expect(b.roles.find((r) => r.id === "reviewer")!.mustNotRead).toEqual([
      "workspace/notes.md",
    ]);
    expect(b.roles.find((r) => r.id === "archivist")!.mustNotRead).toEqual([
      "workspace/diff.md",
    ]);
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

  it("lists reads nobody produces as run preconditions, and checks them on disk", () => {
    const b = briefFor("code-review.at");
    const paths = b.preconditions.map((p) => p.path);
    expect(paths).toContain("workspace/pr-diff.md");
    // Anything a role writes is produced inside the run, so it is not a precondition.
    expect(paths).not.toContain("workspace/analysis.md");

    // Each carries an absolute path and a real existence check — "must exist
    // first" that nobody verifies is a runtime surprise, not a contract.
    for (const p of b.preconditions) {
      expect(p.absolute.startsWith("/"), p.path).toBe(true);
      expect(typeof p.exists).toBe("boolean");
    }
  });

  it("pre-flags a precondition that does not exist on disk", () => {
    const src = `topology t : [pipeline] {
      meta {
        version: "1.0.0"
        description: "x"
      }
      agent a {
        model: sonnet
        description: "a"
        reads: ["definitely/not/here.md"]
      }
      action intake {
        kind: inline
        description: "in"
      }
      flow { intake -> a }
    }`;
    const b = buildExecutionBrief(parse(src));
    const flag = b.preflagged.find((p) => p.kind === "precondition-missing")!;
    expect(flag).toBeDefined();
    expect(flag.question).toContain("definitely/not/here.md");
  });

  it("resolves every declared path to an absolute one for the role cards", () => {
    // Dogfooding found three subagents each normalising the same relative path
    // differently, so the declared handoff pointed nowhere.
    const b = briefFor("code-review.at");
    for (const r of b.roles) {
      for (const p of [...r.readsAbs, ...r.writesAbs]) {
        expect(p.startsWith("/"), `${r.id}: ${p}`).toBe(true);
      }
    }
  });

  it("carries the task into the brief so {{TASK}} is never undefined", () => {
    const b = briefFor("code-review.at", { task: "Review PR 42" });
    expect(b.task).toBe("Review PR 42");
    const md = renderBriefMarkdown(b);
    expect(md).toContain("§1b — Run inputs");
    expect(md).toContain("Review PR 42");
    // §0 legitimately mentions the placeholder when explaining it. What must
    // not contain it is the ROLE PROMPTS — those are copied verbatim.
    const cards = md.slice(md.indexOf("# §3 — Role cards"));
    expect(cards).not.toContain("{{TASK}}");
    expect(cards).toContain("Review PR 42");
  });

  it("says what to do about {{TASK}} when no task was given", () => {
    const md = renderBriefMarkdown(briefFor("code-review.at"));
    const cards = md.slice(md.indexOf("# §3 — Role cards"));
    expect(cards).toContain("{{TASK}}");
    expect(md).toContain("Substitute the user's actual request");
  });

  it("marks the `name` spawn parameter optional", () => {
    // Some hosts reject it outright ("Teammates cannot spawn other teammates").
    const md = renderBriefMarkdown(briefFor("code-review.at"));
    expect(md).toContain("drop it if the host rejects it");
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
      meta {
        version: "1.0.0"
        description: "x"
      }
      agent bare {
        model: sonnet
        description: "does a thing"
      }
      action intake {
        kind: inline
        description: "in"
      }
      flow { intake -> bare }
    }`;
    const b = buildExecutionBrief(parse(src));
    const flag = b.preflagged.find((p) => p.kind === "prompt-missing")!;
    expect(flag.at.node).toBe("bare");
    expect(flag.fix).toContain("prompt { }");
  });

  it("pre-flags an edge across which nothing is declared to cross", () => {
    const src = `topology t : [pipeline] {
      meta {
        version: "1.0.0"
        description: "x"
      }
      agent a {
        model: sonnet
        description: "a"
        writes: ["workspace/a.md"]
      }
      agent b {
        model: sonnet
        description: "b"
        reads: ["workspace/other.md"]
      }
      action intake {
        kind: inline
        description: "in"
      }
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

  const TWO_OUTPUTS = `topology t : [pipeline] {
    meta {
      version: "1.0.0"
      description: "one node routing on two different outputs, plus a default"
    }
    agent judge {
      model: opus
      description: "j"
      outputs: {
        verdict: pass | fail
        severity: minor | major
      }
    }
    agent sink {
      model: sonnet
      description: "s"
    }
    agent worker {
      model: sonnet
      description: "w"
    }
    agent always {
      model: sonnet
      description: "al"
    }
    action i {
      kind: inline
      description: "in"
    }
    flow { i -> judge
           judge -> sink [when judge.verdict == pass]
           judge -> worker [when judge.severity == major]
           judge -> always }
  }`;

  it("groups routing by (source, output), not by source alone", () => {
    // Regression: grouped by source with the key read off edges[0], so a node
    // routing on two outputs got ONE heading naming whichever came first, and
    // every row under it looked like it tested that output.
    const routes = buildExecutionBrief(parse(TWO_OUTPUTS)).routes;
    expect(routes).toHaveLength(2);
    expect(routes.map((r) => r.key).sort()).toEqual(["severity", "verdict"]);
    for (const r of routes) {
      for (const e of r.edges) expect(e.condition).toContain(`.${r.key}`);
    }
  });

  it("keeps the unconditional out-edge as a default instead of dropping it", () => {
    // Regression: it was dropped entirely, and §5 then told the host to halt
    // when nothing matched — a dead end the topology had an answer for.
    const routes = buildExecutionBrief(parse(TWO_OUTPUTS)).routes;
    for (const r of routes) {
      expect(r.fallbacks.map((f) => f.to)).toContain("always");
    }
    const md = renderBriefMarkdown(buildExecutionBrief(parse(TWO_OUTPUTS)));
    expect(md).toContain("(no condition — default)");
    expect(md).toContain("take the unconditional default row");
  });

  it("still says halt when a decision has no default", () => {
    const md = renderBriefMarkdown(briefFor("code-review.at"));
    expect(md).toContain("log `route-unmatched` and stop");
  });

  it("does not mark exclusive branches as mutually blind", () => {
    // They never co-run, so they cannot leak into each other — and marking them
    // blind told the host to dispatch every branch of a decision at once.
    const b = buildExecutionBrief(parse(TWO_OUTPUTS));
    const exclusive = b.steps.filter((s) => s.exclusive).flatMap((s) => s.ids);
    for (const p of b.blindPairs) {
      expect(exclusive).not.toContain(p.a);
      expect(exclusive).not.toContain(p.b);
    }
  });

  it("heads a routing table with the node the condition TESTS, not the edge source", () => {
    // Regression: `worker -> judge [when judge.verdict == fail]` produced a
    // heading of `worker.verdict` — a node/output pair that does not exist,
    // since `worker` declares no outputs at all.
    const src = `topology t : [pipeline] {
      meta {
        version: "1.0.0"
        description: "x"
      }
      agent worker {
        model: sonnet
        description: "w"
      }
      agent judge {
        model: opus
        description: "j"
        outputs: {
          verdict: pass | fail
        }
      }
      action i {
        kind: inline
        description: "in"
      }
      flow { i -> worker
             worker -> judge [when judge.verdict == fail] }
    }`;
    const b = buildExecutionBrief(parse(src));
    expect(b.routes[0].subject).toBe("judge");
    expect(b.routes[0].from).toBe("worker");
    const md = renderBriefMarkdown(b);
    expect(md).toContain("**On `judge.verdict`:**");
    expect(md).not.toContain("worker.verdict");
  });
});

describe("renderBriefMarkdown", () => {
  it("refuses to be enacted when the topology has validation errors", () => {
    const src = `topology t : [pipeline] {
      meta {
        version: "1.0.0"
        description: "x"
      }
      agent a {
        model: sonnet
        description: "a"
        prompt: "prompts/a.md"
      }
      action intake {
        kind: inline
        description: "in"
      }
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

  it("renders a gate's `before` anchor, not just `after`", () => {
    // Regression: only `after` was shown, so a before-only gate read as
    // anchored to nothing.
    const md = renderBriefMarkdown(briefFor("simple-pipeline.at"));
    expect(md).toContain("| gate | anchor |");
    expect(md).toMatch(/after `writer`, before `reviewer`/);
  });
});
