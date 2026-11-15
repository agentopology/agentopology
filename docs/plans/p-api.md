# P-API: a stable programmatic API, import robustness, and `--json` findings

## Premise check (main @9a69e87, grep)
- Every name below already exists as an exported function, const or type, except
  `parseFrontmatter` and `asList` (not exported from `src/import/claude-code.ts`: they become exported).
- `checkHooks` and `NO_MATCHER_EVENTS` exist twice (conformance/claude-code.ts, conformance/codex.ts).
  The API exports `checkClaudeHooks`, `checkCodexHooks`, and the Claude Code `NO_MATCHER_EVENTS`.
- `validateResult` lives in `src/visualizer/facts.ts`; it is re-exported from there (no move).
- A `.claude/settings.json` that is not JSON makes `importClaudeCode` throw (`JSON.parse` in `parseSettingsJson`).
- `validate x.at --json` today reads `--json` as a second .at file and fails "file not found".

## 1. `agentopology/api`
`src/api.ts` -> `dist/api.js`, package.json `exports["./api"]` (import + types). Re-exports only:
parse, validate, validateResult, checkClaudeHooks, checkCodexHooks, onFailureWarnings, NO_MATCHER_EVENTS,
checkGuards, checkCodexGuards, collectInventory, coverage, importClaudeCodeWithReport, readClaudeProject,
parseFrontmatter, asList, runParts, isStubContent; types TopologyAST, ValidationResult, GuardReport,
GuardItem, InventoryItem, CoverageReport, FlowReport, ClaudeProject, PlatformFile. No behaviour change.
`src/__tests__/api-surface.test.ts` pins the sorted runtime names and the type names, and `exports["./api"]`.

## 2. Import robustness
A settings.json that does not parse: the import goes on without settings and hooks (agents, skills,
commands, .mcp.json still imported) and the flow report carries one warning
`settings.invalid-json: <file> line <n>: <parser message>; settings and hooks not imported`
(`line <n>` only when the parser message gives it). Red first.

## 3. `--json` on `validate` and `guard --check`
One JSON document on stdout, nothing else on stdout:
`{version: 1, command: "validate"|"guard --check", target?, findings: [{id, severity, message, file, line, source}], exitCode}`.
- validate: one finding per validation result (id = rule, severity = level) plus the Claude Code
  onFailure warning; with `--inventory`, one error per missing pointer. Several files: all in one document.
  A parse error, a missing file or an unknown target is one error finding (`parse`, `file.not-found`, `cli.unknown-target`).
- guard --check: one finding per graded item; `error` when it counts toward `missing`, else `info`;
  one `info` per hook not tied to a step.
- Exit codes unchanged: validate 1 on any error, parse error, missing file, unknown target or missing
  coverage pointer, else 0; guard --check 1 when `missing > 0` or the target is unsupported, else 0.
  `exitCode` in the document equals the process exit code.
- `spec/findings-output.schema.json` (JSON Schema draft 2020-12). A test runs both commands over every
  `examples/*.at` and checks each document against the schema with a small in-test validator (no dependency).
- Without `--json`, output is byte-identical: no existing text pin moves.

## Out of scope
No new command, no loading of outside code, no version bump, no release.

## API-ADD: scaffolding and the Codex config check
- Adds `claudeCodeBinding`, `codexBinding` (already exported from the package root) and types `BindingTarget`, `GeneratedFile`.
  No `scaffold(ast, target)` helper exists in the source, so none is added: call `binding.scaffold(ast)`.
- Adds `checkConfigAgainstSchema` (src/conformance/surface.ts) and types `SchemaMismatch`, `KnownDrift`.
  No function loads `spec/codex/config.schema.json` today; the file ships in the package (`files: spec`), and the caller reads it.
- surface.ts imports `smol-toml` at load, so `smol-toml` moves from devDependencies to dependencies (own commit),
  proven by installing the packed tarball with `--omit=dev` and importing `agentopology/api`.
- The pinned name list in api-surface.test.ts grows by these 7 names. No behaviour change.
