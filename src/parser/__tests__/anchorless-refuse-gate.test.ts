/**
 * V135: a gate meant to refuse that no generated hook runs is a validate error.
 *
 * A gate with a `run:` script, not advisory, and strength refuse (written or
 * left out) is meant to refuse. Claude Code (and Codex, which wires gates the
 * same way) runs it from a hook only when one of these marks its moment:
 * - every `after:` is a subagent (SubagentStop),
 * - a `before:` is a subagent (before-agent.sh on the Agent tool),
 * - a `before:` is a script step, an action with `commands:` (before-action.sh).
 * Inline delegation removes the first two. Every other such gate got its
 * wrapper script, a scaffold warning, and "All validation rules passed": it
 * looked like it refused while nothing ran it. The planted row is the shape of
 * a real one: `before:` a report step, no `after:`, a cited `at:`.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../index.js";
import { validate } from "../validator.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const CLI = resolve(root, "dist/cli/index.js");
const FIXTURE = resolve(here, "fixtures/anchorless-refuse-gate.at");

/** A topology with every kind of anchor a gate can name, and one gate. */
const topo = (gate: string, delegation = "") => `topology t : [pipeline] {
  meta {
    version: "1.0.0"
    description: "gate anchors"
  }
  orchestrator {
    model: opus
${delegation ? `    delegation: ${delegation}\n` : ""}    handles: [intake, report, deploy]
  }
  action intake {
    kind: inline
    description: "Take the request"
  }
  agent a {
    model: sonnet
    description: "First worker"
    prompt { Do a. }
  }
  agent b {
    model: sonnet
    description: "Second worker"
    prompt { Do b. }
  }
  agent s {
    model: sonnet
    description: "Runs as a skill"
    runs: inline
    prompt { Do s. }
  }
  human h {
    description: "A person approves"
  }
  action report {
    kind: report
    description: "Hand the result back"
  }
  action deploy {
    kind: inline
    description: "Ship it"
    commands: ["./deploy.sh"]
  }
  flow {
    intake -> a
    a -> s
    s -> h
    h -> b
    b -> deploy
    deploy -> report
  }
  gates {
    gate g {
${gate}
    }
  }
}`;

const RUN = `      run: "scripts/check.sh"`;
const v135 = (src: string, target?: string) =>
  validate(parse(src), target ? { target } : {}).filter((r) => r.rule === "V135");

/** Rows that must error: a gate meant to refuse with no hook that runs it. */
const HOOKLESS: Array<[string, string, string, string?]> = [
  ["no after:, no before:", RUN, "no after: target and no before: target"],
  ["no after:, before: a report step (an action with no commands:)", `      before: report\n${RUN}`,
    'no after: target and before: "report" (an action with no commands:), not a subagent or a script step'],
  ["after: a human, no before:", `      after: h\n${RUN}`, 'after: "h" (a human), not a subagent and no before: target'],
  ["after: a report step, before: a human", `      after: report\n      before: h\n${RUN}`,
    'after: "report" (an action with no commands:), not a subagent and before: "h" (a human), not a subagent or a script step'],
  ["after: an agent and a human, no before: (SubagentStop needs every after: to be a subagent)", `      after: [a, h]\n${RUN}`,
    'after: "h" (a human), not a subagent and no before: target'],
  ["after: an agent with runs: inline (a skill, not a subagent)", `      after: s\n${RUN}`,
    'after: "s" (an agent with runs: inline, so not a subagent), not a subagent and no before: target'],
  ["strength: refuse written, cited at:", `      before: report\n${RUN}\n      strength: refuse\n      by: hook\n      at: "tools/checks.py"`,
    'no after: target and before: "report" (an action with no commands:), not a subagent or a script step'],
  ["inline delegation, after: and before: agents", `      after: a\n      before: b\n${RUN}`,
    'orchestrator.delegation "inline" (no subagent ever runs)', "inline"],
];

/** Rows that must not: a hook runs the gate, or it is not meant to refuse. */
const HOOKED_OR_EXEMPT: Array<[string, string, string?]> = [
  ["after: an agent (SubagentStop)", `      after: a\n${RUN}`],
  ["after: a group of agents (SubagentStop on each)", `      after: [a, b]\n${RUN}`],
  ["after: a human, before: an agent (before-agent.sh)", `      after: h\n      before: b\n${RUN}`],
  ["no after:, before: an agent (before-agent.sh)", `      before: b\n${RUN}`],
  ["after: a report step, before: a script step (before-action.sh)", `      after: report\n      before: deploy\n${RUN}`],
  ["no after:, before: a script step (before-action.sh)", `      before: deploy\n${RUN}`],
  ["before: a script step under inline delegation (before-action.sh still runs)", `      after: b\n      before: deploy\n${RUN}`, "inline"],
  ["advisory", `      before: report\n${RUN}\n      behavior: advisory`],
  ["no run:", `      before: report\n      description: "checked by hand"`],
  ["strength: hope (the playbook runs it, and says so)", `      before: report\n${RUN}\n      strength: hope`],
  ["strength: detect", `      before: report\n${RUN}\n      strength: detect`],
  ["strength: none", `      before: report\n${RUN}\n      strength: none`],
];

describe("V135: a gate meant to refuse that no hook runs", () => {
  for (const [name, gate, reason, delegation] of HOOKLESS) {
    it(`errors: ${name}`, () => {
      const hits = v135(topo(gate, delegation));
      expect(hits).toHaveLength(1);
      expect(hits[0].level).toBe("error");
      expect(hits[0].node).toBe("g");
      expect(hits[0].message).toContain(`Gate "g" would refuse, but has ${reason}, so no hook runs it`);
    });
  }
  for (const [name, gate, delegation] of HOOKED_OR_EXEMPT) {
    it(`passes: ${name}`, () => {
      expect(v135(topo(gate, delegation))).toEqual([]);
    });
  }

  describe("an edge guard that cites a refusing hook credits the gate (as guard --check does)", () => {
    const withEdgeGuard = (hook: string, gateExtra = "") => topo(`      after: h\n      before: report\n${RUN}${gateExtra}`)
      .replace("    deploy -> report\n", "    deploy -> report\n    h -> report [guard: lock]\n")
      .replace("  gates {", `  hooks {\n    hook lock {\n${hook}\n    }\n  }\n  gates {`);
    const PRE = `      on: PreToolUse\n      matcher: "Bash"\n      run: "python3 harness/lock.py"\n      strength: refuse`;

    it("passes: the edge cites a PreToolUse hook with strength: refuse", () => {
      expect(v135(withEdgeGuard(PRE))).toEqual([]);
    });
    it("errors: the cited hook declares no strength", () => {
      expect(v135(withEdgeGuard(`      on: PreToolUse\n      matcher: "Bash"\n      run: "python3 harness/lock.py"`))).toHaveLength(1);
    });
    it("errors: the cited hook is PostToolUse (it cannot block)", () => {
      expect(v135(withEdgeGuard(`      on: PostToolUse\n      matcher: "Bash"\n      run: "python3 harness/lock.py"\n      strength: refuse`))).toHaveLength(1);
    });
    it("errors: a cited gate (at:) takes no edge credit (0.12.4)", () => {
      expect(v135(withEdgeGuard(PRE, `\n      at: "tools/checks.py"`))).toHaveLength(1);
    });
  });

  it("names the fix: an anchor that wires, or strength: hope", () => {
    const [hit] = v135(topo(`      before: report\n${RUN}`));
    expect(hit.message).toContain("Give it a subagent in after: or before:, or a script step (an action with commands:) in before:");
    expect(hit.message).toContain("strength: hope");
  });

  it("under inline delegation names the one anchor that still wires", () => {
    const [hit] = v135(topo(`      after: a\n      before: b\n${RUN}`, "inline"));
    expect(hit.message).toContain("only a script step (an action with commands:) in before: gets a hook");
  });

  describe("a gate after the entry agent (meta { entry }): the entry agent is the session, not a subagent", () => {
    const withEntry = (gate: string) =>
      topo(gate).replace('    description: "gate anchors"\n', '    description: "gate anchors"\n    entry: a\n');

    it("errors: after: the entry agent, no before: (SubagentStop never fires for the session)", () => {
      const hits = v135(withEntry(`      after: a\n${RUN}`));
      expect(hits).toHaveLength(1);
      expect(hits[0].message).toContain(
        'after: "a" (the entry agent: it is the session, so SubagentStop never fires for it), not a subagent and no before: target',
      );
    });
    it("passes: after: the entry agent, before: a subagent (before-agent.sh runs it before that agent launches)", () => {
      expect(v135(withEntry(`      after: a\n      before: b\n${RUN}`))).toEqual([]);
    });
    it("passes: after: another agent while the entry is set", () => {
      expect(v135(withEntry(`      after: b\n${RUN}`))).toEqual([]);
    });
    it("codex has no entry agent: after: a stays wired there (no V135)", () => {
      expect(v135(withEntry(`      after: a\n${RUN}`), "codex")).toEqual([]);
    });
  });

  it("says a citation does not make it refuse", () => {
    const [hit] = v135(topo(`      before: report\n${RUN}\n      at: "tools/checks.py"`));
    expect(hit.message).toContain("Its at: citation does not make it refuse");
  });

  it("applies with no target, claude-code and codex; not cursor or claude-workflow", () => {
    const src = topo(`      before: report\n${RUN}`);
    expect(v135(src)).toHaveLength(1);
    expect(v135(src, "claude-code")).toHaveLength(1);
    expect(v135(src, "codex")).toHaveLength(1);
    // Cursor writes a preToolUse hook for every gate; claude-workflow leaves
    // a host gate to the claude-code binding (validate --target claude-code).
    expect(v135(src, "cursor")).toEqual([]);
    expect(v135(src, "claude-workflow")).toEqual([]);
  });

  it("the scaffold warning gives the same reason as the error", () => {
    const src = topo(`      before: report\n${RUN}`);
    const [hit] = v135(src);
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    try {
      claudeCodeBinding.scaffold(parse(src));
    } finally {
      console.warn = original;
    }
    const line = warnings.find((w) => w.includes('Gate "g"'));
    expect(line).toBeDefined();
    const reason = 'has no after: target and before: "report" (an action with no commands:), not a subagent or a script step, so no hook runs it';
    expect(line).toContain(`[claude-code] Gate "g" ${reason}`);
    expect(hit.message).toContain(reason);
  });
});

describe("V135 planted row: the fixture fails validate", () => {
  const source = readFileSync(FIXTURE, "utf8");

  it("validate() reports V135 on the gate and nothing else as an error", () => {
    const errors = validate(parse(source)).filter((r) => r.level === "error");
    expect(errors.map((e) => `${e.rule} ${e.node}`)).toEqual(["V135 numbers-need-a-source"]);
  });

  const run = (args: string[], cwd: string) => {
    try {
      return { out: execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], cwd }), code: 0 };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; status?: number };
      return { out: `${e.stdout ?? ""}${e.stderr ?? ""}`, code: e.status ?? 1 };
    }
  };
  const project = () => {
    const dir = mkdtempSync(join(tmpdir(), "at-v135-"));
    writeFileSync(join(dir, "t.at"), source);
    return dir;
  };

  it("the CLI's validate exits 1 with [V135], with no target and with --target claude-code or codex", () => {
    const dir = project();
    for (const extra of [[], ["--target", "claude-code"], ["--target", "codex"]]) {
      const v = run(["validate", "t.at", ...extra], dir);
      expect(v.code, v.out).toBe(1);
      expect(v.out).toContain("[V135]");
      expect(v.out).not.toContain("All validation rules passed");
    }
  });

  it("scaffold --target claude-code refuses it; --target cursor writes it", () => {
    const dir = project();
    const s = run(["scaffold", "t.at", "--target", "claude-code", "--dry-run"], dir);
    expect(s.code, s.out).toBe(1);
    expect(s.out).toContain("[V135]");
    const cursor = run(["scaffold", "t.at", "--target", "cursor", "--dry-run"], dir);
    expect(cursor.out).not.toContain("[V135]");
    expect(cursor.code, cursor.out).toBe(0);
  });

  it("plan is not refused by it: interpreted mode places the gate by its before: and runs it", () => {
    const dir = project();
    const p = run(["plan", "t.at", "--brief"], dir);
    expect(p.out).not.toContain("V135");
    expect(p.code, p.out).toBe(0);
  });
});
