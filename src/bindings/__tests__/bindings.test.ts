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
  it("contains all 8 bindings", () => {
    expect(Object.keys(bindings)).toHaveLength(8);
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

  it("produces a context file (.claude/CONTEXT.md, never root CLAUDE.md)", () => {
    const contextFile = files.find((f) => f.path === ".claude/CONTEXT.md");
    expect(contextFile).toBeDefined();
    // Must never generate root-level CLAUDE.md
    const rootClaudeMd = files.find((f) => f.path === "CLAUDE.md");
    expect(rootClaudeMd).toBeUndefined();
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

  it("produces .gemini/CONTEXT.md context file (never root GEMINI.md)", () => {
    const geminiMd = files.find((f) => f.path === ".gemini/CONTEXT.md");
    expect(geminiMd).toBeDefined();
    // Must never generate root-level GEMINI.md
    const rootGeminiMd = files.find((f) => f.path === "GEMINI.md");
    expect(rootGeminiMd).toBeUndefined();
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

// ---------------------------------------------------------------------------
// anthropic-sdk
// ---------------------------------------------------------------------------

describe("anthropic-sdk binding", () => {
  const files = scaffoldBinding("anthropic-sdk");

  assertStructuralInvariants(files);

  it("produces package.json with anthropic SDK dependency", () => {
    const pkg = files.find((f) => f.path === "package.json");
    expect(pkg).toBeDefined();
    const parsed = JSON.parse(pkg!.content);
    expect(parsed.dependencies["@anthropic-ai/sdk"]).toBeDefined();
    expect(parsed.scripts.start).toContain("tsx");
  });

  it("produces tsconfig.json", () => {
    const tsconfig = files.find((f) => f.path === "tsconfig.json");
    expect(tsconfig).toBeDefined();
    const parsed = JSON.parse(tsconfig!.content);
    expect(parsed.compilerOptions.strict).toBe(true);
  });

  it("produces src/types.ts with agent IDs", () => {
    const types = files.find((f) => f.path === "src/types.ts");
    expect(types).toBeDefined();
    expect(types!.content).toContain("planner");
    expect(types!.content).toContain("builder");
    expect(types!.content).toContain("AgentConfig");
    expect(types!.content).toContain("MemoryStore");
  });

  it("produces src/executor.ts with agentic loop", () => {
    const executor = files.find((f) => f.path === "src/executor.ts");
    expect(executor).toBeDefined();
    expect(executor!.content).toContain("executeAgent");
    expect(executor!.content).toContain("tool_use");
    expect(executor!.content).toContain("end_turn");
  });

  it("produces src/orchestrator.ts with flow routing", () => {
    const orch = files.find((f) => f.path === "src/orchestrator.ts");
    expect(orch).toBeDefined();
    expect(orch!.content).toContain("runTopology");
    expect(orch!.content).toContain("getNextAgents");
    expect(orch!.content).toContain('"planner"');
    expect(orch!.content).toContain('"builder"');
  });

  it("produces src/memory.ts with file-based memory", () => {
    const mem = files.find((f) => f.path === "src/memory.ts");
    expect(mem).toBeDefined();
    expect(mem!.content).toContain("FileMemory");
    expect(mem!.content).toContain("readFile");
    expect(mem!.content).toContain("writeFile");
  });

  it("produces src/tools.ts with built-in tools", () => {
    const tools = files.find((f) => f.path === "src/tools.ts");
    expect(tools).toBeDefined();
    expect(tools!.content).toContain("read_file");
    expect(tools!.content).toContain("write_file");
    expect(tools!.content).toContain("bash");
  });

  it("produces src/index.ts entry point", () => {
    const index = files.find((f) => f.path === "src/index.ts");
    expect(index).toBeDefined();
    expect(index!.content).toContain("runTopology");
  });

  it("produces .env.example with ANTHROPIC_API_KEY", () => {
    const env = files.find((f) => f.path === ".env.example");
    expect(env).toBeDefined();
    expect(env!.content).toContain("ANTHROPIC_API_KEY");
  });

  it("produces .memory/.gitkeep for memory directory", () => {
    const memDir = files.find((f) => f.path === ".memory/.gitkeep");
    expect(memDir).toBeDefined();
  });

  it("maps agent models correctly in orchestrator", () => {
    const orch = files.find((f) => f.path === "src/orchestrator.ts");
    expect(orch).toBeDefined();
    // The test topology uses "opus" which should map to claude-opus
    expect(orch!.content).toContain("claude-");
  });
});

// ---------------------------------------------------------------------------
// anthropic-sdk (deep)
// ---------------------------------------------------------------------------

describe("anthropic-sdk binding (deep)", () => {
  const files = scaffoldBinding("anthropic-sdk");

  // =========================================================================
  // Category 1: File Manifest
  // =========================================================================
  describe("file manifest", () => {
    it("generates package.json", () => {
      expect(files.find((f) => f.path === "package.json")).toBeDefined();
    });

    it("generates tsconfig.json", () => {
      expect(files.find((f) => f.path === "tsconfig.json")).toBeDefined();
    });

    it("generates .env.example", () => {
      expect(files.find((f) => f.path === ".env.example")).toBeDefined();
    });

    it("generates .gitignore", () => {
      expect(files.find((f) => f.path === ".gitignore")).toBeDefined();
    });

    it("generates .memory/.gitkeep", () => {
      expect(files.find((f) => f.path === ".memory/.gitkeep")).toBeDefined();
    });

    it("generates .checkpoint/.gitkeep", () => {
      expect(files.find((f) => f.path === ".checkpoint/.gitkeep")).toBeDefined();
    });

    it("generates src/types.ts", () => {
      expect(files.find((f) => f.path === "src/types.ts")).toBeDefined();
    });

    it("generates src/executor.ts", () => {
      expect(files.find((f) => f.path === "src/executor.ts")).toBeDefined();
    });

    it("generates src/orchestrator.ts", () => {
      expect(files.find((f) => f.path === "src/orchestrator.ts")).toBeDefined();
    });

    it("generates src/memory.ts", () => {
      expect(files.find((f) => f.path === "src/memory.ts")).toBeDefined();
    });

    it("generates src/tools.ts", () => {
      expect(files.find((f) => f.path === "src/tools.ts")).toBeDefined();
    });

    it("generates src/index.ts", () => {
      expect(files.find((f) => f.path === "src/index.ts")).toBeDefined();
    });

    it("generates src/group-executor.ts", () => {
      expect(files.find((f) => f.path === "src/group-executor.ts")).toBeDefined();
    });

    it("generates src/human-executor.ts", () => {
      expect(files.find((f) => f.path === "src/human-executor.ts")).toBeDefined();
    });

    it("generates src/action-executor.ts", () => {
      expect(files.find((f) => f.path === "src/action-executor.ts")).toBeDefined();
    });

    it("generates src/observability.ts", () => {
      expect(files.find((f) => f.path === "src/observability.ts")).toBeDefined();
    });

    it("generates src/checkpoint.ts", () => {
      expect(files.find((f) => f.path === "src/checkpoint.ts")).toBeDefined();
    });

    it("generates src/scheduler.ts", () => {
      expect(files.find((f) => f.path === "src/scheduler.ts")).toBeDefined();
    });

    it("generates src/rate-limiter.ts", () => {
      expect(files.find((f) => f.path === "src/rate-limiter.ts")).toBeDefined();
    });

    it("generates src/variants.ts", () => {
      expect(files.find((f) => f.path === "src/variants.ts")).toBeDefined();
    });

    it("generates gate scripts for each gate in the topology", () => {
      expect(files.find((f) => f.path === "scripts/gate-quality-check.sh")).toBeDefined();
      expect(files.find((f) => f.path === "scripts/gate-soft-review.sh")).toBeDefined();
    });
  });

  // =========================================================================
  // Category 2: Types (src/types.ts)
  // =========================================================================
  describe("types (src/types.ts)", () => {
    const types = files.find((f) => f.path === "src/types.ts")!;

    it("contains AgentId type with agent names from topology", () => {
      expect(types.content).toContain('"planner"');
      expect(types.content).toContain('"builder"');
      expect(types.content).toContain("AgentId");
    });

    it("contains AgentConfig interface", () => {
      expect(types.content).toContain("export interface AgentConfig");
    });

    it("contains AgentResult interface", () => {
      expect(types.content).toContain("export interface AgentResult");
    });

    it("contains MemoryStore interface", () => {
      expect(types.content).toContain("export interface MemoryStore");
    });

    it("contains ToolDefinition interface", () => {
      expect(types.content).toContain("export interface ToolDefinition");
    });

    it("contains EdgeRoute interface", () => {
      expect(types.content).toContain("export interface EdgeRoute");
    });

    it("contains TopologyConfig interface", () => {
      expect(types.content).toContain("export interface TopologyConfig");
    });

    it("contains GroupChatConfig interface", () => {
      expect(types.content).toContain("export interface GroupChatConfig");
    });

    it("contains HumanNodeConfig interface", () => {
      expect(types.content).toContain("export interface HumanNodeConfig");
    });

    it("contains ActionNodeConfig interface", () => {
      expect(types.content).toContain("export interface ActionNodeConfig");
    });

    it("contains GateConfig interface", () => {
      expect(types.content).toContain("export interface GateConfig");
    });

    it("contains CircuitBreakerState interface", () => {
      expect(types.content).toContain("export interface CircuitBreakerState");
    });

    it("contains CircuitBreakerConfig interface", () => {
      expect(types.content).toContain("export interface CircuitBreakerConfig");
    });

    it("contains CheckpointData interface", () => {
      expect(types.content).toContain("export interface CheckpointData");
    });

    it("contains ObservabilitySpan interface", () => {
      expect(types.content).toContain("export interface ObservabilitySpan");
    });

    it("contains ObservabilityConfig interface", () => {
      expect(types.content).toContain("export interface ObservabilityConfig");
    });

    it("contains PromptVariant interface", () => {
      expect(types.content).toContain("export interface PromptVariant");
    });

    it("contains VariantSelection interface", () => {
      expect(types.content).toContain("export interface VariantSelection");
    });

    it("contains AgentMessage interface", () => {
      expect(types.content).toContain("export interface AgentMessage");
    });

    it("imports Anthropic SDK", () => {
      expect(types.content).toContain('import Anthropic from "@anthropic-ai/sdk"');
    });
  });

  // =========================================================================
  // Category 3: Executor (src/executor.ts)
  // =========================================================================
  describe("executor (src/executor.ts)", () => {
    const executor = files.find((f) => f.path === "src/executor.ts")!;

    it("imports Anthropic SDK", () => {
      expect(executor.content).toContain('import Anthropic from "@anthropic-ai/sdk"');
    });

    it("exports executeAgent function", () => {
      expect(executor.content).toContain("export async function executeAgent");
    });

    it("handles end_turn stop reason", () => {
      expect(executor.content).toContain('"end_turn"');
    });

    it("handles tool_use stop reason", () => {
      expect(executor.content).toContain('"tool_use"');
    });

    it("injects memory context via memoryReads", () => {
      expect(executor.content).toContain("memoryReads");
      expect(executor.content).toContain("memoryContext");
    });

    it("adds memory_write tool when memoryWrites configured", () => {
      expect(executor.content).toContain("memoryWrites");
      expect(executor.content).toContain("memory_write");
    });

    it("supports extended thinking with budget_tokens", () => {
      expect(executor.content).toContain("thinking");
      expect(executor.content).toContain("budget_tokens");
    });

    it("supports seed parameter", () => {
      expect(executor.content).toContain("config.seed");
    });

    it("handles timeout with Promise.race", () => {
      expect(executor.content).toContain("Promise.race");
      expect(executor.content).toContain("config.timeout");
    });

    it("forwards temperature sampling param", () => {
      expect(executor.content).toContain("config.temperature");
      expect(executor.content).toContain("temperature");
    });

    it("forwards top_p sampling param", () => {
      expect(executor.content).toContain("config.topP");
      expect(executor.content).toContain("top_p");
    });

    it("forwards top_k sampling param", () => {
      expect(executor.content).toContain("config.topK");
      expect(executor.content).toContain("top_k");
    });

    it("handles max_tokens stop reason", () => {
      expect(executor.content).toContain('"max_tokens"');
    });

    it("supports structured output via outputSchema", () => {
      expect(executor.content).toContain("outputSchema");
      expect(executor.content).toContain("structured_output");
    });

    it("tracks token usage", () => {
      expect(executor.content).toContain("totalInputTokens");
      expect(executor.content).toContain("totalOutputTokens");
    });

    it("tracks tool call records", () => {
      expect(executor.content).toContain("toolCalls.push");
    });

    it("returns AgentResult structure", () => {
      expect(executor.content).toContain("agentId: config.id");
      expect(executor.content).toContain("durationMs");
      expect(executor.content).toContain("tokenUsage");
    });
  });

  // =========================================================================
  // Category 4: Orchestrator (src/orchestrator.ts)
  // =========================================================================
  describe("orchestrator (src/orchestrator.ts)", () => {
    const orch = files.find((f) => f.path === "src/orchestrator.ts")!;

    it("exports runTopology function", () => {
      expect(orch.content).toContain("export async function runTopology");
    });

    it("contains getNextAgents function", () => {
      expect(orch.content).toContain("function getNextAgents");
    });

    it("references planner agent ID", () => {
      expect(orch.content).toContain('"planner"');
    });

    it("references builder agent ID", () => {
      expect(orch.content).toContain('"builder"');
    });

    it("maps opus model to claude- prefixed model ID", () => {
      expect(orch.content).toContain("claude-opus-4-0-20250514");
    });

    it("maps sonnet model to claude- prefixed model ID", () => {
      expect(orch.content).toContain("claude-sonnet-4-5-20250514");
    });

    it("handles error edge routing by checking isError", () => {
      expect(orch.content).toContain("isError");
      expect(orch.content).toContain("errorEdges");
    });

    it("handles race edge routing", () => {
      expect(orch.content).toContain("raceEdges");
      expect(orch.content).toContain("e.race");
    });

    it("handles weighted routing with Math.random", () => {
      expect(orch.content).toContain("Math.random()");
      expect(orch.content).toContain("e.weight");
    });

    it("supports retry loop with backoff", () => {
      expect(orch.content).toContain("retryMax");
      expect(orch.content).toContain("backoff");
      expect(orch.content).toContain("exponential");
    });

    it("uses Promise.all for parallel execution", () => {
      expect(orch.content).toContain("Promise.all");
    });

    it("contains circuit breaker logic", () => {
      expect(orch.content).toContain("circuitBreaker");
      expect(orch.content).toContain("checkCircuitBreaker");
      expect(orch.content).toContain("recordCircuitBreakerResult");
      expect(orch.content).toContain("CircuitBreakerState");
    });

    it("handles onFail behaviors including halt, skip, continue, fallback", () => {
      expect(orch.content).toContain("handleOnFail");
      expect(orch.content).toContain('"halt"');
      expect(orch.content).toContain('"skip"');
      expect(orch.content).toContain('"continue"');
      expect(orch.content).toContain('fallback ');
    });

    it("contains gate execution via runGates function", () => {
      expect(orch.content).toContain("runGates");
      expect(orch.content).toContain('"before"');
      expect(orch.content).toContain('"after"');
    });

    it("dispatches action nodes via config.actions check", () => {
      expect(orch.content).toContain("config.actions[agentId]");
      expect(orch.content).toContain("executeAction");
    });

    it("imports executeAgent from executor", () => {
      expect(orch.content).toContain('import { executeAgent } from "./executor.js"');
    });

    it("imports FileMemory from memory", () => {
      expect(orch.content).toContain('import { FileMemory } from "./memory.js"');
    });

    it("imports action executor", () => {
      expect(orch.content).toContain('import { executeAction } from "./action-executor.js"');
    });

    it("uses edge condition functions for conditional routing", () => {
      expect(orch.content).toContain("condition");
    });

    it("supports maxIterations on edges", () => {
      expect(orch.content).toContain("maxIterations");
      expect(orch.content).toContain("edgeIterations");
    });

    it("configures gate entries from the topology", () => {
      expect(orch.content).toContain('"quality-check"');
      expect(orch.content).toContain('"soft-review"');
    });

    it("includes action config for intake action", () => {
      expect(orch.content).toContain('"intake"');
    });

    it("sets entry points", () => {
      expect(orch.content).toContain("entryPoints");
    });

    it("contains skip condition check", () => {
      expect(orch.content).toContain("agentConfig.skip");
      expect(orch.content).toContain("[skipped]");
    });

    it("contains fallback chain model iteration", () => {
      expect(orch.content).toContain("modelsToTry");
      expect(orch.content).toContain("fallbackChain");
    });

    it("has phase-aware sorting of agents", () => {
      expect(orch.content).toContain("phaseAgents");
      expect(orch.content).toContain("a.phase");
    });

    it("sets memoryReads from topology agent reads", () => {
      expect(orch.content).toContain("memoryReads");
      expect(orch.content).toContain("workspace/input.md");
    });

    it("sets memoryWrites from topology agent writes", () => {
      expect(orch.content).toContain("memoryWrites");
      expect(orch.content).toContain("workspace/plan.md");
    });
  });

  // =========================================================================
  // Category 5: Group Executor (src/group-executor.ts)
  // =========================================================================
  describe("group executor (src/group-executor.ts)", () => {
    const group = files.find((f) => f.path === "src/group-executor.ts")!;

    it("exports executeGroup function", () => {
      expect(group.content).toContain("export async function executeGroup");
    });

    it("supports round-robin speaker selection", () => {
      expect(group.content).toContain("round-robin");
    });

    it("supports random speaker selection", () => {
      expect(group.content).toContain('"random"');
      expect(group.content).toContain("Math.random()");
    });

    it("supports model-selected speaker selection", () => {
      expect(group.content).toContain("model-selected");
    });

    it("tracks conversation history", () => {
      expect(group.content).toContain("conversationHistory");
    });

    it("has maxRounds loop", () => {
      expect(group.content).toContain("maxRounds");
      expect(group.content).toContain("round < maxRounds");
    });

    it("checks termination condition", () => {
      expect(group.content).toContain("termination");
      expect(group.content).toContain("result.output.includes(groupConfig.termination)");
    });

    it("returns GroupResult structure", () => {
      expect(group.content).toContain("messages: conversationHistory");
      expect(group.content).toContain("finalOutput");
      expect(group.content).toContain("totalTokens");
      expect(group.content).toContain("rounds");
    });

    it("imports Anthropic SDK", () => {
      expect(group.content).toContain('import Anthropic from "@anthropic-ai/sdk"');
    });

    it("imports executeAgent", () => {
      expect(group.content).toContain('import { executeAgent } from "./executor.js"');
    });
  });

  // =========================================================================
  // Category 6: Human Executor (src/human-executor.ts)
  // =========================================================================
  describe("human executor (src/human-executor.ts)", () => {
    const human = files.find((f) => f.path === "src/human-executor.ts")!;

    it("exports executeHuman function", () => {
      expect(human.content).toContain("export async function executeHuman");
    });

    it("uses readline for user input", () => {
      expect(human.content).toContain("createInterface");
      expect(human.content).toContain("readline");
    });

    it("supports timeout handling", () => {
      expect(human.content).toContain("config.timeout");
      expect(human.content).toContain("setTimeout");
    });

    it("handles onTimeout behaviors", () => {
      expect(human.content).toContain("config.onTimeout");
      expect(human.content).toContain('"skip"');
      expect(human.content).toContain('"halt"');
      expect(human.content).toContain("fallback ");
    });

    it("returns HumanResult structure", () => {
      expect(human.content).toContain("timedOut");
      expect(human.content).toContain("input: answer");
    });

    it("imports HumanNodeConfig and HumanResult types", () => {
      expect(human.content).toContain("HumanNodeConfig");
      expect(human.content).toContain("HumanResult");
    });
  });

  // =========================================================================
  // Category 7: Action Executor (src/action-executor.ts)
  // =========================================================================
  describe("action executor (src/action-executor.ts)", () => {
    const action = files.find((f) => f.path === "src/action-executor.ts")!;

    it("exports executeAction function", () => {
      expect(action.content).toContain("export async function executeAction");
    });

    it("uses child_process exec", () => {
      expect(action.content).toContain('import { exec } from "node:child_process"');
    });

    it("supports timeout", () => {
      expect(action.content).toContain("config.timeout");
      expect(action.content).toContain("timeout:");
    });

    it("returns stdout and stderr in ActionResult", () => {
      expect(action.content).toContain("stdout");
      expect(action.content).toContain("stderr");
      expect(action.content).toContain("exitCode");
    });

    it("imports ActionNodeConfig and ActionResult types", () => {
      expect(action.content).toContain("ActionNodeConfig");
      expect(action.content).toContain("ActionResult");
    });

    it("uses promisify for async exec", () => {
      expect(action.content).toContain("promisify");
      expect(action.content).toContain("execAsync");
    });
  });

  // =========================================================================
  // Category 8: Observability (src/observability.ts)
  // =========================================================================
  describe("observability (src/observability.ts)", () => {
    const obs = files.find((f) => f.path === "src/observability.ts")!;

    it("creates spans with traceId and spanId", () => {
      expect(obs.content).toContain("traceId");
      expect(obs.content).toContain("spanId");
    });

    it("supports stdout exporter", () => {
      expect(obs.content).toContain('"stdout"');
    });

    it("supports otlp exporter", () => {
      expect(obs.content).toContain('"otlp"');
    });

    it("supports none exporter", () => {
      expect(obs.content).toContain('"none"');
    });

    it("has sample rate check", () => {
      expect(obs.content).toContain("sampleRate");
      expect(obs.content).toContain("shouldSample");
    });

    it("has startSpan method", () => {
      expect(obs.content).toContain("startSpan(");
    });

    it("has endSpan method", () => {
      expect(obs.content).toContain("endSpan(");
    });

    it("exports Tracer class", () => {
      expect(obs.content).toContain("export class Tracer");
    });

    it("imports ObservabilitySpan and ObservabilityConfig types", () => {
      expect(obs.content).toContain("ObservabilitySpan");
      expect(obs.content).toContain("ObservabilityConfig");
    });

    it("has getSpans method", () => {
      expect(obs.content).toContain("getSpans()");
    });

    it("has reset method", () => {
      expect(obs.content).toContain("reset()");
    });
  });

  // =========================================================================
  // Category 9: Checkpoint (src/checkpoint.ts)
  // =========================================================================
  describe("checkpoint (src/checkpoint.ts)", () => {
    const cp = files.find((f) => f.path === "src/checkpoint.ts")!;

    it("has save method", () => {
      expect(cp.content).toContain("async save(");
    });

    it("has load method", () => {
      expect(cp.content).toContain("async load(");
    });

    it("uses file-based storage with readFile and writeFile", () => {
      expect(cp.content).toContain("readFile");
      expect(cp.content).toContain("writeFile");
    });

    it("supports per-node strategy", () => {
      expect(cp.content).toContain('"per-node"');
      expect(cp.content).toContain("shouldSaveAfterNode");
    });

    it("supports per-phase strategy", () => {
      expect(cp.content).toContain('"per-phase"');
      expect(cp.content).toContain("shouldSaveAfterPhase");
    });

    it("has cleanup method for TTL expiry", () => {
      expect(cp.content).toContain("async cleanup()");
      expect(cp.content).toContain("this.ttl");
    });

    it("exports CheckpointManager class", () => {
      expect(cp.content).toContain("export class CheckpointManager");
    });

    it("creates directory recursively", () => {
      expect(cp.content).toContain("mkdir");
      expect(cp.content).toContain("recursive: true");
    });

    it("has getCompletedNodes method", () => {
      expect(cp.content).toContain("getCompletedNodes");
    });

    it("imports CheckpointData and CheckpointState types", () => {
      expect(cp.content).toContain("CheckpointData");
      expect(cp.content).toContain("CheckpointState");
    });
  });

  // =========================================================================
  // Category 10: Scheduler (src/scheduler.ts)
  // =========================================================================
  describe("scheduler (src/scheduler.ts)", () => {
    const sched = files.find((f) => f.path === "src/scheduler.ts")!;

    it("parses duration strings like s, m, h", () => {
      expect(sched.content).toContain("parseEvery");
      expect(sched.content).toContain("60_000");
    });

    it("uses setInterval for job scheduling", () => {
      expect(sched.content).toContain("setInterval");
    });

    it("exports Scheduler class", () => {
      expect(sched.content).toContain("export class Scheduler");
    });

    it("has start method", () => {
      expect(sched.content).toContain("start()");
    });

    it("has stop method with clearInterval", () => {
      expect(sched.content).toContain("stop()");
      expect(sched.content).toContain("clearInterval");
    });

    it("has addEveryJob method", () => {
      expect(sched.content).toContain("addEveryJob");
    });

    it("has addCronJob method", () => {
      expect(sched.content).toContain("addCronJob");
    });

    it("defines ScheduledJob interface", () => {
      expect(sched.content).toContain("export interface ScheduledJob");
    });
  });

  // =========================================================================
  // Category 11: Rate Limiter (src/rate-limiter.ts)
  // =========================================================================
  describe("rate limiter (src/rate-limiter.ts)", () => {
    const rl = files.find((f) => f.path === "src/rate-limiter.ts")!;

    it("parses rate expressions like 60/min", () => {
      expect(rl.content).toContain("parseRateLimit");
      expect(rl.content).toContain("/(sec|min|hour|day)");
    });

    it("implements token bucket pattern with tokens and refill", () => {
      expect(rl.content).toContain("this.tokens");
      expect(rl.content).toContain("maxTokens");
      expect(rl.content).toContain("refill");
    });

    it("exports acquire method", () => {
      expect(rl.content).toContain("async acquire()");
    });

    it("exports RateLimiter class", () => {
      expect(rl.content).toContain("export class RateLimiter");
    });

    it("waits when no tokens available", () => {
      expect(rl.content).toContain("setTimeout");
      expect(rl.content).toContain("waitTime");
    });
  });

  // =========================================================================
  // Category 12: Variants (src/variants.ts)
  // =========================================================================
  describe("variants (src/variants.ts)", () => {
    const variants = files.find((f) => f.path === "src/variants.ts")!;

    it("exports selectVariant function", () => {
      expect(variants.content).toContain("export function selectVariant");
    });

    it("uses weighted random selection with totalWeight", () => {
      expect(variants.content).toContain("totalWeight");
      expect(variants.content).toContain("Math.random()");
    });

    it("returns VariantSelection with variantId and prompt", () => {
      expect(variants.content).toContain("variantId");
      expect(variants.content).toContain("prompt");
    });

    it("falls back to default prompt when no variants", () => {
      expect(variants.content).toContain("defaultPrompt");
      expect(variants.content).toContain('"default"');
    });

    it("supports temperature and model override per variant", () => {
      expect(variants.content).toContain("temperature");
      expect(variants.content).toContain("model");
    });

    it("imports PromptVariant and VariantSelection types", () => {
      expect(variants.content).toContain("PromptVariant");
      expect(variants.content).toContain("VariantSelection");
    });
  });

  // =========================================================================
  // Category 13: Memory (src/memory.ts)
  // =========================================================================
  describe("memory (src/memory.ts)", () => {
    const mem = files.find((f) => f.path === "src/memory.ts")!;

    it("exports FileMemory class", () => {
      expect(mem.content).toContain("export class FileMemory");
    });

    it("implements MemoryStore interface", () => {
      expect(mem.content).toContain("implements MemoryStore");
    });

    it("has read method", () => {
      expect(mem.content).toContain("async read(key: string)");
    });

    it("has write method", () => {
      expect(mem.content).toContain("async write(key: string, value: string)");
    });

    it("has list method", () => {
      expect(mem.content).toContain("async list(prefix?: string)");
    });

    it("uses dot notation path resolution", () => {
      expect(mem.content).toContain('key.split(".")');
    });

    it("uses mkdir recursive for creating directories", () => {
      expect(mem.content).toContain("mkdir");
      expect(mem.content).toContain("recursive: true");
    });

    it("uses .memory as default base path", () => {
      expect(mem.content).toContain("./.memory");
    });
  });

  // =========================================================================
  // Category 14: Tools (src/tools.ts)
  // =========================================================================
  describe("tools (src/tools.ts)", () => {
    const tools = files.find((f) => f.path === "src/tools.ts")!;

    it("defines read_file built-in tool", () => {
      expect(tools.content).toContain('name: "read_file"');
    });

    it("defines write_file built-in tool", () => {
      expect(tools.content).toContain('name: "write_file"');
    });

    it("defines bash built-in tool", () => {
      expect(tools.content).toContain('name: "bash"');
    });

    it("exports allTools registry", () => {
      expect(tools.content).toContain("export const allTools");
      expect(tools.content).toContain("read_file: readFileTool");
      expect(tools.content).toContain("write_file: writeFileTool");
      expect(tools.content).toContain("bash: bashTool");
    });

    it("imports ToolDefinition type", () => {
      expect(tools.content).toContain("ToolDefinition");
    });

    it("uses readFile from node:fs/promises", () => {
      expect(tools.content).toContain('import { readFile, writeFile } from "node:fs/promises"');
    });

    it("uses exec from node:child_process", () => {
      expect(tools.content).toContain('import { exec } from "node:child_process"');
    });
  });

  // =========================================================================
  // Category 15: Package & Config
  // =========================================================================
  describe("package and config", () => {
    it("package.json has @anthropic-ai/sdk dependency", () => {
      const pkg = files.find((f) => f.path === "package.json")!;
      const parsed = JSON.parse(pkg.content);
      expect(parsed.dependencies["@anthropic-ai/sdk"]).toBeDefined();
    });

    it("package.json has tsx in start script", () => {
      const pkg = files.find((f) => f.path === "package.json")!;
      const parsed = JSON.parse(pkg.content);
      expect(parsed.scripts.start).toContain("tsx");
    });

    it("package.json has build script", () => {
      const pkg = files.find((f) => f.path === "package.json")!;
      const parsed = JSON.parse(pkg.content);
      expect(parsed.scripts.build).toBe("tsc");
    });

    it("package.json has type module", () => {
      const pkg = files.find((f) => f.path === "package.json")!;
      const parsed = JSON.parse(pkg.content);
      expect(parsed.type).toBe("module");
    });

    it("package.json has typescript devDependency", () => {
      const pkg = files.find((f) => f.path === "package.json")!;
      const parsed = JSON.parse(pkg.content);
      expect(parsed.devDependencies.typescript).toBeDefined();
    });

    it("tsconfig.json has strict: true", () => {
      const tsconfig = files.find((f) => f.path === "tsconfig.json")!;
      const parsed = JSON.parse(tsconfig.content);
      expect(parsed.compilerOptions.strict).toBe(true);
    });

    it("tsconfig.json targets ES2022", () => {
      const tsconfig = files.find((f) => f.path === "tsconfig.json")!;
      const parsed = JSON.parse(tsconfig.content);
      expect(parsed.compilerOptions.target).toBe("ES2022");
    });

    it("tsconfig.json uses ESNext module", () => {
      const tsconfig = files.find((f) => f.path === "tsconfig.json")!;
      const parsed = JSON.parse(tsconfig.content);
      expect(parsed.compilerOptions.module).toBe("ESNext");
    });

    it(".env.example has ANTHROPIC_API_KEY", () => {
      const env = files.find((f) => f.path === ".env.example")!;
      expect(env.content).toContain("ANTHROPIC_API_KEY");
    });

    it(".gitignore includes node_modules and dist", () => {
      const gitignore = files.find((f) => f.path === ".gitignore")!;
      expect(gitignore.content).toContain("node_modules/");
      expect(gitignore.content).toContain("dist/");
    });

    it(".gitignore includes .env", () => {
      const gitignore = files.find((f) => f.path === ".gitignore")!;
      expect(gitignore.content).toContain(".env");
    });

    it(".gitignore includes .memory/ and .checkpoint/", () => {
      const gitignore = files.find((f) => f.path === ".gitignore")!;
      expect(gitignore.content).toContain(".memory/");
      expect(gitignore.content).toContain(".checkpoint/");
    });
  });

  // =========================================================================
  // Category 16: Index Entry Point (src/index.ts)
  // =========================================================================
  describe("index entry point (src/index.ts)", () => {
    const index = files.find((f) => f.path === "src/index.ts")!;

    it("imports runTopology from orchestrator", () => {
      expect(index.content).toContain('import { runTopology } from "./orchestrator.js"');
    });

    it("uses process.argv for input", () => {
      expect(index.content).toContain("process.argv");
    });

    it("has error handling with .catch", () => {
      expect(index.content).toContain(".catch(");
      expect(index.content).toContain("process.exit(1)");
    });

    it("prints summary of results", () => {
      expect(index.content).toContain("result.output");
      expect(index.content).toContain("result.tokenUsage");
    });
  });

  // =========================================================================
  // Category 17: Gate Scripts
  // =========================================================================
  describe("gate scripts", () => {
    it("generates scripts/gate-quality-check.sh for quality-check gate", () => {
      const gate = files.find((f) => f.path === "scripts/gate-quality-check.sh")!;
      expect(gate).toBeDefined();
    });

    it("gate script has bash shebang", () => {
      const gate = files.find((f) => f.path === "scripts/gate-quality-check.sh")!;
      expect(gate.content).toContain("#!/usr/bin/env bash");
    });

    it("gate script has set -euo pipefail", () => {
      const gate = files.find((f) => f.path === "scripts/gate-quality-check.sh")!;
      expect(gate.content).toContain("set -euo pipefail");
    });

    it("gate script contains gate description", () => {
      const gate = files.find((f) => f.path === "scripts/gate-quality-check.sh")!;
      expect(gate.content).toContain("quality-check");
    });

    it("gate script references checks from the topology", () => {
      const gate = files.find((f) => f.path === "scripts/gate-quality-check.sh")!;
      expect(gate.content).toContain("Check: lint");
      expect(gate.content).toContain("Check: types");
    });

    it("generates scripts/gate-soft-review.sh for advisory gate too", () => {
      const gate = files.find((f) => f.path === "scripts/gate-soft-review.sh")!;
      expect(gate).toBeDefined();
      expect(gate.content).toContain("#!/usr/bin/env bash");
      expect(gate.content).toContain("set -euo pipefail");
    });
  });

  // =========================================================================
  // Category 18: Cross-Cutting Security
  // =========================================================================
  describe("cross-cutting security", () => {
    it("no generated file contains eval(", () => {
      for (const f of files) {
        expect(f.content).not.toContain("eval(");
      }
    });

    it("all src/ TypeScript imports use .js extension", () => {
      const srcFiles = files.filter((f) => f.path.startsWith("src/") && f.path.endsWith(".ts"));
      for (const f of srcFiles) {
        // Find all from "./..." import statements and check they end with .js"
        const importMatches = f.content.match(/from\s+"\.\/[^"]+"/g) || [];
        for (const imp of importMatches) {
          expect(imp).toMatch(/\.js"$/);
        }
      }
    });

    it("no hardcoded API keys in any file", () => {
      for (const f of files) {
        // Check for patterns that look like actual API keys (sk-ant-...)
        expect(f.content).not.toMatch(/sk-ant-[a-zA-Z0-9]{20,}/);
      }
    });
  });
});
