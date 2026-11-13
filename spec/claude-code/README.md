# Claude Code contract snapshots

What the claude-code binding relies on, as Claude Code's own docs state it.

| File | What it is |
|---|---|
| `hooks-contract.json` | Extracted from https://code.claude.com/docs/en/hooks.md: the hook events, the events with no matcher support, the matcher rules, each handler type's fields, and every "Requires Claude Code vX". Its `claudeCode` field is the version installed when it was checked. |
| `hooks-contract.2.1.295.json` | The same contract at the minimum version the binding supports, **derived**: events and fields that need a newer version are dropped. The docs are current-only, so a contract can't be fetched as it stood at an older version. |

The docs are the source of truth. SchemaStore's settings schema
(`https://json.schemastore.org/claude-code-settings.json`) lags the CLI; on
2026-11-10 it lacked `onFailure` and two of the 33 events. So it is not used.

- `npm run drift` fetches the page and diffs it with the snapshot. It exits 1 on drift.
- `node scripts/claude-code-drift.mjs --write --claude-code <version>` accepts the page as the new snapshot and re-derives the minimum.
- `src/__tests__/e2e/contract-drift.test.ts` holds the code to the snapshot, offline. The checks:
  - the constants in `src/conformance/claude-code.ts` match it;
  - the minimum's contract is the derived one;
  - every event and handler field the binding writes exists at the minimum version.

The surface map `spec/surface/claude-code.surface.json` lists everything the binding writes or relies on, one entry per item, each with its contract page. `src/__tests__/e2e/surface-map.test.ts` fails on any generated hook event, handler field, payload field, frontmatter key, settings key, path or CLI flag that has no entry.
