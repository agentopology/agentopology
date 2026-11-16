/**
 * 0.11.4: the generated guard hooks refuse only what could be a gated step.
 *
 * Measured on 0.11.2 and 0.11.3 (p0hook probe): against a git commit / git
 * push step behind a refusing gate, 11 of 40 ordinary git commands were
 * refused (HEAD~1, @{u}, HEAD@{1}, ^{commit}: words bash leaves literal), and
 * with no jq on PATH every Bash command, every edit and every agent launch was
 * refused.
 *
 * Each case runs the generated hook the way the host does: a shell, a
 * subfolder as the current directory, the payload on stdin. The PATH is a
 * fresh folder of symlinks, with jq or without it.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { join } from "node:path";
import { parse } from "../../parser/index.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import { codexBinding } from "../../bindings/codex.js";
// @ts-expect-error plain JavaScript module, shared with freeze-hooks.mjs
import { TOPOLOGIES, MUST_NOT_BLOCK, MUST_BLOCK, runHook, scaffoldOne, toolPaths } from "./differential/hook-corpus.mjs";

const hasJq = spawnSync("/bin/sh", ["-c", "command -v jq"]).status === 0;
const lib = { parse, bindings: { "claude-code": claudeCodeBinding, codex: codexBinding } };
type Binding = "claude-code" | "codex";
type Scaffolded = { root: string; hooks: Array<{ hook: string; script: string }> };

const topo = (id: string) => TOPOLOGIES.find((t: { id: string }) => t.id === id);
const made = new Map<string, Scaffolded>();
/** The topology scaffolded once per binding. */
function scaffolded(id: string, binding: Binding): Scaffolded {
  const k = `${id}|${binding}`;
  if (!made.has(k)) made.set(k, scaffoldOne(lib, topo(id), binding));
  return made.get(k)!;
}
function scriptOf(id: string, binding: Binding, hook: string): { root: string; script: string } {
  const s = scaffolded(id, binding);
  const h = s.hooks.find((x) => x.hook === hook);
  if (!h) throw new Error(`${id} (${binding}) has no ${hook}`);
  return { root: s.root, script: h.script };
}

const bashIn = (command: string) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
const editIn = (binding: Binding, p: string) => binding === "codex"
  ? JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { command: `*** Begin Patch\n*** Update File: ${p}\n@@\n-a\n+b\n*** End Patch\n` } })
  : JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: p, old_string: "a", new_string: "b" } });
const launchIn = (binding: Binding, a: string) => binding === "codex"
  ? JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "collaborationspawn_agent", tool_input: { task_name: "t", agent_type: a, message: "go" } })
  : JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: a, prompt: "go" } });

let PATHS: { jq: string; nojq: string; hasJq: boolean };
beforeAll(() => { PATHS = toolPaths(); });

async function exits(id: string, binding: Binding, hook: string, payloads: Array<[string, string]>, jq: boolean) {
  const { root, script } = scriptOf(id, binding, hook);
  const out: Array<{ input: string; code: number | null; stderr: string }> = [];
  for (const [input, payload] of payloads) {
    const r = await runHook(script, root, binding, payload, jq ? PATHS.jq : PATHS.nojq);
    out.push({ input, ...r });
  }
  return out;
}
const lines = (s: string) => s.split("\n").filter((l) => l.trim() !== "");

describe.skipIf(!hasJq)("[0.11.4] before-action.sh lets ordinary commands run past a git commit / git push step", () => {
  for (const binding of ["claude-code", "codex"] as const) {
    it(`${binding}: every must-not-block command exits 0 (${MUST_NOT_BLOCK.length} commands)`, async () => {
      const rs = await exits("factory", binding, "before-action.sh", MUST_NOT_BLOCK.map((c: string) => [c, bashIn(c)]), true);
      const refused = rs.filter((r) => r.code !== 0).map((r) => `exit ${r.code}: ${r.input}`);
      expect(refused, refused.join("\n")).toEqual([]);
    }, 120_000);
  }
});

describe("[0.11.4] with no jq on PATH, a hook refuses only input that could hold its gated thing", () => {
  const NOTE = /jq is not installed/;

  for (const binding of ["claude-code", "codex"] as const) {
    it(`${binding}: before-action.sh lets git status and ls -la run, with one warning line`, async () => {
      for (const r of await exits("factory", binding, "before-action.sh", [["git status", bashIn("git status")], ["ls -la", bashIn("ls -la")]], false)) {
        expect(r.code, `${r.input}: ${r.stderr}`).toBe(0);
        expect(lines(r.stderr), r.input).toHaveLength(1);
        expect(r.stderr).toMatch(NOTE);
      }
    });

    it(`${binding}: before-edit.sh lets an edit of a file that is no ledger through, with one warning line`, async () => {
      for (const r of await exits("ship", binding, "before-edit.sh", [["src/a.ts", editIn(binding, "src/a.ts")], ["README.md", editIn(binding, "README.md")]], false)) {
        expect(r.code, `${r.input}: ${r.stderr}`).toBe(0);
        expect(lines(r.stderr), r.input).toHaveLength(1);
        expect(r.stderr).toMatch(NOTE);
      }
    });
  }

  it("claude-code: before-agent.sh launches an agent with no gate, with one warning line", async () => {
    for (const r of await exits("compile", "claude-code", "before-agent.sh", [["critic", launchIn("claude-code", "critic")], ["tidy", launchIn("claude-code", "tidy")]], false)) {
      expect(r.code, `${r.input}: ${r.stderr}`).toBe(0);
      expect(lines(r.stderr), r.input).toHaveLength(1);
      expect(r.stderr).toMatch(NOTE);
    }
  });

  it("codex: before-agent.sh launches an agent with no gate and no approval step, with one warning line", async () => {
    for (const r of await exits("cxgates", "codex", "before-agent.sh", [["someone-else", launchIn("codex", "someone-else")]], false)) {
      expect(r.code, `${r.input}: ${r.stderr}`).toBe(0);
      expect(lines(r.stderr), r.input).toHaveLength(1);
      expect(r.stderr).toMatch(NOTE);
    }
  });
});

describe.skipIf(!hasJq)("[0.11.4] MUST BLOCK with jq: a commit or a push, plain or in a form the guard cannot read", () => {
  for (const binding of ["claude-code", "codex"] as const) {
    it(`${binding}: every must-block command exits 2 (${MUST_BLOCK.length} commands)`, async () => {
      const rs = await exits("factory", binding, "before-action.sh", MUST_BLOCK.map((c: string) => [c, bashIn(c)]), true);
      const passed = rs.filter((r) => r.code !== 2).map((r) => `exit ${r.code}: ${r.input}`);
      expect(passed, passed.join("\n")).toEqual([]);
    }, 120_000);
  }
});

describe("[0.11.4] MUST BLOCK with no jq: input that could hold the gated thing keeps today's refusal", () => {
  const REQUIRED = /jq is required/;
  const refused = (r: { input: string; code: number | null; stderr: string }) => {
    expect(r.code, `${r.input}: ${r.stderr}`).toBe(2);
    expect(r.stderr, r.input).toMatch(REQUIRED);
  };
  /** A launch: exit 2 (0.11.3's message for a missing jq read "not valid JSON"). */
  const refusedLaunch = (r: { input: string; code: number | null; stderr: string }) => {
    expect(r.code, `${r.input}: ${r.stderr}`).toBe(2);
  };

  for (const binding of ["claude-code", "codex"] as const) {
    it(`${binding}: before-action.sh refuses a step, plain, chained, hidden in an expansion or behind a \\u escape`, async () => {
      const raw = (c: string) => `{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"${c}"}}`;
      const cases: Array<[string, string]> = [
        ["git commit -m x", bashIn("git commit -m x")],
        ["git push origin main", bashIn("git push origin main")],
        ["ls && git commit", bashIn("ls && git commit")],
        ["g=git; $g commit", bashIn("g=git; $g commit")],
        ["git c${x}ommit", bashIn("git c${x}ommit")],
        ["git co?mit", bashIn("git co?mit")],
        ["git co\\\\nmmit (a line continuation)", raw("git co\\\\\\nmmit")],
        ["git commi\\\\t (a backslash before a letter)", raw("git commi\\\\t")],
        ["git \\u0063ommit", raw("git \\u0063ommit")],
        ["ls \\u002dla", raw("ls \\u002dla")],
      ];
      for (const r of await exits("factory", binding, "before-action.sh", cases, false)) refused(r);
      for (const r of await exits("ship", binding, "before-action.sh", [["./tool publish ep1", bashIn("./tool publish ep1")], ["echo x > logs/ep1/trace.jsonl", bashIn("echo x > logs/ep1/trace.jsonl")]], false)) refused(r);
    });

    it(`${binding}: before-edit.sh refuses an edit of a ledger, in any spelling, and an edit behind a \\u escape`, async () => {
      const cases: Array<[string, string]> = ["logs/ep1/trace.jsonl", "logs/ep1/TRACE.JSONL", "other/trace.jsonl", "./logs/../logs/ep1/trace.jsonl"].map((p) => [p, editIn(binding, p)]);
      cases.push(["src/\\u0061.ts", binding === "codex"
        ? '{"hook_event_name":"PreToolUse","tool_name":"apply_patch","tool_input":{"command":"*** Begin Patch\\n*** Update File: src/\\u0061.ts\\n*** End Patch\\n"}}'
        : '{"hook_event_name":"PreToolUse","tool_name":"Edit","tool_input":{"file_path":"src/\\u0061.ts"}}']);
      for (const r of await exits("ship", binding, "before-edit.sh", cases, false)) refused(r);
    });
  }

  it("claude-code: before-agent.sh refuses the launch of a gated agent, in any spelling, and a launch behind a \\u escape", async () => {
    const cases: Array<[string, string]> = ["drafter", "Drafter", " drafter ", "agents/drafter", "drafter:"].map((a) => [a, launchIn("claude-code", a)]);
    cases.push(["cr\\u0069tic", '{"hook_event_name":"PreToolUse","tool_name":"Agent","tool_input":{"subagent_type":"cr\\u0069tic"}}']);
    for (const r of await exits("compile", "claude-code", "before-agent.sh", cases, false)) refusedLaunch(r);
  });

  it("codex: before-agent.sh refuses the launch of an agent held by a gate or an approval step", async () => {
    for (const r of await exits("cxgates", "codex", "before-agent.sh", [["editor", launchIn("codex", "editor")], ["Editor", launchIn("codex", "Editor")]], false)) refusedLaunch(r);
  });

  it("a launch refused for a missing jq says so (it used to say the input was not valid JSON)", async () => {
    for (const [id, binding, agent] of [["compile", "claude-code", "drafter"], ["cxgates", "codex", "editor"]] as const) {
      for (const r of await exits(id, binding, "before-agent.sh", [[agent, launchIn(binding, agent)]], false)) {
        refused(r);
        expect(r.stderr).toContain("jq is required to check this launch, so it is blocked");
      }
    }
  });

  it("the action script's own gate check still refuses with no jq: the script IS the step", () => {
    const { root } = scaffolded("factory", "claude-code");
    const script = join(root, ".claude/skills/factory/scripts/action-commit.sh");
    expect(fs.readFileSync(script, "utf8")).toContain("jq is required to check the gates of step commit");
    const r = spawnSync("bash", [script], { cwd: root, env: { PATH: PATHS.nojq, HOME: root }, encoding: "utf8", timeout: 20_000 });
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toContain("jq is required to check the gates of step commit, so it does not run");
  });
});
