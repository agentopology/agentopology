/**
 * The entry agent: `meta { entry: <agent-id> }` names the agent a session
 * starts as. Claude Code's `agent` setting "Start[s] every session as a named
 * subagent with its prompt, tools, and model" (code.claude.com/docs/en/settings-reference,
 * index row `agent`; code.claude.com/docs/en/sub-agents: "set `agent` in
 * `.claude/settings.json`"). V134 refuses an entry Claude Code cannot start.
 */

import { describe, it, expect } from "vitest";
import { parse } from "../index.js";
import { validate } from "../validator.js";
import { serializeAST } from "../../import/serializer.js";
import type { TopologyAST } from "../ast.js";

const topo = (entry: string, extra = "", ext = "") => `topology t : [pipeline] {
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
    prompt { Lead. }
  }
  agent worker {
    model: sonnet
    description: "Does the work"
    prompt { Work. }
  }
  ${extra}
  flow {
    intake -> lead
    lead -> worker
  }
  ${ext}
}`;

/** The parsed entry (read through a cast so this file compiles before the field exists). */
const entryOf = (ast: TopologyAST) => (ast.topology as { entry?: string }).entry;

const v134 = (src: string) => validate(parse(src)).filter((r) => r.rule === "V134");

describe("meta { entry } parses", () => {
  it("reads entry into topology.entry", () => {
    const ast = parse(topo("entry: lead"));
    expect(entryOf(ast)).toBe("lead");
  });

  it("is a known meta field (no V102)", () => {
    const res = validate(parse(topo("entry: lead")));
    expect(res.filter((r) => r.rule === "V102")).toEqual([]);
  });

  it("is absent when not written", () => {
    expect(entryOf(parse(topo("")))).toBeUndefined();
  });

  it("round-trips through the serializer", () => {
    const ast = parse(topo("entry: lead"));
    const text = serializeAST(ast);
    expect(text).toMatch(/^\s+entry: lead$/m);
    expect(entryOf(parse(text))).toBe("lead");
  });
});

describe("V134: the entry agent is one Claude Code can start", () => {
  it("passes for a declared agent", () => {
    expect(v134(topo("entry: lead"))).toEqual([]);
    const errors = validate(parse(topo("entry: lead"))).filter((r) => r.level === "error");
    expect(errors).toEqual([]);
  });

  it("errors when entry names no declared node", () => {
    const r = v134(topo("entry: ghost"));
    expect(r).toHaveLength(1);
    expect(r[0].level).toBe("error");
    expect(r[0].message).toContain('"ghost"');
    expect(r[0].message).toMatch(/not a declared node/);
  });

  it("errors when entry names an action", () => {
    const r = v134(topo("entry: intake"));
    expect(r).toHaveLength(1);
    expect(r[0].level).toBe("error");
    expect(r[0].message).toMatch(/action/);
  });

  it("errors when entry names a human", () => {
    const src = topo("entry: approver", `human approver {
    description: "Approves"
  }`).replace("lead -> worker", "lead -> worker\n    worker -> approver");
    const r = v134(src);
    expect(r).toHaveLength(1);
    expect(r[0].level).toBe("error");
    expect(r[0].message).toMatch(/human/);
  });

  it("errors when entry names a gate", () => {
    const src = topo("entry: check", `gates {
    gate check {
      after: lead
      before: worker
      run: "scripts/check.sh"
    }
  }`);
    const r = v134(src);
    expect(r).toHaveLength(1);
    expect(r[0].level).toBe("error");
    expect(r[0].message).toMatch(/gate/);
  });

  it("errors when entry names an agent that runs inline (written as a skill)", () => {
    const src = topo("entry: helper", `agent helper {
    model: sonnet
    description: "Helps"
    runs: inline
    invocation: manual
    prompt { Help. }
  }`);
    const r = v134(src);
    expect(r).toHaveLength(1);
    expect(r[0].level).toBe("error");
    expect(r[0].message).toMatch(/runs: inline/);
    expect(r[0].message).toMatch(/skill/);
  });

  it("errors when entry names an agent the workflow rung owns (execution: workflow)", () => {
    const src = topo("entry: worker").replace(`description: "Does the work"`, `description: "Does the work"
    extensions {
      claude-workflow {
        execution: workflow
      }
    }`);
    const r = v134(src);
    expect(r).toHaveLength(1);
    expect(r[0].level).toBe("error");
    expect(r[0].message).toMatch(/execution: workflow/);
  });

  it("warns when extensions { claude-code { agent } } names a different agent, naming both", () => {
    const src = topo("entry: lead", "", `extensions {
    claude-code {
      agent: worker
    }
  }`);
    const r = v134(src);
    expect(r).toHaveLength(1);
    expect(r[0].level).toBe("warning");
    expect(r[0].message).toContain("lead");
    expect(r[0].message).toContain("worker");
  });

  it("says nothing when the extension names the same agent", () => {
    const src = topo("entry: lead", "", `extensions {
    claude-code {
      agent: lead
    }
  }`);
    expect(v134(src)).toEqual([]);
  });

  it("an entry agent needs no flow edge and no invocation: manual (V4)", () => {
    const src = topo("entry: boss", `agent boss {
    model: opus
    description: "Runs the session"
    prompt { Run it. }
  }`);
    const res = validate(parse(src));
    expect(res.filter((r) => r.rule === "V4")).toEqual([]);
    expect(res.filter((r) => r.rule === "V134")).toEqual([]);
  });
});
