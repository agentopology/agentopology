---
name: binding-factory
description: "Compiler-grade binding generator — npm install SDK, introspect types, map every AST concept, debate gap strategies, generate + verify binding"
version: "1.0.0"
topology: binding-factory
patterns:
  - pipeline
  - fan-out
  - human-gate
  - debate
entry: commands/build-binding.md
---

# Binding Factory Topology Skill

Compiler-grade binding generator for AgentTopology. Takes an npm SDK package and optional API docs URL, then runs a 7-stage compiler pipeline to produce a fully conformant binding that maps every AST concept to the target platform.

Version: 1.0.0
Patterns: pipeline, fan-out, human-gate, debate

## Orchestrator

The binding factory is a 7-stage compiler pipeline. Each stage is an agent with a narrowly scoped responsibility, reading and writing to the shared workspace. The pipeline is deterministic: given the same SDK and AST, it produces the same binding.

### Stage 1: SDK Installer (`sdk-installer`)
Installs the target SDK package via npm, extracts `.d.ts` type declarations, and produces the **capability IR** -- a structured inventory of every authentication method, API endpoint, tool interface, parameter shape, and error type the SDK exposes. Caches type declarations in `domains/sdk-types/` so retry loops skip re-installation.

### Stage 2: AST Mapper (`ast-mapper`)
Walks every exported interface and type in `src/parser/ast.ts` and maps each one to the SDK's capabilities. Produces a coverage table where every AST concept gets one of four verdicts: **NATIVE** (SDK has direct support), **PARTIAL** (SDK supports it with workarounds), **CLIENT** (must be implemented in the binding), or **IMPOSSIBLE** (cannot be supported). Gaps (anything not NATIVE) are flagged for debate.

### Stage 3: Gap Debate (`gap-debate`)
A GROUP node that orchestrates a 3-perspective debate among `sdk-specialist`, `binding-veteran`, and `platform-expert`. Each gap from the AST mapping is discussed to reach consensus on the resolution strategy: polyfill, shim, client-side implementation, extension comment, or documented skip. See the [Gap Debate Agent](../../agents/gap-debate/AGENT.md) for the full protocol.

### Stage 4: Spec Writer (`spec-writer`)
Synthesizes the capability IR, the AST mapping with coverage verdicts, and the debate consensus into a deterministic **binding spec**. This is the blueprint: it specifies exactly which file(s) to generate, what each function signature looks like, which AST types map to which SDK calls, and what gap strategies to apply. No ambiguity remains after this stage.

### Stage 5: Code Generator (`code-generator`)
Reads the binding spec and SDK type declarations to produce the actual TypeScript binding file(s) in `workspace/generated-binding/`. Follows the patterns established by existing bindings in `src/bindings/`. The output must compile cleanly with `tsc --noEmit` and reference every AST interface.

### Stage 6: Conformance Checker (`conformance-checker`)
Runs every example `.at` file through the CLI scaffold command with the new binding as the target. Verifies that all examples produce non-empty output, no path collisions exist, and the coverage matrix matches what the AST mapper promised. Produces a conformance report.

### Stage 7: Regression Guard (`regression-guard`)
Runs the full test suite (`npx vitest run`) and the TypeScript compiler to verify the new binding does not break any existing functionality. This is the final quality gate before delivery.

### Retry Loops
Two feedback loops exist in the pipeline:
- **Conformance failure**: If conformance-checker returns `verdict: fail`, the pipeline bounces back to code-generator with the conformance report attached. The code-generator re-reads the binding spec (not regenerated) and the conformance report to fix the issues. Maximum 3 retries.
- **Regression failure**: If regression-guard returns `verdict: fail`, the pipeline bounces back to code-generator with the test failure output. Maximum 3 retries.

## How to Use

### Full build with API docs (standard depth)
```
/build-binding @anthropic-ai/sdk https://docs.anthropic.com/en/api
```
This runs all 7 stages including the gap debate. The API docs URL is fetched and cached in `domains/api-docs/` to supplement the type introspection with documentation context.

### Minimal build (skip debate)
```
/build-binding-minimal @anthropic-ai/sdk
```
Skips the gap debate stage entirely. Gaps are resolved by the spec-writer alone using default strategies (PARTIAL becomes client-side, IMPOSSIBLE becomes extension comment). Faster but may produce less optimal gap resolutions.

### Targeting a specific binding name
The SDK package name is used to derive the binding name. `@anthropic-ai/sdk` becomes `anthropic-sdk`, `@google/generative-ai` becomes `gemini-cli`, etc. The mapping is deterministic.

## Depth Modes

Three depth levels control how thoroughly gaps are analyzed:

### Minimal
- Skips the gap debate entirely
- Spec-writer applies default gap strategies
- No API docs fetch
- Best for: SDKs with high NATIVE coverage where gaps are trivial

### Standard (default)
- Full gap debate with 3 rounds
- API docs fetched and cached
- Conformance check against all examples
- Best for: Most new bindings

### Thorough
- Full gap debate with extended rounds (up to 5)
- API docs fetched and cross-referenced with SDK types
- Conformance check plus manual review gate before delivery
- Regression guard runs with coverage reporting
- Best for: Critical bindings or SDKs with many gaps

## Artifacts

The pipeline produces 6 artifacts, each building on the previous:

| # | Artifact | File | Producer | Consumers |
|---|----------|------|----------|-----------|
| 1 | Capability IR | `workspace/capability-ir.md` | sdk-installer | ast-mapper, spec-writer |
| 2 | SDK Type Cache | `domains/sdk-types/*.d.ts` | sdk-installer | ast-mapper, spec-writer, code-generator |
| 3 | AST Mapping | `workspace/ast-mapping.md` | ast-mapper | gap-debate, spec-writer, conformance-checker |
| 4 | Binding Spec | `workspace/binding-spec.md` | spec-writer | code-generator |
| 5 | Generated Binding | `workspace/generated-binding/*.ts` | code-generator | conformance-checker, regression-guard |
| 6 | Conformance Report | `workspace/conformance-report.md` | conformance-checker | regression-guard, code-generator (on retry) |

Lineage is strictly forward: each artifact depends only on artifacts with a lower number. The exception is the retry loop, where artifact 6 feeds back into the code-generator to refine artifact 5.

## Gates

### Type and Coverage Gate
- **Position**: After code-generator, before binding-review
- **Script**: `scripts/gate-type-and-coverage.sh`
- **Checks**:
  1. **tsc --noEmit** -- the generated binding must compile without errors
  2. **AST coverage** -- every exported interface/type in `src/parser/ast.ts` must be referenced in the binding file
  3. **Import completeness** -- no unused imports in the binding file
- **On fail (bounce-back)**: Pipeline returns to code-generator with the gate output. The code-generator re-reads the binding spec and fixes compilation or coverage issues. The spec is NOT regenerated.

### Conformance Matrix Gate
- **Position**: After conformance-checker, before regression-guard
- **Script**: `scripts/gate-conformance-matrix.sh`
- **Checks**:
  1. **Example scaffolding** -- every `.at` file in `examples/` must scaffold successfully with the new binding as target
  2. **Non-empty files** -- scaffolded output must not contain empty files
  3. **No path collisions** -- all generated file paths must be unique
- **On fail (bounce-back)**: Pipeline returns to code-generator with the conformance report. The code-generator adjusts the scaffold logic or file naming to resolve collisions/failures. Maximum 3 retries before the pipeline halts with an error.

## Group Debate

The gap-debate stage is a GROUP node, not a regular agent. It orchestrates a structured 3-perspective debate to resolve every gap identified in the AST mapping.

- **Members**: sdk-specialist (knows the SDK internals), binding-veteran (knows existing AgentTopology bindings), platform-expert (knows the target platform's constraints)
- **Protocol**: Round-robin, 3 rounds maximum
- **Input**: `workspace/ast-mapping.md` with gaps marked as PARTIAL, CLIENT, or IMPOSSIBLE
- **Output**: Consensus strategy for each gap, written back to the AST mapping or passed to spec-writer
- **Termination**: All gaps have an agreed resolution strategy

See [Gap Debate Agent](../../agents/gap-debate/AGENT.md) for the full debate protocol and format.

## Flow

```
sdk-installer -> ast-mapper
ast-mapper -> gap-debate
gap-debate -> spec-writer
spec-writer -> code-generator
code-generator -> binding-review
binding-review -> conformance-checker
conformance-checker -> regression-guard
conformance-checker -> code-generator [when conformance-checker.verdict == fail] [max 3]
regression-guard -> code-generator [when regression-guard.verdict == fail] [max 3]
regression-guard -> deliver-binding [when regression-guard.verdict == pass]
```

## Gates

### Type And Coverage
After: code-generator
Before: binding-review
Run: scripts/binding-gate.sh
Checks: tsc, ast-coverage, imports
On fail: bounce-back

### Conformance Matrix
After: conformance-checker
Before: regression-guard
Run: scripts/conformance-gate.sh
Checks: all-examples-scaffold, non-empty-files, no-collisions
On fail: bounce-back

## Triggers

### /build-binding
Pattern: `/build-binding <SDK_PACKAGE> <API_DOCS_URL>`
Argument: SDK_PACKAGE
Description: Full pipeline run with API docs. Installs the SDK, introspects types, runs gap debate, generates and verifies the binding. The API_DOCS_URL is optional but recommended for better capability IR.

### /build-binding-minimal
Pattern: `/build-binding-fast <SDK_PACKAGE>`
Argument: SDK_PACKAGE
Description: Minimal-depth run. Skips the gap debate, uses default gap strategies, and omits API docs fetch. Suitable for SDKs with high native coverage.

## Memory Layout

### `workspace/`
Ephemeral per-run directory. Each pipeline run writes its artifacts here. Contents are overwritten on each invocation -- they are intermediate compiler outputs, not persistent state.

```
workspace/
  capability-ir.md        # SDK capability inventory
  ast-mapping.md          # AST-to-SDK coverage table
  binding-spec.md         # Deterministic generation blueprint
  generated-binding/      # Output TypeScript file(s)
    <binding-name>.ts
  conformance-report.md   # Scaffold + coverage verification results
```

### `domains/`
Persistent cache directory. Survives across runs so that retry loops and subsequent invocations skip expensive operations (npm install, WebFetch).

```
domains/
  sdk-types/              # Cached .d.ts files from npm install
    <package-name>/
      index.d.ts
      ...
  api-docs/               # Cached WebFetch results (via cache-fetch.sh hook)
    <sanitized-url>.md
```

### `runs/`
Run history directory. Each completed pipeline run can optionally log its metrics here via the `log-stage.sh` hook for observability.
