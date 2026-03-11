# Agentopology

**The declarative language for multi-agent systems.**

Agentopology (`.at`) is a platform-agnostic, human-readable language for defining AI agent topologies -- their roles, tools, flows, gates, memory, hooks, and orchestration patterns.

Write once. Scaffold for any platform.

## What is an `.at` file?

```
# simple-pipeline.at — A basic 3-agent content pipeline

topology simple-pipeline : [pipeline, human-gate] {

  meta {
    version: "1.0.0"
    description: "Research, write, and review — a minimal content pipeline"
  }

  agent researcher {
    role: researcher
    model: gpt-4o
    permissions: supervised
    tools: [Read, Grep, Glob, WebSearch]
    writes: ["workspace/research.md"]
  }

  agent writer {
    role: writer
    model: sonnet
    permissions: autonomous
    tools: [Read, Write, Glob]
    reads: ["workspace/research.md"]
    writes: ["workspace/draft.md"]
  }

  agent reviewer {
    role: reviewer
    model: opus
    permissions: supervised
    tools: [Read, Grep, Glob]
    reads: ["workspace/draft.md", "workspace/research.md"]
    outputs: {
      verdict: approve | revise | reject
    }
  }

  flow {
    intake -> researcher
    researcher -> writer
    writer -> reviewer
    reviewer -> writer     [when reviewer.verdict == revise, max 2]
    reviewer -> done       [when reviewer.verdict == approve]
  }
}
```

An `.at` file declares the full topology: agents, their models and tools, how data flows between them, validation gates, memory layout, and more. One file, complete picture.

## Why Agentopology?

- **Declarative** -- describe *what* you want, not *how* to build it
- **Platform-agnostic** -- scaffold for Claude Code, Codex, Gemini CLI, or any platform
- **Human-readable** -- architects and operators can reason about topology without code
- **Validated** -- 15 built-in rules catch errors before you scaffold
- **Composable** -- import and reuse agent definitions across topologies

## Quick Start

```bash
npm install -g agentopology

# Validate your topology
agentopology validate my-team.at

# Scaffold for your platform
agentopology scaffold my-team.at --target claude-code
agentopology scaffold my-team.at --target codex

# List available targets
agentopology targets
```

## Supported Platforms

| Target | Status | Description |
|--------|--------|-------------|
| `claude-code` | Stable | Anthropic Claude Code CLI |
| `codex` | Beta | OpenAI Codex CLI |
| `gemini-cli` | Planned | Google Gemini CLI |
| `copilot-cli` | Planned | GitHub Copilot CLI |

## Language Features

- 11 topology patterns (pipeline, supervisor, fan-out, debate, and more)
- Typed agents with model, tools, permissions, and scale
- Flow graphs with conditions, fan-out, and bounded loops
- Validation gates between phases
- Memory management (domains, references, workspace)
- Hook-based event system
- MCP server integration
- Batch processing and metering
- Import and reuse via libraries

## Programmatic API

```typescript
import { parse, validate, bindings } from "agentopology";

// Parse an .at file
const ast = parse(source);

// Validate (returns errors/warnings)
const issues = validate(ast);

// Scaffold for a platform
const files = bindings["claude-code"].scaffold(ast);
```

## Visualizer

Agentopology includes a built-in visualizer that generates a self-contained HTML file from any topology:

```typescript
import { parse, generateVisualization } from "agentopology";

const ast = parse(source);
const html = generateVisualization(ast);
// Write html to a file and open in a browser
```

## Documentation

- [Getting Started](docs/getting-started.md)
- [Language Guide](docs/language-guide.md)
- [Language Specification](spec/grammar.md)
- [Creating Bindings](docs/bindings.md)
- [Examples](examples/)

## Creating a Binding

A binding transforms a parsed `TopologyAST` into platform-specific files. Implement the `BindingTarget` interface to add support for any AI coding tool:

```typescript
import type { BindingTarget } from "agentopology/bindings";

export const myBinding: BindingTarget = {
  name: "my-platform",
  description: "My AI Platform",
  scaffold(ast) {
    // Transform AST into generated files
    return [{ path: "config.json", content: "..." }];
  },
};
```

See [Creating Bindings](docs/bindings.md) for the full guide.

## License

Apache 2.0

---

Created by [Nadav Naveh](https://github.com/nadavnaveh)
