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
| G12 | A second scaffold of an imported project changes nothing | e2e/roundtrip.test.ts |
| G13 | An agent's `extensions` never leak into project-wide settings (only a topology-level `extensions` block is top-level) | e2e/roundtrip.test.ts |
| G14 | An imported hook and its compiled form (`$CLAUDE_PROJECT_DIR`) merge as one hook, not two | e2e/roundtrip.test.ts |
| G15 | V97 refuses a `file:` outside the project | e2e/roundtrip.test.ts |
| G16 | Scaffold names every hand-written `file:` the project lacks | e2e/roundtrip.test.ts |
| G17 | V11 does not demand a flow path for an on-demand (`invocation: manual`) agent | e2e/roundtrip.test.ts |
| R1 | Import then scaffold keeps every hand-built file (was: 37 of 72 missing) | e2e/roundtrip.test.ts |
| R2 | Import then scaffold leaves every hand-built file byte-identical, settings.json included (was: 2,957 lines cut to 1,706) | e2e/roundtrip.test.ts |
| R3 | The imported .at validates with no errors (was: 22) | e2e/roundtrip.test.ts |
| R4 | Import keeps frontmatter the language has no field for, comma-string lists, and the real `permissions` block | e2e/roundtrip.test.ts |
| A4 | Agents, groups, skills and commands found on disk are imported with `file:` and never generated | e2e/roundtrip.test.ts |
| F3 | `--allow-invalid` compiles despite validation errors; `--force` only overwrites kept files | e2e/roundtrip.test.ts |
| C5 | A hook's own script is created only when missing: never overwritten (even with `--force`), reported or claimed | e2e/roundtrip.test.ts |
| L2 | Real Claude Code loads a hand-built project after import then scaffold | live/claude-code.live.test.ts |
| L1 | Real Claude Code loads every scaffolded example: every agent, skill and command registers, and the session succeeds | live/claude-code.live.test.ts |

## Open findings (not yet guaranteed)

Each is an `it.todo` with the same id. When one is fixed, its todo becomes a
real test and the row moves to Guarantees. Source: the compile audit,
2026-10-28/29 (plan page and `.history/2026-10-28-content-harness-gaps.md`).

| Id | Finding | Phase |
|---|---|---|
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
| C1 | `scaffold --dry-run` says settings.json and .mcp.json would be "config merged" but does not show the diff (content session, 2026-10-29) | 3 |
| C2 | Scaffold adds `.claude/CLAUDE.md`, which competes with a project's root CLAUDE.md (content session, 2026-10-29) | 3 |
| C3 | Run-line parsing takes placeholders and file arguments as scripts (`SLUG`, `frames-critic.json`) and plans stubs for them (content session, 2026-10-29) | 3 |
| C4 | A gate whose `after:` is an action or a human compiles to no enforceable hook (10 gates in content-harness) | 3 |
| B5 | An agent's permissions read as per-agent grants; Claude Code allow rules are session-wide | 4 |
| F1 | Missing first-class fields: agent effort, initialPrompt, omitClaudeMd, cache TTL, color; skill when_to_use, arguments, paths, shell | 4 |
| F2 | Hooks as a typed union (http, mcp_tool, agent; once, async, if) | 4 |
