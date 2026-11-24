# Lane report: body re-scaffold (0.13.1)

Branch `fix/0.13.1-body-rescaffold`, from `origin/rc/0.13.0` (aec197c). Finished; nothing stopped on.

## Cause, confirmed

Measured on 0.13.0 with a 2-agent topology: scaffold, change only the prompts, scaffold again → `0 created, 0 updated, 4 unchanged`; every AGENT.md still held the old prompt, and a clean generation differed.

The cause is wider than the frontmatter patch named in the brief:

- `src/scaffold/incremental.ts:372-386` (0.13.0): an agent/skill file still hashing to its manifest entry goes through `mergeAgentFile`, which keeps the text between the prompt markers (`src/scaffold/merge.ts:75-81`) and labels it "prompt preserved". The prompt of an unedited file was never rewritten.
- `src/scaffold/incremental.ts:236-261` + `src/scaffold/structure.ts:22-23`: a file with edited frontmatter gets only the frontmatter patch; "The body is never written".
- `src/bindings/types.ts:101-103` (`StructureSpec`): the file owns its body.
- The manifest recorded only the whole-file hash and region hashes (`head`, `outside`), no hash of the body including the prompt.

## Commits

- `03c17e6` Add rows for a prompt change reaching an unedited scaffolded file (`src/__tests__/e2e/body-rescaffold.test.ts`, 12 rows).
- `02412e4` Rewrite an unedited scaffolded body from the .at (manifest `body` hash; plan, record, CLI line, CHANGELOG, getting-started).

## Red, then green

- Red (rows on 0.13.0 source, run in a worktree of `origin/rc/0.13.0`): 9 failed, 3 passed.
- Green: 12 passed.

Rows: measured repro (6 agents + skill + rules, prompt/description only → 9 updated; clean generation equals the re-scaffold, tree and manifest minus timestamp); manifest holds a body hash for each agent, skill, rules file; SKILL.md and rules follow the .at; agent and skill with user-edited frontmatter still take the new body; hand-edited-back body counts as unedited; edited agent prompt, edited outside markers, edited SKILL.md, edited rules file (message `user edited — kept`) are kept; manifest without hashes keeps all bodies and records nothing; deleting a kept file has it written fresh and recorded, and the next change reaches it.

## Design as implemented

- `ManifestEntry.body` (`src/scaffold/types.ts`): hash of the text after the frontmatter, for files under `.claude/agents|skills|commands/**.md` and `.claude/rules/*.md` (`isBodyTracked`, `src/scaffold/regions.ts`).
- Recorded only when scaffold writes the body and it equals the .at's body (create, or update to the generated body), or an earlier record exists and the file is found holding the .at's body (hand-edited back). An earlier record is otherwise kept; with none, nothing is recorded.
- (a) record matches: unedited file → whole generated file written (label "prompt preserved" where the prompt did not change, else "body updated from the .at"); edited frontmatter → the frontmatter patch, then the body from the .at ("body updated from the .at" change line).
- (b) record differs → treated as edited; the old paths (patch, prompt-region merge, "user edited — kept") apply unchanged.
- (c) no record: agent and skill files take the old path (`mergeAgentFile`, prompt kept); a rules file is kept with the new line `body kept — written before bodies were recorded; delete the file to have it generated from the .at`.
- Re-scaffolding fresh: delete the file and run `scaffold`; deleting the manifest does not do it (unlisted files are "not created by scaffold", kept). Stated in the CHANGELOG.

## Judgement calls to check

1. (c) for a SKILL.md keeps today's `mergeAgentFile` behaviour: instructions kept, the sections around them regenerated (this adds blank lines around the kept instructions, as in 0.13.0). I did not change that, so the (c) skill row asserts the prompt is kept, not byte equality.
2. (c) for a rules file is literal: an unedited rules file from a 0.13.0 manifest is now kept (and said) instead of regenerated whole. That is the one place an unedited file stops following the .at on upgrade. No existing assertion covered it.
3. The "prompt preserved" label is kept where the prompt did not change, because `merge-differential-0112` compares that output line byte for byte. My first label ("body updated from the .at" everywhere) moved the row `gate run changed` in merge-differential-0112 and hook-record-fallback; I changed the label, not the row.

## Old assertions moved

None. No existing assertion stated that an unedited scaffold-written body is kept, and none moved. No golden or pin was edited. No FROZEN differential row moved in the final tree (differential-0112, merge-differential-0112, hook-differential-0112, as0112-blocks all pass).

## Gates

- `npx tsc`: clean.
- scaffold, manifest, structure, binding tests, guards-golden, the three differentials, as0112-blocks, spec-sync, surface-map (+codex), structure-patch, body-rescaffold: 51 files, 1164 passed, 1 skipped.
- Full suite once on the final tree (`timeout 1800 npx vitest run`): 217 files passed, 2 failed (3 skipped); 6546 tests passed, 2 failed.

Full-suite failures, both also failing on `origin/rc/0.13.0` in this container (checked in a worktree of aec197c):

- `import-project.test.ts` [I5] an unreadable file … (fails as root: permissions are not enforced).
- `action-guard-speed.test.ts` "the same with no timeout program on PATH (stock macOS)".

Also seen failing on rc/0.13.0 and in an earlier full run here, but passing in the final run (timing flake): `cx-review-fixes.test.ts` [F-17] F9d, POSIX watchdog and GNU timeout variants.
