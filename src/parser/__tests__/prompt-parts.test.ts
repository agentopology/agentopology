/**
 * A prompt with named parts: `prompt { job { } scope { } ... }`, and
 * `meta { prompt-parts: [..] }` for the parts every agent's prompt must have.
 * V137 refuses a missing part, an unknown part name, a repeated part and a
 * prompt that mixes free text with parts. A prompt with no named parts is free
 * text and is read as before.
 */

import { describe, it, expect } from "vitest";
import { parse } from "../index.js";
import { validate } from "../validator.js";
import { serializeAST } from "../../import/serializer.js";
import { claudeCodeBinding } from "../../bindings/index.js";
import { PROMPT_FENCE_OPEN, PROMPT_FENCE_CLOSE } from "../../bindings/lib/prompt-fence.js";

const topo = (meta: string, prompt: string, second = "Work.") => `topology t : [pipeline] {
  meta {
    version: "1.0.0"
    description: "x"
    ${meta}
  }
  orchestrator {
    model: opus
    handles: [intake]
  }
  action intake {
    kind: inline
    description: "in"
  }
  agent lead {
    model: sonnet
    description: "Leads"
    prompt {
${prompt}
    }
  }
  agent worker {
    model: sonnet
    description: "Works"
    prompt { ${second} }
  }
  flow {
    intake -> lead
    lead -> worker
  }
}`;

const v137 = (src: string) => validate(parse(src)).filter((r) => r.rule === "V137");
const promptOf = (src: string, id = "lead") =>
  (parse(src).nodes.find((n) => n.id === id) as { prompt?: string }).prompt ?? "";

const PARTS = `
      rules {
        Never guess.
      }
      job {
        Lead the work.
      }
      done {
        All checked.
      }`;

describe("named prompt parts parse and compile", () => {
  it("writes the parts in a fixed order under ## headings", () => {
    const p = promptOf(topo("", PARTS));
    expect(p).toBe("## Job\n\nLead the work.\n\n## Rules\n\nNever guess.\n\n## Done\n\nAll checked.");
  });

  it("any subset, in any order, passes with no required parts", () => {
    expect(v137(topo("", PARTS))).toEqual([]);
    expect(validate(parse(topo("", PARTS))).filter((r) => r.level === "error")).toEqual([]);
  });

  it("holds braces and colons in prose", () => {
    const src = topo("", `
      job {
        Reply with {"status": "ok"} and a note: done.
        Use the key: value form, and { nested { braces } } too.
      }
      steps {
        1. Read it
        2. Write: the answer
      }`);
    const p = promptOf(src);
    expect(p).toContain('Reply with {"status": "ok"} and a note: done.');
    expect(p).toContain("{ nested { braces } } too.");
    expect(p).toContain("## Steps");
    expect(p).toContain("2. Write: the answer");
    expect(v137(src)).toEqual([]);
  });

  it("a part named in prose or a nested block is not a part", () => {
    const src = topo("", `
      job {
        Example:
        rules {
          not a part
        }
      }`);
    expect(promptOf(src)).toBe("## Job\n\nExample:\nrules {\n  not a part\n}");
    expect(v137(src)).toEqual([]);
  });

  it("free text keeps working exactly as before", () => {
    const src = topo("", "      Just do it.\n      rules are good: {fine}");
    expect(promptOf(src)).toBe("Just do it.\nrules are good: {fine}");
    expect(v137(src)).toEqual([]);
  });

  it("free text with a code sample that looks like a block stays free text", () => {
    const src = topo("", "      Config:\n      foo {\n        a: 1\n      }");
    expect(promptOf(src)).toBe("Config:\nfoo {\n  a: 1\n}");
    expect(v137(src)).toEqual([]);
  });
});

describe("meta { prompt-parts }", () => {
  it("is a known meta field and reads the list", () => {
    const ast = parse(topo("prompt-parts: [job]", PARTS, "x"));
    expect((ast.topology as { promptParts?: string[] }).promptParts).toEqual(["job"]);
    expect(validate(ast).filter((r) => r.rule === "V102")).toEqual([]);
  });

  it("names the agent and the part an agent lacks", () => {
    const res = v137(topo("prompt-parts: [job, scope]", PARTS));
    const lead = res.filter((r) => r.node === "lead");
    expect(lead).toHaveLength(1);
    expect(lead[0].level).toBe("error");
    expect(lead[0].message).toContain('agent "lead"');
    expect(lead[0].message).toContain('"scope"');
    expect(lead[0].message).not.toContain('"job"');
    // the worker has a free-text prompt, so it lacks both
    const worker = res.filter((r) => r.node === "worker");
    expect(worker.map((r) => r.message).join("\n")).toMatch(/"job"[\s\S]*"scope"|"scope"[\s\S]*"job"/);
  });

  it("passes when every agent has every required part", () => {
    const full = `
      job { a }
      scope { b }`;
    const src = topo("prompt-parts: [job, scope]", full).replace("prompt { Work. }", "prompt { job { w } scope { s } }");
    expect(v137(src)).toEqual([]);
  });

  it("an unknown name in the list is an error", () => {
    const res = v137(topo("prompt-parts: [job, banana]", PARTS));
    expect(res.some((r) => r.level === "error" && r.message.includes('"banana"'))).toBe(true);
  });
});

describe("V137 refuses a malformed prompt", () => {
  it("an unknown part name is an error naming the agent and the part", () => {
    const res = v137(topo("", "      job { a }\n      banana { b }"));
    expect(res).toHaveLength(1);
    expect(res[0].level).toBe("error");
    expect(res[0].node).toBe("lead");
    expect(res[0].message).toContain('"banana"');
  });

  it("free text mixed with parts is an error", () => {
    const res = v137(topo("", "      Some intro text.\n      job { a }"));
    expect(res).toHaveLength(1);
    expect(res[0].level).toBe("error");
    expect(res[0].message).toContain('agent "lead"');
    expect(res[0].message).toMatch(/free text/);
  });

  it("text after the parts is an error too", () => {
    const res = v137(topo("", "      job { a }\n      and then more"));
    expect(res.some((r) => r.level === "error" && /free text/.test(r.message))).toBe(true);
  });

  it("a part written twice is an error", () => {
    const res = v137(topo("", "      job { a }\n      job { b }"));
    expect(res.some((r) => r.level === "error" && r.message.includes('"job"') && /twice|more than once/.test(r.message))).toBe(true);
  });
});

describe("the generated agent file", () => {
  it("writes the parts inside the prompt markers, as ## headings", () => {
    const ast = parse(topo("", PARTS));
    const files = claudeCodeBinding.scaffold(ast);
    const f = files.find((x) => x.path === ".claude/agents/lead/AGENT.md")!;
    const span = f.content.slice(f.content.indexOf(PROMPT_FENCE_OPEN), f.content.indexOf(PROMPT_FENCE_CLOSE));
    expect(span).toMatch(/^## Job$/m);
    expect(span).toMatch(/^## Rules$/m);
    expect(span.indexOf("## Job")).toBeLessThan(span.indexOf("## Rules"));
    expect(span.indexOf("## Rules")).toBeLessThan(span.indexOf("## Done"));
  });
});

describe("serializer", () => {
  it("round-trips named parts and the required list", () => {
    const ast = parse(topo("prompt-parts: [job]", PARTS, "x"));
    const text = serializeAST(ast);
    expect(text).toMatch(/prompt-parts: \[job\]/);
    const back = parse(text);
    expect(promptOf(text)).toBe(promptOf(topo("prompt-parts: [job]", PARTS, "x")));
    const msgs = (src: string) => v137(src).map((r) => r.message);
    expect(msgs(text)).toEqual(msgs(topo("prompt-parts: [job]", PARTS, "x")));
    expect(back.nodes.length).toBe(ast.nodes.length);
  });
});
