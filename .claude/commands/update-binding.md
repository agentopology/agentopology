---
description: "Update an existing agentopology binding when its SDK releases a new version"
---

# /update-binding <BINDING_NAME>

## What This Does
Takes the name of an existing binding and runs the update path defined in `binding-factory.at` to surgically patch the binding for the latest SDK version, without a full rewrite.

## Arguments
- `BINDING_NAME` (required): the binding to update (e.g., `anthropic-sdk`, `vercel-ai`)

## Execution Plan

Execute these stages sequentially. Each stage launches a subagent. Do not skip stages.

---

### Stage 1: SDK Differ (sdk-differ)

**Goal:** Diff old vs new SDK types to produce a structured change set.

**Launch:** `@sdk-differ` with inputs:
- `BINDING_NAME` = `$ARGUMENTS`

**What it does:**
1. Reads `domains/binding-registry.json` to find the package name, current version, docs URL, and changelog URL
2. If a changelog URL exists, fetches it via WebFetch to understand what changed contextually
3. Snapshots the current cached `.d.ts` files from `domains/sdk-types/` into `workspace/sdk-diff/old/`
4. Runs `npm update <package-name>` and reads the new version
5. Reads updated `.d.ts` files, writes them to `domains/sdk-types/` and `workspace/sdk-diff/new/`
6. Produces `workspace/sdk-diff/changeset.md` with breaking changes, new features, modified signatures, and removals

**Produces:** `workspace/sdk-diff/changeset.md`
**Expected output:** `change-level: breaking | additive | patch | none`

If `change-level` is `none`, stop and report that no update is needed.

---

### Stage 2: IR Updater (ir-updater)

**Goal:** Update the capability IR and identify which AST mappings changed.

**Launch:** `@ir-updater`

**What it does:**
1. Reads `workspace/sdk-diff/changeset.md` to understand what changed
2. Updates `workspace/capability-ir.md` with new/removed/modified features
3. Produces `workspace/ast-mapping-delta.md` with only the changed rows: upgrades (CLIENT-SIDE to NATIVE), migrations (signature changes), new mappings, removed mappings

**Produces:** `workspace/capability-ir.md` (updated), `workspace/ast-mapping-delta.md`
**Expected output:** `status: updated | no-changes`

If `status` is `no-changes`, skip to deliver-update and report that the SDK update has no binding impact.

---

### Stage 3: Binding Patcher (binding-patcher)

**Goal:** Surgically patch the existing binding -- only modify functions affected by the SDK change.

**Launch:** `@binding-patcher`

**What it does:**
1. Reads `workspace/sdk-diff/changeset.md` and `workspace/ast-mapping-delta.md`
2. Identifies which `generate*()` functions in the existing binding need patching
3. Uses the Edit tool for targeted changes -- does NOT rewrite the whole file
4. Runs `npx tsc --noEmit` after each patch to verify compilation
5. Updates dependency versions in the package.json generator

**Produces:** Updated `src/bindings/<name>.ts`
**Expected output:** `status: compiled`

---

### Stage 4: Conformance (conformance-checker)

**Goal:** Verify the patched binding still handles every AST concept and scaffolds correctly.

**Launch:** `@conformance-checker` (reused from create path)

**What it does:**
1. AST coverage matrix: greps the binding for every exported interface in `src/parser/ast.ts`
2. Scaffolds every `.at` file in `examples/` using the updated binding (dry-run)
3. Verifies field-level coverage for all 48 AgentNode fields
4. Verifies all edge types are handled
5. Writes `workspace/conformance-report.md`

**Produces:** `workspace/conformance-report.md`
**Expected output:** `verdict: pass`

---

### Stage 5: Regression (regression-guard)

**Goal:** Full test suite and type check to ensure nothing is broken.

**Launch:** `@regression-guard` (reused from create path)

**What it does:**
1. `npx tsc --noEmit` -- zero errors
2. `npx vitest run` -- all existing tests pass
3. Verifies binding is registered in `src/bindings/index.ts`
4. Validates all `examples/*.at` files
5. Reports final verdict

**Expected output:** `verdict: pass`

---

### Feedback Loop

If conformance-checker or regression-guard returns `verdict: fail`:
1. Collect the error details from the failing stage's report
2. Re-launch `@binding-patcher` with the error context (NOT code-generator -- this is the update path)
3. Re-run the failing verification stage
4. Maximum 2 total retry cycles. If still failing after 2, stop and report the failures to the user.

---

### Done

When regression-guard returns `verdict: pass`, report to the user:

- **Binding name:** the target name
- **SDK version:** old version to new version
- **Change level:** breaking | additive | patch
- **Functions patched:** count of generate*() functions modified
- **AST coverage:** percentage from conformance report
- **Tests:** all passing (count)
