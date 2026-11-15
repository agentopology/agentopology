/**
 * agentopology/api: a stable programmatic API.
 *
 * Re-exports existing functions and types of the package under one entry, so
 * code that builds on the language imports from `agentopology/api` and never
 * from a file path inside it. The exported names are pinned by
 * src/__tests__/api-surface.test.ts.
 *
 * @module
 */

// Parse and validate
export { parse } from "./parser/index.js";
export { validate, type ValidationResult } from "./parser/validator.js";
export { validateResult } from "./visualizer/facts.js";
export type { TopologyAST } from "./parser/ast.js";

// Host conformance: hook files checked against each host's hook contract
export { checkHooks as checkClaudeHooks, onFailureWarnings, NO_MATCHER_EVENTS } from "./conformance/claude-code.js";
export { checkHooks as checkCodexHooks } from "./conformance/codex.js";

// Guards: how strongly a project enforces what its .at declares
export { checkGuards, type GuardReport, type GuardItem } from "./guard/check.js";
export { checkCodexGuards } from "./guard/check-codex.js";

// Inventory and coverage
export { collectInventory, coverage, type InventoryItem, type CoverageReport } from "./inventory/index.js";

// Import
export { importClaudeCodeWithReport, readClaudeProject, type FlowReport } from "./import/index.js";
export type { ClaudeProject } from "./import/walk.js";
export { parseFrontmatter, asList } from "./import/claude-code.js";
export type { PlatformFile } from "./sync/index.js";

// Helpers
export { runParts } from "./parser/run.js";
export { isStubContent } from "./bindings/lib/stub.js";
