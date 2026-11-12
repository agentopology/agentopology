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
type Validate = (ast: TopologyAST, opts?: { filePath?: string; importStack?: string[] }) => Array<{ rule: string; level: "error" | "warning"; message: string }>;

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
    let bytes: Buffer;
    try {
      bytes = readFileSync(target);
    } catch {
      results.push({ rule: "V8", level: "error", node: imp.alias, message: `import "${imp.source}": file not found (${target})` });
      continue;
    }
    if (imp.sha256) {
      const want = imp.sha256.replace(/^sha256:/i, "").toLowerCase();
      const got = createHash("sha256").update(bytes).digest("hex");
      if (want !== got) {
        results.push({ rule: "V8", level: "error", node: imp.alias, message: `import "${imp.source}": sha256 does not match (declared ${want}, file is ${got})` });
        continue;
      }
    }
    let sub: TopologyAST;
    try {
      sub = parse(bytes.toString("utf8"));
    } catch (err) {
      results.push({ rule: "V8", level: "error", node: imp.alias, message: `${imp.source}: parse error: ${(err as Error).message}` });
      continue;
    }
    for (const r of validate(sub, { filePath: target, importStack: chain })) {
      if (r.level === "error") {
        results.push({ rule: "V8", level: "error", node: imp.alias, message: `${imp.source}: [${r.rule}] ${r.message}` });
      }
    }
  }
  return results;
}
