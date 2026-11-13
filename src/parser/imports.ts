/**
 * Import resolution at validate time (N43, T-02).
 *
 * `import "./f.at" as x` is read relative to the importing file. A missing
 * file, a wrong `sha256`, an import cycle and any error inside the imported
 * file are V8 errors, reported with the imported path. Registry imports are
 * not files and are left to V56/V57.
 *
 * @module
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import type { TopologyAST } from "./ast.js";

export interface ImportResult {
  rule: "V8";
  level: "error" | "warning";
  message: string;
  node?: string;
}

type Parse = (src: string) => TopologyAST;
type Result = { rule: string; level: "error" | "warning"; message: string };
type Validate = (ast: TopologyAST, opts?: { filePath?: string; importStack?: string[]; importCache?: ImportCache }) => Result[];

/** What was learned about one resolved file; shared by every import that reaches it. */
type Loaded = { bytes: Buffer; parseError?: string; errors: Result[] } | { missing: true };
export type ImportCache = Map<string, Loaded>;

/**
 * Rules an imported `fragment` is held to: parse-level problems and its own
 * names. A fragment is a part, not a whole topology, so rules such as V3/V4
 * (flow, orphans), V7 (model) and V91 (meta) do not apply to it.
 */
const FRAGMENT_RULES = new Set(["V1", "V2", "V8", "V12", "V23", "V24", "V89", "V90", "V92", "V98", "V102"]);

/**
 * Check every local import of `ast`, which was read from `filePath`.
 * `stack` holds the files already being resolved (for cycle detection).
 */
export function checkImports(
  ast: TopologyAST,
  filePath: string,
  parse: Parse,
  validate: Validate,
  stack: string[] = [],
  cache: ImportCache = new Map(),
): ImportResult[] {
  const results: ImportResult[] = [];
  const self = resolve(filePath);
  const chain = [...stack, self];
  for (const imp of ast.imports) {
    if (imp.registry) continue;
    const target = resolve(dirname(self), imp.source);
    if (chain.includes(target)) {
      const loop = [...chain.slice(chain.indexOf(target)), target].join(" -> ");
      results.push({ rule: "V8", level: "error", node: imp.alias, message: `import "${imp.source}": import cycle (${loop})` });
      continue;
    }
    // Each file is read, parsed and validated once, however many paths reach
    // it. The cycle check above stays per path.
    let cached = cache.get(target);
    if (!cached) {
      let bytes: Buffer | undefined;
      try {
        bytes = readFileSync(target);
      } catch {
        cached = { missing: true };
      }
      if (bytes) {
        let sub: TopologyAST | undefined;
        let parseError: string | undefined;
        try {
          sub = parse(bytes.toString("utf8"));
        } catch (err) {
          parseError = (err as Error).message;
        }
        let errors: Result[] = [];
        if (sub) {
          const all = validate(sub, { filePath: target, importStack: chain, importCache: cache }).filter((r) => r.level === "error");
          errors = sub.isFragment ? all.filter((r) => FRAGMENT_RULES.has(r.rule)) : all;
        }
        cached = { bytes, parseError, errors };
      }
      cache.set(target, cached!);
    }
    const loaded: Loaded = cached!;
    if ("missing" in loaded) {
      results.push({ rule: "V8", level: "error", node: imp.alias, message: `import "${imp.source}": file not found (${target})` });
      continue;
    }
    if (imp.sha256) {
      const want = imp.sha256.replace(/^sha256:/i, "").toLowerCase();
      const got = createHash("sha256").update(loaded.bytes).digest("hex");
      if (want !== got) {
        results.push({ rule: "V8", level: "error", node: imp.alias, message: `import "${imp.source}": sha256 does not match (declared ${want}, file is ${got})` });
        continue;
      }
    }
    if (loaded.parseError !== undefined) {
      results.push({ rule: "V8", level: "error", node: imp.alias, message: `${imp.source}: parse error: ${loaded.parseError}` });
      continue;
    }
    for (const r of loaded.errors) {
      results.push({ rule: "V8", level: "error", node: imp.alias, message: `${imp.source}: [${r.rule}] ${r.message}` });
    }
  }
  return results;
}
