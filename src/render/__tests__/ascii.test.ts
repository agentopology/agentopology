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

  it("survives a topology with no flow edges", () => {
    // NB: fields are newline-separated. parseFields is line-based, so putting
    // them on one line makes `model` swallow the rest as its value.
    const src = `topology t : [pipeline] {
      meta { version: "1.0.0" description: "x" }
      agent a {
        model: sonnet
        description: "a"
        invocation: manual
      }
    }`;
    const out = renderAscii(parse(src));
    expect(out).toContain("a");
    expect(out).toMatch(/1\s+▸ a/);
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
});
