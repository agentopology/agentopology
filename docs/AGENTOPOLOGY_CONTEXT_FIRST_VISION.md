# AgenTopology — Context-First Agent Orchestration

> **Working vision document for the coding agent maintaining AgenTopology**
>
> Status: design direction / product thesis, not a finalized language proposal  
> Date: 2026-08-26

---

## Why this document exists

AgenTopology started from a strong idea: describe an agent organization once, in a human-readable `.at` file, and make that topology portable across agent platforms.

The project already has a real language, parser, validation rules, bindings, visualization, agent definitions, flows, gates, memory, tools, `reads`, `writes`, typed `outputs`, and platform targets.

The new realization is that `.at` may be more fundamental than the compilation/scaffolding model it was originally built around.

Modern coding agents such as Claude Code and Codex are already capable of:

- planning complex work,
- spawning subagents dynamically,
- giving different subagents different instructions,
- running agents in parallel or sequence,
- asking one agent to validate another,
- retrying or changing direction,
- using files and artifacts as shared state,
- and changing the plan while execution is already in progress.

Because the host coding agent can already act as the orchestrator, **AgenTopology does not need to compile anything in order to be useful at runtime.**

A `.at` topology can instead become the structured operational plan shared between the human and the lead agent.

And once we take that seriously, a second and even more important realization appears:

> **The real problem is not only the topology of agents. It is the topology of context.**

The highest-leverage question in an agent system is not merely:

> Who runs after whom?

It is:

> **Who knows what, at what moment, from whom, in what form, and what are they expected to produce for the next agent?**

That is the direction this document explores.

---

# 1. The thesis

## One-sentence version

**AgenTopology should become a portable language for expressing how agents collaborate — including the control flow of work and the context flow of information — whether the topology is persistent or created ephemerally for a single task.**

## Even shorter

> **Who works, when they work, and what they know when they work.**

That may be the essence of `.at`.

---

# 2. Context is king

The quality of an LLM agent is heavily determined by its context.

A capable model with the wrong context can perform badly.

A smaller or less capable model with the right context can often perform surprisingly well.

In a multi-agent system, context becomes an architecture problem.

We need to reason about:

- what enters an agent's context,
- what should not enter it,
- which files it can read,
- which previous outputs it receives,
- whether it sees another agent's reasoning or only its artifact,
- whether two agents should remain independent,
- what form the previous agent's result should take,
- how much context is carried forward,
- which state must persist,
- which state should be discarded,
- and what the next agent actually needs to make a good decision.

The naive multi-agent pattern is:

```text
Agent A
  ↓
dump everything
  ↓
Agent B
  ↓
dump everything
  ↓
Agent C
```

That is not orchestration. It is uncontrolled context inheritance.

A better model is:

```text
Agent A
  │
  │ produces a deliberate handoff
  ▼
Artifact / structured result
  │
  │ selected as input
  ▼
Fresh Agent B context
```

The context boundary is intentional.

The handoff is designed for the receiver.

The next agent does not automatically inherit the entire history of the previous agent.

This is extremely similar to how a well-run company operates.

A company is not effective simply because it has talented people connected by an org chart. It is effective when the right person receives the right information, at the right abstraction level, at the right moment, with a clear expected output.

Agent systems should work the same way.

---

# 3. The major shift: `.at` does not need to compile in order to run

The original mental model is approximately:

```text
.at
 ↓
parse + validate
 ↓
binding
 ↓
generate platform files
 ↓
Claude Code / Codex / Cursor / ...
 ↓
execution
```

This remains useful and should continue to exist.

But it should no longer be assumed to be the only important lifecycle.

A second mode is possible:

```text
Human
  ↕
Lead coding agent
  ↕
task.at
  ↓
Lead agent interprets topology
  ↓
Native ephemeral subagents
  ↓
Work / artifacts / validation
```

No compilation is necessary.

No `.claude/agents/*` files need to be generated.

No `.codex/*` topology needs to be materialized.

No custom AgenTopology execution engine is required.

**The host coding agent is already the runtime.**

The `.at` file becomes the structured plan that tells the host agent how to organize the work.

---

# 4. `.at` as a shared planning artifact

Consider a conversation with a coding agent.

The human says:

> Redesign authentication. Research the current architecture first, have an independent security review, propose a design, implement it, and validate it.

Today, the lead model may plan this internally or explain the plan in prose.

Instead, it could create a topology:

```at
topology auth-redesign : [pipeline] {

  agent codebase-researcher {
    model: inherit
    description: "Understand the current authentication architecture"
  }

  agent security-researcher {
    model: inherit
    description: "Identify security risks and relevant constraints"
  }

  agent architect {
    model: inherit
    description: "Produce the proposed architecture"
  }

  agent builder {
    model: inherit
    description: "Implement the approved design"
  }

  agent validator {
    model: inherit
    description: "Independently validate the result"
  }

  flow {
    [codebase-researcher, security-researcher] -> architect
    architect -> builder -> validator
  }
}
```

The exact syntax above is less important than the interaction model.

The `.at` file becomes the object between the human and the agent.

The human can inspect the plan and say:

- remove the security researcher,
- run two architects independently,
- add a product reviewer,
- make validation blind,
- do not give the implementer the raw research transcript,
- give the validator only requirements + diff + tests,
- let the architect see the two research briefs,
- retry implementation once if validation fails.

The lead agent modifies the topology.

Then the human says:

> Execute it.

The host agent uses its native orchestration/subagent capabilities to enact the topology.

This is important:

> **`.at` is not competing with Claude Code or Codex orchestration. It gives those systems a language for describing orchestration.**

---

# 5. The topology can be ephemeral

A `.at` file does not have to describe a permanent team.

It may exist only for a task.

Possible lifecycle:

```text
User intent
   ↓
discussion with lead agent
   ↓
temporary .at topology
   ↓
human reviews / edits
   ↓
lead agent executes topology
   ↓
topology evolves if reality changes
   ↓
task completes
   ↓
discard topology
```

If the topology turns out to be generally useful:

```text
temporary topology
   ↓
"save this workflow"
   ↓
persistent repository topology
```

So persistence should be a choice, not an assumption.

This gives us at least three valid usage modes:

| Topology | Workers | Use case |
|---|---|---|
| Persistent | Materialized/persistent | Stable reusable agent team |
| Persistent | Ephemeral | Reusable workflow, fresh workers per run |
| Ephemeral | Ephemeral | Task-specific delegation plan generated and executed on the fly |

All three should be compatible with the same conceptual language.

---

# 6. Agent definitions are roles; executions are ephemeral workers

In interpreted execution, this:

```at
agent reviewer {
  model: inherit
  description: "Review the implementation for correctness and architectural issues"
}
```

does not need to mean:

> A persistent entity called `reviewer` must exist.

It can mean:

> When this role is needed, instantiate a fresh subagent that fulfills this contract.

Conceptually:

```text
Agent role definition
      │
      ├── Reviewer execution #1 → finish → disappear
      ├── Reviewer execution #2 → finish → disappear
      └── Reviewer execution #3 → finish → disappear
```

This separation is useful:

### Durable

- topology,
- role definitions,
- artifacts,
- decisions,
- execution state if needed,
- memory that is intentionally persistent.

### Ephemeral

- individual model contexts,
- subagent instances,
- scratch reasoning,
- temporary tool state.

A useful phrase for the architecture is:

> **Ephemeral agents, intentional state.**

---

# 7. There are really two graphs

AgenTopology currently makes the control topology easy to see.

Example:

```text
CONTROL GRAPH

researcher → architect → builder → reviewer
                           ↑          │
                           └──────────┘
```

But every useful agent organization also has a second graph.

```text
CONTEXT GRAPH

task ───────────────→ researcher
requirements ───────→ researcher

research.findings ──→ architect
requirements ───────→ architect

architecture ───────→ builder
relevant code ──────→ builder
requirements ───────→ builder

requirements ───────→ reviewer
implementation diff ─→ reviewer
test output ─────────→ reviewer
```

These graphs are related, but they are **not the same graph**.

An execution edge:

```text
A → B
```

should not automatically imply:

> B inherits everything A saw, thought, said, or produced.

It should mean:

> B executes after A, and the topology determines what information is available to B.

This may be the most important conceptual addition to AgenTopology.

---

# 8. The arrow may be more important than the node

The language naturally makes agents feel like the primary object:

```at
agent researcher { ... }
agent architect { ... }
```

But in a context-first model, the edge may become equally important.

```text
researcher ─────────────► architect
             handoff
```

That handoff potentially represents:

- ordering,
- dependency,
- delegation,
- context selection,
- artifact passing,
- structured output,
- transformation,
- information hiding,
- validation requirements,
- retry semantics.

The agent describes a role.

The edge describes the **contract between roles**.

That contract is how an organization becomes predictable.

---

# 9. Context contracts

A key concept worth introducing at the design level is a **context contract** or **handoff contract**.

A context contract answers:

1. What does the receiving agent need?
2. Where does that information come from?
3. In what form should it arrive?
4. What should be intentionally excluded?
5. What is the sender required to produce?
6. Which parts are durable artifacts versus transient state?
7. Is the receiver supposed to be independent/blind?
8. What happens if the handoff is incomplete?

A context contract should make ambiguity visible.

For example:

```text
builder → validator
```

is underspecified.

A better semantic description is:

```text
Validator receives:
  ✓ original task
  ✓ acceptance criteria
  ✓ implementation diff
  ✓ test output

Validator does not receive:
  ✗ builder's chain of thought
  ✗ builder's confidence
  ✗ builder's self-review
  ✗ irrelevant research history

Validator produces:
  - verdict
  - failed criteria
  - concrete evidence
  - required corrections
```

This gives us a real information boundary.

---

# 10. Outputs should be designed for the receiver

The agent that produces information should not simply summarize what it did.

It should produce what the next role needs.

For example, a security researcher may produce:

```text
{
  threats,
  affected_components,
  evidence,
  constraints,
  recommendations,
  unresolved_questions
}
```

Why those fields?

Because the architect needs them.

This reverses the planning process.

Instead of:

```text
"We need a researcher."
```

the planning agent should think:

```text
What does the architect need to decide well?
        ↓
What information is missing?
        ↓
Who should create that information?
        ↓
What exact output should that worker produce?
        ↓
What should remain hidden or discarded?
```

That is much closer to context engineering than traditional multi-agent prompting.

---

# 11. Fresh context is a feature

A common assumption is that losing context is bad.

That is too simplistic.

**Uncontrolled context loss is bad.  
Uncontrolled context inheritance is also bad.**

A fresh subagent can be superior when it receives a precise handoff.

Bad:

```text
80k-token implementation session
        +
review instructions
        ↓
review
```

Better:

```text
requirements ───┐
diff ───────────┼──→ fresh reviewer context
tests ──────────┘
```

The reviewer may have far fewer tokens, but a higher signal-to-noise ratio.

This suggests a strong default principle:

> **Prefer fresh contexts connected through intentional artifacts over giant inherited conversations.**

Not as an absolute rule, but as an architectural default.

---

# 12. Independent agents require information barriers

Some agent topologies only work if workers are genuinely independent.

Examples:

- two agents propose solutions independently,
- a reviewer should not be biased by the builder's explanation,
- a judge should compare outputs without knowing which model produced them,
- red-team and blue-team agents need controlled visibility,
- multiple researchers should not anchor each other before synthesis.

AgenTopology should eventually be able to represent this intent.

Conceptual examples:

```text
independent
blind
artifact-only
shared
summarized
full
```

These are **concepts**, not finalized syntax.

For example:

```text
researcher-a ─┐
              ├─→ synthesizer
researcher-b ─┘
```

may mean:

- both researchers receive the original task,
- neither researcher receives the other's work,
- the synthesizer receives both final reports,
- the synthesizer does not receive the researchers' internal scratch context.

That is a meaningful topology property.

---

# 13. Current AgenTopology already contains part of this idea

Before changing anything, preserve what already works.

The current language already has several concepts related to context and handoffs:

## `reads`

Agents can declare runtime input artifacts.

```at
reads: ["workspace/research.md"]
```

## `writes`

Agents can declare runtime output artifacts.

```at
writes: ["workspace/design.md"]
```

## `outputs`

Agents can expose typed values that affect flow.

```at
outputs: {
  verdict: approve | revise | reject
}
```

## `memory` / retrieval

Agents can be given selected persistent knowledge sources.

## `flow`

The language already models ordering, conditions, retries/loops, fan-out, and other orchestration structure.

## Agent context isolation

The current grammar/runtime model already recognizes separate agent context windows in relevant orchestration modes.

These concepts are not mistakes or obsolete ideas.

They are evidence that the language already contains the beginnings of a context-flow model.

---

# 14. Important distinction: the current `context {}` block is not this

Do not conflate this new idea with the existing topology-level `context` block.

Today, `context {}` is used for binding/platform instruction files such as a generated `CLAUDE.md`, `CODEX.md`, etc.

For example:

```at
context {
  file: "CONTEXT.md"
  includes: ["docs/architecture.md", "docs/conventions.md"]
}
```

That is useful, but it is a different concern.

It defines broad platform/topology instructions.

What this document calls **context flow** means:

> the precise information available to a specific agent execution and the information passed across a specific handoff.

The naming may eventually need careful thought so we do not overload `context`.

---

# 15. Do not jump directly into syntax design

The coding agent should **not** read this document and immediately add `inputs`, `passes`, `receives`, `excludes`, or other keywords to the grammar.

First determine the semantic model.

The important questions are:

- What is the smallest useful context contract?
- Which existing `reads`, `writes`, and `outputs` semantics already solve part of it?
- Should handoff semantics live on agents, edges, artifacts, or some combination?
- How should a host agent interpret the contract?
- Which constraints are advisory versus deterministic?
- What can remain implicit without creating harmful ambiguity?
- How do we preserve readability?
- How do we preserve backward compatibility?
- How do we avoid turning `.at` into a general-purpose workflow language?

Only after those questions are answered should syntax be selected.

---

# 16. Conceptual syntax sketches — NOT proposals

The following examples exist only to clarify semantics.

They are **not valid current AgenTopology syntax** and should not be implemented blindly.

## Option A — role-centric inputs/outputs

```at
agent researcher {
  receives: [task, requirements]

  produces: {
    findings: artifact
    risks: artifact
  }
}

agent architect {
  receives: [
    task,
    requirements,
    researcher.findings,
    researcher.risks
  ]
}
```

## Option B — edge-centric handoff

```at
flow {
  researcher -> architect [
    pass: [findings, risks]
  ]

  architect -> builder [
    pass: [design, decisions]
  ]

  builder -> validator [
    pass: [diff, tests]
  ]
}
```

## Option C — explicit artifacts

```at
artifact research-brief {
  produced-by: researcher
  consumed-by: architect
}

artifact implementation {
  produced-by: builder
  consumed-by: validator
}
```

The correct design may combine pieces of these, or may need none of them if existing primitives can be extended cleanly.

The semantic target matters more than the surface syntax.

---

# 17. Interpreted topology vs enforced topology

There is an important distinction between a topology interpreted by a coding agent and a topology enforced by a deterministic runtime.

Suppose `.at` says:

```at
reviewer -> builder [when reviewer.verdict == revise, max 2]
```

If an AgenTopology execution engine runs this, `max 2` can be a hard guarantee.

If Claude Code or Codex reads the file and orchestrates natively, the topology is closer to an operational contract:

> Follow this flow and do not exceed two revision cycles.

That distinction should remain explicit.

## Interpreted mode

```text
.at
 ↓
Claude Code / Codex reads it
 ↓
lead agent enacts topology with native capabilities
```

Properties:

- extremely low infrastructure,
- flexible,
- topology can change on the fly,
- works with existing coding agents,
- some semantics are followed by the host agent rather than mechanically enforced.

## Enforced mode

```text
.at
 ↓
deterministic topology engine
 ↓
runtime adapter
 ↓
agents
```

Properties:

- hard limits,
- reproducibility,
- stronger guarantees,
- more infrastructure.

The existence of interpreted mode does **not** require building enforced mode now.

In fact, interpreted mode may be the fastest way to discover which semantics are actually useful.

---

# 18. Do not overbuild the runtime

A critical design warning:

**Do not immediately build a new AgenTopology runtime just because `.at` is now useful during execution.**

Claude Code, Codex, and similar systems already:

- understand natural-language instructions,
- spawn workers,
- use tools,
- manage subagent contexts,
- execute in parallel,
- inspect outputs,
- retry,
- and change plans.

The first opportunity is to make `.at` a better **shared orchestration language for those existing runtimes**.

A dedicated runtime may still be valuable later for deterministic enforcement, observability, cost control, or production workflows.

But it should be a separate decision.

The new thesis is valuable even if no new runtime is ever written.

---

# 19. The lead agent should be allowed to modify the topology

Real work changes after execution begins.

Example:

Initial plan:

```text
research → implement → review
```

During research, the lead agent discovers an undocumented legacy dependency.

Updated plan:

```text
research
   ↓
legacy-investigator
   ↓
implement
   ↓
review
```

The topology should be capable of evolving.

This suggests another useful distinction:

```text
planned topology
       ↓
execution
       ↓
actual/evolved topology
```

For ephemeral interpreted mode, mutation is likely a feature.

But mutation should not become invisible.

A good convention could be:

- material topology changes should be reflected in `.at`,
- the lead agent should state why the topology changed,
- the human should be able to inspect the new structure,
- high-risk structural changes may require human approval,
- the final topology can optionally become part of the execution record.

Again: design semantics first; implementation later.

---

# 20. Context should be observable

If context flow becomes first-class, AgenTopology can eventually provide something more useful than an agent graph.

It can show a **context topology**.

Example:

```text
researcher
  input:  task + docs + 12 files
  output: research-brief
             │
             ▼
architect
  input:  task + requirements + research-brief
  output: design + decisions
             │
             ▼
builder
  input:  design + selected code paths
  output: diff + tests
             │
             ▼
validator
  input:  requirements + diff + tests
```

At runtime, this could eventually become observable:

```text
researcher
  input:  12.4k tokens
  output: 3.1k tokens

architect
  input:   8.7k tokens
  output:  2.4k tokens

builder
  input:  14.2k tokens
  output: diff + tests

validator
  input:   9.3k tokens
```

This would let developers ask:

- Why are we passing 50k tokens here?
- Why can this worker see the entire repo?
- Why did an independent researcher receive another researcher's conclusion?
- Why does the validator see the builder's narrative?
- Which piece of required information disappeared at this boundary?
- Which handoff consistently produces retries?
- Where are we paying for context that provides no value?

That is a real debugging surface for agent systems.

---

# 21. Context topology may matter more than model topology

A useful hypothesis for the project:

> **For many agent systems, improving information routing will produce more benefit than adding more agents or choosing larger models.**

This should influence the product.

Do not optimize first for:

- maximum number of agent patterns,
- maximum runtime features,
- maximum provider-specific options,
- maximum DSL expressiveness.

Optimize for:

- clear roles,
- clear handoffs,
- minimal ambiguity,
- intentional context boundaries,
- visible inputs and outputs,
- receiver-oriented artifacts,
- independent validation,
- inspectable control flow.

The language should help humans and agents answer:

> Why does this agent have this information?

If the answer is unclear, the topology is incomplete.

---

# 22. A company is an information-routing system

The company analogy is not just marketing language.

It is architecturally useful.

A real organization has:

- roles,
- authority,
- responsibilities,
- handoffs,
- documents,
- meetings,
- information access,
- escalation paths,
- review processes,
- decision rights,
- persistent institutional memory,
- temporary working groups.

The org chart is only one view.

The operational organization is the movement of information and decisions between people.

AgenTopology can model the agent equivalent.

```text
ROLE
 ↓
receives relevant information
 ↓
does bounded cognitive work
 ↓
produces an intentional work product
 ↓
passes it to the next role
```

The goal is not to simulate a company theatrically.

The goal is to borrow a proven principle:

> **Specialization works only when handoffs work.**

---

# 23. North-star example

The following is a conceptual example of the experience we want.

The human says:

> Implement the new billing retry system. First understand the existing billing architecture and Stripe integration. Have an independent failure-mode researcher. Let an architect synthesize both. Then implement. Finally, have a fresh validator review requirements, diff, tests, and failure cases without seeing the builder's self-assessment.

The lead agent creates or proposes a topology.

Conceptually:

```text
                         original task
                              │
                ┌─────────────┴─────────────┐
                ▼                           ▼
      codebase researcher          failure-mode researcher
                │                           │
       architecture brief             risk brief
                └─────────────┬─────────────┘
                              ▼
                          architect
                              │
                 design + acceptance criteria
                              │
                              ▼
                           builder
                              │
                        diff + tests
                              │
                              ▼
                          validator
```

Context rules:

### Codebase researcher

Receives:

- task,
- relevant repository access,
- architecture docs.

Produces:

- current architecture,
- integration points,
- affected files,
- unknowns.

### Failure-mode researcher

Receives:

- task,
- requirements,
- public/domain knowledge if needed.

Does **not** receive:

- conclusions from the codebase researcher.

Produces:

- failure modes,
- edge cases,
- validation scenarios.

### Architect

Receives:

- original task,
- both research artifacts.

Produces:

- implementation design,
- decisions,
- acceptance criteria,
- files/components likely to change.

### Builder

Receives:

- original task,
- architecture,
- acceptance criteria,
- selected repository context.

Produces:

- implementation,
- tests,
- machine-observable test results.

### Validator

Receives:

- original requirements,
- acceptance criteria,
- diff,
- test results,
- failure-mode checklist.

Does **not** receive:

- builder confidence,
- builder self-review,
- unnecessary implementation-session transcript.

Produces:

- pass/fail verdict,
- evidence,
- failed criteria,
- exact required corrections.

If validation fails, the lead agent can route the structured validator result back to a fresh or resumed builder according to the topology.

This is context-first orchestration.

---

# 24. Design principles for future AgenTopology work

Any evolution in this direction should preserve these principles.

## 1. Human-readable

A non-expert should be able to understand the topology.

## 2. Agent-readable

A capable coding agent should be able to interpret the topology directly without a proprietary runtime.

## 3. Parseable

The language should remain deterministic and mechanically inspectable.

## 4. Vendor-neutral

The semantic model should not depend on Claude Code, Codex, Gemini, or another provider.

## 5. Context-explicit

Important information boundaries should be representable rather than hidden inside prompts.

## 6. Minimal ambiguity

The language should reduce uncertainty about what enters and exits a worker.

## 7. Receiver-oriented handoffs

Outputs should be designed around what downstream roles need.

## 8. Fresh-context friendly

A topology should work naturally with ephemeral agent instances.

## 9. Persistence-agnostic

A topology may live for years or for ten minutes.

## 10. Compilation remains optional

Existing bindings and scaffolding stay useful. Interpreted execution adds a mode; it does not invalidate the old one.

## 11. Runtime optionality

Do not require developers to adopt an AgenTopology execution engine merely to benefit from `.at`.

## 12. Observable by design

The semantic model should make future visualization and debugging of context flow possible.

## 13. Constraints over cleverness

`.at` should remain a domain language for agent organization, not become JavaScript with different punctuation.

---

# 25. What not to do

Avoid these traps.

### Do not turn `.at` into a giant prompt format

Prompts may exist inside roles, but the language's value is structure, not storing paragraphs of prose.

### Do not automatically pass full conversation history along every edge

That defeats the context-first model.

### Do not confuse shared workspace with shared context

Two agents may have access to the same filesystem while still receiving intentionally different context.

### Do not make every agent persistent

A role declaration and an execution instance are different concepts.

### Do not require materialization

Scaffolding is a backend, not the meaning of `.at`.

### Do not require a custom runtime

Interpreted topology should be useful with existing host coding agents.

### Do not add syntax before defining semantics

The grammar should encode a coherent model, not accumulate keywords.

### Do not destroy backward compatibility unnecessarily

Current `.at` files and bindings are valuable assets.

### Do not make context selection so explicit that simple topologies become verbose

Good defaults still matter.

The goal is **less ambiguity**, not maximum ceremony.

---

# 26. Product framing

The existing framing:

> Harness as code. Terraform for AI agents.

still communicates the scaffolding use case well.

But the broader vision may be:

> **A language for expressing how agents collaborate.**

More technical:

> **A portable topology language for agent delegation, context flow, and orchestration.**

Stronger conceptual framing:

> **AgenTopology is the boundary object between human intent and agent delegation.**

Why "boundary object"?

Because the same `.at` can be:

- written by a human,
- generated by an agent,
- edited collaboratively,
- parsed by software,
- rendered visually,
- interpreted directly by Claude Code or Codex,
- scaffolded into provider-specific files,
- validated statically,
- stored in Git,
- used temporarily,
- or promoted into a permanent organizational pattern.

Its value exists independently of any single execution mechanism.

---

# 27. The deeper product insight

Claude Code can already spawn agents.

Codex can already spawn agents.

The missing primitive is not necessarily "another way to spawn an agent."

The missing primitive is a **shared, inspectable, editable representation of delegation and information flow**.

Natural language is excellent for intent but becomes ambiguous for complex orchestration.

General-purpose code is precise but implementation-specific and unnecessarily powerful.

`.at` can sit between them:

```text
Natural language
      │
      │ intent / discussion
      ▼
     .at
      │
      │ topology / context contracts
      ▼
Host coding agent
      │
      │ native orchestration
      ▼
Ephemeral workers
```

That is a compelling place for a DSL.

---

# 28. Recommended next step for the coding agent

Do **not** begin with a large implementation.

First perform a focused design pass.

## Step 1 — audit the existing semantics

Review at minimum:

- `spec/grammar.md`
- parser/AST types
- validation rules
- current `reads`
- current `writes`
- current `outputs`
- memory/retrieval semantics
- flow edge representation
- groups/shared-state semantics
- orchestrator semantics
- bindings
- visualizer
- the `/agentopology` skill and current generation workflow

Answer:

> What parts of context-flow semantics already exist, even if they are currently framed as scaffolding features?

## Step 2 — model the semantics without changing syntax

Write a short internal design note defining:

- Agent Role
- Agent Execution
- Artifact
- Context Contract / Handoff
- Control Edge
- Context Edge
- Persistent State
- Ephemeral State
- Interpreted Topology
- Enforced Topology

Do not choose grammar keywords yet.

## Step 3 — prove interpreted mode with today's language

Try to make Claude Code or Codex use an existing `.at` file directly as an operational plan **without scaffolding it**.

The experiment should test whether the host agent can:

1. parse/understand the topology,
2. spawn native subagents,
3. honor flow ordering,
4. use `reads` / `writes` as handoff artifacts,
5. use typed `outputs` for routing,
6. honor bounded retries,
7. modify the topology when the task materially changes,
8. keep unrelated subagent context isolated.

This may require only a skill/instruction update, not grammar work.

## Step 4 — identify the context gaps

During the experiment, record every place where the lead agent has to guess:

- what to pass to the next agent,
- whether to include previous conversation,
- whether to include a file,
- whether the receiver should be blind,
- whether parallel agents should be independent,
- what output format is expected,
- whether an artifact is durable,
- whether a handoff is complete.

Those ambiguities are the evidence for any future grammar extension.

## Step 5 — only then design the smallest language addition

The target is not "model every possible context operation."

The target is:

> **What is the smallest extension that removes the highest-value context ambiguity?**

---

# 29. A possible first milestone

A powerful first milestone may require **no grammar change at all**.

Example goal:

> Given `task.at`, the `/agentopology` skill can enter an "execute topology" behavior where the current coding agent treats the file as the current delegation plan, uses native subagents to fulfill its roles, uses declared workspace artifacts as intentional handoffs, follows flow semantics, and keeps the topology synchronized when the plan changes.

This would prove the new thesis quickly.

Then the team can observe where current language semantics are insufficient.

That is much better evidence than designing the whole context DSL from theory.

---

# 30. Questions the design should eventually answer

These are open questions, not requirements.

### Context identity

What kinds of things can be passed?

- artifact/file,
- structured value,
- original task,
- selected chat context,
- memory domain,
- repository slice,
- tool result,
- summary,
- previous agent result.

### Default inheritance

If nothing is declared, what does the next agent receive?

This is one of the most important defaults in the language.

### Exclusion

Can a topology explicitly say that an agent must *not* receive a piece of information?

### Independence

Can two workers be guaranteed or strongly instructed not to see each other's outputs before synthesis?

### Output contracts

Should outputs remain routing-only enum values, or can an agent expose richer typed artifacts/results?

### Handoff validation

How do we know an agent actually produced the required context for its consumer?

### Transformations

Should summarization/filtering be explicit nodes, edge behavior, or ordinary agents?

### Dynamic mutation

How should a lead agent record topology changes during execution?

### Planned vs actual graph

Should a run record the topology that was actually executed?

### Context budgets

Should `.at` eventually express context/token budgets, or should this remain runtime metadata?

### Observability

How can the visualizer show both control edges and context edges without becoming unreadable?

### Advisory vs enforceable semantics

Which semantics can a host agent merely interpret, and which require a deterministic runtime?

---

# 31. Success criteria for this direction

We know the vision is working if a developer can do this:

1. Explain a complicated task to Claude Code or Codex.
2. The lead agent proposes a concise `.at` topology.
3. The developer understands the delegation structure at a glance.
4. The developer can modify the structure without rewriting a long prompt.
5. The topology makes important context boundaries visible.
6. The host agent executes it using native ephemeral workers.
7. Each worker receives only the context appropriate to its role.
8. Handoffs are intentional artifacts/results rather than context dumps.
9. Validation is structurally independent where appropriate.
10. The topology can change when reality changes.
11. No provider-specific agent files must be generated for this to work.
12. The same conceptual topology can still be scaffolded later if persistence is desired.

If that works, `.at` has become much more than configuration.

It has become a **language for organizing machine cognition.**

---

# 32. Final vision

The future of agent engineering is not just better prompts.

It is better structure around intelligence.

Models are increasingly capable of doing work, spawning workers, using tools, and adapting plans.

The hard problem becomes the architecture around those capabilities:

- who should do the work,
- when they should do it,
- what they should know,
- what they should not know,
- what evidence they should produce,
- how that evidence moves,
- who validates it,
- and when the organization decides it is done.

AgenTopology already has the beginning of a language for the first half of that problem.

The next opportunity is to recognize that **agent topology and context topology belong together**.

The topology of workers defines the organization.

The topology of context defines the quality of the organization.

And the `.at` file can become the shared, portable, human-and-agent-readable contract that connects the two.

> **The graph is the control plane. Context is the data plane.**

> **Agents are ephemeral. Handoffs are intentional. State persists only when it should.**

> **AgenTopology defines who works, when they work, and what they know when they work.**

That is the north star.
