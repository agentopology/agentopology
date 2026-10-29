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
| C1 | `scaffold --dry-run` lists, key by key, what a config merge would add or change in settings.json and .mcp.json | e2e/scaffold-owns.test.ts |
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
| N4 | A url MCP server gets `type: http` (Claude Code skipped it) | e2e/compile.test.ts |
| N5 | A `type: prompt` hook compiles to a prompt handler, in settings and in agent frontmatter | e2e/compile.test.ts |
| N6 | Universal hook events map to Claude Code events (AgentStop → SubagentStop; Stop inside an agent) | e2e/compile.test.ts |
| N7 | MCP names convert in whole-server, wildcard and dotted forms, in tools and in permission rules | e2e/compile.test.ts |
| N8 | `permissions: confirm` and `bypass` compile to real `permissionMode` values; an unknown value is never emitted | e2e/compile.test.ts |
| N9 | A regex hook matcher stays a valid YAML string in agent frontmatter | e2e/compile.test.ts |
| N10 | A manual agent keeps its description (Claude Code skips an agent without one) | e2e/compile.test.ts |
| N14 | `settings.ask` rules are emitted | e2e/compile.test.ts |
| N17 | A scalar YAML would read as another type (`yes`, `1.0`) is quoted | e2e/compile.test.ts |
| N19 | Scaffold output is byte-stable: no date in any generated file | e2e/compile.test.ts |
| C3 | A `run:` line's script is the word after its interpreter, never an argument; a project script runs in place, from the project root | e2e/compile.test.ts |
| C4 | A gate after an action or a human runs before its next agent launches (PreToolUse on the Agent tool; exit 2 blocks) | e2e/compile.test.ts |
| H1 | A human node compiles to an approval step: Claude Code asks before launching the next agent, and the playbook says to ask; no ignored AGENT.md | e2e/compile.test.ts |
| L4 | Real Claude Code blocks launching an agent when its gate fails, and stops at its approval step when the gate passes | live/claude-code.live.test.ts |
| C2 | The topology context is written to `.claude/rules/<topology>.md`, never a CLAUDE.md, so it never competes with the project's own | e2e/compile.test.ts |
| L5 | Real Claude Code loads the topology context from `.claude/rules/<topology>.md` | live/claude-code.live.test.ts |
| N12 | A skill's instructions reach the model: a `prompt { }` block is the SKILL.md body; `prompt: "path"` tells Claude to read and follow the file | e2e/compile.test.ts |
| A3 | An action's `commands:` are emitted whatever its kind; a non-inline action without commands is a marked stub that fails | e2e/compile.test.ts |
| A3b | A tool's stub goes where its `script:` points (create-only for a project path), never a copy beside it | e2e/compile.test.ts |
| B4 | A schedule runs headless from the project root, calls the real action path, and `every:` converts to cron (or warns) | e2e/compile.test.ts |
| N21 | A `gate`, `hook`, `tool`, `job`, `command` or `level` outside its container block is a V98 error, never dropped silently | e2e/compile.test.ts |
| N18 | An agent's `skills:`/`mcp-servers:` or a skill's `agent:` naming nothing declared is a V99 warning | e2e/compile.test.ts |
| L2 | Real Claude Code loads a hand-built project after import then scaffold | live/claude-code.live.test.ts |
| L3 | Real Claude Code registers a manual agent and an agent with a regex matcher, and runs a prompt hook | live/claude-code.live.test.ts |
| L1 | Real Claude Code loads every scaffolded example: every agent, skill and command registers, and the session succeeds | live/claude-code.live.test.ts |

## Open findings (not yet guaranteed)

Each is an `it.todo` with the same id. When one is fixed, its todo becomes a
real test and the row moves to Guarantees. Source: the compile audit,
2026-10-28/29 (plan page and `.history/2026-10-28-content-harness-gaps.md`).

| Id | Finding | Phase |
|---|---|---|
| N11 | sync pulls generated prose back into the .at, so the prompt grows each cycle | 2 |
| N16 | Model ids are not checked per target | 3 |
| B5 | An agent's permissions read as per-agent grants; Claude Code allow rules are session-wide | 4 |
| F1 | Missing first-class fields: agent effort, initialPrompt, omitClaudeMd, cache TTL, color; skill when_to_use, arguments, paths, shell | 4 |
| F2 | Hooks as a typed union (http, mcp_tool, agent; once, async, if) | 4 |
