/**
 * `agentopology guard <file> --test`: run the `tests { refuse: [..] allow: [..] }`
 * rows of the gates and hooks through the real generated scripts.
 *
 * Each row is fed the way the host feeds a hook: a PreToolUse event as JSON on
 * stdin, a shell, the project folder as the current directory and (Claude
 * Code) CLAUDE_PROJECT_DIR set.
 *
 * - A gate that holds a script step (before-action.sh) gets the row as a Bash
 *   command. A gate that holds a subagent launch (before-agent.sh) gets the
 *   row as the agent's name in the Agent tool's input (Codex: its spawn tool).
 * - A hook gets the row as a Bash command, through its own `run:` command.
 *
 * Exit 2 is a refusal, 0 is allowed. A gate in `mode: shadow` exits 0 whatever
 * it would refuse; it counts as refused when it logged the row to
 * logs/shadow.jsonl, and says so.
 *
 * @module
 */

import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { GateNode, HookDef, TopologyAST } from "../parser/ast.js";
import { claudeCodeBinding } from "../bindings/claude-code.js";
import { codexBinding } from "../bindings/codex.js";
import { CLAUDE_CODE_GUARDS, CODEX_GUARDS, gateChecks, spawnHeldAgents, type GuardPlatform } from "../bindings/lib/guards.js";

export type Verdict = "refused" | "allowed";

export interface TestRowResult {
  /** `gate` or `hook`, and its id. */
  kind: "gate" | "hook";
  owner: string;
  /** The script that was run, project-relative, or the hook's command. */
  via: string;
  /** The row as written. */
  text: string;
  expected: Verdict;
  /** What the script did; `error` when it could not be run or exited with something other than 0 or 2. */
  got: Verdict | "error";
  /** True when it matches the expectation. */
  ok: boolean;
  /** Why, when it is a miss or an error, or a note (shadow). */
  note?: string;
}

export interface TestRun {
  results: TestRowResult[];
  /** Rows that did not match. */
  misses: number;
  /** The folder the scripts were run in. */
  dir: string;
}

const ROW_TIMEOUT_MS = 30_000;

const bashPayload = (command: string) =>
  JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });

const agentPayload = (p: GuardPlatform, name: string) =>
  p.id === "codex"
    ? JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "collaborationspawn_agent", tool_input: { task_name: "t", agent_type: name, message: "go" } })
    : JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: name, prompt: "go" } });

/** Every gate and hook that has a tests block with at least one row. */
function testedGates(ast: TopologyAST): GateNode[] {
  return ast.nodes.filter((n): n is GateNode => n.type === "gate" && !!(n as GateNode).tests);
}

function testedHooks(ast: TopologyAST): HookDef[] {
  return [...(ast.hooks ?? []), ...ast.nodes.flatMap((n) => (n.type === "agent" ? (n as { hooks?: HookDef[] }).hooks ?? [] : []))].filter((h) => !!h.tests);
}

/** Whether the topology has any tests row to run. */
export function hasTests(ast: TopologyAST): boolean {
  const rows = (t?: { refuse: string[]; allow: string[] }) => (t ? t.refuse.length + t.allow.length : 0);
  return testedGates(ast).some((g) => rows(g.tests) > 0) || testedHooks(ast).some((h) => rows(h.tests) > 0);
}

/**
 * Write the scaffold's files into `dir`, keeping any file already there (a
 * project's own script is the one to test), then run every tests row.
 */
export function runGuardTests(ast: TopologyAST, dir: string, target: "claude-code" | "codex" = "claude-code"): TestRun {
  const p = target === "codex" ? CODEX_GUARDS : CLAUDE_CODE_GUARDS;
  const binding = target === "codex" ? codexBinding : claudeCodeBinding;
  for (const f of binding.scaffold(ast)) {
    const to = join(dir, f.path);
    if (fs.existsSync(to)) continue;
    fs.mkdirSync(dirname(to), { recursive: true });
    fs.writeFileSync(to, f.content);
    if (f.executable) fs.chmodSync(to, 0o755);
  }
  const name = ast.topology.name;
  const env = { ...process.env } as NodeJS.ProcessEnv;
  if (p.projectDirVar) env[p.projectDirVar] = dir;
  else delete env.CLAUDE_PROJECT_DIR;

  const shadowRows = () => {
    const f = join(dir, "logs/shadow.jsonl");
    return fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).length : 0;
  };
  const results: TestRowResult[] = [];

  const feed = (cmd: string[], input: string): { status: number | null; stderr: string; error?: string } => {
    const r = spawnSync(cmd[0], cmd.slice(1), { cwd: dir, input, env, encoding: "utf8", timeout: ROW_TIMEOUT_MS });
    return { status: r.status, stderr: r.stderr ?? "", ...(r.error ? { error: r.error.message } : {}) };
  };

  const record = (
    base: Pick<TestRowResult, "kind" | "owner" | "via" | "text" | "expected">,
    run: { status: number | null; stderr: string; error?: string },
    shadowed: boolean,
  ) => {
    let got: TestRowResult["got"];
    let note: string | undefined;
    if (run.status === 2) got = "refused";
    else if (run.status === 0) {
      got = shadowed ? "refused" : "allowed";
      if (shadowed) note = "mode: shadow: logged to logs/shadow.jsonl, the step is not stopped";
    } else {
      got = "error";
      note = run.error ?? `exited ${run.status}: ${run.stderr.trim().split("\n").pop() ?? ""}`;
    }
    const ok = got === base.expected;
    if (!ok && got !== "error" && !note) note = `expected ${base.expected}${run.stderr.trim() ? `: ${run.stderr.trim().split("\n")[0]}` : ""}`;
    results.push({ ...base, got, ok, ...(note ? { note } : {}) });
  };

  for (const gate of testedGates(ast)) {
    const tests = gate.tests!;
    const checks = gateChecks(ast, gate, p);
    const held = spawnHeldAgents(ast, gate, p);
    const rows: Array<[string, Verdict]> = [...tests.refuse.map((t): [string, Verdict] => [t, "refused"]), ...tests.allow.map((t): [string, Verdict] => [t, "allowed"])];
    for (const [text, expected] of rows) {
      const base = { kind: "gate" as const, owner: gate.id, text, expected };
      // A row that is a held agent's name goes to the launch check when the gate holds both a step and a launch.
      const asAgent = checks.includes("agent") && (!checks.includes("action") || held.includes(text));
      const script = `${p.scriptsDir(name)}/${asAgent ? "before-agent.sh" : "before-action.sh"}`;
      if (checks.length === 0) {
        results.push({ ...base, via: "-", got: "error", ok: false, note: "no generated check runs this gate (V137)" });
        continue;
      }
      if (!fs.existsSync(join(dir, script))) {
        results.push({ ...base, via: script, got: "error", ok: false, note: `${script} was not generated` });
        continue;
      }
      const before = shadowRows();
      const run = feed(["bash", join(dir, script)], asAgent ? agentPayload(p, text) : bashPayload(text));
      record({ ...base, via: script }, run, run.status === 0 && shadowRows() > before);
    }
  }

  for (const hook of testedHooks(ast)) {
    const tests = hook.tests!;
    const rows: Array<[string, Verdict]> = [...tests.refuse.map((t): [string, Verdict] => [t, "refused"]), ...tests.allow.map((t): [string, Verdict] => [t, "allowed"])];
    for (const [text, expected] of rows) {
      const base = { kind: "hook" as const, owner: hook.name, text, expected, via: hook.run };
      if (!hook.run || (hook.type && hook.type !== "command") || hook.on !== "PreToolUse") {
        results.push({ ...base, got: "error", ok: false, note: "not a PreToolUse command hook with a run: (V137)" });
        continue;
      }
      record(base, feed(["/bin/sh", "-c", hook.run], bashPayload(text)), false);
    }
  }

  return { results, misses: results.filter((r) => !r.ok).length, dir };
}

/** Where `--test --dir D` leaves what it found, for `guard --check` to read. */
export const TEST_RESULTS_FILE = ".agentopology/guard-test.json";

const hashOf = (source: string) => createHash("sha256").update(source).digest("hex");

/**
 * Write the gates whose rows all matched to <dir>/.agentopology/guard-test.json,
 * with the hash of the .at text they were run from: `guard --check` marks a gate
 * `tested` only while the file it is given is that text.
 */
export function writeTestResults(dir: string, source: string, run: TestRun): void {
  const gates = [...new Set(run.results.filter((r) => r.kind === "gate").map((r) => r.owner))].filter((id) =>
    run.results.filter((r) => r.kind === "gate" && r.owner === id).every((r) => r.ok),
  );
  const file = join(dir, TEST_RESULTS_FILE);
  fs.mkdirSync(dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ source: hashOf(source), at: new Date().toISOString(), gates }, null, 2) + "\n");
}

/** The gates the last `--test --dir <root>` run passed, for this .at text; empty when there is no such run. */
export function testedGateIds(root: string, source: string): Set<string> {
  try {
    const rec = JSON.parse(fs.readFileSync(join(root, TEST_RESULTS_FILE), "utf8")) as { source?: string; gates?: string[] };
    return rec.source === hashOf(source) && Array.isArray(rec.gates) ? new Set(rec.gates) : new Set();
  } catch {
    return new Set();
  }
}

/** The report lines: one per row, grouped by gate or hook. */
export function renderTestRun(run: TestRun): string[] {
  const out: string[] = [];
  let last = "";
  for (const r of run.results) {
    const head = `${r.kind} ${r.owner}`;
    if (head !== last) {
      out.push(`  ${head}${r.via !== "-" ? ` (${r.via})` : ""}`);
      last = head;
    }
    out.push(`    ${r.ok ? "ok  " : "MISS"} ${r.got.padEnd(7)} ${r.text}${r.note ? `   [${r.note}]` : ""}`);
  }
  const n = run.results.length;
  out.push("", n === 0 ? "  no tests rows" : `  ${n} row(s), ${run.misses} miss(es)`);
  return out;
}
