# Changelog

All notable changes to agentopology are documented here.

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
