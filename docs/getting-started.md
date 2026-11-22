# Getting Started with AgenTopology

Created by Nadav Naveh

## What is AgenTopology?

AgenTopology is a declarative language for defining multi-agent systems. You write a single `.at` file that describes your agents, how they connect, what tools they use, and how work flows between them. Then a compiler generates the platform-specific configuration for your chosen runtime.

The `.at` file is the single source of truth. Everything else is generated from it.

## Install

```bash
npm install -g agentopology
```

## Write Your First Topology

Create a file called `my-pipeline.at`:

```agenttopology
topology my-pipeline : [pipeline] {

  meta {
    version: "1.0.0"
    description: "Research, write, and review content"
  }

  orchestrator {
    model: sonnet
    handles: [start]
  }

  action start {
    kind: inline
    description: "Parse user request"
  }

  agent researcher {
    model: sonnet
    phase: 1
    tools: [Read, Grep, Glob, WebSearch]
    writes: ["workspace/research.md"]
  }

  agent writer {
    model: sonnet
    phase: 2
    tools: [Read, Write]
    reads: ["workspace/research.md"]
    writes: ["workspace/draft.md"]
    outputs: {
      verdict: done | needs-revision
    }
  }

  agent reviewer {
    model: opus
    phase: 3
    tools: [Read, Grep]
    reads: ["workspace/draft.md"]
    outputs: {
      verdict: approve | revise
    }
  }

  flow {
    start -> researcher
    researcher -> writer
    writer -> reviewer
    reviewer -> writer  [when reviewer.verdict == revise, max 2]
    reviewer -> finish  [when reviewer.verdict == approve]
  }

  action finish {
    kind: report
    description: "Deliver final content"
  }

  triggers {
    command create {
      pattern: "/create <TOPIC>"
      argument: TOPIC
    }
  }
}
```

## Validate

Check your topology for errors:

```bash
agentopology validate my-pipeline.at
```

The validator checks all 82 rules: unique names, flow resolution, exhaustive conditions, bounded loops, provider security, and more. If something is wrong, you get a clear error message pointing to the issue.

### Gates no hook runs (V135)

A gate meant to refuse (its `run:` names a script, it is not `behavior: advisory`, and its `strength` is `refuse` or not written) needs a moment a generated hook can catch: a subagent in `after:` or `before:`, or a script step (an action with `commands:`) in `before:`. A gate without one is a V135 error. When a harness has many, `fix` lists them:

```bash
agentopology fix my-pipeline.at            # dry run: writes nothing
agentopology fix my-pipeline.at --write    # adds strength: hope to each one
```

For each gate it prints why no hook runs it, the fix (`strength: hope`: nothing enforces the gate today, the playbook runs it) and, when the flow has one, an anchor that would make it refuse, as a suggestion it never applies. `--write` inserts one `strength: hope` line after the gate's `run:` line (or turns a written `strength: refuse` into `strength: hope`); every other byte of the file stays as it was. It then validates again. A gate that cites code (`at:`) gets V135's own fix instead, drop `run:` and keep the citation, and is left for you to edit. A V135 error in an imported file is counted and names that file: run `fix` on it there; the importer's run never edits it. Exit codes: 0 when nothing is left to fix, 2 when a dry run found something to fix (in this file or an imported one), 1 on an error or when a V135 error is left after `--write` (a gate written on a single line, a cited gate, or one in an imported file). `--write` refuses `--dry-run`, and a file that is not valid UTF-8, since writing it back would change bytes outside the edited lines; both exit 1 and write nothing. `--target cursor` and `--target claude-workflow` have nothing to fix: V135 does not apply there. A V135 warning (a declared hook runs the gate's command) is left alone.

## Scaffold

Generate platform-specific files from your topology:

```bash
agentopology scaffold my-pipeline.at --target claude-code
```

This produces agent configuration files, permission settings, MCP configs, and orchestrator logic for your chosen platform. The `--target` flag selects which binding to use.

Available targets:
- `claude-code` -- Claude Code agent files, settings, and MCP config (supported)
- `codex`, `cursor`, `claude-workflow` -- experimental

### Existing files and drift

On a project that already has agent, skill or command files, scaffold writes only the frontmatter keys the `.at` states and never the body. It never widens a tool list, an allowed-tools list, a server list or a permission mode over a value it did not write: it keeps yours and reports it as drift. Once a scaffold run has happened with the `.at` and the file agreeing on a key, the `.at` owns that key and later `.at` edits to it apply. To keep a hand-narrowed value, don't scaffold with the .at stating the same value; use `validate --inventory` to see who owns each key.

## Visualize

Generate an HTML visualization of your topology's flow graph:

```bash
agentopology visualize my-pipeline.at
```

This produces an interactive HTML file showing all agents, actions, gates, and flow edges. Useful for understanding complex topologies at a glance.

## Next Steps

- **Language Guide** -- `docs/language-guide.md` covers every block type, field, and pattern in detail.
- **Spec** -- `spec/grammar.md` is the formal language specification with EBNF grammar.
- **Examples** -- The `examples/` directory has complete topologies demonstrating different patterns.
- **Bindings** -- `docs/bindings.md` explains how to create bindings for new platforms.
- **Interactive Skill** -- `docs/skill-guide.md` covers the conversational topology builder.
