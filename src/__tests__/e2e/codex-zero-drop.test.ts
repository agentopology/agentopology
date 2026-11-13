/**
 * [CX-23] Zero drop on Codex: every field set in kitchen-sink.at is either
 * found in the Codex output or is on the "not expressible on codex" list, and
 * each listed field gives one validate warning. No model call, no codex binary.
 */
import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { codexBinding } from "../../bindings/codex.js";
import { NOT_EXPRESSIBLE, notExpressibleHits } from "../../bindings/lib/not-expressible.js";
import type { GeneratedFile } from "../../bindings/types.js";
import type { TopologyAST } from "../../parser/ast.js";

const here = dirname(fileURLToPath(import.meta.url));
const kitchen = fs.readFileSync(resolve(here, "../../../kitchen-sink.at"), "utf8").replace(/\bmodel: (opus|sonnet|haiku)\b/g, "model: gpt-5.2");

/** Parser bookkeeping, not user-written fields. */
const STRUCTURAL = new Set(["id", "type", "label", "line", "file"]);

/** Fields expressed in another form than their own text: where to look instead. */
const EXPRESSED_AS: Record<string, (files: GeneratedFile[]) => boolean> = {
  // permissions become the project approval_policy
  "agent.permissions": (files) => /^approval_policy = "(on-request|never)"/m.test(files.find((f) => f.path === ".codex/config.toml")!.content),
};

const norm = (x: string) => x.toLowerCase().replace(/[-_]/g, " ");
const leaves = (v: unknown, acc: string[] = []): string[] => {
  if (v === undefined || v === null || v === false) return acc;
  if (typeof v === "object") for (const x of Object.values(v as object)) leaves(x, acc);
  else acc.push(String(v));
  return acc;
};

/** The fields set in `ast` that are neither found in the output nor on the list. */
function unaccounted(ast: TopologyAST, files: GeneratedFile[]): string[] {
  const out = norm(files
    .map((f) => (f.path.endsWith(".toml") ? f.content.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n") : f.content))
    .join("\n"));
  const listed = new Set(NOT_EXPRESSIBLE.map((n) => `${n.scope}.${n.field}`));
  const missing: string[] = [];
  for (const node of ast.nodes) {
    for (const [field, value] of Object.entries(node as unknown as Record<string, unknown>)) {
      if (STRUCTURAL.has(field)) continue;
      const ls = leaves(value);
      if (ls.length === 0) continue;
      const key = `${node.type}.${field}`;
      if (listed.has(`agent.${field}`) && node.type === "agent") continue;
      if (EXPRESSED_AS[key]?.(files)) continue;
      if (!ls.some((l) => out.includes(norm(l)))) missing.push(`${key} (${node.id})`);
    }
  }
  return missing;
}

describe("[CX-23] zero drop on Codex", () => {
  const ast = parse(kitchen);
  const files = codexBinding.scaffold(ast);

  it("[CX-23] every field kitchen-sink.at sets is in the Codex output or on the not-expressible list", () => {
    expect(unaccounted(ast, files)).toEqual([]);
  });

  it("[CX-23] planted: a new AST field with neither fails the check", () => {
    const planted = parse(kitchen);
    (planted.nodes.find((n) => n.type === "agent") as any).zzBrandNewField = "zz-never-written-anywhere";
    expect(unaccounted(planted, codexBinding.scaffold(planted))).toEqual([expect.stringContaining("agent.zzBrandNewField")]);
  });

  it("[CX-23] each listed field the topology sets gives exactly one validate warning, and a Claude Code validate gives none", () => {
    const hits = notExpressibleHits(ast);
    expect(hits.length).toBeGreaterThan(3);
    const warnings = validate(ast, { target: "codex" }).filter((r) => r.rule === "CX23");
    expect(warnings).toHaveLength(hits.length);
    for (const h of hits) {
      expect(warnings.filter((w) => w.message.includes(`"${h.field}"`) && w.message.includes(h.scope)), `${h.scope}.${h.field}`).toHaveLength(1);
    }
    expect(validate(ast).filter((r) => r.rule === "CX23")).toEqual([]);
  });

  it("[CX-23] scaffold prints the same warnings, once each", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    codexBinding.scaffold(parse(kitchen));
    const text = warn.mock.calls.map((c) => String(c[0]));
    warn.mockRestore();
    for (const h of notExpressibleHits(ast)) {
      expect(text.filter((m) => m.includes("not expressible") && m.includes(`"${h.field}"`) && m.includes(h.scope)), h.field).toHaveLength(1);
    }
  });

  it("[CX-23] temperature and max tokens are no longer silent TOML comments", () => {
    const toml = files.find((f) => f.path === ".codex/config.toml")!.content;
    expect(toml).not.toMatch(/^#\s+temperature = /m);
    expect(toml).not.toMatch(/^#\s+max_tokens = /m);
  });
});
