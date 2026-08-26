# Prior art — AgenTopology and "graph engineering"

**The claim, stated narrowly:** AgenTopology shipped a public, versioned,
declarative language for agent topologies **four months before the term "graph
engineering" existed** for that practice.

**What this page does not claim:** we did not coin the term. We had never heard
it. LangGraph, AutoGen and Google ADK were also doing graph orchestration before
the vocabulary arrived. The narrow claim is the checkable one, and it is enough.

---

## Check it yourself in 60 seconds

Nothing below requires trusting us. Every line is a public record.

```bash
# When was the package first published? A registry timestamp nobody can edit.
npm view agentopology time

#   "0.1.0": "2026-03-19T09:23:06.787Z"

# When was the repository created?
gh repo view agentopology/agentopology --json createdAt,visibility

#   {"createdAt":"2026-03-11T22:51:18Z","visibility":"PUBLIC"}

# What did the first commit say?
git -C <clone> log --reverse --format="%ad  %s" --date=short | head -1

#   2026-03-12  Initial commit — Agentopology open-source language standard
```

Then search for when "graph engineering" started being used for AI agent
architecture. The earliest widely-circulated pieces are **July 2026**.

| Event | Date | Public record |
|---|---|---|
| Skill repo, first commit | 2026-03-10 | git history |
| GitHub repo created, public | 2026-03-11 | GitHub API |
| Package repo, first commit | 2026-03-12 | git history |
| **`agentopology@0.1.0` on npm** | **2026-03-19** | **npm registry — immutable** |
| `0.2.0` | 2026-03-25 | npm registry |
| `0.3.0` | 2026-06-16 | npm registry |
| "graph engineering" enters circulation | **2026-07** | search record |

The npm entry is the load-bearing one. A git history can be rewritten. A
registry publish timestamp cannot.

---

## The term's definition, and what `.at` already was

The working definition that circulated in July 2026:

> Designing the topology of an AI system as an **explicit, versioned artifact**
> instead of letting it emerge from whatever code you happened to write. Nodes
> represent agents, edges represent control-flow transitions and routing logic,
> and shared state flows along the edges.

Line by line against `.at` as published in March:

| The definition says | `.at` had, in `0.1.0` |
|---|---|
| explicit, versioned artifact | a `.at` file with a `meta { version }`, committed to git, diffable, reviewable |
| nodes represent agents | `agent`, `action`, `gate`, `human`, `group`, `orchestrator` node types |
| edges represent control flow and routing | `flow { a -> b [when x.y == v, max 2] }` — conditions, bounded loops, fan-out, error edges |
| shared state flows along the edges | `memory { workspace }` plus per-agent `reads` / `writes` |

The vocabulary was new. The artifact was not.

---

## The part that is genuinely ahead

The field's own framing of graph engineering splits it into **execution graphs**
and **context graphs** — the control flow, and the information flow.

`docs/AGENTOPOLOGY_CONTEXT_FIRST_VISION.md` makes exactly that split, and states
it as the project's direction:

> **The graph is the control plane. Context is the data plane.**
>
> Who works, when they work, and what they know when they work.

That document came out of noticing the gap while using the language, not out of
reading a definition. And the audit that followed
(`docs/CONTEXT_FLOW_AUDIT.md`) found the honest state of it: `EdgeDef` carries
twelve fields and **all twelve are control plane**. The data plane exists on the
nodes — `reads`, `writes`, `artifacts`, `produces`, `consumes`, typed
`input-schema` / `output-schema` — but nothing yet describes what *crosses* an
edge, or what an agent must be *blind* to.

So the honest position is not "we solved graph engineering first." It is:

- we shipped the **execution graph** as a portable declarative artifact in March,
  with eight compile targets;
- we identified the **context graph** as the harder half and wrote down why;
- and we are building it from run evidence rather than from theory — every
  interpreted run logs where the host had to guess, and each log entry carries a
  concrete `.at` edit that would remove the guess.

That is a roadmap with receipts, which is worth more than a naming claim.

---

## What "already practising it" actually looks like

Not a slogan. Concrete, in the repo, before the term:

| Capability | Since |
|---|---|
| 90 static validation rules over the graph (V1-V90) | growing since 0.1.0 |
| Bounded loops enforced (`V6` — every back-edge needs `max N`) | 0.1.0 |
| Typed routing on agent outputs (`[when x.verdict == approve]`) | 0.1.0 |
| Eight compile targets from one file | 0.2.x |
| Artifact lineage (`artifacts` + `produces` / `consumes`, V70/V71) | 0.2.x |
| Interactive graph visualiser | 0.2.x |
| Agent memory stores and retrieval strategies | 0.3.0 |
| Interpreted execution — no compilation required | this branch |

A language that refuses an unbounded loop and refuses a router whose enum has an
uncovered case is doing graph engineering whether or not the phrase exists.

---

## How to use this page

Link it. Do not paraphrase it into a stronger claim. The sentence that survives
scrutiny is:

> AgenTopology published a declarative agent-topology language to npm on
> 2026-03-19, four months before "graph engineering" became the name for that
> practice.

Anything larger invites a correction that costs more than the claim was worth.
