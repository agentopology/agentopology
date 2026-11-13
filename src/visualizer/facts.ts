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
import { sourceIndex } from "./source-index.js";
import * as path from "node:path";
import type { TopologyAST } from "../parser/ast.js";
import { validate, type ValidationResult } from "../parser/validator.js";
import { checkGuards, guardFacts, type GuardFact } from "../guard/check.js";
import { versionStamp, type VersionStamp } from "../conformance/claude-code.js";
import { collectInventory, coverage, type CollectOptions as InventoryCollectOptions, type CoverageReport, type InventoryItem, type OutsideCheck } from "../inventory/index.js";

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
export function coverageResult(ast: TopologyAST, items: InventoryItem[], root: string, user = false, home?: string): CoverageReport {
  return coverage(ast, items, root, home === undefined ? { user } : { user, home });
}

export interface ItemFacts {
  validate: ValidationResult[] | NotChecked;
  guard: GuardFact | NotChecked | undefined;
}

/** The items of one inventory kind: mapped and unmapped ids, and the missing pointers filed under it. */
export interface InventoryKindFacts {
  kind: string;
  mapped: string[];
  unmapped: string[];
  /** "<path>  <- <what points at it>". A missing pointer is filed under the kind of the thing that points at it. */
  missing: string[];
}

export interface InventoryFacts {
  total: number;
  mapped: number;
  unmapped: string[];
  missing: Array<{ path: string; from: string }>;
  notScaffolded: string[];
  /** The same numbers by kind (a click on the page lists the items). */
  kinds: InventoryKindFacts[];
  /** Tagged e: listed, never required. */
  external: string[];
  /** Per `inventory { roots }` entry: files under it and how many the .at maps. */
  roots: Array<{ root: string; total: number; mapped: number }>;
  /** `--user`: the user-level tree, counted apart from the project. */
  user?: { total: number; mapped: number; unmapped: string[] };
  /** What `needs` declares outside the repo, with its local status. */
  outside: OutsideCheck[];
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
  /** Hooks in settings.json that no step ties to (guard --check's "not tied" list). */
  untied: string[] | NotChecked;
  inventory: InventoryFacts | NotChecked;
  /** Per node id. */
  items: Record<string, ItemFacts>;
  /** The .at text the facts were read against (the Index lens embeds it). */
  source: string;
  /** Where each declaration sits in `source`: `<kind>:<id>` to a 1-based line. */
  lines: Record<string, number>;
}

export interface CollectOptions {
  source: string;
  /** Absolute path of the .at file (lets validate resolve imports). */
  filePath?: string;
  /** Project dir to read from disk. Without it nothing is checked. */
  dir?: string;
  now?: Date;
  /** Also list the user-level tree and check `needs` against the home folder (`validate --inventory --user`). */
  user?: boolean;
  /** The home folder `user` reads; default `$HOME`. Tests point it at a temp dir. */
  home?: string;
  /** Passed to the inventory collector (tests give an empty crontab and LaunchAgents folder). */
  inventory?: InventoryCollectOptions;
}

export function collectFacts(ast: TopologyAST, opts: CollectOptions): Facts {
  const sha256 = createHash("sha256").update(opts.source).digest("hex");
  const at = (opts.now ?? new Date()).toISOString();
  const version = versionStamp();
  if (!opts.dir) {
    const items: Record<string, ItemFacts> = {};
    for (const n of ast.nodes) items[n.id] = { validate: NOT_CHECKED, guard: NOT_CHECKED };
    return { checked: false, sha256, at, version, validate: NOT_CHECKED, guard: NOT_CHECKED, untied: NOT_CHECKED, inventory: NOT_CHECKED, items, source: opts.source, lines: sourceIndex(opts.source) };
  }
  const root = path.resolve(opts.dir);
  const v = validateResult(ast, opts.filePath);
  const report = checkGuards(ast, root);
  const guard = guardFacts(report);
  const user = !!opts.user;
  const items0 = collectInventory(root, { ...opts.inventory, roots: ast.inventoryRoots ?? [], user, ...(opts.home !== undefined ? { home: opts.home } : {}) });
  const cov = coverageResult(ast, items0, root, user, opts.home);
  const unmappedIds = new Set(cov.unmapped.map((i) => i.id));
  const kinds = new Map<string, InventoryKindFacts>();
  const kindOf = (k: string) => { let e = kinds.get(k); if (!e) kinds.set(k, (e = { kind: k, mapped: [], unmapped: [], missing: [] })); return e; };
  for (const i of items0.filter((x) => x.scope !== "user" && x.tag !== "e")) kindOf(i.kind)[unmappedIds.has(i.id) ? "unmapped" : "mapped"].push(i.id);
  for (const m of cov.missing) kindOf(m.from.split(/[\s:]/)[0]).missing.push(`${m.path}  <- ${m.from}`);
  const items: Record<string, ItemFacts> = {};
  for (const n of ast.nodes) {
    items[n.id] = { validate: v.results.filter((r) => r.node === n.id), guard: guard[n.id] };
  }
  return {
    checked: true, sha256, at, version, validate: v, guard, untied: [...report.unattributed], items, source: opts.source, lines: sourceIndex(opts.source),
    inventory: {
      total: cov.total,
      mapped: cov.mapped,
      unmapped: cov.unmapped.map((i) => i.id),
      missing: cov.missing.map((m) => ({ path: m.path, from: m.from })),
      notScaffolded: cov.notScaffolded,
      kinds: [...kinds.values()].sort((a, b) => (a.kind < b.kind ? -1 : 1)),
      external: cov.external.map((i) => i.id),
      roots: cov.roots ?? [],
      ...(cov.user ? { user: { total: cov.user.total, mapped: cov.user.mapped, unmapped: cov.user.unmapped.map((i) => i.id) } } : {}),
      outside: cov.outside ?? [],
    },
  };
}
