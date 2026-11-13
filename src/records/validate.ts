/**
 * The record rules (Spec B, "Validation rules"; SP-6).
 *
 * A record is a file only named programs write. These rules check what the
 * declaration says about its writers and its cited guards; the path rules stay
 * in V112. `append-only: true` on a record no gate reads is not a finding.
 *
 * @module
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { HookDef, RecordDef, TopologyAST } from "../parser/ast.js";
import type { ValidationResult } from "../parser/validator.js";
import { unsafePathReason } from "../parser/paths.js";
import { FILE_WRITE_TOOLS, matcherMatches } from "../conformance/claude-code.js";

/** What the record rules need from `validate`'s options. */
export interface RecordRuleOptions {
  /** Path of the file `ast` was parsed from; `written-by` programs are looked for beside it. */
  filePath?: string;
}

const recordsOf = (ast: TopologyAST): RecordDef[] => ast.records ?? [];

/**
 * V130: every `written-by` program is on disk.
 *
 * An entry that names a node of the topology (an agent, an action) is a
 * writer, not a file, and is not looked for. Any other entry is a
 * project-relative path, looked for beside the .at file. Without a file path
 * (a topology validated from a string) the disk is not read.
 */
export function v130RecordWriters(ast: TopologyAST, opts: RecordRuleOptions = {}): ValidationResult[] {
  const results: ValidationResult[] = [];
  const nodes = new Set(ast.nodes.map((n) => n.id));
  const file = opts.filePath ?? ast.sourcePath;
  const root = file ? path.dirname(path.resolve(file)) : null;
  for (const r of recordsOf(ast)) {
    for (const w of r.writtenBy ?? []) {
      if (nodes.has(w)) continue;
      const rel = w.replace(/^\.\//, "");
      const why = unsafePathReason(rel);
      if (why) {
        results.push({ rule: "V130", level: "error", node: r.id, message: `Record "${r.id}" has written-by: "${w}", which is not a project-relative path (${why}). Name a program in the project, or a node of this topology` });
        continue;
      }
      if (root && !fs.existsSync(path.join(root, rel))) {
        results.push({ rule: "V130", level: "error", node: r.id, message: `Record "${r.id}" has written-by: "${w}", which is missing: no such file in ${root}. The record names a writer that does not exist` });
      }
    }
  }
  return results;
}

/** V131: a record that names no writer (B-Q2). */
export function v131RecordNoWriter(ast: TopologyAST): ValidationResult[] {
  return recordsOf(ast)
    .filter((r) => (r.writtenBy ?? []).length === 0)
    .map((r) => ({
      rule: "V131",
      level: "warning" as const,
      node: r.id,
      message: `Record "${r.id}" has no written-by: anyone may write this record. Name the programs allowed to write it, e.g. written-by: ["scripts/approve.py"]`,
    }));
}

/** V132: one id declared as a store and as a record (B-Q3: two words, two things). */
export function v132RecordStoreSameId(ast: TopologyAST): ValidationResult[] {
  const stores = new Set((ast.stores ?? []).map((s) => s.id));
  return recordsOf(ast)
    .filter((r) => stores.has(r.id))
    .map((r) => ({
      rule: "V132",
      level: "warning" as const,
      node: r.id,
      message: `"${r.id}" is declared as a store agents write and as a record only programs write. Rename one of them`,
    }));
}

/** Events on which a hook can refuse a tool call before it runs. */
const REFUSING_TOOL_EVENTS = new Set(["PreToolUse", "PermissionRequest"]);

/**
 * V133: a record's cited `guard:` hooks.
 *
 * Each id names a declared hook (error otherwise). Together, the cited hooks
 * that fire before a tool call must match every file-writing tool in the
 * conformance facts; a tool none of them matches is a way in, named in a
 * warning. A cited hook on Bash only covers the shell path, so the union is
 * what counts, not each hook alone.
 */
export function v133RecordGuards(ast: TopologyAST): ValidationResult[] {
  const results: ValidationResult[] = [];
  const hooks = new Map<string, HookDef>((ast.hooks ?? []).map((h) => [h.name, h]));
  for (const r of recordsOf(ast)) {
    const cited = r.guard ?? [];
    if (cited.length === 0) continue;
    const found: HookDef[] = [];
    for (const id of cited) {
      const h = hooks.get(id);
      if (h) found.push(h);
      else {
        results.push({ rule: "V133", level: "error", node: r.id, message: `Record "${r.id}" has guard: ${id}, but no hook is named "${id}". A record's guard names a hook in hooks { }` });
      }
    }
    if (found.length < cited.length) continue;
    const before = found.filter((h) => REFUSING_TOOL_EVENTS.has(h.on));
    const open = FILE_WRITE_TOOLS.filter((t) => !before.some((h) => matcherMatches(h.on, h.matcher, t)));
    if (open.length === 0) continue;
    results.push({
      rule: "V133",
      level: "warning",
      node: r.id,
      message: `Record "${r.id}" cites guard: [${cited.join(", ")}], but no cited PreToolUse hook matches ${open.join(", ")}, so ${open.length === 1 ? "that tool writes" : "those tools write"} the record unrefused. File-writing tools: ${FILE_WRITE_TOOLS.join(", ")}`,
    });
  }
  return results;
}
