/**
 * Include resolution: `include "./f.at"` merges a fragment into the topology.
 *
 * The fragment is read relative to the file that writes the include, parsed,
 * and what it declares is merged into the including AST, so validate,
 * scaffold, guard --check and plan all see it. A section is either merged or
 * refused with a V8 error naming the section and the fragment file; nothing a
 * fragment declares is dropped in silence (until 0.13 the include line was
 * parsed and never read, so a fragment's hooks never reached settings.json).
 *
 * Merged: named lists (agents, actions, gates and other nodes, hooks,
 * triggers, skills, tools, schedules, schemas, artifacts, records, stores,
 * retrievals, providers, interfaces, machines, persons), keyed maps
 * (mcp-servers, env, roles), flow edges, decisions and inventory roots.
 * A name declared both by the including file and by a fragment (or by two
 * fragments) is a V8 error naming both files, never an override.
 *
 * Refused (V8 error): one-per-topology sections (settings, defaults, depth,
 * memory, batch, environments, metering, observability, checkpoint, context,
 * extensions, params, interface, needs, pin-models, meta fields beyond
 * version and description) and `import` inside a fragment. Write them in the
 * including file.
 *
 * Paths a fragment writes (a hook's `run:`, a skill's scripts) stay as
 * written: relative to the project, like any path in the including file.
 *
 * @module
 */

import { readFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import type { TopologyAST } from "./ast.js";

export interface IncludeError {
  rule: "V8";
  level: "error";
  message: string;
  node?: string;
}

type Parse = (src: string) => TopologyAST;
type Ast = TopologyAST & Record<string, unknown>;

/** Named lists merged by their key. */
const KEYED_LISTS: Record<string, { key: "id" | "name"; what: string }> = {
  nodes: { key: "id", what: "node" },
  hooks: { key: "name", what: "hook" },
  triggers: { key: "name", what: "trigger" },
  skills: { key: "id", what: "skill" },
  toolDefs: { key: "id", what: "tool" },
  schedules: { key: "id", what: "schedule job" },
  schemas: { key: "id", what: "schema" },
  artifacts: { key: "id", what: "artifact" },
  records: { key: "id", what: "record" },
  stores: { key: "id", what: "store" },
  retrievals: { key: "id", what: "retrieval" },
  providers: { key: "name", what: "provider" },
  interfaces: { key: "id", what: "interface" },
  machines: { key: "id", what: "machine" },
  persons: { key: "id", what: "person" },
};

/** Maps merged key by key. */
const KEYED_RECORDS: Record<string, string> = {
  mcpServers: "mcp-server",
  env: "env variable",
  roles: "role",
};

/** Lists appended as they are (duplicates of plain values dropped). */
const APPEND_LISTS = new Set(["edges", "decisions", "inventoryRoots"]);

/** AST fields that are not a declared section of the fragment. */
const NOT_SECTIONS = new Set(["topology", "isFragment", "includes", "sourcePath"]);

/** How a refused section is written in .at, for the error message. */
const SECTION_WORD: Record<string, string> = {
  depth: "depth",
  memory: "memory",
  batch: "batch",
  environments: "environments",
  settings: "settings",
  metering: "metering",
  context: "context",
  defaults: "defaults",
  observability: "observability",
  params: "params",
  interfaceEndpoints: "interface",
  imports: "import",
  checkpoint: "checkpoint",
  extensions: "extensions",
  pinModels: "pin-models",
  needs: "needs",
};

let baseline: Ast | undefined;
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const isEmpty = (v: unknown) =>
  v === undefined || v === null || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0);

/**
 * Resolve every include of `ast`, read from `filePath`, merging each fragment
 * into `ast` in place. Returns the V8 errors: a missing file, a parse error, an
 * include cycle, a topology where a fragment was expected, a name clash, and a
 * section include does not merge.
 */
export function resolveIncludes(ast: TopologyAST, filePath: string, parse: Parse): IncludeError[] {
  baseline ??= parse("fragment baseline {\n}") as Ast;
  const self = resolve(filePath);
  const rootDir = dirname(self);
  const show = (abs: string) => (abs === self ? basename(abs) : relative(rootDir, abs) || basename(abs));
  const errors: IncludeError[] = [];
  /** `<section>:<key>` → the file that declared it. */
  const origin = new Map<string, string>();
  const merged = new Set<string>([self]);

  const target = ast as Ast;
  for (const [field, { key }] of Object.entries(KEYED_LISTS)) {
    for (const item of (target[field] as Array<Record<string, unknown>> | undefined) ?? []) origin.set(`${field}:${item[key]}`, self);
  }
  for (const field of Object.keys(KEYED_RECORDS)) {
    for (const k of Object.keys((target[field] as Record<string, unknown> | undefined) ?? {})) origin.set(`${field}:${k}`, self);
  }

  const visit = (from: TopologyAST, fromPath: string, chain: string[]) => {
    for (const inc of from.includes ?? []) {
      const abs = resolve(dirname(fromPath), inc.source);
      const err = (message: string) => errors.push({ rule: "V8", level: "error", node: inc.source, message: `include "${inc.source}": ${message}` });
      if (chain.includes(abs)) {
        err(`include cycle (${[...chain.slice(chain.indexOf(abs)), abs].map(show).join(" -> ")})`);
        continue;
      }
      // A fragment reached twice (two files include it) is merged once: the
      // second include declares nothing new.
      if (merged.has(abs)) continue;
      let text: string;
      try {
        text = readFileSync(abs, "utf8");
      } catch {
        err(`file not found (${abs})`);
        continue;
      }
      let sub: Ast;
      try {
        sub = parse(text) as Ast;
      } catch (e) {
        err(`parse error in ${show(abs)}: ${(e as Error).message}`);
        continue;
      }
      if (!sub.isFragment) {
        err(`${show(abs)} is a topology, not a fragment; include merges a \`fragment { ... }\` file (use import for a sub-topology)`);
        continue;
      }
      merged.add(abs);
      visit(sub, abs, [...chain, abs]);
      mergeOne(sub, abs, err);
    }
  };

  const mergeOne = (sub: Ast, abs: string, err: (m: string) => void) => {
    const file = show(abs);
    // Parse-time findings on the fragment (V12, V23, V89, V102, V131, ...)
    // live on the fragment's AST; carry them over, prefixed with its path.
    for (const k of Object.keys(sub)) {
      if (!k.startsWith("_") || k === "_sourceMap" || !Array.isArray(sub[k])) continue;
      const carried = (sub[k] as Array<Record<string, unknown>>).map(({ line: _line, ...r }) => ({ ...r, message: `${file}: ${r.message}` }));
      target[k] = [...((target[k] as unknown[] | undefined) ?? []), ...carried];
    }

    const meta = sub.topology;
    const metaBase = baseline!.topology;
    for (const [k, v] of Object.entries(meta)) {
      if (k === "name" || k === "version" || k === "description") continue;
      if (!same(v, (metaBase as unknown as Record<string, unknown>)[k])) err(`${file} declares \`meta { ${k} }\`, which include does not merge; write it in the including file`);
    }

    for (const field of Object.keys(sub)) {
      if (field.startsWith("_") || NOT_SECTIONS.has(field)) continue;
      const value = sub[field];
      if (same(value, baseline![field]) || isEmpty(value)) continue;

      const keyed = KEYED_LISTS[field];
      if (keyed) {
        const list = [...((target[field] as Array<Record<string, unknown>> | undefined) ?? [])];
        for (const item of value as Array<Record<string, unknown>>) {
          const id = `${field}:${item[keyed.key]}`;
          const was = origin.get(id);
          if (was !== undefined && was !== abs) {
            err(`${keyed.what} "${item[keyed.key]}" is declared in both ${show(was)} and ${file}; rename one`);
            continue;
          }
          origin.set(id, abs);
          list.push(item);
        }
        target[field] = list;
        continue;
      }

      const what = KEYED_RECORDS[field];
      if (what) {
        const rec = { ...((target[field] as Record<string, unknown> | undefined) ?? {}) };
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          const id = `${field}:${k}`;
          const was = origin.get(id);
          if (was !== undefined && was !== abs) {
            err(`${what} "${k}" is declared in both ${show(was)} and ${file}; rename one`);
            continue;
          }
          origin.set(id, abs);
          rec[k] = v;
        }
        target[field] = rec;
        continue;
      }

      if (APPEND_LISTS.has(field)) {
        const list = [...((target[field] as unknown[] | undefined) ?? [])];
        for (const v of value as unknown[]) {
          if (typeof v === "string" && list.includes(v)) continue;
          list.push(v);
        }
        target[field] = list;
        continue;
      }

      err(`${file} declares \`${SECTION_WORD[field] ?? field}\`, which include does not merge; write it in the including file`);
    }
  };

  visit(ast, self, [self]);
  return errors;
}
