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

The validator checks all 19 rules: unique names, flow resolution, exhaustive conditions, bounded loops, provider security, and more. If something is wrong, you get a clear error message pointing to the issue.

## Scaffold

Generate platform-specific files from your topology:

```bash
agentopology scaffold my-pipeline.at --target claude-code
```

This produces agent configuration files, permission settings, MCP configs, and orchestrator logic for your chosen platform. The `--target` flag selects which binding to use.

Available targets:
- `claude-code` -- Claude Code agent files, settings, and MCP config
- `codex` -- OpenAI Codex CLI configuration
- `gemini-cli` -- Google Gemini CLI settings
- `copilot-cli` -- GitHub Copilot CLI instructions
- `openclaw` -- OpenClaw platform JSON

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
