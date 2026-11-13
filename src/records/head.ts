/**
 * Append-only records (Spec B, generated piece 3; SP-8):
 * `agentopology record check FILE.at [id] [--unit U] [--dir D]`.
 *
 * A record with `append-only: true` only grows. The check keeps a small head
 * file per record (and per unit, for a `{unit}` path) under
 * `.agentopology/records/`: the number of complete lines last seen and the
 * sha256 of those lines. On each check:
 *
 * - no head yet: write one (first run), exit 0;
 * - the file has fewer complete lines than the head: truncated, exit 1;
 * - its first N lines no longer hash the same: rewritten, exit 1;
 * - else: move the head forward to the current line count, exit 0.
 *
 * A failing check leaves the head where it was, so the finding repeats until
 * a person looks. The head files live in the repo, so git history is the
 * outside witness; the generated record guard (SP-7) refuses tool writes to
 * them (it imports {@link RECORD_HEADS_DIR}).
 *
 * Only complete lines (ending in "\n") count: a line a writer is still
 * appending is not hashed, so the next check cannot mistake its completion
 * for a rewrite.
 *
 * The tool never writes a record (B-Q1). It writes only these head files.
 *
 * @module
 */

import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import type { RecordDef, TopologyAST } from "../parser/ast.js";
import { ledgerPath, unsafeUnit } from "../parser/ledger.js";

/** Project-relative folder of the head files. SP-7's guard protects it. */
export const RECORD_HEADS_DIR = ".agentopology/records";

/** A head file's project-relative path: `<dir>/<id>.head`, or `<dir>/<id>/<unit>.head` for a unit. */
export function headPath(id: string, unit = ""): string {
  return unit === "" ? `${RECORD_HEADS_DIR}/${id}.head` : `${RECORD_HEADS_DIR}/${id}/${unit}.head`;
}

export interface Head {
  record: string;
  unit?: string;
  path: string;
  /** Complete lines covered. */
  lines: number;
  /** sha256 (hex) of the bytes of those lines, newlines included. */
  sha256: string;
}

export type HeadStatus = "first" | "grown" | "same" | "absent" | "rewritten" | "truncated" | "bad-head" | "bad-unit";

export interface HeadResult {
  record: string;
  unit?: string;
  /** The record file, project-relative. */
  path: string;
  status: HeadStatus;
  ok: boolean;
  /** One line saying what was found. */
  message: string;
}

/** The byte length of the first `n` complete lines, or -1 when there are fewer. */
function prefixLength(buf: Buffer, n: number): number {
  let end = 0;
  for (let i = 0; i < n; i++) {
    const nl = buf.indexOf(0x0a, end);
    if (nl === -1) return -1;
    end = nl + 1;
  }
  return end;
}

function completeLines(buf: Buffer): number {
  let count = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) count++;
  return count;
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function readHead(file: string): Head | null | "bad" {
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); } catch { return null; }
  try {
    const h = JSON.parse(text) as Head;
    if (typeof h.lines !== "number" || !Number.isInteger(h.lines) || h.lines < 0 || typeof h.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(h.sha256)) return "bad";
    return h;
  } catch { return "bad"; }
}

function writeHead(file: string, head: Head): void {
  fs.mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(head) + "\n");
  fs.renameSync(tmp, file);
}

/**
 * Check one record file (one unit) against its head and, when it only grew,
 * move the head forward. `root` is the project directory.
 */
export function checkRecordHead(record: RecordDef, unit: string, root: string): HeadResult {
  const rel = ledgerPath(record, unit);
  const base = { record: record.id, ...(unit ? { unit } : {}), path: rel };
  const who = `record ${record.id}${unit ? ` (unit ${unit})` : ""}`;
  if (unit !== "" && unsafeUnit(unit)) {
    return { ...base, status: "bad-unit", ok: false, message: `${who}: the unit "${unit}" is not a safe file name` };
  }
  const headFile = join(root, headPath(record.id, unit));
  const head = readHead(headFile);
  if (head === "bad") {
    return { ...base, status: "bad-head", ok: false, message: `${who}: its head file ${headPath(record.id, unit)} is not readable; it was changed by hand` };
  }
  let buf: Buffer | null;
  try { buf = fs.readFileSync(join(root, rel)); } catch { buf = null; }

  if (buf === null) {
    if (head && head.lines > 0) {
      return { ...base, status: "truncated", ok: false, message: `${who}: truncated: ${rel} is gone, and ${head.lines} line(s) were seen before` };
    }
    return { ...base, status: "absent", ok: true, message: `${who}: ${rel} does not exist yet` };
  }

  const lines = completeLines(buf);
  const now = (n: number): Head => ({ record: record.id, ...(unit ? { unit } : {}), path: rel, lines: n, sha256: sha(buf!.subarray(0, prefixLength(buf!, n))) });

  if (!head) {
    writeHead(headFile, now(lines));
    return { ...base, status: "first", ok: true, message: `${who}: first check, head set at ${lines} line(s)` };
  }
  const len = prefixLength(buf, head.lines);
  if (len === -1) {
    return { ...base, status: "truncated", ok: false, message: `${who}: truncated: ${rel} has ${lines} line(s), ${head.lines} were seen before` };
  }
  if (sha(buf.subarray(0, len)) !== head.sha256) {
    return { ...base, status: "rewritten", ok: false, message: `${who}: rewritten: the first ${head.lines} line(s) of ${rel} no longer hash the same` };
  }
  if (lines === head.lines) {
    return { ...base, status: "same", ok: true, message: `${who}: unchanged at ${lines} line(s)` };
  }
  writeHead(headFile, now(lines));
  return { ...base, status: "grown", ok: true, message: `${who}: grew from ${head.lines} to ${lines} line(s); head moved forward` };
}

/** The units a `{unit}` record has on disk or in its heads (so a deleted unit file is still found). */
function unitsOf(record: RecordDef, root: string): string[] {
  const found = new Set<string>();
  // Heads seen before.
  try {
    for (const f of fs.readdirSync(join(root, RECORD_HEADS_DIR, record.id))) {
      if (f.endsWith(".head")) found.add(f.slice(0, -".head".length));
    }
  } catch { /* none yet */ }
  // Files on disk: walk the path segment by segment; a segment holding {unit} matches one name.
  const segs = record.path.split("/");
  const walk = (i: number, at: string, unit: string | undefined): void => {
    if (i === segs.length) {
      if (unit !== undefined) found.add(unit);
      return;
    }
    const seg = segs[i];
    if (!seg.includes("{unit}")) {
      const next = join(at, seg);
      if (i === segs.length - 1 ? fs.existsSync(next) : isDir(next)) walk(i + 1, next, unit);
      return;
    }
    // "<pre>{unit}<post>": a second {unit} in the segment must repeat the first.
    const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const parts = seg.split("{unit}").map(esc);
    const re = new RegExp(`^${parts[0]}([^/]+?)${parts.slice(1).join("\\1")}$`);
    let names: string[];
    try { names = fs.readdirSync(at); } catch { return; }
    for (const name of names) {
      const cand = re.exec(name)?.[1];
      if (cand === undefined || unsafeUnit(cand)) continue;
      if (unit !== undefined && unit !== cand) continue;
      walk(i + 1, join(at, name), cand);
    }
  };
  walk(0, root, undefined);
  return [...found].filter((u) => !unsafeUnit(u)).sort();
}

function isDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

export interface RecordCheckOptions {
  /** Check only this record. */
  id?: string;
  /** Check only this unit (for `{unit}` records). */
  unit?: string;
  /** Project directory. Default ".". */
  dir?: string;
}

export interface RecordCheckReport {
  ok: boolean;
  results: HeadResult[];
  /** Set when the request itself is wrong (an unknown id); the check exits 1. */
  error?: string;
  /** Records skipped because they are not `append-only: true`. */
  skipped: string[];
}

/**
 * Check every append-only record (or the one named). A `{unit}` record with no
 * `--unit` is checked for every unit found on disk or in its heads.
 */
export function checkRecords(ast: TopologyAST, options: RecordCheckOptions = {}): RecordCheckReport {
  const root = resolve(options.dir ?? ".");
  const records = ast.records ?? [];
  if (options.id !== undefined && !records.some((r) => r.id === options.id)) {
    return { ok: false, results: [], skipped: [], error: `no record named "${options.id}" in this topology` };
  }
  const chosen = options.id !== undefined ? records.filter((r) => r.id === options.id) : records;
  const results: HeadResult[] = [];
  const skipped: string[] = [];
  for (const r of chosen) {
    if (r.appendOnly !== true) { skipped.push(r.id); continue; }
    if (!r.path.includes("{unit}")) {
      results.push(checkRecordHead(r, "", root));
    } else if (options.unit !== undefined) {
      results.push(checkRecordHead(r, options.unit, root));
    } else {
      for (const u of unitsOf(r, root)) results.push(checkRecordHead(r, u, root));
    }
  }
  return { ok: results.every((x) => x.ok), results, skipped };
}

/** The report as terminal lines. */
export function renderRecordCheck(report: RecordCheckReport): string[] {
  if (report.error) return [`record check: ${report.error}`];
  const lines = report.results.map((r) => `${r.ok ? "ok" : "FAILS"}  ${r.message}`);
  for (const id of report.skipped) lines.push(`skip  record ${id}: not append-only, nothing to check`);
  if (report.results.length === 0 && report.skipped.length === 0) lines.push("no records to check");
  const bad = report.results.filter((r) => !r.ok).length;
  if (bad > 0) lines.push(`${bad} record file(s) were changed after they were seen: an append-only record must only grow`);
  return lines;
}

/** Read `<file.at> [id] [--unit U] [--dir D]` (what follows `record check`). */
export function parseRecordArgs(args: string[]): { file?: string; id?: string; unit?: string; dir?: string } {
  const out: { file?: string; id?: string; unit?: string; dir?: string } = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--unit" && i + 1 < args.length) out.unit = args[++i];
    else if (args[i] === "--dir" && i + 1 < args.length) out.dir = args[++i];
    else positional.push(args[i]);
  }
  [out.file, out.id] = positional;
  return out;
}
