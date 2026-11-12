/**
 * Facts about a topology that are not in the AST: validation results, guard
 * strengths, inventory coverage and the version stamp. They are computed by
 * structured functions (the CLI's text output renders the same results) and
 * embedded in the visualizer page keyed by item id, with the sha256 of the
 * source and the time they were read.
 *
 * With no project dir nothing is read from disk: every fact is "not checked".
 *
 * @module
 */

import { createHash } from "node:crypto";
import * as path from "node:path";
import type { TopologyAST } from "../parser/ast.js";
import { validate, type ValidationResult } from "../parser/validator.js";
import { checkGuards, guardFacts, type GuardFact } from "../guard/check.js";
import { versionStamp, type VersionStamp } from "../conformance/claude-code.js";
import { collectInventory, coverage, type CoverageReport, type InventoryItem } from "../inventory/index.js";

export const NOT_CHECKED = "not checked" as const;
export type NotChecked = typeof NOT_CHECKED;

/** What `validate` found, as data. */
export interface ValidateResult {
  results: ValidationResult[];
  errors: number;
  warnings: number;
}

export function validateResult(ast: TopologyAST, filePath?: string): ValidateResult {
  const results = validate(ast, filePath ? { filePath } : {});
  return {
    results,
    errors: results.filter((r) => r.level === "error").length,
    warnings: results.filter((r) => r.level === "warning").length,
  };
}

/** What `validate --inventory` found, as data (the report plus the items read). */
export function coverageResult(ast: TopologyAST, items: InventoryItem[], root: string): CoverageReport {
  return coverage(ast, items, root);
}

export interface ItemFacts {
  validate: ValidationResult[] | NotChecked;
  guard: GuardFact | NotChecked | undefined;
}

export interface InventoryFacts {
  total: number;
  mapped: number;
  unmapped: string[];
  missing: Array<{ path: string; from: string }>;
  notScaffolded: string[];
}

export interface Facts {
  checked: boolean;
  /** sha256 of the .at source these facts were read against. */
  sha256: string;
  /** ISO time they were read. */
  at: string;
  version: VersionStamp;
  validate: ValidateResult | NotChecked;
  guard: Record<string, GuardFact> | NotChecked;
  inventory: InventoryFacts | NotChecked;
  /** Per node id. */
  items: Record<string, ItemFacts>;
}

export interface CollectOptions {
  source: string;
  /** Absolute path of the .at file (lets validate resolve imports). */
  filePath?: string;
  /** Project dir to read from disk. Without it nothing is checked. */
  dir?: string;
  now?: Date;
}

export function collectFacts(ast: TopologyAST, opts: CollectOptions): Facts {
  const sha256 = createHash("sha256").update(opts.source).digest("hex");
  const at = (opts.now ?? new Date()).toISOString();
  const version = versionStamp();
  if (!opts.dir) {
    const items: Record<string, ItemFacts> = {};
    for (const n of ast.nodes) items[n.id] = { validate: NOT_CHECKED, guard: NOT_CHECKED };
    return { checked: false, sha256, at, version, validate: NOT_CHECKED, guard: NOT_CHECKED, inventory: NOT_CHECKED, items };
  }
  const root = path.resolve(opts.dir);
  const v = validateResult(ast, opts.filePath);
  const guard = guardFacts(checkGuards(ast, root));
  const cov = coverageResult(ast, collectInventory(root), root);
  const items: Record<string, ItemFacts> = {};
  for (const n of ast.nodes) {
    items[n.id] = { validate: v.results.filter((r) => r.node === n.id), guard: guard[n.id] };
  }
  return {
    checked: true, sha256, at, version, validate: v, guard, items,
    inventory: {
      total: cov.total,
      mapped: cov.mapped,
      unmapped: cov.unmapped.map((i) => i.id),
      missing: cov.missing.map((m) => ({ path: m.path, from: m.from })),
      notScaffolded: cov.notScaffolded,
    },
  };
}
