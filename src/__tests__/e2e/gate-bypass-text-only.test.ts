/**
 * A gate's `bypass:` is written as text only (the claude-code skill's gate
 * section); nothing enforces it. validate says so, on claude-code and with no
 * target, through V130, the rule for what Claude Code does not carry out.
 */

import { describe, it, expect } from "vitest";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";

const SOURCE = (bypass = '      bypass: "none"\n') => `topology bp : [pipeline] {
  meta {
    version: "0.1.0"
    description: "a gate with bypass"
  }
  agent builder {
    model: sonnet
    description: "Builds"
    prompt {
      Build.
    }
  }
  agent reviewer {
    model: opus
    description: "Reviews"
    prompt {
      Review.
    }
  }
  flow {
    builder -> reviewer
  }
  gates {
    gate tests-green {
      after: builder
      before: reviewer
      run: "npm test"
      strength: refuse
${bypass}    }
  }
}
`;

const TEXT = "gate tests-green has bypass: it is written as text only; it is not enforced";
const hits = (src: string, target?: string) =>
  validate(parse(src), target ? { target } : {}).filter((r) => r.message.includes(TEXT));

describe("a gate's bypass: is reported as text only", () => {
  it("warns with no target and on claude-code, through V130", () => {
    for (const target of [undefined, "claude-code"]) {
      const h = hits(SOURCE(), target);
      expect(h, String(target)).toHaveLength(1);
      expect(h[0].rule).toBe("V130");
      expect(h[0].level).toBe("warning");
      expect(h[0].node).toBe("tests-green");
    }
  });

  it("a gate with no bypass: is not reported", () => {
    expect(hits(SOURCE(""))).toEqual([]);
  });
});
