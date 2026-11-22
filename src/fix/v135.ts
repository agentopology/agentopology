/**
 * `agentopology fix`: the way out of V135 errors after an upgrade.
 *
 * V135 errors on a gate meant to refuse that no generated hook runs. Nothing
 * enforces such a gate today, so the honest grade is `strength: hope` (the
 * playbook runs it). This module lists each V135 error with V135's own
 * analysis (the validator's result and {@link hooklessGateReason}), the edit
 * that writes that grade, and, as a suggestion only, an anchor already in the
 * flow that would make the gate refuse. It never invents an anchor and never
 * rewires the flow.
 *
 * The edit is minimal and in place: a `strength: hope` line inserted right
 * after the gate's `run:` line (same indent, same line ending), or the word
 * `refuse` replaced in a written `strength: refuse`. Every other byte of the
 * file is kept, comments and spacing included. A gate whose `run:` line also
 * holds a brace of the gate block (a gate on one line) is left for a hand
 * edit.
 *
 * @module
 */

import { parse } from "../parser/index.js";
import type { GateNode, TopologyAST } from "../parser/ast.js";
import { gateAnchors } from "../parser/ast.js";
import { validate, V135_TARGETS } from "../parser/validator.js";
import type { ValidationResult } from "../parser/validator.js";
import { braceText, closingBrace, escapeRegex, maskProse } from "../parser/lexer.js";
import { CLAUDE_CODE_GUARDS, CODEX_GUARDS, gateWiring, hooklessGateReason, type GuardPlatform } from "../bindings/lib/guards.js";

/** One text edit: at `offset`, `remove` characters are replaced by `text`. */
export interface GateEdit {
  kind: "insert" | "replace";
  offset: number;
  remove: number;
  text: string;
  /** The 1-based line of the file as read: the replaced line, or the `run:` line an insert follows. */
  line: number;
}

/** A V135 error and what fix makes of it. */
export interface V135Fix {
  gate: string;
  /** The gate's line, as V135 reports it. */
  line?: number;
  /** Why no hook runs it: {@link hooklessGateReason}, the text V135 uses. */
  reason: string;
  /** V135's message for the gate. */
  message: string;
  /** The `strength: hope` edit, or undefined when it needs a hand edit. */
  edit?: GateEdit;
  /** Why the gate cannot be edited in place. */
  manual?: string;
  /** Anchors in the flow that would make the gate refuse, in words. Never applied. */
  suggestions: string[];
  /** The same anchors as gate fields, one per suggestion. */
  anchors: Array<Pick<GateNode, "after" | "before">>;
}

export interface V135FixPlan {
  /** False when V135 does not apply to the target (cursor, claude-workflow). */
  applies: boolean;
  target?: string;
  fixes: V135Fix[];
  /** V135 errors relayed from an imported file (V8): fixed in that file. */
  relayed: ValidationResult[];
}

export interface V135FixOptions {
  target?: string;
  /** The file the source was read from, so imports resolve. */
  filePath?: string;
}

/** The V135 errors of `source`, each with its edit and suggestions. */
export function planV135Fixes(source: string, opts: V135FixOptions = {}): V135FixPlan {
  const { target } = opts;
  if (target && !V135_TARGETS.includes(target)) return { applies: false, target, fixes: [], relayed: [] };
  const ast = parse(source);
  const results = validate(ast, { ...(target ? { target } : {}), ...(opts.filePath ? { filePath: opts.filePath } : {}) });
  const p = target === "codex" ? CODEX_GUARDS : CLAUDE_CODE_GUARDS;
  const fixes: V135Fix[] = [];
  for (const r of results) {
    if (r.rule !== "V135" || r.level !== "error" || !r.node) continue;
    const gate = ast.nodes.find((n) => n.type === "gate" && n.id === r.node) as GateNode | undefined;
    if (!gate) continue;
    const located = strengthEdit(source, gate.id);
    const anchors = anchorSuggestions(ast, gate, p);
    fixes.push({
      gate: gate.id,
      ...(r.line !== undefined ? { line: r.line } : {}),
      reason: hooklessGateReason(ast, gate, p) ?? "",
      message: r.message,
      ...("edit" in located ? { edit: located.edit } : { manual: located.manual }),
      suggestions: anchors.map((a) => a.words),
      anchors: anchors.map((a) => a.fields),
    });
  }
  const relayed = results.filter((r) => r.rule === "V8" && r.via === "V135" && r.level === "error");
  return { applies: true, ...(target ? { target } : {}), fixes, relayed };
}

/** `source` with the plan's edits applied; a gate with no edit is left as written. */
export function applyV135Fixes(source: string, plan: V135FixPlan): string {
  const edits = plan.fixes.flatMap((f) => (f.edit ? [f.edit] : [])).sort((a, b) => b.offset - a.offset);
  let out = source;
  for (const e of edits) out = out.slice(0, e.offset) + e.text + out.slice(e.offset + e.remove);
  return out;
}

// ---------------------------------------------------------------------------
// Where the edit goes
// ---------------------------------------------------------------------------

const lineOf = (src: string, offset: number) => src.slice(0, offset).split("\n").length;

/**
 * The body range `[start, end)` of `gate <id> { }` inside the first
 * `gates { }` block, as the parser reads it, or null when the source does not
 * hold exactly one such block (the gate came from an include, or the id is
 * written twice).
 */
function gateBody(source: string, id: string): { start: number; end: number } | null {
  const mask = maskProse(source);
  const braces = braceText(source);
  const gates = /(?:^|\n)\s*gates(?:\s+[a-zA-Z][a-zA-Z0-9_-]*)?[^{\n]*\{/.exec(mask);
  if (!gates) return null;
  const gStart = gates.index + gates[0].length;
  const gEnd = closingBrace(braces, gStart);
  if (gEnd < 0) return null;
  const re = new RegExp(`(?:^|\\n)\\s*gate\\s+${escapeRegex(id)}(?![a-zA-Z0-9_-])[^{\\n]*\\{`, "g");
  const inGates = mask.slice(gStart, gEnd);
  const found: Array<{ start: number; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(inGates)) !== null) {
    const start = gStart + m.index + m[0].length;
    const end = closingBrace(braces, start);
    if (end >= 0) found.push({ start, end });
  }
  return found.length === 1 ? found[0] : null;
}

/** The lines of a gate body at its own depth (not inside a nested block), with their offsets. */
function topLevelLines(source: string, body: { start: number; end: number }): Array<{ start: number; end: number; masked: string }> {
  const mask = maskProse(source);
  const braces = braceText(source);
  const lines: Array<{ start: number; end: number; masked: string }> = [];
  let depth = 0;
  let ls = body.start;
  while (ls < body.end) {
    const nl = source.indexOf("\n", ls);
    const le = nl < 0 || nl > body.end ? body.end : nl;
    if (depth === 0) lines.push({ start: ls, end: le, masked: mask.slice(ls, le) });
    for (let i = ls; i < le; i++) {
      if (braces[i] === "{") depth++;
      else if (braces[i] === "}") depth--;
    }
    ls = le + 1;
  }
  return lines;
}

/** The edit that writes `strength: hope` on gate `id`, or why it needs a hand edit. */
function strengthEdit(source: string, id: string): { edit: GateEdit } | { manual: string } {
  const body = gateBody(source, id);
  if (!body) return { manual: `gate "${id}" is not written once in this file's gates block; add strength: hope to it by hand` };
  const lines = topLevelLines(source, body);
  // The parser keeps the last value written for a field.
  const strength = lines.filter((l) => /^\s*strength\s*:/.test(l.masked)).pop();
  if (strength) {
    const m = /^(\s*strength\s*:\s*)refuse(?![a-zA-Z0-9_-])/.exec(strength.masked);
    if (!m) return { manual: `gate "${id}" has a strength: line fix cannot read; write strength: hope there by hand` };
    const offset = strength.start + m[1].length;
    return { edit: { kind: "replace", offset, remove: "refuse".length, text: "hope", line: lineOf(source, offset) } };
  }
  const run = lines.filter((l) => /^\s*run\s*:/.test(l.masked)).pop();
  // The run: line must be a line of its own: not the gate's header line, and
  // not holding the closing brace.
  const headerLine = source.lastIndexOf("\n", body.start - 1) + 1;
  if (!run || run.start <= headerLine || run.end >= body.end) {
    return { manual: `gate "${id}" is written on one line; add strength: hope to it by hand` };
  }
  const indent = /^\s*/.exec(source.slice(run.start, run.end))![0];
  const eol = source[run.end - 1] === "\r" ? "\r\n" : "\n";
  const offset = run.end + 1;
  return { edit: { kind: "insert", offset, remove: 0, text: `${indent}strength: hope${eol}`, line: lineOf(source, run.start) } };
}

// ---------------------------------------------------------------------------
// Anchors that would make the gate refuse (suggestions only)
// ---------------------------------------------------------------------------

/**
 * Anchors next to the gate in the flow that would give it a hook: a node
 * right before one of its `before:` targets (as `after:`), or right after one
 * of its `after:` targets (added to `before:`). Each is kept only when
 * {@link hooklessGateReason} finds a hook for the gate with it, so a
 * suggestion is never an anchor the topology lacks or one that would not
 * refuse.
 */
function anchorSuggestions(ast: TopologyAST, gate: GateNode, p: GuardPlatform): Array<{ words: string; fields: Pick<GateNode, "after" | "before"> }> {
  const out: Array<{ words: string; fields: Pick<GateNode, "after" | "before"> }> = [];
  const seen = new Set<string>();
  const afters = gateAnchors(gate, "after");
  const befores = gateAnchors(gate, "before");
  const how = (candidate: GateNode): string => {
    const wiring = gateWiring(ast, candidate, p);
    if (wiring.kind === "subagent-stop") return "SubagentStop runs the gate when it finishes";
    if (wiring.kind === "before-agent") return "before-agent.sh runs the gate before it is launched";
    return "before-action.sh runs the gate before its command";
  };
  const consider = (fields: Pick<GateNode, "after" | "before">, words: (why: string) => string) => {
    const key = JSON.stringify(fields);
    if (seen.has(key)) return;
    seen.add(key);
    const candidate: GateNode = { ...gate, ...fields };
    if (hooklessGateReason(ast, candidate, p) !== null) return;
    out.push({ words: words(how(candidate)), fields });
  };
  const isScriptStep = (id: string) => ast.nodes.some((n) => n.type === "action" && n.id === id && ((n as { commands?: string[] }).commands?.length ?? 0) > 0);
  for (const b of befores) {
    for (const e of ast.edges) {
      if (e.to !== b || e.from === b) continue;
      consider({ after: [e.from] }, (why) => `after: ${e.from} ("${e.from}" runs right before "${b}" in the flow; ${why})`);
    }
  }
  for (const a of afters) {
    for (const e of ast.edges) {
      if (e.from !== a || e.to === a || befores.includes(e.to)) continue;
      const what = isScriptStep(e.to) ? "a script step" : "a subagent";
      const list = befores.length ? `[${[...befores, e.to].join(", ")}]` : e.to;
      consider({ before: [...befores, e.to] }, (why) => `before: ${list} (${what} right after "${a}" in the flow; ${why})`);
    }
  }
  return out;
}
