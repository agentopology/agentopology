import { describe, it, expect } from "vitest";
import { parse } from "../../parser/index.js";
import {
  bindings,
  claudeCodeBinding,
  codexBinding,
  geminiCliBinding,
  copilotCliBinding,
  openClawBinding,
  kiroBinding,
} from "../index.js";
import type { GeneratedFile } from "../types.js";

// ---------------------------------------------------------------------------
// Minimal but valid .at topology exercising most features
// ---------------------------------------------------------------------------

const TOPOLOGY_SOURCE = `
topology test-scaffold : [pipeline, fan-out] {

  meta {
    version: "1.0.0"
    description: "A minimal topology for binding tests"
  }

  orchestrator {
    model: opus
    generates: "commands/run.md"
    handles: [intake]
  }

  roles {
    planner: "Plans work items"
    builder: "Builds code"
  }

  action intake {
    kind: external
    source: "github-pr"
    description: "Fetch PR data"
  }

  agent planner {
    role: planner
    model: sonnet
    phase: 1
    tools: [Read, Grep]
    reads: ["workspace/input.md"]
    writes: ["workspace/plan.md"]
    permissions: supervised
    outputs: {
      status: ready | blocked
    }
  }

  agent builder {
    role: builder
    model: opus
    phase: 2
    tools: [Read, Write, Bash]
    reads: ["workspace/plan.md"]
    writes: ["workspace/output.md"]
    permissions: autonomous
    disallowed-tools: [Edit]
  }

  flow {
    intake -> planner
    planner -> builder  [when planner.status == ready]
  }

  gates {
    gate quality-check {
      after: builder
      run: "scripts/lint.sh"
      checks: [lint, types]
      on-fail: halt
    }
    gate soft-review {
      after: planner
      run: "scripts/review.sh"
      behavior: advisory
    }
  }

  triggers {
    command run {
      pattern: "/run <TASK>"
      argument: TASK
    }
  }

  hooks {
    hook post-build {
      on: PostToolUse
      matcher: Write
      run: "scripts/post-build.sh"
      type: command
    }
  }

  mcp-servers {
    filesystem {
      command: "npx"
      args: ["-y", "@modelcontextprotocol/server-filesystem"]
    }
  }

  memory {
    domains: true
    references: true
    metrics: true
    workspace {
      path: "workspace/"
      structure: [input, plan, output]
    }
  }

  settings {
    allow: ["Read", "Grep", "Glob"]
    deny: ["Bash"]
  }
}
`;

const ast = parse(TOPOLOGY_SOURCE);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Scaffold a binding and return the generated file list. */
function scaffoldBinding(name: string): GeneratedFile[] {
  const binding = bindings[name];
  if (!binding) throw new Error(`Unknown binding: ${name}`);
  return binding.scaffold(ast);
}

/** Assert standard structural invariants on scaffold output. */
function assertStructuralInvariants(files: GeneratedFile[]) {
  it("returns a non-empty array of GeneratedFile", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("every file has a non-empty path", () => {
    for (const f of files) {
      expect(f.path).toBeTruthy();
      expect(f.path.length).toBeGreaterThan(0);
    }
  });

  it("every file has content defined (string, may be empty for .gitkeep)", () => {
    for (const f of files) {
      expect(typeof f.content).toBe("string");
    }
  });

  it("non-.gitkeep files have non-empty content", () => {
    for (const f of files) {
      if (!f.path.endsWith(".gitkeep") && !f.path.endsWith(".jsonl")) {
        expect(f.content.length, `Expected non-empty content for ${f.path}`).toBeGreaterThan(0);
      }
    }
  });

  it("no two files have the same path (no collisions)", () => {
    const paths = files.map((f) => f.path);
    const unique = new Set(paths);
    expect(unique.size).toBe(paths.length);
  });
}

// ---------------------------------------------------------------------------
// Registry tests
// ---------------------------------------------------------------------------

describe("Binding registry", () => {
  it("contains all 6 bindings", () => {
    expect(Object.keys(bindings)).toHaveLength(6);
  });

  it("all bindings have a name and description", () => {
    for (const [key, binding] of Object.entries(bindings)) {
      expect(binding.name, `binding "${key}" should have a name`).toBeTruthy();
      expect(binding.description, `binding "${key}" should have a description`).toBeTruthy();
      expect(binding.name.length).toBeGreaterThan(0);
      expect(binding.description.length).toBeGreaterThan(0);
    }
  });

  it("registry keys match binding names", () => {
    for (const [key, binding] of Object.entries(bindings)) {
      expect(binding.name).toBe(key);
    }
  });
});

// ---------------------------------------------------------------------------
// claude-code
// ---------------------------------------------------------------------------

describe("claude-code binding", () => {
  const files = scaffoldBinding("claude-code");

  assertStructuralInvariants(files);

  it("produces AGENT.md files for each agent", () => {
    const agentFiles = files.filter((f) => f.path.endsWith("/AGENT.md"));
    expect(agentFiles.length).toBeGreaterThanOrEqual(2);

    const paths = agentFiles.map((f) => f.path);
    expect(paths).toContain(".claude/agents/planner/AGENT.md");
    expect(paths).toContain(".claude/agents/builder/AGENT.md");
  });

  it("produces a SKILL.md for the topology", () => {
    const skillFile = files.find((f) => f.path === ".claude/skills/test-scaffold/SKILL.md");
    expect(skillFile).toBeDefined();
    expect(skillFile!.content).toContain("test-scaffold");
  });

  it("produces command files from triggers", () => {
    const cmdFile = files.find((f) => f.path === ".claude/commands/run.md");
    expect(cmdFile).toBeDefined();
    expect(cmdFile!.content).toContain("/run");
  });

  it("produces .claude/settings.json with hooks", () => {
    const settingsFile = files.find((f) => f.path === ".claude/settings.json");
    expect(settingsFile).toBeDefined();
    const settings = JSON.parse(settingsFile!.content);
    expect(settings.hooks).toBeDefined();
  });

  it("produces .mcp.json for MCP servers", () => {
    const mcpFile = files.find((f) => f.path === ".mcp.json");
    expect(mcpFile).toBeDefined();
    const mcp = JSON.parse(mcpFile!.content);
    expect(mcp.mcpServers.filesystem).toBeDefined();
  });

  it("produces a context file (CLAUDE.md)", () => {
    const contextFile = files.find((f) => f.path === "CLAUDE.md");
    expect(contextFile).toBeDefined();
  });

  it("emits disallowed-tools in agent frontmatter", () => {
    const builderFile = files.find((f) => f.path === ".claude/agents/builder/AGENT.md");
    expect(builderFile).toBeDefined();
    expect(builderFile!.content).toContain("disallowed-tools:");
    expect(builderFile!.content).toContain("Edit");
  });

  it("compiles enforced gate to settings.json PreToolUse hook", () => {
    const settingsFile = files.find((f) => f.path === ".claude/settings.json");
    expect(settingsFile).toBeDefined();
    const settings = JSON.parse(settingsFile!.content);
    expect(settings.hooks.PreToolUse).toBeDefined();
    const gateHook = settings.hooks.PreToolUse.find(
      (h: Record<string, unknown>) => h.matcher === "Task" && JSON.stringify(h).includes("gate-quality-check")
    );
    expect(gateHook).toBeDefined();
  });

  it("does NOT compile advisory gate to settings.json hook", () => {
    const settingsFile = files.find((f) => f.path === ".claude/settings.json");
    const settings = JSON.parse(settingsFile!.content);
    const allHookJson = JSON.stringify(settings.hooks);
    expect(allHookJson).not.toContain("gate-soft-review");
  });

  it("generates gate wrapper script for enforced gate", () => {
    const wrapperScript = files.find((f) => f.path.includes("gate-quality-check.sh"));
    expect(wrapperScript).toBeDefined();
    expect(wrapperScript!.content).toContain("lint.sh");
    expect(wrapperScript!.content).toContain("exit 1");
  });

  it("does NOT generate gate wrapper script for advisory gate", () => {
    const advisoryWrapper = files.find((f) => f.path.includes("gate-soft-review.sh"));
    expect(advisoryWrapper).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// codex
// ---------------------------------------------------------------------------

describe("codex binding", () => {
  const files = scaffoldBinding("codex");

  assertStructuralInvariants(files);

  it("produces codex.toml", () => {
    const toml = files.find((f) => f.path === "codex.toml");
    expect(toml).toBeDefined();
    expect(toml!.content).toContain("model");
  });

  it("produces AGENTS.md", () => {
    const agentsMd = files.find((f) => f.path === "AGENTS.md");
    expect(agentsMd).toBeDefined();
    expect(agentsMd!.content).toContain("planner");
    expect(agentsMd!.content).toContain("builder");
  });

  it("produces .codex/instructions.md", () => {
    const instructions = files.find((f) => f.path === ".codex/instructions.md");
    expect(instructions).toBeDefined();
  });

  it("produces gate scripts under .codex/scripts/", () => {
    const gateScript = files.find((f) => f.path.startsWith(".codex/scripts/") && f.content.includes("Gate"));
    expect(gateScript).toBeDefined();
  });

  it("marks gate enforcement level in AGENTS.md", () => {
    const agentsMd = files.find((f) => f.path === "AGENTS.md");
    expect(agentsMd!.content).toContain("Enforcement:");
  });
});

// ---------------------------------------------------------------------------
// gemini-cli
// ---------------------------------------------------------------------------

describe("gemini-cli binding", () => {
  const files = scaffoldBinding("gemini-cli");

  assertStructuralInvariants(files);

  it("produces GEMINI.md context file", () => {
    const geminiMd = files.find((f) => f.path === "GEMINI.md");
    expect(geminiMd).toBeDefined();
  });

  it("produces .gemini/settings.json", () => {
    const settings = files.find((f) => f.path === ".gemini/settings.json");
    expect(settings).toBeDefined();
    const parsed = JSON.parse(settings!.content);
    expect(parsed).toBeDefined();
  });

  it("produces .gemini/instructions.md", () => {
    const instructions = files.find((f) => f.path === ".gemini/instructions.md");
    expect(instructions).toBeDefined();
  });

  it("produces command files from triggers", () => {
    const cmdFile = files.find((f) => f.path === ".gemini/commands/run.md");
    expect(cmdFile).toBeDefined();
  });

  it("produces MCP config at .gemini/settings/mcp.json", () => {
    const mcpFile = files.find((f) => f.path === ".gemini/settings/mcp.json");
    expect(mcpFile).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// copilot-cli
// ---------------------------------------------------------------------------

describe("copilot-cli binding", () => {
  const files = scaffoldBinding("copilot-cli");

  assertStructuralInvariants(files);

  it("produces .github/copilot-instructions.md", () => {
    const instructions = files.find((f) => f.path === ".github/copilot-instructions.md");
    expect(instructions).toBeDefined();
    expect(instructions!.content.length).toBeGreaterThan(0);
  });

  it("produces .github/agents/*.agent.md for each agent", () => {
    const agentFiles = files.filter((f) => f.path.match(/\.github\/agents\/.*\.agent\.md$/));
    expect(agentFiles.length).toBeGreaterThanOrEqual(2);

    const paths = agentFiles.map((f) => f.path);
    expect(paths).toContain(".github/agents/planner.agent.md");
    expect(paths).toContain(".github/agents/builder.agent.md");
  });

  it("generates gate script for enforced gate", () => {
    const gateScript = files.find((f) => f.path === "scripts/gate-quality-check.sh");
    expect(gateScript).toBeDefined();
    expect(gateScript!.content).toContain("lint.sh");
  });

  it("does NOT generate gate script for advisory gate", () => {
    const advisoryScript = files.find((f) => f.path === "scripts/gate-soft-review.sh");
    expect(advisoryScript).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// openclaw
// ---------------------------------------------------------------------------

describe("openclaw binding", () => {
  const files = scaffoldBinding("openclaw");

  assertStructuralInvariants(files);

  it("produces openclaw.json", () => {
    const config = files.find((f) => f.path === "openclaw.json");
    expect(config).toBeDefined();
    const parsed = JSON.parse(config!.content);
    expect(parsed).toBeDefined();
  });

  it("produces SOUL.md", () => {
    const soul = files.find((f) => f.path === "SOUL.md");
    expect(soul).toBeDefined();
  });

  it("produces AGENTS.md", () => {
    const agents = files.find((f) => f.path === "AGENTS.md");
    expect(agents).toBeDefined();
    expect(agents!.content).toContain("planner");
  });

  it("produces TOOLS.md", () => {
    const tools = files.find((f) => f.path === "TOOLS.md");
    expect(tools).toBeDefined();
  });

  it("produces MEMORY.md", () => {
    const memory = files.find((f) => f.path === "MEMORY.md");
    expect(memory).toBeDefined();
  });

  it("produces BOOTSTRAP.md", () => {
    const bootstrap = files.find((f) => f.path === "BOOTSTRAP.md");
    expect(bootstrap).toBeDefined();
  });

  it("produces TEAM.md", () => {
    const team = files.find((f) => f.path === "TEAM.md");
    expect(team).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// kiro (deep)
// ---------------------------------------------------------------------------

describe("kiro binding (deep)", () => {
  // A richer topology that exercises: multiple agents with tools/prompts,
  // hooks, triggers, mcp-servers, gates, memory, and different tool mappings.
  const RICH_TOPOLOGY = `
topology deep-kiro-test : [pipeline, fan-out] {

  meta {
    version: "2.0.0"
    description: "Rich topology for deep Kiro binding tests"
  }

  orchestrator {
    model: opus
    generates: "plans/run.md"
    handles: [ingest]
  }

  roles {
    analyzer: "Analyzes incoming data and produces structured reports"
    coder: "Writes and modifies source code"
    reviewer: "Reviews code changes for quality"
  }

  action ingest {
    kind: external
    source: "webhook"
    description: "Ingest data from webhook"
  }

  agent analyzer {
    role: analyzer
    model: sonnet
    phase: 1
    tools: [Read, Grep]
    reads: ["workspace/raw.md"]
    writes: ["workspace/analysis.md"]
    permissions: supervised
    outputs: {
      quality: good | bad | unknown
    }
    prompt {
      Carefully analyze all incoming data.
      Produce a structured report with findings.
    }
  }

  agent coder {
    role: coder
    model: opus
    phase: 2
    tools: [Read, Write, Bash, Edit]
    reads: ["workspace/analysis.md"]
    writes: ["workspace/code/"]
    permissions: autonomous
    mcp-servers: [filesystem, github]
    prompt {
      Implement code changes based on the analysis report.
      Follow existing patterns in the codebase.
    }
    hooks {
      hook coder-post-write {
        on: PostToolUse
        matcher: Write
        run: "scripts/format.sh"
        type: command
      }
    }
  }

  agent reviewer {
    role: reviewer
    model: haiku
    phase: 3
    tools: [Read, Bash]
    reads: ["workspace/code/"]
    writes: ["workspace/review.md"]
    permissions: supervised
  }

  flow {
    ingest -> analyzer
    analyzer -> coder    [when analyzer.quality == good]
    coder -> reviewer
    reviewer -> coder    [when reviewer.verdict == revise] [max 3]
  }

  gates {
    gate lint-gate {
      after: coder
      run: "scripts/lint-check.sh"
      checks: [lint, types, format]
      on-fail: halt
    }
    gate security-gate {
      before: reviewer
      run: "scripts/security-scan.sh"
      checks: [cve, secrets]
      on-fail: halt
    }
  }

  triggers {
    command analyze {
      pattern: "/analyze <INPUT>"
      argument: INPUT
    }
    command deploy {
      pattern: "/deploy <ENV>"
      argument: ENV
    }
  }

  hooks {
    hook global-post-write {
      on: PostToolUse
      matcher: Write
      run: "scripts/post-write.sh"
      type: command
    }
    hook pre-bash {
      on: PreToolUse
      matcher: Bash
      run: "scripts/pre-bash.sh"
      type: command
    }
  }

  mcp-servers {
    filesystem {
      command: "npx"
      args: ["-y", "@modelcontextprotocol/server-filesystem"]
    }
    github {
      command: "npx"
      args: ["-y", "@modelcontextprotocol/server-github"]
      env: {
        GITHUB_TOKEN: "\${GITHUB_TOKEN}"
      }
    }
  }

  memory {
    domains: true
    references: true
    metrics: true
    workspace {
      path: "workspace/"
      structure: [raw, analysis, code, review]
    }
  }

  settings {
    allow: ["Read", "Grep", "Glob"]
    deny: ["Bash"]
  }
}
`;

  const richAst = parse(RICH_TOPOLOGY);
  const files = kiroBinding.scaffold(richAst);

  // 1. Agent JSON validity
  describe("agent JSON validity", () => {
    const agentFiles = files.filter((f) => f.path.match(/\.kiro\/agents\/.*\.json$/));

    it("produces a JSON file for each agent", () => {
      expect(agentFiles.length).toBe(3);
      const paths = agentFiles.map((f) => f.path);
      expect(paths).toContain(".kiro/agents/analyzer.json");
      expect(paths).toContain(".kiro/agents/coder.json");
      expect(paths).toContain(".kiro/agents/reviewer.json");
    });

    it("each agent JSON has id (name), description, and instructions (prompt) fields", () => {
      for (const f of agentFiles) {
        const json = JSON.parse(f.content);
        expect(json.name, `${f.path} should have a name field`).toBeDefined();
        expect(typeof json.name).toBe("string");
        expect(json.name.length).toBeGreaterThan(0);

        expect(json.description, `${f.path} should have a description field`).toBeDefined();
        expect(typeof json.description).toBe("string");
        expect(json.description.length).toBeGreaterThan(0);

        expect(json.prompt, `${f.path} should have a prompt (instructions) field`).toBeDefined();
        expect(typeof json.prompt).toBe("string");
        expect(json.prompt.length).toBeGreaterThan(0);
      }
    });
  });

  // 2. Steering docs have YAML frontmatter
  describe("steering docs", () => {
    const steeringFiles = files.filter((f) => f.path.startsWith(".kiro/steering/"));

    it("produces at least 3 steering files", () => {
      expect(steeringFiles.length).toBeGreaterThanOrEqual(3);
    });

    it("each steering file starts with YAML frontmatter (---)", () => {
      for (const f of steeringFiles) {
        expect(
          f.content.startsWith("---"),
          `${f.path} should start with YAML frontmatter (---)`
        ).toBe(true);
        // Should have closing frontmatter delimiter too
        const secondDash = f.content.indexOf("---", 3);
        expect(secondDash, `${f.path} should have closing --- in frontmatter`).toBeGreaterThan(3);
      }
    });
  });

  // 3. MCP config matches topology's mcp-servers
  describe("MCP config", () => {
    const mcpFile = files.find((f) => f.path === ".kiro/settings/mcp.json");

    it("produces valid JSON for mcp.json", () => {
      expect(mcpFile).toBeDefined();
      expect(() => JSON.parse(mcpFile!.content)).not.toThrow();
    });

    it("contains all declared MCP servers", () => {
      const mcp = JSON.parse(mcpFile!.content);
      expect(mcp.mcpServers).toBeDefined();
      expect(mcp.mcpServers.filesystem).toBeDefined();
      expect(mcp.mcpServers.github).toBeDefined();
    });

    it("server entries have command and args fields", () => {
      const mcp = JSON.parse(mcpFile!.content);
      for (const [name, config] of Object.entries(mcp.mcpServers) as [string, Record<string, unknown>][]) {
        expect(config.command, `MCP server "${name}" should have a command`).toBeDefined();
        expect(config.args, `MCP server "${name}" should have args`).toBeDefined();
      }
    });

    it("preserves env field from topology", () => {
      const mcp = JSON.parse(mcpFile!.content);
      // The parser stores env as-is from the topology; verify it exists on each server
      for (const [name, config] of Object.entries(mcp.mcpServers) as [string, Record<string, unknown>][]) {
        expect(config.env, `MCP server "${name}" should have an env field`).toBeDefined();
      }
    });
  });

  // 4. Hook mapping — verify hook/gate scripts are generated
  describe("hook mapping", () => {
    it("generates script stubs for global hooks", () => {
      const postWriteScript = files.find((f) => f.path === ".kiro/scripts/post-write.sh");
      expect(postWriteScript, "should generate post-write.sh for global-post-write hook").toBeDefined();
      expect(postWriteScript!.content).toContain("postToolUse");

      const preBashScript = files.find((f) => f.path === ".kiro/scripts/pre-bash.sh");
      expect(preBashScript, "should generate pre-bash.sh for pre-bash hook").toBeDefined();
      expect(preBashScript!.content).toContain("preToolUse");
    });

    it("generates script stubs for gate scripts", () => {
      const lintScript = files.find((f) => f.path === ".kiro/scripts/lint-check.sh");
      expect(lintScript, "should generate lint-check.sh for lint-gate").toBeDefined();
      expect(lintScript!.content).toContain("lint-gate");

      const securityScript = files.find((f) => f.path === ".kiro/scripts/security-scan.sh");
      expect(securityScript, "should generate security-scan.sh for security-gate").toBeDefined();
      expect(securityScript!.content).toContain("security-gate");
    });
  });

  // 5. Flow as prose — verify AGENTS.md contains agent names and flow description
  describe("flow as prose in AGENTS.md", () => {
    const agentsMd = files.find((f) => f.path === "AGENTS.md");

    it("AGENTS.md is generated", () => {
      expect(agentsMd).toBeDefined();
    });

    it("contains all agent names", () => {
      const content = agentsMd!.content;
      expect(content).toContain("analyzer");
      expect(content).toContain("coder");
      expect(content).toContain("reviewer");
    });

    it("contains a Flow section with edge descriptions", () => {
      const content = agentsMd!.content;
      expect(content).toContain("## Flow");
      expect(content).toContain("analyzer -> coder");
      expect(content).toContain("coder -> reviewer");
      expect(content).toContain("reviewer -> coder");
    });

    it("contains gate descriptions", () => {
      const content = agentsMd!.content;
      // Gate ids are title-cased in AGENTS.md (lint-gate -> Lint Gate)
      expect(content).toContain("Lint Gate");
      expect(content).toContain("Security Gate");
    });

    it("contains trigger descriptions", () => {
      const content = agentsMd!.content;
      expect(content).toContain("/analyze");
      expect(content).toContain("/deploy");
    });
  });

  // 6. Tool mapping — verify mapped tool names in agent instructions
  describe("tool mapping", () => {
    it("maps Read to 'read' in agent tools", () => {
      const analyzerFile = files.find((f) => f.path === ".kiro/agents/analyzer.json");
      const json = JSON.parse(analyzerFile!.content);
      expect(json.tools).toContain("read");
    });

    it("maps Write to 'write' in agent tools", () => {
      const coderFile = files.find((f) => f.path === ".kiro/agents/coder.json");
      const json = JSON.parse(coderFile!.content);
      expect(json.tools).toContain("write");
    });

    it("maps Bash to 'shell' in agent tools", () => {
      const coderFile = files.find((f) => f.path === ".kiro/agents/coder.json");
      const json = JSON.parse(coderFile!.content);
      expect(json.tools).toContain("shell");
    });

    it("maps Edit to 'write' in agent tools", () => {
      const coderFile = files.find((f) => f.path === ".kiro/agents/coder.json");
      const json = JSON.parse(coderFile!.content);
      // Edit maps to "write", so coder should have "write" (from both Write and Edit)
      expect(json.tools).toContain("write");
    });

    it("maps Grep to lowercase 'grep' in agent tools", () => {
      const analyzerFile = files.find((f) => f.path === ".kiro/agents/analyzer.json");
      const json = JSON.parse(analyzerFile!.content);
      expect(json.tools).toContain("grep");
    });
  });

  // 7. Prompt content — verify prompt text appears in agent JSON instructions
  describe("prompt content", () => {
    it("analyzer agent JSON contains its prompt text", () => {
      const analyzerFile = files.find((f) => f.path === ".kiro/agents/analyzer.json");
      const json = JSON.parse(analyzerFile!.content);
      expect(json.prompt).toContain("Carefully analyze all incoming data");
      expect(json.prompt).toContain("structured report with findings");
    });

    it("coder agent JSON contains its prompt text", () => {
      const coderFile = files.find((f) => f.path === ".kiro/agents/coder.json");
      const json = JSON.parse(coderFile!.content);
      expect(json.prompt).toContain("Implement code changes based on the analysis report");
      expect(json.prompt).toContain("Follow existing patterns in the codebase");
    });

    it("reviewer agent JSON has role text but no inline prompt", () => {
      const reviewerFile = files.find((f) => f.path === ".kiro/agents/reviewer.json");
      const json = JSON.parse(reviewerFile!.content);
      // reviewer has no prompt block, so only role text should be present
      expect(json.prompt).toContain("Reviews code changes for quality");
      expect(json.prompt).not.toContain("## Instructions");
    });
  });

  // 8. Trigger prompts — verify .kiro/prompts/ files are generated
  describe("trigger prompts", () => {
    it("generates a prompt file for each trigger", () => {
      const analyzePrompt = files.find((f) => f.path === ".kiro/prompts/analyze.md");
      expect(analyzePrompt, "should generate analyze.md prompt").toBeDefined();

      const deployPrompt = files.find((f) => f.path === ".kiro/prompts/deploy.md");
      expect(deployPrompt, "should generate deploy.md prompt").toBeDefined();
    });

    it("prompt files contain the trigger pattern", () => {
      const analyzePrompt = files.find((f) => f.path === ".kiro/prompts/analyze.md");
      expect(analyzePrompt!.content).toContain("/analyze <INPUT>");

      const deployPrompt = files.find((f) => f.path === ".kiro/prompts/deploy.md");
      expect(deployPrompt!.content).toContain("/deploy <ENV>");
    });

    it("prompt files contain argument info", () => {
      const analyzePrompt = files.find((f) => f.path === ".kiro/prompts/analyze.md");
      expect(analyzePrompt!.content).toContain("INPUT");

      const deployPrompt = files.find((f) => f.path === ".kiro/prompts/deploy.md");
      expect(deployPrompt!.content).toContain("ENV");
    });

    it("prompt files contain agent summary table", () => {
      const analyzePrompt = files.find((f) => f.path === ".kiro/prompts/analyze.md");
      expect(analyzePrompt!.content).toContain("analyzer");
      expect(analyzePrompt!.content).toContain("coder");
      expect(analyzePrompt!.content).toContain("reviewer");
    });
  });

  // Additional: memory directories
  describe("memory directories", () => {
    it("generates .kiro/runs/.gitkeep for workspace memory", () => {
      // The parser resolves the workspace sub-block from memory {}
      expect(files.find((f) => f.path === ".kiro/runs/.gitkeep")).toBeDefined();
    });

    it("structure steering mentions workspace layout", () => {
      const structureSteering = files.find((f) => f.path === ".kiro/steering/structure.md");
      expect(structureSteering).toBeDefined();
      // The workspace structure items appear in the steering doc
      expect(structureSteering!.content).toContain("Workspace");
    });
  });

  // Additional: per-agent hooks and MCP resources
  describe("per-agent hooks and MCP resources", () => {
    it("coder agent JSON includes per-agent hooks", () => {
      const coderFile = files.find((f) => f.path === ".kiro/agents/coder.json");
      const json = JSON.parse(coderFile!.content);
      expect(json.hooks).toBeDefined();
      expect(json.hooks.length).toBeGreaterThanOrEqual(1);
      expect(json.hooks[0].event).toBe("postToolUse");
    });

    it("coder agent JSON includes MCP resources", () => {
      const coderFile = files.find((f) => f.path === ".kiro/agents/coder.json");
      const json = JSON.parse(coderFile!.content);
      expect(json.resources).toBeDefined();
      expect(json.resources).toContain("mcp://filesystem");
      expect(json.resources).toContain("mcp://github");
    });
  });
});

// ---------------------------------------------------------------------------
// kiro
// ---------------------------------------------------------------------------

describe("kiro binding", () => {
  const files = scaffoldBinding("kiro");

  assertStructuralInvariants(files);

  it("produces .kiro/agents/*.json for each agent", () => {
    const agentFiles = files.filter((f) => f.path.match(/\.kiro\/agents\/.*\.json$/));
    expect(agentFiles.length).toBeGreaterThanOrEqual(2);

    const paths = agentFiles.map((f) => f.path);
    expect(paths).toContain(".kiro/agents/planner.json");
    expect(paths).toContain(".kiro/agents/builder.json");

    // Verify JSON is valid
    for (const f of agentFiles) {
      expect(() => JSON.parse(f.content)).not.toThrow();
    }
  });

  it("produces steering documents", () => {
    const steeringFiles = files.filter((f) => f.path.startsWith(".kiro/steering/"));
    expect(steeringFiles.length).toBeGreaterThanOrEqual(3);

    const paths = steeringFiles.map((f) => f.path);
    expect(paths).toContain(".kiro/steering/product.md");
    expect(paths).toContain(".kiro/steering/tech.md");
    expect(paths).toContain(".kiro/steering/structure.md");
  });

  it("produces .kiro/settings/mcp.json for MCP servers", () => {
    const mcpFile = files.find((f) => f.path === ".kiro/settings/mcp.json");
    expect(mcpFile).toBeDefined();
    const mcp = JSON.parse(mcpFile!.content);
    expect(mcp.mcpServers.filesystem).toBeDefined();
  });

  it("produces AGENTS.md top-level flow narrative", () => {
    const agentsMd = files.find((f) => f.path === "AGENTS.md");
    expect(agentsMd).toBeDefined();
    expect(agentsMd!.content).toContain("Flow");
  });

  it("produces prompt files from triggers", () => {
    const promptFile = files.find((f) => f.path === ".kiro/prompts/run.md");
    expect(promptFile).toBeDefined();
  });

  it("produces memory directories", () => {
    const runsKeep = files.find((f) => f.path === ".kiro/runs/.gitkeep");
    expect(runsKeep).toBeDefined();
  });

  it("generates .kiro/hooks/ file for enforced gate", () => {
    const hookFile = files.find((f) => f.path === ".kiro/hooks/gate-quality-check.md");
    expect(hookFile).toBeDefined();
    expect(hookFile!.content).toContain("postToolUse");
    expect(hookFile!.content).toContain("lint.sh");
  });

  it("does NOT generate hook file for advisory gate", () => {
    const advisoryHook = files.find((f) => f.path === ".kiro/hooks/gate-soft-review.md");
    expect(advisoryHook).toBeUndefined();
  });
});
