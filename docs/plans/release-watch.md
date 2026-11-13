# The release watch: build spec (RW-1..RW-8, RW-11, RW-12, RW-13)

Claude Code and Codex ship new versions almost every day, and each one can change something AgenTopology generates: a hook event, a handler field, a frontmatter key, a config value, a CLI flag. The release watch notices those changes. It reads each new version's npm registry entry, release notes, docs pages and (for Codex) config schema. It maps each change to what AgenTopology generates through a per-platform **surface map**, proves the change with the **conformance suite** on the new binary, and turns a matched breaking change into a **red planted test** that a fix must turn green.

Nothing in the watch merges, tags or publishes. A release stays a maintainer's decision, outside this spec.

Release notes are a hint, never the proof. One Claude Code version in a 30-day window had no notes at all. The proof is the new binary under the conformance suite, plus the docs diff.

**MEASURED** = read or run on 2026-11-13 (source named). **INFERRED** = reasoned, not tested.

## Base and branch rules

- Base: `origin/feat/icx2-candidate`. Branch from it. Never push to main, never tag, never publish.
- The base already contains the Codex fixes CX-4: the binding no longer writes `untrusted`, `max_threads` or `max_depth`. VERIFIED_ON is already 2.1.323 on the base.
- So a done-when below that expects those Codex values (or the old VERIFIED_ON) to show up as red must be adapted. Keep the mechanism (a `knownDrift` entry carrying a ticket id, and a failing test for any mismatch not in `knownDrift`). Plant the mismatch in a temp fixture (a hand-written `config.toml`, or a copy of the binding output edited in a temp dir) instead of expecting the real binding to produce it.
- Every done-when is a planted test: committed first and failing, then passing.
- Test names start with the ticket id in brackets, for example `it("[RW-3] skips 2.1.320, which was never published", ...)`.
- Line numbers below (`src/bindings/claude-code.ts:612` and the like) were measured on 0.10.1 main (commit 151789e). They may have moved on the base. Find the code by content, not by line.
- `src/bindings/codex.ts` is not touched by any RW ticket. Codex binding fixes are CX tickets.

## 1. Sources, measured on 2026-11-13

### Claude Code

| Source | What it gives | Measured | Role |
|---|---|---|---|
| npm registry, `https://registry.npmjs.org/@anthropic-ai/claude-code` | dist-tags and a publish time per version | `latest` 2.1.323, `next` 2.1.323, `stable` 2.1.311. 565 versions. 23 versions in the last 30 days, on 19 different days. Numbers skip: no 2.1.313, no 2.1.320 | The cheap first check |
| `CHANGELOG.md` in `github.com/anthropics/claude-code` (raw file) | one `## x.y.z` section per version, one bullet per change | 440 sections, 1.2 MB. The last 30 days hold 1,693 bullet lines. 2.1.323 alone has 294. Three versions have 1 line | The notes the reader reads |
| GitHub releases (`api.github.com/repos/anthropics/claude-code/releases`, `releases.atom`) | the same text as a release body | v2.1.323 released 22:12 UTC, npm publish 20:29 UTC (1 h 43 min later). v2.1.319: npm 6 Nov 00:58, release 6 Nov 17:04 (16 h later) | When the notes landed. Not a second source of content |
| Docs changelog, `code.claude.com/docs/en/changelog.md` | the same notes, grouped | The page says it "is generated from the CHANGELOG.md on GitHub" | A mirror. Not used |
| Docs pages: `hooks.md`, `settings.md`, `permission-modes.md`, `permissions.md`, `sub-agents.md`, `skills.md`, `mcp.md`, `cli-reference.md`, `cross-session-messaging.md`, `sessions.md`, `routines.md` (under `code.claude.com/docs/en/`) | the contract itself | All listed in `code.claude.com/docs/llms.txt` (239 pages). AT snapshots one today: `spec/claude-code/hooks-contract.json` from `hooks.md` (`scripts/claude-code-drift.mjs`) | The contract diff (shape changes) |
| SchemaStore, `json.schemastore.org/claude-code-settings.json` | a settings JSON schema | 142 keys, 31 hook events against the docs' 33. `spec/claude-code/README.md` already rejects it as lagging | Side signal only. It lists permission modes `manual` and `delegate`, which the binding does not know |
| The binary: `claude --version`, `claude --help` | what really shipped | 2.1.323 | The proof (the conformance suite runs against it) |

### Codex

| Source | What it gives | Measured | Role |
|---|---|---|---|
| npm registry, `https://registry.npmjs.org/@openai/codex` | dist-tags and times | `latest` 0.168.0, `alpha` 0.171.0-alpha.1. 5,891 versions, because every platform build is its own version (`0.168.0-darwin-arm64`). 427 publishes in 30 days, 8 of them plain stable versions | The cheap first check, on `latest` only. A filter that drops prerelease and platform-suffixed versions is required |
| GitHub releases, `api.github.com/repos/openai/codex/releases` | tag `rust-vX.Y.Z`, a body with sections | Stable bodies have "New Features", "Bug Fixes", "Documentation", "Chores" and a PR list (0.168.0: 19,857 characters). Alpha bodies are 25 characters, so empty. Patch bodies are short (0.167.1: 105 characters) | The notes the reader reads |
| `CHANGELOG.md` in `github.com/openai/codex` | a pointer | 330 bytes: "The changelog can be found on the releases page" | Not used |
| Docs changelog, `developers.openai.com/codex/changelog` | a web page | Redirects to `learn.chatgpt.com/docs/changelog`, 4.9 MB of HTML | Not used: too heavy, not the first source |
| `codex-rs/core/config.schema.json` in the repo | the whole `config.toml` as a JSON schema | 274 KB, 103 top-level keys, 215 definitions. Hook events: 14. `sandbox_mode`: `read-only`, `workspace-write`, `danger-full-access`. `approval_policy`: `on-request`, `granular`, `never` | The contract diff. Codex gives a machine-readable contract; Claude Code does not |
| The binary: `codex --version` | what shipped | 0.156.1 on the measuring machine, 12 minor versions behind `latest` | The proof, once the Codex binding has a suite |

### What the measurements imply

| Finding | Evidence | Consequence |
|---|---|---|
| Claude Code moves almost every day | 23 versions on 19 of 30 days; 1,693 note lines | The reader must be a script. Only the few lines it cannot place need a judgment |
| Most lines do not touch AT | A loose keyword match hits 943 of 1,693 lines. A match on exact tokens (`PreToolUse`, `onFailure`, `permissionMode`, `SendMessage`, `.mcp.json`, and so on) hits 219. Of those, 57 start with Added or Changed | The map holds exact tokens. About 7 lines a day reach a verdict, about 2 a day can become work |
| Notes are incomplete and late | 2.1.315 is on npm with no changelog section. The 2.1.323 notes document a variable "available since 2.1.318". Notes trail npm by up to 16 hours | The suite and the docs diff run on every new version, notes or not. Old sections are re-hashed to catch late lines (RW-13) |
| The Codex binding had drifted (fixed on the base by CX-4) | 0.10.1 wrote `max_threads`; the schema has `max_concurrent_threads_per_session` and no `max_threads`. It passed `untrusted` and `on-failure` through and mapped "supervised" to `untrusted`; the schema lists neither | The Codex map has a `knownDrift` list. RW-2 proves the mechanism on a planted fixture |
| Codex has hooks; the Codex binding writes none | 14 events, among them `PreToolUse`, `PermissionRequest`, `SubagentStart`, `UserPromptSubmit` (`HooksToml` in the schema). The binding writes TODO stubs under `.codex/scripts/` | The first reverse card (LG-1): guards could compile to Codex hooks |

## 2. The parts

```
 tick           reader           proof                 run file
 npm tags  -->  notes lookup -->  docs/schema diff  -->  one JSON per
 (RW-3)         against the map   + conformance suite    platform+version
                (RW-4, RW-13)     (RW-5, RW-6, RW-7)     (RW-8)
                     |
                     +--> gap cards for features AT cannot say (RW-12)
 red-green gate (RW-11): proves a planted test was red before its fix
```

### 2.1 The tick (RW-3)

- One GET per platform to the npm registry. Compare `dist-tags.latest` with the last version seen.
- Walk the registry's `time` list to collect every version published since the last one seen. Versions skip numbers and several arrive a day, so "+1" is wrong.
- Claude Code: `latest` is the trigger; `stable` is recorded. Codex: `latest` only; drop prerelease (`-alpha.N`) and platform-suffixed (`-darwin-arm64`) versions.
- Exit 0 on no change, 10 on new versions.

### 2.2 The reader: a lookup against a map

**The map file.** One per platform, public, in AT: `spec/surface/claude-code.surface.json` and `spec/surface/codex.surface.json`. It lists everything on the platform that AT writes or relies on. A test holds the map to the binding: scaffold the fixtures, collect every hook event, handler field, frontmatter key, settings key, file path and flag in the output, and fail on any that has no entry. So the map cannot rot.

```json
{
  "platform": "claude-code",
  "areas": ["hooks.events", "hooks.handler", "hooks.payload", "settings", "permissions.modes",
            "permissions.rules", "agents.file", "sessions", "subagents", "skills", "mcp",
            "cli", "env", "instructions", "plugins", "schedules"],
  "entries": [
    {
      "id": "cc.hooks.handler.onFailure",
      "area": "hooks.handler",
      "tokens": ["onFailure"],
      "contract": { "doc": "https://code.claude.com/docs/en/hooks.md",
                    "snapshot": "spec/claude-code/hooks-contract.json#/fields" },
      "usedBy": ["src/bindings/claude-code.ts", "src/conformance/claude-code.ts"],
      "language": ["guard", "gate", "strength: refuse"],
      "proof": "src/__tests__/e2e/fail-closed.test.ts",
      "ifBroken": "a guard that errors stops blocking",
      "grade": "refuse"
    }
  ],
  "areaWords": { "hooks.events": ["hook", "hooks"], "permissions.modes": ["permission mode", "auto mode"] },
  "ignore": [ { "pattern": "^Remote Control:", "why": "AT writes nothing for it" } ],
  "watchOnly": [ { "id": "cc.new.code-mode", "tokens": ["Code Mode"], "card": "LG-3" } ],
  "knownDrift": []
}
```

**Entry ids.** `<platform>.<area>.<name>`, with platform prefix `cc` (Claude Code) or `cx` (Codex). Ids referenced by the tickets and examples: `cc.hooks.event.PreToolUse`, `cc.hooks.handler.onFailure`, `cc.hooks.handler.exit2`, `cc.hooks.payload.subagent_type`, `cc.permissions.modes.auto`, `cc.new.code-mode` (watchOnly). `knownDrift` items carry `{ "id", "value", "ticket", "why" }`, where `ticket` is a binding ticket id (a CX id for Codex).

**The dependency surface, Claude Code.** Counts are occurrences in `src/bindings/claude-code.ts`, `src/bindings/lib`, `src/guard` and `src/conformance` on 0.10.1 (MEASURED by grep).

| Area | What AT relies on | Where in AT | Contract source | Snapshot today |
|---|---|---|---|---|
| hooks.events | 33 events known; the binding writes `PreToolUse` (47), `SubagentStop` (31), `PostToolUse` (17), `Stop` (9), `UserPromptSubmit` (6), `SubagentStart` (5), `TeammateIdle`, `TaskCompleted`, `SessionStart`, `SessionEnd`, `PreCompact`, `Notification` | `src/conformance/claude-code.ts` | `hooks.md` | Yes |
| hooks.handler | types `command`, `http`, `mcp_tool`, `prompt`, `agent`; `matcher`; `onFailure`; exit code 2 blocks; events with no matcher | `src/conformance/claude-code.ts` | `hooks.md` | Yes |
| hooks.payload | stdin fields `tool_input.command`, `tool_input.subagent_type`, `tool_name`, `agent_type`, `session_id`, `transcript_path`; SendMessage target as `to` and `recipient`; stdout `hookSpecificOutput.permissionDecision` | `src/bindings/claude-code.ts` | `hooks.md`; a live session check on 13 Nov 2026 | Partly |
| settings | `.claude/settings.json` keys `hooks`, `permissions`, `env` | `src/bindings/claude-code.ts` (24 mentions) | `settings.md` | No |
| permissions.modes | `plan`, `default`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`; which modes ignore an agent's own mode | `src/bindings/claude-code.ts` | `permission-modes.md` | No |
| agents.file | `.claude/agents/<id>/AGENT.md`; frontmatter `maxTurns`, `disallowedTools`, `mcpServers`, `background`, `permissionMode`, `initialPrompt`, `isolation` | `src/bindings/claude-code.ts` | `sub-agents.md` | No |
| sessions | `claude --agent <id> -n <id>`; `SendMessage`; `ListAgents`; a message from another session fires `UserPromptSubmit` | `src/bindings/lib/session.ts`; `SESSION_HOOKS_PROVEN` in `src/conformance/claude-code.ts` (both false) | `cross-session-messaging.md`, `sessions.md`, `cli-reference.md` | No |
| subagents | matcher `Agent\|Task`; `subagent_type` | `src/guard/check.ts` | `sub-agents.md`, `tools-reference.md` | No |
| skills | `.claude/skills/<name>/SKILL.md`; frontmatter `disallowed-tools` | `src/bindings/claude-code.ts` | `skills.md` | No |
| mcp | `.mcp.json` `mcpServers`; tool names `mcp__server__tool`; matcher rules | `src/bindings/claude-code.ts` | `mcp.md`, `hooks.md` | Partly (matcher) |
| cli | `claude -p ... --agent`; `claude --version`; `--permission-mode` | `src/bindings/claude-code.ts`; `src/conformance/claude-code.ts` | `cli-reference.md`, `claude --help` | No |
| env | `CLAUDE_PROJECT_DIR` in every generated guard | `src/bindings/claude-code.ts` | `hooks.md`, `env-vars.md` | No |
| instructions | `CLAUDE.md`, `.claude/rules` | binding (8 and 3 mentions) | `memory.md` | No |
| plugins | `.claude-plugin/plugin.json`; `type: mod` hooks | `src/bindings/index.ts` | `plugins-reference.md` | No |
| schedules | crontab fragments | binding (8 mentions) | `routines.md`, `scheduled-tasks.md` | No |

**The dependency surface, Codex.** As measured on 0.10.1; the base has the CX-4 fixes, so re-collect from the base's output.

| Area | What AT relies on | Where in AT | Contract source |
|---|---|---|---|
| config.keys | `.codex/config.toml`: `approval_policy`, `sandbox_mode`, `model_reasoning_effort`, `developer_instructions`, `mcp_servers`, `history` | `src/bindings/codex.ts` | `config.schema.json` |
| approvals | 0.10.1: `untrusted`, `on-request`, `on-failure`, `never` (base: no `untrusted`) | `src/bindings/codex.ts` | `AskForApproval` in the schema |
| sandbox | `read-only`, `workspace-write`, `danger-full-access` | `src/bindings/codex.ts` | `SandboxMode` (matches) |
| agents | 0.10.1: `[agents]` with `max_threads`, `max_depth` (base: neither); `[agents.<id>]` with `description`, `config_file`; `.codex/agents/<id>.toml` | `src/bindings/codex.ts` | `AgentsToml`, `AgentRoleToml` |
| instructions | `AGENTS.md` | `src/bindings/codex.ts` (10 mentions) | schema keys `project_doc_fallback_filenames`, `project_doc_max_bytes` |
| skills | `.codex/skills/<id>.md` | `src/bindings/codex.ts` | schema key `skills` ("keyed by SKILL.md path"). INFERRED: the path AT writes is not where Codex looks |
| hooks | nothing written; TODO stubs only | `src/bindings/codex.ts` | `HooksToml` (14 events) |
| permissions | not used | none | schema keys `permissions`, `default_permissions` (named profiles) |
| features | not used | none | `features.*`; 0.168.0 notes: `features.multi_agent` now points to `agents.enabled` |

**The verdicts.** The script gives each note line exactly one.

| Verdict | Rule (all by script) | What happens next |
|---|---|---|
| `hit-breaking` | a token of a map entry, and the line starts with Changed, Removed, Deprecated or Renamed, or contains "no longer" or "now requires" | a ticket and a red planted test (2.3) |
| `hit-fix` | a token of a map entry, and the line starts with Fixed | the entry's proof test is re-run on the new version; a ticket only if it is red |
| `hit-added` | a token of a map entry, and the line starts with Added | checked for a new name inside a known area (a new event, field or mode): if so, a gap card (2.4) |
| `new-surface` | no entry token, but an `areaWords` word | the only verdict that needs a judgment: gap card, new map token, or ignore with a written reason |
| `ignore` | none of the above, or an `ignore` pattern | counted, not listed |
| `notes-missing` | a version on npm with no notes section | retried on the next 3 ticks, then recorded as a silent release; the proof still runs |

Every judgment on a `new-surface` line is stored next to the line in the run file. An `ignore` chosen for a `new-surface` line is listed, never dropped.

**Labeled examples from the real notes** (MEASURED lines; the verdicts are what the rules give):

| Version | Line (shortened) | Verdict | Entry |
|---|---|---|---|
| 2.1.316 | "Fixed PowerShell hooks not blocking on exit code 2 when the command begins with a type cast..." | `hit-fix` | `cc.hooks.handler.exit2` |
| 2.1.317 | "Added `onFailure: "block"` for Agent SDK hook callbacks..." | `hit-added` | `cc.hooks.handler.onFailure` |
| 2.1.302 | "Changed fork subagents (`subagent_type: "fork"`) to be on by default in `claude -p`..." | `hit-breaking` | `cc.hooks.payload.subagent_type` (the spawn guard reads this field) |
| 2.1.323 | "Fixed `--permission-mode auto` or a settings `defaultMode: auto` starting in a mode that could allow more..." | `hit-fix` | `cc.permissions.modes.auto` |
| 2.1.323 | "Added Code Mode, an experimental opt-in in which Claude writes JavaScript to call its tools" | `new-surface` | none: a gap candidate (do `PreToolUse` guards still see those calls?) |
| 2.1.323 | "Remote Control: Fixed sessions showing as disconnected..." | `ignore` | pattern |
| 2.1.315 | (no section) | `notes-missing` | |

### 2.3 The proof and the loop

**The proof, on every new version, with or without notes.**

| Step | What runs | Catches |
|---|---|---|
| Docs diff | `npm run drift`, extended from `hooks.md` to settings, permission modes, agent frontmatter, skills frontmatter and CLI flags (RW-5). For Codex: a diff of `config.schema.json` between the two release tags, limited to keys in the map, plus a list of every added key and hook event (RW-6) | shape changes, including ones the notes never mention |
| The suite | install the new version into a temp prefix (`npm i --prefix`), then the conformance suite: each generated hook script gets planted stdin, exit codes are checked | behavior changes |
| Help diff | `claude --help` and `codex --help` against a saved copy | a removed or renamed flag |
| Live-only entries | SendMessage and spawn guards need a signed-in session, which an unattended runner cannot hold (INFERRED) | listed as "needs a live session"; their grade stays "unverified" on the new version |

**The run verdict** (RW-8 writes it into the run file).

| Verdict | Meaning | Result |
|---|---|---|
| green | no `hit-breaking`, suite green, no docs diff on a mapped entry | a proposed `verified.json` entry with its proof (run id, date, suite counts) |
| yellow | `hit-added`, `new-surface`, or a docs diff outside the map | gap-card candidates and map-update candidates in the run file |
| red | `hit-breaking`, a red suite, or a docs diff on a mapped entry | the entry ids that broke, for the loop below |
| blind | an extractor found nothing (a page layout changed), or the notes could not be fetched 3 days running | exit 2. The watch itself is the broken thing |

**The loop, for each red item.**

| # | Step | Proof it happened |
|---|---|---|
| 1 | A ticket with the note line, the map entry, what breaks, and the name of the planted test | the ticket |
| 2 | Commit the planted test alone, on a branch `watch/<platform>-<version>-<slug>`. It must fail on the new version | the red-green gate (RW-11) checks out that commit and sees the test fail |
| 3 | The fix, on the same branch. The test passes. If the fix would break the minimum supported Claude Code version (2.1.295), stop and write up the compatibility question for a maintainer instead | the gate sees the test pass at HEAD |
| 4 | The conformance suite on the new version and on the minimum-version fixtures, plus the full test suite | exit codes in the lane report |
| 5 | Merge the fix branch into an integration branch (never main). Add the version to `verified.json` with its proof | one open integration PR, updated |
| 6 | Stop. The release is a maintainer's decision | |

**What the watch never does.** It never pushes to main, never tags, never runs `npm publish`, never edits a user's `.at`, never starts a language change.

**The verified line.** `VERIFIED_ON` is one constant in `src/conformance/claude-code.ts` (2.1.323 on the base). With about 5 Claude Code versions a week, one constant means a user is "verified" on one exact version only. RW-7 turns it into a list with a proof per version (`spec/claude-code/verified.json`). Green versions are added to the list on the integration branch and ship with the next release. Until then a newer Claude Code reads "unverified", which is the honest answer and already ships in 0.10.1.

### 2.4 The reverse: a platform feature AT cannot say (RW-12)

A `hit-added` or `new-surface` line can become a language-gap card. A gap card is never built by the watch: a new word in the language is a maintainer's call.

| Field | Content |
|---|---|
| `id` | `LG-n` |
| `platform`, `version`, `line` | copied from the notes or the schema diff |
| `area` | from the map, or `"new"` |
| `atToday` | one of: "cannot say it", "says it only in `extensions`", "says it, the binding does not write it" |
| `both` | true when the other platform's map has the same kind of thing (for example a `watchOnly` entry in both maps). The language holds intent and the bindings hold mechanism, so a feature on both platforms is the stronger candidate for a word |
| `sketch` | 2 lines at most. Not a design |

Seed cards, measured on 2026-11-13 (useful as expected outputs for fixtures):

| id | Platform | Feature | Evidence | AT today |
|---|---|---|---|---|
| LG-1 | Codex | Hooks: 14 events, including `PreToolUse` and `PermissionRequest` | `HooksToml` in `config.schema.json` | says it, the Codex binding does not write it. Both: true |
| LG-2 | Codex | Named permission profiles (`permissions`, `default_permissions`) | schema keys | cannot say it |
| LG-3 | Claude Code | Code Mode (2.1.323): tool calls written as JavaScript | changelog 2.1.323, first line. Codex has `features.code_mode` too (schema) | unknown whether guards still see the calls: needs a live check. Both: true |
| LG-4 | Claude Code | `engines["claude-code"]` in `plugin.json` (2.1.323): a plugin states its version range | changelog 2.1.323 | a `.at` cannot state the platform versions it was verified on |
| LG-5 | Claude Code | Permission modes `manual` and `delegate` | SchemaStore `defaultMode` enum. INFERRED: `manual` is an alias of `default` (the schema's own note) | the binding's list has 6 modes |
| LG-6 | Codex | Subagent settings: `agents.enabled`, `max_concurrent_threads_per_session`, role `nickname_candidates` | `AgentsToml`, `AgentRoleToml` | cannot say it |

### 2.5 Failure modes that touch AT code

| Failure | Evidence | The answer |
|---|---|---|
| A release with no notes | MEASURED: 2.1.315 | the proof runs on every version; verdict `notes-missing` is recorded |
| Notes written later | MEASURED: "available since 2.1.318" appears in the 2.1.323 notes | each run re-hashes the last 10 sections; a changed section is read again (RW-13) |
| Notes trail the package | MEASURED: 1 h 43 min and 16 h | missing notes are retried for 3 ticks |
| Skipped version numbers | MEASURED: no 2.1.313, no 2.1.320 | walk npm's `time` list (RW-3) |
| Codex noise | MEASURED: 427 publishes in 30 days, 8 stable | the filter in the tick (RW-3) |
| A docs page changes layout | `scripts/claude-code-drift.mjs` already exits 2 on zero events | verdict `blind`, exit 2 (RW-5, RW-8) |
| A line is misjudged | INFERRED | only `new-surface` lines need a judgment; each is stored with its line; ignores are listed |
| A wrong fix | INFERRED | the red-green gate, the full suite, and no merge to main |
| Two lanes edit one file | | each ticket names its files; the shared-files rule below keeps shared files in one lane |

## 3. Tickets

Sizes are builder-days. Every done-when is a planted test, committed first and failing, then passing.

| id | Title | Size | Files it touches | Blocked by | Done when (red first, then green) |
|---|---|---|---|---|---|
| RW-1 | The surface map for Claude Code | 1.5 | `spec/surface/claude-code.surface.json` (new), `src/conformance/surface.ts` (new), `src/__tests__/e2e/surface-map.test.ts` (new), `spec/claude-code/README.md` | none | The test scaffolds `kitchen-sink.at` and the session-agents fixture, collects every hook event, handler field, payload field, frontmatter key, settings key, written path and CLI flag, and fails on any with no map entry. Red: with an empty map it names every item. Green: zero unmapped. Planted negative: delete entry `cc.hooks.event.PreToolUse` in a temp copy and the test fails naming it |
| RW-2 | The surface map for Codex, with the schema snapshot | 1 | `spec/surface/codex.surface.json` (new), `spec/codex/config.schema.json` (new, a copy at tag `rust-v0.168.0`), `src/__tests__/e2e/surface-map-codex.test.ts` (new) | none | The test scaffolds a fixture with the Codex binding and checks every key and value written to `config.toml` against the snapshot. On the base the binding no longer writes `max_threads` or `untrusted` (CX-4), so: Green on the real output: zero mismatches. Planted (temp fixture): a `config.toml` holding `max_threads` and `approval_policy = "untrusted"` makes the test name both. With both in `knownDrift`, each with a CX ticket id, that fixture passes, and any other planted mismatch (for example an unknown `sandbox_mode` value) still fails. A `knownDrift` item with no ticket id fails. The binding itself is not edited |
| RW-3 | The tick: new versions from the registry | 0.5 | `src/watch/versions.ts` (new), `scripts/release-watch/tick.mjs` (new), `src/__tests__/watch/versions.test.ts` and fixtures (new) | none | Fixture: a saved cut of the real registry JSON. State 2.1.319 gives exactly 2.1.321, 2.1.322, 2.1.323 (no 2.1.320). Codex state 0.167.2 gives exactly 0.168.0, with `0.171.0-alpha.1` and `0.168.0-darwin-arm64` dropped. Exit 0 on no change, 10 on new versions. Red: the test exists before the module |
| RW-4 | The reader: notes to verdicts by lookup | 2 | `src/watch/notes.ts`, `src/watch/classify.ts`, `scripts/release-watch/read.mjs`, `src/__tests__/watch/classify.test.ts`, fixtures (all new) | RW-1, RW-2 | Fixture: the real notes for 2.1.302 and 2.1.315 to 2.1.323, and the Codex 0.168.0 release body. A hand-labeled file of 14 lines (the 7 examples in section 2.2 among them) must get the same verdict and entry. 2.1.315 gives `notes-missing`. The count of `ignore` lines is printed. Red: the labels exist before the classifier |
| RW-5 | Contract snapshots beyond hooks (Claude Code) | 2 | `src/conformance/extract.ts`, `scripts/claude-code-drift.mjs`, `spec/claude-code/settings-contract.json`, `modes-contract.json`, `agent-file-contract.json`, `skills-contract.json`, `cli-contract.json` (new), `src/__tests__/e2e/contract-drift.test.ts` | RW-1 | Saved copies of the 5 docs pages and of `claude --help`. In each planted copy one thing is edited: a permission mode removed, a frontmatter field renamed, a settings key removed, the `--agent` flag removed. `drift --from` exits 1 and names the map entry each time. The unedited copies exit 0. A page with no recognizable table exits 2 |
| RW-6 | The Codex contract diff | 1 | `src/watch/schema-diff.ts`, `scripts/release-watch/codex-schema-diff.mjs`, `src/__tests__/watch/schema-diff.test.ts`, fixtures (all new) | RW-2 | Two fixture schemas. A mapped key renamed gives `hit-breaking` with the entry id. A new hook event and a new top-level key are listed as gap candidates. An unmapped key removed gives nothing. Red: the test before the module |
| RW-7 | The verified version becomes a list with proofs | 1 | `src/conformance/claude-code.ts`, `spec/claude-code/verified.json` (new), `src/__tests__/e2e/honest-version.test.ts`, `src/__tests__/e2e/verified-on.test.ts` | none (VERIFIED_ON is already 2.1.323 on the base) | With a fake `claude` on PATH printing 2.1.321 and a list holding 2.1.319, 2.1.321, 2.1.323: no "unverified" mark. Printing 2.1.322: "installed 2.1.322: unverified". An entry with no `proof` field fails the test. The one-version behavior of 0.10.1 still passes |
| RW-8 | The run: tick, read, proof, one run file | 1.5 | `scripts/release-watch/run.mjs`, `src/watch/run.ts`, `spec/surface/run.schema.json`, `src/__tests__/watch/run.test.ts`, fixtures (all new) | RW-3, RW-4, RW-5, RW-6, RW-7 | Three planted cases with fixtures and a fake binary. (a) All clean: verdict green and a proposed `verified.json` entry. (b) A fixture guard that exits 0 where 2 is expected: verdict red, naming the entry. (c) An extractor that returns zero events: verdict blind, exit 2. The run file validates against the schema in all three |
| RW-11 | The red-green gate | 1 | `scripts/release-watch/red-green.mjs`, `src/__tests__/watch/red-green.test.ts`, 2 small fixture repos as git bundles (all new) | none | Fixture repo A: the planted test passes at its own commit. The gate exits 1 and says "never red". Fixture repo B: the test fails at its commit and passes at HEAD. The gate exits 0 and prints both exit codes. Red: the test before the script |
| RW-12 (AT part) | Language-gap cards | 0.5 | `scripts/release-watch/gap-card.mjs`, `src/__tests__/watch/gap-card.test.ts` (new) | RW-4, RW-6 | Fixture lines: the Code Mode line (Claude Code, 2.1.323) and a new Codex hook event. Two cards come out with every field of section 2.4. A feature with a `watchOnly` entry in both maps gets `both: true`. Red: the test before the script |
| RW-13 (AT part) | Late notes | 0.5 | `src/watch/notes.ts`, `src/__tests__/watch/late-notes.test.ts` (new) | RW-4 | The reader keeps a hash per changelog section and re-hashes the last 10 sections each run. A changelog fixture where the 2.1.318 section gained one line after it was read: the reader reports exactly 1 late line, with its version. An unchanged fixture reports 0. Red: the test before the code |

**Edges.**

```
RW-1 --+--> RW-4 --+--> RW-13 (AT part)
       |           +--> RW-12 (AT part)
       |           +--> RW-8
       +--> RW-5 ------> RW-8
RW-2 --+--> RW-4
       +--> RW-6 --+--> RW-12 (AT part)
                   +--> RW-8
RW-3 ------------------> RW-8
RW-7 ------------------> RW-8
RW-11  (no edges; the loop's gate)
```

**Shared-files rule.** `src/conformance/claude-code.ts` is edited by RW-7 only. `src/conformance/extract.ts` and `scripts/claude-code-drift.mjs` are edited by RW-5 only. `src/watch/notes.ts` is created by RW-4 and edited by RW-13, in that order, in the same lane. No other file has two tickets. `src/bindings/codex.ts` is not touched by any RW ticket.

## 4. Lanes

### W1: maps, tick, gate, verified list

Order: RW-1, RW-2, RW-3, RW-11, then RW-7.

Files owned: `spec/surface/*`, `spec/codex/config.schema.json`, `src/conformance/surface.ts`, `src/conformance/claude-code.ts` (RW-7 only), `spec/claude-code/verified.json`, `src/watch/versions.ts`, `scripts/release-watch/tick.mjs`, `scripts/release-watch/red-green.mjs`, and their tests and fixtures. RW-1 also edits `spec/claude-code/README.md` (a line pointing at the map).

### W2: reader, snapshots, schema diff, cards, late notes, run

Starts after W1, on W1's branch. Order: RW-4, RW-5, RW-6, RW-12 (AT part), RW-13 (AT part), RW-8.

Files owned: the files listed for those tickets in section 3. W2 may add entries to `spec/surface/*.surface.json` when a ticket needs a new token, but does not change the map format.

### Fixtures with real data

Some fixtures need real data: the registry JSON for both packages, the Claude Code `CHANGELOG.md` sections (2.1.302, 2.1.315 to 2.1.323), the Codex 0.168.0 release body, the docs pages, `claude --help`, and the Codex `config.schema.json` at tag `rust-v0.168.0`. The lane fetches each once from `registry.npmjs.org`, `code.claude.com` or `github.com` (raw files and `api.github.com`), saves it as a committed fixture (trimmed to what the test needs, with the source URL and fetch date in a sibling note or a header field), and never fetches again during tests. Tests run offline. The lane report lists every fixture it could not reach; that ticket's test then uses a hand-built fixture marked as such, and the gap is named in the report.
