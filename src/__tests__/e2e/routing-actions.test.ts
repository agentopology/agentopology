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
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import type { GateNode } from "../../parser/ast.js";
import { claudeCodeBinding, checkableActionGate } from "../../bindings/claude-code.js";
import { codexBinding } from "../../bindings/codex.js";
import { cursorBinding } from "../../bindings/cursor.js";
import { claudeWorkflowBinding } from "../../bindings/claude-workflow.js";
import { isStubContent } from "../../bindings/lib/stub.js";
import { plannedStubs } from "../../scaffold/stubs.js";
import type { GeneratedFile } from "../../bindings/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = fs.readFileSync(resolve(here, "fixtures/routing-actions/routing.at"), "utf-8");
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
