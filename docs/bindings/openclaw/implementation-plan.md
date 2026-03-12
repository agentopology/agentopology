# OpenClaw Binding — Implementation Plan

## Overview

Build `src/bindings/openclaw.ts` that transforms a `TopologyAST` into a complete, deployable OpenClaw workspace. This is the 5th binding (after claude-code, codex, gemini-cli, copilot-cli) and the first targeting a production multi-channel agent framework.

---

## Generated Files (GeneratedFile[])

The OpenClaw binding produces this file tree:

```
project/
├── openclaw.json                          # System config (models, channels, auth, gateway)
├── SOUL.md                                # Primary agent identity (from orchestrator + meta)
├── AGENTS.md                              # Sub-agent definitions + flow logic
├── TOOLS.md                               # Available tools + skill references
├── MEMORY.md                              # Long-term memory structure + workspace protocol
├── BOOTSTRAP.md                           # Init instructions (from hooks on:SessionStart + gates)
├── TEAM.md                                # Topology overview doc (patterns, roles, flow diagram)
├── skills/                                # Skill directories
│   ├── <skill-id>/
│   │   └── SKILL.md                       # Skill definition (from ast.skills)
│   └── <tool-id>/
│       ├── SKILL.md                       # Tool-as-skill wrapper
│       └── index.ts                       # Stub implementation
├── scripts/
│   ├── <gate-id>.sh                       # Gate scripts
│   ├── <hook-run>.sh                      # Hook scripts
│   └── collect-metrics.sh                 # Metering script (if ast.metering)
├── workspace/
│   ├── .gitkeep                           # Workspace root
│   └── <structure-dirs>/.gitkeep          # From memory.workspace.structure
├── domains/
│   └── .gitkeep                           # Domain knowledge files
├── metrics.jsonl                          # Empty metrics file (if metering)
└── workspace-protocol.md                  # Access rules (from agent reads/writes)
```

---

## AT → OpenClaw Mapping (by generated file)

### 1. `openclaw.json`

The central config. Maps from multiple AT sources:

```typescript
{
  // From ast.topology
  name: ast.topology.name,
  version: ast.topology.version,

  // From ast.nodes (orchestrator + agents)
  agents: {
    list: [
      // Orchestrator → primary agent (coordinator role)
      {
        id: "orchestrator",
        name: toTitle(ast.topology.name) + " Coordinator",
        model: mapModel(orchestrator.model),
        workspace: `~/.openclaw/workspace-${ast.topology.name}`,
        agentDir: `./config/agents/orchestrator/agent`,
        subagents: {
          allowAgents: agentIds  // all agent node IDs
        }
      },
      // Each agent node → agent entry
      ...agents.map(a => ({
        id: a.id,
        name: toTitle(a.id),
        model: mapModel(a.model),
        workspace: `~/.openclaw/workspace-${a.id}`,
        agentDir: `./config/agents/${a.id}/agent`,
        tools: {
          allow: a.tools ?? [],
          deny: a.disallowedTools ?? []
        }
      }))
    ]
  },

  // From extensions.openclaw (if present)
  gateway: {
    port: ext?.["gateway-port"] ?? 18789,
    auth: {
      requireToken: true,  // HARDENED BY DEFAULT (solves OpenClaw security vuln)
      tokens: ext?.["auth-tokens"] ?? ["${OPENCLAW_AUTH_TOKEN}"]
    }
  },

  // From extensions.openclaw.channels
  channels: ext?.channels ?? {},

  // From ast.mcpServers
  // MCP servers listed as available integrations

  // From ast.settings
  tools: {
    agentToAgent: { enabled: true },
    defaults: {
      allow: settings.allow ?? [],
      deny: settings.deny ?? []
    }
  }
}
```

**Key decisions:**
- Auth is HARDENED by default (requireToken: true) — solves OpenClaw's security vulnerability
- Model mapping function converts AT models (opus/sonnet/haiku) to OpenClaw model strings
- Extensions block is the escape hatch for OpenClaw-specific config (channels, plugins, cron)

### 2. `SOUL.md`

Primary agent identity. Built from orchestrator + meta + roles:

```markdown
> {ast.topology.description}

## Identity
- Name: {toTitle(ast.topology.name)}
- Version: {ast.topology.version}
- Model: {orchestrator.model}
- Patterns: {ast.topology.patterns.join(", ")}

## Mission
{orchestrator description or topology description}

## Roles
{for each role in ast.roles:}
### {toTitle(roleName)}
{roleDescription}

## Ethical Guardrails
- Permission model: {mapPermissions(orchestrator)}
- Tool restrictions: {settings.deny or "none"}
```

### 3. `AGENTS.md`

Sub-agent definitions + flow orchestration logic. This is the **most complex file** — it encodes the entire flow graph as orchestration instructions:

```markdown
# Sub-Agent Definitions

## Pipeline Overview
{topology.name} uses a {patterns.join(" + ")} topology.

## Agents

{for each agent sorted by phase:}
### {toTitle(agent.id)}
- **Model:** {agent.model}
- **Phase:** {agent.phase}
- **Role:** {agent.role or roles[agent.id]}
- **Tools:** {agent.tools.join(", ")}
- **Reads:** {agent.reads.join(", ")}
- **Writes:** {agent.writes.join(", ")}
{if agent.outputs:}
- **Outputs:** {key}: {values.join(" | ")}
{if agent.scale:}
- **Scale:** {scale.min}-{scale.max} instances by {scale.by}
{if agent.maxTurns:}
- **Max turns:** {agent.maxTurns}
{if agent.description:}

{agent.description}

## Flow

{Generate natural-language orchestration instructions from edges:}

### Execution Order
{for each edge chain:}
1. {from} → {to} {if condition: "when " + condition} {if maxIterations: "(max " + max + " iterations)"}

### Conditional Routing
{for edges with conditions:}
- If {condition}: route to {to}

### Fan-Out Points
{for edges with fan-out:}
- After {from}: spawn [{targets}] in parallel

### Bounded Loops
{for edges with maxIterations:}
- {from} ↔ {to}: max {max} iterations (prevents infinite loops)

## Gates
{for each gate node:}
### {toTitle(gate.id)}
- **After:** {gate.after}
- **Before:** {gate.before}
- **Script:** {gate.run}
- **On failure:** {gate.onFail}
- **Behavior:** {gate.behavior ?? "blocking"}
```

### 4. `TOOLS.md`

Available tools. Built from ast.toolDefs + agent tools + skills:

```markdown
# Available Tools

## Core Tools
{unique tools across all agents, documented}

## Custom Tools
{for each toolDef:}
### {tool.id}
{tool.description}
- Script: {tool.script}
- Args: {tool.args.join(", ")}
- Language: {tool.lang}

## Skills
{for each skill:}
### {skill.id}
{skill.description}
```

### 5. `MEMORY.md`

Long-term memory structure. Built from ast.memory:

```markdown
# Memory Structure

## Domains
Path: {memory.domains.path}
{if memory.domains.routing:}
Routing: {memory.domains.routing}

## Workspace
Path: {memory.workspace.path}
Structure: {memory.workspace.structure.join(", ")}

## Metrics
Path: {memory.metrics.path}
Mode: {memory.metrics.mode}

## Agent Access Rules
{for each agent:}
### {agent.id}
- Reads: {agent.reads}
- Writes: {agent.writes}
```

### 6. `BOOTSTRAP.md`

Init instructions. Built from hooks (on:SessionStart) + gates + flow ordering:

```markdown
# Bootstrap Sequence

## Initialization
{hooks where on == "SessionStart" or "InstructionsLoaded":}
1. Run: {hook.run}

## Pre-Flight Gates
{gates that are "before" the first flow node:}
1. Gate: {gate.id} — {gate.run}
   On failure: {gate.onFail}

## Agent Initialization Order
{agents sorted by phase:}
Phase {phase}: {agent.id} ({agent.model})
```

### 7. `TEAM.md`

Topology overview documentation:

```markdown
# {toTitle(topology.name)} — Topology Overview

## Architecture
- Patterns: {patterns}
- Agents: {agent count}
- Gates: {gate count}
- Version: {version}

## Flow Diagram
```mermaid
graph TD
{edges as mermaid arrows}
```

## Roles
{roles table}

## Metering
{if metering: tracking details}
```

---

## Permission Mapping

```typescript
function mapPermissions(permissions: string): string {
  switch (permissions) {
    case "auto":       return "autonomous";       // No restrictions
    case "plan":       return "supervised";        // Propose then ask
    case "confirm":    return "interactive";       // Ask per tool use
    case "bypass":     return "unrestricted";      // Full access
    default:           return "autonomous";
  }
}
```

## Model Mapping

```typescript
function mapModel(model: string): string {
  const MODEL_MAP: Record<string, string> = {
    "opus":    "claude-opus-4",
    "sonnet":  "claude-sonnet-4.5",
    "haiku":   "claude-haiku-4",
    // Extend for other providers
  };
  return MODEL_MAP[model] ?? model;
}
```

---

## Extensions Schema

OpenClaw-specific fields go in `extensions { openclaw { ... } }`:

```typescript
interface OpenClawExtensions {
  // Gateway
  "gateway-port"?: number;          // Default: 18789
  "auth-tokens"?: string[];         // Auth token list

  // Channels
  channels?: string[];              // ["telegram", "slack", "whatsapp"]
  telegram?: {
    botToken: string;
    dmPolicy?: string;
    groups?: Record<string, { requireMention?: boolean }>;
  };
  slack?: {
    appToken: string;
    botToken: string;
  };
  whatsapp?: {
    accountId: string;
  };

  // Model configuration
  "model-fallback-chain"?: string[];  // Fallback models

  // Cron jobs
  "cron-jobs"?: Array<{
    name: string;
    schedule: string;
    tz?: string;
    agent: string;
    message: string;
  }>;

  // Plugins
  plugins?: Record<string, {
    enabled: boolean;
    config?: Record<string, unknown>;
  }>;

  // Sandbox
  "sandbox-defaults"?: {
    mode: string;
    scope?: string;
    docker?: { memory?: string; cpus?: number };
  };

  // Node pairing
  "node-pairing"?: {
    enabled: boolean;
    allowedDevices?: string[];
  };
}
```

---

## Code Structure

Follow the established pattern from other bindings:

```typescript
// src/bindings/openclaw.ts

import type { TopologyAST, AgentNode, GateNode, ... } from "../parser/ast.js";
import type { BindingTarget, GeneratedFile } from "./types.js";

// --- Helpers ---
function toTitle(id: string): string { ... }
function shellStub(description: string): string { ... }
function gitkeep(dirPath: string): GeneratedFile { ... }
function mapModel(model: string): string { ... }
function mapPermissions(perm: string): string { ... }
function getOpenClawExtensions(ast: TopologyAST): Record<string, unknown> | null { ... }

// --- File Generators ---
function generateOpenClawJson(ast: TopologyAST): GeneratedFile { ... }
function generateSoulMd(ast: TopologyAST): GeneratedFile { ... }
function generateAgentsMd(ast: TopologyAST): GeneratedFile { ... }
function generateToolsMd(ast: TopologyAST): GeneratedFile { ... }
function generateMemoryMd(ast: TopologyAST): GeneratedFile { ... }
function generateBootstrapMd(ast: TopologyAST): GeneratedFile { ... }
function generateTeamMd(ast: TopologyAST): GeneratedFile { ... }
function generateWorkspaceProtocol(ast: TopologyAST): GeneratedFile | null { ... }
function generateSkillFiles(ast: TopologyAST): GeneratedFile[] { ... }
function generateToolSkills(ast: TopologyAST): GeneratedFile[] { ... }
function generateGateScripts(ast: TopologyAST): GeneratedFile[] { ... }
function generateHookScripts(ast: TopologyAST): GeneratedFile[] { ... }
function generateMemoryDirs(ast: TopologyAST): GeneratedFile[] { ... }
function generateMetering(ast: TopologyAST): GeneratedFile | null { ... }

// --- Main Binding ---
export const openClawBinding: BindingTarget = {
  name: "openclaw",
  description: "OpenClaw workspace — multi-channel AI agent framework with gateway, channels, and markdown-based agent identity",

  scaffold(ast: TopologyAST): GeneratedFile[] {
    const files: GeneratedFile[] = [];

    // 1. Core workspace files
    files.push(generateOpenClawJson(ast));
    files.push(generateSoulMd(ast));
    files.push(generateAgentsMd(ast));
    files.push(generateToolsMd(ast));
    files.push(generateMemoryMd(ast));
    files.push(generateBootstrapMd(ast));
    files.push(generateTeamMd(ast));

    // 2. Skills (from ast.skills + ast.toolDefs)
    files.push(...generateSkillFiles(ast));
    files.push(...generateToolSkills(ast));

    // 3. Scripts (gates + hooks + metering)
    files.push(...generateGateScripts(ast));
    files.push(...generateHookScripts(ast));
    const metering = generateMetering(ast);
    if (metering) files.push(metering);

    // 4. Memory directories
    files.push(...generateMemoryDirs(ast));

    // 5. Workspace protocol
    const protocol = generateWorkspaceProtocol(ast);
    if (protocol) files.push(protocol);

    return files;
  }
};
```

---

## AT-Added-Value Features (things AT gives OpenClaw for free)

These are features OpenClaw DOESN'T have natively that AT generates:

| Feature | OpenClaw Problem | What AT Generates |
|---------|-----------------|-------------------|
| **Quality Gates** | No validation checkpoints between agents | Gate scripts + orchestration logic in AGENTS.md |
| **Bounded Loops** | Infinite loop risk in agent-to-agent calls | Max iteration counters in AGENTS.md flow logic |
| **Hardened Auth** | Gateway runs with no auth by default | openclaw.json with requireToken: true |
| **Structured Metrics** | Chaotic scattered logs | metrics.jsonl + collect-metrics.sh + hooks |
| **Bootstrap Ordering** | Agents skip identity setup for user queries | BOOTSTRAP.md with explicit init sequence |
| **Flow Validation** | Implicit topology, no compile-time checks | TEAM.md with validated flow diagram |
| **Exhaustive Routing** | Easy to miss output branches | AGENTS.md documents ALL output values + routes |
| **Scale Config** | No native auto-scaling concept | Documented scale params for manual/future use |
| **Workspace Protocol** | No access control on shared files | workspace-protocol.md with per-agent read/write rules |

---

## Example .at File

```agenttopology
# OpenClaw showcase — personal assistant with multi-channel support

topology personal-assistant : [supervisor, fan-out] {

  meta {
    version: "1.0.0"
    description: "Multi-channel personal assistant with research, writing, and scheduling capabilities"
    domain: "productivity"
  }

  orchestrator {
    model: opus
    handles: [intake, route]
    outputs: {
      task-type: research | write | schedule | general
    }
  }

  roles {
    researcher: "Deep research using web search and document analysis"
    writer: "Draft emails, messages, and documents in user's voice"
    scheduler: "Manage calendar and schedule meetings"
    responder: "Handle general questions and conversation"
  }

  agent researcher {
    role: researcher
    model: sonnet
    phase: 1
    tools: [Read, Write, Bash, Glob, Grep, WebSearch, WebFetch]
    reads: ["workspace/queries/"]
    writes: ["workspace/research/"]
    max-turns: 15
    description: "Research agent — searches web, reads docs, produces summaries"
  }

  agent writer {
    role: writer
    model: sonnet
    phase: 1
    tools: [Read, Write, Edit]
    reads: ["workspace/research/", "domains/voice-guide.md"]
    writes: ["workspace/drafts/"]
    description: "Writing agent — drafts in user's voice using research output"
  }

  agent scheduler {
    role: scheduler
    model: haiku
    phase: 1
    tools: [Read, Write]
    skills: [google-calendar]
    reads: ["workspace/requests/"]
    writes: ["workspace/scheduled/"]
    description: "Calendar agent — checks availability, proposes meeting times"
    extensions {
      openclaw {
        calendar-integration: true
      }
    }
  }

  agent responder {
    role: responder
    model: sonnet
    phase: 1
    tools: [Read, Write]
    reads: ["domains/"]
    writes: ["workspace/responses/"]
    description: "General responder for conversation and simple questions"
  }

  flow {
    intake -> route
    route -> researcher   [when orchestrator.task-type == research]
    route -> writer       [when orchestrator.task-type == write]
    route -> scheduler    [when orchestrator.task-type == schedule]
    route -> responder    [when orchestrator.task-type == general]
  }

  memory {
    domains {
      path: "domains/"
      routing: "FILE_MAP.md"
    }
    workspace {
      path: "workspace/"
      structure: [queries, research, drafts, requests, scheduled, responses]
    }
    metrics {
      path: "metrics.jsonl"
      mode: append-only
    }
  }

  settings {
    allow: [Read, Write, Edit, Glob, Grep]
    deny: []
  }

  metering {
    track: [tokens-in, tokens-out, cost, wall-time]
    per: [agent, run]
    output: "metrics/"
    format: jsonl
    pricing: anthropic-current
  }

  # OpenClaw-specific configuration
  extensions {
    openclaw {
      gateway-port: 18789
      auth-tokens: ["${OPENCLAW_AUTH_TOKEN}"]
      channels: [telegram, slack]
      telegram: {
        bot-token: "${TELEGRAM_BOT_TOKEN}"
        dm-policy: "pairing"
      }
      slack: {
        app-token: "${SLACK_APP_TOKEN}"
        bot-token: "${SLACK_BOT_TOKEN}"
      }
      model-fallback-chain: ["opus", "sonnet", "haiku"]
    }
  }
}
```

---

## Registration

Add to `src/bindings/index.ts`:

```typescript
import { openClawBinding } from "./openclaw.js";

export const bindings: Record<string, BindingTarget> = {
  "claude-code": claudeCodeBinding,
  "codex": codexBinding,
  "gemini-cli": geminiCliBinding,
  "copilot-cli": copilotCliBinding,
  "openclaw": openClawBinding,          // NEW
};
```

Add to `src/index.ts`:

```typescript
export { openClawBinding } from "./bindings/openclaw.js";
```

---

## Implementation Order

1. **Helpers** — toTitle, shellStub, gitkeep, mapModel, mapPermissions, getOpenClawExtensions
2. **generateOpenClawJson** — the hardest file, maps AST → JSON config
3. **generateSoulMd** — orchestrator identity
4. **generateAgentsMd** — sub-agents + flow logic (most complex markdown)
5. **generateToolsMd** — tool listings
6. **generateMemoryMd** — memory structure
7. **generateBootstrapMd** — init sequence from hooks/gates
8. **generateTeamMd** — topology overview with mermaid diagram
9. **generateSkillFiles** — skill directories from ast.skills
10. **generateToolSkills** — custom tools as skill wrappers
11. **generateGateScripts** — gate shell stubs
12. **generateHookScripts** — hook shell stubs
13. **generateMemoryDirs** — .gitkeep markers
14. **generateWorkspaceProtocol** — access rules from reads/writes
15. **generateMetering** — metrics collection script
16. **Wire up** — register in index.ts, export from main index.ts
17. **Example** — add `examples/openclaw-assistant.at`
18. **Test** — validate with `agentopology scaffold --target openclaw examples/openclaw-assistant.at`

---

## Estimated Size

Based on other bindings (638-835 lines), the OpenClaw binding will be approximately **900-1100 lines** due to:
- More complex JSON config generation (openclaw.json has richer schema)
- Additional markdown files (6 vs 2-3 in other bindings)
- Extensions schema handling (channels, cron, plugins)
- Flow-to-orchestration-logic translation (unique to OpenClaw)
