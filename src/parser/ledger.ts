/**
 * Ledgers: the JSON Lines files a step's own script appends to, and the gates
 * that read them.
 *
 * A gate before an action (a script step) is checked against a record of what
 * the step before it did: one object per line,
 * `{"step": "<node id>", "unit": "<unit, omitted when none>", "ok": true|false, "at": "<ISO time>"}`.
 * agentopology only reads it. The claude-code binding compiles the check into
 * before-action.sh (a hook, so it covers Claude Code sessions); `step check`
 * runs the same check from a terminal or a scheduler.
 *
 * @module
 */

import type { ActionNode, GateNode, RecordDef, TopologyAST } from "./ast.js";
import { gateAnchors } from "./ast.js";

/** The actions a gate stands before that a command can name (they have `commands:`). */
export function guardedActions(ast: TopologyAST, gate: GateNode): ActionNode[] {
  return gateAnchors(gate, "before")
    .map((id) => ast.nodes.find((n) => n.id === id))
    .filter((n): n is ActionNode => n?.type === "action" && (n as ActionNode).commands?.length !== 0 && !!(n as ActionNode).commands);
}

/**
 * The record a gate reads: the one it names, else the topology's only record.
 * Undefined when it names none and there is not exactly one record, when the
 * name is not declared (V112 reports both), or when the gate has no `after:`
 * step to look up.
 */
export function gateLedger(ast: TopologyAST, gate: GateNode): RecordDef | undefined {
  // A ledger answers "did the after: step finish ok?"; with no after: there is no step to look up.
  if (gateAnchors(gate, "after").length === 0) return undefined;
  const records = ast.records ?? [];
  if (gate.ledger) return records.find((r) => r.id === gate.ledger);
  return records.length === 1 ? records[0] : undefined;
}

/** A unit goes into a file path, so it is one safe path segment: no `/`, no `..`. */
const SAFE_UNIT = /^[A-Za-z0-9_.@+-]+$/;

export function unsafeUnit(unit: string): boolean {
  return !SAFE_UNIT.test(unit) || unit === "." || unit.includes("..");
}

/** The ledger's project-relative path for a unit (`{unit}` replaced; empty when none). */
export function ledgerPath(record: RecordDef, unit: string): string {
  return record.path.replace(/\{unit\}/g, unit);
}

/**
 * Whether a ledger's text shows a step finished ok: the LAST line for the step
 * (and the unit, when one is given) must have `ok: true`. A line that is not
 * JSON is an error, not a skip: a damaged ledger must not open a gate.
 */
export function stepIsOk(text: string, step: string, unit: string): { ok: boolean; why: string } {
  let last: { ok?: unknown } | undefined;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    let rec: { step?: unknown; unit?: unknown; ok?: unknown };
    try { rec = JSON.parse(lines[i]); } catch { return { ok: false, why: `line ${i + 1} of the ledger is not JSON` }; }
    if (rec === null || typeof rec !== "object") return { ok: false, why: `line ${i + 1} of the ledger is not an object` };
    if (rec.step === step && (unit === "" || rec.unit === unit)) last = rec;
  }
  if (!last) return { ok: false, why: `the ledger has no record for step "${step}"${unit ? ` and unit "${unit}"` : ""}` };
  return last.ok === true ? { ok: true, why: "" } : { ok: false, why: `the last record for step "${step}"${unit ? ` and unit "${unit}"` : ""} is not ok` };
}
