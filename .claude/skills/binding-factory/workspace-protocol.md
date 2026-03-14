# Workspace Protocol

This document is the **data contract** between pipeline stages in the binding factory. Every agent reads and writes to the shared `workspace/` and `domains/` directories following the rules below. No agent may read a file it is not listed as a consumer of, and no agent may write to a file owned by another stage.

## Workspace Files

### `workspace/capability-ir.md`

**Producer**: sdk-installer
**Consumers**: ast-mapper, spec-writer

The capability IR (intermediate representation) is a structured inventory of everything the target SDK can do. It is written in markdown with the following sections:

```markdown
# Capability IR: <package-name>

## Authentication
- Methods: [api-key, oauth, bearer, ...]
- Environment variables: [API_KEY_VAR, ...]
- Client initialization pattern: <code snippet>

## Endpoints / Services
| Service | Method | Path / Function | Parameters | Returns |
|---------|--------|-----------------|------------|---------|
| ...     | ...    | ...             | ...        | ...     |

## Tool Interfaces
- Tool creation pattern: <how the SDK defines tools>
- Parameter schemas: <JSON Schema, Zod, plain objects, etc.>
- Tool result handling: <how results flow back>

## Parameter Shapes
- Required vs optional conventions
- Default value handling
- Enum/union type patterns

## Error Types
| Error Class | HTTP Status | Retry-able | Description |
|-------------|-------------|------------|-------------|
| ...         | ...         | ...        | ...         |

## Streaming
- Supported: yes/no
- Pattern: <SSE, WebSocket, async iterator, etc.>
- Event types: [...]

## Models / Resources
- Model selection: <how models are specified>
- Resource types: [messages, completions, embeddings, ...]
```

### `workspace/ast-mapping.md`

**Producer**: ast-mapper
**Consumers**: gap-debate, spec-writer, conformance-checker

A coverage table mapping every exported AST type from `src/parser/ast.ts` to the SDK's capabilities. Each row gets one of four verdicts.

```markdown
# AST Mapping: <package-name>

## Coverage Summary
- NATIVE: N (X%)
- PARTIAL: N (X%)
- CLIENT: N (X%)
- IMPOSSIBLE: N (X%)

## Mapping Table

| AST Type | Verdict | SDK Mapping | Gap Notes |
|----------|---------|-------------|-----------|
| Topology | NATIVE | Direct config object | |
| Agent | NATIVE | SDK client instance | |
| Flow | PARTIAL | Must chain SDK calls | Needs sequencing shim |
| Gate | CLIENT | No SDK concept | Implement as pre/post hook |
| HumanNode | IMPOSSIBLE | No human-in-loop support | Document as extension |
| ... | ... | ... | ... |

## Gaps Requiring Debate
List of all PARTIAL, CLIENT, and IMPOSSIBLE items with initial analysis:

### Gap: Flow (PARTIAL)
- SDK has: individual API calls
- SDK lacks: call chaining / sequencing
- Initial strategy: client-side sequencer
- Confidence: medium

### Gap: Gate (CLIENT)
- SDK has: nothing
- SDK lacks: gate concept entirely
- Initial strategy: pre/post hook wrapper
- Confidence: low — needs debate
```

### `workspace/binding-spec.md`

**Producer**: spec-writer
**Consumers**: code-generator

The deterministic blueprint for code generation. After this document is written, no creative decisions remain -- the code-generator is a mechanical translator.

```markdown
# Binding Spec: <binding-name>

## File Architecture
- Primary file: `src/bindings/<binding-name>.ts`
- Additional files: [if any]

## Exports
- `generate(topology: Topology): GeneratedFile[]`
- Any helper functions

## AST Type Mappings
For each AST type, the exact code pattern to generate:

### Topology -> <SDK pattern>
```typescript
// Template for topology-level generation
```

### Agent -> <SDK pattern>
```typescript
// Template for agent-level generation
```

## Gap Strategies (from debate consensus)
For each non-NATIVE mapping:

### Flow (PARTIAL) -> Client Sequencer
- Strategy: Generate a `runFlow()` helper that chains SDK calls
- Code pattern: <template>
- Extension comment: none needed

### Gate (CLIENT) -> Pre/Post Hook
- Strategy: Generate gate as a validation function called before/after agent
- Code pattern: <template>
- Extension comment: `// @at-extension: gate`

### HumanNode (IMPOSSIBLE) -> Extension Comment Only
- Strategy: Emit extension comment, no runtime code
- Extension comment: `// @at-extension: human-node — not supported by <SDK>`

## Import Map
| From | Import |
|------|--------|
| `../parser/ast` | `Topology, Agent, Flow, ...` |
| `<sdk-package>` | `Client, Message, ...` |

## Scaffold Template
How the binding generates files for a given .at topology:
- File naming convention
- Directory structure
- Entrypoint pattern
```

### `workspace/generated-binding/`

**Producer**: code-generator
**Consumers**: conformance-checker, regression-guard

Directory containing the actual TypeScript binding file(s). The primary output is a single file named `<binding-name>.ts` that follows the interface defined in `src/bindings/types.ts`.

- Must export a `generate(topology: Topology): GeneratedFile[]` function
- Must import all AST types from `../parser/ast`
- Must compile cleanly with `tsc --noEmit`
- Must follow the patterns visible in existing bindings (`src/bindings/claude-code.ts`, etc.)

### `workspace/conformance-report.md`

**Producer**: conformance-checker
**Consumers**: regression-guard, code-generator (on retry)

Results of running every example through the scaffold command with the new binding.

```markdown
# Conformance Report: <binding-name>

## Summary
- Examples tested: N
- Passed: N
- Failed: N
- Warnings: N

## Results

| Example | Status | Files Generated | Notes |
|---------|--------|-----------------|-------|
| data-processing.at | PASS | 3 | |
| research-team.at | PASS | 4 | |
| code-review.at | FAIL | 0 | Missing tool mapping |

## Coverage Matrix Verification

| AST Type | Spec Verdict | Actual Coverage | Match |
|----------|-------------|-----------------|-------|
| Topology | NATIVE | Referenced | YES |
| Agent | NATIVE | Referenced | YES |
| Gate | CLIENT | Missing | NO -- needs fix |

## Failures Detail
For each failure, the exact error output and suggested fix.
```

### `workspace/sdk-diff/`

**Producer**: sdk-differ
**Consumers**: ir-updater, binding-patcher

Directory containing the old and new `.d.ts` snapshots and the structured changeset. Used only in the update path.

```
workspace/sdk-diff/
  old/           # cached .d.ts from previous build
  new/           # .d.ts from updated SDK
  changeset.md   # structured diff with breaking changes, new features, modified signatures
```

### `workspace/ast-mapping-delta.md`

**Producer**: ir-updater
**Consumers**: binding-patcher

A delta document containing ONLY the AST mapping rows that changed between SDK versions. This is NOT a full mapping -- it is a surgical diff that tells the binding-patcher exactly which `generate*()` functions need updating.

```markdown
# AST Mapping Delta: <package> v<old> -> v<new>

## Upgraded (CLIENT-SIDE -> NATIVE/PARTIAL)
| AST Concept | Old Coverage | New Coverage | New SDK Method |

## Migrated (signature changed)
| AST Concept | Old SDK Method | New SDK Method | Breaking? |

## New Mappings
| AST Concept | Coverage | SDK Method |

## Removed Mappings
| AST Concept | Old SDK Method | Replacement |
```

## Domains Cache

### `domains/binding-registry.json`

**Producer**: sdk-installer (on create), sdk-differ (on update check)
**Consumers**: sdk-differ, sdk-installer

A JSON registry of all SDK bindings that have been built or updated by the factory. Each entry tracks the package name, installed version, documentation URLs, and timestamps.

```json
{
  "<binding-name>": {
    "package": "<npm-package>",
    "version": "<installed-version>",
    "docsUrl": "<API docs URL>",
    "changelogUrl": "<GitHub releases URL>",
    "lastBuilt": "<ISO timestamp>",
    "lastChecked": "<ISO timestamp>"
  }
}
```

The registry is read by sdk-differ at the start of the update path to find the package name, current version, and changelog URL for the binding being updated. It is written by sdk-installer at the end of the create path.

### `domains/sdk-types/`

Cached `.d.ts` type declaration files from `npm install`. Organized by package name.

```
domains/sdk-types/
  @anthropic-ai/
    sdk/
      index.d.ts
      resources/
        messages.d.ts
        ...
```

These files are installed once by sdk-installer and read by ast-mapper, spec-writer, and code-generator. On retry loops, the SDK is NOT reinstalled -- the cached types are re-read directly.

### `domains/api-docs/`

Cached WebFetch results, written automatically by the `cache-fetch.sh` PostToolUse hook. Each fetched URL is saved as a markdown file with a sanitized filename.

```
domains/api-docs/
  docs_anthropic_com_en_api_messages.md
  docs_anthropic_com_en_api_errors.md
```

Caching prevents redundant HTTP requests during retry loops. The cache persists across runs, so subsequent invocations for the same SDK skip the fetch entirely.

## Artifact Lineage

The dependency graph between artifacts is strictly forward:

```
CREATE PATH:

SDK Package (input)
  |
  v
[1] capability-ir.md ----+
  |                      |
  v                      |
[2] sdk-types/ (cache)   |
  |                      |
  v                      v
[3] ast-mapping.md ------+-----> [4] binding-spec.md
                                       |
                                       v
                              [5] generated-binding/*.ts
                                       |
                                       v
                              [6] conformance-report.md
                                       |
                                       v
                              [R] binding-registry.json (updated by sdk-installer)

UPDATE PATH:

[R] binding-registry.json (read by sdk-differ)
  |
  v
[U1] sdk-diff/changeset.md ----> [U2] ast-mapping-delta.md
  |                                     |
  v                                     v
[2'] sdk-types/ (updated)        [5'] generated-binding/*.ts (patched)
                                       |
                                       v
                              [6] conformance-report.md (reused stage)
```

No artifact may reference a downstream artifact. The sole exception is the retry loop: artifact [6] feeds back to the code-generator (create path) or binding-patcher (update path) to refine artifact [5].

## Read/Write Rules

| Stage | Reads | Writes |
|-------|-------|--------|
| sdk-installer | (npm registry) | `workspace/capability-ir.md`, `domains/sdk-types/`, `domains/binding-registry.json` |
| ast-mapper | `workspace/capability-ir.md`, `domains/sdk-types/` | `workspace/ast-mapping.md` |
| gap-debate | `workspace/ast-mapping.md` | (consensus passed to spec-writer) |
| spec-writer | `workspace/capability-ir.md`, `workspace/ast-mapping.md`, `domains/sdk-types/` | `workspace/binding-spec.md` |
| code-generator | `workspace/binding-spec.md`, `domains/sdk-types/` | `workspace/generated-binding/` |
| conformance-checker | `workspace/ast-mapping.md`, `workspace/binding-spec.md`, `workspace/generated-binding/` | `workspace/conformance-report.md` |
| regression-guard | `workspace/conformance-report.md`, `workspace/generated-binding/` | (pass/fail verdict) |
| sdk-differ | `domains/sdk-types/`, `domains/binding-registry.json` | `workspace/sdk-diff/`, `domains/sdk-types/` |
| ir-updater | `workspace/sdk-diff/`, `workspace/capability-ir.md` | `workspace/capability-ir.md`, `workspace/ast-mapping-delta.md` |
| binding-patcher | `workspace/sdk-diff/`, `workspace/ast-mapping-delta.md` | `workspace/generated-binding/` |

## Retry Loop Behavior

When a gate fails and the pipeline bounces back to code-generator:

### What gets re-read (not regenerated)
- `workspace/binding-spec.md` -- the spec is stable, the code-generator re-reads it
- `domains/sdk-types/` -- the SDK types are cached, no reinstall
- `workspace/capability-ir.md` -- unchanged, re-read if needed for context

### What gets regenerated
- `workspace/generated-binding/*.ts` -- the code-generator overwrites the binding with fixes
- `workspace/conformance-report.md` -- the conformance-checker re-runs and overwrites

### What is NEW input on retry
- The gate failure output (tsc errors, missing AST references, scaffold failures)
- The conformance report (if bouncing from conformance-checker)
- The test failure output (if bouncing from regression-guard)

The code-generator receives these as additional context alongside the original spec, allowing it to make targeted fixes rather than regenerating from scratch.
