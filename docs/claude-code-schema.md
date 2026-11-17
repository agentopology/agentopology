# The Claude Code schema: one row per key the binding may write

The claude-code binding writes four kinds of structure: agent frontmatter
(`.claude/agents/<name>/AGENT.md`), skill frontmatter (`SKILL.md`), command
frontmatter (`.claude/commands/<name>.md`), `.claude/settings.json` and
`.mcp.json`. Claude Code ignores a key it does not know, silently, so a key
written at the wrong level or under the wrong name looks configured and does
nothing. The schema is the list of keys Claude Code documents, and the binding
writes nothing that is not on it.

## Shape

`src/bindings/claude-code-schema.ts` holds one row per key:

| Field | Meaning |
|---|---|
| `surface` | `agent`, `skill`, `command`, `settings` or `mcp-server` |
| `key` | the key as Claude Code spells it; a settings key is its dotted path (`permissions.defaultMode`, `sandbox.enabled`) |
| `type` | `string`, `boolean`, `number`, `list` (a string list), `enum`, `object`, `hooks` |
| `values` | the allowed values of an `enum` |
| `doc` | the Claude Code page that defines it |
| `verifiedOn` | the Claude Code version a live run checked it on, or `docs <date>` when only the page was read |
| `enforcement` | what Claude Code does with it, measured where a probe ran: `refuses` (it blocks a call), `grants` (it allows a call), `steers` (the model reads it), `none` (a probe saw no effect), `unknown` (not measured yet) |
| `enforcedWhen` | the conditions the enforcement value holds under, when a probe found it depends on them: `path` (`subagent` or `session-agent`) and `afterTrust` (nothing happens until the folder is trusted) |
| `note` | what the probe saw, when the value alone would mislead (agent `maxTurns` refuses for a subagent, not for a session agent) |
| `projectFile` | settings only: whether a project's `.claude/settings.json` may set it (some keys are read from user or managed settings only) |

The settings rows are generated from the settings reference page
(`src/bindings/claude-code-settings-keys.ts`, do not edit by hand). The
frontmatter and `.mcp.json` rows are written by hand: those pages give no
per-key type line to read.

## Two layers

1. **One-to-one keys.** An `.at` construct that is a Claude Code key by another
   name: `tools` → `tools`, `max-turns` → `maxTurns`, `thinking` → `effort`,
   `settings { deny }` → `permissions.deny`. And the escape hatch:
   `extensions { claude-code { key: value } }` on the topology (settings),
   an agent (agent frontmatter) or a skill (skill frontmatter). An extension
   key is looked up in the schema for its surface, written at its documented
   path with its documented type (`defaultMode: plan` on the topology lands
   at `permissions.defaultMode`; `additionalDirectories: ["../shared"]` lands
   as a JSON list), and a key the schema does not have is not written, with a
   validation warning that names the nearest known key.
2. **Composed abstractions.** An `.at` construct with no key of its own must
   compile onto one-to-one keys or be reported. `settings { sandbox: true }`
   compiles to `sandbox.enabled: true`; `settings { fallback-chain }` to
   `fallbackModel`. An agent's `sandbox` and `fallback-chain` have no
   per-agent key in Claude Code: they are not written, and validation says so.

## How the binding consults it

Every frontmatter block goes through one writer that takes the surface and
throws on a key with no row, and every settings key the binding builds is
checked the same way. A test scaffolds every example and the kitchen-sink
topology and fails on any written key the schema does not hold, so a new
field cannot reach a file without a row.

Validation rule V130 is the user-facing side: what an `.at` states that the
target cannot place (an unknown extension key, a value of the wrong type or
outside the allowed values, a settings key a project file may not set, a
first-class field with no Claude Code key) is not written, and validation
warns. It is a warning, not an error, so a file that validated before still
does. Nothing is dropped without a warning.

## Absorbing a Claude Code update

1. `node scripts/claude-code-schema-drift.mjs` (after `npm run build`) reads
   the sub-agents, skills and settings reference pages and prints the keys
   added, removed or retyped since the committed rows. It exits 1 on drift.
2. `--write` regenerates the settings rows; frontmatter rows are edited by hand
   from the printed list.
3. `npx vitest run` then says which generated output or validation message
   moved.

A probe that measures a key's enforcement changes that row's `enforcement`
and `verifiedOn`, nothing else.
