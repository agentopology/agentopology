---
description: "Build a complete agentopology binding from an SDK package and API docs"
---

# /build-binding <SDK_PACKAGE> [API_DOCS_URL]

## What This Does
Takes an npm package name and optional API documentation URL, then runs the full 7-stage compiler pipeline defined in `binding-factory.at` to produce a tested, registered, and conformance-verified `BindingTarget` implementation in `src/bindings/`.

## Arguments
- `SDK_PACKAGE` (required): npm package name (e.g., `"openai"`, `"@google/generative-ai"`, `"cohere-ai"`)
- `API_DOCS_URL` (optional): URL to the API documentation for features not covered by the SDK's `.d.ts` types

## Execution Plan

Execute these stages sequentially. Each stage launches a subagent via `@agent-name`. Do not skip stages. Do not proceed past a gate until it passes.

---

### Stage 1: Frontend (sdk-installer)

**Goal:** Install the SDK, introspect its TypeScript declarations, fetch API docs, and produce the Capability IR.

**Launch:** `@sdk-installer` with inputs:
- `SDK_PACKAGE` = `$ARGUMENTS` (first argument)
- `API_DOCS_URL` = second argument if provided

**What it does:**
1. `npm install <SDK_PACKAGE> --save-dev`
2. Reads all `.d.ts` files from the installed package and extracts every exported symbol
3. Caches `.d.ts` content into `domains/sdk-types/` for downstream reuse
4. If `API_DOCS_URL` provided, fetches docs via WebFetch and caches into `domains/api-docs/`
5. Writes `workspace/capability-ir.md` with auth methods, endpoints, tool use support, streaming, model params, and all exported types

**Produces:** `workspace/capability-ir.md`, `domains/sdk-types/`
**Expected output:** `status: complete`

---

### Stage 2: Semantic Analysis (ast-mapper)

**Goal:** Map every AST concept in `src/parser/ast.ts` to the SDK's capabilities.

**Launch:** `@ast-mapper`

**What it does:**
1. Reads `workspace/capability-ir.md` and `src/parser/ast.ts`
2. Creates a row-by-row mapping for every TopologyAST field (30), every AgentNode field (48), every EdgeDef field (13), all 6 node types, and all supporting types
3. Assigns coverage level to each: NATIVE, PARTIAL, CLIENT-SIDE, or IMPOSSIBLE
4. Writes `workspace/ast-mapping.md` with counts

**Produces:** `workspace/ast-mapping.md`
**Expected output:** `completeness: full | has-gaps`

---

### Stage 3: Gap Debate (gap-debate group)

**Goal:** Three-way debate to resolve the strategy for every non-NATIVE gap.

**Launch agents as group:** `@sdk-specialist`, `@binding-veteran`, `@platform-expert`

**What they do:**
1. Read `workspace/ast-mapping.md` and `domains/sdk-types/`
2. For every PARTIAL, CLIENT-SIDE, and IMPOSSIBLE row, debate the best resolution strategy:
   - POLYFILL (inline helper), SHIM (separate file), MAP (translation), COMMENT (doc only), SKIP (impossible)
3. Round-robin speaker selection, max 3 rounds
4. Terminate when all gaps have a consensus strategy

**Produces:** Debate transcript with resolved strategies for each gap

---

### Stage 3.5: Spec Writing (spec-writer)

**Goal:** Synthesize debate results into a deterministic binding specification.

**Launch:** `@spec-writer`

**What it does:**
1. Reads `workspace/capability-ir.md`, `workspace/ast-mapping.md`, debate results, and `src/bindings/claude-code.ts` as reference
2. Writes `workspace/binding-spec.md` containing:
   - Gap resolution table (every gap with its strategy from the debate)
   - File architecture (every file the binding will generate)
   - Model mapping table (topology aliases to exact SDK model IDs)
   - Permission mapping, tool name mapping, platform-specific considerations

**Produces:** `workspace/binding-spec.md`
**Expected output:** `verdict: ready`

If verdict is `needs-research`, stop and report what is missing to the user.

---

### Stage 4: Code Generation (code-generator)

**Goal:** Generate the complete binding `.ts` file, register it, and pass type checking.

**Launch:** `@code-generator`

**What it does:**
1. Reads `workspace/binding-spec.md` as the blueprint
2. Reads `src/bindings/types.ts` (BindingTarget interface), `src/bindings/claude-code.ts` (reference pattern), `src/parser/ast.ts` (AST types)
3. Generates `src/bindings/<name>.ts` following the standard binding structure:
   - Import block, helpers, model mapping, permission mapping, section generators, scaffold function, BindingTarget export
4. Registers the binding in `src/bindings/index.ts`
5. Runs `npx tsc --noEmit` and fixes any type errors (up to 3 self-check loops)

**Produces:** `src/bindings/<name>.ts`, updated `src/bindings/index.ts`
**Expected output:** `status: compiled`

#### Gate: type-and-coverage

After code-generator completes, verify:
- `npx tsc --noEmit` passes with zero errors
- AST coverage meets threshold (grep binding file for all AST interface references)
- All imports resolve

If the gate fails, bounce back to code-generator with the error output. Max 2 gate retries.

---

### Stage 5: Human Review (binding-review)

**Goal:** Present the generated binding to the user for approval before running the full test suite.

**Pause for human input.** Show the user:
1. The generated binding file path and a summary of its structure
2. The gap resolution decisions (from binding-spec.md)
3. The AST coverage stats (from ast-mapping.md)

Wait for the user to approve, request changes, or reject.
- If approved: proceed to Stage 6
- If changes requested: re-launch `@code-generator` with the feedback, then re-gate
- If rejected: stop and report

Timeout: 1 hour. On timeout: skip and proceed.

---

### Stage 6: Conformance (conformance-checker)

**Goal:** Formal verification that the binding handles every AST concept and scaffolds correctly.

**Launch:** `@conformance-checker`

**What it does:**
1. Builds an AST coverage matrix: greps the binding file for every exported interface in `src/parser/ast.ts`
2. Scaffolds every `.at` file in `examples/` using the new binding (dry-run mode)
3. Verifies field-level coverage for all 48 AgentNode fields
4. Verifies all edge types are handled
5. Writes `workspace/conformance-report.md` with full matrix

**Produces:** `workspace/conformance-report.md`
**Expected output:** `verdict: pass`

#### Gate: conformance-matrix

After conformance-checker completes, verify:
- All example files scaffold successfully
- All generated files are non-empty
- No path collisions between generated files

If the gate fails, bounce back to code-generator with the missing concepts. Max 1 gate retry.

---

### Stage 7: Regression (regression-guard)

**Goal:** Run the complete test suite and write new tests for the binding.

**Launch:** `@regression-guard`

**What it does:**
1. `npx tsc --noEmit` -- zero errors
2. `npx vitest run` -- all existing tests pass
3. Verifies binding is registered in `src/bindings/index.ts`
4. Validates all `examples/*.at` files
5. Writes new tests for the binding following existing test patterns
6. Runs vitest again to confirm new tests pass

**Expected output:** `verdict: pass`

---

### Feedback Loop

If conformance-checker or regression-guard returns `verdict: fail`:
1. Collect the error details from the failing stage's report
2. Re-launch `@code-generator` with the error context appended to its input
3. Re-run the gate and the failing verification stage
4. Maximum 3 total retry cycles across both stages. If still failing after 3, stop and report the failures to the user.

---

### Done

When regression-guard returns `verdict: pass`, report to the user:

- **Binding name:** the target name (e.g., `openai`)
- **Binding file:** `src/bindings/<name>.ts`
- **Files generated:** count of files the scaffold produces per example
- **Tests written:** count of new test cases
- **AST coverage:** percentage from conformance report
- **Gaps:** count of SKIP/IMPOSSIBLE items (if any)
