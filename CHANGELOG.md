# Changelog

All notable changes to agentopology are documented here.

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
