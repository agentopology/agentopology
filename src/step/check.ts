/**
 * `agentopology step check <file.at> <step-id> [--unit U] [--dir D]`: a step
 * asks whether the gates before it hold.
 *
 * A hook guards a Claude Code session only (before-action.sh); a script run
 * from a terminal or a scheduler never meets it. So the step checks itself at
 * its start (`by: code`) and stops on exit 1. The check is the one the hook
 * makes, run directly:
 *
 * - a gate with a ledger holds when the LAST record for its `after:` step (and
 *   the same unit, when one is given) has `ok: true`;
 * - a gate with `run:` holds when that command exits 0 from the project dir;
 * - a gate with both needs both; a gate with neither is unsatisfiable
 *   ("nothing to check", the case V110 warns about).
 *
 * It reads ledgers and runs check scripts. It never writes.
 *
 * @module
 */

import * as fs from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { GateNode, TopologyAST } from "../parser/ast.js";
import { gateAnchors } from "../parser/ast.js";
import { gateLedger, ledgerPath, stepIsOk, unsafeUnit } from "../parser/ledger.js";
import { scriptNameFromRun } from "../parser/run.js";
import { parseWindow, today as todayDate } from "../parser/window.js";
import { hookCommand } from "../bindings/claude-code.js";

export interface StepCheckOptions {
  /** The unit (an episode id, a ticket); filters ledger records. */
  unit?: string;
  /** Project directory ledgers and check scripts are read from. Default ".". */
  dir?: string;
  /** Today as YYYY-MM-DD; default the real date (or AT_TODAY). */
  today?: string;
}

export interface GateResult {
  gate: string;
  ok: boolean;
  /** Why the gate fails; empty when it holds. */
  reasons: string[];
}

export interface StepReport {
  step: string;
  unit?: string;
  /** False when the topology has no node by that name (a typo must not pass). */
  known: boolean;
  gates: GateResult[];
  ok: boolean;
}

/** Longest a gate's `run:` may take. */
const RUN_TIMEOUT_MS = 5 * 60_000;

function checkGate(ast: TopologyAST, gate: GateNode, unit: string, root: string): GateResult {
  const reasons: string[] = [];
  const ledger = gateLedger(ast, gate);
  const runnable = !!scriptNameFromRun(gate.run);

  if (ledger) {
    const needsUnit = ledger.path.includes("{unit}");
    if (needsUnit && unit === "") {
      reasons.push(`ledger ${ledger.path} needs a unit: pass --unit`);
    } else if (unit !== "" && unsafeUnit(unit)) {
      reasons.push(`the unit "${unit}" is not a safe file name`);
    } else {
      const rel = ledgerPath(ledger, unit);
      const text = (() => { try { return fs.readFileSync(join(root, rel), "utf8"); } catch { return null; } })();
      for (const step of gateAnchors(gate, "after")) {
        if (text === null) {
          reasons.push(`step "${step}"${unit ? ` for unit "${unit}"` : ""} has no ok record: the ledger ${rel} does not exist`);
          continue;
        }
        const r = stepIsOk(text, step, unit);
        if (!r.ok) reasons.push(`${r.why} (ledger ${rel})`);
      }
    }
  }

  if (gate.run && runnable) {
    const r = spawnSync("/bin/sh", ["-c", hookCommand(gate.run, ast.topology.name)], {
      cwd: root,
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
      encoding: "utf8",
      timeout: RUN_TIMEOUT_MS,
    });
    if (r.status !== 0) {
      const out = `${r.stderr ?? ""}${r.stdout ?? ""}`.trim().split("\n").slice(-5).join(" | ");
      reasons.push(`its check ${gate.run} ${r.status === null ? "did not finish" : `exited ${r.status}`}${out ? `: ${out}` : ""}`);
    }
  }

  if (!ledger && !(gate.run && runnable)) {
    reasons.push("nothing to check: it has no ledger and no run: (V110)");
  }
  return { gate: gate.id, ok: reasons.length === 0, reasons };
}

/**
 * Humans that guard `step` (a flow edge from the human to it, or a gate before
 * it that comes after the human) and whose `valid:` window has ended. Their
 * approval is out of date, so the step is refused.
 */
function expiredHumans(ast: TopologyAST, step: string, now: string): GateResult[] {
  const guards = new Set<string>();
  for (const e of ast.edges) if (e.to === step) guards.add(e.from);
  for (const g of ast.nodes) {
    if (g.type !== "gate" || !gateAnchors(g as GateNode, "before").includes(step)) continue;
    for (const a of gateAnchors(g as GateNode, "after")) guards.add(a);
  }
  const out: GateResult[] = [];
  for (const n of ast.nodes) {
    if (n.type !== "human" || !n.valid || !guards.has(n.id)) continue;
    const w = parseWindow(n.valid);
    if (w && now > w.end) out.push({ gate: n.id, ok: false, reasons: [`human ${n.id}'s approval is valid ${n.valid}, and today (${now}) is after it`] });
  }
  return out;
}

/**
 * Check every gate whose `before:` names `step`. An advisory gate reports and
 * never blocks, so it is left out. A step id that is no node of the topology
 * fails, so a typo cannot read as "nothing guards it".
 */
export function checkStep(ast: TopologyAST, step: string, options: StepCheckOptions = {}): StepReport {
  const unit = options.unit ?? "";
  const root = resolve(options.dir ?? ".");
  const known = ast.nodes.some((n) => n.id === step);
  const gates = ast.nodes
    .filter((n): n is GateNode => n.type === "gate")
    .filter((g) => g.behavior !== "advisory" && gateAnchors(g, "before").includes(step))
    .map((g) => checkGate(ast, g, unit, root));
  gates.push(...expiredHumans(ast, step, options.today ?? todayDate()));
  return { step, ...(unit ? { unit } : {}), known, gates, ok: known && gates.every((g) => g.ok) };
}

/** The report as terminal lines. */
export function renderStepReport(report: StepReport): string[] {
  if (!report.known) return [`step check: no node named "${report.step}" in this topology`];
  if (report.gates.length === 0) return [`no gate guards ${report.step}`];
  const lines: string[] = [];
  for (const g of report.gates) {
    lines.push(g.ok ? `gate ${g.gate}: ok` : `gate ${g.gate}: FAILS`);
    for (const r of g.reasons) lines.push(`  ${r}`);
  }
  const failed = report.gates.filter((g) => !g.ok).length;
  lines.push(failed === 0
    ? `${report.step}: every gate before it holds`
    : `${report.step}: ${failed} of ${report.gates.length} gate(s) fail, so it must not run`);
  return lines;
}

/** Read `<file.at> <step-id> [--unit U] [--dir D]` (what follows `step check`). */
export function parseStepArgs(args: string[]): { file?: string; step?: string; unit?: string; dir?: string } {
  const out: { file?: string; step?: string; unit?: string; dir?: string } = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--unit" && i + 1 < args.length) out.unit = args[++i];
    else if (args[i] === "--dir" && i + 1 < args.length) out.dir = args[++i];
    else positional.push(args[i]);
  }
  [out.file, out.step] = positional;
  return out;
}
