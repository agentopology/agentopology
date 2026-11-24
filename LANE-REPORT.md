# Lane report: OTLP protocol + SKILL.md entry (0.13.1)

Branch `feat/0.13.1-otlp-entry`, from `origin/rc/0.13.0` (aec197c). Nothing else pushed except this report branch. No PRs.

## Docs quotes

monitoring-usage (https://code.claude.com/docs/en/monitoring-usage):
- `OTEL_EXPORTER_OTLP_PROTOCOL`: "Protocol for OTLP exporter, applies to all signals. Defaults to `http/protobuf` for a valid `http://` or `https://` endpoint. For a gRPC endpoint such as `http://localhost:4317`, set this to `grpc`." Values: `grpc`, `http/json`, `http/protobuf`.
- Per-signal variables exist with the same three values: `OTEL_EXPORTER_OTLP_METRICS_PROTOCOL` and `OTEL_EXPORTER_OTLP_LOGS_PROTOCOL` ("overrides general setting"), and `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL` (beta, "overrides `OTEL_EXPORTER_OTLP_PROTOCOL`").
- The binding writes only the general key (it covers every signal). It writes no per-signal key, so nothing is inconsistent. The page was read only to char 100000 of 182558; the section on the variables table was in the read part.

skills (https://code.claude.com/docs/en/skills): "A field name must match the table exactly, hyphens included: Claude Code ignores a field it doesn't recognize without reporting an error." Unknown keys do not break skills in Claude Code. Caveat from the same page: claude.ai upload / Skills API / `package_skill.py` reject keys outside name, description, license, compatibility, metadata, allowed-tools. The topology skill already carries non-spec keys (`version`, `topology`, `patterns`, `entry`), so this adds no new class of risk. Page read only to char 100000 of 119905.

## Commits

- 8e4d9c4 Add observability protocol field (card 1): `protocol:` parsed, written as OTEL_EXPORTER_OTLP_PROTOCOL, V158 error for other values; grammar 4.19a, docs topic, validation spec, surface row `cc.env.OTEL_EXPORTER_OTLP_PROTOCOL`, CHANGELOG.
- f196096 Write entry into the flow-map SKILL.md frontmatter (card 2): `entry: <agent id>` when meta.entry is a declared agent; CHANGELOG `### Changed behaviour`.
- (third) Update README rule count to 158 (readme-sync test failed after V158).

## Red then green

- Card 1, `observability-protocol.test.ts`: red 4 failed / 4 passed (8); green 8 passed. Tests were written and run red first but committed together with the change, not as a separate red commit.
- Card 2, `skill-entry-key.test.ts`: red 1 failed / 2 passed (3); green 3 passed. Same, one commit.

## Goldens edited

None. No golden, pin, or differential file was touched. Only the source files, tests, spec/docs, surface map and CHANGELOG changed. No fixture in the repo has an agent `meta.entry` in a golden, so no SKILL.md hash moved.

## Decision to check (card 2)

The topology SKILL.md frontmatter already wrote `entry: commands/<first-trigger>.md` when a topology has triggers. The frontmatter holds one `entry`, so with both triggers and an agent entry I made the agent id win (the card's purpose is flow-map recognition). Topologies with triggers but no agent entry are unchanged. Alternative: keep the command path and skip the agent id when triggers exist; one line in `generateTopologySkill`. The CHANGELOG says what I did.

## Gates

- tsc: clean.
- Card 1 batch (spec-sync, surface-map, observability/settings tests, differential, as0112): 13/14 files passed; the one failure was spec-sync's rule count prose (validation.md 157 vs 158), fixed, rerun green (4 files, 29 tests).
- guards-golden, differential (all, incl. merge/hook where named so), as0112: 5 files, 223 tests passed. A frozen differential did not move.
- Skill/golden/entry batch after card 2: 7 files, 105 tests passed.
- Full suite once (`timeout 1800 npx vitest run`, run before the README fix): 216 files passed, 4 failed, 3 skipped; 6543 tests passed, 4 failed, 24 skipped, 22 todo.
  - `readme-sync` "states the real validation rule count": caused by my change (README said 157); fixed in the third commit, passes.
  - `action-guard-speed` "the same with no timeout program on PATH": also fails on origin/rc/0.13.0 in this container.
  - `cx-review-fixes` "[F-17] POSIX watchdog: a check that ignores TERM is dead when the hook exits 2": also fails on base.
  - `import-project` "[I5] an unreadable file...": also fails on base (the container runs as root).
  - Base check: a detached worktree of origin/rc/0.13.0 ran those three files, 3 failed / 292 passed.

## Notes

- The README count is edited in the feature branch (5 places); the integrator renumbers V158 if needed.
- `npm ci` was needed (node_modules absent).
- Stopped on nothing.
