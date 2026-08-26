# Five months of AgenTopology, and why we just made the agents disposable

Five months ago I started writing a language for describing teams of AI agents.

The problem was mundane. I kept describing the same thing twice. Once in
English, to explain what I wanted — a researcher, then an architect, then a
builder, and a reviewer who has to be independent of the builder. Then again in
config files, by hand, for whichever platform I happened to be on. Claude Code
wanted one shape. Codex wanted another. Change your mind about the reviewer and
you edited four files and hoped you caught them all.

So I built `.at`: a small declarative language where you write the team once.

```
agent reviewer {
  model: opus
  reads:  ["workspace/diff.md", "workspace/tests.log"]
  writes: ["workspace/verdict.md"]
  outputs: { verdict: approve | revise | reject }
}

flow {
  builder -> reviewer
  reviewer -> builder [when reviewer.verdict == revise, max 2]
}
```

Nodes are agents. Edges are who runs after whom, and under what condition.
`max 2` means the revision loop is bounded — the validator refuses a back-edge
without one, because an unbounded loop between two agents is a bill, not a
design. It published to npm on the 19th of March and it compiled to eight
platforms.

The pitch was Terraform for agent teams. Write the org chart once, generate the
files anywhere.

That was right for about four months.

---

## What changed

The models got good at running the org chart themselves.

A coding agent today already plans, spawns sub-agents, runs them in parallel,
reads their results, retries, and changes the plan when the plan turns out to be
wrong. It does all of that natively. It does not need me to generate a folder of
markdown files first.

Which meant the compile step — the thing my whole tool was built around — had
quietly become optional.

I noticed because I stopped using my own output. I would scaffold a team into a
repo, work for a week, and find myself ignoring it. The repo had moved. The
harness had not. Regenerating it every week cost me more than it returned, and
the agent given the same task without the harness usually did something smarter
— it would fuse two steps that did not need to be separate, or skip a role that
turned out to be unnecessary.

The uncomfortable version: my own tool's topology file described a four-phase
pipeline with a gate and a retry loop. The skill that actually ran it had
collapsed all of that into three shell commands months earlier, and nobody had
updated the file. It had become fiction. I found that this week, by pointing the
tool at itself.

---

## So we made the agents disposable

Yesterday `.at` gained a second mode. Same file, no compilation:

```
agentopology plan my-team.at --task "Add rate limiting to the API"
```

Nothing is written to disk. The command validates the topology, resolves the
execution order, and hands the coding agent already in your session a brief it
follows to run the team with its own sub-agents. When the task is done, the team
is gone.

The agents are disposable. The structure is not.

That sounds like giving something up. It is the opposite, and the reason is the
part I did not understand five months ago.

---

## The real problem was never the org chart

It was the context.

The quality of an agent is mostly decided by what is in its context window. Not
the model. The context. A strong model with the wrong context does bad work, and
a smaller model with exactly the right context is often startlingly good.

In a team of agents, that becomes an architecture problem, and it is genuinely
hard for an agent to solve on its own mid-flight. When agent A finishes and agent
B starts, something has to decide what B is told. The default — hand B everything
A saw — is not a decision. It is a leak. B inherits A's dead ends, A's
confidence, A's half-formed guesses, and then reasons from them as if they were
findings.

The opposite default is just as bad. Start B clean, and you have thrown away the
one thing it needed.

So the question that actually determines whether a multi-agent system works is
not *who runs after whom*. It is:

> **Who knows what, at what moment, from whom, and what are they expected to
> produce for the next one?**

That is not something an agent should be improvising under time pressure. It is
a design decision, and design decisions belong in a file you can read and argue
with.

Concretely, this is what it looks like. A builder writes two files: its
implementation notes, and its own self-review. The validator reads the notes.
The validator must **not** read the self-review — because a verdict formed after
reading the builder's own opinion of its work is not independent, and the whole
point of having a validator is that it is independent.

That constraint has to live somewhere. In prose it is a sentence in a prompt
that a helpful orchestrator will cheerfully violate by summarising the
self-review "for context". As structure, it is a property of the topology, and
the run can be checked against it.

Same for blindness. Two researchers looking at the same problem are only worth
having if neither sees the other's conclusions first. Otherwise the second one
anchors on the first and you paid twice for one opinion.

---

## Why disposable makes that easier, not harder

Because a frozen harness cannot express any of it usefully.

If the team is a folder of generated files, then changing what the validator can
see means regenerating the folder. So you do not change it. The structure calcifies
while the work moves, and within a month the files describe a team that no longer
exists — exactly what happened to mine.

If the team is created for the task and discarded after, the structure is cheap
to change. You can write a topology for one job, look at it, say "no, the
validator shouldn't see that", change one line, and run it. Then throw it away.

The file is not the team. The file is the argument about how the team should be
shaped — and it is worth having that argument out loud, in something both a human
and an agent can read, before any tokens are spent on the work.

Persistence became a choice rather than an assumption. Some topologies earn it
and get compiled into real files with real enforcement. Most do not, and should
not.

---

## What I know, and what I do not

I spent this week testing the claim instead of asserting it, and I will give you
both halves.

I ran the same code-review task two ways: one agent working alone with the task
in prose, and the same task expressed as a topology and enacted through the
brief. Everything verified against the real code, and I told the judge that a
null result was a perfectly good answer.

The structured run found **21 real bugs**. The solo run found **11**, and every
one of those 11 was in the other set. So the structure roughly doubled what was
caught — including four serious things the solo run walked straight past.

It also cost **2.5× the tokens** and **2.6× the wall clock**, and per bug found it
was about **30% less efficient**. That is not a rounding error. If missing a bug
is cheap, work solo. If missing one is expensive, the structure pays.

And the honest caveat, which came from the judge and not from me: the clean
control is a solo run given the *same* budget — three prose agents instead of
one. Nobody has run that yet. If it finds 21 too, then what I measured was
"spend more, split the work", which needs no language to express. That is the
next experiment and I am not going to pretend I already know how it comes out.

One more thing worth saying plainly. Over two days the tool found **22 real bugs
in its own project**, including a rule the validator claimed to enforce and did
not, and one regression I shipped and caught an hour later by installing my own
package and running it like a stranger. Every one of those bugs was the same
shape: a value quietly substituted or dropped, with nothing comparing it to what
the specification said. None were carelessness. They were missing comparisons.

Which turns out to be the whole thesis in one line. **The job of a topology is to
make the comparison possible. The job of the validator is to actually run it.**

The graph is the control plane. Context is the data plane. Agents are disposable.
Handoffs are deliberate. State persists only when it should.

`npm i -g agentopology` — Apache-2.0, eight platform targets, and a `plan`
command that writes nothing at all.
