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
        PreToolUse: [{
          hooks: [{ command: "bash scripts/gate-quality.sh", type: "command" }],
          matcher: "Task",
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
