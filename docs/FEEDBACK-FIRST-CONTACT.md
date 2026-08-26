# First-contact feedback — interpreted mode

> Source: a Fable session (`congreat-main`) that orchestrated ~20 agent lanes on a
> parse-engine epic, then wrote the remaining four days as
> `saturday-road.at` and ran `plan` / `validate` / `visualize` / `export`.
> Date: 2026-08-26. Package version at time of contact: `0.4.2`.

**Their verdict, unprompted:** the linter caught three real errors in the first
draft — a phase-vs-flow contradiction, an unbounded retry loop, and a missing
version. *"That is the tool earning its place."* The asks below are all about
**closing the loop between the plan, the run, and the next plan.**

That framing is the useful part. Everything they hit is downstream of one
absence: **a topology can describe intention, and cannot describe reality.**

---

## The bug — FIXED in 0.4.3

**Reported as:** the reachability walker flags nodes as unreachable when they are
fed only through the *second* root of a parallel fan-out.

**Actual cause — different, and worth knowing.** The fan-out was never the
problem; `start -> [a, b]` and everything under `b` resolves correctly, and there
is now a test pinning that. The culprit was the last line of their flow:

```
take6-staging -x-> oom-fix [max 2]
```

An **error edge pointing backward**. Back-edge detection skipped `-x->` edges,
but the ranker still received them — so Kahn saw a genuine cycle
(`oom-fix → take6-staging → oom-fix`), could not rank it, and dropped
**eleven downstream nodes** to depth −1. On a file that validates clean.

**Fix:** error edges are exception routes, not steps — a catch, not part of the
happy path — so they no longer contribute to ranking at all. Their full 13-step
road now renders. Regression test uses their exact shape and is verified to fail
without the fix.

---

## The seven asks, ranked by value over cost

| # | Ask | Exists today? | Cost | Verdict |
|---|---|---|---|---|
| 2 | Gate attached to many anchors | ⛔ `gate.after` is one string | **S** | **Do first** |
| 6 | `effort` beside `model` | ⛔ not in AST, not reserved | **S** | **Do first** |
| 7 | Edge schema compatibility check | ⚠️ schemas exist per agent; nothing compares them | **M** | Do — it is Phase 2's first honest step |
| 5 | Concurrency class across agents | ⚠️ `scale.max` is per-agent only | **M** | Do — safety, learned via a forced shutdown |
| 1 | Live-state overlay | ⛔ nothing | **L** | The real one. Needs design first. |
| 4 | Run results stamped back | ⚠️ `revision` is in the brief already | **M** | Follows from #1 |
| 3 | Callback contract as a field | ⚠️ mostly solved, wrong axis | **S** | Clarify before building |

### 2 — Gate roles: one ritual, many anchors

> *"My supervisor-verify ritual repeats after EVERY builder. I had to declare
> near-identical gates per lane."*

`gate.after` is a single string, so a shared ritual becomes N copies that drift.
`after: [a, b, c]` is backward-compatible and turns the ritual into a reusable
contract.

Not a patch: it touches the AST type, the parser, V13, the splicer in
`resolve/order.ts`, and every binding that compiles a gate to a hook matcher.
Half a day, and the best value-per-cost in this list.

### 6 — `effort` beside `model`

> *"Model is a string; modern routing also picks an effort tier."*

Correct, and the omission is arbitrary — the host's Agent tool accepts `effort`,
and `.at` exists to declare exactly this kind of routing decision. One AST field,
one parser line, one reserved keyword, plus binding emission. Small and obviously
right.

### 7 — Prove the dataflow instead of drawing it

> *"validate should check that a producer's `outputSchema` satisfies the
> consumer's `inputSchema` on every edge, and report the diff."*

This is the most interesting ask in the list, because it is **exactly the
direction `docs/CONTEXT_FLOW_AUDIT.md` identified as gap G1**: the edge carries
no information today, all twelve of its fields are control-plane. Schemas already
exist on both ends; nothing compares them. That comparison is a new validation
rule and needs no grammar change at all.

It is also the same shape as every bug fixed on 2026-08-26: a value declared in
two places with nothing checking that they agree.

### 5 — Concurrency caps that span agents

> *"Max 2 test-running builders concurrently — learned via a forced shutdown."*

`ScaleDef` has `min`/`max`, but those bound instances **of one agent**. There is
no way to say "these three agents share a budget of 2". A `concurrency-class`
that `plan` respects when ordering parallel branches would make the ordering safe
by construction.

The docs point stands regardless: `agentopology docs scale` should show what
`max` actually bounds, because reading it as a machine-wide cap is a natural and
expensive mistake.

### 1 — The file cannot say "we are HERE"

> *"My topology described a run already in flight. Mid-run replanning is the
> whole point of interpreted mode."*

This is the deepest ask and the one that needs design before code. A topology is
a plan; a run is a fact; today nothing connects them. With per-node state,
`plan` could emit only the remaining steps and `visualize` could render reality
against intention.

**Design question to settle first:** does state live *in* the `.at`, or in a
sidecar keyed by revision? In the file is readable and diffable, and makes every
run mutate the artifact. A sidecar keeps the topology a clean statement of
intent, at the cost of two files to reason about.

The sidecar reading is probably right, and it merges with #4: one run record per
revision, holding node states, gate verdicts and measured outcomes. A plan that
remembers its runs becomes a lab notebook rather than a blueprint — their phrase,
and a good one.

### 3 — Callback contract: mostly solved, on a different axis

> *"Twice a lane finished and reported in PROSE instead of a message send, and
> the report evaporated."*

The brief already requires every sub-agent to end with a fenced ` ```at-output `
block, resolves it in three tiers (contract → transcript scan → inference), logs
any fallback, and **stops the run outright if the very first sub-agent fails the
contract** — the canary rule. So "reported in prose" is already a detected
violation.

What is genuinely missing is the **channel**: the brief says what the shape must
be, never where it must be sent. `callback: sendmessage` is a small addition once
we agree it belongs to the agent rather than the edge.

Worth checking with them whether the canary and the `at-output` contract already
close their case in practice — the loss they describe reads like a run that
predates the brief, not one the brief permits.

---

## What this feedback changes about the roadmap

Phase 2 was scoped as *"what crosses an edge, and what an agent must be blind
to"*, triggered by recurring ambiguities. This report adds a third axis nobody
had named: **the plan cannot see the run.**

Five of seven asks (#1, #3, #4, #5, #7) are all one sentence underneath —
*the file describes intention and has no vocabulary for what actually happened.*
That is a bigger and more concrete direction than the context-contract work, and
it arrived from someone using the tool for real on the first day it existed.

**Ask #7 is the bridge.** It is Phase 2 context work, it needs no grammar change,
and it is the first place a topology would prove something about a run rather
than assert something about a plan.

---

# Design decisions — 2026-08-26

Settled with Nadav in a grill round. Two of my own recommendations were wrong
and he killed them; both retractions are recorded below because the reasoning
matters more than the conclusion.

## 1. Run state is DERIVED from evidence, not stored

**Rejected: a `team.run.json` sidecar.** I proposed it and Nadav refused it, in
his words: *"if you're a coding agent you already know where you stand — you're
committing stuff. Another JSON is another point of failure, another thing to
back up, another thing to maintain."*

He is right, and the reason is stronger than convenience. A topology **already
declares what each role writes**. Whether those files exist on disk *is* the run
state. `plan` already stat()s preconditions; extending that to every declared
`writes` path gives progress for free.

| Derived from disk | Stored in a sidecar |
|---|---|
| no new artifact | another file to back up |
| cannot disagree with reality | can go stale |
| works if a human did step 3 | only knows what it was told |
| delete the file → step is pending again | stamp survives, work doesn't |
| **evidence** | **testimony** |

The last row decides it. A sidecar records *"I finished"*. The filesystem
records *"the artifact exists"*. Only one of those survives a crash between
stamping and writing.

**Measured:** 31 of 44 agents (70%) across 11 real topologies declare `writes`.
The rest are genuinely undecidable, and `plan` must say so rather than guess.

**Also rejected: `status:` fields in the `.at`.** They make the file mutate every
run, fill git diffs with run noise, force `scaffold` to ignore a region of the
language, and make the same team produce different files. The invariant holds:
**a `.at` never contains a fact about a specific run.**

**Shape:** `plan` reports per step — outputs present, outputs missing, or
undecidable — and stops. No `--resume`, no mode. The agent reads that beside
`git log` and decides where to start, which is what it would do anyway. This
also dissolves ask #4: there is no run-history artifact, because there is no run
artifact.

## 2. The dataflow check is on `reads`/`writes`, not schemas

**Retracted: my "edge schema compatibility is Phase 2's first honest step".**
Measured across 12 real topologies: **0 of 43 agent-to-agent edges have schemas
on both ends**, and **0 of 10 examples declare a schema at all**. The rule would
never have fired.

`reads`/`writes` appear on nearly every agent and are validated by nothing. A
rule that flags an edge where the writer's `writes` and the reader's `reads` do
not overlap fires on real files immediately. `plan` already computes this as a
pre-flagged ambiguity; promoting it to a validation rule makes it work under
`scaffold` too.

## 3. One-backend vocabulary is allowed, and must declare itself

`#5` (concurrency class) and `#3` (callback channel) can never be enforced by
`scaffold`. They are still allowed — but every such field appears in the brief's
§8 "declared but not enforceable" table on the backend that cannot honour it.
The precedent exists and works: that table already carries per-agent tool grants.

The language stays expressive. The gap is always visible, never silent.

## 4. Multi-anchor gates: build it

`after: [a, b, c]` means one gate declared once, firing after each named node
independently — N hook entries from `scaffold`, N splice positions in `plan`.

Explicitly **not** an agent-side capability: the agent sees the same thing either
way. The value is that their four-step verification ritual, copied across twenty
lanes, cannot drift — and the whole point of a verification ritual is that it is
identical everywhere.

## Still open

- **#6 `effort` beside `model`** — small and obviously right, not formally
  decided. The host's Agent tool accepts it and `.at` exists to declare exactly
  this kind of routing choice.
- **#3 callback channel** — allowed by decision 3, but check with the reporter
  first whether the `at-output` contract and the canary rule already cover the
  loss they described. Their case reads like a run that predates the brief.

## Build order

1. Derived run state in `plan` (per-step evidence line) — no new vocabulary
2. `reads`/`writes` edge rule — no new vocabulary
3. Multi-anchor gates — small grammar change
4. `effort` field — small grammar change
5. Concurrency class — needs its scope settled first

The first two need no grammar change at all, which is the right way in.
