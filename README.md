<h1 align="center">AgentTopology</h1>

<p align="center">
  <strong>The Terraform for AI agents.</strong><br/>
  Define your agent team once. Deploy to any platform.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/agentopology"><img src="https://img.shields.io/npm/v/agentopology" alt="npm" /></a>
  <a href="https://github.com/nadavnaveh/agentopology/actions"><img src="https://img.shields.io/badge/tests-1%2C313%20passing-brightgreen" alt="tests" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue" alt="license" /></a>
</p>

<br/>

You have 5 agents across 3 tools. Each tool wants its own config format. You maintain 47 files that do the same thing differently. One agent changes — you update everywhere.

**Stop.**

```
topology code-review : [pipeline] {
  agent researcher  { model: sonnet  tools: [Read, Grep, WebSearch] }
  agent writer      { model: sonnet  tools: [Read, Write] }
  agent reviewer    { model: opus    tools: [Read, Grep] }

  flow {
    researcher -> writer -> reviewer
    reviewer -> writer  [when reviewer.verdict == revise, max 2]
  }
}
```

```bash
agentopology scaffold my-team.at --target claude-code   # → .claude/agents/
agentopology scaffold my-team.at --target cursor         # → .cursor/rules/
agentopology scaffold my-team.at --target codex          # → .codex/
```

One file. Seven platforms. Every agent, flow, gate, hook, and MCP server — defined once.

---

## What It Does

AgentTopology is a **declarative language** (`.at` files) and a **CLI compiler** that transforms agent definitions into platform-native configuration files.

```
┌──────────────┐      ┌────────────┐      ┌─────────────────────┐
│  .at file    │ ───▶ │  Parser &  │ ───▶ │  Platform configs   │
│  (you write) │      │  Validator │      │  (auto-generated)   │
└──────────────┘      └────────────┘      └─────────────────────┘
                                            ├── .claude/agents/
                                            ├── .cursor/rules/
                                            ├── .codex/
                                            ├── .github/agents/
                                            ├── .kiro/agents/
                                            ├── .openclaw/
                                            └── ...
```

You stop hand-maintaining config files. Your topology becomes the single source of truth.

---

## Quick Start

```bash
npm install -g agentopology
```

**Validate** — catch errors before you scaffold:
```bash
agentopology validate my-team.at
```

**Scaffold** — generate platform configs:
```bash
agentopology scaffold my-team.at --target claude-code
```

**Visualize** — see your topology as an interactive graph:
```bash
agentopology visualize my-team.at
```

**List targets** — see all supported platforms:
```bash
agentopology targets
```

---

## The Language

`.at` files are human-readable and version-controllable. Here's a real topology:

```
topology content-pipeline : [pipeline, human-gate] {

  meta {
    version: "1.0.0"
    description: "Research, write, review — with quality gate"
  }

  agent researcher {
    model: sonnet
    description: "Gathers information and sources"
    tools: [Read, Grep, WebSearch]
    writes: ["workspace/research.md"]
    prompt {
      Search broadly for relevant sources.
      Compile findings into structured research notes.
      Include citations and source URLs.
    }
  }

  agent writer {
    model: sonnet
    description: "Drafts content from research"
    tools: [Read, Write]
    reads: ["workspace/research.md"]
    writes: ["workspace/draft.md"]
  }

  agent reviewer {
    model: opus
    description: "Reviews drafts for quality"
    tools: [Read, Grep]
    reads: ["workspace/draft.md"]
    outputs: { verdict: approve | revise | reject }
  }

  gates {
    gate quality-check {
      after: reviewer
      run: "scripts/check-quality.sh"
      on-fail: halt
    }
  }

  flow {
    researcher -> writer -> reviewer
    reviewer -> writer  [when reviewer.verdict == revise, max 2]
  }
}
```

This defines three agents, their tools and memory, a quality gate, and a flow with a conditional retry loop — all in 40 lines.

---

## Supported Platforms

| Target | Command | What It Generates |
|--------|---------|-------------------|
| **Claude Code** | `--target claude-code` | `.claude/agents/`, `.claude/skills/`, `.mcp.json`, `.claude/settings.json` |
| **Cursor** | `--target cursor` | `.cursor/rules/*.mdc`, `.cursor/mcp.json`, `.cursor/hooks.json` |
| **Codex** | `--target codex` | `.codex/config.toml`, `AGENTS.md` |
| **Copilot** | `--target copilot-cli` | `.github/agents/*.agent.md`, `.github/copilot-instructions.md` |
| **Gemini CLI** | `--target gemini-cli` | `.gemini/`, `AGENTS.md` |
| **Kiro** | `--target kiro` | `.kiro/agents/*.json`, `.kiro/steering/` |
| **OpenClaw** | `--target openclaw` | `.openclaw/soul.md`, `.openclaw/skills/` |

Every binding is ground-truth validated against real-world configs from production repos.

---

## Language Features

<table>
<tr>
<td width="50%">

**Agents & Models**
```
agent planner {
  model: opus
  tools: [Read, Write, Bash]
  permissions: plan
  thinking: high
  thinking-budget: 4000
  max-turns: 20
}
```

</td>
<td width="50%">

**Flow Graphs**
```
flow {
  intake -> researcher
  researcher -> writer
  writer -> reviewer
  reviewer -> writer  [when verdict == revise, max 3]
  reviewer -> done    [when verdict == approve]
}
```

</td>
</tr>
<tr>
<td>

**Group Chats**
```
group debate-arena {
  members: [pro, con]
  speaker-selection: "round-robin"
  max-rounds: 5
  termination: "judge declares winner"
}
```

</td>
<td>

**Quality Gates**
```
gates {
  gate security-scan {
    after: builder
    run: "scripts/security.sh"
    checks: [vulnerabilities, secrets]
    on-fail: halt
  }
}
```

</td>
</tr>
<tr>
<td>

**Hooks & Events**
```
hooks {
  hook format-on-save {
    on: PostToolUse
    matcher: "Write"
    run: "scripts/format.sh"
  }
}
```

</td>
<td>

**MCP Servers**
```
mcp-servers {
  github {
    command: "npx"
    args: ["-y", "@mcp/server-github"]
    env { TOKEN: "${GITHUB_TOKEN}" }
  }
}
```

</td>
</tr>
</table>

Plus: schemas, artifacts, metering, circuit breakers, scale configs, depth levels, environment overrides, prompt variants, composition via imports, and [more](spec/grammar.md).

---

## Group Chats — Agents That Talk to Each Other

Groups aren't fan-out. They're real conversations. Each agent reads what others wrote and responds:

```
group design-review {
  members: [architect, security-lead, tech-lead]
  speaker-selection: "round-robin"
  max-rounds: 3
  termination: "consensus reached"
}
```

In Claude Code, this compiles to a **file-based protocol** — a shared transcript file that agents read and append to sequentially. No HTTP, no message bus. Just the filesystem as shared state.

---

## Programmatic API

```typescript
import { parse, validate, bindings } from "agentopology";

// Parse
const ast = parse(atSource);

// Validate (29 built-in rules)
const issues = validate(ast);

// Scaffold
const files = bindings["claude-code"].scaffold(ast);

// Visualize
import { generateVisualization } from "agentopology";
const html = generateVisualization(ast);
```

---

## Create Your Own Binding

Implement the `BindingTarget` interface to add any platform:

```typescript
import type { BindingTarget } from "agentopology";

export const myBinding: BindingTarget = {
  name: "my-platform",
  description: "My AI Platform",
  scaffold(ast) {
    return [
      { path: "agents.json", content: JSON.stringify(ast.nodes) },
    ];
  },
};
```

---

## Why Not Just Write Config Files?

| | Config files | AgentTopology |
|---|---|---|
| **Switch platforms** | Rewrite everything | Change `--target` |
| **Add an agent** | Update 5-12 files across 3 tools | Add 4 lines to `.at` file |
| **Review topology** | Read YAML, JSON, TOML, Markdown across dirs | Read one `.at` file |
| **Validate** | Hope for the best | `agentopology validate` catches 29 error types |
| **Visualize** | Draw it yourself | `agentopology visualize` → interactive HTML |
| **Version control** | Diff 47 generated files | Diff one `.at` file |

---

## Examples

- [`simple-pipeline.at`](examples/simple-pipeline.at) — Research → write → review with quality gate
- [`code-review.at`](examples/code-review.at) — Multi-agent code review with security scanning
- [`data-processing.at`](examples/data-processing.at) — ETL pipeline with batch processing and metering
- [`scheduled-monitor.at`](examples/scheduled-monitor.at) — Monitoring system with scheduled health checks
- [`openclaw-assistant.at`](examples/openclaw-assistant.at) — Customer support with routing and scheduling

---

## CLI Reference

```
agentopology validate <file>              Validate an .at file
agentopology scaffold <file> --target <t> Generate platform configs
agentopology visualize <file>             Interactive topology graph
agentopology targets                      List supported platforms
agentopology docs [topic]                 Language reference
agentopology info <file>                  Topology summary
agentopology export <file> --format json  Export AST as JSON
```

---

## Contributing

We welcome contributions. The easiest ways to start:

- Add a new [example topology](examples/)
- Improve a [binding](src/bindings/)
- Add [tests](src/bindings/__tests__/)
- Write [documentation](docs/)

Grammar and AST changes require an RFC.

---

## License

Apache 2.0 — see [LICENSE](LICENSE).

---

<p align="center">
  <sub>Created by <a href="https://github.com/nadavnaveh">Nadav Naveh</a></sub>
</p>
