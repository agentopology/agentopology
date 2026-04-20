/**
 * Tests for Change 2: agentopology info warns about observability gaps.
 *
 * If a topology has agents but no SubagentStop/Stop hook, the analyzer
 * should emit a warning-level suggestion.
 */

import { describe, it, expect } from "vitest";
import { parse } from "../../parser/index.js";
import { analyze } from "../index.js";

// ---------------------------------------------------------------------------
// Topology WITHOUT any hooks — should warn
// ---------------------------------------------------------------------------

const NO_HOOKS_TOPOLOGY = `
topology no-hooks : [pipeline] {
  meta { version: "1.0.0" description: "No hooks at all" }
  orchestrator { model: opus handles: [start] }
  action start { kind: inline }
  agent worker-a { model: sonnet phase: 1 prompt { You are worker-a. } }
  agent worker-b { model: haiku phase: 2 prompt { You are worker-b. } }
  flow { start -> worker-a -> worker-b }
}
`;

// Topology WITH SubagentStop hook — should NOT warn
const WITH_SUBAGENT_STOP_TOPOLOGY = `
topology with-hooks : [pipeline] {
  meta { version: "1.0.0" description: "Has SubagentStop hook" }
  orchestrator { model: opus handles: [start] }
  action start { kind: inline }
  agent worker { model: sonnet phase: 1 prompt { You are worker. } }
  flow { start -> worker }
  hooks {
    hook log-finish {
      on: SubagentStop
      matcher: "worker"
      run: ".claude/scripts/log.sh"
      type: command
    }
  }
}
`;

// Topology WITH Stop hook — should NOT warn
const WITH_STOP_TOPOLOGY = `
topology with-stop : [pipeline] {
  meta { version: "1.0.0" description: "Has Stop hook" }
  orchestrator { model: opus handles: [start] }
  action start { kind: inline }
  agent worker { model: sonnet phase: 1 prompt { You are worker. } }
  flow { start -> worker }
  hooks {
    hook on-stop {
      on: Stop
      matcher: ""
      run: ".claude/scripts/stop.sh"
      type: command
    }
  }
}
`;

// Topology WITH enforced gate (compiles to SubagentStop) — should NOT warn
const WITH_GATE_TOPOLOGY = `
topology with-gate : [pipeline] {
  meta { version: "1.0.0" description: "Has an enforced gate" }
  orchestrator { model: opus handles: [start] }
  action start { kind: inline }
  agent worker { model: sonnet phase: 1 prompt { You are worker. } }
  flow { start -> worker }
  gates {
    gate quality-check {
      after: worker
      run: "scripts/check.sh"
      checks: [lint]
      on-fail: halt
    }
  }
}
`;

// Zero-agent topology — should NOT warn
const ZERO_AGENTS_TOPOLOGY = `
topology zero-agents : [pipeline] {
  meta { version: "1.0.0" description: "No agents" }
  orchestrator { model: opus handles: [start, done] }
  action start { kind: inline }
  action done { kind: report }
  flow { start -> done }
}
`;

describe("Change 2 — observability gap warning", () => {
  it("warns when topology has agents but NO hooks at all", () => {
    const ast = parse(NO_HOOKS_TOPOLOGY);
    const result = analyze(ast);
    const obsWarning = result.suggestions.find(
      (s) => s.message.includes("Observability gap"),
    );
    expect(obsWarning).toBeDefined();
    expect(obsWarning!.level).toBe("warning");
  });

  it("warning message contains agent count", () => {
    const ast = parse(NO_HOOKS_TOPOLOGY);
    const result = analyze(ast);
    const obsWarning = result.suggestions.find(
      (s) => s.message.includes("Observability gap"),
    );
    expect(obsWarning!.message).toContain("2");
  });

  it("warning message references SubagentStop", () => {
    const ast = parse(NO_HOOKS_TOPOLOGY);
    const result = analyze(ast);
    const obsWarning = result.suggestions.find(
      (s) => s.message.includes("Observability gap"),
    );
    expect(obsWarning!.message).toContain("SubagentStop");
  });

  it("does NOT warn when topology has a SubagentStop hook", () => {
    const ast = parse(WITH_SUBAGENT_STOP_TOPOLOGY);
    const result = analyze(ast);
    const obsWarning = result.suggestions.find(
      (s) => s.message.includes("Observability gap"),
    );
    expect(obsWarning).toBeUndefined();
  });

  it("does NOT warn when topology has a Stop hook", () => {
    const ast = parse(WITH_STOP_TOPOLOGY);
    const result = analyze(ast);
    const obsWarning = result.suggestions.find(
      (s) => s.message.includes("Observability gap"),
    );
    expect(obsWarning).toBeUndefined();
  });

  it("does NOT warn when topology has an enforced gate (compiles to SubagentStop)", () => {
    const ast = parse(WITH_GATE_TOPOLOGY);
    const result = analyze(ast);
    const obsWarning = result.suggestions.find(
      (s) => s.message.includes("Observability gap"),
    );
    expect(obsWarning).toBeUndefined();
  });

  it("does NOT warn for zero-agent topologies", () => {
    const ast = parse(ZERO_AGENTS_TOPOLOGY);
    const result = analyze(ast);
    const obsWarning = result.suggestions.find(
      (s) => s.message.includes("Observability gap"),
    );
    expect(obsWarning).toBeUndefined();
  });
});
