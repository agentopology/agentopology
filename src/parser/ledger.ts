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

import type { ActionNode, GateNode, HumanNode, RecordDef, TopologyAST } from "./ast.js";
import { gateAnchors } from "./ast.js";

/** A human's stop words as written: the list, or the one string; empty when it has none. */
export function stopWordsOf(h: HumanNode): string[] {
  return h.stopWords ?? (h.stopWord !== undefined ? [h.stopWord] : []);
}

/** The ASCII letters of `s` folded to lower case; every other character stays as it is. */
export function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** The characters the stop-word reader cuts the first word at: a stop word holding one could never match. */
export const STOP_CUT_CHARS = ",;:!?.\"*/()`<>…–—";
/** The characters trimmed from both ends of a word, besides whitespace. */
export const TRIM_CHARS = ".,;:!?'\"*/()-_`…–—";

/** True when `w` holds a character outside ASCII (such a word is matched exactly, with no case folding). */
export const isNonAscii = (w: string): boolean => /[^\x00-\x7f]/.test(w);

/** `w` with whitespace and the TRIM_CHARS taken off both ends, and inner whitespace one space. */
export function trimWord(w: string): string {
  const trim = new Set([...TRIM_CHARS]);
  let chars = [...w.trim()];
  while (chars.length > 0 && (trim.has(chars[0]) || /\s/.test(chars[0]))) chars.shift();
  while (chars.length > 0 && (trim.has(chars[chars.length - 1]) || /\s/.test(chars[chars.length - 1]))) chars.pop();
  return chars.join("").split(/\s+/).filter(Boolean).join(" ");
}

/** A go or stop word as the go hook compares it: ends trimmed, inner whitespace one space, ASCII lower case (when `fold`). */
export function normalWord(w: string, fold = true): string {
  const t = trimWord(w);
  return fold ? asciiLower(t) : t;
}

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

/**
 * The ledgers a human's go row goes to: those of the gates whose `after:` names the
 * human, once each, in declaration order. Empty when no gate after it reads a record.
 */
export function goLedgers(ast: TopologyAST, humanId: string): RecordDef[] {
  const out: RecordDef[] = [];
  for (const n of ast.nodes) {
    if (n.type !== "gate" || !gateAnchors(n as GateNode, "after").includes(humanId)) continue;
    const rec = gateLedger(ast, n as GateNode);
    if (rec && !out.includes(rec)) out.push(rec);
  }
  return out;
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
