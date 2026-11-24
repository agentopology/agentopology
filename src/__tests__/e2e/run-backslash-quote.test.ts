/**
 * `\"` in a run: reaches the command as a backslash, except where the run
 * reader decodes it (an interpreter followed by a project script file, the
 * 0.12.6 path). A .at string keeps its backslashes as written in 0.13.0, so
 * an inline `test -f \"x\"` runs `test -f \"x\"`, which tests a file named
 * `"x"`, quotes included, and never matches. validate says so (V96): a
 * warning on every hook and gate, refusing ones included (in 0.13.0 it is
 * never an error; unescaping strings comes later).
 */

import { describe, it, expect } from "vitest";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
const TEXT = '`\\"` reaches the command unescaped; this check may never pass or refuse as written';

const topology = (hooks: string, gates = "") => `topology q : [pipeline] {
  meta {
    version: "0.1.0"
    description: "quotes in run"
  }
  agent builder {
    model: sonnet
    description: "Builds"
    prompt {
      Build.
    }
  }
  agent reviewer {
    model: sonnet
    description: "Reviews"
    prompt {
      Review.
    }
  }
  flow {
    builder -> reviewer
  }
${gates}  hooks {
${hooks}  }
}
`;

const hook = (run: string, strength?: string) => `    hook h {
      on: PreToolUse
      matcher: "Bash"
      run: "${run}"
      type: command
${strength ? `      strength: ${strength}\n` : ""}    }
`;

const hits = (src: string) => validate(parse(src)).filter((r) => r.message.includes(TEXT));

describe("validate on \\\" in run:", () => {
  it("an inline test -f \\\"x\\\" on a refuse hook warns", () => {
    const src = topology(hook('test -f \\"x\\"', "refuse"));
    expect(src).toContain('run: "test -f \\"x\\""');
    const h = hits(src);
    expect(h).toHaveLength(1);
    expect(h[0].level).toBe("warning");
    expect(h[0].rule).toBe("V96");
  });

  it("the same run on a hook with no strength is a warning", () => {
    const h = hits(topology(hook('test -f \\"x\\"')));
    expect(h).toHaveLength(1);
    expect(h[0].level).toBe("warning");
  });

  it("on a refusing gate it warns", () => {
    const gates = `  gates {
    gate g {
      after: builder
      before: reviewer
      run: "test -f \\"out.md\\""
    }
  }
`;
    const h = hits(topology(hook("exit 0"), gates));
    expect(h).toHaveLength(1);
    expect(h[0].level).toBe("warning");
    expect(h[0].node).toBe("g");
  });

  it("bash .claude/hooks/x.sh \\\"a b\\\" (decoded: an interpreter and a project script) gives nothing", () => {
    expect(hits(topology(hook('bash .claude/hooks/x.sh \\"a b\\"', "refuse")))).toEqual([]);
    expect(hits(topology(hook('bash .claude/hooks/x.sh \\"a b\\"')))).toEqual([]);
  });

  it("a run with no \\\" gives nothing", () => {
    expect(hits(topology(hook("test -f 'x'", "refuse")))).toEqual([]);
  });
});
