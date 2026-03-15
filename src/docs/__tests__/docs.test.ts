import { describe, it, expect } from "vitest";
import { topics } from "../content.js";
import { listTopics, getTopic, getAllTopics, searchTopics } from "../index.js";

// ---------------------------------------------------------------------------
// 1. Topic Registry Tests
// ---------------------------------------------------------------------------
describe("docs topic registry", () => {
  it("has all expected topics", () => {
    const expectedTopics = [
      "topology", "agent", "orchestrator", "action", "gate", "human", "group",
      "flow", "memory", "hooks", "triggers", "settings", "tools", "skills",
      "mcp-servers", "metering", "providers", "env", "environments", "batch",
      "depth", "scale", "extensions", "schemas", "defaults", "observability",
      "schedule", "interfaces", "checkpoint", "artifacts", "composition",
      "validation", "patterns", "keywords", "examples", "bindings",
    ];
    for (const topic of expectedTopics) {
      expect(topics[topic], `Missing topic: ${topic}`).toBeDefined();
    }
  });

  it("every topic has name, description, and content", () => {
    for (const [key, topic] of Object.entries(topics)) {
      expect(topic.name, `${key} missing name`).toBeTruthy();
      expect(topic.description, `${key} missing description`).toBeTruthy();
      const content = topic.content();
      expect(content.length, `${key} has empty content`).toBeGreaterThan(100);
    }
  });

  it("topic count is at least 35", () => {
    expect(Object.keys(topics).length).toBeGreaterThanOrEqual(35);
  });
});

// ---------------------------------------------------------------------------
// 2. Agent Field Coverage (the most critical test)
// ---------------------------------------------------------------------------
describe("agent topic covers all AST fields", () => {
  // These are ALL 47 fields from AgentNode in ast.ts
  const agentFields = [
    "phase", "model", "permissions", "prompt", "tools", "skills",
    "reads", "writes", "disallowedTools", "skip", "behavior",
    "invocation", "retry", "isolation", "background", "mcpServers",
    "outputs", "scale", "hooks", "role", "description", "maxTurns",
    "sandbox", "fallbackChain", "timeout", "onFail", "temperature",
    "maxTokens", "topP", "topK", "stop", "seed", "thinking",
    "thinkingBudget", "outputFormat", "logLevel", "join",
    "circuitBreaker", "compensates", "inputSchema", "outputSchema",
    "produces", "consumes", "variants", "rateLimit", "extensions",
  ];

  // Map camelCase AST names to kebab-case .at syntax names where different
  const fieldNameMap: Record<string, string> = {
    disallowedTools: "disallowed-tools",
    mcpServers: "mcp-servers",
    maxTurns: "max-turns",
    fallbackChain: "fallback-chain",
    onFail: "on-fail",
    maxTokens: "max-tokens",
    topP: "top-p",
    topK: "top-k",
    thinkingBudget: "thinking-budget",
    outputFormat: "output-format",
    logLevel: "log-level",
    circuitBreaker: "circuit-breaker",
    inputSchema: "input-schema",
    outputSchema: "output-schema",
    rateLimit: "rate-limit",
  };

  const agentContent = topics["agent"]?.content() ?? "";

  for (const field of agentFields) {
    it(`documents field: ${field}`, () => {
      // Check for either camelCase or kebab-case version
      const kebab = fieldNameMap[field] || field;
      const found = agentContent.includes(field) || agentContent.includes(kebab);
      expect(found, `Agent topic missing field: ${field} (or ${kebab})`).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// 3. Node Type Coverage
// ---------------------------------------------------------------------------
describe("all node types have topics", () => {
  const nodeTypes = ["agent", "orchestrator", "action", "gate", "human", "group"];

  for (const nodeType of nodeTypes) {
    it(`has topic for node type: ${nodeType}`, () => {
      expect(topics[nodeType]).toBeDefined();
      const content = topics[nodeType].content();
      expect(content.length).toBeGreaterThan(50);
    });
  }
});

// ---------------------------------------------------------------------------
// 4. Validation Rules Coverage
// ---------------------------------------------------------------------------
describe("validation topic covers all 29 rules", () => {
  const validationContent = topics["validation"]?.content() ?? "";

  for (let i = 1; i <= 29; i++) {
    it(`documents validation rule V${i}`, () => {
      expect(validationContent, `Missing V${i}`).toContain(`V${i}`);
    });
  }
});

// ---------------------------------------------------------------------------
// 5. Hook Events Coverage
// ---------------------------------------------------------------------------
describe("hooks topic covers all events", () => {
  const hookEvents = [
    "AgentStart", "AgentStop", "ToolUse", "Error",
    "SessionStart", "SessionEnd", "PreToolUse", "PostToolUse",
    "PostToolUseFailure", "SubagentStart", "SubagentStop",
    "Stop", "UserPromptSubmit", "InstructionsLoaded",
    "PermissionRequest", "Notification", "TeammateIdle",
    "TaskCompleted", "ConfigChange", "PreCompact",
    "WorktreeCreate", "WorktreeRemove",
  ];

  const hooksContent = topics["hooks"]?.content() ?? "";

  for (const event of hookEvents) {
    it(`documents hook event: ${event}`, () => {
      expect(hooksContent, `Missing event: ${event}`).toContain(event);
    });
  }
});

// ---------------------------------------------------------------------------
// 6. Pattern Coverage
// ---------------------------------------------------------------------------
describe("patterns topic covers all 10 patterns", () => {
  const patterns = [
    "pipeline", "supervisor", "blackboard", "orchestrator-worker",
    "debate", "market-routing", "consensus", "fan-out",
    "event-driven", "human-gate",
  ];

  const patternContent = topics["patterns"]?.content() ?? "";

  for (const pattern of patterns) {
    it(`documents pattern: ${pattern}`, () => {
      expect(patternContent, `Missing pattern: ${pattern}`).toContain(pattern);
    });
  }
});

// ---------------------------------------------------------------------------
// 7. Top-level AST Section Coverage
// ---------------------------------------------------------------------------
describe("all TopologyAST sections have topics", () => {
  // These are all the top-level fields on TopologyAST that need documentation
  const astSections = [
    { field: "topology", topic: "topology" },
    { field: "nodes", topic: "agent" },
    { field: "edges", topic: "flow" },
    { field: "depth", topic: "depth" },
    { field: "memory", topic: "memory" },
    { field: "batch", topic: "batch" },
    { field: "environments", topic: "environments" },
    { field: "triggers", topic: "triggers" },
    { field: "hooks", topic: "hooks" },
    { field: "settings", topic: "settings" },
    { field: "mcpServers", topic: "mcp-servers" },
    { field: "metering", topic: "metering" },
    { field: "skills", topic: "skills" },
    { field: "toolDefs", topic: "tools" },
    { field: "env", topic: "env" },
    { field: "providers", topic: "providers" },
    { field: "schedules", topic: "schedule" },
    { field: "interfaces", topic: "interfaces" },
    { field: "defaults", topic: "defaults" },
    { field: "schemas", topic: "schemas" },
    { field: "extensions", topic: "extensions" },
    { field: "observability", topic: "observability" },
    { field: "params", topic: "composition" },
    { field: "interfaceEndpoints", topic: "interfaces" },
    { field: "imports", topic: "composition" },
    { field: "includes", topic: "composition" },
    { field: "checkpoint", topic: "checkpoint" },
    { field: "artifacts", topic: "artifacts" },
  ];

  for (const { field, topic } of astSections) {
    it(`AST field "${field}" is covered by topic "${topic}"`, () => {
      expect(topics[topic], `No topic "${topic}" for AST field "${field}"`).toBeDefined();
    });
  }
});

// ---------------------------------------------------------------------------
// 8. Edge Attribute Coverage
// ---------------------------------------------------------------------------
describe("flow topic covers all edge attributes", () => {
  const edgeFields = [
    "condition", "maxIterations", "per", "isError", "errorType",
    "tolerance", "race", "wait", "weight", "reflection",
  ];

  // Map to .at syntax names
  const edgeNameMap: Record<string, string> = {
    condition: "when",
    maxIterations: "max",
    isError: "error",
  };

  const flowContent = topics["flow"]?.content() ?? "";

  for (const field of edgeFields) {
    it(`documents edge attribute: ${field}`, () => {
      const syntaxName = edgeNameMap[field] || field;
      const found = flowContent.includes(field) || flowContent.includes(syntaxName);
      expect(found, `Flow topic missing edge attribute: ${field} (or ${syntaxName})`).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// 9. Keyword Coverage
// ---------------------------------------------------------------------------
describe("keywords topic covers reserved keywords", () => {
  const blockKeywords = [
    "topology", "library", "import", "from", "use",
    "agent", "action", "orchestrator", "meta", "roles", "memory", "flow", "gates",
    "depth", "batch", "environments", "triggers", "hooks", "settings",
    "mcp-servers", "metering", "tools", "context", "env", "extensions",
    "providers", "schedule", "interfaces", "defaults", "schemas",
    "observability", "fragment", "params",
  ];

  const keywordsContent = topics["keywords"]?.content() ?? "";

  for (const keyword of blockKeywords) {
    it(`documents block keyword: ${keyword}`, () => {
      expect(keywordsContent, `Missing keyword: ${keyword}`).toContain(keyword);
    });
  }
});

// ---------------------------------------------------------------------------
// 10. Binding Coverage
// ---------------------------------------------------------------------------
describe("bindings topic covers all targets", () => {
  const bindingTargets = [
    "claude-code", "codex", "gemini-cli", "copilot-cli", "openclaw", "kiro",
  ];

  const bindingsContent = topics["bindings"]?.content() ?? "";

  for (const target of bindingTargets) {
    it(`documents binding: ${target}`, () => {
      expect(bindingsContent, `Missing binding: ${target}`).toContain(target);
    });
  }
});

// ---------------------------------------------------------------------------
// 11. API Tests (listTopics, getTopic, getAllTopics, searchTopics)
// ---------------------------------------------------------------------------
describe("docs API", () => {
  it("listTopics returns formatted output", () => {
    const output = listTopics();
    expect(output).toContain("topology");
    expect(output).toContain("agent");
    expect(output).toContain("Available topics");
  });

  it("getTopic returns content for valid topic", () => {
    const content = getTopic("agent");
    expect(content).not.toBeNull();
    expect(content!.length).toBeGreaterThan(100);
  });

  it("getTopic returns null for invalid topic", () => {
    expect(getTopic("nonexistent")).toBeNull();
  });

  it("getAllTopics includes all topics", () => {
    const all = getAllTopics();
    for (const key of Object.keys(topics)) {
      expect(all, `--all missing topic: ${key}`).toContain(topics[key].name);
    }
  });

  it("searchTopics finds matches", () => {
    const results = searchTopics("circuit-breaker");
    expect(results).toContain("circuit-breaker");
  });

  it("searchTopics returns no-match message for gibberish", () => {
    const results = searchTopics("xyzzy12345nonexistent");
    expect(results.toLowerCase()).toContain("no matches");
  });
});

// ---------------------------------------------------------------------------
// 12. Defaults Coverage
// ---------------------------------------------------------------------------
describe("defaults topic covers all DefaultsDef fields", () => {
  const defaultsFields = [
    "temperature", "maxTokens", "topP", "topK", "stop", "seed",
    "thinking", "thinkingBudget", "outputFormat", "timeout", "logLevel",
  ];

  const defaultsFieldMap: Record<string, string> = {
    maxTokens: "max-tokens",
    topP: "top-p",
    topK: "top-k",
    thinkingBudget: "thinking-budget",
    outputFormat: "output-format",
    logLevel: "log-level",
  };

  const defaultsContent = topics["defaults"]?.content() ?? "";

  for (const field of defaultsFields) {
    it(`documents defaults field: ${field}`, () => {
      const kebab = defaultsFieldMap[field] || field;
      const found = defaultsContent.includes(field) || defaultsContent.includes(kebab);
      expect(found, `Defaults topic missing field: ${field}`).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// 13. Metering Coverage
// ---------------------------------------------------------------------------
describe("metering topic covers all MeteringDef fields", () => {
  const meteringFields = ["track", "per", "output", "format", "pricing"];
  const meteringContent = topics["metering"]?.content() ?? "";

  for (const field of meteringFields) {
    it(`documents metering field: ${field}`, () => {
      expect(meteringContent, `Missing metering field: ${field}`).toContain(field);
    });
  }

  it("documents all track metrics", () => {
    for (const metric of ["tokens-in", "tokens-out", "cost", "wall-time", "agent-count"]) {
      expect(meteringContent, `Missing metric: ${metric}`).toContain(metric);
    }
  });
});

// ---------------------------------------------------------------------------
// 14. Observability Coverage
// ---------------------------------------------------------------------------
describe("observability topic covers all fields", () => {
  const obsContent = topics["observability"]?.content() ?? "";

  const obsFields = ["enabled", "exporter", "endpoint", "service", "sampleRate", "capture", "spans"];
  const obsFieldMap: Record<string, string> = {
    sampleRate: "sample-rate",
  };

  for (const field of obsFields) {
    it(`documents observability field: ${field}`, () => {
      const kebab = obsFieldMap[field] || field;
      const found = obsContent.includes(field) || obsContent.includes(kebab);
      expect(found, `Missing observability field: ${field}`).toBe(true);
    });
  }

  it("documents all exporters", () => {
    for (const exp of ["otlp", "langsmith", "datadog", "stdout"]) {
      expect(obsContent, `Missing exporter: ${exp}`).toContain(exp);
    }
  });
});

// ---------------------------------------------------------------------------
// 15. Provider Auth Types Coverage
// ---------------------------------------------------------------------------
describe("providers topic covers auth types", () => {
  const authTypes = ["oidc", "oauth2", "api-key", "aws-iam", "gcp-sa", "azure-msi"];
  const providersContent = topics["providers"]?.content() ?? "";

  for (const authType of authTypes) {
    it(`documents auth type: ${authType}`, () => {
      expect(providersContent, `Missing auth type: ${authType}`).toContain(authType);
    });
  }
});

// ---------------------------------------------------------------------------
// 16. Scale Coverage
// ---------------------------------------------------------------------------
describe("scale topic covers all ScaleDef fields", () => {
  const scaleContent = topics["scale"]?.content() ?? "";

  for (const field of ["mode", "min", "max"]) {
    it(`documents scale field: ${field}`, () => {
      expect(scaleContent).toContain(field);
    });
  }

  for (const mode of ["auto", "fixed", "config"]) {
    it(`documents scale mode: ${mode}`, () => {
      expect(scaleContent).toContain(mode);
    });
  }

  for (const dim of ["batch-count", "doc-count", "token-volume", "source-count"]) {
    it(`documents scale dimension: ${dim}`, () => {
      expect(scaleContent).toContain(dim);
    });
  }
});

// ---------------------------------------------------------------------------
// 17. Composition Coverage
// ---------------------------------------------------------------------------
describe("composition topic covers imports, includes, params", () => {
  const compContent = topics["composition"]?.content() ?? "";

  it("documents import syntax", () => {
    expect(compContent).toContain("import");
    expect(compContent).toContain("from");
  });

  it("documents params", () => {
    expect(compContent).toContain("params");
    expect(compContent).toContain("param");
  });

  it("documents fragments", () => {
    expect(compContent).toContain("fragment");
  });

  it("documents include", () => {
    expect(compContent).toContain("include");
  });

  it("documents interface endpoints", () => {
    expect(compContent).toContain("entry");
    expect(compContent).toContain("exit");
  });

  it("documents sha256 integrity", () => {
    expect(compContent).toContain("sha256");
  });
});

// ---------------------------------------------------------------------------
// 18. Schema Coverage
// ---------------------------------------------------------------------------
describe("schemas topic covers schema types", () => {
  const schemaContent = topics["schemas"]?.content() ?? "";

  for (const type of ["string", "number", "integer", "boolean", "object"]) {
    it(`documents primitive type: ${type}`, () => {
      expect(schemaContent).toContain(type);
    });
  }

  it("documents array type", () => {
    expect(schemaContent).toContain("array");
  });

  it("documents enum type", () => {
    expect(schemaContent).toContain("enum");
  });

  it("documents optional fields", () => {
    expect(schemaContent).toContain("optional");
  });
});

// ---------------------------------------------------------------------------
// 19. Secret Schemes Coverage
// ---------------------------------------------------------------------------
describe("env topic covers secret schemes", () => {
  const envContent = topics["env"]?.content() ?? "";

  for (const scheme of ["vault", "op", "awssm", "ssm", "gcpsm", "azurekv"]) {
    it(`documents secret scheme: ${scheme}`, () => {
      expect(envContent, `Missing secret scheme: ${scheme}`).toContain(scheme);
    });
  }
});

// ---------------------------------------------------------------------------
// 20. Permission Modes Coverage
// ---------------------------------------------------------------------------
describe("agent topic covers all permission modes", () => {
  const agentContent = topics["agent"]?.content() ?? "";

  for (const mode of ["autonomous", "supervised", "interactive", "unrestricted"]) {
    it(`documents permission mode: ${mode}`, () => {
      expect(agentContent, `Missing permission mode: ${mode}`).toContain(mode);
    });
  }

  for (const shortMode of ["auto", "plan", "confirm", "bypass"]) {
    it(`documents short permission mode: ${shortMode}`, () => {
      expect(agentContent, `Missing short mode: ${shortMode}`).toContain(shortMode);
    });
  }
});
