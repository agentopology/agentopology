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
import { checkGuards } from "../../guard/check.js";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join } from "node:path";

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

/**
 * A gate after the entry agent. MEASURED on 19 Nov (live Claude Code, haiku,
 * `claude --agent manager`): Stop fired with agent_type "manager" and
 * SubagentStop did not; in the control run SubagentStop fired for a spawned
 * helper. The settings.json `agent` key is the same mechanism as --agent
 * (the sub-agents doc: the flag overrides the setting): INFERRED.
 */
describe("claude-code: a gate after the entry agent", () => {
  const gates = (body: string) => `gates {
    gate check {
      ${body}
      run: "scripts/check.sh"
    }
  }`;
  const withGate = (entry: string, body: string) =>
    topo(entry).replace("  flow {", `  ${gates(body)}\n  flow {`);
  const stopMatchers = (files: GeneratedFile[]) =>
    ((settingsOf(files).hooks?.SubagentStop ?? []) as Array<{ matcher: string }>).map((e) => e.matcher);

  it("writes no SubagentStop entry for the entry agent, and warns", () => {
    const { out, said } = quiet(() => claudeCodeBinding.scaffold(parse(withGate("entry: lead", "after: lead"))));
    expect(stopMatchers(out)).not.toContain("lead");
    expect(said.some((m) => /check/.test(m) && /entry agent/.test(m))).toBe(true);
  });

  it("still wires a gate after another agent", () => {
    const { out } = quiet(() => claudeCodeBinding.scaffold(parse(withGate("entry: lead", "after: worker"))));
    expect(stopMatchers(out)).toEqual(["worker"]);
  });

  it("without an entry, a gate after lead is wired on SubagentStop as before", () => {
    const { out } = quiet(() => claudeCodeBinding.scaffold(parse(withGate("", "after: lead"))));
    expect(stopMatchers(out)).toEqual(["lead"]);
  });

  it("with before: an agent, the gate runs before that agent launches instead", () => {
    const { out } = quiet(() => claudeCodeBinding.scaffold(parse(withGate("entry: lead", "after: lead\n      before: worker"))));
    expect(stopMatchers(out)).not.toContain("lead");
    const pre = (settingsOf(out).hooks?.PreToolUse ?? []) as Array<{ matcher: string; hooks: Array<{ command: string }> }>;
    expect(pre.some((e) => e.matcher === "Agent|Task" && e.hooks.some((h) => h.command.includes("before-agent.sh")))).toBe(true);
  });

  it("codex has no entry agent, so its SubagentStop entry for lead stays", () => {
    const { out } = quiet(() => codexBinding.scaffold(parse(codexSource(withGate("entry: lead", "after: lead")))));
    const hooks = JSON.parse(out.find((f) => f.path === ".codex/hooks.json")!.content);
    expect((hooks.hooks?.SubagentStop ?? []).map((e: { matcher: string }) => e.matcher)).toContain("lead");
  });

  it("guard --check grades it hope, saying why, instead of refuse", () => {
    const src = withGate("entry: lead", "after: lead");
    const { out } = quiet(() => claudeCodeBinding.scaffold(parse(src)));
    const root = fs.mkdtempSync(join(os.tmpdir(), "at-entry-gate-"));
    try {
      for (const f of out) {
        fs.mkdirSync(dirname(join(root, f.path)), { recursive: true });
        fs.writeFileSync(join(root, f.path), f.content);
      }
      const item = checkGuards(parse(src), root).items.find((i) => i.kind === "gate" && i.id === "check")!;
      expect(item.strength).toBe("hope");
      expect(item.where).toMatch(/entry agent/);
      expect(item.where).toMatch(/SubagentStop never fires/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("claude-code: the settings agent value is the agent file's name", () => {
  it("writes the claude-code name extension when the entry agent carries one", () => {
    const src = topo("entry: lead").replace(`description: "Leads the session"`, `description: "Leads the session"
    extensions {
      claude-code {
        name: boss
      }
    }`);
    const { out } = quiet(() => claudeCodeBinding.scaffold(parse(src)));
    expect(settingsOf(out).agent).toBe("boss");
    expect(out.find((f) => f.path === ".claude/agents/lead/AGENT.md")!.content).toMatch(/^name: boss$/m);
  });

  it("does not write an extension agent that names an agent Claude Code cannot start, and warns", () => {
    const src = topo("", `extensions {
    claude-code {
      agent: helper
    }
  }`).replace("  flow {", `  agent helper {
    model: sonnet
    description: "Helps"
    runs: inline
    invocation: manual
    prompt { Help. }
  }
  flow {`);
    const { out, said } = quiet(() => claudeCodeBinding.scaffold(parse(src)));
    expect(settingsOf(out).agent).toBeUndefined();
    expect(said.some((m) => /helper/.test(m) && /agent/.test(m))).toBe(true);
  });
});

describe("claude-code: entry changed between two scaffolds", () => {
  it("the file keeps the earlier value and the run names it; deleting the key lets the new value in", () => {
    const first = quiet(() => claudeCodeBinding.scaffold(parse(topo("entry: lead")))).out;
    const second = quiet(() => claudeCodeBinding.scaffold(parse(topo("entry: worker")))).out;
    const onDisk = first.find((f) => f.path === ".claude/settings.json")!.content;
    const next = second.find((f) => f.path === ".claude/settings.json")!.content;
    expect(JSON.parse(deepMergeSettingsJson(onDisk, next)).agent).toBe("lead");
    expect(keptSettings(onDisk, next, ".claude/settings.json").find((k) => k.key === "agent")!.line)
      .toMatch(/file has "lead", the \.at states "worker"/);
    const withoutKey = JSON.stringify({ ...JSON.parse(onDisk), agent: undefined }, null, 2);
    expect(JSON.parse(deepMergeSettingsJson(withoutKey, next)).agent).toBe("worker");
  });
});

// ---------------------------------------------------------------------------
// Round 2: the file on disk decides which agent the session runs as.
// ---------------------------------------------------------------------------

const GATE_AFTER_LEAD = `gates {
    gate check {
      after: lead
      run: "scripts/check.sh"
    }
  }`;
const withGates = (src: string, gates: string) => src.replace("  flow {", `  ${gates}\n  flow {`);

/** Write generated files into a fresh temp root, settings.json merged into what is there. */
function writeInto(root: string, files: GeneratedFile[]): void {
  for (const f of files) {
    const abs = join(root, f.path);
    fs.mkdirSync(dirname(abs), { recursive: true });
    if (f.path === ".claude/settings.json" && fs.existsSync(abs)) {
      fs.writeFileSync(abs, deepMergeSettingsJson(fs.readFileSync(abs, "utf-8"), f.content));
    } else {
      fs.writeFileSync(abs, f.content);
    }
  }
}

describe("entry removed between two scaffolds", () => {
  const withEntry = withGates(topo("entry: lead"), GATE_AFTER_LEAD);
  const without = withGates(topo(""), GATE_AFTER_LEAD);

  it("scaffold says the file keeps agent when the .at states none", () => {
    const first = quiet(() => claudeCodeBinding.scaffold(parse(withEntry))).out.find((f) => f.path === ".claude/settings.json")!.content;
    const second = quiet(() => claudeCodeBinding.scaffold(parse(without))).out.find((f) => f.path === ".claude/settings.json")!.content;
    const kept = keptSettings(first, second, ".claude/settings.json").find((k) => k.key === "agent");
    expect(kept).toBeDefined();
    expect(kept!.line).toMatch(/file has "lead", the \.at states none/);
  });

  it("the binding, which cannot see the file, writes SubagentStop[lead] again; guard --check reads the file and grades the gate hope", () => {
    const root = fs.mkdtempSync(join(os.tmpdir(), "at-entry-removed-"));
    try {
      writeInto(root, quiet(() => claudeCodeBinding.scaffold(parse(withEntry))).out);
      const second = quiet(() => claudeCodeBinding.scaffold(parse(without))).out;
      expect(((settingsOf(second).hooks?.SubagentStop ?? []) as Array<{ matcher: string }>).map((e) => e.matcher)).toEqual(["lead"]);
      writeInto(root, second);
      const onDisk = JSON.parse(fs.readFileSync(join(root, ".claude/settings.json"), "utf-8"));
      expect(onDisk.agent).toBe("lead");
      const item = checkGuards(parse(without), root).items.find((i) => i.kind === "gate" && i.id === "check")!;
      expect(item.strength).toBe("hope");
      expect(item.where).toMatch(/settings\.json agent/);
      expect(item.where).toMatch(/lead/);
      expect(item.where).toMatch(/SubagentStop never fires/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("entry removed: a gate before, and a human step before, the file's session agent", () => {
  const build = (entry: string, before: string) => withGates(topo(entry), `gates {
    gate check {
      after: intake
      before: ${before}
      run: "scripts/check.sh"
    }
  }`)
    .replace("  gates {", `  human approver {
    description: "Approves"
  }
  gates {`)
    .replace("intake -> lead", "intake -> approver\n    approver -> lead");

  const grade = (before: string) => {
    const root = fs.mkdtempSync(join(os.tmpdir(), "at-entry-removed-before-"));
    try {
      writeInto(root, quiet(() => claudeCodeBinding.scaffold(parse(build("entry: lead", before)))).out);
      const without = build("", before);
      writeInto(root, quiet(() => claudeCodeBinding.scaffold(parse(without))).out);
      expect(JSON.parse(fs.readFileSync(join(root, ".claude/settings.json"), "utf-8")).agent).toBe("lead");
      return checkGuards(parse(without), root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };

  it("grades both hope, naming the file's agent: lead is never launched (enforcement 0 of 2)", () => {
    const report = grade("lead");
    const gate = report.items.find((i) => i.kind === "gate" && i.id === "check")!;
    const human = report.items.find((i) => i.kind === "human" && i.id === "approver")!;
    for (const item of [gate, human]) {
      expect(item.strength).toBe("hope");
      expect(item.where).toMatch(/settings\.json agent is "lead"/);
      expect(item.where).toMatch(/never launched/);
      expect(item.notes.join(" ")).toMatch(/delete "agent" from \.claude\/settings\.json/);
    }
    expect(report.enforcement).toEqual({ refuse: 0, of: 2 });
  });

  it("a gate before lead and worker keeps worker, with a note naming lead", () => {
    const gate = grade("[lead, worker]").items.find((i) => i.kind === "gate" && i.id === "check")!;
    expect(gate.strength).toBe("refuse");
    expect(gate.where).toMatch(/launching worker/);
    expect(gate.where).not.toMatch(/lead/);
    expect(gate.notes.join(" ")).toMatch(/settings\.json agent is "lead"/);
  });
});

describe("the extension names an agent Claude Code cannot start, beside an entry", () => {
  const src = withGates(topo("entry: lead", `extensions {
    claude-code {
      agent: sk
    }
  }`), GATE_AFTER_LEAD).replace("  gates {", `  agent sk {
    model: sonnet
    description: "Skill"
    runs: inline
    invocation: manual
    prompt { Skill. }
  }
  gates {`);

  it("the entry is written, and the session is lead everywhere (no SubagentStop for it)", () => {
    const { out } = quiet(() => claudeCodeBinding.scaffold(parse(src)));
    expect(settingsOf(out).agent).toBe("lead");
    expect(((settingsOf(out).hooks?.SubagentStop ?? []) as Array<{ matcher: string }>).map((e) => e.matcher)).not.toContain("lead");
  });

  it("V134 gives one true message about the extension, and no differ warning", () => {
    const v = validate(parse(src)).filter((r) => r.rule === "V134" && /extensions/.test(r.message));
    expect(v).toHaveLength(1);
    expect(v[0].message).toMatch(/not written/);
    expect(v[0].message).toMatch(/settings\.json gets the entry "lead"/);
    expect(validate(parse(src)).some((r) => r.rule === "V134" && /settings\.json gets agent: "sk"/.test(r.message))).toBe(false);
  });
});

describe("a gate after both the entry agent and a subagent", () => {
  const src = withGates(topo("entry: lead"), `gates {
    gate check {
      after: [worker, lead]
      run: "scripts/check.sh"
    }
  }`);

  it("wires SubagentStop for worker only, and warns only about lead", () => {
    const { out, said } = quiet(() => claudeCodeBinding.scaffold(parse(src)));
    expect(((settingsOf(out).hooks?.SubagentStop ?? []) as Array<{ matcher: string }>).map((e) => e.matcher)).toEqual(["worker"]);
    const gateWarn = said.filter((m) => /Gate "check"/.test(m));
    expect(gateWarn).toHaveLength(1);
    expect(gateWarn[0]).toMatch(/"lead", the entry agent/);
    expect(gateWarn[0]).not.toMatch(/"worker"/);
    const v = validate(parse(src)).filter((r) => r.rule === "V134" && r.node === "check");
    expect(v).toHaveLength(1);
    expect(v[0].message).toMatch(/after "lead"/);
  });

  it("the gate script header says SubagentStop on worker, and names lead as the entry agent", () => {
    const { out } = quiet(() => claudeCodeBinding.scaffold(parse(src)));
    const script = out.find((f) => f.path.endsWith("gate-check.sh"))!.content;
    expect(script).toMatch(/SubagentStop hook on agent "worker"/);
    expect(script).toMatch(/lead is the entry agent/);
    expect(script).not.toMatch(/is not an agent/);
  });

  it("a gate after the entry agent alone: the header says why, not 'is not an agent'", () => {
    const { out } = quiet(() => claudeCodeBinding.scaffold(parse(withGates(topo("entry: lead"), GATE_AFTER_LEAD))));
    const script = out.find((f) => f.path.endsWith("gate-check.sh"))!.content;
    expect(script).toMatch(/lead is the entry agent/);
    expect(script).not.toMatch(/is not an agent/);
  });

  it("guard --check grades it refuse on worker, with a note naming lead", () => {
    const root = fs.mkdtempSync(join(os.tmpdir(), "at-entry-mixed-"));
    try {
      writeInto(root, quiet(() => claudeCodeBinding.scaffold(parse(src))).out);
      const item = checkGuards(parse(src), root).items.find((i) => i.kind === "gate" && i.id === "check")!;
      expect(item.strength).toBe("refuse");
      expect(item.where).toMatch(/SubagentStop on worker/);
      expect(item.notes.join(" ")).toMatch(/lead.*entry agent/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("a gate before, and a human step before, the entry agent", () => {
  const gateBefore = withGates(topo("entry: lead"), `gates {
    gate check {
      after: intake
      before: lead
      run: "scripts/check.sh"
    }
  }`);
  const humanBefore = topo("entry: lead")
    .replace("  flow {", `  human approver {
    description: "Approves"
  }
  flow {`)
    .replace("intake -> lead", "intake -> approver\n    approver -> lead");

  it("V134 warns on the gate: the entry agent is never launched", () => {
    const v = validate(parse(gateBefore)).filter((r) => r.rule === "V134" && r.node === "check");
    expect(v).toHaveLength(1);
    expect(v[0].level).toBe("warning");
    expect(v[0].message).toMatch(/before "lead", the entry agent/);
    expect(v[0].message).toMatch(/never launched/);
  });

  it("V134 warns on the human step: its approval is never asked", () => {
    const v = validate(parse(humanBefore)).filter((r) => r.rule === "V134" && r.node === "approver");
    expect(v).toHaveLength(1);
    expect(v[0].level).toBe("warning");
    expect(v[0].message).toMatch(/approval is never asked/);
  });

  it("guard --check gives both the true reason", () => {
    for (const [src, kind, id] of [[gateBefore, "gate", "check"], [humanBefore, "human", "approver"]] as const) {
      const root = fs.mkdtempSync(join(os.tmpdir(), "at-entry-before-"));
      try {
        writeInto(root, quiet(() => claudeCodeBinding.scaffold(parse(src))).out);
        const item = checkGuards(parse(src), root).items.find((i) => i.kind === kind && i.id === id)!;
        expect(item.strength).toBe("hope");
        expect(item.where).toMatch(/lead, the entry agent/);
        expect(item.where).not.toMatch(/no agent follows it/);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });
});
