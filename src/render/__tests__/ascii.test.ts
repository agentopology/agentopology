import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import { renderAscii } from "../ascii.js";

const example = (name: string) =>
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../examples", name), "utf8");

describe("renderAscii", () => {
  it("puts the gate after the agent it gates, not first", () => {
    const out = renderAscii(parse(example("code-review.at")));
    const lines = out.split("\n");
    const reviewer = lines.findIndex((l) => l.includes("reviewer") && l.includes("▸"));
    const gate = lines.findIndex((l) => l.includes("human-approval"));
    expect(gate).toBeGreaterThan(reviewer);
  });

  it("shows a parallel step on one line", () => {
    const out = renderAscii(parse(example("code-review.at")));
    expect(out).toContain("analyzer  ∥  security-scanner");
    expect(out).toContain("agent ×2, parallel");
  });

  it("renders every back-edge with its condition and budget", () => {
    const out = renderAscii(parse(example("simple-pipeline.at")));
    expect(out).toContain("↩  reviewer → writer");
    expect(out).toContain("when reviewer.verdict == revise, max 2");
    expect(out).toContain("↩  reviewer → researcher");
  });

  it("states that the orchestrator is the host, not a step", () => {
    const out = renderAscii(parse(example("simple-pipeline.at")));
    expect(out).toContain("is the host agent — it is not a step");
  });

  it("emits no ANSI escape codes — colour is the CLI's job", () => {
    const out = renderAscii(parse(example("code-review.at")));
    // eslint-disable-next-line no-control-regex
    expect(/\[/.test(out)).toBe(false);
  });

  it("includes a roles table with model and handoff counts", () => {
    const out = renderAscii(parse(example("simple-pipeline.at")));
    expect(out).toContain("Roles");
    expect(out).toMatch(/researcher\s+sonnet/);
  });

  it("does not render unwired nodes as a parallel step", () => {
    // Regression: nodes with no edges all rank at Kahn depth 0, so they came
    // out as one "agent ×N, parallel" line that read like real concurrent work
    // — and `(no flow declared)` was unreachable. An earlier version of THIS
    // test asserted the buggy behaviour.
    const src = `topology t : [pipeline] {
      meta {
        version: "1.0.0"
        description: "x"
      }
      agent a {
        model: sonnet
        description: "a"
        invocation: manual
      }
      agent b {
        model: sonnet
        description: "b"
        invocation: manual
      }
    }`;
    const out = renderAscii(parse(src));
    expect(out).toContain("(no flow declared)");
    expect(out).toContain("declared but not in the flow: a, b");
    expect(out).not.toContain("parallel");
  });

  it("keeps unwired nodes out of the spine but still names them", () => {
    const src = `topology t : [pipeline] {
      meta {
        version: "1.0.0"
        description: "x"
      }
      agent wired {
        model: sonnet
        description: "w"
      }
      agent lonely {
        model: sonnet
        description: "l"
        invocation: manual
      }
      action i {
        kind: inline
        description: "in"
      }
      flow { i -> wired }
    }`;
    const out = renderAscii(parse(src));
    expect(out).toMatch(/1\s+▪ i/);
    expect(out).toMatch(/2\s+▸ wired/); // renumbered, no gap
    expect(out).toContain("declared but not in the flow: lonely");
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
      expect(() => renderAscii(parse(example(f))), f).not.toThrow();
    }
  });

  it("renders a decision as a branch, not as parallel work", () => {
    const src = `topology t : [pipeline] {
      meta {
        version: "1.0.0"
        description: "x"
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
    const out = renderAscii(parse(src));
    expect(out).toContain("exactly one runs");
    expect(out).not.toContain("parallel");
    // and the condition that selects each branch is shown, not dropped
    expect(out).toContain("when judge.verdict == pass");
    expect(out).toContain("when judge.verdict == fail");
  });

  it("keeps the spine aligned past step 99", () => {
    // Regression: the step number was padded to a fixed width of 2, so the
    // whole column shifted at step 100.
    const agents = Array.from({ length: 105 }, (_, i) => i + 1)
      .map(
        (n) =>
          `  agent a${n} {\n    model: sonnet\n    description: "a${n}"\n    phase: ${n}\n  }`
      )
      .join("\n");
    const chain = Array.from({ length: 105 }, (_, i) => `a${i + 1}`).join(" -> ");
    const src = [
      "topology big : [pipeline] {",
      "  meta {",
      '    version: "1.0.0"',
      '    description: "x"',
      "  }",
      agents,
      "  action i {",
      "    kind: inline",
      '    description: "in"',
      "  }",
      `  flow { i -> ${chain} }`,
      "}",
    ].join("\n");
    const lines = renderAscii(parse(src)).split("\n");
    const step9 = lines.find((l) => /^\s+9\s+[▸▪]/.test(l))!;
    const step100 = lines.find((l) => /^\s+100\s+[▸▪]/.test(l))!;
    expect(step9).toBeDefined();
    expect(step100).toBeDefined();
    // The glyph must sit in the same column on both.
    expect(step9.indexOf("▸")).toBe(step100.indexOf("▸"));
  });
});
