/**
 * `checkpoint { }` and `interface { }` are parsed and validated. The
 * claude-code binding writes both as prose: checkpoint into the rules file
 * (.claude/rules/<name>.md), interface into the topology skill. Because they
 * are written, validation gives no "not written" warning (V130) for either.
 */

import { describe, it, expect } from "vitest";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { claudeCodeBinding } from "../claude-code.js";

const topo = (extra: string) => `topology t : [pipeline] {
  meta {
    version: "1.0.0"
    description: "x"
  }
  orchestrator {
    model: opus
    handles: [intake]
  }
  action intake {
    kind: inline
    description: "in"
  }
  agent a {
    model: sonnet
    description: "worker"
    prompt { Do the work. }
  }
  flow {
    intake -> a
  }
  ${extra}
}`;

const CHECKPOINT = `checkpoint {
    backend: sqlite
    strategy: every-node
    ttl: 7d
  }`;
const INTERFACE = `interface {
    entry: intake
    exit: a
  }`;

function run(extra: string) {
  const ast = parse(topo(extra));
  const files = claudeCodeBinding.scaffold(ast);
  const notWritten = validate(ast)
    .filter((r) => r.rule === "V130" && /not written/.test(r.message))
    .map((r) => r.message);
  return { files, notWritten };
}

describe("claude-code: checkpoint and interface blocks are written", () => {
  it("checkpoint values land in the rules file, with no not-written warning", () => {
    const { files, notWritten } = run(CHECKPOINT);
    const rules = files.find((f) => f.path === ".claude/rules/t.md");
    expect(rules?.content).toContain("## Checkpoint");
    expect(rules?.content).toContain("- Backend: sqlite");
    expect(rules?.content).toContain("- Strategy: every-node");
    expect(rules?.content).toContain("- TTL: 7d");
    expect(notWritten.filter((m) => /checkpoint/.test(m))).toEqual([]);
  });

  it("interface entry and exit land in the topology skill, with no not-written warning", () => {
    const { files, notWritten } = run(INTERFACE);
    const skill = files.find((f) => f.path === ".claude/skills/t/SKILL.md");
    expect(skill?.content).toContain("## Interface");
    expect(skill?.content).toContain("- Entry: intake");
    expect(skill?.content).toContain("- Exit: a");
    expect(notWritten.filter((m) => /interface/.test(m))).toEqual([]);
  });
});
