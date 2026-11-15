/**
 * Records in `guard --check` (Spec B, "The honest grade"; SP-9 records half).
 *
 * One block per declared record, one line per way in: no single grade, since
 * the ways differ. Each line is read from disk, the way the gate lines are:
 *
 * - tools: a file-writing tool. Generated guard: before-edit.sh wired on the
 *   file-writing tools of the conformance facts and holding the record's line.
 *   Cited guard: the cited PreToolUse hooks in .claude/settings.json; a tool no
 *   cited matcher covers is a warning naming it (B9).
 * - shell: a command that names the path. Graded detect at best.
 * - later: a rewrite found by `record check` (append-only only): detect, by code.
 * - other: what no generated guard closes, with the fixed bypass line.
 *
 * A generated piece that is missing, or a cited hook absent from settings.json,
 * grades none and counts as missing (guard --check exits 1). The tool never
 * prints "protected". Lines name no lane file: that is the compose half of
 * SP-9, after SP-4.
 *
 * @module
 */

import * as fs from "node:fs";
import { join } from "node:path";
import type { GateNode, HookDef, RecordDef, TopologyAST } from "../parser/ast.js";
import { gateLedger } from "../parser/ledger.js";
import { runParts } from "../parser/run.js";
import { shellQuote, ledgerPattern } from "../bindings/lib/guards.js";
import { FILE_WRITE_TOOLS, matcherMatches } from "../conformance/claude-code.js";
import { claudeEvent } from "../bindings/claude-code.js";
import { RECORD_BYPASS_LINE, isGuardedRecord, protectsHeads, recordWaysIn } from "./guard.js";
import { RECORD_HEADS_DIR } from "./head.js";

export interface RecordNote {
  text: string;
  /** A piece the project should have and lacks: counted in the report's missing. */
  missing?: boolean;
}

export interface RecordWayLine {
  way: "tools" | "shell" | "later" | "other";
  grade: string;
  where: string;
  notes: RecordNote[];
}

export interface RecordReport {
  id: string;
  path: string;
  writers: string[];
  lines: RecordWayLine[];
}

interface Handler { type?: string; command?: string; async?: boolean; onFailure?: string }
interface Entry { matcher?: string; hooks?: Handler[] }

/** Unverified until the conformance suite proves the hook on the installed version (Spec B). */
const UNVERIFIED = "unverified: the conformance suite has not proven this hook stops a file-writing tool on the installed Claude Code";
const OTHER_WAYS = "a path built at run time, an interpreter one-liner, a script an agent wrote, a process outside Claude Code";

function readText(path: string): string | null {
  try { return fs.readFileSync(path, "utf8"); } catch { return null; }
}

const entriesOf = (settings: Record<string, any> | null, event: string): Entry[] => (settings?.hooks?.[event] ?? []) as Entry[];

/** Entries on an event whose command hooks name `file`. */
function entriesRunning(settings: Record<string, any> | null, event: string, file: string): Entry[] {
  return entriesOf(settings, event).filter((e) => (e.hooks ?? []).some((h) => h.type === "command" && h.command?.includes(file)));
}

/** A cited hook's settings entries: PreToolUse (or its event), its matcher, a command naming its script. */
function citedOnDisk(settings: Record<string, any> | null, hook: HookDef): Entry[] {
  const script = runParts(hook.run).script.replace(/^\.\//, "");
  if (!script) return [];
  return entriesRunning(settings, claudeEvent(hook.on), script).filter((e) => !hook.matcher || e.matcher === hook.matcher);
}

const REFUSING_EVENTS = new Set(["PreToolUse", "PermissionRequest"]);

/**
 * The records block of `guard --check` for Claude Code. `settings` is the
 * parsed .claude/settings.json (null when absent); `scriptsDir` the skill's
 * scripts folder, project-relative.
 */
export function checkRecordGuards(ast: TopologyAST, root: string, settings: Record<string, any> | null, scriptsDir: string): RecordReport[] {
  const records = ast.records ?? [];
  if (records.length === 0) return [];
  const sq = shellQuote;
  const hooks = new Map<string, HookDef>((ast.hooks ?? []).map((h) => [h.name, h]));
  const beforeEdit = readText(join(root, scriptsDir, "before-edit.sh"));
  const beforeAction = readText(join(root, scriptsDir, "before-action.sh"));
  const editEntries = entriesRunning(settings, "PreToolUse", "before-edit.sh");
  const actionEntries = entriesRunning(settings, "PreToolUse", "before-action.sh").filter((e) => matcherMatches("PreToolUse", e.matcher, "Bash"));
  const ledgers = new Set(ast.nodes.filter((n) => n.type === "gate").map((g) => gateLedger(ast, g as GateNode)?.id).filter(Boolean));
  const headsGuarded = protectsHeads(ast) && beforeEdit?.includes("refuse_head") && beforeAction?.includes("record_guard 'head files'");

  /** The generated tool line: before-edit.sh wired on every file-writing tool, holding `needle`. */
  const generatedTools = (needle: string, label: string, holds: string): RecordWayLine => {
    const notes: RecordNote[] = [];
    if (editEntries.length === 0) notes.push({ text: "no PreToolUse entry for before-edit.sh in .claude/settings.json", missing: true });
    else {
      const open = FILE_WRITE_TOOLS.filter((t) => !editEntries.some((e) => matcherMatches("PreToolUse", e.matcher, t)));
      if (open.length) notes.push({ text: `before-edit.sh's matcher misses ${open.join(", ")}: rerun guard --target claude-code`, missing: true });
    }
    if (beforeEdit === null) notes.push({ text: `${scriptsDir}/before-edit.sh is missing`, missing: true });
    else if (!beforeEdit.includes(needle)) notes.push({ text: `before-edit.sh has no line for ${holds}; regenerate it`, missing: true });
    const where = `PreToolUse on ${editEntries[0]?.matcher ?? FILE_WRITE_TOOLS.join("|")} → before-edit.sh`;
    if (notes.some((n) => n.missing)) return { way: "tools", grade: "none", where, notes };
    if (!editEntries.some((e) => (e.hooks ?? []).some((h) => h.onFailure === "block"))) notes.push({ text: 'the entry has no onFailure: "block", so the write goes through if the hook cannot start' });
    return { way: "tools", grade: `refuse, by hook (${label})`, where, notes: [{ text: UNVERIFIED }, ...notes] };
  };
  /** The generated shell line: before-action.sh wired on Bash, holding `needle`. */
  const generatedShell = (needle: string, holds: string): RecordWayLine => {
    const notes: RecordNote[] = [];
    if (actionEntries.length === 0) notes.push({ text: "no PreToolUse entry on Bash for before-action.sh in .claude/settings.json", missing: true });
    if (beforeAction === null) notes.push({ text: `${scriptsDir}/before-action.sh is missing`, missing: true });
    else if (!beforeAction.includes(needle)) notes.push({ text: `before-action.sh has no line for ${holds}; regenerate it`, missing: true });
    const where = `PreToolUse on ${actionEntries[0]?.matcher ?? "Bash|Monitor|PowerShell"} → before-action.sh`;
    if (notes.length) return { way: "shell", grade: "none", where, notes };
    return { way: "shell", grade: "detect", where, notes: [{ text: "a pattern on the command text" }] };
  };

  const out: RecordReport[] = [];
  for (const r of records) {
    const path = r.path.replace(/^\.\//, "");
    const lines: RecordWayLine[] = [];
    const cited = r.guard ?? [];
    const isLedger = ledgers.has(r.id);
    if (isGuardedRecord(r)) {
      lines.push(generatedTools(`refuse_record ${sq(r.id)} `, "generated", `the record ${r.id}`));
      lines.push(generatedShell(`record_guard ${sq(r.id)} `, `the record ${r.id}`));
    } else if (cited.length > 0) {
      lines.push(...citedLines(r, cited, hooks, settings));
      if (isLedger) for (const l of lines) l.notes.push({ text: "also the generated gate-ledger guard (see the gate lines)" });
    } else if (isLedger) {
      const glob = sq(ledgerPattern(path).glob.toLowerCase());
      lines.push(generatedTools(`PAT=${glob};`, "gate ledger", `the ledger ${path}`));
      lines.push(generatedShell(`ledger_guard ${glob} `, `the ledger ${path}`));
    } else {
      lines.push({ way: "tools", grade: "none", where: "no guard", notes: [{ text: "the record names no writer: anyone may write this record" }] });
      lines.push({ way: "shell", grade: "none", where: "no guard", notes: [{ text: "the record names no writer: anyone may write this record" }] });
    }
    if (r.appendOnly === true) {
      const later = recordWaysIn({ appendOnly: true }).find((w) => w.grade === "detect, by code")!;
      const notes: RecordNote[] = [{ text: later.note }];
      if (!headsGuarded) notes.push({ text: `no generated guard protects the head files in ${RECORD_HEADS_DIR}/; a head removed makes the next check trust the file as it is` });
      lines.push({ way: "later", grade: later.grade, where: `agentopology record check, and step check before a gate reads it (heads in ${RECORD_HEADS_DIR}/)`, notes });
    }
    lines.push({ way: "other", grade: "none", where: OTHER_WAYS, notes: [{ text: `bypass: ${RECORD_BYPASS_LINE}` }] });
    out.push({ id: r.id, path, writers: r.writtenBy ?? [], lines });
  }
  return out;
}

/** The tools and shell lines of a record that cites hand-built guards (Spec B piece 5). */
function citedLines(r: RecordDef, cited: string[], hooks: Map<string, HookDef>, settings: Record<string, any> | null): RecordWayLine[] {
  const notes: RecordNote[] = [];
  const onDisk: Array<{ hook: HookDef; entries: Entry[] }> = [];
  for (const id of cited) {
    const h = hooks.get(id);
    if (!h) { notes.push({ text: `the cited guard ${id} is not a declared hook`, missing: true }); continue; }
    const entries = citedOnDisk(settings, h);
    if (entries.length === 0) { notes.push({ text: `the cited hook ${id} is not in .claude/settings.json`, missing: true }); continue; }
    onDisk.push({ hook: h, entries });
  }
  const blocking = onDisk.filter(({ hook, entries }) => REFUSING_EVENTS.has(claudeEvent(hook.on)) && !hook.async && !entries.some((e) => (e.hooks ?? []).some((x) => x.async)));
  const names = (xs: typeof blocking) => xs.map(({ hook }) => `${hook.on}${hook.matcher ? ` ${hook.matcher}` : ""} → ${hook.name}`).join(", ");

  const toolHooks = blocking.filter(({ hook }) => FILE_WRITE_TOOLS.some((t) => matcherMatches(hook.on, hook.matcher, t)));
  const open = FILE_WRITE_TOOLS.filter((t) => !toolHooks.some(({ hook }) => matcherMatches(hook.on, hook.matcher, t)));
  const toolNotes = [...notes];
  let tools: RecordWayLine;
  if (toolHooks.length === 0) {
    tools = { way: "tools", grade: "none", where: "no cited hook runs before a file-writing tool", notes: [...toolNotes, { text: `no cited PreToolUse hook matches ${FILE_WRITE_TOOLS.join(", ")}: a file-writing tool writes the record unrefused` }] };
  } else {
    if (open.length) toolNotes.push({ text: `the cited hooks' matchers miss ${open.join(", ")}: ${open.length === 1 ? "that tool writes" : "those tools write"} the record unrefused` });
    tools = { way: "tools", grade: "refuse, by hook (cited)", where: names(toolHooks), notes: [{ text: `cited, not proven; ${UNVERIFIED}` }, ...toolNotes] };
  }
  const shellHooks = blocking.filter(({ hook }) => matcherMatches(hook.on, hook.matcher, "Bash"));
  const shell: RecordWayLine = shellHooks.length
    ? { way: "shell", grade: "detect", where: names(shellHooks), notes: [{ text: "a pattern on the command text, cited, not proven" }] }
    : { way: "shell", grade: "none", where: "no cited hook runs before Bash", notes: [{ text: `no cited PreToolUse hook matches Bash: a shell command writes ${r.path} unseen` }] };
  return [tools, shell];
}

/** How many record lines lack a piece the project should have. */
export function recordsMissing(reports: RecordReport[]): number {
  return reports.reduce((n, r) => n + r.lines.filter((l) => l.notes.some((x) => x.missing)).length, 0);
}

/** The records block as terminal lines (empty when no record is declared). */
export function renderRecordReports(reports: RecordReport[]): string[] {
  if (reports.length === 0) return [];
  const width = Math.max(...reports.flatMap((r) => r.lines.map((l) => l.grade.length)));
  const lines = [`records: one line per way in, no single grade (${reports.length} declared)`];
  for (const r of reports) {
    lines.push(`  record ${r.id}  ${r.path}${r.writers.length ? ` · written by ${r.writers.join(", ")}` : " · no written-by"}`);
    for (const l of r.lines) {
      lines.push(`    ${l.way.padEnd(5)}  ${l.grade.padEnd(width)}  ${l.where}`);
      for (const n of l.notes) lines.push(`    ${"".padEnd(5)}  ${n.missing ? "✗" : "⚠"} ${n.text}`);
    }
  }
  return lines;
}
