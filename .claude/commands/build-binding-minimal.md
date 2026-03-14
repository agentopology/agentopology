---
description: "Build an agentopology binding fast — skips gap debate and human review"
---

# /build-binding-fast <SDK_PACKAGE> [API_DOCS_URL]

## What This Does
Fast-path binding generator that skips the 3-way gap debate and human review gate. Runs 6 stages instead of 7: Frontend, Semantic Analysis, Spec Writing (direct, no debate), Code Generation, Conformance, and Regression. Suitable for well-documented SDKs with straightforward APIs.

## Arguments
- `SDK_PACKAGE` (required): npm package name (e.g., `"openai"`, `"@google/generative-ai"`, `"cohere-ai"`)
- `API_DOCS_URL` (optional): URL to the API documentation

## Execution Plan

---

### Stage 1: Frontend (sdk-installer)

**Launch:** `@sdk-installer` with `SDK_PACKAGE` = `$ARGUMENTS`

Installs the SDK, introspects all `.d.ts` type declarations, fetches API docs if URL provided, caches types into `domains/sdk-types/`, and writes `workspace/capability-ir.md`.

**Produces:** `workspace/capability-ir.md`, `domains/sdk-types/`

---

### Stage 2: Semantic Analysis (ast-mapper)

**Launch:** `@ast-mapper`

Maps every AST concept in `src/parser/ast.ts` to the SDK. Covers all 30 TopologyAST fields, 48 AgentNode fields, 13 EdgeDef fields, 6 node types, and all supporting types. Assigns NATIVE, PARTIAL, CLIENT-SIDE, or IMPOSSIBLE to each row.

**Produces:** `workspace/ast-mapping.md`

---

### Stage 3: Spec Writing (spec-writer) -- direct, no debate

**Launch:** `@spec-writer`

Skips the gap-debate group chat (depth level 1: minimal). The spec-writer resolves gap strategies on its own by reading existing bindings (`src/bindings/claude-code.ts`) as reference and applying the standard strategy table (POLYFILL, SHIM, MAP, COMMENT, SKIP). Writes the complete `workspace/binding-spec.md` blueprint.

**Produces:** `workspace/binding-spec.md`

If verdict is `needs-research`, stop and report to the user.

---

### Stage 4: Code Generation (code-generator)

**Launch:** `@code-generator`

Generates `src/bindings/<name>.ts` following the binding-spec blueprint. Registers the binding in `src/bindings/index.ts`. Runs `npx tsc --noEmit` and self-corrects type errors up to 3 times.

**Produces:** `src/bindings/<name>.ts`, updated `src/bindings/index.ts`

#### Gate: type-and-coverage
Verify `tsc` passes, AST coverage meets threshold, imports resolve. On failure, bounce back to code-generator. Max 2 retries.

---

### Stage 5: Conformance (conformance-checker)

**Launch:** `@conformance-checker`

Builds AST coverage matrix, scaffolds every `examples/*.at` file with the new binding (dry-run), verifies field-level and edge-type coverage. Writes `workspace/conformance-report.md`.

**Produces:** `workspace/conformance-report.md`

#### Gate: conformance-matrix
Verify all examples scaffold, files are non-empty, no path collisions. On failure, bounce back to code-generator. Max 1 retry.

---

### Stage 6: Regression (regression-guard)

**Launch:** `@regression-guard`

Runs `npx tsc --noEmit`, `npx vitest run`, verifies binding registration, writes new tests, re-runs vitest.

---

### Feedback Loop

If conformance-checker or regression-guard fails, re-launch code-generator with error context. Max 3 total retries. If still failing, stop and report.

---

### Done

Report: binding name, file path, files generated per scaffold, tests written, AST coverage percentage, and any SKIP/IMPOSSIBLE gaps.
