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
import { markdownExporter } from "../../exporters/markdown.js";

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

describe("markdown export", () => {
  it("prints the entry agent next to the error handler", () => {
    const md = markdownExporter.export(parse(topo("entry: lead"))).map((f) => f.content).join("\n");
    expect(md).toMatch(/\*\*Entry:\*\* `lead`/);
  });
});

describe("V134: more entries Claude Code cannot start", () => {
  it("errors for an agent with runs: fork", () => {
    const src = topo("entry: helper", `agent helper {
    model: sonnet
    description: "Helps"
    runs: fork
    invocation: manual
    prompt { Help. }
  }`);
    const r = v134(src);
    expect(r).toHaveLength(1);
    expect(r[0].level).toBe("error");
    expect(r[0].message).toMatch(/runs: fork/);
  });

  it("errors for a group", () => {
    const src = topo("entry: chat", `group chat {
    members: [lead, worker]
  }`);
    const r = v134(src);
    expect(r).toHaveLength(1);
    expect(r[0].level).toBe("error");
    expect(r[0].message).toMatch(/is a group, not an agent/);
  });

  it("errors for the orchestrator, with the right article", () => {
    const r = v134(topo("entry: orchestrator"));
    expect(r).toHaveLength(1);
    expect(r[0].level).toBe("error");
    expect(r[0].message).toMatch(/is an orchestrator, not an agent/);
    expect(v134(topo("entry: intake"))[0].message).toMatch(/is an action, not an agent/);
  });

  it("errors for an empty entry", () => {
    const r = v134(topo("entry:"));
    expect(r).toHaveLength(1);
    expect(r[0].level).toBe("error");
    expect(r[0].message).toMatch(/one agent id/);
  });

  it("errors for a list entry, without calling it an undeclared node", () => {
    const r = v134(topo("entry: [lead, worker]"));
    expect(r).toHaveLength(1);
    expect(r[0].level).toBe("error");
    expect(r[0].message).toMatch(/one agent id/);
    expect(r[0].message).not.toMatch(/not a declared node/);
  });

  it("the differ warning is not given under --target codex", () => {
    const src = topo("entry: lead", "", `extensions {
    claude-code {
      agent: worker
    }
  }`);
    expect(validate(parse(src), { target: "codex" }).filter((r) => r.rule === "V134")).toEqual([]);
  });

  it("an entry V134 refuses is not exempt from V4", () => {
    const src = topo("entry: boss", `agent boss {
    model: opus
    description: "Runs the session"
    prompt { Run it. }
    extensions {
      claude-workflow {
        execution: workflow
      }
    }
  }`);
    const res = validate(parse(src));
    expect(res.filter((r) => r.rule === "V134" && r.level === "error")).toHaveLength(1);
    expect(res.filter((r) => r.rule === "V4").map((r) => r.node)).toEqual(["boss"]);
  });
});

describe("V134: the extension's agent value is checked like entry", () => {
  const withExt = (value: string, extra = "") => topo("", extra, `extensions {
    claude-code {
      agent: ${value}
    }
  }`);

  it("warns when extensions { claude-code { agent } } names an agent that runs inline", () => {
    const src = withExt("helper", `agent helper {
    model: sonnet
    description: "Helps"
    runs: inline
    invocation: manual
    prompt { Help. }
  }`);
    const r = v134(src);
    expect(r).toHaveLength(1);
    expect(r[0].level).toBe("warning");
    expect(r[0].message).toMatch(/extensions \{ claude-code \{ agent/);
    expect(r[0].message).toMatch(/runs: inline/);
  });

  it("says nothing when it names something the topology does not declare (a plugin's or built-in agent)", () => {
    expect(v134(withExt("my-plugin:reviewer"))).toEqual([]);
  });
});

describe("V134: a gate after the entry agent", () => {
  const gate = (body: string) => `gates {
    gate check {
      ${body}
      run: "scripts/check.sh"
    }
  }`;

  it("warns on the gate: SubagentStop never fires for the session's agent", () => {
    const res = validate(parse(topo("entry: lead", gate("after: lead"))));
    const r = res.filter((x) => x.rule === "V134");
    expect(r).toHaveLength(1);
    expect(r[0].level).toBe("warning");
    expect(r[0].node).toBe("check");
    expect(r[0].message).toMatch(/the entry agent is the session, so SubagentStop never fires for it/);
    expect(r[0].message).toMatch(/anchor the gate on a subagent or a script step/);
  });

  it("says nothing for a gate after another agent", () => {
    expect(v134(topo("entry: lead", gate("after: worker")))).toEqual([]);
  });

  it("says nothing without an entry", () => {
    expect(v134(topo("", gate("after: lead")))).toEqual([]);
  });
});

describe("V134: the entry agent's tools are the session's tools", () => {
  const withTools = (tools: string, src = topo("entry: lead")) =>
    src.replace(`description: "Leads the session"`, `description: "Leads the session"\n    tools: ${tools}`);

  it("warns when the entry's tools list has no Agent and it hands work to an agent", () => {
    const r = v134(withTools("[Read, Grep]"));
    expect(r).toHaveLength(1);
    expect(r[0].level).toBe("warning");
    expect(r[0].node).toBe("lead");
    expect(r[0].message).toMatch(/cannot (start|spawn|delegate)/);
    expect(r[0].message).toContain("Agent(worker)");
  });

  it("says nothing when tools has Agent, Agent(...), or the older Task", () => {
    expect(v134(withTools("[Read, Agent]"))).toEqual([]);
    expect(v134(withTools("[Read, Agent(worker)]"))).toEqual([]);
    expect(v134(withTools("[Read, Task]"))).toEqual([]);
  });

  it("says nothing without a tools list", () => {
    expect(v134(topo("entry: lead"))).toEqual([]);
  });

  it("says nothing when the topology has no other subagent", () => {
    const solo = `topology t : [pipeline] {
  meta {
    version: "1.0.0"
    description: "x"
    entry: lead
  }
  agent lead {
    model: sonnet
    description: "Leads the session"
    tools: [Read]
    prompt { Lead. }
  }
}`;
    expect(v134(solo)).toEqual([]);
  });
});
