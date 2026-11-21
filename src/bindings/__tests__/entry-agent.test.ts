/**
 * `meta { entry: <agent> }` per binding.
 *
 * - claude-code writes `"agent": "<id>"` into .claude/settings.json: "To make
 *   it the default for every session in a project, set `agent` in
 *   `.claude/settings.json`" (code.claude.com/docs/en/sub-agents). An
 *   extensions { claude-code { agent } } value is the more specific one and is
 *   what is written; V134 warns when the two differ.
 * - codex: config.toml has no key that picks the primary session's agent; the
 *   `agents.*` keys declare roles for spawned subagents only
 *   (learn.chatgpt.com/docs/config-file/config-reference). Nothing is written;
 *   validate --target codex says so (CX5-entry).
 * - cursor: subagents are delegated to or invoked with /name; no file makes
 *   one the main chat's agent (cursor.com/docs/context/subagents). Nothing is
 *   written; scaffold warns.
 * - claude-workflow: the workflow script is run by a session; which agent that
 *   session is lives on the host (claude-code). Noted in the LOSSY report.
 */

import { describe, it, expect, vi } from "vitest";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { claudeCodeBinding } from "../claude-code.js";
import { codexBinding } from "../codex.js";
import { cursorBinding } from "../cursor.js";
import { claudeWorkflowBinding } from "../claude-workflow.js";
import { codexSource } from "./codex-models.js";
import { keptSettings } from "../../scaffold/settings-kept.js";
import { deepMergeSettingsJson } from "../../scaffold/merge.js";
import type { GeneratedFile } from "../types.js";

const topo = (entry: string, ext = "") => `topology t : [pipeline] {
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
  flow {
    intake -> lead
    lead -> worker
  }
  ${ext}
}`;

function quiet<T>(fn: () => T): { out: T; said: string[] } {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const out = fn();
    return { out, said: warn.mock.calls.map((c) => String(c[0])) };
  } finally {
    warn.mockRestore();
  }
}

const settingsOf = (files: GeneratedFile[]) => {
  const f = files.find((x) => x.path === ".claude/settings.json");
  return f ? JSON.parse(f.content) : {};
};

describe("claude-code: entry is the settings.json agent key", () => {
  it("writes agent: <entry>", () => {
    const { out } = quiet(() => claudeCodeBinding.scaffold(parse(topo("entry: lead"))));
    expect(settingsOf(out).agent).toBe("lead");
  });

  it("writes no agent key without an entry", () => {
    const { out } = quiet(() => claudeCodeBinding.scaffold(parse(topo(""))));
    expect(settingsOf(out).agent).toBeUndefined();
  });

  it("the entry agent still gets its own agent file (the setting names it)", () => {
    const { out } = quiet(() => claudeCodeBinding.scaffold(parse(topo("entry: lead"))));
    expect(out.some((f) => f.path === ".claude/agents/lead/AGENT.md")).toBe(true);
  });

  it("when extensions { claude-code { agent } } differs, the extension value is written", () => {
    const src = topo("entry: lead", `extensions {
    claude-code {
      agent: worker
    }
  }`);
    const { out } = quiet(() => claudeCodeBinding.scaffold(parse(src)));
    expect(settingsOf(out).agent).toBe("worker");
    const v = validate(parse(src)).filter((r) => r.rule === "V134");
    expect(v.map((r) => r.level)).toEqual(["warning"]);
  });

  it("when the extension names the same agent, it is written once and nothing is said", () => {
    const src = topo("entry: lead", `extensions {
    claude-code {
      agent: lead
    }
  }`);
    const { out } = quiet(() => claudeCodeBinding.scaffold(parse(src)));
    expect(settingsOf(out).agent).toBe("lead");
    expect(validate(parse(src)).filter((r) => r.rule === "V134" || r.rule === "V130")).toEqual([]);
  });

  it("under --allow-invalid an entry Claude Code cannot start is not written, with a warning", () => {
    const { out, said } = quiet(() => claudeCodeBinding.scaffold(parse(topo("entry: intake"))));
    expect(settingsOf(out).agent).toBeUndefined();
    expect(said.some((m) => /entry/.test(m) && /intake/.test(m))).toBe(true);
  });

  it("a user's own settings.json agent is kept like any other generated key, and the run says so", () => {
    const { out } = quiet(() => claudeCodeBinding.scaffold(parse(topo("entry: lead"))));
    const generated = out.find((f) => f.path === ".claude/settings.json")!.content;
    const existing = JSON.stringify({ agent: "mine" }, null, 2);
    expect(JSON.parse(deepMergeSettingsJson(existing, generated)).agent).toBe("mine");
    const kept = keptSettings(existing, generated, ".claude/settings.json");
    expect(kept.map((k) => k.key)).toContain("agent");
    expect(kept.find((k) => k.key === "agent")!.line).toMatch(/file has "mine", the \.at states "lead"/);
  });

  it("an existing settings.json without agent gets it added", () => {
    const { out } = quiet(() => claudeCodeBinding.scaffold(parse(topo("entry: lead"))));
    const generated = out.find((f) => f.path === ".claude/settings.json")!.content;
    const existing = JSON.stringify({ model: "opus" }, null, 2);
    const merged = JSON.parse(deepMergeSettingsJson(existing, generated));
    expect(merged.agent).toBe("lead");
    expect(merged.model).toBe("opus");
  });
});

describe("codex: no entry-agent concept", () => {
  it("writes nothing for entry and validate --target codex says so (CX5-entry)", () => {
    const src = codexSource(topo("entry: lead"));
    const { out } = quiet(() => codexBinding.scaffold(parse(src)));
    const { out: without } = quiet(() => codexBinding.scaffold(parse(codexSource(topo("")))));
    const byPath = (fs: GeneratedFile[]) => Object.fromEntries(fs.map((f) => [f.path, f.content]));
    expect(byPath(out)).toEqual(byPath(without));
    const cx = validate(parse(src), { target: "codex" }).filter((r) => r.rule === "CX5-entry");
    expect(cx).toHaveLength(1);
    expect(cx[0].level).toBe("warning");
    expect(cx[0].message).toContain("lead");
  });

  it("says nothing without an entry", () => {
    const cx = validate(parse(codexSource(topo(""))), { target: "codex" }).filter((r) => r.rule === "CX5-entry");
    expect(cx).toEqual([]);
  });
});

describe("cursor: no entry-agent concept", () => {
  it("writes nothing for entry and warns at scaffold", () => {
    const { out, said } = quiet(() => cursorBinding.scaffold(parse(topo("entry: lead"))));
    const { out: without } = quiet(() => cursorBinding.scaffold(parse(topo(""))));
    const byPath = (fs: GeneratedFile[]) => Object.fromEntries(fs.map((f) => [f.path, f.content]));
    expect(byPath(out)).toEqual(byPath(without));
    expect(said.some((m) => m.startsWith("[cursor]") && /entry/.test(m) && /lead/.test(m))).toBe(true);
  });

  it("does not warn without an entry", () => {
    const { said } = quiet(() => cursorBinding.scaffold(parse(topo(""))));
    expect(said.some((m) => /entry/.test(m))).toBe(false);
  });
});

describe("claude-workflow: entry is a host concern", () => {
  it("records entry in the LOSSY report as unrepresentable, pointing at the host's settings.json agent", () => {
    const { out } = quiet(() => claudeWorkflowBinding.scaffold(parse(topo("entry: lead"))));
    const report = out.find((f) => /LOSSY/i.test(f.path))!;
    expect(report).toBeDefined();
    expect(report.content).toMatch(/^### entry — `lead`$/m);
    expect(report.content).toMatch(/settings\.json/);
  });

  it("no entry note without an entry", () => {
    const { out } = quiet(() => claudeWorkflowBinding.scaffold(parse(topo(""))));
    const report = out.find((f) => /LOSSY/i.test(f.path))!;
    expect(report.content).not.toMatch(/^### entry/m);
  });
});
