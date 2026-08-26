# KPIs — how we know AgenTopology is working

> Every metric here names its **instrument**. A KPI without a way to measure it is
> a wish, and wishes make a roadmap feel healthy while it rots.
>
> Date: 2026-08-26. Baselines measured, not estimated.

---

## 0. The priority claim, with receipts

In **July 2026** the term *"graph engineering"* began spreading in AI agent
development. Its working definition:

> Designing the topology of an AI system as an explicit, versioned artifact
> instead of letting it emerge from whatever code you happened to write. Nodes
> are agents, edges are control-flow transitions and routing, and shared state
> flows along the edges.

That is a description of `.at`.

| Receipt | Date | Verifiable by |
|---|---|---|
| Skill repo, first commit | **2026-03-10** | `git log --reverse` |
| Package repo, first commit | **2026-03-12** | `git log --reverse` |
| **`agentopology@0.1.0` published to npm** | **2026-03-19** | `npm view agentopology time` — public, immutable, third-party |
| The term "graph engineering" spreads | **2026-07** | search record |

**Four months.** The npm timestamp is the one that matters: it is not our claim
about ourselves, it is a public registry record nobody can edit.

And the discipline the term names is split into *execution graphs* and *context
graphs*. `docs/AGENTOPOLOGY_CONTEXT_FIRST_VISION.md` makes exactly that split —
"the graph is the control plane, context is the data plane" — from our own
practice, not from reading the term.

**KPI-0 — priority is defensible.** Instrument: a single page that a stranger can
check in 60 seconds without trusting us. Status: ✅ **`docs/PRIOR_ART.md`** — three
copy-pasteable commands, each hitting a public record (npm registry, GitHub API,
git history), plus the definition compared line by line against `.at` as it
shipped in `0.1.0`.

**Anti-goal:** do not claim to have *coined* the term. We did not. The claim is
narrower and stronger — we shipped the practice, publicly and versioned, before
the vocabulary existed. Overreaching turns a checkable fact into a marketing
smell.

---

## Layer 1 — Language quality

Is `.at` actually a good language, or just a config format with opinions?

| # | KPI | Instrument | Baseline (2026-08-26) | Target |
|---|---|---|---|---|
| L1.1 | **Every shipped example validates clean** | `for f in examples/*.at; do agentopology validate $f; done` | ✅ 10/10 | stays 10/10, enforced in CI |
| L1.2 | **Zero silent drops** — a construct the parser ignores must produce an error | V89 + V90, plus `V90: every shipped example is free of swallowed fields` | ✅ **0 known.** V90 closed the last one: fields are one per line, now documented in `spec/grammar.md` §2 and enforced across `meta` and every node block, with prose fields exempted so a colon in a description is not a false positive. | 0 known |
| L1.3 | **Spec matches implementation** | `src/parser/__tests__/spec-sync.test.ts` — compares the spec table against the `validate()` registry | ✅ **92 / 92**, contiguous V1-V92, guarded by 4 tests | stays equal |
| L1.4 | **Bindings agree on defaults** | `src/bindings/__tests__/defaults-agreement.test.ts` | ✅ **0 disagreements.** Was 1 — codex defaulted to `supervised` → Codex `untrusted`, the most restrictive policy, for an omitted field the spec says means `autonomous`. openclaw's literal `"auto"` was a false alarm: it *maps* to `autonomous`. | stays 0 |
| L1.5 | **Round-trip fidelity** | parse → serialize → parse, deep-equal | ✅ covered by `src/import/__tests__` | stays green |
| L1.6 | **Time to a first valid topology, by a stranger** | dogfood run artefacts | ✅ a stranger wrote a valid 4-role topology with genuinely blind auditors, unaided | < 10 min, ≤ 2 rejections |

**The one that matters most is L1.2.** A language whose validator says PASS on a
file it silently mangled has no credibility, and we shipped exactly that for
months — `examples/code-review.at` used `prompt: "path.md"` on four agents,
pointing at a directory that never existed, and `validate()` reported it clean.
V89 closed that instance. The class is still open.

---

## Layer 2 — Tooling correctness

| # | KPI | Instrument | Baseline | Target |
|---|---|---|---|---|
| L2.1 | Type-clean | `npx tsc --noEmit`, exit code | ✅ 0 | 0 |
| L2.2 | Test count and pass rate | `npx vitest run` | ✅ **1467 / 1467** | 100%, count grows with surface |
| L2.3 | **Regression tests actually regress** | revert the fix, confirm the test fails | ✅ verified twice — settings merge (3 fail without it) and codex defaults (1 fails without it) | every bugfix test proven this way |
| L2.4 | Compile path stability | `git diff src/bindings/` after any non-binding change | ✅ empty | empty unless bindings are the subject |
| L2.5 | CLI has tests | `npx vitest run src/cli` | ✅ **17 tests** — real subprocess runs, so exit codes and arg guards are covered | ≥ 1 per command; grows with the surface |
| L2.6 | Docs drift | `CLAUDE.md` claims vs measured | ✅ refreshed: **1467 tests / 92 rules / 10 examples / 5 exporters**. Was 1141 / 82 / 5 / 2. | refreshed at each release |

---

## Layer 3 — Interpreted mode (the thesis under test)

The claim: **a host coding agent given a resolved topology produces better work
than the same agent given the same task in prose.** If that is false, this whole
direction is decoration.

| # | KPI | Instrument | Baseline | Target |
|---|---|---|---|---|
| L3.1 | **Brief is followable without guessing** | the ambiguity log itself | ⚠️ **8 in the first run**, 6 of them new to me. All 6 fixed. Re-measure on the next run. | ≤ 2 per run |
| L3.2 | **Return contract holds** | `outputs resolved: N by contract / M by scan / K by inference` in the closing report | ⏳ measuring | ≥ 80% by contract |
| L3.3 | **Blindness survives** | a blind role's output must contain no fact only its sibling had | ⏳ not yet instrumented | 0 leaks |
| L3.4 | **Brief size stays sane** | lines of brief ÷ number of roles | 347 lines / 4 roles ≈ **87 lines per role** | < 60, or a `--from-step` flag |
| L3.5 | **Ambiguity log yields fixes** | share of logged entries whose `fix:` is actionable | ✅ **8 of 8** in the first real run, and 6 became shipped code changes the same day | stays 100% |
| L3.6 | **Interpreted beats prose** | same task, two runs: brief-driven vs prose-driven, blind-judged | ⏳ **never run** | brief wins ≥ 2 of 3 |
| L3.7 | Scaffold still preferred where it should be | count runs that hit the §9 "needs scaffold" wall | ⏳ | wall is *named*, never silent — 100% |

**L3.6 is the honest test and it has not been run.** Everything else measures
whether the machinery works. Only L3.6 measures whether it was worth building.

---

## Layer 4 — Adoption

| # | KPI | Instrument | Baseline | Target |
|---|---|---|---|---|
| L4.1 | npm weekly downloads | `npm view agentopology` / npmjs stats | to measure | — |
| L4.2 | Topologies written by someone who is not Nadav | GitHub code search for `.at` files | to measure | > 0 is the whole game |
| L4.3 | **Second-hand use** — an `.at` file written by an agent, not a human | `.at` files whose git author is a Claude/Codex co-author trailer | 0 | > 0 |
| L4.4 | Time from `npm i` to a first working topology | onboarding walkthrough, timed | ⏳ | < 15 min |
| L4.5 | Issues that are *usage* questions vs *bug* reports | GitHub label ratio | — | usage > bugs means docs are the gap, not the code |

---

## The Phase 2 gate

Already decided: the context-flow grammar extension (what crosses an edge, what
an agent must be blind to — gaps **G1** and **G3** in
`docs/CONTEXT_FLOW_AUDIT.md`) is triggered by **the same ambiguity kind firing
three or more times within one session**, confirmed by hand into the audit doc.

**Precondition:** resolve **G4** first — `reads`/`writes` (free strings,
validated by nothing) and `produces`/`consumes` (ids, validated by V71) are two
unlinked handoff systems. A third must not land on an unreconciled two.

New candidate found by dogfooding the renderer on our own skill topology:
**`.at` cannot express "exactly one of".** A router renders identically to a
fan-out, because in the flow graph they are the same shape. `at-skill.at` shows
11 entry actions and 7 agents as one parallel step when exactly one runs.

---

## Anti-KPIs — what we deliberately do not optimise

Naming these stops them creeping in as accidental goals.

| Not a goal | Why |
|---|---|
| **Number of grammar keywords** | The value is constraint. `.at` becoming JavaScript with different punctuation is the failure mode, not the finish line. |
| **Number of supported patterns** | 101 concepts already outruns what anyone uses. Depth beats breadth. |
| **Replacing the host runtime** | Claude Code and Codex already spawn agents. We give them a language, not a competitor. |
| **Brief completeness** | A field that does not change what the host *does* is noise that costs tokens. Cut it. |
| **Making every gate hard** | A hard gate costs exactly one file on every vendor. That price should be paid deliberately, not by default. |

---

## Scoreboard, today

```
  LANGUAGE     ██████████  6 of 6 green
  TOOLING      ██████████  6 of 6 green
  INTERPRETED  ░░░░░░░░░░  0 of 7 measured — dogfood in flight
  ADOPTION     ░░░░░░░░░░  0 of 5 measured — pre-launch
  PRIORITY     ██████████  page written, every claim independently checkable
```

**Every red is closed.** The two that would have embarrassed us in public are
now guarded by tests rather than by vigilance: `spec-sync.test.ts` fails if the
spec and validator ever disagree again, and `defaults-agreement.test.ts` fails
if a binding drifts from the spec's defaults table.

Note on L1.4: the original finding said three bindings disagreed. Re-measuring
found **one**. openclaw falls back to the literal `"auto"`, but its
`mapPermissions` turns `"auto"` into `"autonomous"` — so it always agreed. Only
codex disagreed, and the consequence was real: an omitted `permissions` became
Codex `untrusted`, the strictest approval policy, rather than the `on-request`
the language says it means.
