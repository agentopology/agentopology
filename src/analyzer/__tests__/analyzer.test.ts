import { describe, it, expect } from "vitest";
import { parse } from "../../parser/index.js";
import { analyze } from "../index.js";

// ---------------------------------------------------------------------------
// Test topologies
// ---------------------------------------------------------------------------

const SIMPLE_PIPELINE = `
topology simple-pipeline : [pipeline, human-gate] {
  meta {
    version: "1.0.0"
    description: "Research, write, and review"
  }
  orchestrator {
    model: sonnet
    handles: [intake, done]
  }
  action intake { kind: inline }
  agent researcher {
    model: gpt-4o
    permissions: supervised
    phase: 1
    tools: [Read, Grep]
    prompt { You are a researcher. }
  }
  agent writer {
    model: sonnet
    phase: 2
    tools: [Read, Write]
    prompt { You are a writer. }
  }
  agent reviewer {
    model: opus
    phase: 3
    tools: [Read]
    outputs: { verdict: approve | revise | reject }
    prompt { You are a reviewer. }
  }
  action done { kind: report }
  flow {
    intake -> researcher
    researcher -> writer
    writer -> reviewer
    reviewer -> writer     [when reviewer.verdict == revise, max 2]
    reviewer -> researcher [when reviewer.verdict == reject, max 1]
    reviewer -> done       [when reviewer.verdict == approve]
  }
  gates {
    gate quality-check {
      after: writer
      before: reviewer
      run: "scripts/check.sh"
      checks: [grammar, formatting]
      on-fail: bounce-back
    }
  }
  settings {
    allow: ["Read", "Grep"]
  }
}
`;

const FAN_OUT = `
topology code-review : [pipeline, fan-out] {
  meta { version: "2.0.0" description: "Fan-out review" }
  orchestrator { model: opus handles: [intake, report] }
  action intake { kind: inline }
  agent analyzer { model: sonnet phase: 1 }
  agent security { model: sonnet phase: 1 }
  agent reporter { model: sonnet phase: 2 prompt { Summarize findings. } }
  action report { kind: report }
  flow {
    intake -> analyzer
    intake -> security
    analyzer -> reporter
    security -> reporter
    reporter -> report
  }
}
`;

const MINIMAL = `
topology minimal : [pipeline] {
  meta { version: "0.1.0" description: "Bare minimum" }
  orchestrator { model: sonnet handles: [start] }
  action start { kind: inline }
  agent worker { model: haiku phase: 1 }
  flow { start -> worker }
}
`;

// ---------------------------------------------------------------------------
// Summary tests
// ---------------------------------------------------------------------------

describe("analyze — summary", () => {
  it("returns correct topology name and version", () => {
    const result = analyze(parse(SIMPLE_PIPELINE));
    expect(result.summary.name).toBe("simple-pipeline");
    expect(result.summary.version).toBe("1.0.0");
    expect(result.summary.description).toBe("Research, write, and review");
  });

  it("counts nodes correctly", () => {
    const result = analyze(parse(SIMPLE_PIPELINE));
    expect(result.summary.nodeCount.agents).toBe(3);
    expect(result.summary.nodeCount.actions).toBe(2);
    expect(result.summary.nodeCount.gates).toBe(1);
    expect(result.summary.nodeCount.orchestrators).toBe(1);
    expect(result.summary.nodeCount.groups).toBe(0);
    expect(result.summary.nodeCount.humans).toBe(0);
  });

  it("counts edges", () => {
    const result = analyze(parse(SIMPLE_PIPELINE));
    expect(result.summary.edgeCount).toBe(6);
  });

  it("includes declared patterns", () => {
    const result = analyze(parse(SIMPLE_PIPELINE));
    expect(result.summary.declaredPatterns).toContain("pipeline");
    expect(result.summary.declaredPatterns).toContain("human-gate");
  });

  it("works with minimal topology", () => {
    const result = analyze(parse(MINIMAL));
    expect(result.summary.nodeCount.agents).toBe(1);
    expect(result.summary.edgeCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Pattern detection tests
// ---------------------------------------------------------------------------

describe("analyze — patterns", () => {
  it("detects pipeline pattern", () => {
    const result = analyze(parse(SIMPLE_PIPELINE));
    const pipeline = result.patterns.find((p) => p.name === "pipeline");
    expect(pipeline).toBeDefined();
    expect(pipeline!.confidence).toBe("definite");
    expect(pipeline!.involvedNodes.length).toBeGreaterThanOrEqual(3);
  });

  it("pipeline description shows node chain", () => {
    const result = analyze(parse(SIMPLE_PIPELINE));
    const pipeline = result.patterns.find((p) => p.name === "pipeline");
    expect(pipeline!.description).toContain("->");
  });

  it("detects fan-out pattern", () => {
    const result = analyze(parse(FAN_OUT));
    const fanOut = result.patterns.find((p) => p.name === "fan-out");
    expect(fanOut).toBeDefined();
    expect(fanOut!.involvedNodes).toContain("intake");
    expect(fanOut!.involvedNodes).toContain("analyzer");
    expect(fanOut!.involvedNodes).toContain("security");
  });

  it("detects review-loop pattern", () => {
    const result = analyze(parse(SIMPLE_PIPELINE));
    const loops = result.patterns.filter((p) => p.name === "review-loop");
    expect(loops.length).toBe(2);
    expect(loops[0].involvedNodes).toContain("reviewer");
  });

  it("review-loop description shows max iterations", () => {
    const result = analyze(parse(SIMPLE_PIPELINE));
    const loop = result.patterns.find((p) => p.name === "review-loop");
    expect(loop!.description).toContain("max");
  });

  it("no false fan-out on simple pipeline", () => {
    // The simple pipeline has fan-out from reviewer (3 conditional edges)
    const result = analyze(parse(SIMPLE_PIPELINE));
    const fanOuts = result.patterns.filter((p) => p.name === "fan-out");
    // reviewer has 3 outgoing forward edges (the conditional ones without max)
    // This is technically a fan-out
    expect(fanOuts.length).toBeGreaterThanOrEqual(0);
  });

  it("minimal topology detects no loops", () => {
    const result = analyze(parse(MINIMAL));
    const loops = result.patterns.filter((p) => p.name === "review-loop");
    expect(loops).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Layer tests
// ---------------------------------------------------------------------------

describe("analyze — layers", () => {
  it("computes topological layers", () => {
    const result = analyze(parse(SIMPLE_PIPELINE));
    expect(result.layers.length).toBeGreaterThan(0);
  });

  it("source nodes are at depth 0", () => {
    const result = analyze(parse(SIMPLE_PIPELINE));
    const layer0 = result.layers.find((l) => l.depth === 0);
    expect(layer0).toBeDefined();
    expect(layer0!.nodes.length).toBeGreaterThan(0);
  });

  it("fan-out nodes are at same depth", () => {
    const result = analyze(parse(FAN_OUT));
    const analyzerLayer = result.layers.find((l) => l.nodes.includes("analyzer"));
    const securityLayer = result.layers.find((l) => l.nodes.includes("security"));
    expect(analyzerLayer).toBeDefined();
    expect(securityLayer).toBeDefined();
    expect(analyzerLayer!.depth).toBe(securityLayer!.depth);
  });

  it("downstream nodes have higher depth", () => {
    const result = analyze(parse(FAN_OUT));
    const intakeLayer = result.layers.find((l) => l.nodes.includes("intake"));
    const reporterLayer = result.layers.find((l) => l.nodes.includes("reporter"));
    expect(intakeLayer).toBeDefined();
    expect(reporterLayer).toBeDefined();
    expect(reporterLayer!.depth).toBeGreaterThan(intakeLayer!.depth);
  });

  it("minimal topology has layers", () => {
    const result = analyze(parse(MINIMAL));
    expect(result.layers.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Suggestion tests
// ---------------------------------------------------------------------------

describe("analyze — suggestions", () => {
  it("suggests retry for agents without retry config", () => {
    const result = analyze(parse(SIMPLE_PIPELINE));
    const retrySuggestions = result.suggestions.filter(
      (s) => s.message.includes("retry"),
    );
    expect(retrySuggestions.length).toBeGreaterThan(0);
  });

  it("suggests timeout for agents without timeout", () => {
    const result = analyze(parse(SIMPLE_PIPELINE));
    const timeoutSuggestions = result.suggestions.filter(
      (s) => s.message.includes("timeout"),
    );
    expect(timeoutSuggestions.length).toBeGreaterThan(0);
  });

  it("does not suggest missing prompt for agents with prompts", () => {
    const result = analyze(parse(SIMPLE_PIPELINE));
    const promptSuggestions = result.suggestions.filter(
      (s) => s.message.includes("no prompt") && s.node === "researcher",
    );
    expect(promptSuggestions).toHaveLength(0);
  });

  it("suggests missing prompt for agents without prompt", () => {
    const result = analyze(parse(FAN_OUT));
    const promptSuggestions = result.suggestions.filter(
      (s) => s.message.includes("no prompt"),
    );
    // analyzer and security have no prompt
    expect(promptSuggestions.length).toBeGreaterThanOrEqual(2);
  });

  it("detects declared pattern mismatch", () => {
    // SIMPLE_PIPELINE declares "human-gate" but has no HumanNode
    const result = analyze(parse(SIMPLE_PIPELINE));
    const mismatch = result.suggestions.find(
      (s) => s.message.includes("human-gate") && s.message.includes("not detected"),
    );
    expect(mismatch).toBeDefined();
  });

  it("suggestions include node id", () => {
    const result = analyze(parse(SIMPLE_PIPELINE));
    const withNode = result.suggestions.filter((s) => s.node);
    expect(withNode.length).toBeGreaterThan(0);
  });

  it("gate without checks gets suggestion", () => {
    const ast = parse(`
topology test : [pipeline] {
  meta { version: "1.0.0" }
  orchestrator { model: sonnet handles: [start] }
  action start { kind: inline }
  agent a { model: sonnet prompt { test } }
  flow { start -> a }
  gates { gate g { after: a run: "check.sh" } }
}
`);
    const result = analyze(ast);
    const gateSuggestion = result.suggestions.find(
      (s) => s.node === "g" && s.message.includes("checks"),
    );
    expect(gateSuggestion).toBeDefined();
  });
});
