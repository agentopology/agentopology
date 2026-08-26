# Context-Flow Audit — Step 1 of the Context-First Vision

> Output of Step 1 in `docs/AGENTOPOLOGY_CONTEXT_FIRST_VISION.md` §28.
> Question answered: **what context-flow semantics already exist in `.at` today,
> even if they are currently framed as scaffolding features?**
>
> Date: 2026-08-26 · Method: direct source read of `src/parser/ast.ts`,
> `src/parser/validator.ts`, `spec/grammar.md`, `spec/reserved-keywords.md`,
> all 8 bindings, and the `/at --run` skill path.
> No syntax was designed or added. This is evidence, not a proposal.

---

## Headline

The **data plane already exists and is larger than the vision document assumes.**
`artifacts {}` + `produces` / `consumes` is a shipped, parsed, validated,
binding-emitted implementation of what the vision doc sketches as an unbuilt
"Option C — explicit artifacts" (§16).

The real hole is not the node. It is **the edge**: `EdgeDef` carries twelve
fields and every single one is control plane. And there are **two unlinked
handoff systems** in the language that nobody has reconciled.

---

## 1. What already exists (context data plane)

| Primitive | Source | What of the vision it already covers | State |
|---|---|---|---|
| `reads` / `writes` | `src/parser/ast.ts:517-520`, `spec/grammar.md:354` | Runtime workspace paths as intentional handoff artifacts (§13). Emitted into agent prompts by claude-code, codex, copilot-cli, claude-workflow. | ✅ shipped |
| `artifacts {}` block | `src/parser/ast.ts:375-386` | Declared artifact with `type`, `path`, `retention`, `depends-on` lineage. | ✅ shipped |
| `produces` / `consumes` | `src/parser/ast.ts:604-607` | **This is vision §16 Option C, already built.** Agent-to-artifact binding by id. | ✅ shipped |
| V70 / V71 | `src/parser/validator.ts:2225-2280` | Artifact ids unique; `produces`/`consumes`/`depends-on` must reference declared artifacts. | ✅ shipped |
| `outputs` enum | `src/parser/ast.ts:17` (`OutputsMap`), V5 | Typed routing values consumed by `[when x.y]` edges. | ✅ shipped |
| `input-schema` / `output-schema` | `src/parser/ast.ts:600-603`, `SchemaFieldDef:173` | Structured typed I/O per agent. **Vision open question "should outputs remain routing-only enums?" (§30) is already answered — no, schemas exist.** | ✅ shipped |
| `memory` stores + `retrieval` | `StoreNode:279`, `RetrievalNode:349` | Per-agent selected knowledge, `scope`, `isolation: strict\|soft\|none`. | ✅ shipped |
| `retrieval.budget` | `src/parser/ast.ts:354` | **A token budget for retrieved context already exists in the language.** Vision §30 "context budgets" is half-answered. | ✅ shipped |
| `delegation: subagent \| inline` | `OrchestratorNode:475` | The fresh-context vs inherited-context switch — at topology granularity. | ✅ shipped |
| `custodian-of` / `custodian-does` | `src/parser/ast.ts:552-566` | Ownership of a knowledge store, distinct from read access. | ✅ shipped |
| `isolation: worktree` | `AgentNode` | Filesystem isolation. **Not context isolation** — easy to confuse, worth naming. | ✅ shipped |
| `context {}` top-level | `TopologyAST:903` | Only `file` + `includes`. Vision §14 is correct: this is a platform instruction file, unrelated to context flow. Confirmed by source. | ✅ shipped, different concern |

**Control plane, for contrast** — `EdgeDef` (`src/parser/ast.ts:725-751`) has:
`from`, `to`, `condition`, `maxIterations`, `per`, `isError`, `errorType`,
`tolerance`, `race`, `wait`, `weight`, `reflection`.

Twelve fields. Zero of them say anything about information.

---

## 2. What is missing (the actual gaps)

| # | Gap | Evidence | Why it matters |
|---|---|---|---|
| G1 | **The edge carries no context.** | `EdgeDef:725-751` — all 12 fields are ordering/failure/retry. | Vision §8 ("the arrow may be more important than the node") is entirely unbuilt. |
| G2 | **Default inheritance is undefined.** | `grep -n "inherit" spec/grammar.md` finds only the `model: inherit` value. Nothing states what agent B receives from agent A. | Vision §30 calls this "one of the most important defaults in the language". It is currently decided independently by each of 8 bindings. |
| G3 | **No exclusion, no blindness, no independence.** | `grep -i "blind\|independen\|exclude\|receives\|handoff" spec/grammar.md` → **zero hits**. MEASURED. | Vision §12 (information barriers) has no representation at all. A blind reviewer cannot be expressed. |
| G4 | **Two unlinked handoff systems.** | `reads`/`writes` are free string paths validated by nothing. `produces`/`consumes` are declared ids validated by V71. Neither knows about the other. | An author has two ways to say "hand this off" and the language never reconciles them. This is a language smell to resolve *before* adding a third. |
| G5 | **No handoff completeness rule.** | No V-rule cross-checks that what an agent `consumes` is `produce`d by a node upstream of it in `flow`. | Vision §30 "how do we know an agent produced the required context for its consumer?" — nothing checks it today. |
| G6 | **`reads`/`writes` never reach three bindings.** | `grep "\.reads" src/bindings/*.ts` hits claude-code, codex, copilot-cli, claude-workflow only. | The handoff is silently dropped on gemini-cli, kiro, openclaw, cursor. |

---

## 3. Where the project is further along than the vision doc assumes

**Interpreted mode already ships — but as a stub.**

`/at --run` routes to the `at-runner` agent
(`~/Projects/agent-topology/.claude/agents/at-runner/AGENT.md`, 917 bytes, opus,
has the `Agent` tool). Its instructions are:

> 1. Parse description: pattern, number of agents  2. Match to pattern
> (fan-out, pipeline, supervisor, debate, blackboard)  3. Design agent configs
> inline  4. Execute using Claude Code primitives  5. Synthesize  6. Offer to save

So it pattern-matches **prose**. It does **not** read a `.at` file, does not
honor `flow` ordering, does not use `reads`/`writes` as handoffs, does not route
on typed `outputs`, does not enforce `[max N]`.

That means vision §29 ("a powerful first milestone may require no grammar change
at all") has a **placeholder, not an implementation**. The experiment it calls for
has not actually been run.

**A related strategic call was already made.** `docs/AT_VS_WORKFLOW_STRATEGY.md`
(2026-05-30) concluded `.at` orchestrates the Claude Workflow tool rather than
competing with it, and already lists a pending grammar addition
`execution: workflow | host`. Any context-flow design has to sit alongside that,
not collide with it.

---

## 4. The two graphs, as they exist in source today

```
CONTROL PLANE (rich)                 CONTEXT PLANE (real, but node-attached only)

  EdgeDef                              AgentNode
   ├ condition   [when x.y]             ├ reads        → free path strings
   ├ maxIterations [max N]              ├ writes       → free path strings
   ├ per / race / tolerance             ├ consumes     → artifact ids (V71)
   ├ weight / wait                      ├ produces     → artifact ids (V71)
   ├ isError / errorType                ├ input-schema / output-schema
   └ reflection                         ├ memory[] / retrieval
                                        └ outputs (enum, routing only)

   A ──────────────► B                 A and B each declare what they touch.
   carries ordering.                    NOTHING declares what CROSSES.
   carries no information.
```

The gap is exactly the middle column: the edge is where a handoff contract would
live, and today it is empty.

---

## 5. Recommended reading of the evidence

1. **Do not add a keyword yet.** G4 (two unlinked handoff systems) must be
   resolved first, or a third system gets added on top of an unreconciled two.
2. **G2 is the highest-value single decision in the language** — stating the
   default inheritance rule costs no grammar and removes the largest ambiguity.
   It is a spec sentence, not a feature.
3. **G3 is the one thing genuinely unrepresentable** and is the clearest
   candidate for the "smallest extension that removes the highest-value
   ambiguity" (§28 Step 5) — but only after Step 3 produces real evidence.
4. **Step 3 has not actually been run.** Making `at-runner` truly interpret a
   `.at` file is the cheapest way to generate the ambiguity log the vision doc
   asks for in §28 Step 4.

---

## Appendix — verification state of each claim

| Claim | State | Instrument |
|---|---|---|
| 84 validation rules V1-V88 exist (V8, V12, V23, V24 absent from validator.ts) | MEASURED | `grep -oE '"V[0-9]{1,3}"' src/parser/validator.ts \| sort -u \| wc -l` → 84 |
| Grammar contains no blind/independent/exclude/receives/handoff | MEASURED | `grep -i` on `spec/grammar.md` → exit 1, zero hits |
| `EdgeDef` has 12 fields, all control-plane | MEASURED | `src/parser/ast.ts:725-751` read in full |
| `reads`/`writes` reach only 4 of 8 bindings | MEASURED | `grep -n "\.reads\|\.writes" src/bindings/*.ts` |
| `at-runner` does not parse `.at` | MEASURED | full read of its `AGENT.md` (917 bytes) |
| Test suite count (1141) | INFERRED | from `CLAUDE.md`; not re-run in this pass |
