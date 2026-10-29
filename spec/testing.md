# Testing spec: what the suite proves

Every guarantee has an id. A test carries that id in its name (`[G3] ...`), and
`src/__tests__/spec-testing-sync.test.ts` fails when an id here has no test, or
a test names an id that isn't here. Open findings are listed as `it.todo` in
`src/__tests__/open-findings.test.ts`, so the suite shows what is not yet
guaranteed instead of hiding it.

## How to run

| Suite | Command | Needs |
|---|---|---|
| Everything offline (unit, CLI, e2e) | `npx vitest run` | nothing; the build runs first (vitest globalSetup), so tests never see a stale `dist/` |
| Live Claude Code | `AT_LIVE=1 npx vitest run src/__tests__/live` | the `claude` CLI; one small haiku call per project; `AT_CLAUDE_BIN` overrides the binary |

Run the live suite before every release, and after any change to a binding.

## Guarantees

| Id | Guarantee | Where |
|---|---|---|
| G1 | The first scaffold keeps a file it did not create (conflict, kept unless `--force`) | e2e/scaffold-owns.test.ts |
| G2 | Scaffold never writes or deletes through a symlink, even with `--force` | e2e/scaffold-owns.test.ts |
| G3 | Re-scaffolding keeps the user's hooks, `ask`, `defaultMode` and other permission keys | e2e/scaffold-owns.test.ts |
| G4 | A second scaffold with no changes writes nothing | e2e/scaffold-owns.test.ts |
| G5 | `--dry-run` writes nothing | e2e/scaffold-owns.test.ts |
| G6 | Prose in a gate's `run` fails validate (V96) and scaffold, and nothing is written | e2e/scaffold-owns.test.ts |
| G7 | An edited file that scaffold owns is kept on the next run | e2e/scaffold-owns.test.ts |
| G8 | `--prune` removes untouched leftovers and keeps edited ones | e2e/scaffold-owns.test.ts |
| G9 | Two topologies in one project keep separate manifests | e2e/scaffold-owns.test.ts |
| G10 | No `${…}` reference or `#`-key reaches settings `env` (Claude Code applies env literally) | e2e/scaffold-owns.test.ts |
| G11 | An unsafe generated path aborts the run before any file is written | scaffold/__tests__/safety.test.ts |
| L1 | Real Claude Code loads every scaffolded example: every agent, skill and command registers, and the session succeeds | live/claude-code.live.test.ts |

## Open findings (not yet guaranteed)

Each is an `it.todo` with the same id. When one is fixed, its todo becomes a
real test and the row moves to Guarantees. Source: the compile audit,
2026-10-28/29 (plan page and `.history/2026-10-28-content-harness-gaps.md`).

| Id | Finding | Phase |
|---|---|---|
| R1 | Import then scaffold loses files: 37 of 72 hand-built files missing (all commands, real scripts) | 2 |
| R2 | Import then scaffold cuts bodies: 2,957 lines became 1,706 | 2 |
| R3 | Import emits an .at with validation errors (22 on this repo) | 2 |
| R4 | Import drops unknown skill frontmatter keys | 2 |
| A4 | Skills that already exist need an `external` mark: referenced, never generated | 2 |
| N11 | sync pulls generated prose back into the .at, so the prompt grows each cycle | 2 |
| N12 | A skill `prompt: "path"` emits `See: path`; the instructions never reach Claude | 2 |
| A3 | `kind: external` actions ignore `commands:` and emit a TODO stub | 3 |
| A3b | Tools with a real `script:` get stub copies | 3 |
| B4 | Schedule scripts call the wrong action path; `every:` becomes a commented-out cron line | 3 |
| H1 | Human nodes compile to frontmatter-less AGENT.md files that Claude Code ignores; they should be an approval step | 3 |
| N4 | `.mcp.json` drops `type`, so a url server is skipped | 3 |
| N5 | `type: prompt` hooks are emitted as commands | 3 |
| N6 | Universal events (AgentStop, ToolUse, Error) are emitted unmapped, so the hook never fires | 3 |
| N7 | MCP tool names: whole-server and dotted names mis-converted; permissions not converted | 3 |
| N8 | V27 accepts `confirm` and `bypass`, emitted as invalid `permissionMode` | 3 |
| N9 | A hook matcher with a regex breaks the agent file's YAML | 3 |
| N10 | `invocation: manual` drops the description, so the agent is not registered | 3 |
| N14 | `settings.ask` is parsed but never emitted | 3 |
| N16 | Model ids are not checked per target | 3 |
| N17 | Unquoted YAML scalars change type (`yes` becomes `true`) | 3 |
| N18 | No reference checks for `skills:`, `mcp-servers:`, skill `agent:` | 3 |
| N19 | Hook stubs carry the date, so output is not byte-stable | 3 |
| B5 | An agent's permissions read as per-agent grants; Claude Code allow rules are session-wide | 4 |
| F1 | Missing first-class fields: agent effort, initialPrompt, omitClaudeMd, cache TTL, color; skill when_to_use, arguments, paths, shell | 4 |
| F2 | Hooks as a typed union (http, mcp_tool, agent; once, async, if) | 4 |
| F3 | `--force` means both "compile despite errors" and "overwrite kept files" | 2 |
