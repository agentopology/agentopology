/**
 * Tests for Change 1: Observability hook shortcut — SubagentStop in global hooks {}.
 *
 * Validates that a `hooks {}` block with `on: SubagentStop` compiles to
 * a correctly-formed settings.json entry, preserving the run path as-is
 * (not rewritten to the skills/ directory) and preserving matcher.
 */

import { describe, it, expect } from "vitest";
import { parse } from "../../parser/index.js";
import { bindings } from "../index.js";
import type { GeneratedFile } from "../types.js";

// ---------------------------------------------------------------------------
// Change 1 — SubagentStop observability hook in global hooks {} block
// ---------------------------------------------------------------------------

const OBS_TOPOLOGY = `
topology obs-test : [supervisor] {
  meta {
    version: "1.0.0"
    description: "Observability hook test"
  }
  orchestrator {
    model: opus
    handles: [start]
  }
  action start { kind: inline }
  agent amitai-cos {
    model: opus
    phase: 1
    prompt { You are amitai-cos. }
  }
  agent nadav-cos {
    model: opus
    phase: 1
    prompt { You are nadav-cos. }
  }
  agent ops-agent {
    model: sonnet
    phase: 2
    prompt { You are ops-agent. }
  }
  flow {
    start -> amitai-cos
    start -> nadav-cos
    amitai-cos -> ops-agent
    nadav-cos -> ops-agent
  }
  hooks {
    hook log-subagent-finish {
      on: SubagentStop
      matcher: "amitai-cos|nadav-cos|ops-agent"
      run: ".claude/scripts/log-subagent.sh"
      type: command
      timeout: 5000
    }
  }
}
`;

describe("Change 1 — observability SubagentStop hook", () => {
  const ast = parse(OBS_TOPOLOGY);
  const binding = bindings["claude-code"];
  const files: GeneratedFile[] = binding.scaffold(ast);

  it("emits settings.json with SubagentStop block", () => {
    const settingsFile = files.find((f) => f.path === ".claude/settings.json");
    expect(settingsFile).toBeDefined();
    const settings = JSON.parse(settingsFile!.content);
    expect(settings.hooks).toBeDefined();
    expect(settings.hooks.SubagentStop).toBeDefined();
  });

  it("SubagentStop entry has the matcher preserved verbatim", () => {
    const settingsFile = files.find((f) => f.path === ".claude/settings.json");
    const settings = JSON.parse(settingsFile!.content);
    const block = settings.hooks.SubagentStop as Array<Record<string, unknown>>;
    const obsHook = block.find((h) => h.matcher === "amitai-cos|nadav-cos|ops-agent");
    expect(obsHook).toBeDefined();
  });

  it("SubagentStop command uses the hook run path as-is (not rewritten to skills/)", () => {
    const settingsFile = files.find((f) => f.path === ".claude/settings.json");
    const settings = JSON.parse(settingsFile!.content);
    const block = settings.hooks.SubagentStop as Array<Record<string, unknown>>;
    const obsHook = block.find((h) => h.matcher === "amitai-cos|nadav-cos|ops-agent");
    expect(obsHook).toBeDefined();
    const hookDefs = obsHook!.hooks as Array<Record<string, unknown>>;
    // The command must reference the actual path, not a rewritten skills/ path
    expect(hookDefs[0].command).toContain(".claude/scripts/log-subagent.sh");
  });

  it("SubagentStop entry has the timeout preserved", () => {
    const settingsFile = files.find((f) => f.path === ".claude/settings.json");
    const settings = JSON.parse(settingsFile!.content);
    const block = settings.hooks.SubagentStop as Array<Record<string, unknown>>;
    const obsHook = block.find((h) => h.matcher === "amitai-cos|nadav-cos|ops-agent");
    const hookDefs = obsHook!.hooks as Array<Record<string, unknown>>;
    expect(hookDefs[0].timeout).toBe(5000);
  });

  it("type is 'command'", () => {
    const settingsFile = files.find((f) => f.path === ".claude/settings.json");
    const settings = JSON.parse(settingsFile!.content);
    const block = settings.hooks.SubagentStop as Array<Record<string, unknown>>;
    const obsHook = block.find((h) => h.matcher === "amitai-cos|nadav-cos|ops-agent");
    const hookDefs = obsHook!.hooks as Array<Record<string, unknown>>;
    expect(hookDefs[0].type).toBe("command");
  });
});

// ---------------------------------------------------------------------------
// Change 1 — Existing PostToolUse hook still uses skills/ path (no regression)
// ---------------------------------------------------------------------------

const PTLU_TOPOLOGY = `
topology ptlu-test : [pipeline] {
  meta { version: "1.0.0" description: "PostToolUse hook test" }
  orchestrator { model: opus handles: [start] }
  action start { kind: inline }
  agent worker { model: sonnet phase: 1 prompt { You are worker. } }
  flow { start -> worker }
  hooks {
    hook post-write {
      on: PostToolUse
      matcher: Write
      run: "scripts/post-write.sh"
      type: command
    }
  }
}
`;

describe("Change 1 — PostToolUse hook still goes through skills/ (no regression)", () => {
  const ast = parse(PTLU_TOPOLOGY);
  const binding = bindings["claude-code"];
  const files: GeneratedFile[] = binding.scaffold(ast);

  it("PostToolUse hook uses skills/ path for non-absolute hook run paths", () => {
    const settingsFile = files.find((f) => f.path === ".claude/settings.json");
    expect(settingsFile).toBeDefined();
    const settings = JSON.parse(settingsFile!.content);
    const block = settings.hooks.PostToolUse as Array<Record<string, unknown>>;
    expect(block).toBeDefined();
    const hookDefs = block[0].hooks as Array<Record<string, unknown>>;
    expect(hookDefs[0].command as string).toContain("skills/");
  });
});
