/**
 * The teaching layer must stay correct, small, and honest.
 *
 * The trap here is obvious and worth guarding: a snippet that shows the WRONG
 * form teaches the mistake to every agent that reads it. So every example a
 * lesson presents as correct is parsed and validated, and must be clean under
 * the very rule it teaches.
 */

import { describe, it, expect } from "vitest";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { lessonsFor, taughtRules, hasLesson } from "../teach.js";
import { getAgentGuide, getAllTopics } from "../index.js";
import { topics } from "../content.js";

describe("lessons are deduplicated and capped", () => {
  it("teaches a repeated rule once", () => {
    // A file with twelve V90 errors must not produce twelve lessons.
    const lessons = lessonsFor(["V90", "V90", "V90", "V90"]);
    expect(lessons).toHaveLength(1);
    expect(lessons[0].rule).toBe("V90");
  });

  it("caps the total, so a badly broken file cannot out-teach its own output", () => {
    const many = taughtRules();
    expect(many.length).toBeGreaterThan(3);
    expect(lessonsFor(many).length).toBeLessThanOrEqual(3);
  });

  it("stays silent for rules with no shape to show", () => {
    // "names must be unique" needs no example; an invented one would be noise.
    expect(lessonsFor(["V1"])).toEqual([]);
    expect(hasLesson("V1")).toBe(false);
  });
});

describe("every lesson points at a real topic", () => {
  it("names a topic the docs actually have", () => {
    const names = new Set(Object.keys(topics));
    for (const rule of taughtRules()) {
      const [lesson] = lessonsFor([rule]);
      expect(names.has(lesson.topic), `${rule} points at "${lesson.topic}"`).toBe(true);
    }
  });
});

describe("no lesson teaches a mistake", () => {
  /**
   * Extract the lines a snippet presents as CORRECT: everything except comments
   * and lines explicitly marked wrong with ✗.
   */
  const correctLines = (snippet: string) =>
    snippet
      .split("\n")
      .filter((l) => !l.trim().startsWith("#") && !l.includes("✗"))
      .join("\n");

  it("every rule's own example is clean under that rule", () => {
    for (const rule of taughtRules()) {
      const [lesson] = lessonsFor([rule]);
      const body = correctLines(lesson.snippet);
      if (!body.trim()) continue;

      // Wrap the fragment in a minimal valid topology unless it is one already.
      const src = body.includes("topology ")
        ? body
        : [
            "topology teach : [pipeline] {",
            "  meta {",
            '    version: "1.0.0"',
            '    description: "x"',
            "  }",
            body,
            "  action bootstrap {",
            "    kind: inline",
            '    description: "in"',
            "  }",
            "}",
          ].join("\n");

      let ast;
      try {
        ast = parse(src);
      } catch (err) {
        throw new Error(`${rule}'s snippet does not parse: ${(err as Error).message}`);
      }
      const hits = validate(ast).filter((r) => r.rule === rule);
      expect(
        hits.map((h) => h.message),
        `${rule}'s own example violates ${rule}`
      ).toEqual([]);
    }
  });
});

describe("the agent guide is the compact path", () => {
  it("is a fraction of the full docs", () => {
    // The whole reason it exists: ~104 KB is not a thing to load in order to
    // write one topology.
    const guide = getAgentGuide();
    const all = getAllTopics();
    expect(guide.length).toBeLessThan(6000);
    expect(all.length / guide.length).toBeGreaterThan(10);
  });

  it("contains a topology that actually validates", () => {
    const guide = getAgentGuide();
    const block = /```\n(topology[\s\S]*?)```/.exec(guide);
    expect(block, "guide should show a complete topology").not.toBeNull();
    const ast = parse(block![1]);
    const errors = validate(ast).filter((r) => r.level === "error");
    expect(
      errors.map((e) => `${e.rule}: ${e.message}`),
      "the guide's own example must be valid"
    ).toEqual([]);
  });

  it("names the traps that actually bite, not a feature list", () => {
    const guide = getAgentGuide();
    for (const trap of ["One field per line", "prompt is a block", "max N"]) {
      expect(guide.toLowerCase()).toContain(trap.toLowerCase());
    }
  });
});
