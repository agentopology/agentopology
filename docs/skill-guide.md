# AgentTopology Skill Guide

Created by Nadav Naveh

## What is the AgentTopology Skill?

The AgentTopology skill is an interactive builder that ships with the `agentopology` package. Describe what you want your agents to do, and it generates a complete `.at` topology file, validates it, scaffolds platform configs, and optionally visualizes the architecture — all in under 2 minutes.

## Installation

```bash
npm install -g agentopology
```

### Claude Code

Symlink the skill into your project:

```bash
mkdir -p .claude/skills
ln -s $(npm root -g)/agentopology/.claude/skills/agentopology .claude/skills/agentopology
```

Then invoke with `/agentopology` or describe what you want to build.

### Other CLIs

The skill ships as generic markdown (SKILL.md). Other CLIs with skill support can consume it directly.

## How It Works

The skill has 4 modes. The main one is **build**.

### Build

Describe your task. The skill picks a pattern, generates the `.at` file, validates it, and offers to scaffold.

```
You: I need agents to research a topic, write an article, and review it

Skill: ## Pipeline
       Research → write → review with revision loop.

         researcher → writer → reviewer

       Agents:
         researcher (sonnet) — gather sources and compile notes
         writer (sonnet)     — draft article from research
         reviewer (opus)     — review for accuracy and completeness

       Generating content-pipeline.at...

       content-pipeline.at created and validated (19/19 rules passed).

         scaffold    Generate agent configs for your platform
         visualize   See the topology graph

       Which platform? (claude-code, codex, gemini-cli, copilot-cli)

You: claude-code

Skill: [scaffolds .claude/ directory with agent files, settings, etc.]
       Done. 5 files generated.
```

That's it. Idea → working agent configs.

### Validate

Check any `.at` file for errors:

```
You: /agentopology --validate my-team.at
Skill: All 19 validation rules passed.
```

### Scaffold

Generate platform-specific files from an existing `.at` file:

```
You: /agentopology --scaffold my-team.at
Skill: Which target? claude-code, codex, gemini-cli, copilot-cli, openclaw
```

### Visualize

Generate an interactive HTML graph:

```
You: /agentopology --visualize my-team.at
Skill: Generated my-team-topology.html — opening in browser.
```

## Supported Patterns

The skill recommends from 5 proven patterns:

| Pattern | When to use |
|---------|------------|
| **Pipeline** | Steps happen one after another — content creation, data processing |
| **Supervisor** | Central router sends tasks to specialists — assistants, dispatch |
| **Fan-out** | Multiple agents work in parallel — code review, batch analysis |
| **Blackboard** | Agents share a knowledge base — research, collaborative analysis |
| **Pipeline + Blackboard** | Sequential phases with shared state — most production systems |

## Supported Platforms

| Target | Description |
|--------|-------------|
| `claude-code` | Anthropic Claude Code CLI |
| `codex` | OpenAI Codex CLI |
| `gemini-cli` | Google Gemini CLI |
| `copilot-cli` | GitHub Copilot CLI |
| `openclaw` | OpenClaw platform |

## Next Steps

- [Getting Started](getting-started.md) — Write `.at` files by hand
- [Language Guide](language-guide.md) — Full block and field reference
- [Creating Bindings](bindings.md) — Add support for a new platform
- [Examples](../examples/) — Complete topology files
