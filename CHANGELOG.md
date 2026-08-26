# Changelog

All notable changes to agentopology are documented here.

## [0.4.2] — 2026-08-26

### [feat] `agentopology/plan`, `/render`, `/resolve` subpath exports

The interpreted-mode modules were shipped but not reachable — `package.json`
exported only `.`, `./parser`, `./bindings` and `./visualizer`, so
`import { buildExecutionBrief } from "agentopology/plan"` threw. Now exported,
with `renderBriefMarkdown` re-exported from `plan` so both halves are one import.

### [docs] README covers both lifecycles

The hero and the "What It Does" diagram still described a one-way compiler:
`.at` in, platform configs out. It now shows the fork — `scaffold` to files, or
`plan` to a brief your coding agent enacts — plus a section on interpreted
execution with a real render, the four questions the brief answers, and the
three autonomy notches.

Corrected a stale "29 built-in rules" (it is 92) and the programmatic API
example, which imported subpaths that did not exist.

### [test] The README is now checked against the package

`src/docs/__tests__/readme-sync.test.ts` fails if the README imports a subpath
`package.json` does not export, states a rule count the validator disagrees
with, points at a `docs` topic that does not exist, or contains an `.at` snippet
that does not parse and validate. Documentation drift is not a discipline
problem — it is a missing test, the same shape as the spec drift fixed in 0.4.0.

## [0.4.1] — 2026-08-26

### [fix] `plan` dropped every gate from the rendered flow

`0.4.0` held nodes with no edges out of the terminal spine, so a topology's
manual-invocation agents would not read as concurrent work. But a **gate** never
appears in an edge either — it binds through `after`/`before`, which is the
whole reason `resolve/order.ts` splices them by anchor. So every gate was
classified as "declared but not in the flow" and vanished from the render.

Only the ASCII render was affected. The execution brief, the order resolver and
all 8 bindings were correct throughout — a scaffolded gate still compiled to its
hook.

The test that should have caught this compared the gate's line POSITION against
the agent it gates. When the gate was dropped from the spine, its name still
appeared in the "declared but not in the flow" line further down, so the
positional assertion held. It now asserts the gate is present in the spine by
its glyph, before comparing anything.

## [0.4.0] — 2026-08-26

### [feat] `agentopology plan` — interpreted mode, a second lifecycle for a topology

A `.at` file has always compiled to a persisted harness. It can now also be
**enacted directly**, by the coding agent already in your session, with nothing
written outside the session scratchpad.

```bash
agentopology plan <file>.at --mode plan|execute|auto [--task "..."] [--brief]
```

The premise: **the host coding agent is already the runtime.** It plans, spawns
subagents, runs them in parallel, reads files, retries and re-plans. It does not
need generated agent files to do any of that. So `plan` does not run anything —
a CLI cannot spawn subagents. It is a **linter and an orderer**: it validates
(the agent that wrote the file can write an illegal one), applies the spec's
defaults, resolves execution order, and emits an **execution brief** — a
Markdown program in eleven fixed sections that a host agent follows.

The brief resolves what a host would otherwise guess: handoffs as
`writes ∩ reads`, what each reader **must not** read, which same-step roles are
mutually blind, gate tiers, loop budgets, and every declaration that cannot be
honoured at runtime. Nine ambiguity kinds are detected statically and pre-filled,
each carrying a concrete `.at` edit that would remove the guess.

Not a replacement for `scaffold`. The same declaration, two execution backends —
a **lifetime** choice, not a strategy one. `agentopology docs interpreted-mode`
explains which to reach for.

### [feat] Terminal flow renderer, and two new export formats

`plan` prints an ASCII flow graph ranked by real execution order — gates spliced
where their `after`/`before` puts them, exclusive branches drawn as branches with
their conditions, loops with their budgets. Also available as
`--format ascii` and `--format brief`.

### [fix] Gates were ranked as graph sources

Gates bind through `after`/`before`, never through edges, so their in-degree is
zero and a topological sort ranks them **first**. On `examples/code-review.at` a
post-review gate sat next to the entry action. Execution order is now resolved
with gates spliced at their anchors, including gate-to-gate anchors regardless of
declaration order.

### [fix] An unphased agent no longer sorts differently on every target

Seven consumers each chose their own sentinel for an undeclared `agent.phase`:
`MAX_SAFE_INTEGER` in claude-code and claude-workflow, `999` in gemini-cli, `0`
in openclaw, kiro, mermaid and the markdown exporter. The same topology put the
same agent **first on four targets and last on three** — the exact failure
"write once, deploy to any platform" exists to prevent. `src/resolve/phase.ts` is
now the single definition, and a test fails if any consumer reintroduces its own.

### [fix] `codex` no longer defaults `permissions` to the strictest policy

The spec's default is `autonomous`, which maps to Codex `on-request`. The binding
used `supervised`, which maps to `untrusted`. Omitting the field produced an
agent that asked permission for everything.

### [fix] `settings.json` hook merging was written, tested, and unreachable

`deepMergeSettingsJson` handles union-merged permissions, merged env, and
topology-owned hooks. The scaffold pipeline routed `settings.json` to the generic
JSON merge instead, which cannot update an existing `hooks[event]` array and can
never remove one — so scaffolding a hook into settings that already declared that
event silently dropped it.

### [feat] Four new validation rules, and the spec now tracks the validator

| Rule | Catches |
|---|---|
| **V89** | `agent.prompt` written as `prompt: "path"` — the string form belongs to `skill`. Two shipped examples did this on eight agents, pointing at a directory that never existed, and those agents scaffolded with their own description as their entire instruction set. |
| **V90** | A field value that swallowed the next field. Fields are one per line; the grammar never said so, and `{ model: sonnet retry: 3 }` made `model` the string `"sonnet retry: 3"`. |
| **V91** | A required field satisfied by a parser-injected placeholder. V7 is named *Model required* and passed on an orchestrator with no model, because the parser had substituted `"unknown"`. |
| **V92** | An edge's attributes split across two brackets. `[when ...] [max N]` produced the condition string `a.verdict == fail] [max 3`, silently. |

`spec/validation.md` documented 35 rules while the validator implemented 89 —
fifty-four existed only in source, because nothing compared them. The table is
now generated from the registry and a test fails if the two ever diverge. **92
rules, V1-V92, contiguous.**

### [feat] `docs/KPIS.md` and `docs/PRIOR_ART.md`

29 metrics across four layers, each naming the instrument that measures it. And
the priority record: `agentopology@0.1.0` was published to npm on **2026-03-19**,
four months before "graph engineering" became the name for the practice. Three
copy-pasteable commands let a stranger verify that without trusting us.

### Notes

Every fix above was found by **using the tool on itself** — a stranger's topology
run through `plan`, and a review topology whose verifier stage reproduced each
claim against the real CLI before accepting it. 22 findings acted on. The compile
path is unchanged: all 8 bindings produce byte-identical output.

1467 tests, up from 1351.

## [0.2.5] — 2026-05-30

### [feat] `claude-workflow` binding — compile topologies to the Claude Workflow runtime

The first binding whose output **executes** (a Claude Workflow script) rather than
only configuring a project. `agentopology scaffold <file>.at --target claude-workflow`
compiles the **deterministic fan-out phases** of a topology — the phases whose
agents are marked `extensions { claude-workflow { execution: workflow } }` — into a
`<topology>.workflow.js` (a Claude Workflow tool script using `export const meta`,
`parallel()`, `agent()`, the `schema` option, and `isolation: 'worktree'`). It also
emits a `<topology>-SEAM.md` (the Blackboard hand-off contract), a
`<topology>-README.md` (human-node split), and a `<topology>-LOSSY-REPORT.md` that
loudly lists every primitive that could not be translated — nothing is dropped
silently. `human` nodes force a workflow split; session-fixed concerns
(permissions, providers) are reported, not faked.

### [feat] Hybrid model — `claude-code` host + `claude-workflow` rung from one topology

One `.at` topology can compile to **two coupled targets at once**. `claude-code` is
the **host** (the event-driven layer: agents, hooks, the Blackboard, concurrent
observability, the human/gate/branching nodes). `claude-workflow` is the embedded
**deterministic rung** (the parallel fan-out phases). They couple through the
Blackboard files (`memory.workspace`): the host launches the rung and observes its
writes live via a `PostToolUse` hook — giving concurrent observability the Workflow
runtime cannot express on its own. The `claude-code` binding is now hybrid-aware:
agents marked `execution: workflow` are NOT emitted as host subagents (the rung owns
them); instead the host emits the launch glue + the observe hook + a "Hybrid run
order" block in `CLAUDE.md`.

The hybrid is **opt-in and backward-compatible**: a topology with no
`execution: workflow` marker compiles to pure `claude-code`, unchanged.

### [internal] `src/bindings/lib/seam.ts` — single source of truth for the seam

The `claude-code` and `claude-workflow` bindings share one module for the seam
namespace, the `execution: workflow` predicate, the generated-artifact filenames,
and the Blackboard root — so the two halves cannot drift.

### [test] hybrid end-to-end test

`hybrid-e2e.test.ts` compiles both bindings from one `.at` file and proves they
compose: agents partition cleanly, both agree on the seam, the generated
`workflow.js` is valid ES module syntax (`node --check`), the host wires the
observer, and the LOSSY report names the human split. (1310 tests total.)

### [docs] strategy + mapping

- `docs/AT_VS_WORKFLOW_STRATEGY.md` — why `.at` is the runtime-agnostic standard
  (Terraform-for-agents) and Claude Workflow is its first compile target.
- `docs/bindings/claude-workflow-mapping.md` — the complete bidirectional mapping:
  every `.at` primitive + design pattern classified CLEAN / LOSSY / UNREPRESENTABLE.
- `examples/matchmat-ship.at` — the dogfood hybrid topology.

## [0.2.4] — 2026-05-19

### [feat] `orchestrator { delegation: inline | subagent }` field (#7)

Topologies can now declare how the orchestrator runs the agent nodes. The
new `delegation` field on the orchestrator block has two values:

- `subagent` (default): the orchestrator spawns each agent via the platform's
  subagent / Task-tool mechanism. Each agent runs in its own context window.
  On claude-code, `SubagentStop` hooks fire and gates compile to those hooks
  (the behavior every version up to 0.2.3 shipped).
- `inline`: the orchestrator drives every agent step in its own session
  context. Agent `AGENT.md` files are read as prompt fragments by the main
  session; no subagent is ever spawned via Task.

### [fix] claude-code: suppress dead `SubagentStop` hooks in inline mode (#7)

When `orchestrator.delegation: inline` is declared, the claude-code binding:

- Skips emitting `SubagentStop` hooks for every gate, regardless of whether
  the gate's `after:` target is a registered subagent_type — no subagent
  ever runs, so the hook would never fire.
- Skips emitting any global `hook { on: SubagentStop }` / `SubagentStart`
  declaration with a one-line warning explaining why.
- Updates the gate-wrapper script header to say "Enforcement: NOT wired as
  a SubagentStop hook (orchestrator.delegation is 'inline'). Invoke this
  script from your /<topology> playbook at the right step."
- Adds a **"Gates to invoke (inline-orchestrator)"** section to each
  generated `.claude/commands/<trigger>.md` listing every blocking gate
  with a copy-pasteable `bash` invocation, the `after:` step name, and the
  `on-fail` semantic. This is the cheat sheet pattern the youtube-flywheel
  topology in `agentopology-content` arrived at by hand.

Default behavior is unchanged: topologies without `delegation:` continue
to compile gates to `SubagentStop` hooks exactly as in 0.2.3.

### [feat] New validator rule V87 — orchestrator delegation enum

`orchestrator.delegation` must be one of `subagent` or `inline`. Any other
value (including typos like `inlined`, `delegate`, etc.) is a hard error.

### Migration

If your topology drives every agent step from a slash-command playbook and
the scaffolded `SubagentStop` hooks have always been dead config for you,
add one line to your `orchestrator` block:

```at
orchestrator {
  model: opus
  delegation: inline   // <-- add this
  handles: [start, finish]
}
```

After re-scaffolding, your `settings.json` will have no `SubagentStop`
entries and the trigger playbook (e.g. `.claude/commands/<topology>.md`)
will contain a ready-to-paste cheat sheet for invoking each gate at the
right step.

## [0.2.3] — 2026-05-19

### [refactor] Lift `shellStub` to shared `src/bindings/lib/stub.ts` (#4)

The `shellStub()` function was duplicated across five binding files
(claude-code, codex, gemini-cli, kiro, openclaw) and declared but unused in
cursor.ts. Each copy now lives in one place: `src/bindings/lib/stub.ts`.
Cursor's dead copy was removed.

### [feat] Machine-readable `AGENTOPOLOGY_STUB` marker in stubs (#4)

Every script produced by `shellStub()` now contains the literal line
`# AGENTOPOLOGY_STUB — fill this in before relying on this script`. The
marker is:

- A comment, so it never affects script behavior at runtime.
- Removed by the user once they implement the script — that single action
  flips the file out of "stub" state for all downstream tooling.
- Pinned by a unit test so downstream gate-runners or CI scripts can match
  on it reliably across minor versions.

Use `isStubContent(content)` from `agentopology/bindings` (exported via
`src/bindings/lib/stub.ts`) to detect stubs programmatically.

### [feat] `agentopology scaffold` reports stub count and paths to stderr (#4)

After a successful scaffold run, the CLI now emits a yellow warning to
stderr listing every generated file that contains the `AGENTOPOLOGY_STUB`
marker. Output looks like:

```
  3 stub(s) need implementation before this topology can run:
    · .claude/skills/yt/scripts/validate-brief.sh
    · .claude/skills/yt/scripts/qa-render.sh
    · .claude/skills/yt/scripts/check-platform-auth.sh
  Search for "# AGENTOPOLOGY_STUB — fill this in before relying on this script" — remove that line when each script is implemented.
```

stdout is unchanged so existing automation that captures the file list keeps
working.

### [feat] New `agentopology stubs <project-dir>` command (#4)

Scan an already-scaffolded project for unimplemented stubs. Walks the
directory (skipping `node_modules`, `.git`, `dist`), greps each file for the
marker, and prints a sorted list. Exits 1 if any stubs remain, 0 if clean —
designed for CI:

```sh
# In your CI pipeline:
npx agentopology stubs ./
```

### [fix] claude-code: gate SubagentStop hooks only emitted for agent/group targets (#3)

The `SubagentStop` hook's `matcher` field is matched against the registered
`agent_type` (the name of a `.claude/agents/<name>/AGENT.md` subagent). Only
`agent` and `group` nodes scaffold a frontmatter-bearing AGENT.md and register
as subagent_types — `human`, `action`, and `orchestrator` nodes do not.

Before this fix, the scaffolder emitted `SubagentStop` entries for any gate
with an `after:` target, including human checkpoints. Those hooks silently
never fired because no subagent ever ran by that name.

Now the scaffolder:

- Emits a `SubagentStop` hook only when `gate.after` resolves to an agent or
  group node.
- Warns to stderr when a blocking gate targets a non-agent node, explaining
  that the gate wrapper script must be invoked from an orchestrator playbook
  or slash command.
- Still generates the wrapper script for non-agent-targeted gates (with a
  header comment documenting the limitation), so the orchestrator can call it
  directly.
- The gate wrapper script's header now accurately describes whether the gate
  is enforced by a hook (agent target) or must be invoked by the orchestrator
  (non-agent target).

`V25` is rewritten: the rule now fires only for `on-fail: bounce-back` gates
with non-agent (or missing) `after` targets. Gates with agent/group targets
are not flagged because they ARE enforced by the SubagentStop hook on
claude-code (exit 2 prevents the subagent from stopping).

## [0.2.2] — 2026-04-21

### [feat] Observability hook shortcut — SubagentStop in global `hooks {}` block

Global hooks with `on: SubagentStop` now use the declared `run:` path verbatim when it
starts with `.` or `/`, instead of being rewritten into `.claude/skills/<name>/scripts/`.
This enables clean per-agent finish logging without fake gates:

```at
hooks {
  hook log-subagent-finish {
    on: SubagentStop
    matcher: "amitai-cos|nadav-cos|ops-agent"
    run: ".claude/scripts/log-subagent.sh"
    type: command
    timeout: 5000
  }
}
```

The `matcher` and `timeout` are preserved verbatim in the generated `settings.json`.

### [feat] `agentopology info` warns about observability gaps

If a topology has one or more agents but no `SubagentStop`/`Stop` hook (and no
enforced gates, which compile to `SubagentStop`), `agentopology info` now emits a
`[warning]` suggestion with the agent count and a ready-to-paste `hooks {}` snippet.

### [feat] Non-destructive scaffold — `deepMergeSettingsJson`

New `deepMergeSettingsJson` function in the scaffold merge layer handles
`.claude/settings.json` with domain-aware logic:

- `permissions.allow`: union-merged (existing entries survive re-scaffold)
- `permissions.deny`: union-merged (existing entries survive re-scaffold)
- `env`: shallow-merged (generated wins on key conflict, user-only keys preserved)
- `hooks`: rewritten entirely from topology (topology owns hooks)
- All other top-level keys (e.g. `model`, `theme`): existing value wins

Re-scaffold without `--force` calls `deepMergeSettingsJson` for `settings.json`
via the `shared-config` incremental category (already in place). Invalid existing
JSON now throws a descriptive error instead of silently reverting to the existing
file.

### [feat] Agent-scoped env var injection in hook stubs (Change 4)

Generated hook stub scripts now extract `AGENT_TYPE` and `SESSION_ID` from the
Claude Code stdin JSON payload (`agent_type` and `session_id` fields), making the
variables available to the user's implementation:

```bash
PAYLOAD=$(cat)
AGENT_TYPE=$(echo "$PAYLOAD" | jq -r '.agent_type // "unknown"')
SESSION_ID=$(echo "$PAYLOAD" | jq -r '.session_id // ""')
```

### [feat] Hook stub generation for observability scripts (Change 5)

When `scaffold` generates a hook pointing at a path that starts with `.` or `/`
(i.e. an observability-style script, not a skills-directory script), it emits an
executable stub at that exact path. The stub:

- Has a `#!/usr/bin/env bash` shebang
- Contains an auto-generated header (hook name, event, matcher, date)
- Extracts `AGENT_TYPE` from stdin (Change 4 integration)
- Appends a structured JSON line to `.claude/memory/metrics.jsonl`
- Is flagged `executable: true` in the `GeneratedFile` so `executeActions` writes
  it with `chmod 0755`

### [fix] Multi-line suggestions rendered correctly in `agentopology info`

Suggestion messages with embedded newlines (e.g. the observability gap snippet)
are now printed with proper indentation — continuation lines are prefixed with
four spaces.

### Breaking: none

All existing `.at` files validate and scaffold identically. The path-rewriting
change for global hooks only activates when `hook.run` begins with `.` or `/`
(a pattern that was previously broken anyway — it would generate scripts in the
wrong directory).

---

## [0.2.1] — 2026-04

- 10 claude-code binding syntax fixes validated by battle test topology

## [0.2.0] — 2026-04

- OpenClaw importer added
- Gates compile to SubagentStop hooks (not PreToolUse/Task)
