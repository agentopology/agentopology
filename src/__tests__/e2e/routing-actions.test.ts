/**
 * A decision or report action with no commands: is conversational routing,
 * like an inline one: the orchestrator does it in conversation, so scaffold
 * writes no stub for it (fixtures/routing-actions/routing.at).
 *
 * - claude-code: its action script says it is performed in conversation, the
 *   same body as an inline action's, carries no stub marker and is not
 *   counted; an external or git action with no commands stays a counted stub.
 * - a decision or report action that names commands still runs them.
 * - a gate before such an action is no script-step gate: the action's script
 *   holds no gate check, and every action script a generated file runs is written.
 * - codex, cursor and claude-workflow: no action stub for these kinds.
 * - V136: a schedule job that runs such an action, or an inline or kindless
 *   one with no commands, does nothing, so validate warns, naming the job,
 *   the action and its kind.
 * - guard --check and the stub line never read such an action as a gate, a
 *   check, a refuse or a stub.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { checkGuards } from "../../guard/check.js";
import type { GateNode } from "../../parser/ast.js";
import { claudeCodeBinding, checkableActionGate } from "../../bindings/claude-code.js";
import { codexBinding } from "../../bindings/codex.js";
import { cursorBinding } from "../../bindings/cursor.js";
import { claudeWorkflowBinding } from "../../bindings/claude-workflow.js";
import { isStubContent } from "../../bindings/lib/stub.js";
import { plannedStubs } from "../../scaffold/stubs.js";
import type { GeneratedFile } from "../../bindings/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "fixtures/routing-actions/routing.at");
const CLI = resolve(here, "../../../dist/cli/index.js");
const SOURCE = fs.readFileSync(FIXTURE, "utf-8");
const cli = (args: string[]) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  return { stdout: r.stdout, stderr: r.stderr, code: r.status };
};
const ast = parse(SOURCE);
/** Codex runs no Claude model: the same topology with a Codex model. */
const codexAst = parse(SOURCE.replaceAll("model: sonnet", "model: gpt-5.2"));

const quiet = <T>(f: () => T): T => {
  const warn = console.warn;
  console.warn = () => {};
  try { return f(); } finally { console.warn = warn; }
};
const ccFiles = (): GeneratedFile[] => quiet(() => claudeCodeBinding.scaffold(ast));
const ccScript = (id: string): GeneratedFile => {
  const f = ccFiles().find((x) => x.path === `.claude/skills/routing/scripts/action-${id}.sh`);
  expect(f, `action-${id}.sh is written`).toBeDefined();
  return f!;
};
/** A script's lines without its "# Action: <id> — <description>" header. */
const body = (f: GeneratedFile) => f.content.split("\n").filter((l) => !l.startsWith("# Action: "));

describe("claude-code: a decision or report action with no commands is routing, like inline", () => {
  it.each(["pick", "accept", "finish"])("action-%s.sh is no stub: it is performed in conversation, as an inline action is", (id) => {
    const script = ccScript(id);
    expect(isStubContent(script.content)).toBe(false);
    expect(script.content).toContain("# Performed by the orchestrator in conversation; nothing to run.");
    expect(script.content).not.toContain("exit 1");
    expect(script.content).not.toContain("TODO");
    expect(body(script)).toEqual(body(ccScript("chat")));
  });

  it("only the external and git actions with no commands are counted stubs", () => {
    const plan = plannedStubs(ast, "claude-code")!;
    expect(plan.stubs.filter((s) => s.kind === "action").map((s) => s.path)).toEqual([
      ".claude/skills/routing/scripts/action-pull.sh",
      ".claude/skills/routing/scripts/action-tag.sh",
    ]);
    expect(isStubContent(ccScript("pull").content)).toBe(true);
    expect(isStubContent(ccScript("tag").content)).toBe(true);
  });

  it.each([["choose-run", "./tools/choose --next"], ["report-run", "./tools/report --weekly"]])(
    "a %s action that names commands still runs them",
    (id, cmd) => {
      const script = ccScript(id);
      expect(isStubContent(script.content)).toBe(false);
      expect(script.content.split("\n")).toContain(cmd);
      expect(script.content).not.toContain("nothing to run");
    },
  );

  it("a gate before a decision action with no commands is no script-step gate: its script holds no gate check", () => {
    const gate = ast.nodes.find((n) => n.id === "ready") as GateNode;
    expect(checkableActionGate(ast, gate)).toBe(false);
    const script = ccScript("accept");
    expect(script.content).not.toContain("at_gate");
    expect(script.content).not.toContain("before-action.sh");
  });

  it("every action script a generated file runs is written (the schedule job's included)", () => {
    const files = ccFiles();
    const paths = new Set(files.map((f) => f.path));
    const refs = new Set<string>();
    for (const f of files) {
      for (const m of f.content.matchAll(/\.claude\/skills\/routing\/scripts\/action-[A-Za-z0-9_-]+\.sh/g)) refs.add(m[0]);
    }
    expect(refs).toContain(".claude/skills/routing/scripts/action-finish.sh");
    for (const r of refs) expect(paths, `${r} is referenced and written`).toContain(r);
  });
});

describe("V136: a schedule that runs a decision, report, inline or kindless action with no commands does nothing", () => {
  const v136 = () => validate(ast).filter((r) => r.rule === "V136");
  const WARNED = ["nightly-finish", "nightly-pick", "nightly-chat", "nightly-muse"];

  it("warns once per such job, naming the job, the action and its kind", () => {
    const found = v136();
    expect(found.map((r) => [r.level, r.node])).toEqual(WARNED.map((j) => ["warning", j]));
    expect(found[0].message).toContain('Schedule job "nightly-finish"');
    expect(found[0].message).toContain('action "finish"');
    expect(found[0].message).toContain("a report action with no commands");
    expect(found[1].message).toContain('Schedule job "nightly-pick"');
    expect(found[1].message).toContain('action "pick"');
    expect(found[1].message).toContain("a decision action with no commands");
    expect(found[2].message).toContain('Schedule job "nightly-chat"');
    expect(found[2].message).toContain('action "chat"');
    expect(found[2].message).toContain("an inline action with no commands");
    expect(found[3].message).toContain('Schedule job "nightly-muse"');
    expect(found[3].message).toContain('action "muse"');
    expect(found[3].message).toContain("an action with no kind and no commands");
  });

  it("is silent for a decision or inline action with commands, an external stub and an agent job", () => {
    const named = v136().map((r) => r.node);
    for (const job of ["nightly-choose", "nightly-chat-run", "nightly-pull", "nightly-write"]) expect(named).not.toContain(job);
  });

  it("warns on every target, since the job does nothing on any of them", () => {
    for (const target of ["claude-code", "codex", "cursor", "claude-workflow"]) {
      expect(validate(ast, { target }).filter((r) => r.rule === "V136").map((r) => r.node)).toEqual(WARNED);
    }
  });

  it("the kindless action's script says nothing to run, as an inline one's does", () => {
    const script = ccScript("muse");
    expect(isStubContent(script.content)).toBe(false);
    expect(body(script)).toEqual(body(ccScript("chat")));
  });

  it("validate prints it as a warning", () => {
    const r = cli(["validate", FIXTURE]);
    expect(r.stdout + r.stderr).toMatch(/WARN\s+\[V136\][^\n]*Schedule job "nightly-finish"/);
    expect(r.code).toBe(0);
  });
});

describe("guard --check and the stub count read a routing action as routing", () => {
  let tmp = "";
  beforeEach(() => { tmp = fs.mkdtempSync(join(os.tmpdir(), "at-routing-")); });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("guard --check grades no routing action as a gate, a check, a refuse or a stub", () => {
    for (const f of ccFiles()) {
      fs.mkdirSync(dirname(join(tmp, f.path)), { recursive: true });
      fs.writeFileSync(join(tmp, f.path), f.content, { mode: 0o755 });
    }
    const report = checkGuards(ast, tmp);
    const ids = report.items.map((i) => i.id);
    for (const id of ["pick", "accept", "finish", "chat"]) expect(ids).not.toContain(id);
    // The gate beside the routing action is graded on its own hook, never on the action's script.
    const ready = report.items.find((i) => i.id === "ready")!;
    expect(ready.kind).toBe("gate");
    expect(JSON.stringify(ready)).not.toMatch(/action-(pick|accept|finish)\.sh/);
    const out = cli(["guard", FIXTURE, "--check", "--dir", tmp]);
    expect(out.stdout + out.stderr).not.toMatch(/action-(pick|accept|finish|chat)\.sh/);
  });

  it("the stub line counts the gate check and the external and git actions only", () => {
    const r = cli(["validate", FIXTURE]);
    expect(r.stdout + r.stderr).toMatch(/stubs \(claude-code\): 3 of \d+ generated files are stubs: 1 gate check script, 2 action scripts\n/);
  });
});

describe("the other bindings write no action stub for a routing action", () => {
  it("codex writes no action script and counts no action stub", () => {
    const files = quiet(() => codexBinding.scaffold(codexAst));
    expect(files.filter((f) => /action-/.test(f.path))).toEqual([]);
    expect(plannedStubs(codexAst, "codex")!.stubs.filter((s) => s.kind === "action")).toEqual([]);
  });

  it("cursor writes each action's script, none of them a stub", () => {
    const files = quiet(() => cursorBinding.scaffold(ast));
    for (const id of ["pick", "accept", "finish", "chat"]) {
      const f = files.find((x) => x.path === `.cursor/scripts/actions/${id}.sh`);
      expect(f, `${id}.sh is written`).toBeDefined();
      expect(isStubContent(f!.content)).toBe(false);
    }
    expect(plannedStubs(ast, "cursor")!.stubs.filter((s) => s.kind === "action")).toEqual([]);
  });

  it("claude-workflow writes no action script and counts no action stub", () => {
    const files = quiet(() => claudeWorkflowBinding.scaffold(ast));
    expect(files.filter((f) => /action-/.test(f.path))).toEqual([]);
    expect(plannedStubs(ast, "claude-workflow")!.stubs.filter((s) => s.kind === "action")).toEqual([]);
  });
});
