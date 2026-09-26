/**
 * Hooks: one field per line (V90), a known type (V94), an event that fits the
 * type (V95), and `type: mod` — a module loaded inside the engine.
 *
 * The live specimen: congreat-ade.at wrote nine hooks on one line each. Every
 * one parsed with `on` swallowing the line, `run` empty, `type` unset, and the
 * validator passed it. The one-liners below are copied from that map.
 */

import { describe, it, expect } from "vitest";
import { parse } from "../index.js";
import { validate } from "../validator.js";
import { getTopic } from "../../docs/index.js";

function topology(hooks: string, agentHooks = ""): string {
  return [
    "topology t : [pipeline] {",
    "  meta {",
    '    version: "1.0.0"',
    '    description: "x"',
    "  }",
    "  orchestrator {",
    "    model: sonnet",
    "  }",
    "  agent a {",
    "    model: sonnet",
    '    description: "a"',
    agentHooks ? `    hooks {\n${agentHooks}\n    }` : "",
    "  }",
    "  flow { a }",
    "  hooks {",
    hooks,
    "  }",
    "}",
  ].join("\n");
}

const rules = (src: string, rule: string) => validate(parse(src)).filter((r) => r.rule === rule);

describe("V90 covers hooks: fields are one per line", () => {
  it("refuses the congreat-ade.at one-liners (the specimen)", () => {
    const src = topology(
      [
        '    hook router-at-prompt { on: UserPromptSubmit run: "harness-plugin/hooks/router.py (H5: the position)" type: command }',
        '    hook redaction-mod    { on: PostToolUse run: "harness-plugin/hooks/register.ts (the identity Mod)" type: command }',
        '    hook merge-gate       { on: PreToolUse matcher: "Bash" run: ".claude/hooks/gates/gate-merge-numbers.sh" type: command }',
      ].join("\n"),
    );
    const ast = parse(src);
    // What the parser makes of them — the silent damage V90 now names.
    expect(ast.hooks.map((h) => h.run)).toEqual(["", "", ""]);
    const v90 = rules(src, "V90");
    expect(v90.map((r) => r.node)).toEqual(["router-at-prompt", "redaction-mod", "merge-gate"]);
    expect(v90[0].level).toBe("error");
    expect(v90[0].message).toContain("swallowed the field `run`");
    expect(v90[2].message).toContain("swallowed the field `matcher`");
  });

  it("refuses a one-line per-agent hook", () => {
    const src = topology(
      '    hook g {\n      on: Stop\n      run: "g.sh"\n    }',
      '      hook h { on: PreToolUse run: "h.sh" }',
    );
    expect(rules(src, "V90").map((r) => r.node)).toEqual(["a.h"]);
  });

  it("leaves the multi-line form clean", () => {
    const src = topology('    hook g {\n      on: PreToolUse\n      matcher: "Bash"\n      run: "g.sh"\n      type: command\n    }');
    expect(parse(src).hooks[0]).toMatchObject({ on: "PreToolUse", matcher: "Bash", run: "g.sh", type: "command" });
    expect(rules(src, "V90")).toEqual([]);
    expect(rules(src, "V94")).toEqual([]);
    expect(rules(src, "V95")).toEqual([]);
  });
});

describe("type: mod", () => {
  const mod = (on: string, extra = "") =>
    topology(`    hook redact {\n      on: ${on}\n      run: "hooks/redact.ts"\n      type: mod\n${extra}    }`);

  it("parses on, run, type and flag", () => {
    const src = mod("tool.call", "      flag: CONGREAT_MOD_REDACT\n");
    expect(parse(src).hooks[0]).toMatchObject({
      name: "redact", on: "tool.call", run: "hooks/redact.ts", type: "mod", flag: "CONGREAT_MOD_REDACT",
    });
    expect([...rules(src, "V94"), ...rules(src, "V95")]).toEqual([]);
  });

  it("accepts both proven engine events", () => {
    expect(rules(mod("prompt.submit"), "V95")).toEqual([]);
    expect(rules(mod("tool.call"), "V95")).toEqual([]);
  });

  it("RED CONTROL: refuses an unknown engine event, teaching the list", () => {
    const v95 = rules(mod("tool.called"), "V95");
    expect(v95).toHaveLength(1);
    expect(v95[0].level).toBe("error");
    expect(v95[0].message).toBe(
      'Mod "redact" subscribes to unknown engine event "tool.called". Engine events: tool.call, prompt.submit, prompt.context, session.start, session.end, model.complete, message.received.',
    );
  });

  it("refuses a command-hook event on a mod, saying why", () => {
    const v95 = rules(mod("PreToolUse"), "V95");
    expect(v95[0].level).toBe("error");
    expect(v95[0].message).toContain('"PreToolUse" is a command-hook event');
  });

  it("warns (not refuses) an event seen in the engine but unproven for Mods", () => {
    const v95 = rules(mod("session.start"), "V95");
    expect(v95).toHaveLength(1);
    expect(v95[0].level).toBe("warning");
    expect(v95[0].message).toContain("no Mod has been observed");
  });

  it("refuses a mod with no module", () => {
    const src = topology("    hook m {\n      on: tool.call\n      type: mod\n    }");
    expect(rules(src, "V95")[0].message).toContain("has no run:");
  });

  it("refuses a flag that is not an env variable name", () => {
    expect(rules(mod("tool.call", "      flag: my-flag\n"), "V94")[0].message).toContain("an env variable name");
  });
});

describe("V94: a hook type the grammar defines", () => {
  it("refuses an unknown type", () => {
    const src = topology('    hook g {\n      on: Stop\n      run: "g.sh"\n      type: comand\n    }');
    const v94 = rules(src, "V94");
    expect(v94).toHaveLength(1);
    expect(v94[0].message).toContain('has type "comand" — a hook is one of: command, prompt, mod');
  });

  it("refuses flag: on a command hook", () => {
    const src = topology('    hook g {\n      on: Stop\n      run: "g.sh"\n      flag: X_ON\n    }');
    expect(rules(src, "V94")[0].message).toContain("flag: is the env switch of a type: mod hook");
  });
});

describe("V95: a command hook takes a PascalCase event", () => {
  it("refuses an engine event on a command hook, pointing at type: mod", () => {
    const src = topology('    hook g {\n      on: tool.call\n      run: "g.sh"\n    }');
    const v95 = rules(src, "V95");
    expect(v95).toHaveLength(1);
    expect(v95[0].message).toContain("set type: mod");
  });

  it("does not double-report a swallowed line (that is V90's)", () => {
    const src = topology('    hook g { on: Stop run: "g.sh" }');
    expect(rules(src, "V90")).toHaveLength(1);
    expect(rules(src, "V95")).toEqual([]);
  });
});

describe("docs: agentopology docs hooks", () => {
  it("teaches type: mod, its events and an example", () => {
    const text = getTopic("hooks")!;
    expect(text).toContain("type: mod");
    expect(text).toContain("tool.call");
    expect(text).toContain("prompt.submit");
    expect(text).toContain("flag: MY_MOD_REDACT");
  });
});
