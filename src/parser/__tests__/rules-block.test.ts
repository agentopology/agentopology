/**
 * `rules { rule "<id>" { text: "...", source: "..." } }`: conduct rules traced
 * to their ids. They are written into the entry agent's file (the topology
 * skill when there is no entry), into AGENTS.md for Codex, listed by validate,
 * and a gate or hook may cite one with `rule: "<id>"`.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { parse } from "../index.js";
import { validate } from "../validator.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import { codexBinding } from "../../bindings/codex.js";
import { checkGuards, renderGuardReport } from "../../guard/check.js";
import { getTopic } from "../../docs/index.js";
import { rulesSummary } from "../rules.js";
import { codexSource } from "../../bindings/__tests__/codex-models.js";

const RULES = `
  rules {
    rule "R-7.6" {
      text: "Never publish a draft without a second read."
      source: "editorial handbook, section 7"
    }
    rule "R-2" {
      text: "Cite every number."
    }
  }`;

const topo = (extra = "", entry = "entry: lead", gate = "") => `topology t : [pipeline] {
  meta {
    version: "1.0.0"
    description: "x"
    ${entry}
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
    description: "Leads the session"
    prompt { Lead the work. }
  }
  agent worker {
    model: sonnet
    description: "Does the work"
    prompt { Work. }
  }
  flow {
    intake -> lead
    lead -> worker
  }
  gates {
    gate check {
      after: worker
      run: "scripts/check.sh"
      ${gate}
    }
  }
${extra}
}`;

const errors = (src: string, rule?: string) =>
  validate(parse(src)).filter((r) => r.level === "error" && (!rule || r.rule === rule));

describe("rules block: parse", () => {
  it("reads ids with dots, text and source", () => {
    const ast = parse(topo(RULES));
    expect(ast.rules).toEqual([
      expect.objectContaining({ id: "R-7.6", text: "Never publish a draft without a second read.", source: "editorial handbook, section 7" }),
      expect.objectContaining({ id: "R-2", text: "Cite every number." }),
    ]);
    expect(ast.rules![1].source).toBeUndefined();
  });

  it("has no rules when none are declared", () => {
    expect(parse(topo()).rules ?? []).toEqual([]);
  });

  it("reads rule: on a gate", () => {
    const ast = parse(topo(RULES, "entry: lead", 'rule: "R-7.6"'));
    const gate = ast.nodes.find((n) => n.id === "check") as { rule?: string };
    expect(gate.rule).toBe("R-7.6");
  });
});

describe("rules block: validation", () => {
  it("accepts a clean block", () => {
    expect(errors(topo(RULES))).toEqual([]);
  });

  it("a duplicate id is an error", () => {
    const dup = `rules {
      rule "R-1" { text: "a" }
      rule "R-1" { text: "b" }
    }`;
    const e = errors(topo(dup), "V143");
    expect(e).toHaveLength(1);
    expect(e[0].message).toContain("R-1");
  });

  it("an empty text is an error", () => {
    const e = errors(topo(`rules { rule "R-1" { text: "" } }`), "V143");
    expect(e).toHaveLength(1);
    expect(e[0].message).toMatch(/text/);
  });

  it("a missing text is an error", () => {
    const e = errors(topo(`rules { rule "R-1" { source: "x" } }`), "V143");
    expect(e).toHaveLength(1);
  });

  it("a gate citing an unknown rule is an error", () => {
    const e = errors(topo(RULES, "entry: lead", 'rule: "R-99"'), "V144");
    expect(e).toHaveLength(1);
    expect(e[0].message).toContain("R-99");
  });

  it("a gate citing a known rule is fine", () => {
    expect(errors(topo(RULES, "entry: lead", 'rule: "R-7.6"'), "V144")).toEqual([]);
  });

  it("a hook citing an unknown rule is an error, a known one is fine", () => {
    const hook = (id: string) => `${RULES}
  hooks {
    hook h {
      on: PreToolUse
      matcher: "Bash"
      run: "scripts/h.sh"
      rule: "${id}"
    }
  }`;
    expect(errors(topo(hook("R-2")), "V144")).toEqual([]);
    expect(errors(topo(hook("R-5")), "V144")).toHaveLength(1);
  });

  it("a citation with no rules block at all is an error", () => {
    expect(errors(topo("", "entry: lead", 'rule: "R-1"'), "V144")).toHaveLength(1);
  });

  it("validate prints the declared rules in one line", () => {
    expect(rulesSummary(parse(topo(RULES)))).toBe("rules: 2 declared (R-7.6, R-2)");
    expect(rulesSummary(parse(topo()))).toBeNull();
  });
});

describe("rules block: claude-code", () => {
  const files = (src: string) => claudeCodeBinding.scaffold(parse(src));
  const get = (src: string, path: string) => files(src).find((f) => f.path === path)?.content ?? "";

  it("writes the rules into the entry agent's file between markers", () => {
    const body = get(topo(RULES), ".claude/agents/lead/AGENT.md");
    const m = body.match(/<!-- agentopology:rules[^>]*-->([\s\S]*?)<!-- \/agentopology:rules -->/);
    expect(m, body).not.toBeNull();
    expect(m![1]).toContain("## Rules");
    expect(m![1]).toContain("R-7.6");
    expect(m![1]).toContain("Never publish a draft without a second read.");
    expect(m![1]).toContain("editorial handbook, section 7");
    expect(m![1]).toContain("R-2");
  });

  it("does not write the rules into other agents", () => {
    expect(get(topo(RULES), ".claude/agents/worker/AGENT.md")).not.toContain("Never publish a draft");
  });

  it("with no entry, writes them into the topology skill", () => {
    const body = get(topo(RULES, ""), ".claude/skills/t/SKILL.md");
    expect(body).toContain("## Rules");
    expect(body).toContain("R-7.6");
  });

  it("writes no Rules section when there are no rules", () => {
    expect(get(topo(), ".claude/agents/lead/AGENT.md")).not.toContain("## Rules");
  });

  it("writes the citation into the gate's text", () => {
    const body = get(topo(RULES, "entry: lead", 'rule: "R-7.6"'), ".claude/skills/t/SKILL.md");
    expect(body).toMatch(/Rule: R-7\.6/);
  });
});

describe("rules block: guard --check", () => {
  it("lists a gate's rule beside it", () => {
    const ast = parse(topo(RULES, "entry: lead", 'rule: "R-7.6"'));
    const root = fs.mkdtempSync(join(os.tmpdir(), "at-rules-"));
    try {
      for (const f of claudeCodeBinding.scaffold(ast)) {
        fs.mkdirSync(dirname(join(root, f.path)), { recursive: true });
        fs.writeFileSync(join(root, f.path), f.content);
      }
      const report = checkGuards(ast, root);
      expect(report.items.find((i) => i.id === "check")?.rule).toBe("R-7.6");
      const line = renderGuardReport(report).find((l) => l.includes("gate check"));
      expect(line).toContain("rule: R-7.6");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("rules block: codex and docs", () => {
  it("writes the rules into AGENTS.md", () => {
    const agents = codexBinding.scaffold(parse(codexSource(topo(RULES)))).find((f) => f.path === "AGENTS.md")!;
    expect(agents.content).toContain("## Rules");
    expect(agents.content).toContain("R-7.6");
    expect(agents.content).toContain("Never publish a draft without a second read.");
  });

  it("has a docs topic", () => {
    expect(getTopic("rules")).toContain("rule \"");
  });
});
