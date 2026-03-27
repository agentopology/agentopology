import { describe, it, expect } from "vitest";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { serializeAST } from "../serializer.js";
import { importClaudeCode, parseAgentMd, parseSettingsJson, parseMcpJson, parseCommandMd, parseActionScript, parseSkillMd } from "../claude-code.js";
import { importFromPlatform } from "../index.js";
import type { PlatformFile } from "../../sync/index.js";

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const SIMPLE_PIPELINE = `
topology simple-pipeline : [pipeline] {
  meta {
    version: "1.0.0"
    description: "Test pipeline"
  }
  orchestrator {
    model: sonnet
    handles: [intake, done]
  }
  action intake {
    kind: inline
    description: "Start"
  }
  agent researcher {
    model: gpt-4o
    permissions: supervised
    phase: 1
    tools: [Read, Grep]
    reads: ["workspace/data.md"]
    writes: ["workspace/output.md"]
    outputs: {
      quality: high | low
    }
    prompt {
      You are a researcher.
    }
  }
  agent writer {
    model: sonnet
    phase: 2
    tools: [Read, Write]
    prompt {
      You are a writer.
    }
  }
  action done {
    kind: report
    description: "Finish"
  }
  flow {
    intake -> researcher
    researcher -> writer
    writer -> done
  }
  settings {
    allow: ["Read", "Grep"]
    deny: ["Bash(rm -rf *)"]
  }
}
`;

const BASIC_AGENT_MD = `---
name: researcher
description: "Gather info"
model: gpt-4o
tools:
  - Read
  - Grep
  - Glob
mcpServers:
  - supabase
permissionMode: plan
maxTurns: 25
sandbox: docker
fallback-chain: sonnet, haiku
---

You are the Researcher agent.

## Role
Gather information and compile research notes

## Instructions
You are a research specialist focused on gathering comprehensive information.
Always cite your sources.

## Reads
- workspace/data.md
- workspace/refs.md

## Writes
- workspace/output.md

## Outputs
- confidence: high | medium | low

You have a maximum of 5m to complete your work.

If you fail: retry-then-escalate
`;

const HUMAN_AGENT_MD = `# Binding Review (Human-in-the-Loop)

Review the generated binding code before proceeding.

Timeout: 1h
On timeout: skip
`;

const GROUP_AGENT_MD = `---
name: gap-debate
type: group
members:
  - sdk-specialist
  - binding-veteran
  - platform-expert
description: "Three-perspective debate"
---

# Gap Debate (Group Chat)

Three-perspective debate on gap resolution.

Speaker selection: round-robin
Max rounds: 3
Termination: consensus reached
`;

const SIMPLE_SKILL_MD = `---
name: test-pipeline
description: "Test pipeline skill"
version: "1.0.0"
topology: test-pipeline
patterns:
  - pipeline
entry: commands/start.md
---

# Test Pipeline Topology Skill

Test pipeline skill

Version: 1.0.0
Patterns: pipeline

## Orchestrator

Model: opus
Handles: intake, done
Generates: commands/start.md

### Outputs
- verdict: pass | fail

## Flow

- intake -> researcher
- researcher -> writer
- writer -> done

## Gates

### Quality Check
After: writer
Before: done
Run: scripts/check.sh
Checks: grammar, formatting
On fail: bounce-back

## Triggers

### /start
Pattern: \`/start\`
`;

// ---------------------------------------------------------------------------
// Serializer tests
// ---------------------------------------------------------------------------

describe("serializeAST", () => {
  it("round-trips a simple pipeline", () => {
    const ast = parse(SIMPLE_PIPELINE);
    const serialized = serializeAST(ast);
    const reparsed = parse(serialized);

    expect(reparsed.topology.name).toBe("simple-pipeline");
    expect(reparsed.topology.version).toBe("1.0.0");
    expect(reparsed.topology.patterns).toContain("pipeline");
  });

  it("preserves agents", () => {
    const ast = parse(SIMPLE_PIPELINE);
    const serialized = serializeAST(ast);
    const reparsed = parse(serialized);

    const agents = reparsed.nodes.filter((n) => n.type === "agent");
    expect(agents.length).toBe(2);

    const researcher = agents.find((a) => a.id === "researcher");
    expect(researcher).toBeDefined();
    expect((researcher as any).model).toBe("gpt-4o");
    expect((researcher as any).tools).toContain("Read");
  });

  it("preserves actions", () => {
    const ast = parse(SIMPLE_PIPELINE);
    const serialized = serializeAST(ast);
    const reparsed = parse(serialized);

    const actions = reparsed.nodes.filter((n) => n.type === "action");
    expect(actions.length).toBe(2);
  });

  it("preserves edges", () => {
    const ast = parse(SIMPLE_PIPELINE);
    const serialized = serializeAST(ast);
    const reparsed = parse(serialized);

    expect(reparsed.edges.length).toBe(3);
    expect(reparsed.edges[0].from).toBe("intake");
    expect(reparsed.edges[0].to).toBe("researcher");
  });

  it("preserves settings", () => {
    const ast = parse(SIMPLE_PIPELINE);
    const serialized = serializeAST(ast);
    const reparsed = parse(serialized);

    expect((reparsed.settings as any).allow).toContain("Read");
    expect((reparsed.settings as any).deny).toContain("Bash(rm -rf *)");
  });

  it("preserves outputs", () => {
    const ast = parse(SIMPLE_PIPELINE);
    const serialized = serializeAST(ast);
    const reparsed = parse(serialized);

    const researcher = reparsed.nodes.find((n) => n.id === "researcher") as any;
    expect(researcher.outputs).toBeDefined();
    expect(researcher.outputs.quality).toContain("high");
    expect(researcher.outputs.quality).toContain("low");
  });

  it("preserves prompts", () => {
    const ast = parse(SIMPLE_PIPELINE);
    const serialized = serializeAST(ast);
    const reparsed = parse(serialized);

    const researcher = reparsed.nodes.find((n) => n.id === "researcher") as any;
    expect(researcher.prompt).toContain("researcher");
  });

  it("preserves reads and writes", () => {
    const ast = parse(SIMPLE_PIPELINE);
    const serialized = serializeAST(ast);
    const reparsed = parse(serialized);

    const researcher = reparsed.nodes.find((n) => n.id === "researcher") as any;
    expect(researcher.reads).toContain("workspace/data.md");
    expect(researcher.writes).toContain("workspace/output.md");
  });

  it("preserves orchestrator", () => {
    const ast = parse(SIMPLE_PIPELINE);
    const serialized = serializeAST(ast);
    const reparsed = parse(serialized);

    const orch = reparsed.nodes.find((n) => n.type === "orchestrator") as any;
    expect(orch).toBeDefined();
    expect(orch.model).toBe("sonnet");
    expect(orch.handles).toContain("intake");
  });

  it("outputs valid .at that passes validation", () => {
    const ast = parse(SIMPLE_PIPELINE);
    const serialized = serializeAST(ast);
    const reparsed = parse(serialized);
    const results = validate(reparsed);
    const errors = results.filter((r) => r.level === "error");
    expect(errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AGENT.md parser tests
// ---------------------------------------------------------------------------

describe("parseAgentMd", () => {
  it("parses basic agent fields", () => {
    const node = parseAgentMd("researcher", BASIC_AGENT_MD);
    expect(node).toBeDefined();
    expect(node!.type).toBe("agent");
    expect(node!.id).toBe("researcher");

    const agent = node as any;
    expect(agent.model).toBe("gpt-4o");
    expect(agent.tools).toContain("Read");
    expect(agent.tools).toContain("Grep");
    expect(agent.tools).toContain("Glob");
  });

  it("reverse-maps permission mode", () => {
    const agent = parseAgentMd("researcher", BASIC_AGENT_MD) as any;
    expect(agent.permissions).toBe("supervised");
  });

  it("parses maxTurns", () => {
    const agent = parseAgentMd("researcher", BASIC_AGENT_MD) as any;
    expect(agent.maxTurns).toBe(25);
  });

  it("parses mcpServers", () => {
    const agent = parseAgentMd("researcher", BASIC_AGENT_MD) as any;
    expect(agent.mcpServers).toContain("supabase");
  });

  it("parses sandbox", () => {
    const agent = parseAgentMd("researcher", BASIC_AGENT_MD) as any;
    expect(agent.sandbox).toBe("docker");
  });

  it("parses fallback chain", () => {
    const agent = parseAgentMd("researcher", BASIC_AGENT_MD) as any;
    expect(agent.fallbackChain).toContain("sonnet");
    expect(agent.fallbackChain).toContain("haiku");
  });

  it("extracts role section", () => {
    const agent = parseAgentMd("researcher", BASIC_AGENT_MD) as any;
    expect(agent.role).toContain("Gather information");
  });

  it("extracts prompt from ## Instructions", () => {
    const agent = parseAgentMd("researcher", BASIC_AGENT_MD) as any;
    expect(agent.prompt).toContain("research specialist");
    expect(agent.prompt).toContain("cite your sources");
  });

  it("extracts reads and writes", () => {
    const agent = parseAgentMd("researcher", BASIC_AGENT_MD) as any;
    expect(agent.reads).toContain("workspace/data.md");
    expect(agent.reads).toContain("workspace/refs.md");
    expect(agent.writes).toContain("workspace/output.md");
  });

  it("extracts outputs", () => {
    const agent = parseAgentMd("researcher", BASIC_AGENT_MD) as any;
    expect(agent.outputs).toBeDefined();
    expect(agent.outputs.confidence).toContain("high");
    expect(agent.outputs.confidence).toContain("medium");
    expect(agent.outputs.confidence).toContain("low");
  });

  it("extracts timeout", () => {
    const agent = parseAgentMd("researcher", BASIC_AGENT_MD) as any;
    expect(agent.timeout).toBe("5m");
  });

  it("extracts onFail", () => {
    const agent = parseAgentMd("researcher", BASIC_AGENT_MD) as any;
    expect(agent.onFail).toBe("retry-then-escalate");
  });

  it("detects human nodes", () => {
    const node = parseAgentMd("binding-review", HUMAN_AGENT_MD);
    expect(node).toBeDefined();
    expect(node!.type).toBe("human");
    expect((node as any).timeout).toBe("1h");
    expect((node as any).onTimeout).toBe("skip");
  });

  it("detects group nodes", () => {
    const node = parseAgentMd("gap-debate", GROUP_AGENT_MD);
    expect(node).toBeDefined();
    expect(node!.type).toBe("group");
    const group = node as any;
    expect(group.members).toContain("sdk-specialist");
    expect(group.members).toContain("binding-veteran");
    expect(group.members).toContain("platform-expert");
    expect(group.speakerSelection).toBe("round-robin");
    expect(group.maxRounds).toBe(3);
  });

  it("preserves unknown frontmatter as extensions", () => {
    const md = `---
name: test
model: sonnet
custom-field: custom-value
---

## Instructions
Test prompt.
`;
    const agent = parseAgentMd("test", md) as any;
    expect(agent.extensions).toBeDefined();
    expect(agent.extensions["claude-code"]["custom-field"]).toBe("custom-value");
  });
});

// ---------------------------------------------------------------------------
// SKILL.md parser tests
// ---------------------------------------------------------------------------

describe("parseSkillMd", () => {
  it("detects topology skill", () => {
    const result = parseSkillMd(SIMPLE_SKILL_MD);
    expect(result.isTopology).toBe(true);
    expect(result.name).toBe("test-pipeline");
    expect(result.version).toBe("1.0.0");
  });

  it("extracts patterns", () => {
    const result = parseSkillMd(SIMPLE_SKILL_MD);
    expect(result.patterns).toContain("pipeline");
  });

  it("extracts orchestrator", () => {
    const result = parseSkillMd(SIMPLE_SKILL_MD);
    expect(result.orchestrator).toBeDefined();
    expect(result.orchestrator!.model).toBe("opus");
    expect(result.orchestrator!.handles).toContain("intake");
    expect(result.orchestrator!.handles).toContain("done");
  });

  it("extracts orchestrator outputs", () => {
    const result = parseSkillMd(SIMPLE_SKILL_MD);
    expect(result.orchestrator!.outputs).toBeDefined();
    expect(result.orchestrator!.outputs!.verdict).toContain("pass");
  });

  it("extracts flow edges", () => {
    const result = parseSkillMd(SIMPLE_SKILL_MD);
    expect(result.edges.length).toBe(3);
    expect(result.edges[0].from).toBe("intake");
    expect(result.edges[0].to).toBe("researcher");
  });

  it("extracts agent IDs from flow", () => {
    const result = parseSkillMd(SIMPLE_SKILL_MD);
    expect(result.agentIds.has("researcher")).toBe(true);
    expect(result.agentIds.has("writer")).toBe(true);
  });

  it("extracts gates", () => {
    const result = parseSkillMd(SIMPLE_SKILL_MD);
    expect(result.gates.length).toBe(1);
    expect(result.gates[0].id).toBe("quality-check");
    expect(result.gates[0].after).toBe("writer");
    expect(result.gates[0].onFail).toBe("bounce-back");
  });

  it("extracts triggers", () => {
    const result = parseSkillMd(SIMPLE_SKILL_MD);
    expect(result.triggers.length).toBe(1);
    expect(result.triggers[0].name).toBe("start");
    expect(result.triggers[0].pattern).toBe("/start");
  });

  it("non-topology skill is detected", () => {
    const md = `---
name: helper-skill
description: "A helper"
---

# Helper Skill
`;
    const result = parseSkillMd(md);
    expect(result.isTopology).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// settings.json parser tests
// ---------------------------------------------------------------------------

describe("parseSettingsJson", () => {
  it("extracts allow/deny/ask", () => {
    const { settings } = parseSettingsJson(JSON.stringify({
      allow: ["Read", "Grep"],
      deny: ["Bash(rm -rf *)"],
      ask: ["Write"],
    }));
    expect((settings as any).allow).toContain("Read");
    expect((settings as any).deny).toContain("Bash(rm -rf *)");
    expect((settings as any).ask).toContain("Write");
  });

  it("extracts hooks", () => {
    const { hooks } = parseSettingsJson(JSON.stringify({
      hooks: {
        PostToolUse: [{
          hooks: [{ command: "bash scripts/log.sh", type: "command", timeout: 5 }],
          matcher: "Bash",
        }],
      },
    }));
    expect(hooks.length).toBe(1);
    expect(hooks[0].on).toBe("PostToolUse");
    expect(hooks[0].run).toBe("bash scripts/log.sh");
  });

  it("skips gate hooks", () => {
    const { hooks } = parseSettingsJson(JSON.stringify({
      hooks: {
        SubagentStop: [{
          hooks: [{ command: "bash scripts/gate-quality.sh", type: "command" }],
          matcher: "builder",
        }],
      },
    }));
    expect(hooks.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// .mcp.json parser tests
// ---------------------------------------------------------------------------

describe("parseMcpJson", () => {
  it("extracts MCP servers", () => {
    const servers = parseMcpJson(JSON.stringify({
      mcpServers: {
        supabase: { command: "npx", args: ["supabase-mcp"], env: {} },
      },
    }));
    expect(servers.supabase).toBeDefined();
    expect(servers.supabase.command).toBe("npx");
  });
});

// ---------------------------------------------------------------------------
// Command parser tests
// ---------------------------------------------------------------------------

describe("parseCommandMd", () => {
  it("extracts trigger from command file", () => {
    const trigger = parseCommandMd("start.md", `---
description: "Start"
---

# /start <TOPIC>

## Arguments
- TOPIC: the topic
`);
    expect(trigger).toBeDefined();
    expect(trigger!.name).toBe("start");
    expect(trigger!.pattern).toBe("/start <TOPIC>");
    expect(trigger!.argument).toBe("TOPIC");
  });
});

// ---------------------------------------------------------------------------
// Action script parser tests
// ---------------------------------------------------------------------------

describe("parseActionScript", () => {
  it("extracts action from script", () => {
    const action = parseActionScript("action-intake.sh", `#!/usr/bin/env bash
# Action: intake — Parse user request
# Auto-generated by agentopology scaffold — edit as needed.
set -euo pipefail

echo "TODO: implement inline action"
`);
    expect(action).toBeDefined();
    expect(action!.id).toBe("intake");
    expect(action!.description).toBe("Parse user request");
    expect(action!.kind).toBe("inline");
  });

  it("detects external actions", () => {
    const action = parseActionScript("action-fetch.sh", `#!/usr/bin/env bash
# Action: fetch — Get external data
# External source: github-pr
set -euo pipefail
`);
    expect(action).toBeDefined();
    expect(action!.kind).toBe("external");
    expect(action!.source).toBe("github-pr");
  });
});

// ---------------------------------------------------------------------------
// Full import tests
// ---------------------------------------------------------------------------

describe("importClaudeCode", () => {
  it("imports basic agent files", () => {
    const files: PlatformFile[] = [
      {
        path: "agents/worker/AGENT.md",
        content: `---
name: worker
model: sonnet
tools:
  - Read
  - Write
---

## Instructions
Do work.
`,
      },
    ];

    const ast = importClaudeCode(files, "test-import");
    expect(ast.topology.name).toBe("test-import");
    expect(ast.nodes.length).toBeGreaterThanOrEqual(1);

    const worker = ast.nodes.find((n) => n.id === "worker");
    expect(worker).toBeDefined();
    expect(worker!.type).toBe("agent");
    expect((worker as any).model).toBe("sonnet");
  });

  it("imports with SKILL.md topology metadata", () => {
    const files: PlatformFile[] = [
      {
        path: "agents/researcher/AGENT.md",
        content: `---
name: researcher
model: sonnet
---

## Instructions
Research things.
`,
      },
      {
        path: "skills/my-pipeline/SKILL.md",
        content: SIMPLE_SKILL_MD,
      },
    ];

    const ast = importClaudeCode(files, "fallback-name");
    expect(ast.topology.name).toBe("test-pipeline"); // from SKILL.md, not fallback
    expect(ast.topology.version).toBe("1.0.0");
    expect(ast.edges.length).toBe(3);
  });

  it("imports settings.json", () => {
    const files: PlatformFile[] = [
      {
        path: "agents/worker/AGENT.md",
        content: `---
name: worker
model: sonnet
---
`,
      },
      {
        path: ".claude/settings.json",
        content: JSON.stringify({ allow: ["Read"], deny: ["Bash"] }),
      },
    ];

    const ast = importClaudeCode(files, "test");
    expect((ast.settings as any).allow).toContain("Read");
  });

  it("imports .mcp.json", () => {
    const files: PlatformFile[] = [
      {
        path: "agents/worker/AGENT.md",
        content: `---
name: worker
model: sonnet
---
`,
      },
      {
        path: ".mcp.json",
        content: JSON.stringify({ mcpServers: { db: { command: "npx", args: ["db-mcp"] } } }),
      },
    ];

    const ast = importClaudeCode(files, "test");
    expect(ast.mcpServers.db).toBeDefined();
  });

  it("generates linear flow when no SKILL.md", () => {
    const files: PlatformFile[] = [
      {
        path: "agents/alpha/AGENT.md",
        content: `---
name: alpha
model: sonnet
---
`,
      },
      {
        path: "agents/beta/AGENT.md",
        content: `---
name: beta
model: sonnet
---
`,
      },
    ];

    const ast = importClaudeCode(files, "test");
    expect(ast.edges.length).toBe(1);
    expect(ast.edges[0].from).toBe("alpha");
    expect(ast.edges[0].to).toBe("beta");
  });

  it("handles human and group nodes", () => {
    const files: PlatformFile[] = [
      { path: "agents/review/AGENT.md", content: HUMAN_AGENT_MD },
      { path: "agents/debate/AGENT.md", content: GROUP_AGENT_MD },
    ];

    const ast = importClaudeCode(files, "test");
    const human = ast.nodes.find((n) => n.type === "human");
    const group = ast.nodes.find((n) => n.type === "group");
    expect(human).toBeDefined();
    expect(group).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// importFromPlatform dispatch tests
// ---------------------------------------------------------------------------

describe("importFromPlatform", () => {
  it("dispatches to claude-code", () => {
    const files: PlatformFile[] = [
      {
        path: "agents/worker/AGENT.md",
        content: `---
name: worker
model: sonnet
---

## Instructions
Work.
`,
      },
    ];

    const atSource = importFromPlatform(files, "claude-code", "test");
    expect(atSource).toContain("topology test");
    expect(atSource).toContain("agent worker");
  });

  it("throws for unsupported binding", () => {
    expect(() => importFromPlatform([], "unknown", "test")).toThrow(
      "Import not supported",
    );
  });

  it("generates parseable .at output", () => {
    const files: PlatformFile[] = [
      {
        path: "agents/researcher/AGENT.md",
        content: BASIC_AGENT_MD,
      },
    ];

    const atSource = importFromPlatform(files, "claude-code", "my-topology");
    // Should parse without throwing
    const ast = parse(atSource);
    expect(ast.topology.name).toBe("my-topology");
  });
});

// ---------------------------------------------------------------------------
// Round-trip test: scaffold → import
// ---------------------------------------------------------------------------

describe("round-trip: parse → serialize → parse", () => {
  it("round-trips a complex topology", () => {
    const source = `
topology complex : [pipeline, fan-out] {
  meta {
    version: "2.0.0"
    description: "Complex topology"
    domain: testing
  }
  orchestrator {
    model: opus
    handles: [intake, report]
  }
  roles {
    lead: "Lead researcher"
  }
  action intake { kind: inline description: "Start" }
  agent lead-researcher {
    role: lead
    model: gpt-4o
    permissions: supervised
    phase: 1
    tools: [Read, Grep, WebSearch]
    reads: ["workspace/data.md"]
    writes: ["workspace/output.md"]
    outputs: {
      confidence: high | medium | low
    }
    timeout: 10m
    on-fail: retry
    retry: 3
    prompt {
      You are the lead researcher.
    }
  }
  agent writer {
    model: sonnet
    phase: 2
    tools: [Read, Write]
    prompt {
      You write documents.
    }
  }
  action report { kind: report description: "Done" }
  flow {
    intake -> lead-researcher
    lead-researcher -> writer
    writer -> report
  }
  gates {
    gate quality {
      after: writer
      run: "scripts/check.sh"
      checks: [grammar]
      on-fail: bounce-back
    }
  }
  memory {
    workspace {
      path: "workspace/"
    }
  }
  triggers {
    command start {
      pattern: "/start"
    }
  }
  settings {
    allow: ["Read", "Grep"]
  }
  mcp-servers {
    db {
      command: npx
      args: ["db-mcp"]
    }
  }
}
`;
    const ast = parse(source);
    const serialized = serializeAST(ast);
    const reparsed = parse(serialized);

    // Verify key fields survived
    expect(reparsed.topology.name).toBe("complex");
    expect(reparsed.topology.version).toBe("2.0.0");
    expect(reparsed.topology.domain).toBe("testing");
    expect(reparsed.nodes.filter((n) => n.type === "agent").length).toBe(2);
    expect(reparsed.edges.length).toBe(3);
    expect(reparsed.triggers.length).toBe(1);
    expect(Object.keys(reparsed.mcpServers).length).toBe(1);

    const lead = reparsed.nodes.find((n) => n.id === "lead-researcher") as any;
    expect(lead.model).toBe("gpt-4o");
    expect(lead.timeout).toBe("10m");
    expect(lead.retry).toBe(3);
    expect(lead.outputs.confidence).toContain("high");
  });
});

// ===========================================================================
// OpenClaw importer tests
// ===========================================================================

import {
  parseOpenClawJson,
  parseSoulMd,
  parseAgentsMd,
  parseSkillFile,
  parseMemoryMd,
  parseCronJobsJson,
  importOpenClaw,
} from "../openclaw.js";

// ---------------------------------------------------------------------------
// OpenClaw test data
// ---------------------------------------------------------------------------

const OPENCLAW_JSON = `{
  "agents": {
    "defaults": {
      "workspace": "~/.openclaw/workspace",
      "model": { "primary": "openrouter/google/gemini-2.5-flash" }
    },
    "list": [
      {
        "id": "commander",
        "name": "Commander",
        "model": { "primary": "openrouter/google/gemini-2.5-flash" },
        "workspace": "~/.openclaw/workspace-commander",
        "agentDir": "~/.openclaw/config/agents/commander/agent",
        "subagents": { "allowAgents": ["researcher", "worker"] }
      },
      {
        "id": "researcher",
        "name": "Researcher",
        "model": {
          "primary": "openrouter/google/gemini-2.5-flash",
          "fallbacks": ["openrouter/google/gemini-2.5-flash-lite"]
        },
        "workspace": "~/.openclaw/workspace-researcher",
        "agentDir": "~/.openclaw/config/agents/researcher/agent"
      }
    ]
  },
  "gateway": { "port": 18789, "auth": { "mode": "token", "token": "\${OPENCLAW_AUTH_TOKEN}" } },
  "models": {
    "providers": {
      "openrouter": {
        "apiKey": "\${OPENROUTER_API_KEY}",
        "baseUrl": "https://openrouter.ai/api/v1",
        "models": [
          { "id": "openrouter/google/gemini-2.5-flash", "name": "Gemini 2.5 Flash" }
        ]
      }
    }
  },
  "tools": { "allow": [], "deny": ["dangerous-tool"], "agentToAgent": { "enabled": true } },
  "env": { "OPENROUTER_API_KEY": "\${OPENROUTER_API_KEY}", "MY_VAR": "hello" }
}`;

const SOUL_MD = `> A test topology for unit testing.

## Identity
- Name: Test Topology
- Version: 2.0.0
- Patterns: supervisor, fan-out

## Mission
A test topology for unit testing.

## Roles
### Strategy
Plan and coordinate

### Research
Find information

## Ethical Guardrails
- Tool restrictions: none

## Parameters

- **campaign**: string (required)
- **mode**: string = intelligence

## Interface

- Entry: commander
- Exit: commander

## Triggers

### launch
Pattern: \`/launch <CAMPAIGN>\`
Argument: CAMPAIGN

### status
Pattern: \`/status <CAMPAIGN>\`
Argument: CAMPAIGN

## Environment

- \`OPENROUTER_API_KEY\`: \${OPENROUTER_API_KEY}
- \`MY_VAR\`: hello
`;

const AGENTS_MD = `# Sub-Agent Definitions

## Pipeline Overview
Test Topology uses a supervisor + fan-out topology.

## Agents

### Commander
- **Model:** openrouter/google/gemini-2.5-flash
- **Phase:** 1
- **Role:** Plan and coordinate
- **Tools allowed:** Read, Write, Bash
- **Tools denied:** none
- **Reads:** workspace
- **Writes:** workspace
- **Skills:** campaign-management
- **Max turns:** 100

#### Instructions

You are the commander.

Do important things.
- **Maximum execution time:** 30m
- **Retry:** max 2 attempts

### Researcher
- **Model:** openrouter/google/gemini-2.5-flash
- **Phase:** 2
- **Role:** Find information
- **Tools allowed:** Read, Write
- **Tools denied:** none
- **Reads:** workspace, domains
- **Writes:** workspace
- **Rate limit:** 30/hour
- **Circuit breaker:** threshold=5, window=30m, cooldown=1h
- **On failure:** continue

#### Instructions

You are the researcher.
- **Maximum execution time:** 45m
- **Retry:** max 3 attempts

## Group Chat Coordination

### Strategy Session
- **Members:** commander, researcher
- **Speaker selection:** round-robin
- **Max rounds:** 5
- **Termination:** Commander confirms the plan
- **Description:** Strategy planning session
- **Timeout:** 30m

## Flow

### Execution Order
1. commander -> strategy-session
2. strategy-session -> researcher
3. researcher -x-> commander (max 3 iterations)

### Bounded Loops
- researcher <-> commander: max 3 iterations (prevents infinite loops)

### Error Handling
- On error in researcher: route to commander

## Gates

### Quality Check
- **After:** researcher
- **Before:** commander
- **On failure:** bounce-back
- **Behavior:** blocking
- **Checks:** output-valid, data-complete

## Schedule

### Morning Run
- **Agent:** commander
- **Cron:** \`0 9 * * 0-4\`
- **Enabled:** true

## Hooks

### Block Destructive
- **Event:** PreToolUse
- **Run:** exit 2
- **Type:** command

### Log Completion
- **Event:** AgentStop
- **Run:** scripts/log.sh
- **Type:** command

---

## Test Topology -- Topology Overview

### Architecture
- Patterns: supervisor, fan-out
- Agents: 2
- Gates: 1
- Version: 2.0.0
`;

const SKILL_MD = `---
name: campaign-management
description: Manage campaigns end to end
user-invocable: true
---

This skill manages campaign lifecycle.
`;

const MEMORY_MD = `# Memory Structure

## Workspace
- Path: \`campaigns/{CAMPAIGN}/\`
- Structure: messages, outbox, logs

## Domains
- Path: \`campaigns/{CAMPAIGN}/intel/\`
`;

// ---------------------------------------------------------------------------
// parseOpenClawJson
// ---------------------------------------------------------------------------

describe("parseOpenClawJson", () => {
  it("extracts agent list with models", () => {
    const result = parseOpenClawJson(OPENCLAW_JSON);
    expect(result.agents).toHaveLength(2);
    expect(result.agents[0].id).toBe("commander");
    expect(result.agents[0].model).toBe("openrouter/google/gemini-2.5-flash");
    expect(result.agents[0].subagents).toEqual(["researcher", "worker"]);
  });

  it("extracts fallback chains", () => {
    const result = parseOpenClawJson(OPENCLAW_JSON);
    expect(result.agents[1].fallbacks).toEqual(["openrouter/google/gemini-2.5-flash-lite"]);
  });

  it("extracts providers", () => {
    const result = parseOpenClawJson(OPENCLAW_JSON);
    expect(result.providers).toHaveLength(1);
    expect(result.providers[0].name).toBe("openrouter");
    expect(result.providers[0].apiKey).toBe("${OPENROUTER_API_KEY}");
    expect(result.providers[0].baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(result.providerNames).toEqual(["openrouter"]);
  });

  it("extracts tools settings and env", () => {
    const result = parseOpenClawJson(OPENCLAW_JSON);
    expect(result.settings.deny).toEqual(["dangerous-tool"]);
    expect(result.env.MY_VAR).toBe("hello");
  });

  it("extracts gateway extensions", () => {
    const result = parseOpenClawJson(OPENCLAW_JSON);
    expect(result.extensions["gateway-port"]).toBe(18789);
    expect(result.extensions["auth-mode"]).toBe("token");
  });
});

// ---------------------------------------------------------------------------
// parseSoulMd
// ---------------------------------------------------------------------------

describe("parseSoulMd", () => {
  it("extracts identity", () => {
    const result = parseSoulMd(SOUL_MD);
    expect(result.name).toBe("test-topology");
    expect(result.version).toBe("2.0.0");
    expect(result.patterns).toEqual(["supervisor", "fan-out"]);
  });

  it("extracts description from quote block", () => {
    const result = parseSoulMd(SOUL_MD);
    expect(result.description).toBe("A test topology for unit testing.");
  });

  it("extracts roles", () => {
    const result = parseSoulMd(SOUL_MD);
    expect(result.roles.strategy).toBe("Plan and coordinate");
    expect(result.roles.research).toBe("Find information");
  });

  it("extracts parameters", () => {
    const result = parseSoulMd(SOUL_MD);
    expect(result.params).toHaveLength(2);
    expect(result.params[0]).toEqual({ name: "campaign", type: "string", default: undefined, required: true });
    expect(result.params[1]).toEqual({ name: "mode", type: "string", default: "intelligence", required: false });
  });

  it("extracts interface endpoints", () => {
    const result = parseSoulMd(SOUL_MD);
    expect(result.interfaceEndpoints).toEqual({ entry: "commander", exit: "commander" });
  });

  it("extracts triggers", () => {
    const result = parseSoulMd(SOUL_MD);
    expect(result.triggers).toHaveLength(2);
    expect(result.triggers[0]).toEqual({ name: "launch", pattern: "/launch <CAMPAIGN>", argument: "CAMPAIGN" });
    expect(result.triggers[1]).toEqual({ name: "status", pattern: "/status <CAMPAIGN>", argument: "CAMPAIGN" });
  });

  it("extracts environment variables", () => {
    const result = parseSoulMd(SOUL_MD);
    expect(result.env["OPENROUTER_API_KEY"]).toBe("${OPENROUTER_API_KEY}");
    expect(result.env["MY_VAR"]).toBe("hello");
  });
});

// ---------------------------------------------------------------------------
// parseAgentsMd
// ---------------------------------------------------------------------------

describe("parseAgentsMd", () => {
  it("extracts agents with basic properties", () => {
    const result = parseAgentsMd(AGENTS_MD);
    expect(result.agents).toHaveLength(2);
    const cmd = result.agents[0];
    expect(cmd.id).toBe("commander");
    expect(cmd.phase).toBe(1);
    expect(cmd.tools).toEqual(["Read", "Write", "Bash"]);
    expect(cmd.reads).toEqual(["workspace"]);
    expect(cmd.writes).toEqual(["workspace"]);
    expect(cmd.skills).toEqual(["campaign-management"]);
    expect(cmd.maxTurns).toBe(100);
  });

  it("extracts agent prompt (instructions)", () => {
    const result = parseAgentsMd(AGENTS_MD);
    const cmd = result.agents[0];
    expect(cmd.prompt).toContain("You are the commander.");
    expect(cmd.prompt).toContain("Do important things.");
  });

  it("extracts trailing properties after instructions", () => {
    const result = parseAgentsMd(AGENTS_MD);
    const cmd = result.agents[0];
    expect(cmd.timeout).toBe("30m");
    expect(cmd.retry).toBe(2);
  });

  it("extracts rate limit and circuit breaker", () => {
    const result = parseAgentsMd(AGENTS_MD);
    const researcher = result.agents[1];
    expect(researcher.rateLimit).toBe("30/hour");
    expect(researcher.circuitBreaker).toEqual({
      threshold: 5,
      window: "30m",
      cooldown: "1h",
    });
    expect(researcher.onFail).toBe("continue");
  });

  it("extracts group chat", () => {
    const result = parseAgentsMd(AGENTS_MD);
    expect(result.groups).toHaveLength(1);
    const group = result.groups[0];
    expect(group.id).toBe("strategy-session");
    expect(group.members).toEqual(["commander", "researcher"]);
    expect(group.speakerSelection).toBe("round-robin");
    expect(group.maxRounds).toBe(5);
    expect(group.termination).toBe("Commander confirms the plan");
    expect(group.timeout).toBe("30m");
  });

  it("extracts flow edges including error edges", () => {
    const result = parseAgentsMd(AGENTS_MD);
    expect(result.edges).toHaveLength(3);

    expect(result.edges[0]).toMatchObject({ from: "commander", to: "strategy-session" });
    expect(result.edges[0].isError).toBeUndefined();
    expect(result.edges[1]).toMatchObject({ from: "strategy-session", to: "researcher" });
    expect(result.edges[1].isError).toBeUndefined();
    expect(result.edges[2]).toMatchObject({ from: "researcher", to: "commander", isError: true, maxIterations: 3 });
  });

  it("extracts gates", () => {
    const result = parseAgentsMd(AGENTS_MD);
    expect(result.gates).toHaveLength(1);
    const gate = result.gates[0];
    expect(gate.id).toBe("quality-check");
    expect(gate.after).toBe("researcher");
    expect(gate.before).toBe("commander");
    expect(gate.onFail).toBe("bounce-back");
    expect(gate.behavior).toBe("blocking");
    expect(gate.checks).toEqual(["output-valid", "data-complete"]);
  });

  it("extracts schedule", () => {
    const result = parseAgentsMd(AGENTS_MD);
    expect(result.schedules).toHaveLength(1);
    expect(result.schedules[0]).toEqual({
      id: "morning-run",
      agent: "commander",
      cron: "0 9 * * 0-4",
      enabled: true,
    });
  });

  it("extracts hooks", () => {
    const result = parseAgentsMd(AGENTS_MD);
    expect(result.hooks).toHaveLength(2);
    expect(result.hooks[0].name).toBe("block-destructive");
    expect(result.hooks[0].on).toBe("PreToolUse");
    expect(result.hooks[0].run).toBe("exit 2");
    expect(result.hooks[1].name).toBe("log-completion");
    expect(result.hooks[1].on).toBe("AgentStop");
  });
});

// ---------------------------------------------------------------------------
// parseSkillFile
// ---------------------------------------------------------------------------

describe("parseSkillFile (openclaw)", () => {
  it("extracts skill from frontmatter", () => {
    const skill = parseSkillFile("campaign-management", SKILL_MD);
    expect(skill.id).toBe("campaign-management");
    expect(skill.description).toBe("Manage campaigns end to end");
    expect(skill.userInvocable).toBe(true);
  });

  it("handles skill without frontmatter", () => {
    const skill = parseSkillFile("my-skill", "This skill does things.");
    expect(skill.id).toBe("my-skill");
    expect(skill.description).toBe("This skill does things.");
    expect(skill.userInvocable).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parseMemoryMd
// ---------------------------------------------------------------------------

describe("parseMemoryMd", () => {
  it("extracts workspace and domains", () => {
    const result = parseMemoryMd(MEMORY_MD);
    const ws = result.memory.workspace as any;
    expect(ws.path).toBe("campaigns/{CAMPAIGN}/");
    expect(ws.structure).toEqual(["messages", "outbox", "logs"]);

    const domains = result.memory.domains as any;
    expect(domains.path).toBe("campaigns/{CAMPAIGN}/intel/");
  });
});

// ---------------------------------------------------------------------------
// parseCronJobsJson
// ---------------------------------------------------------------------------

describe("parseCronJobsJson", () => {
  it("parses cron jobs array", () => {
    const json = JSON.stringify({
      jobs: [
        { id: "morning", agentId: "commander", schedule: { expr: "0 9 * * *" }, enabled: true },
        { id: "evening", agentId: "reporter", cron: "0 18 * * *", enabled: false },
      ],
    });
    const jobs = parseCronJobsJson(json);
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toEqual({ id: "morning", agent: "commander", cron: "0 9 * * *", enabled: true });
    expect(jobs[1]).toEqual({ id: "evening", agent: "reporter", cron: "0 18 * * *", enabled: false });
  });
});

// ---------------------------------------------------------------------------
// importOpenClaw (integration)
// ---------------------------------------------------------------------------

describe("importOpenClaw", () => {
  const minimalFiles: PlatformFile[] = [
    { path: "openclaw.json", content: OPENCLAW_JSON },
    { path: "SOUL.md", content: SOUL_MD },
    { path: "AGENTS.md", content: AGENTS_MD },
    { path: "MEMORY.md", content: MEMORY_MD },
    { path: "skills/campaign-management/SKILL.md", content: SKILL_MD },
  ];

  it("produces a complete TopologyAST", () => {
    const ast = importOpenClaw(minimalFiles, "test-topology");
    expect(ast.topology.name).toBe("test-topology");
    expect(ast.topology.version).toBe("2.0.0");
    expect(ast.topology.patterns).toEqual(["supervisor", "fan-out"]);
    expect(ast.topology.description).toBe("A test topology for unit testing.");
  });

  it("imports agents with reverse-mapped models", () => {
    const ast = importOpenClaw(minimalFiles, "test-topology");
    const agents = ast.nodes.filter((n) => n.type === "agent");
    expect(agents).toHaveLength(2);

    const cmd = agents.find((a) => a.id === "commander") as any;
    expect(cmd.model).toBe("google/gemini-2.5-flash");
    expect(cmd.phase).toBe(1);
    expect(cmd.timeout).toBe("30m");

    const researcher = agents.find((a) => a.id === "researcher") as any;
    expect(researcher.model).toBe("google/gemini-2.5-flash");
    expect(researcher.fallbackChain).toEqual(["google/gemini-2.5-flash-lite"]);
  });

  it("imports roles, matching agents to role keys", () => {
    const ast = importOpenClaw(minimalFiles, "test-topology");
    expect(ast.roles.strategy).toBe("Plan and coordinate");
    expect(ast.roles.research).toBe("Find information");

    const cmd = ast.nodes.find((n) => n.id === "commander") as any;
    expect(cmd.role).toBe("strategy");
  });

  it("imports groups, gates, edges, hooks, schedules", () => {
    const ast = importOpenClaw(minimalFiles, "test-topology");
    const groups = ast.nodes.filter((n) => n.type === "group");
    expect(groups).toHaveLength(1);

    const gates = ast.nodes.filter((n) => n.type === "gate");
    expect(gates).toHaveLength(1);

    expect(ast.edges).toHaveLength(3);
    expect(ast.hooks).toHaveLength(2);
    expect(ast.schedules).toHaveLength(1);
  });

  it("imports skills", () => {
    const ast = importOpenClaw(minimalFiles, "test-topology");
    expect(ast.skills).toHaveLength(1);
    expect(ast.skills[0].id).toBe("campaign-management");
    expect(ast.skills[0].userInvocable).toBe(true);
  });

  it("imports params, triggers, interface endpoints", () => {
    const ast = importOpenClaw(minimalFiles, "test-topology");
    expect(ast.params).toHaveLength(2);
    expect(ast.triggers).toHaveLength(2);
    expect(ast.interfaceEndpoints).toEqual({ entry: "commander", exit: "commander" });
  });

  it("imports providers with reverse-mapped models", () => {
    const ast = importOpenClaw(minimalFiles, "test-topology");
    expect(ast.providers).toHaveLength(1);
    expect(ast.providers[0].name).toBe("openrouter");
    expect(ast.providers[0].default).toBe(true);
  });

  it("imports env and settings", () => {
    const ast = importOpenClaw(minimalFiles, "test-topology");
    expect(ast.env["MY_VAR"]).toBe("hello");
    expect((ast.settings as any).deny).toEqual(["dangerous-tool"]);
  });

  it("imports memory", () => {
    const ast = importOpenClaw(minimalFiles, "test-topology");
    expect((ast.memory as any).workspace?.path).toBe("campaigns/{CAMPAIGN}/");
  });
});

// ---------------------------------------------------------------------------
// importFromPlatform — OpenClaw dispatch
// ---------------------------------------------------------------------------

describe("importFromPlatform (openclaw)", () => {
  it("dispatches to openclaw", () => {
    const files: PlatformFile[] = [
      { path: "openclaw.json", content: OPENCLAW_JSON },
      { path: "SOUL.md", content: SOUL_MD },
      { path: "AGENTS.md", content: AGENTS_MD },
    ];

    const atSource = importFromPlatform(files, "openclaw", "test");
    // SOUL.md Identity overrides the topologyName param
    expect(atSource).toContain("topology test-topology");
    expect(atSource).toContain("agent commander");
    expect(atSource).toContain("agent researcher");
  });

  it("falls back to topologyName when SOUL.md is missing", () => {
    const files: PlatformFile[] = [
      { path: "openclaw.json", content: OPENCLAW_JSON },
      { path: "AGENTS.md", content: AGENTS_MD },
    ];

    const atSource = importFromPlatform(files, "openclaw", "my-project");
    expect(atSource).toContain("topology my-project");
  });

  it("generates parseable .at output", () => {
    const files: PlatformFile[] = [
      { path: "openclaw.json", content: OPENCLAW_JSON },
      { path: "SOUL.md", content: SOUL_MD },
      { path: "AGENTS.md", content: AGENTS_MD },
      { path: "MEMORY.md", content: MEMORY_MD },
      { path: "skills/campaign-management/SKILL.md", content: SKILL_MD },
    ];

    const atSource = importFromPlatform(files, "openclaw", "test");
    const ast = parse(atSource);
    expect(ast.topology.name).toBe("test-topology");
    expect(ast.nodes.filter((n) => n.type === "agent").length).toBe(2);
  });

  it("validates with zero errors (warnings allowed)", () => {
    const files: PlatformFile[] = [
      { path: "openclaw.json", content: OPENCLAW_JSON },
      { path: "SOUL.md", content: SOUL_MD },
      { path: "AGENTS.md", content: AGENTS_MD },
      { path: "MEMORY.md", content: MEMORY_MD },
      { path: "skills/campaign-management/SKILL.md", content: SKILL_MD },
    ];

    const atSource = importFromPlatform(files, "openclaw", "test");
    const ast = parse(atSource);
    const errors = validate(ast).filter((e) => e.level === "error");
    expect(errors).toEqual([]);
  });
});
