/**
 * `agentopology/api` is a stable programmatic API: the names it exports are
 * pinned here, so adding, renaming or removing one is a visible test failure
 * and never a silent break for code that imports it.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import * as api from "../api.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const VALUES = [
  "NO_MATCHER_EVENTS",
  "asList",
  "checkClaudeHooks",
  "checkCodexGuards",
  "checkCodexHooks",
  "checkGuards",
  "collectInventory",
  "coverage",
  "importClaudeCodeWithReport",
  "isStubContent",
  "onFailureWarnings",
  "parse",
  "parseFrontmatter",
  "readClaudeProject",
  "runParts",
  "validate",
  "validateResult",
];

const TYPES = [
  "ClaudeProject",
  "CoverageReport",
  "FlowReport",
  "GuardItem",
  "GuardReport",
  "InventoryItem",
  "PlatformFile",
  "TopologyAST",
  "ValidationResult",
];

describe("agentopology/api", () => {
  it("exports exactly the pinned runtime names", () => {
    expect(Object.keys(api).sort()).toEqual(VALUES);
    for (const name of VALUES) expect((api as Record<string, unknown>)[name], name).toBeDefined();
  });

  it("exports exactly the pinned names, types included", () => {
    const file = resolve(root, "src/api.ts");
    const program = ts.createProgram([file], { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true, skipLibCheck: true });
    const checker = program.getTypeChecker();
    const sym = checker.getSymbolAtLocation(program.getSourceFile(file)!)!;
    const names = checker.getExportsOfModule(sym).map((s) => s.name).sort();
    expect(names).toEqual([...VALUES, ...TYPES].sort());
  });

  it("is an entry in package.json exports", () => {
    const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    expect(pkg.exports["./api"]).toEqual({ import: "./dist/api.js", types: "./dist/api.d.ts" });
  });

  it("keeps the two hook checks apart", () => {
    const m = api as Record<string, unknown>;
    expect(m.checkClaudeHooks).not.toBe(m.checkCodexHooks);
  });
});
