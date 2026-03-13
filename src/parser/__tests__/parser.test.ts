import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { parse, parseSchemaType, parseSchemaFields, parseParams, parseInterfaceEndpoints, parseImports, parseIncludes } from "../index.js";
import { validate } from "../validator.js";
import type { TopologyAST, AgentNode, GateNode, OrchestratorNode, RetryConfig, SchemaFieldDef, SchemaDef, SensitiveValue, ParamDef, InterfaceEndpoints, ImportDef, IncludeDef } from "../ast.js";
import {
  stripComments,
  extractBlock,
  extractAllBlocks,
  parseKV,
  parseFields,
  parseList,
  parseMultilineList,
  unquote,
  parseOutputsBlock,
  dedentBlock,
} from "../lexer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const examplesDir = resolve(__dirname, "../../../examples");

// =========================================================================
// A. Lexer tests
// =========================================================================

describe("Lexer", () => {
  describe("stripComments", () => {
    it("strips lines starting with #", () => {
      const src = `# comment\nfoo\n# another\nbar`;
      const result = stripComments(src);
      expect(result).toBe(`\nfoo\n\nbar`);
    });

    it("preserves content inside prompt {} blocks", () => {
      const src = [
        "agent test {",
        "  prompt {",
        "    # This is a heading",
        "    Some text",
        "  }",
        "}",
      ].join("\n");
      const result = stripComments(src);
      expect(result).toContain("# This is a heading");
    });

    it("strips comments with leading whitespace", () => {
      const src = `  # indented comment\nfoo`;
      const result = stripComments(src);
      expect(result).toBe(`\nfoo`);
    });

    it("preserves non-comment lines unchanged", () => {
      const src = `key: value\nanother: thing`;
      expect(stripComments(src)).toBe(src);
    });

    it("strips inline comments after values", () => {
      const src = `model: opus  # main model\ntools: Read, Write  # core tools`;
      const result = stripComments(src);
      expect(result).toBe(`model: opus\ntools: Read, Write`);
    });

    it("does not strip # inside quoted strings", () => {
      const src = `description: "use # wisely"`;
      const result = stripComments(src);
      expect(result).toBe(`description: "use # wisely"`);
    });

    it("preserves # in prompt blocks even as inline comments", () => {
      const src = [
        "agent test {",
        "  prompt {",
        "    Use color #ff0000 for errors",
        "  }",
        "}",
      ].join("\n");
      const result = stripComments(src);
      expect(result).toContain("Use color #ff0000 for errors");
    });
  });

  describe("extractBlock", () => {
    it("extracts a named block with balanced braces", () => {
      const src = `meta {\n  version: "1.0"\n}`;
      const result = extractBlock(src, "meta");
      expect(result).not.toBeNull();
      expect(result!.body).toContain('version: "1.0"');
      expect(result!.id).toBeNull();
    });

    it("extracts block with an identifier", () => {
      const src = `agent my-agent {\n  model: opus\n}`;
      const result = extractBlock(src, "agent");
      expect(result).not.toBeNull();
      expect(result!.id).toBe("my-agent");
      expect(result!.body).toContain("model: opus");
    });

    it("handles nested braces", () => {
      const src = `agent test {\n  outputs {\n    x: a | b\n  }\n}`;
      const result = extractBlock(src, "agent");
      expect(result).not.toBeNull();
      expect(result!.body).toContain("outputs {");
      expect(result!.body).toContain("x: a | b");
    });

    it("returns null when block not found", () => {
      const result = extractBlock("foo bar", "meta");
      expect(result).toBeNull();
    });
  });

  describe("extractAllBlocks", () => {
    it("extracts multiple blocks of same type", () => {
      const src = `agent a {\n  model: opus\n}\nagent b {\n  model: sonnet\n}`;
      const results = extractAllBlocks(src, "agent");
      expect(results).toHaveLength(2);
      expect(results[0].id).toBe("a");
      expect(results[1].id).toBe("b");
    });

    it("returns empty array when no blocks found", () => {
      const results = extractAllBlocks("no blocks here", "agent");
      expect(results).toHaveLength(0);
    });
  });

  describe("parseKV", () => {
    it("parses key: value", () => {
      const result = parseKV("  model: opus");
      expect(result).toEqual(["model", "opus"]);
    });

    it("parses key with hyphen", () => {
      const result = parseKV("  on-fail: halt");
      expect(result).toEqual(["on-fail", "halt"]);
    });

    it("returns null for non-KV lines", () => {
      expect(parseKV("")).toBeNull();
      expect(parseKV("  # comment")).toBeNull();
      expect(parseKV("  just some text")).toBeNull();
    });

    it("parses quoted values", () => {
      const result = parseKV('  description: "hello world"');
      expect(result).toEqual(["description", '"hello world"']);
    });
  });

  describe("parseFields", () => {
    it("parses multiple KV lines into Record", () => {
      const body = `  model: opus\n  phase: 1\n  permissions: auto`;
      const result = parseFields(body);
      expect(result).toEqual({
        model: "opus",
        phase: "1",
        permissions: "auto",
      });
    });

    it("skips blank lines and non-KV lines", () => {
      const body = `\n  model: opus\n\n  some random text\n  phase: 2`;
      const result = parseFields(body);
      expect(result).toEqual({ model: "opus", phase: "2" });
    });
  });

  describe("parseList", () => {
    it("parses [a, b, c] into array", () => {
      expect(parseList("[a, b, c]")).toEqual(["a", "b", "c"]);
    });

    it("handles quoted items", () => {
      expect(parseList('["x", "y"]')).toEqual(["x", "y"]);
    });

    it("returns single-element array for non-list input", () => {
      expect(parseList("single")).toEqual(["single"]);
    });

    it("handles empty brackets", () => {
      expect(parseList("[]")).toEqual([]);
    });
  });

  describe("parseMultilineList", () => {
    it("parses multiline list", () => {
      const body = `  tools: [\n    Read,\n    Write,\n    Glob\n  ]`;
      const result = parseMultilineList(body, "tools");
      expect(result).toEqual(["Read", "Write", "Glob"]);
    });

    it("parses single-line list", () => {
      const body = `  tools: [Read, Write]`;
      const result = parseMultilineList(body, "tools");
      expect(result).toEqual(["Read", "Write"]);
    });

    it("returns empty array when key not found", () => {
      expect(parseMultilineList("no match", "tools")).toEqual([]);
    });

    it("does not match partial key names", () => {
      // "tools" should not match "disallowed-tools"
      const body = `  disallowed-tools: [Bash]\n  tools: [Read]`;
      const result = parseMultilineList(body, "tools");
      expect(result).toEqual(["Read"]);
    });
  });

  describe("unquote", () => {
    it("removes surrounding double quotes", () => {
      expect(unquote('"hello world"')).toBe("hello world");
    });

    it("returns unchanged if not quoted", () => {
      expect(unquote("noquotes")).toBe("noquotes");
    });

    it("handles empty quoted string", () => {
      expect(unquote('""')).toBe("");
    });
  });

  describe("parseOutputsBlock", () => {
    it("parses outputs { key: a | b } syntax", () => {
      const body = `  outputs {\n    verdict: approve | revise | reject\n  }`;
      const result = parseOutputsBlock(body);
      expect(result).not.toBeNull();
      expect(result!["verdict"]).toEqual(["approve", "revise", "reject"]);
    });

    it("returns null if no outputs block", () => {
      expect(parseOutputsBlock("no outputs here")).toBeNull();
    });

    it("parses multiple output keys", () => {
      const body = `  outputs {\n    a: x | y\n    b: p | q | r\n  }`;
      const result = parseOutputsBlock(body);
      expect(result).not.toBeNull();
      expect(result!["a"]).toEqual(["x", "y"]);
      expect(result!["b"]).toEqual(["p", "q", "r"]);
    });
  });

  describe("dedentBlock", () => {
    it("strips common indent", () => {
      const text = "    line1\n    line2\n    line3";
      expect(dedentBlock(text)).toBe("line1\nline2\nline3");
    });

    it("handles mixed indentation", () => {
      const text = "    line1\n      line2\n    line3";
      expect(dedentBlock(text)).toBe("line1\n  line2\nline3");
    });

    it("trims leading and trailing blank lines", () => {
      const text = "\n\n    line1\n    line2\n\n";
      expect(dedentBlock(text)).toBe("line1\nline2");
    });

    it("handles empty input", () => {
      expect(dedentBlock("")).toBe("");
    });
  });
});

// =========================================================================
// B. Parser section tests
// =========================================================================

describe("Parser sections", () => {
  describe("meta", () => {
    it("parses version, description, and patterns from header", () => {
      const src = `topology test : [pipeline] {\n  meta {\n    version: "2.0.0"\n    description: "A test topology"\n    domain: legal\n  }\n  orchestrator {\n    model: opus\n    handles: [intake]\n  }\n  action intake {\n    kind: inline\n  }\n  flow {\n    intake -> intake\n  }\n}`;
      const ast = parse(src);
      expect(ast.topology.name).toBe("test");
      expect(ast.topology.version).toBe("2.0.0");
      expect(ast.topology.description).toBe("A test topology");
      expect(ast.topology.patterns).toEqual(["pipeline"]);
      expect(ast.topology.domain).toBe("legal");
    });

    it("parses foundations and advanced lists", () => {
      const src = `topology t : [pipeline] {\n  meta {\n    version: "1.0.0"\n    foundations: [pipeline, fan-out]\n    advanced: [consensus]\n  }\n  orchestrator {\n    model: opus\n    handles: [a]\n  }\n  action a { kind: inline }\n  flow { a -> a }\n}`;
      const ast = parse(src);
      expect(ast.topology.foundations).toEqual(["pipeline", "fan-out"]);
      expect(ast.topology.advanced).toEqual(["consensus"]);
    });
  });

  describe("orchestrator", () => {
    it("parses model, handles, generates, and outputs", () => {
      const src = `topology t : [pipeline] {\n  orchestrator {\n    model: opus\n    generates: "plan.md"\n    handles: [intake, done]\n    outputs {\n      decision: plan-gap | bounce-back\n    }\n  }\n  action intake { kind: inline }\n  action done { kind: report }\n  flow { intake -> done }\n}`;
      const ast = parse(src);
      const orch = ast.nodes.find((n) => n.type === "orchestrator") as OrchestratorNode;
      expect(orch).toBeDefined();
      expect(orch.model).toBe("opus");
      expect(orch.generates).toBe("plan.md");
      expect(orch.handles).toEqual(["intake", "done"]);
      expect(orch.outputs).toEqual({ decision: ["plan-gap", "bounce-back"] });
    });
  });

  describe("roles", () => {
    it("parses multiple role definitions", () => {
      const src = `topology t : [pipeline] {\n  roles {\n    writer: "Writes drafts"\n    reviewer: "Reviews content"\n  }\n  orchestrator { model: opus\n    handles: [a] }\n  action a { kind: inline }\n  flow { a -> a }\n}`;
      const ast = parse(src);
      expect(ast.roles).toEqual({
        writer: "Writes drafts",
        reviewer: "Reviews content",
      });
    });
  });

  describe("action", () => {
    it("parses inline action", () => {
      const src = `topology t : [pipeline] {\n  orchestrator { model: opus\n    handles: [a] }\n  action a {\n    kind: inline\n    description: "Parse request"\n  }\n  flow { a -> a }\n}`;
      const ast = parse(src);
      const action = ast.nodes.find((n) => n.id === "a");
      expect(action).toBeDefined();
      expect(action!.type).toBe("action");
      if (action!.type === "action") {
        expect(action!.kind).toBe("inline");
        expect(action!.description).toBe("Parse request");
      }
    });

    it("parses external action with source", () => {
      const src = `topology t : [pipeline] {\n  orchestrator { model: opus\n    handles: [fetch] }\n  action fetch {\n    kind: external\n    source: "github-pr"\n  }\n  flow { fetch -> fetch }\n}`;
      const ast = parse(src);
      const action = ast.nodes.find((n) => n.id === "fetch");
      if (action!.type === "action") {
        expect(action!.kind).toBe("external");
        expect(action!.source).toBe("github-pr");
      }
    });

    it("parses action with commands list", () => {
      const src = `topology t : [pipeline] {\n  orchestrator { model: opus\n    handles: [build] }\n  action build {\n    kind: inline\n    commands: [npm install, npm test]\n  }\n  flow { build -> build }\n}`;
      const ast = parse(src);
      const action = ast.nodes.find((n) => n.id === "build");
      if (action!.type === "action") {
        expect(action!.commands).toEqual(["npm install", "npm test"]);
      }
    });
  });

  describe("agent", () => {
    it("parses all basic fields", () => {
      const src = `topology t : [pipeline] {\n  orchestrator { model: opus\n    handles: [a] }\n  action a { kind: inline }\n  agent my-agent {\n    model: sonnet\n    phase: 2\n    tools: [Read, Write]\n    reads: ["workspace/input"]\n    writes: ["workspace/output"]\n    permissions: auto\n    behavior: advisory\n    invocation: manual\n    isolation: worktree\n    background: true\n    retry: 3\n    skip: "depth < 2"\n    description: "Test agent"\n    max-turns: 10\n  }\n  flow { a -> a }\n}`;
      const ast = parse(src);
      const agent = ast.nodes.find((n) => n.id === "my-agent") as AgentNode;
      expect(agent).toBeDefined();
      expect(agent.model).toBe("sonnet");
      expect(agent.phase).toBe(2);
      expect(agent.tools).toEqual(["Read", "Write"]);
      expect(agent.reads).toEqual(["workspace/input"]);
      expect(agent.writes).toEqual(["workspace/output"]);
      expect(agent.permissions).toBe("auto");
      expect(agent.behavior).toBe("advisory");
      expect(agent.invocation).toBe("manual");
      expect(agent.isolation).toBe("worktree");
      expect(agent.background).toBe(true);
      expect(agent.retry).toBe(3);
      expect(agent.skip).toBe('"depth < 2"');
      expect(agent.description).toBe("Test agent");
      expect(agent.maxTurns).toBe(10);
    });

    it("parses inline prompt block", () => {
      const src = `topology t : [pipeline] {\n  orchestrator { model: opus\n    handles: [a] }\n  action a { kind: inline }\n  agent writer {\n    model: opus\n    prompt {\n      You are a writer.\n      Write good content.\n    }\n  }\n  flow { a -> writer }\n}`;
      const ast = parse(src);
      const agent = ast.nodes.find((n) => n.id === "writer") as AgentNode;
      expect(agent.prompt).toBeDefined();
      expect(agent.prompt).toContain("You are a writer.");
      expect(agent.prompt).toContain("Write good content.");
    });

    it("parses disallowed-tools", () => {
      const src = `topology t : [pipeline] {\n  orchestrator { model: opus\n    handles: [a] }\n  action a { kind: inline }\n  agent safe {\n    model: opus\n    disallowed-tools: [Bash, Write]\n  }\n  flow { a -> safe }\n}`;
      const ast = parse(src);
      const agent = ast.nodes.find((n) => n.id === "safe") as AgentNode;
      expect(agent.disallowedTools).toEqual(["Bash", "Write"]);
    });

    it("parses outputs block", () => {
      const src = `topology t : [pipeline] {\n  orchestrator { model: opus\n    handles: [a] }\n  action a { kind: inline }\n  agent scorer {\n    model: opus\n    outputs {\n      quality: high | medium | low\n    }\n  }\n  flow { a -> scorer }\n}`;
      const ast = parse(src);
      const agent = ast.nodes.find((n) => n.id === "scorer") as AgentNode;
      expect(agent.outputs).toEqual({ quality: ["high", "medium", "low"] });
    });

    it("parses scale block", () => {
      const src = `topology t : [pipeline] {\n  orchestrator { model: opus\n    handles: [a] }\n  action a { kind: inline }\n  agent worker {\n    model: opus\n    scale {\n      mode: auto\n      by: doc-count\n      min: 2\n      max: 8\n      batch-size: 50\n    }\n  }\n  flow { a -> worker }\n}`;
      const ast = parse(src);
      const agent = ast.nodes.find((n) => n.id === "worker") as AgentNode;
      expect(agent.scale).toEqual({
        mode: "auto",
        by: "doc-count",
        min: 2,
        max: 8,
        batchSize: 50,
      });
    });

    it("parses per-agent hooks block", () => {
      const src = `topology t : [pipeline] {\n  orchestrator { model: opus\n    handles: [a] }\n  action a { kind: inline }\n  agent hooked {\n    model: opus\n    hooks {\n      hook pre-tool {\n        on: PreToolUse\n        matcher: "Bash"\n        run: "scripts/check.sh"\n        type: command\n        timeout: 5000\n      }\n    }\n  }\n  flow { a -> hooked }\n}`;
      const ast = parse(src);
      const agent = ast.nodes.find((n) => n.id === "hooked") as AgentNode;
      expect(agent.hooks).toBeDefined();
      expect(agent.hooks).toHaveLength(1);
      expect(agent.hooks![0].name).toBe("pre-tool");
      expect(agent.hooks![0].on).toBe("PreToolUse");
      expect(agent.hooks![0].matcher).toBe("Bash");
      expect(agent.hooks![0].run).toBe("scripts/check.sh");
      expect(agent.hooks![0].type).toBe("command");
      expect(agent.hooks![0].timeout).toBe(5000);
    });

    it("parses extensions block", () => {
      const src = `topology t : [pipeline] {\n  orchestrator { model: opus\n    handles: [a] }\n  action a { kind: inline }\n  agent extended {\n    model: opus\n    extensions {\n      openclaw {\n        calendar-integration: true\n        port: 8080\n      }\n    }\n  }\n  flow { a -> extended }\n}`;
      const ast = parse(src);
      const agent = ast.nodes.find((n) => n.id === "extended") as AgentNode;
      expect(agent.extensions).toBeDefined();
      expect(agent.extensions!["openclaw"]).toEqual({
        "calendar-integration": true,
        port: 8080,
      });
    });

    it("parses mcp-servers list", () => {
      const src = `topology t : [pipeline] {\n  orchestrator { model: opus\n    handles: [a] }\n  action a { kind: inline }\n  agent mcp-user {\n    model: opus\n    mcp-servers: [storage, monitoring]\n  }\n  flow { a -> mcp-user }\n}`;
      const ast = parse(src);
      const agent = ast.nodes.find((n) => n.id === "mcp-user") as AgentNode;
      expect(agent.mcpServers).toEqual(["storage", "monitoring"]);
    });

    it("parses skills list", () => {
      const src = `topology t : [pipeline] {\n  orchestrator { model: opus\n    handles: [a] }\n  action a { kind: inline }\n  agent skilled {\n    model: opus\n    skills: [extraction, classification]\n  }\n  flow { a -> skilled }\n}`;
      const ast = parse(src);
      const agent = ast.nodes.find((n) => n.id === "skilled") as AgentNode;
      expect(agent.skills).toEqual(["extraction", "classification"]);
    });

    it("attaches role from roles block", () => {
      const src = `topology t : [pipeline] {\n  roles {\n    writer: "Writes things"\n  }\n  orchestrator { model: opus\n    handles: [a] }\n  action a { kind: inline }\n  agent writer {\n    model: opus\n  }\n  flow { a -> writer }\n}`;
      const ast = parse(src);
      const agent = ast.nodes.find((n) => n.id === "writer") as AgentNode;
      expect(agent.role).toBe("Writes things");
    });
  });

  describe("flow", () => {
    it("parses simple chain", () => {
      const src = `topology t : [pipeline] {\n  orchestrator { model: opus\n    handles: [a, c] }\n  action a { kind: inline }\n  agent b { model: opus }\n  action c { kind: report }\n  flow {\n    a -> b -> c\n  }\n}`;
      const ast = parse(src);
      expect(ast.edges).toHaveLength(2);
      expect(ast.edges[0]).toEqual({ from: "a", to: "b", condition: null, maxIterations: null, per: null });
      expect(ast.edges[1]).toEqual({ from: "b", to: "c", condition: null, maxIterations: null, per: null });
    });

    it("parses fan-out [a, b]", () => {
      const src = `topology t : [pipeline] {\n  orchestrator { model: opus\n    handles: [start] }\n  action start { kind: inline }\n  agent x { model: opus }\n  agent y { model: opus }\n  flow {\n    start -> [x, y]\n  }\n}`;
      const ast = parse(src);
      expect(ast.edges).toHaveLength(2);
      expect(ast.edges[0].from).toBe("start");
      expect(ast.edges[0].to).toBe("x");
      expect(ast.edges[1].from).toBe("start");
      expect(ast.edges[1].to).toBe("y");
    });

    it("parses conditions [when x.y == z]", () => {
      const src = `topology t : [pipeline] {\n  orchestrator { model: opus\n    handles: [a] }\n  action a { kind: inline }\n  agent b { model: opus\n    outputs { verdict: yes | no } }\n  agent c { model: opus }\n  flow {\n    b -> c [when b.verdict == yes]\n  }\n}`;
      const ast = parse(src);
      const edge = ast.edges.find((e) => e.from === "b" && e.to === "c");
      expect(edge).toBeDefined();
      expect(edge!.condition).toBe("b.verdict == yes");
      expect(edge!.maxIterations).toBeNull();
    });

    it("parses bounded loops [max N]", () => {
      const src = `topology t : [pipeline] {\n  orchestrator { model: opus\n    handles: [a] }\n  action a { kind: inline }\n  agent b { model: opus }\n  agent c { model: opus }\n  flow {\n    c -> b [max 3]\n  }\n}`;
      const ast = parse(src);
      const edge = ast.edges.find((e) => e.from === "c" && e.to === "b");
      expect(edge).toBeDefined();
      expect(edge!.maxIterations).toBe(3);
      expect(edge!.condition).toBeNull();
    });

    it("parses combined [when x.y == z, max 3]", () => {
      const src = `topology t : [pipeline] {\n  orchestrator { model: opus\n    handles: [a] }\n  action a { kind: inline }\n  agent b { model: opus\n    outputs { verdict: yes | no } }\n  agent c { model: opus }\n  flow {\n    c -> b [when c.verdict == no, max 3]\n  }\n}`;
      const ast = parse(src);
      const edge = ast.edges.find((e) => e.from === "c" && e.to === "b");
      expect(edge).toBeDefined();
      expect(edge!.condition).toBe("c.verdict == no");
      expect(edge!.maxIterations).toBe(3);
    });
  });

  describe("gates", () => {
    it("parses gate with all fields", () => {
      const src = `topology t : [pipeline] {\n  orchestrator { model: opus\n    handles: [a] }\n  action a { kind: inline }\n  agent b { model: opus }\n  agent c { model: opus }\n  gates {\n    gate quality {\n      after: b\n      before: c\n      run: "scripts/check.sh"\n      checks: [grammar, formatting]\n      on-fail: bounce-back\n      retry: 2\n      behavior: blocking\n    }\n  }\n  flow { a -> b -> c }\n}`;
      const ast = parse(src);
      const gate = ast.nodes.find((n) => n.id === "quality") as GateNode;
      expect(gate).toBeDefined();
      expect(gate.type).toBe("gate");
      expect(gate.after).toBe("b");
      expect(gate.before).toBe("c");
      expect(gate.run).toBe("scripts/check.sh");
      expect(gate.checks).toEqual(["grammar", "formatting"]);
      expect(gate.onFail).toBe("bounce-back");
      expect(gate.retry).toBe(2);
      expect(gate.behavior).toBe("blocking");
    });

    it("parses gate with extensions", () => {
      const src = `topology t : [pipeline] {\n  orchestrator { model: opus\n    handles: [a] }\n  action a { kind: inline }\n  agent b { model: opus }\n  gates {\n    gate ext-gate {\n      after: b\n      run: "check.sh"\n      extensions {\n        custom {\n          enabled: true\n        }\n      }\n    }\n  }\n  flow { a -> b }\n}`;
      const ast = parse(src);
      const gate = ast.nodes.find((n) => n.id === "ext-gate") as GateNode;
      expect(gate.extensions).toBeDefined();
      expect(gate.extensions!["custom"]).toEqual({ enabled: true });
    });
  });

  describe("depth", () => {
    it("parses levels and factors", () => {
      const src = `topology t : [pipeline] {\n  orchestrator { model: opus\n    handles: [a] }\n  action a { kind: inline }\n  flow { a -> a }\n  depth {\n    factors: [batch-count, token-volume]\n    level 1 "Quick" {\n      omit: [reviewer]\n    }\n    level 2 "Full" {\n      omit: []\n    }\n  }\n}`;
      const ast = parse(src);
      expect(ast.depth.factors).toEqual(["batch-count", "token-volume"]);
      expect(ast.depth.levels).toHaveLength(2);
      expect(ast.depth.levels[0]).toEqual({ level: 1, label: "Quick", omit: ["reviewer"] });
      expect(ast.depth.levels[1]).toEqual({ level: 2, label: "Full", omit: [] });
    });
  });

  describe("memory", () => {
    it("parses workspace, domains, and metrics", () => {
      const src = `topology t : [pipeline] {\n  orchestrator { model: opus\n    handles: [a] }\n  action a { kind: inline }\n  flow { a -> a }\n  memory {\n    workspace {\n      path: "workspace/"\n      protocol: "proto.md"\n      structure: [raw, processed]\n    }\n    domains {\n      path: "domains/"\n      routing: "FILE_MAP.md"\n    }\n    metrics {\n      path: "metrics.jsonl"\n      mode: append-only\n    }\n  }\n}`;
      const ast = parse(src);
      const ws = ast.memory["workspace"] as Record<string, unknown>;
      expect(ws["path"]).toBe("workspace/");
      expect(ws["protocol"]).toBe("proto.md");
      expect(ws["structure"]).toEqual(["raw", "processed"]);

      const domains = ast.memory["domains"] as Record<string, unknown>;
      expect(domains["path"]).toBe("domains/");
      expect(domains["routing"]).toBe("FILE_MAP.md");

      const metrics = ast.memory["metrics"] as Record<string, unknown>;
      expect(metrics["path"]).toBe("metrics.jsonl");
      expect(metrics["mode"]).toBe("append-only");
    });
  });

  describe("batch", () => {
    it("parses parallel, per, workspace, and conflicts", () => {
      const src = `topology t : [pipeline] {\n  orchestrator { model: opus\n    handles: [a] }\n  action a { kind: inline }\n  flow { a -> a }\n  batch {\n    parallel: true\n    per: ticket\n    workspace: "runs/{BATCH_ID}/"\n    conflicts {\n      detect: ["workspace/out.json"]\n      resolve: sequential-rebase\n    }\n  }\n}`;
      const ast = parse(src);
      expect(ast.batch["parallel"]).toBe(true);
      expect(ast.batch["per"]).toBe("ticket");
      expect(ast.batch["workspace"]).toBe("runs/{BATCH_ID}/");
      const conflicts = ast.batch["conflicts"] as any;
      expect(conflicts.detect).toEqual(["workspace/out.json"]);
      expect(conflicts.resolve).toBe("sequential-rebase");
    });
  });

  describe("environments", () => {
    it("parses multiple named environment blocks", () => {
      const src = `topology t : [pipeline] {\n  orchestrator { model: opus\n    handles: [a] }\n  action a { kind: inline }\n  flow { a -> a }\n  environments {\n    staging {\n      bucket: "stage-bucket"\n    }\n    production {\n      bucket: "prod-bucket"\n    }\n  }\n}`;
      const ast = parse(src);
      expect(ast.environments["staging"]).toEqual({ bucket: "stage-bucket" });
      expect(ast.environments["production"]).toEqual({ bucket: "prod-bucket" });
    });
  });

  describe("triggers", () => {
    it("parses command with pattern", () => {
      const src = `topology t : [pipeline] {\n  orchestrator { model: opus\n    handles: [a] }\n  action a { kind: inline }\n  flow { a -> a }\n  triggers {\n    command audit {\n      pattern: "/audit"\n    }\n  }\n}`;
      const ast = parse(src);
      expect(ast.triggers).toHaveLength(1);
      expect(ast.triggers[0].name).toBe("audit");
      expect(ast.triggers[0].pattern).toBe("/audit");
      expect(ast.triggers[0].argument).toBeUndefined();
    });

    it("parses command with pattern and argument", () => {
      const src = `topology t : [pipeline] {\n  orchestrator { model: opus\n    handles: [a] }\n  action a { kind: inline }\n  flow { a -> a }\n  triggers {\n    command create {\n      pattern: "/create <TOPIC>"\n      argument: TOPIC\n    }\n  }\n}`;
      const ast = parse(src);
      expect(ast.triggers[0].name).toBe("create");
      expect(ast.triggers[0].pattern).toBe("/create <TOPIC>");
      expect(ast.triggers[0].argument).toBe("TOPIC");
    });
  });

  describe("hooks", () => {
    it("parses hooks with on, run, type, matcher, timeout", () => {
      const src = `topology t : [pipeline] {\n  orchestrator { model: opus\n    handles: [a] }\n  action a { kind: inline }\n  flow { a -> a }\n  hooks {\n    hook my-hook {\n      on: PreToolUse\n      matcher: "Bash"\n      run: "scripts/guard.sh"\n      type: command\n      timeout: 3000\n    }\n  }\n}`;
      const ast = parse(src);
      expect(ast.hooks).toHaveLength(1);
      expect(ast.hooks[0].name).toBe("my-hook");
      expect(ast.hooks[0].on).toBe("PreToolUse");
      expect(ast.hooks[0].matcher).toBe("Bash");
      expect(ast.hooks[0].run).toBe("scripts/guard.sh");
      expect(ast.hooks[0].type).toBe("command");
      expect(ast.hooks[0].timeout).toBe(3000);
    });
  });

  describe("settings", () => {
    it("parses allow, deny, ask lists", () => {
      const src = `topology t : [pipeline] {\n  orchestrator { model: opus\n    handles: [a] }\n  action a { kind: inline }\n  flow { a -> a }\n  settings {\n    allow: [Read, Write]\n    deny: [Bash]\n    ask: [Edit]\n  }\n}`;
      const ast = parse(src);
      expect(ast.settings["allow"]).toEqual(["Read", "Write"]);
      expect(ast.settings["deny"]).toEqual(["Bash"]);
      expect(ast.settings["ask"]).toEqual(["Edit"]);
    });
  });

  describe("mcp-servers", () => {
    it("parses stdio and http server types", () => {
      const src = `topology t : [pipeline] {\n  orchestrator { model: opus\n    handles: [a] }\n  action a { kind: inline }\n  flow { a -> a }\n  mcp-servers {\n    storage {\n      type: stdio\n      command: "npx"\n      args: ["-y", "storage-server"]\n    }\n    monitor {\n      type: http\n      url: "https://mcp.example.com"\n    }\n  }\n}`;
      const ast = parse(src);
      expect(ast.mcpServers["storage"]).toBeDefined();
      expect(ast.mcpServers["storage"]["type"]).toBe("stdio");
      expect(ast.mcpServers["storage"]["command"]).toBe("npx");
      expect(ast.mcpServers["storage"]["args"]).toEqual(["-y", "storage-server"]);
      expect(ast.mcpServers["monitor"]["type"]).toBe("http");
      expect(ast.mcpServers["monitor"]["url"]).toBe("https://mcp.example.com");
    });
  });

  describe("metering", () => {
    it("parses track, per, output, format, pricing", () => {
      const src = `topology t : [pipeline] {\n  orchestrator { model: opus\n    handles: [a] }\n  action a { kind: inline }\n  flow { a -> a }\n  metering {\n    track: [tokens-in, tokens-out, cost]\n    per: [agent, run]\n    output: "metrics/"\n    format: jsonl\n    pricing: anthropic-current\n  }\n}`;
      const ast = parse(src);
      expect(ast.metering).not.toBeNull();
      expect(ast.metering!.track).toEqual(["tokens-in", "tokens-out", "cost"]);
      expect(ast.metering!.per).toEqual(["agent", "run"]);
      expect(ast.metering!.output).toBe("metrics/");
      expect(ast.metering!.format).toBe("jsonl");
      expect(ast.metering!.pricing).toBe("anthropic-current");
    });
  });

  describe("tools", () => {
    it("parses tool with script, args, lang, description", () => {
      const src = `topology t : [pipeline] {\n  orchestrator { model: opus\n    handles: [a] }\n  action a { kind: inline }\n  flow { a -> a }\n  tools {\n    tool extract-pdf {\n      script: "scripts/extract.py"\n      args: [input, output]\n      lang: python\n      description: "Extract text from PDF"\n    }\n  }\n}`;
      const ast = parse(src);
      expect(ast.toolDefs).toHaveLength(1);
      expect(ast.toolDefs[0].id).toBe("extract-pdf");
      expect(ast.toolDefs[0].script).toBe("scripts/extract.py");
      expect(ast.toolDefs[0].args).toEqual(["input", "output"]);
      expect(ast.toolDefs[0].lang).toBe("python");
      expect(ast.toolDefs[0].description).toBe("Extract text from PDF");
    });
  });

  describe("skill", () => {
    it("parses all skill fields", () => {
      const src = `topology t : [pipeline] {\n  orchestrator { model: opus\n    handles: [a] }\n  action a { kind: inline }\n  flow { a -> a }\n  skill my-skill {\n    description: "A test skill"\n    scripts: [script-a, script-b]\n    domains: ["domains/rubric.md"]\n    references: ["ref/guide.md"]\n    prompt: "prompts/skill.md"\n    disable-model-invocation: true\n    user-invocable: false\n    context: fork\n    agent: task-agent\n    allowed-tools: [Read, Write]\n    extensions {\n      custom {\n        key: value\n      }\n    }\n  }\n}`;
      const ast = parse(src);
      expect(ast.skills).toHaveLength(1);
      const skill = ast.skills[0];
      expect(skill.id).toBe("my-skill");
      expect(skill.description).toBe("A test skill");
      expect(skill.scripts).toEqual(["script-a", "script-b"]);
      expect(skill.domains).toEqual(["domains/rubric.md"]);
      expect(skill.references).toEqual(["ref/guide.md"]);
      expect(skill.prompt).toBe("prompts/skill.md");
      expect(skill.disableModelInvocation).toBe(true);
      expect(skill.userInvocable).toBe(false);
      expect(skill.context).toBe("fork");
      expect(skill.agent).toBe("task-agent");
      expect(skill.allowedTools).toEqual(["Read", "Write"]);
      expect(skill.extensions).toBeDefined();
      expect(skill.extensions!["custom"]).toEqual({ key: "value" });
    });
  });

  describe("context", () => {
    it("parses file and includes", () => {
      const src = `topology t : [pipeline] {\n  orchestrator { model: opus\n    handles: [a] }\n  action a { kind: inline }\n  flow { a -> a }\n  context {\n    file: "CONTEXT.md"\n    includes: [README.md, CONTRIBUTING.md]\n  }\n}`;
      const ast = parse(src);
      expect(ast.context.file).toBe("CONTEXT.md");
      expect(ast.context.includes).toEqual(["README.md", "CONTRIBUTING.md"]);
    });
  });

  describe("env", () => {
    it("parses key-value pairs", () => {
      const src = `topology t : [pipeline] {\n  orchestrator { model: opus\n    handles: [a] }\n  action a { kind: inline }\n  flow { a -> a }\n  env {\n    API_KEY: "sk-123"\n    REGION: "us-east-1"\n  }\n}`;
      const ast = parse(src);
      expect(ast.env["API_KEY"]).toBe("sk-123");
      expect(ast.env["REGION"]).toBe("us-east-1");
    });
  });

  describe("providers", () => {
    it("parses provider with all fields", () => {
      const src = `topology t : [pipeline] {\n  orchestrator { model: opus\n    handles: [a] }\n  action a { kind: inline }\n  flow { a -> a }\n  providers {\n    anthropic {\n      api-key: "\${ANTHROPIC_API_KEY}"\n      base-url: "https://api.anthropic.com"\n      models: [opus, sonnet, haiku]\n      default: true\n    }\n    openai {\n      api-key: "\${OPENAI_API_KEY}"\n      models: [gpt-4o]\n    }\n  }\n}`;
      const ast = parse(src);
      expect(ast.providers).toHaveLength(2);
      expect(ast.providers[0].name).toBe("anthropic");
      expect(ast.providers[0].apiKey).toBe("${ANTHROPIC_API_KEY}");
      expect(ast.providers[0].baseUrl).toBe("https://api.anthropic.com");
      expect(ast.providers[0].models).toEqual(["opus", "sonnet", "haiku"]);
      expect(ast.providers[0].default).toBe(true);
      expect(ast.providers[1].name).toBe("openai");
      expect(ast.providers[1].apiKey).toBe("${OPENAI_API_KEY}");
      expect(ast.providers[1].models).toEqual(["gpt-4o"]);
    });
  });

  describe("schedule", () => {
    it("parses job with cron", () => {
      const src = `topology t : [pipeline] {\n  orchestrator { model: opus\n    handles: [a] }\n  action a { kind: inline }\n  agent worker { model: opus }\n  flow { a -> worker }\n  schedule {\n    job nightly {\n      cron: "0 0 * * *"\n      agent: worker\n    }\n  }\n}`;
      const ast = parse(src);
      expect(ast.schedules).toHaveLength(1);
      expect(ast.schedules[0].id).toBe("nightly");
      expect(ast.schedules[0].cron).toBe("0 0 * * *");
      expect(ast.schedules[0].agent).toBe("worker");
      expect(ast.schedules[0].enabled).toBe(true);
    });

    it("parses job with every", () => {
      const src = `topology t : [pipeline] {\n  orchestrator { model: opus\n    handles: [a] }\n  action a { kind: inline }\n  agent worker { model: opus }\n  flow { a -> worker }\n  schedule {\n    job weekly {\n      every: "monday 9:00"\n      agent: worker\n      enabled: true\n    }\n  }\n}`;
      const ast = parse(src);
      expect(ast.schedules).toHaveLength(1);
      expect(ast.schedules[0].id).toBe("weekly");
      expect(ast.schedules[0].every).toBe("monday 9:00");
      expect(ast.schedules[0].cron).toBeUndefined();
      expect(ast.schedules[0].enabled).toBe(true);
    });

    it("parses job with enabled: false", () => {
      const src = `topology t : [pipeline] {\n  orchestrator { model: opus\n    handles: [a] }\n  action a { kind: inline }\n  agent worker { model: opus }\n  flow { a -> worker }\n  schedule {\n    job disabled-job {\n      cron: "0 0 * * *"\n      agent: worker\n      enabled: false\n    }\n  }\n}`;
      const ast = parse(src);
      expect(ast.schedules[0].enabled).toBe(false);
    });
  });

  describe("interfaces", () => {
    it("parses multiple interfaces with type and config", () => {
      const src = `topology t : [pipeline] {\n  orchestrator { model: opus\n    handles: [a] }\n  action a { kind: inline }\n  flow { a -> a }\n  interfaces {\n    slack {\n      type: webhook\n      webhook: "\${SLACK_URL}"\n      channel: "alerts"\n    }\n    dashboard {\n      type: http\n      port: 8080\n    }\n  }\n}`;
      const ast = parse(src);
      expect(ast.interfaces).toHaveLength(2);

      const slack = ast.interfaces.find((i) => i.id === "slack");
      expect(slack).toBeDefined();
      expect(slack!.type).toBe("webhook");
      expect(slack!.config["webhook"]).toBe("${SLACK_URL}");
      expect(slack!.config["channel"]).toBe("alerts");

      const dashboard = ast.interfaces.find((i) => i.id === "dashboard");
      expect(dashboard).toBeDefined();
      expect(dashboard!.type).toBe("http");
      expect(dashboard!.config["port"]).toBe(8080);
    });
  });

  describe("sandbox", () => {
    it("parses sandbox field on agent (string value)", () => {
      const src = `topology t : [pipeline] {\n  orchestrator { model: opus\n    handles: [a] }\n  action a { kind: inline }\n  agent sandboxed { model: opus\n    sandbox: docker }\n  flow { a -> sandboxed }\n}`;
      const ast = parse(src);
      const agent = ast.nodes.find((n) => n.id === "sandboxed") as AgentNode;
      expect(agent.sandbox).toBe("docker");
    });

    it("parses sandbox: true on agent", () => {
      const src = `topology t : [pipeline] {\n  orchestrator { model: opus\n    handles: [a] }\n  action a { kind: inline }\n  agent sandboxed { model: opus\n    sandbox: true }\n  flow { a -> sandboxed }\n}`;
      const ast = parse(src);
      const agent = ast.nodes.find((n) => n.id === "sandboxed") as AgentNode;
      expect(agent.sandbox).toBe(true);
    });

    it("parses sandbox in settings", () => {
      const src = `topology t : [pipeline] {\n  orchestrator { model: opus\n    handles: [a] }\n  action a { kind: inline }\n  flow { a -> a }\n  settings {\n    sandbox: network-only\n  }\n}`;
      const ast = parse(src);
      expect(ast.settings["sandbox"]).toBe("network-only");
    });
  });

  describe("fallback-chain", () => {
    it("parses fallback-chain on agent", () => {
      const src = `topology t : [pipeline] {\n  orchestrator { model: opus\n    handles: [a] }\n  action a { kind: inline }\n  agent resilient { model: opus\n    fallback-chain: [sonnet, haiku] }\n  flow { a -> resilient }\n}`;
      const ast = parse(src);
      const agent = ast.nodes.find((n) => n.id === "resilient") as AgentNode;
      expect(agent.fallbackChain).toEqual(["sonnet", "haiku"]);
    });

    it("parses fallback-chain in settings", () => {
      const src = `topology t : [pipeline] {\n  orchestrator { model: opus\n    handles: [a] }\n  action a { kind: inline }\n  flow { a -> a }\n  settings {\n    fallback-chain: [opus, sonnet, haiku]\n  }\n}`;
      const ast = parse(src);
      expect(ast.settings["fallbackChain"]).toEqual(["opus", "sonnet", "haiku"]);
    });
  });
});

// =========================================================================
// C. Validator tests
// =========================================================================

describe("Validator", () => {
  /** Helper to create a minimal valid AST for mutation in tests. */
  function minimalAST(overrides: Partial<TopologyAST> = {}): TopologyAST {
    return {
      topology: { name: "test", version: "1.0.0", description: "", patterns: ["pipeline"] },
      nodes: [
        { id: "orchestrator", type: "orchestrator", label: "Orchestrator", model: "opus", handles: ["intake"] },
        { id: "intake", type: "action", label: "Intake" },
        { id: "worker", type: "agent", label: "Worker", model: "sonnet" },
      ],
      edges: [
        { from: "intake", to: "worker", condition: null, maxIterations: null },
      ],
      depth: { factors: [], levels: [] },
      memory: {},
      batch: {},
      environments: {},
      triggers: [],
      hooks: [],
      settings: {},
      mcpServers: {},
      metering: null,
      defaults: null,
      schemas: [],
      observability: null,
      skills: [],
      toolDefs: [],
      roles: {},
      context: {},
      env: {},
      providers: [],
      schedules: [],
      interfaces: [],
      params: [],
      interfaceEndpoints: null,
      imports: [],
      includes: [],
      ...overrides,
    };
  }

  it("V1: duplicate agent names -> error", () => {
    const ast = minimalAST({
      nodes: [
        { id: "orchestrator", type: "orchestrator", label: "O", model: "opus", handles: [] },
        { id: "worker", type: "agent", label: "Worker", model: "sonnet" },
        { id: "worker", type: "agent", label: "Worker2", model: "haiku" },
      ],
    });
    const results = validate(ast);
    const v1 = results.filter((r) => r.rule === "V1");
    expect(v1.length).toBeGreaterThan(0);
    expect(v1[0].level).toBe("error");
  });

  it("V2: reserved keyword as name -> error", () => {
    const ast = minimalAST({
      nodes: [
        { id: "orchestrator", type: "orchestrator", label: "O", model: "opus", handles: [] },
        { id: "agent", type: "agent", label: "Agent", model: "sonnet" },
      ],
      edges: [{ from: "agent", to: "agent", condition: null, maxIterations: null }],
    });
    const results = validate(ast);
    const v2 = results.filter((r) => r.rule === "V2");
    expect(v2.length).toBeGreaterThan(0);
    expect(v2[0].level).toBe("error");
  });

  it("V3: undeclared node in flow -> error", () => {
    const ast = minimalAST({
      edges: [
        { from: "intake", to: "nonexistent", condition: null, maxIterations: null },
      ],
    });
    const results = validate(ast);
    const v3 = results.filter((r) => r.rule === "V3");
    expect(v3.length).toBeGreaterThan(0);
    expect(v3[0].message).toContain("nonexistent");
  });

  it("V4: agent not in flow (without invocation: manual) -> error", () => {
    const ast = minimalAST({
      nodes: [
        { id: "orchestrator", type: "orchestrator", label: "O", model: "opus", handles: [] },
        { id: "orphan", type: "agent", label: "Orphan", model: "sonnet" },
      ],
      edges: [],
    });
    const results = validate(ast);
    const v4 = results.filter((r) => r.rule === "V4");
    expect(v4.length).toBeGreaterThan(0);
    expect(v4[0].node).toBe("orphan");
  });

  it("V5: invalid condition reference -> error", () => {
    const ast = minimalAST({
      edges: [
        { from: "intake", to: "worker", condition: "nonexistent.output == yes", maxIterations: null },
      ],
    });
    const results = validate(ast);
    const v5 = results.filter((r) => r.rule === "V5");
    expect(v5.length).toBeGreaterThan(0);
  });

  it("V6: back-edge without max bound -> error", () => {
    const ast = minimalAST({
      edges: [
        { from: "intake", to: "worker", condition: null, maxIterations: null },
        { from: "worker", to: "intake", condition: null, maxIterations: null },
      ],
    });
    const results = validate(ast);
    const v6 = results.filter((r) => r.rule === "V6");
    expect(v6.length).toBeGreaterThan(0);
  });

  it("V7: agent missing model -> error", () => {
    const ast = minimalAST({
      nodes: [
        { id: "orchestrator", type: "orchestrator", label: "O", model: "opus", handles: [] },
        { id: "nomodel", type: "agent", label: "No Model" } as any,
      ],
      edges: [{ from: "nomodel", to: "nomodel", condition: null, maxIterations: null }],
    });
    const results = validate(ast);
    const v7 = results.filter((r) => r.rule === "V7");
    expect(v7.length).toBeGreaterThan(0);
    expect(v7[0].node).toBe("nomodel");
  });

  it("V9: action in flow not in orchestrator.handles -> error", () => {
    const ast = minimalAST({
      nodes: [
        { id: "orchestrator", type: "orchestrator", label: "O", model: "opus", handles: [] },
        { id: "unhandled", type: "action", label: "Unhandled" },
        { id: "worker", type: "agent", label: "Worker", model: "sonnet" },
      ],
      edges: [
        { from: "unhandled", to: "worker", condition: null, maxIterations: null },
      ],
    });
    const results = validate(ast);
    const v9 = results.filter((r) => r.rule === "V9");
    expect(v9.length).toBeGreaterThan(0);
    expect(v9[0].node).toBe("unhandled");
  });

  it("V10: empty prompt block -> warning", () => {
    const ast = minimalAST({
      nodes: [
        { id: "orchestrator", type: "orchestrator", label: "O", model: "opus", handles: ["intake"] },
        { id: "intake", type: "action", label: "I" },
        { id: "empty-prompt", type: "agent", label: "EP", model: "opus", prompt: "   " },
      ],
      edges: [{ from: "intake", to: "empty-prompt", condition: null, maxIterations: null }],
    });
    const results = validate(ast);
    const v10 = results.filter((r) => r.rule === "V10");
    expect(v10.length).toBeGreaterThan(0);
    expect(v10[0].level).toBe("warning");
  });

  it("V11: write/read path with no flow connection -> error", () => {
    const ast = minimalAST({
      nodes: [
        { id: "orchestrator", type: "orchestrator", label: "O", model: "opus", handles: ["intake"] },
        { id: "intake", type: "action", label: "I" },
        { id: "writer-agent", type: "agent", label: "W", model: "opus", writes: ["shared-data"] },
        { id: "reader-agent", type: "agent", label: "R", model: "opus", reads: ["shared-data"] },
      ],
      edges: [
        // writer and reader are NOT connected in flow
        { from: "intake", to: "writer-agent", condition: null, maxIterations: null },
        { from: "intake", to: "reader-agent", condition: null, maxIterations: null },
      ],
    });
    const results = validate(ast);
    const v11 = results.filter((r) => r.rule === "V11");
    expect(v11.length).toBeGreaterThan(0);
  });

  it("V12: edge annotation with max before when -> error", () => {
    const src = `
topology test-v12 : [pipeline] {
  meta {
    version: "1.0.0"
  }
  orchestrator {
    model: sonnet
    handles {
      intake
    }
    outputs {
      decision { pass, fail }
    }
  }
  action intake {}
  agent worker {
    model: sonnet
  }
  flow {
    intake -> worker [max 3, when orchestrator.decision == pass]
  }
}`;
    const ast = parse(src);
    const results = validate(ast);
    const v12 = results.filter((r) => r.rule === "V12");
    expect(v12.length).toBeGreaterThan(0);
    expect(v12[0].level).toBe("error");
    expect(v12[0].message).toContain("max");
    expect(v12[0].message).toContain("when");
  });

  it("V13: gate references undeclared node -> error", () => {
    const ast = minimalAST({
      nodes: [
        { id: "orchestrator", type: "orchestrator", label: "O", model: "opus", handles: ["intake"] },
        { id: "intake", type: "action", label: "I" },
        { id: "bad-gate", type: "gate", label: "Bad Gate", after: "nonexistent" },
      ],
      edges: [{ from: "intake", to: "intake", condition: null, maxIterations: null }],
    });
    const results = validate(ast);
    const v13 = results.filter((r) => r.rule === "V13");
    expect(v13.length).toBeGreaterThan(0);
    expect(v13[0].message).toContain("nonexistent");
  });

  it("V14: tools AND disallowed-tools on same agent -> error", () => {
    const ast = minimalAST({
      nodes: [
        { id: "orchestrator", type: "orchestrator", label: "O", model: "opus", handles: ["intake"] },
        { id: "intake", type: "action", label: "I" },
        { id: "conflicted", type: "agent", label: "C", model: "opus", tools: ["Read"], disallowedTools: ["Bash"] },
      ],
      edges: [{ from: "intake", to: "conflicted", condition: null, maxIterations: null }],
    });
    const results = validate(ast);
    const v14 = results.filter((r) => r.rule === "V14");
    expect(v14.length).toBeGreaterThan(0);
  });

  it("V15: incomplete conditional coverage -> error", () => {
    const ast = minimalAST({
      nodes: [
        { id: "orchestrator", type: "orchestrator", label: "O", model: "opus", handles: ["intake"], outputs: { decision: ["yes", "no", "maybe"] } },
        { id: "intake", type: "action", label: "I" },
        { id: "a", type: "agent", label: "A", model: "opus" },
        { id: "b", type: "agent", label: "B", model: "opus" },
      ],
      edges: [
        { from: "intake", to: "orchestrator", condition: null, maxIterations: null },
        // Only covers "yes" and "no", missing "maybe"
        { from: "orchestrator", to: "a", condition: "orchestrator.decision == yes", maxIterations: null },
        { from: "orchestrator", to: "b", condition: "orchestrator.decision == no", maxIterations: null },
      ],
    });
    const results = validate(ast);
    const v15 = results.filter((r) => r.rule === "V15");
    expect(v15.length).toBeGreaterThan(0);
    expect(v15[0].message).toContain("maybe");
  });

  it("V16: literal API key (not ${ENV_VAR}) -> error", () => {
    const ast = minimalAST({
      providers: [
        { name: "anthropic", apiKey: "sk-literal-key-123", models: ["opus"], extra: {} },
      ],
    });
    const results = validate(ast);
    const v16 = results.filter((r) => r.rule === "V16");
    expect(v16.length).toBeGreaterThan(0);
  });

  it("V17: multiple default providers -> error", () => {
    const ast = minimalAST({
      providers: [
        { name: "anthropic", apiKey: "${KEY1}", models: ["opus"], default: true, extra: {} },
        { name: "openai", apiKey: "${KEY2}", models: ["gpt-4o"], default: true, extra: {} },
      ],
    });
    const results = validate(ast);
    const v17 = results.filter((r) => r.rule === "V17");
    expect(v17.length).toBeGreaterThan(0);
  });

  it("V18: model not in any provider -> warning", () => {
    const ast = minimalAST({
      nodes: [
        { id: "orchestrator", type: "orchestrator", label: "O", model: "opus", handles: ["intake"] },
        { id: "intake", type: "action", label: "I" },
        { id: "worker", type: "agent", label: "W", model: "unknown-model" },
      ],
      edges: [{ from: "intake", to: "worker", condition: null, maxIterations: null }],
      providers: [
        { name: "anthropic", apiKey: "${KEY}", models: ["opus", "sonnet"], extra: {} },
      ],
    });
    const results = validate(ast);
    const v18 = results.filter((r) => r.rule === "V18");
    expect(v18.length).toBeGreaterThan(0);
    expect(v18[0].level).toBe("warning");
  });

  it("V19: duplicate provider names -> error", () => {
    const ast = minimalAST({
      providers: [
        { name: "anthropic", apiKey: "${KEY1}", models: ["opus"], extra: {} },
        { name: "anthropic", apiKey: "${KEY2}", models: ["sonnet"], extra: {} },
      ],
    });
    const results = validate(ast);
    const v19 = results.filter((r) => r.rule === "V19");
    expect(v19.length).toBeGreaterThan(0);
  });

  it("V20: schedule job referencing undeclared agent -> error", () => {
    const ast = minimalAST({
      schedules: [
        { id: "bad-job", cron: "*/5 * * * *", agent: "nonexistent", enabled: true },
      ],
    });
    const results = validate(ast);
    const v20 = results.filter((r) => r.rule === "V20");
    expect(v20.length).toBeGreaterThan(0);
    expect(v20[0].message).toContain("nonexistent");
  });

  it("V20: schedule job with both cron and every -> error", () => {
    const ast = minimalAST({
      schedules: [
        { id: "dual-job", cron: "*/5 * * * *", every: "monday 3:00", agent: "worker", enabled: true },
      ],
    });
    const results = validate(ast);
    const v20 = results.filter((r) => r.rule === "V20");
    expect(v20.length).toBeGreaterThan(0);
    expect(v20[0].message).toContain("mutually exclusive");
  });

  it("V21: interface with literal webhook -> error", () => {
    const ast = minimalAST({
      interfaces: [
        { id: "slack", type: "webhook", config: { webhook: "https://hooks.slack.com/literal" } },
      ],
    });
    const results = validate(ast);
    const v21 = results.filter((r) => r.rule === "V21");
    expect(v21.length).toBeGreaterThan(0);
    expect(v21[0].message).toContain("literal");
  });

  it("V21: interface with ${ENV_VAR} webhook -> pass", () => {
    const ast = minimalAST({
      interfaces: [
        { id: "slack", type: "webhook", config: { webhook: "${SLACK_WEBHOOK}" } },
      ],
    });
    const results = validate(ast);
    const v21 = results.filter((r) => r.rule === "V21");
    expect(v21).toHaveLength(0);
  });

  it("V21: interface with literal token -> error", () => {
    const ast = minimalAST({
      interfaces: [
        { id: "api-gateway", type: "http", config: { token: "sk-abc123" } },
      ],
    });
    const results = validate(ast);
    const v21 = results.filter((r) => r.rule === "V21");
    expect(v21.length).toBeGreaterThan(0);
    expect(v21[0].message).toContain("literal");
    expect(v21[0].message).toContain("token");
  });

  it("V21: interface with ${ENV_VAR} token -> pass", () => {
    const ast = minimalAST({
      interfaces: [
        { id: "api-gateway", type: "http", config: { token: "${API_TOKEN}" } },
      ],
    });
    const results = validate(ast);
    const v21 = results.filter((r) => r.rule === "V21");
    expect(v21).toHaveLength(0);
  });

  it("V22: fallback-chain model not in provider -> warning", () => {
    const ast = minimalAST({
      nodes: [
        { id: "orchestrator", type: "orchestrator", label: "O", model: "opus", handles: ["intake"] },
        { id: "intake", type: "action", label: "I" },
        { id: "worker", type: "agent", label: "W", model: "opus", fallbackChain: ["sonnet", "unknown-model"] },
      ],
      edges: [{ from: "intake", to: "worker", condition: null, maxIterations: null }],
      providers: [
        { name: "anthropic", apiKey: "${KEY}", models: ["opus", "sonnet"], extra: {} },
      ],
    });
    const results = validate(ast);
    const v22 = results.filter((r) => r.rule === "V22");
    expect(v22.length).toBeGreaterThan(0);
    expect(v22[0].level).toBe("warning");
    expect(v22[0].message).toContain("unknown-model");
  });

  it("V26: action with invalid kind -> error", () => {
    const ast = minimalAST({
      nodes: [
        { id: "orchestrator", type: "orchestrator", label: "O", model: "opus", handles: ["do-stuff"] },
        { id: "do-stuff", type: "action", label: "Do Stuff", kind: "banana" },
        { id: "worker", type: "agent", label: "W", model: "sonnet" },
      ],
      edges: [{ from: "do-stuff", to: "worker", condition: null, maxIterations: null }],
    });
    const results = validate(ast);
    const v26 = results.filter((r) => r.rule === "V26");
    expect(v26.length).toBeGreaterThan(0);
    expect(v26[0].level).toBe("error");
    expect(v26[0].message).toContain("banana");
  });

  it("V26: action with valid kind -> pass", () => {
    const ast = minimalAST({
      nodes: [
        { id: "orchestrator", type: "orchestrator", label: "O", model: "opus", handles: ["do-stuff"] },
        { id: "do-stuff", type: "action", label: "Do Stuff", kind: "external" },
        { id: "worker", type: "agent", label: "W", model: "sonnet" },
      ],
      edges: [{ from: "do-stuff", to: "worker", condition: null, maxIterations: null }],
    });
    const results = validate(ast);
    const v26 = results.filter((r) => r.rule === "V26");
    expect(v26).toHaveLength(0);
  });

  it("V27: agent with unrecognized permissions -> warning", () => {
    const ast = minimalAST({
      nodes: [
        { id: "orchestrator", type: "orchestrator", label: "O", model: "opus", handles: ["intake"] },
        { id: "intake", type: "action", label: "I" },
        { id: "worker", type: "agent", label: "W", model: "sonnet", permissions: "yolo" },
      ],
      edges: [{ from: "intake", to: "worker", condition: null, maxIterations: null }],
    });
    const results = validate(ast);
    const v27 = results.filter((r) => r.rule === "V27");
    expect(v27.length).toBeGreaterThan(0);
    expect(v27[0].level).toBe("warning");
    expect(v27[0].message).toContain("yolo");
  });

  it("V27: agent with valid permissions -> pass", () => {
    const ast = minimalAST({
      nodes: [
        { id: "orchestrator", type: "orchestrator", label: "O", model: "opus", handles: ["intake"] },
        { id: "intake", type: "action", label: "I" },
        { id: "worker", type: "agent", label: "W", model: "sonnet", permissions: "plan" },
      ],
      edges: [{ from: "intake", to: "worker", condition: null, maxIterations: null }],
    });
    const results = validate(ast);
    const v27 = results.filter((r) => r.rule === "V27");
    expect(v27).toHaveLength(0);
  });

  it("V7: orchestrator without model -> error (C05)", () => {
    const ast = minimalAST({
      nodes: [
        { id: "orchestrator", type: "orchestrator", label: "O", model: "", handles: ["intake"] },
        { id: "intake", type: "action", label: "I" },
        { id: "worker", type: "agent", label: "W", model: "sonnet" },
      ],
      edges: [{ from: "intake", to: "worker", condition: null, maxIterations: null }],
    });
    const results = validate(ast);
    const v7 = results.filter((r) => r.rule === "V7" && r.message.includes("Orchestrator"));
    expect(v7.length).toBeGreaterThan(0);
    expect(v7[0].level).toBe("error");
  });

  it("V28: metering with invalid format -> error", () => {
    const ast = minimalAST({
      metering: { track: ["tokens-in"], per: ["agent"], output: "metrics/", format: "xml", pricing: "anthropic-current" },
    });
    const results = validate(ast);
    const v28 = results.filter((r) => r.rule === "V28");
    expect(v28.length).toBeGreaterThan(0);
    expect(v28[0].level).toBe("error");
    expect(v28[0].message).toContain("xml");
  });

  it("V28: metering with valid format -> pass", () => {
    const ast = minimalAST({
      metering: { track: ["tokens-in"], per: ["agent"], output: "metrics/", format: "jsonl", pricing: "anthropic-current" },
    });
    const results = validate(ast);
    const v28 = results.filter((r) => r.rule === "V28");
    expect(v28).toHaveLength(0);
  });

  it("V29: metering with unrecognized pricing -> warning", () => {
    const ast = minimalAST({
      metering: { track: ["tokens-in"], per: ["agent"], output: "metrics/", format: "json", pricing: "free-tier" },
    });
    const results = validate(ast);
    const v29 = results.filter((r) => r.rule === "V29");
    expect(v29.length).toBeGreaterThan(0);
    expect(v29[0].level).toBe("warning");
    expect(v29[0].message).toContain("free-tier");
  });

  it("V29: metering with valid pricing -> pass", () => {
    const ast = minimalAST({
      metering: { track: ["tokens-in"], per: ["agent"], output: "metrics/", format: "json", pricing: "none" },
    });
    const results = validate(ast);
    const v29 = results.filter((r) => r.rule === "V29");
    expect(v29).toHaveLength(0);
  });

  it("valid topology -> 0 errors", () => {
    const ast = minimalAST();
    const results = validate(ast);
    const errors = results.filter((r) => r.level === "error");
    expect(errors).toHaveLength(0);
  });
});

// =========================================================================
// D. Integration tests
// =========================================================================

describe("Integration: example files", () => {
  it("parses simple-pipeline.at", () => {
    const src = readFileSync(resolve(examplesDir, "simple-pipeline.at"), "utf-8");
    const ast = parse(src);
    expect(ast.topology.name).toBe("simple-pipeline");
    expect(ast.topology.patterns).toEqual(["pipeline", "human-gate"]);
    expect(ast.topology.version).toBe("1.0.0");

    // Check nodes
    const orch = ast.nodes.find((n) => n.type === "orchestrator") as OrchestratorNode;
    expect(orch).toBeDefined();
    expect(orch.model).toBe("sonnet");
    expect(orch.handles).toEqual(["intake", "done"]);

    const researcher = ast.nodes.find((n) => n.id === "researcher") as AgentNode;
    expect(researcher).toBeDefined();
    expect(researcher.model).toBe("gpt-4o");
    expect(researcher.phase).toBe(1);
    expect(researcher.tools).toEqual(["Read", "Grep", "Glob", "WebSearch"]);
    expect(researcher.prompt).toContain("research specialist");

    // Check roles
    expect(ast.roles["researcher"]).toBeDefined();
    expect(ast.roles["writer"]).toBeDefined();
    expect(ast.roles["reviewer"]).toBeDefined();

    // Check flow
    expect(ast.edges.length).toBeGreaterThanOrEqual(5);

    // Check gate
    const gate = ast.nodes.find((n) => n.id === "quality-check") as GateNode;
    expect(gate).toBeDefined();
    expect(gate.after).toBe("writer");
    expect(gate.before).toBe("reviewer");

    // Validation
    const results = validate(ast);
    const errors = results.filter((r) => r.level === "error");
    expect(errors).toHaveLength(0);
  });

  it("parses code-review.at", () => {
    const src = readFileSync(resolve(examplesDir, "code-review.at"), "utf-8");
    const ast = parse(src);
    expect(ast.topology.name).toBe("code-review");
    expect(ast.topology.patterns).toContain("fan-out");

    // Check fan-out in flow
    const fanOutEdges = ast.edges.filter((e) => e.from === "intake");
    expect(fanOutEdges).toHaveLength(2);
    const fanOutTargets = fanOutEdges.map((e) => e.to).sort();
    expect(fanOutTargets).toEqual(["analyzer", "security-scanner"]);

    // Check advisory behavior
    const scanner = ast.nodes.find((n) => n.id === "security-scanner") as AgentNode;
    expect(scanner.behavior).toBe("advisory");

    // Check hooks
    expect(ast.hooks.length).toBeGreaterThan(0);

    const results = validate(ast);
    const errors = results.filter((r) => r.level === "error");
    expect(errors).toHaveLength(0);
  });

  it("parses data-processing.at", () => {
    const src = readFileSync(resolve(examplesDir, "data-processing.at"), "utf-8");
    const ast = parse(src);
    expect(ast.topology.name).toBe("data-processing");

    // Check tools
    expect(ast.toolDefs.length).toBeGreaterThanOrEqual(4);
    const extractPdf = ast.toolDefs.find((t) => t.id === "extract-pdf");
    expect(extractPdf).toBeDefined();
    expect(extractPdf!.lang).toBe("python");

    // Check skills
    expect(ast.skills.length).toBeGreaterThanOrEqual(2);

    // Check scale
    const extractor = ast.nodes.find((n) => n.id === "extractor") as AgentNode;
    expect(extractor.scale).toBeDefined();
    expect(extractor.scale!.mode).toBe("auto");
    expect(extractor.scale!.max).toBe(8);
    expect(extractor.background).toBe(true);

    // Check batch
    expect(ast.batch["parallel"]).toBe(true);

    // Check metering
    expect(ast.metering).not.toBeNull();
    expect(ast.metering!.format).toBe("jsonl");

    // Check environments
    expect(ast.environments["development"]).toBeDefined();
    expect(ast.environments["production"]).toBeDefined();

    // Check MCP servers
    expect(ast.mcpServers["storage"]).toBeDefined();
    expect(ast.mcpServers["monitoring"]).toBeDefined();

    const results = validate(ast);
    const errors = results.filter((r) => r.level === "error");
    expect(errors).toHaveLength(0);
  });

  it("parses openclaw-assistant.at", () => {
    const src = readFileSync(resolve(examplesDir, "openclaw-assistant.at"), "utf-8");
    const ast = parse(src);
    expect(ast.topology.name).toBe("personal-assistant");
    expect(ast.topology.domain).toBe('"productivity"');

    // Check conditional routing
    const routeEdges = ast.edges.filter((e) => e.from === "route");
    expect(routeEdges).toHaveLength(4);
    const conditions = routeEdges.map((e) => e.condition).sort();
    expect(conditions).toContain("orchestrator.task-type == research");
    expect(conditions).toContain("orchestrator.task-type == write");

    // Check extensions on agent
    const scheduler = ast.nodes.find((n) => n.id === "scheduler") as AgentNode;
    expect(scheduler.extensions).toBeDefined();
    expect(scheduler.extensions!["openclaw"]).toBeDefined();

    // Check providers
    expect(ast.providers).toHaveLength(1);
    expect(ast.providers[0].name).toBe("anthropic");
    expect(ast.providers[0].default).toBe(true);

    // Check max-turns
    const researcher = ast.nodes.find((n) => n.id === "researcher") as AgentNode;
    expect(researcher.maxTurns).toBe(15);

    // Check description field
    expect(researcher.description).toContain("Research agent");

    const results = validate(ast);
    const errors = results.filter((r) => r.level === "error");
    expect(errors).toHaveLength(0);
  });

  it("parses scheduled-monitor.at", () => {
    const src = readFileSync(resolve(examplesDir, "scheduled-monitor.at"), "utf-8");
    const ast = parse(src);
    expect(ast.topology.name).toBe("scheduled-monitor");
    expect(ast.topology.patterns).toContain("pipeline");
    expect(ast.topology.patterns).toContain("fan-out");

    // Check schedule
    expect(ast.schedules).toHaveLength(3);
    const healthCheck = ast.schedules.find((j) => j.id === "health-check");
    expect(healthCheck).toBeDefined();
    expect(healthCheck!.cron).toBe("*/15 * * * *");
    expect(healthCheck!.agent).toBe("collector");

    const weeklyDeep = ast.schedules.find((j) => j.id === "weekly-deep-scan");
    expect(weeklyDeep).toBeDefined();
    expect(weeklyDeep!.every).toBe("monday 3:00");
    expect(weeklyDeep!.enabled).toBe(true);

    // Check interfaces
    expect(ast.interfaces).toHaveLength(3);
    const slack = ast.interfaces.find((i) => i.id === "slack");
    expect(slack).toBeDefined();
    expect(slack!.type).toBe("webhook");
    expect(slack!.config["webhook"]).toBe("${SLACK_MONITORING_WEBHOOK}");

    const dashboard = ast.interfaces.find((i) => i.id === "dashboard");
    expect(dashboard).toBeDefined();
    expect(dashboard!.type).toBe("http");
    expect(dashboard!.config["port"]).toBe(3000);

    // Check sandbox on agent
    const collector = ast.nodes.find((n) => n.id === "collector") as AgentNode;
    expect(collector.sandbox).toBe("docker");

    const reporter = ast.nodes.find((n) => n.id === "reporter") as AgentNode;
    expect(reporter.sandbox).toBe(true);

    // Check fallback-chain on agent
    const analyzer = ast.nodes.find((n) => n.id === "analyzer") as AgentNode;
    expect(analyzer.fallbackChain).toEqual(["sonnet", "haiku"]);

    // Check settings-level sandbox and fallback-chain
    expect(ast.settings["sandbox"]).toBe("docker");
    expect(ast.settings["fallbackChain"]).toEqual(["opus", "sonnet", "haiku"]);

    // Validation
    const results = validate(ast);
    const errors = results.filter((r) => r.level === "error");
    expect(errors).toHaveLength(0);
  });

  it("parses with syntax errors -> throws", () => {
    expect(() => parse("not a valid topology")).toThrow();
  });
});

// =========================================================================
// E. Edge cases
// =========================================================================

describe("Edge cases", () => {
  it("inline comments are stripped from agent model", () => {
    const src = `topology t : [pipeline] {\n  orchestrator { model: opus\n    handles: [a] }\n  action a { kind: inline }\n  agent worker {\n    model: opus  # main model\n    tools: [Read, Write]  # core tools\n  }\n  flow { a -> worker }\n}`;
    const ast = parse(src);
    const agent = ast.nodes.find((n) => n.id === "worker") as AgentNode;
    expect(agent.model).toBe("opus");
    expect(agent.tools).toEqual(["Read", "Write"]);
  });

  it("prompt blocks with # characters inside are preserved", () => {
    const src = `topology t : [pipeline] {\n  orchestrator { model: opus\n    handles: [a] }\n  action a { kind: inline }\n  agent writer {\n    model: opus\n    prompt {\n      # Step 1: Research\n      Do research.\n      # Step 2: Write\n      Write content.\n    }\n  }\n  flow { a -> writer }\n}`;
    const ast = parse(src);
    const agent = ast.nodes.find((n) => n.id === "writer") as AgentNode;
    expect(agent.prompt).toContain("# Step 1: Research");
    expect(agent.prompt).toContain("# Step 2: Write");
  });

  it("nested braces in prompt blocks", () => {
    const src = `topology t : [pipeline] {\n  orchestrator { model: opus\n    handles: [a] }\n  action a { kind: inline }\n  agent coder {\n    model: opus\n    prompt {\n      Output JSON like:\n      { "key": { "nested": true } }\n    }\n  }\n  flow { a -> coder }\n}`;
    const ast = parse(src);
    const agent = ast.nodes.find((n) => n.id === "coder") as AgentNode;
    expect(agent.prompt).toContain('"key"');
  });

  it("agent with decimal phase numbers", () => {
    const src = `topology t : [pipeline] {\n  orchestrator { model: opus\n    handles: [a] }\n  action a { kind: inline }\n  agent precise {\n    model: opus\n    phase: 4.5\n  }\n  flow { a -> precise }\n}`;
    const ast = parse(src);
    const agent = ast.nodes.find((n) => n.id === "precise") as AgentNode;
    expect(agent.phase).toBe(4.5);
  });

  it("multiple agents with same phase number", () => {
    const src = `topology t : [pipeline] {\n  orchestrator { model: opus\n    handles: [a] }\n  action a { kind: inline }\n  agent p1 {\n    model: opus\n    phase: 1\n  }\n  agent p2 {\n    model: opus\n    phase: 1\n  }\n  flow { a -> [p1, p2] }\n}`;
    const ast = parse(src);
    const p1 = ast.nodes.find((n) => n.id === "p1") as AgentNode;
    const p2 = ast.nodes.find((n) => n.id === "p2") as AgentNode;
    expect(p1.phase).toBe(1);
    expect(p2.phase).toBe(1);
  });

  it("gate with only after (no before)", () => {
    const src = `topology t : [pipeline] {\n  orchestrator { model: opus\n    handles: [a] }\n  action a { kind: inline }\n  agent b { model: opus }\n  gates {\n    gate after-only {\n      after: b\n      run: "check.sh"\n    }\n  }\n  flow { a -> b }\n}`;
    const ast = parse(src);
    const gate = ast.nodes.find((n) => n.id === "after-only") as GateNode;
    expect(gate.after).toBe("b");
    expect(gate.before).toBeUndefined();
  });

  it("hook with only on and run (minimal)", () => {
    const src = `topology t : [pipeline] {\n  orchestrator { model: opus\n    handles: [a] }\n  action a { kind: inline }\n  flow { a -> a }\n  hooks {\n    hook minimal {\n      on: Stop\n      run: "cleanup.sh"\n    }\n  }\n}`;
    const ast = parse(src);
    expect(ast.hooks).toHaveLength(1);
    expect(ast.hooks[0].name).toBe("minimal");
    expect(ast.hooks[0].on).toBe("Stop");
    expect(ast.hooks[0].run).toBe("cleanup.sh");
    expect(ast.hooks[0].type).toBeUndefined();
    expect(ast.hooks[0].timeout).toBeUndefined();
  });

  it("empty sections produce reasonable defaults", () => {
    const src = `topology t : [pipeline] {\n  orchestrator { model: opus\n    handles: [a] }\n  action a { kind: inline }\n  flow { a -> a }\n  memory {\n  }\n  settings {\n  }\n}`;
    const ast = parse(src);
    expect(ast.memory).toEqual({});
    expect(ast.settings).toEqual({ allow: [], deny: [], ask: [] });
  });

  it("extremely long prompt block", () => {
    const longContent = "This is a very long line. ".repeat(500);
    const src = `topology t : [pipeline] {\n  orchestrator { model: opus\n    handles: [a] }\n  action a { kind: inline }\n  agent verbose {\n    model: opus\n    prompt {\n      ${longContent}\n    }\n  }\n  flow { a -> verbose }\n}`;
    const ast = parse(src);
    const agent = ast.nodes.find((n) => n.id === "verbose") as AgentNode;
    expect(agent.prompt).toBeDefined();
    expect(agent.prompt!.length).toBeGreaterThan(1000);
  });

  it("flow with combined [when x.y == z, max 3]", () => {
    const src = `topology t : [pipeline] {\n  orchestrator { model: opus\n    handles: [a] }\n  action a { kind: inline }\n  agent b { model: opus\n    outputs { status: pass | fail } }\n  agent c { model: opus }\n  flow {\n    c -> b [when b.status == fail, max 3]\n  }\n}`;
    const ast = parse(src);
    const edge = ast.edges.find((e) => e.from === "c" && e.to === "b");
    expect(edge).toBeDefined();
    expect(edge!.condition).toBe("b.status == fail");
    expect(edge!.maxIterations).toBe(3);
  });
});

// =========================================================================
// F. Negative / error path tests
// =========================================================================

describe("Parse errors (should throw)", () => {
  it("throws on unclosed brace", () => {
    expect(() =>
      parse("topology foo : [pipeline] { agent bar { model: opus ")
    ).toThrow();
  });

  it("throws on missing topology keyword", () => {
    expect(() => parse("agent bar { model: opus }")).toThrow();
  });

  it("throws on empty file", () => {
    expect(() => parse("")).toThrow();
  });

  it("throws on only comments", () => {
    expect(() => parse("# just a comment")).toThrow();
  });

  it("throws on malformed topology header (missing name)", () => {
    expect(() => parse("topology : [pipeline] {")).toThrow();
  });
});

// =========================================================================
// G. Validation errors (parse succeeds, validate returns errors)
// =========================================================================

describe("Validation errors", () => {
  it("V1 UniqueNames: two agents with the same id", () => {
    const src = `topology t : [pipeline] {
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  agent dup { model: opus }
  agent dup { model: sonnet }
  flow { a -> dup }
}`;
    const ast = parse(src);
    const results = validate(ast);
    const v1 = results.filter((r) => r.rule === "V1" && r.level === "error");
    expect(v1.length).toBeGreaterThanOrEqual(1);
    expect(v1[0].message).toContain("dup");
  });

  it("V3 FlowReferences: flow edge referencing a non-existent node", () => {
    const src = `topology t : [pipeline] {
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  agent real { model: opus }
  flow { a -> ghost }
}`;
    const ast = parse(src);
    const results = validate(ast);
    const v3 = results.filter((r) => r.rule === "V3" && r.level === "error");
    expect(v3.length).toBeGreaterThanOrEqual(1);
    expect(v3[0].message).toContain("ghost");
  });

  it("V14 ToolExclusivity: agent with both tools and disallowed-tools", () => {
    const src = `topology t : [pipeline] {
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  agent confused {
    model: opus
    tools: [Read, Write]
    disallowed-tools: [Bash]
  }
  flow { a -> confused }
}`;
    const ast = parse(src);
    const results = validate(ast);
    const v14 = results.filter((r) => r.rule === "V14" && r.level === "error");
    expect(v14.length).toBeGreaterThanOrEqual(1);
    expect(v14[0].message).toContain("confused");
  });

  it("V6 LoopBound: back-edge without max N annotation", () => {
    const src = `topology t : [pipeline] {
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  agent step1 { model: opus }
  agent step2 { model: opus }
  flow {
    a -> step1
    step1 -> step2
    step2 -> step1
  }
}`;
    const ast = parse(src);
    const results = validate(ast);
    const v6 = results.filter((r) => r.rule === "V6" && r.level === "error");
    expect(v6.length).toBeGreaterThanOrEqual(1);
    expect(v6[0].message).toContain("max");
  });

  it("V6 NoSelfEdges: self-referencing edge without max bound", () => {
    const src = `topology t : [pipeline] {
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  agent analyzer { model: opus }
  flow {
    a -> analyzer
    analyzer -> analyzer
  }
}`;
    const ast = parse(src);
    const results = validate(ast);
    const v6 = results.filter((r) => r.rule === "V6" && r.level === "error");
    expect(v6.length).toBeGreaterThanOrEqual(1);
    expect(v6[0].message).toContain("analyzer");
  });

  it("V13 GateAnchors: gate with after referencing non-existent node", () => {
    const src = `topology t : [pipeline] {
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  agent worker { model: opus }
  gates {
    gate check {
      after: nonexistent
      run: "lint.sh"
    }
  }
  flow { a -> worker }
}`;
    const ast = parse(src);
    const results = validate(ast);
    const v13 = results.filter((r) => r.rule === "V13" && r.level === "error");
    expect(v13.length).toBeGreaterThanOrEqual(1);
    expect(v13[0].message).toContain("nonexistent");
  });
});

// =========================================================================
// H. Validation warnings
// =========================================================================

describe("Validation warnings", () => {
  it("V18 ModelNotInProvider: agent uses model not listed in any provider", () => {
    const src = `topology t : [pipeline] {
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  agent worker {
    model: mystery-model
  }
  providers {
    anthropic {
      api-key: \${ANTHROPIC_API_KEY}
      models: [opus, sonnet, haiku]
    }
  }
  flow { a -> worker }
}`;
    const ast = parse(src);
    const results = validate(ast);
    const v18 = results.filter((r) => r.rule === "V18" && r.level === "warning");
    expect(v18.length).toBeGreaterThanOrEqual(1);
    expect(v18[0].message).toContain("mystery-model");
  });

  it("V22 FallbackNotInProvider: fallback chain model not in provider", () => {
    const src = `topology t : [pipeline] {
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  agent worker {
    model: opus
    fallback-chain: [sonnet, unknown-model]
  }
  providers {
    anthropic {
      api-key: \${ANTHROPIC_API_KEY}
      models: [opus, sonnet]
    }
  }
  flow { a -> worker }
}`;
    const ast = parse(src);
    const results = validate(ast);
    const v22 = results.filter((r) => r.rule === "V22" && r.level === "warning");
    expect(v22.length).toBeGreaterThanOrEqual(1);
    expect(v22[0].message).toContain("unknown-model");
  });
});

// =========================================================================
// I. Edge cases that should NOT throw
// =========================================================================

describe("Edge cases that should NOT throw", () => {
  it("agent with no tools parses fine", () => {
    const src = `topology t : [pipeline] {
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  agent bare { model: opus }
  flow { a -> bare }
}`;
    const ast = parse(src);
    const agent = ast.nodes.find((n) => n.id === "bare") as AgentNode;
    expect(agent).toBeDefined();
    expect(agent.tools).toBeUndefined();
  });

  it("agent with empty prompt block", () => {
    const src = `topology t : [pipeline] {
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  agent empty-prompt {
    model: opus
    prompt {}
  }
  flow { a -> empty-prompt }
}`;
    const ast = parse(src);
    const agent = ast.nodes.find((n) => n.id === "empty-prompt") as AgentNode;
    expect(agent).toBeDefined();
    expect(agent.prompt).toBeDefined();
  });

  it("flow with no conditions (all unconditional edges)", () => {
    const src = `topology t : [pipeline] {
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  agent s1 { model: opus }
  agent s2 { model: opus }
  agent s3 { model: opus }
  flow {
    a -> s1
    s1 -> s2
    s2 -> s3
  }
}`;
    const ast = parse(src);
    expect(ast.edges.length).toBe(3);
    for (const edge of ast.edges) {
      expect(edge.condition).toBeNull();
    }
  });

  it("topology with no agents (just an orchestrator)", () => {
    const src = `topology t : [pipeline] {
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  flow { a -> a }
}`;
    const ast = parse(src);
    const agents = ast.nodes.filter((n) => n.type === "agent");
    expect(agents).toHaveLength(0);
    expect(ast.topology.name).toBe("t");
  });
});

// =========================================================================
// J. Phase 2 edge cases
// =========================================================================

describe("Lexer", () => {
  describe("stripComments — Phase 2 edge cases", () => {
    it("# at end of line with no space before it is NOT a comment (e.g. color:#ff0000)", () => {
      const src = `color:#ff0000`;
      const result = stripComments(src);
      expect(result).toBe(`color:#ff0000`);
    });

    it("multiple # on one line: only the first outside-quote one is the comment start", () => {
      const src = `value: something  # comment with # inside`;
      const result = stripComments(src);
      expect(result).toBe(`value: something`);
    });

    it("empty line with only # should be stripped", () => {
      const src = `foo\n#\nbar`;
      const result = stripComments(src);
      expect(result).toBe(`foo\n\nbar`);
    });

    it("inline comment after a bracket list: tools: [Read, Write]  # core", () => {
      const src = `tools: [Read, Write]  # core`;
      const result = stripComments(src);
      expect(result).toBe(`tools: [Read, Write]`);
    });
  });
});

describe("Validator — V12 edge attribute order (Phase 2)", () => {
  it("valid order [when x.y == pass, max 3] should produce no V12 error", () => {
    const src = `
topology test-v12-valid : [pipeline] {
  orchestrator {
    model: sonnet
    handles { intake }
    outputs { decision { pass, fail } }
  }
  action intake {}
  agent worker { model: sonnet }
  flow {
    intake -> worker [when orchestrator.decision == pass, max 3]
  }
}`;
    const ast = parse(src);
    const results = validate(ast);
    const v12 = results.filter((r) => r.rule === "V12");
    expect(v12).toHaveLength(0);
  });

  it("invalid order [max 3, when x.y == pass] should produce V12 error", () => {
    const src = `
topology test-v12-invalid : [pipeline] {
  orchestrator {
    model: sonnet
    handles { intake }
    outputs { decision { pass, fail } }
  }
  action intake {}
  agent worker { model: sonnet }
  flow {
    intake -> worker [max 3, when orchestrator.decision == pass]
  }
}`;
    const ast = parse(src);
    const results = validate(ast);
    const v12 = results.filter((r) => r.rule === "V12");
    expect(v12.length).toBeGreaterThan(0);
    expect(v12[0].level).toBe("error");
  });

  it("[max 3] alone (no when) should produce no V12 error", () => {
    const src = `
topology test-v12-maxonly : [pipeline] {
  orchestrator { model: sonnet handles: [intake] }
  action intake {}
  agent worker { model: sonnet }
  flow {
    intake -> worker [max 3]
  }
}`;
    const ast = parse(src);
    const results = validate(ast);
    const v12 = results.filter((r) => r.rule === "V12");
    expect(v12).toHaveLength(0);
  });

  it("[when x.y == pass] alone (no max) should produce no V12 error", () => {
    const src = `
topology test-v12-whenonly : [pipeline] {
  orchestrator {
    model: sonnet
    handles { intake }
    outputs { decision { pass, fail } }
  }
  action intake {}
  agent worker { model: sonnet }
  flow {
    intake -> worker [when orchestrator.decision == pass]
  }
}`;
    const ast = parse(src);
    const results = validate(ast);
    const v12 = results.filter((r) => r.rule === "V12");
    expect(v12).toHaveLength(0);
  });
});

describe("Flow parsing edge cases (Phase 2)", () => {
  it("chain with 3+ nodes: a -> b -> c -> d produces 3 edges", () => {
    const src = `topology t : [pipeline] {
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  agent b { model: opus }
  agent c { model: opus }
  agent d { model: opus }
  flow {
    a -> b -> c -> d
  }
}`;
    const ast = parse(src);
    expect(ast.edges).toHaveLength(3);
    expect(ast.edges[0]).toEqual({ from: "a", to: "b", condition: null, maxIterations: null, per: null });
    expect(ast.edges[1]).toEqual({ from: "b", to: "c", condition: null, maxIterations: null, per: null });
    expect(ast.edges[2]).toEqual({ from: "c", to: "d", condition: null, maxIterations: null, per: null });
  });

  it("fan-out combined with condition: a -> [b, c] [when x.y == pass]", () => {
    const src = `topology t : [pipeline] {
  orchestrator {
    model: opus
    handles: [a]
    outputs { verdict: pass | fail }
  }
  action a { kind: inline }
  agent b { model: opus }
  agent c { model: opus }
  flow {
    a -> [b, c] [when orchestrator.verdict == pass]
  }
}`;
    const ast = parse(src);
    const edges = ast.edges.filter((e) => e.from === "a");
    expect(edges).toHaveLength(2);
    expect(edges[0].to).toBe("b");
    expect(edges[0].condition).toBe("orchestrator.verdict == pass");
    expect(edges[1].to).toBe("c");
    expect(edges[1].condition).toBe("orchestrator.verdict == pass");
  });

  it("empty flow block produces empty edges array", () => {
    const src = `topology t : [pipeline] {
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  flow {
  }
}`;
    const ast = parse(src);
    expect(ast.edges).toHaveLength(0);
  });

  it("single node (no arrow) produces no edges", () => {
    const src = `topology t : [pipeline] {
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  agent lonely { model: opus invocation: manual }
  flow {
  }
}`;
    const ast = parse(src);
    expect(ast.edges).toHaveLength(0);
  });
});

describe("Role prefix matching (Phase 2)", () => {
  it("agent review-security should get role from review prefix in roles block", () => {
    const src = `topology t : [pipeline] {
  roles {
    review: "Performs reviews"
  }
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  agent review-security {
    model: opus
  }
  flow { a -> review-security }
}`;
    const ast = parse(src);
    const agent = ast.nodes.find((n) => n.id === "review-security") as AgentNode;
    expect(agent).toBeDefined();
    expect(agent.role).toBe("Performs reviews");
  });

  it("exact match should take priority over prefix match", () => {
    const src = `topology t : [pipeline] {
  roles {
    review: "Generic reviewer"
    review-security: "Security reviewer"
  }
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  agent review-security {
    model: opus
  }
  flow { a -> review-security }
}`;
    const ast = parse(src);
    const agent = ast.nodes.find((n) => n.id === "review-security") as AgentNode;
    expect(agent).toBeDefined();
    expect(agent.role).toBe("Security reviewer");
  });

  it("agent with no matching role should have no role field", () => {
    const src = `topology t : [pipeline] {
  roles {
    writer: "Writes content"
  }
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  agent analyzer {
    model: opus
  }
  flow { a -> analyzer }
}`;
    const ast = parse(src);
    const agent = ast.nodes.find((n) => n.id === "analyzer") as AgentNode;
    expect(agent).toBeDefined();
    expect(agent.role).toBeUndefined();
  });
});

// =========================================================================
// Line number tracking
// =========================================================================

describe("Line number tracking", () => {
  it("_sourceMap records line numbers for agents, actions, gates, and orchestrator", () => {
    const src = [
      "topology t : [pipeline] {",       // line 1
      "  orchestrator {",                 // line 2
      "    model: opus",                  // line 3
      "    handles: [a]",                 // line 4
      "  }",                              // line 5
      "  action a {",                     // line 6
      "    kind: inline",                 // line 7
      "  }",                              // line 8
      "  agent worker {",                 // line 9
      "    model: opus",                  // line 10
      "  }",                              // line 11
      "  flow { a -> worker }",           // line 12
      "}",                                // line 13
    ].join("\n");
    const ast = parse(src) as any;
    expect(ast._sourceMap).toBeDefined();
    expect(ast._sourceMap["orchestrator"]).toBe(2);
    expect(ast._sourceMap["a"]).toBe(6);
    expect(ast._sourceMap["worker"]).toBe(9);
  });

  it("V1 duplicate name error includes line number", () => {
    const src = [
      "topology t : [pipeline] {",       // line 1
      "  orchestrator {",                 // line 2
      "    model: opus",                  // line 3
      "    handles: [a]",                 // line 4
      "  }",                              // line 5
      "  action a { kind: inline }",      // line 6
      "  agent dup { model: opus }",      // line 7
      "  agent dup { model: sonnet }",    // line 8
      "  flow { a -> dup }",              // line 9
      "}",                                // line 10
    ].join("\n");
    const ast = parse(src);
    const results = validate(ast);
    const v1 = results.filter((r) => r.rule === "V1" && r.level === "error");
    expect(v1.length).toBeGreaterThanOrEqual(1);
    expect(v1[0].line).toBeDefined();
    // The duplicate "dup" is the second occurrence at line 8
    expect(v1[0].line).toBe(8);
  });

  it("V7 missing model error includes line number", () => {
    const src = [
      "topology t : [pipeline] {",       // line 1
      "  orchestrator {",                 // line 2
      "    model: opus",                  // line 3
      "    handles: [a]",                 // line 4
      "  }",                              // line 5
      "  action a { kind: inline }",      // line 6
      "  agent no-model {",               // line 7
      "    permissions: plan",             // line 8
      "  }",                              // line 9
      "  flow { a -> no-model }",         // line 10
      "}",                                // line 11
    ].join("\n");
    const ast = parse(src);
    const results = validate(ast);
    const v7 = results.filter((r) => r.rule === "V7" && r.level === "error");
    expect(v7.length).toBeGreaterThanOrEqual(1);
    expect(v7[0].line).toBe(7);
    expect(v7[0].node).toBe("no-model");
  });

  it("V25: on-fail bounce-back produces warning", () => {
    const ast = parse(`topology t : [pipeline] {
    orchestrator { model: opus handles: [a] }
    action a { kind: inline }
    agent b { model: opus }
    agent c { model: opus }
    gates {
      gate bb {
        after: b
        before: c
        run: "check.sh"
        on-fail: bounce-back
      }
    }
    flow { a -> b -> c }
  }`);
    const issues = validate(ast);
    const v25 = issues.filter(i => i.rule === "V25");
    expect(v25).toHaveLength(1);
    expect(v25[0].level).toBe("warning");
    expect(v25[0].message).toContain("bounce-back");
  });
});

// =========================================================================
// K. Parser gap fixes (C12, C13, C14)
// =========================================================================

describe("C12: env sub-map inside mcp-servers entries", () => {
  it("parses env block inside an mcp-server entry", () => {
    const src = `topology t : [pipeline] {
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  agent w { model: opus }
  mcp-servers {
    filesystem {
      command: "npx"
      args: ["-y", "@modelcontextprotocol/server-filesystem"]
      env {
        HOME: "/tmp"
        NODE_ENV: "production"
      }
    }
  }
  flow { a -> w }
}`;
    const ast = parse(src);
    expect(ast.mcpServers.filesystem).toBeDefined();
    expect(ast.mcpServers.filesystem.command).toBe("npx");
    expect(ast.mcpServers.filesystem.args).toEqual(["-y", "@modelcontextprotocol/server-filesystem"]);
    expect(ast.mcpServers.filesystem.env).toEqual({
      HOME: "/tmp",
      NODE_ENV: "production",
    });
  });

  it("mcp-server without env block still works", () => {
    const src = `topology t : [pipeline] {
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  agent w { model: opus }
  mcp-servers {
    simple {
      command: "node"
      args: ["server.js"]
    }
  }
  flow { a -> w }
}`;
    const ast = parse(src);
    expect(ast.mcpServers.simple).toBeDefined();
    expect(ast.mcpServers.simple.command).toBe("node");
    expect(ast.mcpServers.simple.env).toBeUndefined();
  });

  it("parses multiple mcp-servers with env blocks", () => {
    const src = `topology t : [pipeline] {
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  agent w { model: opus }
  mcp-servers {
    server-a {
      command: "npx"
      env {
        API_KEY: "abc123"
      }
    }
    server-b {
      url: "http://localhost:3000"
      env {
        TOKEN: "xyz"
      }
    }
  }
  flow { a -> w }
}`;
    const ast = parse(src);
    expect((ast.mcpServers["server-a"].env as Record<string, string>).API_KEY).toBe("abc123");
    expect((ast.mcpServers["server-b"].env as Record<string, string>).TOKEN).toBe("xyz");
  });
});

describe("C13: extensions block inside hook bodies", () => {
  it("parses extensions inside a global hook", () => {
    const src = `topology t : [pipeline] {
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  agent w { model: opus }
  hooks {
    hook lint-check {
      on: PreToolUse
      matcher: "Write"
      run: "eslint --fix"
      type: command
      extensions {
        claude-code {
          priority: 1
        }
      }
    }
  }
  flow { a -> w }
}`;
    const ast = parse(src);
    expect(ast.hooks).toHaveLength(1);
    expect(ast.hooks[0].name).toBe("lint-check");
    expect(ast.hooks[0].extensions).toBeDefined();
    expect(ast.hooks[0].extensions!["claude-code"]).toEqual({ priority: 1 });
  });

  it("parses extensions inside a per-agent hook", () => {
    const src = `topology t : [pipeline] {
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  agent w {
    model: opus
    hooks {
      hook format-check {
        on: PostToolUse
        matcher: "Write"
        run: "prettier --write"
        extensions {
          copilot {
            enabled: true
          }
        }
      }
    }
  }
  flow { a -> w }
}`;
    const ast = parse(src);
    const agent = ast.nodes.find((n) => n.id === "w") as AgentNode;
    expect(agent.hooks).toHaveLength(1);
    expect(agent.hooks![0].extensions).toBeDefined();
    expect(agent.hooks![0].extensions!["copilot"]).toEqual({ enabled: true });
  });

  it("hook without extensions still works", () => {
    const src = `topology t : [pipeline] {
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  agent w { model: opus }
  hooks {
    hook simple {
      on: PreToolUse
      matcher: "Read"
      run: "echo ok"
    }
  }
  flow { a -> w }
}`;
    const ast = parse(src);
    expect(ast.hooks).toHaveLength(1);
    expect(ast.hooks[0].extensions).toBeUndefined();
  });
});

describe("C14: top-level extensions block in topology body", () => {
  it("parses a top-level extensions block", () => {
    const src = `topology t : [pipeline] {
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  agent w { model: opus }
  extensions {
    claude-code {
      max-tokens: 8192
      stream: true
    }
    openclaw {
      runtime: "docker"
    }
  }
  flow { a -> w }
}`;
    const ast = parse(src);
    expect(ast.extensions).toBeDefined();
    expect(ast.extensions!["claude-code"]).toEqual({
      "max-tokens": 8192,
      stream: true,
    });
    expect(ast.extensions!["openclaw"]).toEqual({
      runtime: "docker",
    });
  });

  it("topology without extensions block has no extensions field", () => {
    const src = `topology t : [pipeline] {
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  agent w { model: opus }
  flow { a -> w }
}`;
    const ast = parse(src);
    expect(ast.extensions).toBeUndefined();
  });
});

// =========================================================================
// Wave 1 Task A: Error Handling — timeout, on-fail, structured retry
// =========================================================================

describe("Error Handling (timeout, on-fail, retry block)", () => {

  describe("Parsing", () => {
    it("agent with timeout parses correctly", () => {
      const src = `topology t : [pipeline] {
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  agent w {
    model: sonnet
    timeout: 5m
  }
  flow { a -> w }
}`;
      const ast = parse(src);
      const agent = ast.nodes.find((n) => n.id === "w") as AgentNode;
      expect(agent.timeout).toBe("5m");
    });

    it("agent with on-fail: halt parses correctly", () => {
      const src = `topology t : [pipeline] {
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  agent w {
    model: sonnet
    on-fail: halt
  }
  flow { a -> w }
}`;
      const ast = parse(src);
      const agent = ast.nodes.find((n) => n.id === "w") as AgentNode;
      expect(agent.onFail).toBe("halt");
    });

    it("agent with on-fail: retry parses correctly", () => {
      const src = `topology t : [pipeline] {
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  agent w {
    model: sonnet
    on-fail: retry
  }
  flow { a -> w }
}`;
      const ast = parse(src);
      const agent = ast.nodes.find((n) => n.id === "w") as AgentNode;
      expect(agent.onFail).toBe("retry");
    });

    it("agent with on-fail: skip parses correctly", () => {
      const src = `topology t : [pipeline] {
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  agent w {
    model: sonnet
    on-fail: skip
  }
  flow { a -> w }
}`;
      const ast = parse(src);
      const agent = ast.nodes.find((n) => n.id === "w") as AgentNode;
      expect(agent.onFail).toBe("skip");
    });

    it("agent with on-fail: fallback parses correctly", () => {
      const src = `topology t : [pipeline] {
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  agent w {
    model: sonnet
    on-fail: fallback backup-agent
  }
  agent backup-agent {
    model: haiku
  }
  flow { a -> w }
}`;
      const ast = parse(src);
      const agent = ast.nodes.find((n) => n.id === "w") as AgentNode;
      expect(agent.onFail).toBe("fallback backup-agent");
    });

    it("simple retry: 3 still works (backward compat)", () => {
      const src = `topology t : [pipeline] {
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  agent w {
    model: sonnet
    retry: 3
  }
  flow { a -> w }
}`;
      const ast = parse(src);
      const agent = ast.nodes.find((n) => n.id === "w") as AgentNode;
      expect(agent.retry).toBe(3);
    });

    it("retry block parses all fields", () => {
      const src = `topology t : [pipeline] {
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  agent w {
    model: sonnet
    retry {
      max: 3
      backoff: exponential
      interval: 1s
      max-interval: 60s
      jitter: true
      non-retryable: [auth-error, invalid-input]
    }
  }
  flow { a -> w }
}`;
      const ast = parse(src);
      const agent = ast.nodes.find((n) => n.id === "w") as AgentNode;
      expect(typeof agent.retry).toBe("object");
      const retryConfig = agent.retry as RetryConfig;
      expect(retryConfig.max).toBe(3);
      expect(retryConfig.backoff).toBe("exponential");
      expect(retryConfig.interval).toBe("1s");
      expect(retryConfig.maxInterval).toBe("60s");
      expect(retryConfig.jitter).toBe(true);
      expect(retryConfig.nonRetryable).toEqual(["auth-error", "invalid-input"]);
    });

    it("action with timeout and on-fail parses correctly", () => {
      const src = `topology t : [pipeline] {
  orchestrator { model: opus handles: [a] }
  action a {
    kind: inline
    timeout: 30s
    on-fail: skip
  }
  agent w { model: sonnet }
  flow { a -> w }
}`;
      const ast = parse(src);
      const action = ast.nodes.find((n) => n.id === "a");
      expect(action).toBeDefined();
      expect((action as any).timeout).toBe("30s");
      expect((action as any).onFail).toBe("skip");
    });

    it("gate with timeout parses correctly", () => {
      const src = `topology t : [pipeline] {
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  agent w { model: sonnet }
  gates {
    gate quality-check {
      after: w
      run: "check.sh"
      timeout: 2m
    }
  }
  flow { a -> w }
}`;
      const ast = parse(src);
      const gate = ast.nodes.find((n) => n.id === "quality-check") as GateNode;
      expect(gate).toBeDefined();
      expect(gate.timeout).toBe("2m");
    });
  });

  describe("Validation", () => {
    function minimalAST(overrides: Partial<TopologyAST> = {}): TopologyAST {
      return {
        topology: { name: "test", version: "1.0.0", description: "", patterns: ["pipeline"] },
        nodes: [
          { id: "orchestrator", type: "orchestrator", label: "Orchestrator", model: "opus", handles: ["intake"] },
          { id: "intake", type: "action", label: "Intake" },
          { id: "worker", type: "agent", label: "Worker", model: "sonnet" },
        ],
        edges: [
          { from: "intake", to: "worker", condition: null, maxIterations: null },
        ],
        depth: { factors: [], levels: [] },
        memory: {},
        batch: {},
        environments: {},
        triggers: [],
        hooks: [],
        settings: {},
        mcpServers: {},
        metering: null,
        defaults: null,
        schemas: [],
        observability: null,
        skills: [],
        toolDefs: [],
        roles: {},
        context: {},
        env: {},
        providers: [],
        schedules: [],
        interfaces: [],
        params: [],
        interfaceEndpoints: null,
        imports: [],
        includes: [],
        ...overrides,
      };
    }

    it("V30: valid timeout format passes", () => {
      const ast = minimalAST({
        nodes: [
          { id: "orchestrator", type: "orchestrator", label: "O", model: "opus", handles: ["intake"] },
          { id: "intake", type: "action", label: "I" },
          { id: "worker", type: "agent", label: "W", model: "sonnet", timeout: "5m" } as AgentNode,
        ],
      });
      const results = validate(ast);
      const v30 = results.filter((r) => r.rule === "V30");
      expect(v30.length).toBe(0);
    });

    it("V30: invalid timeout format produces error", () => {
      const ast = minimalAST({
        nodes: [
          { id: "orchestrator", type: "orchestrator", label: "O", model: "opus", handles: ["intake"] },
          { id: "intake", type: "action", label: "I" },
          { id: "worker", type: "agent", label: "W", model: "sonnet", timeout: "five-minutes" } as AgentNode,
        ],
      });
      const results = validate(ast);
      const v30 = results.filter((r) => r.rule === "V30");
      expect(v30.length).toBeGreaterThan(0);
      expect(v30[0].level).toBe("error");
    });

    it("V30: invalid timeout on action produces error", () => {
      const ast = minimalAST({
        nodes: [
          { id: "orchestrator", type: "orchestrator", label: "O", model: "opus", handles: ["intake"] },
          { id: "intake", type: "action", label: "I", timeout: "abc" } as any,
          { id: "worker", type: "agent", label: "W", model: "sonnet" },
        ],
      });
      const results = validate(ast);
      const v30 = results.filter((r) => r.rule === "V30");
      expect(v30.length).toBeGreaterThan(0);
    });

    it("V30: invalid timeout on gate produces error", () => {
      const ast = minimalAST({
        nodes: [
          { id: "orchestrator", type: "orchestrator", label: "O", model: "opus", handles: ["intake"] },
          { id: "intake", type: "action", label: "I" },
          { id: "worker", type: "agent", label: "W", model: "sonnet" },
          { id: "qg", type: "gate", label: "QG", after: "worker", run: "check.sh", timeout: "forever" } as GateNode,
        ],
      });
      const results = validate(ast);
      const v30 = results.filter((r) => r.rule === "V30");
      expect(v30.length).toBeGreaterThan(0);
    });

    it("V31: valid on-fail values pass", () => {
      for (const value of ["halt", "retry", "skip", "continue", "fallback backup"]) {
        const ast = minimalAST({
          nodes: [
            { id: "orchestrator", type: "orchestrator", label: "O", model: "opus", handles: ["intake"] },
            { id: "intake", type: "action", label: "I" },
            { id: "worker", type: "agent", label: "W", model: "sonnet", onFail: value } as AgentNode,
            { id: "backup", type: "agent", label: "B", model: "haiku", invocation: "manual" } as AgentNode,
          ],
        });
        const results = validate(ast);
        const v31 = results.filter((r) => r.rule === "V31");
        expect(v31.length).toBe(0);
      }
    });

    it("V31: invalid on-fail value produces error", () => {
      const ast = minimalAST({
        nodes: [
          { id: "orchestrator", type: "orchestrator", label: "O", model: "opus", handles: ["intake"] },
          { id: "intake", type: "action", label: "I" },
          { id: "worker", type: "agent", label: "W", model: "sonnet", onFail: "explode" } as AgentNode,
        ],
      });
      const results = validate(ast);
      const v31 = results.filter((r) => r.rule === "V31");
      expect(v31.length).toBeGreaterThan(0);
      expect(v31[0].level).toBe("error");
    });

    it("V32: fallback to non-existent agent produces error", () => {
      const ast = minimalAST({
        nodes: [
          { id: "orchestrator", type: "orchestrator", label: "O", model: "opus", handles: ["intake"] },
          { id: "intake", type: "action", label: "I" },
          { id: "worker", type: "agent", label: "W", model: "sonnet", onFail: "fallback ghost-agent" } as AgentNode,
        ],
      });
      const results = validate(ast);
      const v32 = results.filter((r) => r.rule === "V32");
      expect(v32.length).toBeGreaterThan(0);
      expect(v32[0].level).toBe("error");
      expect(v32[0].message).toContain("ghost-agent");
    });

    it("V32: fallback to existing agent passes", () => {
      const ast = minimalAST({
        nodes: [
          { id: "orchestrator", type: "orchestrator", label: "O", model: "opus", handles: ["intake"] },
          { id: "intake", type: "action", label: "I" },
          { id: "worker", type: "agent", label: "W", model: "sonnet", onFail: "fallback backup" } as AgentNode,
          { id: "backup", type: "agent", label: "B", model: "haiku", invocation: "manual" } as AgentNode,
        ],
      });
      const results = validate(ast);
      const v32 = results.filter((r) => r.rule === "V32");
      expect(v32.length).toBe(0);
    });

    it("V33: invalid retry block backoff produces error", () => {
      const ast = minimalAST({
        nodes: [
          { id: "orchestrator", type: "orchestrator", label: "O", model: "opus", handles: ["intake"] },
          { id: "intake", type: "action", label: "I" },
          { id: "worker", type: "agent", label: "W", model: "sonnet", retry: { max: 3, backoff: "random" as any } } as AgentNode,
        ],
      });
      const results = validate(ast);
      const v33 = results.filter((r) => r.rule === "V33");
      expect(v33.length).toBeGreaterThan(0);
      expect(v33[0].message).toContain("backoff");
    });

    it("V33: invalid retry block interval produces error", () => {
      const ast = minimalAST({
        nodes: [
          { id: "orchestrator", type: "orchestrator", label: "O", model: "opus", handles: ["intake"] },
          { id: "intake", type: "action", label: "I" },
          { id: "worker", type: "agent", label: "W", model: "sonnet", retry: { max: 3, interval: "forever" } } as AgentNode,
        ],
      });
      const results = validate(ast);
      const v33 = results.filter((r) => r.rule === "V33");
      expect(v33.length).toBeGreaterThan(0);
      expect(v33[0].message).toContain("interval");
    });

    it("V33: invalid retry block max-interval produces error", () => {
      const ast = minimalAST({
        nodes: [
          { id: "orchestrator", type: "orchestrator", label: "O", model: "opus", handles: ["intake"] },
          { id: "intake", type: "action", label: "I" },
          { id: "worker", type: "agent", label: "W", model: "sonnet", retry: { max: 3, maxInterval: "nope" } } as AgentNode,
        ],
      });
      const results = validate(ast);
      const v33 = results.filter((r) => r.rule === "V33");
      expect(v33.length).toBeGreaterThan(0);
      expect(v33[0].message).toContain("max-interval");
    });

    it("V33: valid retry block passes", () => {
      const ast = minimalAST({
        nodes: [
          { id: "orchestrator", type: "orchestrator", label: "O", model: "opus", handles: ["intake"] },
          { id: "intake", type: "action", label: "I" },
          { id: "worker", type: "agent", label: "W", model: "sonnet", retry: { max: 3, backoff: "exponential", interval: "1s", maxInterval: "60s", jitter: true, nonRetryable: ["auth-error"] } } as AgentNode,
        ],
      });
      const results = validate(ast);
      const v33 = results.filter((r) => r.rule === "V33");
      expect(v33.length).toBe(0);
    });

    it("V33: simple retry number does not trigger V33", () => {
      const ast = minimalAST({
        nodes: [
          { id: "orchestrator", type: "orchestrator", label: "O", model: "opus", handles: ["intake"] },
          { id: "intake", type: "action", label: "I" },
          { id: "worker", type: "agent", label: "W", model: "sonnet", retry: 3 } as AgentNode,
        ],
      });
      const results = validate(ast);
      const v33 = results.filter((r) => r.rule === "V33");
      expect(v33.length).toBe(0);
    });

    it("V34: temperature out of range produces error", () => {
      const ast = minimalAST({
        nodes: [
          { id: "orchestrator", type: "orchestrator", label: "O", model: "opus", handles: ["intake"] },
          { id: "intake", type: "action", label: "I" },
          { id: "worker", type: "agent", label: "W", model: "sonnet", temperature: 3.0 } as AgentNode,
        ],
      });
      const results = validate(ast);
      const v34 = results.filter((r) => r.rule === "V34");
      expect(v34.length).toBeGreaterThan(0);
      expect(v34[0].message).toContain("temperature");
    });

    it("V34: temperature in range passes", () => {
      const ast = minimalAST({
        nodes: [
          { id: "orchestrator", type: "orchestrator", label: "O", model: "opus", handles: ["intake"] },
          { id: "intake", type: "action", label: "I" },
          { id: "worker", type: "agent", label: "W", model: "sonnet", temperature: 0.7 } as AgentNode,
        ],
      });
      const results = validate(ast);
      const v34 = results.filter((r) => r.rule === "V34");
      expect(v34.length).toBe(0);
    });

    it("V34: temperature in defaults out of range produces error", () => {
      const ast = minimalAST({
        defaults: { temperature: -0.5 },
      });
      const results = validate(ast);
      const v34 = results.filter((r) => r.rule === "V34");
      expect(v34.length).toBeGreaterThan(0);
    });

    it("V35: invalid thinking produces error", () => {
      const ast = minimalAST({
        nodes: [
          { id: "orchestrator", type: "orchestrator", label: "O", model: "opus", handles: ["intake"] },
          { id: "intake", type: "action", label: "I" },
          { id: "worker", type: "agent", label: "W", model: "sonnet", thinking: "turbo" } as AgentNode,
        ],
      });
      const results = validate(ast);
      const v35 = results.filter((r) => r.rule === "V35");
      expect(v35.length).toBeGreaterThan(0);
      expect(v35[0].message).toContain("turbo");
    });

    it("V35: valid thinking passes", () => {
      const ast = minimalAST({
        nodes: [
          { id: "orchestrator", type: "orchestrator", label: "O", model: "opus", handles: ["intake"] },
          { id: "intake", type: "action", label: "I" },
          { id: "worker", type: "agent", label: "W", model: "sonnet", thinking: "high" } as AgentNode,
        ],
      });
      const results = validate(ast);
      const v35 = results.filter((r) => r.rule === "V35");
      expect(v35.length).toBe(0);
    });

    it("V36: invalid output-format produces error", () => {
      const ast = minimalAST({
        nodes: [
          { id: "orchestrator", type: "orchestrator", label: "O", model: "opus", handles: ["intake"] },
          { id: "intake", type: "action", label: "I" },
          { id: "worker", type: "agent", label: "W", model: "sonnet", outputFormat: "xml" } as AgentNode,
        ],
      });
      const results = validate(ast);
      const v36 = results.filter((r) => r.rule === "V36");
      expect(v36.length).toBeGreaterThan(0);
      expect(v36[0].message).toContain("xml");
    });

    it("V36: valid output-format passes", () => {
      const ast = minimalAST({
        nodes: [
          { id: "orchestrator", type: "orchestrator", label: "O", model: "opus", handles: ["intake"] },
          { id: "intake", type: "action", label: "I" },
          { id: "worker", type: "agent", label: "W", model: "sonnet", outputFormat: "json" } as AgentNode,
        ],
      });
      const results = validate(ast);
      const v36 = results.filter((r) => r.rule === "V36");
      expect(v36.length).toBe(0);
    });

    it("V37: invalid log-level produces error", () => {
      const ast = minimalAST({
        nodes: [
          { id: "orchestrator", type: "orchestrator", label: "O", model: "opus", handles: ["intake"] },
          { id: "intake", type: "action", label: "I" },
          { id: "worker", type: "agent", label: "W", model: "sonnet", logLevel: "verbose" } as AgentNode,
        ],
      });
      const results = validate(ast);
      const v37 = results.filter((r) => r.rule === "V37");
      expect(v37.length).toBeGreaterThan(0);
      expect(v37[0].message).toContain("verbose");
    });

    it("V37: valid log-level passes", () => {
      const ast = minimalAST({
        nodes: [
          { id: "orchestrator", type: "orchestrator", label: "O", model: "opus", handles: ["intake"] },
          { id: "intake", type: "action", label: "I" },
          { id: "worker", type: "agent", label: "W", model: "sonnet", logLevel: "debug" } as AgentNode,
        ],
      });
      const results = validate(ast);
      const v37 = results.filter((r) => r.rule === "V37");
      expect(v37.length).toBe(0);
    });

    it("V38: non-positive max-tokens produces error", () => {
      const ast = minimalAST({
        nodes: [
          { id: "orchestrator", type: "orchestrator", label: "O", model: "opus", handles: ["intake"] },
          { id: "intake", type: "action", label: "I" },
          { id: "worker", type: "agent", label: "W", model: "sonnet", maxTokens: 0 } as AgentNode,
        ],
      });
      const results = validate(ast);
      const v38 = results.filter((r) => r.rule === "V38");
      expect(v38.length).toBeGreaterThan(0);
    });

    it("V38: valid max-tokens passes", () => {
      const ast = minimalAST({
        nodes: [
          { id: "orchestrator", type: "orchestrator", label: "O", model: "opus", handles: ["intake"] },
          { id: "intake", type: "action", label: "I" },
          { id: "worker", type: "agent", label: "W", model: "sonnet", maxTokens: 4096 } as AgentNode,
        ],
      });
      const results = validate(ast);
      const v38 = results.filter((r) => r.rule === "V38");
      expect(v38.length).toBe(0);
    });
  });
});

// =========================================================================
// F. Model config parsing tests (sampling params, defaults, thinking, output-format)
// =========================================================================

describe("Model config parsing", () => {
  it("parses agent with sampling parameters", () => {
    const src = `
topology test-pipeline : [pipeline] {
  meta { version: "1.0.0" }
  agent extractor {
    model: gpt-4o
    temperature: 0
    max-tokens: 4096
    top-p: 0.9
    top-k: 50
    seed: 42
    stop: ["END", "---"]
  }
  flow { extractor -> extractor }
}`;
    const ast = parse(src);
    const agent = ast.nodes.find((n) => n.id === "extractor") as AgentNode;
    expect(agent).toBeDefined();
    expect(agent.temperature).toBe(0);
    expect(agent.maxTokens).toBe(4096);
    expect(agent.topP).toBe(0.9);
    expect(agent.topK).toBe(50);
    expect(agent.seed).toBe(42);
    expect(agent.stop).toEqual(["END", "---"]);
  });

  it("parses agent with thinking: high and thinking-budget", () => {
    const src = `
topology test-pipeline : [pipeline] {
  meta { version: "1.0.0" }
  agent reasoner {
    model: opus
    thinking: high
    thinking-budget: 10000
  }
  flow { reasoner -> reasoner }
}`;
    const ast = parse(src);
    const agent = ast.nodes.find((n) => n.id === "reasoner") as AgentNode;
    expect(agent).toBeDefined();
    expect(agent.thinking).toBe("high");
    expect(agent.thinkingBudget).toBe(10000);
  });

  it("parses agent with output-format: json", () => {
    const src = `
topology test-pipeline : [pipeline] {
  meta { version: "1.0.0" }
  agent extractor {
    model: gpt-4o
    output-format: json
  }
  flow { extractor -> extractor }
}`;
    const ast = parse(src);
    const agent = ast.nodes.find((n) => n.id === "extractor") as AgentNode;
    expect(agent).toBeDefined();
    expect(agent.outputFormat).toBe("json");
  });

  it("parses agent with log-level: debug", () => {
    const src = `
topology test-pipeline : [pipeline] {
  meta { version: "1.0.0" }
  agent classifier {
    model: sonnet
    log-level: debug
  }
  flow { classifier -> classifier }
}`;
    const ast = parse(src);
    const agent = ast.nodes.find((n) => n.id === "classifier") as AgentNode;
    expect(agent).toBeDefined();
    expect(agent.logLevel).toBe("debug");
  });

  it("parses defaults block", () => {
    const src = `
topology test-pipeline : [pipeline] {
  meta { version: "1.0.0" }
  defaults {
    temperature: 0.7
    max-tokens: 8192
    thinking: off
    timeout: 10m
    log-level: info
    output-format: text
    top-p: 0.95
    seed: 123
  }
  agent writer {
    model: sonnet
  }
  flow { writer -> writer }
}`;
    const ast = parse(src);
    expect(ast.defaults).not.toBeNull();
    expect(ast.defaults!.temperature).toBe(0.7);
    expect(ast.defaults!.maxTokens).toBe(8192);
    expect(ast.defaults!.thinking).toBe("off");
    expect(ast.defaults!.timeout).toBe("10m");
    expect(ast.defaults!.logLevel).toBe("info");
    expect(ast.defaults!.outputFormat).toBe("text");
    expect(ast.defaults!.topP).toBe(0.95);
    expect(ast.defaults!.seed).toBe(123);
  });

  it("defaults is null when no defaults block present", () => {
    const src = `
topology test-pipeline : [pipeline] {
  meta { version: "1.0.0" }
  agent writer {
    model: sonnet
  }
  flow { writer -> writer }
}`;
    const ast = parse(src);
    expect(ast.defaults).toBeNull();
  });

  it("backward compat: existing topologies still parse with defaults null", () => {
    const src = `
topology code-review : [pipeline] {
  meta {
    version: "1.0.0"
    description: "basic review"
  }
  agent reviewer {
    model: opus
    tools: [Read, Write]
    retry: 2
  }
  flow { reviewer -> reviewer }
}`;
    const ast = parse(src);
    expect(ast.defaults).toBeNull();
    const agent = ast.nodes.find((n) => n.id === "reviewer") as AgentNode;
    expect(agent.model).toBe("opus");
    expect(agent.tools).toEqual(["Read", "Write"]);
    expect(agent.retry).toBe(2);
    // No sampling params set
    expect(agent.temperature).toBeUndefined();
    expect(agent.maxTokens).toBeUndefined();
    expect(agent.thinking).toBeUndefined();
    expect(agent.outputFormat).toBeUndefined();
    expect(agent.logLevel).toBeUndefined();
  });
});

// =========================================================================
// Wave 2: Error Edges, Join Semantics, Edge Attributes
// =========================================================================

describe("Wave 2: Error edges (-x->)", () => {
  it("parses -x-> as an error edge with isError: true", () => {
    const src = `topology t : [pipeline] {
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  agent analyzer { model: opus }
  agent error-handler { model: opus }
  flow {
    a -> analyzer
    analyzer -x-> error-handler
  }
}`;
    const ast = parse(src);
    const errorEdge = ast.edges.find((e) => e.from === "analyzer" && e.to === "error-handler");
    expect(errorEdge).toBeDefined();
    expect(errorEdge!.isError).toBe(true);
    expect(errorEdge!.errorType).toBeUndefined();
  });

  it("parses -x[timeout]-> as a typed error edge", () => {
    const src = `topology t : [pipeline] {
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  agent analyzer { model: opus }
  agent fallback { model: opus }
  flow {
    a -> analyzer
    analyzer -x[timeout]-> fallback
  }
}`;
    const ast = parse(src);
    const errorEdge = ast.edges.find((e) => e.from === "analyzer" && e.to === "fallback");
    expect(errorEdge).toBeDefined();
    expect(errorEdge!.isError).toBe(true);
    expect(errorEdge!.errorType).toBe("timeout");
  });

  it("parses -x[auth-error]-> with hyphenated error type", () => {
    const src = `topology t : [pipeline] {
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  agent caller { model: opus }
  agent auth-fallback { model: opus }
  flow {
    a -> caller
    caller -x[auth-error]-> auth-fallback
  }
}`;
    const ast = parse(src);
    const errorEdge = ast.edges.find((e) => e.from === "caller" && e.to === "auth-fallback");
    expect(errorEdge).toBeDefined();
    expect(errorEdge!.isError).toBe(true);
    expect(errorEdge!.errorType).toBe("auth-error");
  });

  it("normal edges do not have isError set", () => {
    const src = `topology t : [pipeline] {
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  agent b { model: opus }
  flow {
    a -> b
  }
}`;
    const ast = parse(src);
    const edge = ast.edges.find((e) => e.from === "a" && e.to === "b");
    expect(edge).toBeDefined();
    expect(edge!.isError).toBeUndefined();
  });

  it("mixed normal and error edges on same node", () => {
    const src = `topology t : [pipeline] {
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  agent analyzer { model: opus }
  agent reviewer { model: opus }
  agent error-handler { model: opus }
  flow {
    a -> analyzer
    analyzer -> reviewer
    analyzer -x-> error-handler
  }
}`;
    const ast = parse(src);
    const normalEdge = ast.edges.find((e) => e.from === "analyzer" && e.to === "reviewer");
    expect(normalEdge).toBeDefined();
    expect(normalEdge!.isError).toBeUndefined();

    const errorEdge = ast.edges.find((e) => e.from === "analyzer" && e.to === "error-handler");
    expect(errorEdge).toBeDefined();
    expect(errorEdge!.isError).toBe(true);
  });
});

describe("Wave 2: [tolerance] edge attribute", () => {
  it("parses [tolerance: 2] as integer tolerance", () => {
    const src = `topology t : [pipeline] {
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  agent b { model: opus }
  agent c { model: opus }
  agent d { model: opus }
  flow {
    a -> [b, c, d] [tolerance: 2]
  }
}`;
    const ast = parse(src);
    const edges = ast.edges.filter((e) => e.from === "a");
    expect(edges).toHaveLength(3);
    for (const edge of edges) {
      expect(edge.tolerance).toBe(2);
    }
  });

  it("parses [tolerance: 33%] as percentage string", () => {
    const src = `topology t : [pipeline] {
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  agent b { model: opus }
  agent c { model: opus }
  flow {
    a -> [b, c] [tolerance: 33%]
  }
}`;
    const ast = parse(src);
    const edges = ast.edges.filter((e) => e.from === "a");
    expect(edges).toHaveLength(2);
    for (const edge of edges) {
      expect(edge.tolerance).toBe("33%");
    }
  });
});

describe("Wave 2: [race] edge attribute", () => {
  it("parses [race] as boolean edge attribute", () => {
    const src = `topology t : [pipeline] {
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  agent fast { model: opus }
  agent slow { model: opus }
  flow {
    a -> [fast, slow] [race]
  }
}`;
    const ast = parse(src);
    const edges = ast.edges.filter((e) => e.from === "a");
    expect(edges).toHaveLength(2);
    for (const edge of edges) {
      expect(edge.race).toBe(true);
    }
  });
});

describe("Wave 2: [wait N] edge attribute", () => {
  it("parses [wait 30s] as inline timer", () => {
    const src = `topology t : [pipeline] {
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  agent notifier { model: opus }
  flow {
    a -> notifier [wait 30s]
  }
}`;
    const ast = parse(src);
    const edge = ast.edges.find((e) => e.from === "a" && e.to === "notifier");
    expect(edge).toBeDefined();
    expect(edge!.wait).toBe("30s");
  });

  it("parses [wait 5m] with minute duration", () => {
    const src = `topology t : [pipeline] {
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  agent notifier { model: opus }
  flow {
    a -> notifier [wait 5m]
  }
}`;
    const ast = parse(src);
    const edge = ast.edges.find((e) => e.from === "a" && e.to === "notifier");
    expect(edge).toBeDefined();
    expect(edge!.wait).toBe("5m");
  });
});

describe("Wave 2: join field on agent/action", () => {
  it("parses join: all on agent", () => {
    const src = `topology t : [pipeline] {
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  agent synthesizer {
    model: opus
    join: all
  }
  flow { a -> synthesizer }
}`;
    const ast = parse(src);
    const agent = ast.nodes.find((n) => n.id === "synthesizer") as AgentNode;
    expect(agent.join).toBe("all");
  });

  it("parses join: any on agent", () => {
    const src = `topology t : [pipeline] {
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  agent fast-consumer {
    model: opus
    join: any
  }
  flow { a -> fast-consumer }
}`;
    const ast = parse(src);
    const agent = ast.nodes.find((n) => n.id === "fast-consumer") as AgentNode;
    expect(agent.join).toBe("any");
  });

  it("parses join: all-done on agent", () => {
    const src = `topology t : [pipeline] {
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  agent collector {
    model: opus
    join: all-done
  }
  flow { a -> collector }
}`;
    const ast = parse(src);
    const agent = ast.nodes.find((n) => n.id === "collector") as AgentNode;
    expect(agent.join).toBe("all-done");
  });

  it("parses join on action", () => {
    const src = `topology t : [pipeline] {
  orchestrator { model: opus handles: [merge-step] }
  action merge-step {
    kind: inline
    join: none-failed
  }
  flow { merge-step -> merge-step }
}`;
    const ast = parse(src);
    const action = ast.nodes.find((n) => n.id === "merge-step");
    expect(action).toBeDefined();
    expect((action as any).join).toBe("none-failed");
  });
});

describe("Wave 2: Topology meta timeout and error-handler", () => {
  it("parses timeout in meta block", () => {
    const src = `topology t : [pipeline] {
  meta {
    version: "1.0.0"
    timeout: 30m
  }
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  flow { a -> a }
}`;
    const ast = parse(src);
    expect(ast.topology.timeout).toBe("30m");
  });

  it("parses error-handler in meta block", () => {
    const src = `topology t : [pipeline] {
  meta {
    version: "1.0.0"
    error-handler: global-error-agent
  }
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  agent global-error-agent { model: opus }
  flow { a -> global-error-agent }
}`;
    const ast = parse(src);
    expect(ast.topology.errorHandler).toBe("global-error-agent");
  });

  it("parses both timeout and error-handler in meta block", () => {
    const src = `topology t : [pipeline] {
  meta {
    version: "1.0.0"
    timeout: 2h
    error-handler: catch-all
  }
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  agent catch-all { model: opus }
  flow { a -> catch-all }
}`;
    const ast = parse(src);
    expect(ast.topology.timeout).toBe("2h");
    expect(ast.topology.errorHandler).toBe("catch-all");
  });
});

describe("Wave 2: Validator rules V39-V45", () => {
  function minimalAST(overrides: Partial<TopologyAST> = {}): TopologyAST {
    return {
      topology: { name: "test", version: "1.0.0", description: "", patterns: ["pipeline"] },
      nodes: [
        { id: "orchestrator", type: "orchestrator", label: "Orchestrator", model: "opus", handles: ["intake"] },
        { id: "intake", type: "action", label: "Intake" },
        { id: "worker", type: "agent", label: "Worker", model: "sonnet" },
      ],
      edges: [
        { from: "intake", to: "worker", condition: null, maxIterations: null },
      ],
      depth: { factors: [], levels: [] },
      memory: {},
      batch: {},
      environments: {},
      triggers: [],
      hooks: [],
      settings: {},
      mcpServers: {},
      metering: null,
      defaults: null,
      schemas: [],
      observability: null,
      skills: [],
      toolDefs: [],
      roles: {},
      context: {},
      env: {},
      providers: [],
      schedules: [],
      interfaces: [],
      params: [],
      interfaceEndpoints: null,
      imports: [],
      includes: [],
      ...overrides,
    };
  }

  it("V39: invalid join value -> error", () => {
    const ast = minimalAST({
      nodes: [
        { id: "orchestrator", type: "orchestrator", label: "O", model: "opus", handles: ["intake"] },
        { id: "intake", type: "action", label: "I" },
        { id: "worker", type: "agent", label: "W", model: "sonnet", join: "invalid" },
      ],
      edges: [{ from: "intake", to: "worker", condition: null, maxIterations: null }],
    });
    const results = validate(ast);
    const v39 = results.filter((r) => r.rule === "V39");
    expect(v39.length).toBeGreaterThan(0);
    expect(v39[0].level).toBe("error");
    expect(v39[0].message).toContain("invalid");
  });

  it("V39: valid join value -> no error", () => {
    const ast = minimalAST({
      nodes: [
        { id: "orchestrator", type: "orchestrator", label: "O", model: "opus", handles: ["intake"] },
        { id: "intake", type: "action", label: "I" },
        { id: "worker", type: "agent", label: "W", model: "sonnet", join: "all" },
      ],
      edges: [{ from: "intake", to: "worker", condition: null, maxIterations: null }],
    });
    const results = validate(ast);
    const v39 = results.filter((r) => r.rule === "V39");
    expect(v39).toHaveLength(0);
  });

  it("V39: invalid join on action -> error", () => {
    const ast = minimalAST({
      nodes: [
        { id: "orchestrator", type: "orchestrator", label: "O", model: "opus", handles: ["merge"] },
        { id: "merge", type: "action", label: "Merge", join: "bogus" },
        { id: "worker", type: "agent", label: "W", model: "sonnet" },
      ],
      edges: [{ from: "merge", to: "worker", condition: null, maxIterations: null }],
    });
    const results = validate(ast);
    const v39 = results.filter((r) => r.rule === "V39");
    expect(v39.length).toBeGreaterThan(0);
  });

  it("V40: error edge target must be declared", () => {
    const ast = minimalAST({
      edges: [
        { from: "intake", to: "worker", condition: null, maxIterations: null },
        { from: "worker", to: "nonexistent", condition: null, maxIterations: null, isError: true },
      ],
    });
    const results = validate(ast);
    const v40 = results.filter((r) => r.rule === "V40");
    expect(v40.length).toBeGreaterThan(0);
    expect(v40[0].message).toContain("nonexistent");
  });

  it("V40: error edge to declared node -> no error", () => {
    const ast = minimalAST({
      nodes: [
        { id: "orchestrator", type: "orchestrator", label: "O", model: "opus", handles: ["intake"] },
        { id: "intake", type: "action", label: "I" },
        { id: "worker", type: "agent", label: "W", model: "sonnet" },
        { id: "error-handler", type: "agent", label: "EH", model: "sonnet" },
      ],
      edges: [
        { from: "intake", to: "worker", condition: null, maxIterations: null },
        { from: "worker", to: "error-handler", condition: null, maxIterations: null, isError: true },
      ],
    });
    const results = validate(ast);
    const v40 = results.filter((r) => r.rule === "V40");
    expect(v40).toHaveLength(0);
  });

  it("V41: [race] without fan-out -> error", () => {
    const ast = minimalAST({
      edges: [
        { from: "intake", to: "worker", condition: null, maxIterations: null, race: true },
      ],
    });
    const results = validate(ast);
    const v41 = results.filter((r) => r.rule === "V41");
    expect(v41.length).toBeGreaterThan(0);
    expect(v41[0].level).toBe("error");
  });

  it("V41: [race] with fan-out -> no error", () => {
    const ast = minimalAST({
      nodes: [
        { id: "orchestrator", type: "orchestrator", label: "O", model: "opus", handles: ["intake"] },
        { id: "intake", type: "action", label: "I" },
        { id: "fast", type: "agent", label: "F", model: "sonnet" },
        { id: "slow", type: "agent", label: "S", model: "sonnet" },
      ],
      edges: [
        { from: "intake", to: "fast", condition: null, maxIterations: null, race: true },
        { from: "intake", to: "slow", condition: null, maxIterations: null, race: true },
      ],
    });
    const results = validate(ast);
    const v41 = results.filter((r) => r.rule === "V41");
    expect(v41).toHaveLength(0);
  });

  it("V42: invalid tolerance format -> error", () => {
    const ast = minimalAST({
      edges: [
        { from: "intake", to: "worker", condition: null, maxIterations: null, tolerance: "abc" },
      ],
    });
    const results = validate(ast);
    const v42 = results.filter((r) => r.rule === "V42");
    expect(v42.length).toBeGreaterThan(0);
    expect(v42[0].level).toBe("error");
  });

  it("V42: valid tolerance integer -> no error", () => {
    const ast = minimalAST({
      edges: [
        { from: "intake", to: "worker", condition: null, maxIterations: null, tolerance: 2 },
      ],
    });
    const results = validate(ast);
    const v42 = results.filter((r) => r.rule === "V42");
    expect(v42).toHaveLength(0);
  });

  it("V42: valid tolerance percentage -> no error", () => {
    const ast = minimalAST({
      edges: [
        { from: "intake", to: "worker", condition: null, maxIterations: null, tolerance: "33%" },
      ],
    });
    const results = validate(ast);
    const v42 = results.filter((r) => r.rule === "V42");
    expect(v42).toHaveLength(0);
  });

  it("V43: invalid wait format -> error", () => {
    const ast = minimalAST({
      edges: [
        { from: "intake", to: "worker", condition: null, maxIterations: null, wait: "abc" },
      ],
    });
    const results = validate(ast);
    const v43 = results.filter((r) => r.rule === "V43");
    expect(v43.length).toBeGreaterThan(0);
    expect(v43[0].level).toBe("error");
  });

  it("V43: valid wait format -> no error", () => {
    const ast = minimalAST({
      edges: [
        { from: "intake", to: "worker", condition: null, maxIterations: null, wait: "30s" },
      ],
    });
    const results = validate(ast);
    const v43 = results.filter((r) => r.rule === "V43");
    expect(v43).toHaveLength(0);
  });

  it("V44: error-handler references undeclared node -> error", () => {
    const ast = minimalAST({
      topology: { name: "test", version: "1.0.0", description: "", patterns: ["pipeline"], errorHandler: "nonexistent" },
    });
    const results = validate(ast);
    const v44 = results.filter((r) => r.rule === "V44");
    expect(v44.length).toBeGreaterThan(0);
    expect(v44[0].message).toContain("nonexistent");
  });

  it("V44: error-handler references declared node -> no error", () => {
    const ast = minimalAST({
      topology: { name: "test", version: "1.0.0", description: "", patterns: ["pipeline"], errorHandler: "worker" },
    });
    const results = validate(ast);
    const v44 = results.filter((r) => r.rule === "V44");
    expect(v44).toHaveLength(0);
  });

  it("V45: invalid topology timeout -> error", () => {
    const ast = minimalAST({
      topology: { name: "test", version: "1.0.0", description: "", patterns: ["pipeline"], timeout: "abc" },
    });
    const results = validate(ast);
    const v45 = results.filter((r) => r.rule === "V45");
    expect(v45.length).toBeGreaterThan(0);
    expect(v45[0].level).toBe("error");
  });

  it("V45: valid topology timeout -> no error", () => {
    const ast = minimalAST({
      topology: { name: "test", version: "1.0.0", description: "", patterns: ["pipeline"], timeout: "30m" },
    });
    const results = validate(ast);
    const v45 = results.filter((r) => r.rule === "V45");
    expect(v45).toHaveLength(0);
  });
});

describe("Wave 2: Backward compatibility", () => {
  it("existing flow syntax with [when] and [max] still works", () => {
    const src = `topology t : [pipeline] {
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  agent b { model: opus
    outputs { verdict: yes | no } }
  agent c { model: opus }
  flow {
    b -> c [when b.verdict == yes]
    c -> b [max 3]
  }
}`;
    const ast = parse(src);
    const condEdge = ast.edges.find((e) => e.from === "b" && e.to === "c");
    expect(condEdge).toBeDefined();
    expect(condEdge!.condition).toBe("b.verdict == yes");

    const maxEdge = ast.edges.find((e) => e.from === "c" && e.to === "b");
    expect(maxEdge).toBeDefined();
    expect(maxEdge!.maxIterations).toBe(3);
  });

  it("existing fan-out syntax still works", () => {
    const src = `topology t : [pipeline] {
  orchestrator { model: opus handles: [start] }
  action start { kind: inline }
  agent x { model: opus }
  agent y { model: opus }
  flow {
    start -> [x, y]
  }
}`;
    const ast = parse(src);
    expect(ast.edges).toHaveLength(2);
    expect(ast.edges[0].from).toBe("start");
    expect(ast.edges[0].to).toBe("x");
    expect(ast.edges[1].from).toBe("start");
    expect(ast.edges[1].to).toBe("y");
  });

  it("existing chain syntax a -> b -> c still works", () => {
    const src = `topology t : [pipeline] {
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  agent b { model: opus }
  agent c { model: opus }
  flow {
    a -> b -> c
  }
}`;
    const ast = parse(src);
    expect(ast.edges).toHaveLength(2);
    expect(ast.edges[0]).toMatchObject({ from: "a", to: "b" });
    expect(ast.edges[1]).toMatchObject({ from: "b", to: "c" });
  });

  it("existing [per id] syntax still works", () => {
    const src = `topology t : [pipeline] {
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  agent b { model: opus }
  flow {
    a -> b [per ticket]
  }
}`;
    const ast = parse(src);
    const edge = ast.edges.find((e) => e.from === "a" && e.to === "b");
    expect(edge).toBeDefined();
    expect(edge!.per).toBe("ticket");
  });

  it("existing [when ..., max N] combined syntax still works", () => {
    const src = `topology t : [pipeline] {
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  agent b { model: opus
    outputs { status: pass | fail } }
  agent c { model: opus }
  flow {
    c -> b [when b.status == fail, max 3]
  }
}`;
    const ast = parse(src);
    const edge = ast.edges.find((e) => e.from === "c" && e.to === "b");
    expect(edge).toBeDefined();
    expect(edge!.condition).toBe("b.status == fail");
    expect(edge!.maxIterations).toBe(3);
  });
});

// =========================================================================
// Wave 3: Schema system tests
// =========================================================================

describe("Wave 3: Schema system", () => {
  describe("parseSchemaType", () => {
    it("parses string as primitive", () => {
      expect(parseSchemaType("string")).toEqual({ kind: "primitive", value: "string" });
    });

    it("parses number as primitive", () => {
      expect(parseSchemaType("number")).toEqual({ kind: "primitive", value: "number" });
    });

    it("parses integer as primitive", () => {
      expect(parseSchemaType("integer")).toEqual({ kind: "primitive", value: "integer" });
    });

    it("parses boolean as primitive", () => {
      expect(parseSchemaType("boolean")).toEqual({ kind: "primitive", value: "boolean" });
    });

    it("parses object as primitive", () => {
      expect(parseSchemaType("object")).toEqual({ kind: "primitive", value: "object" });
    });

    it("parses array of string", () => {
      expect(parseSchemaType("array of string")).toEqual({
        kind: "array",
        itemType: { kind: "primitive", value: "string" },
      });
    });

    it("parses array of ref", () => {
      expect(parseSchemaType("array of finding")).toEqual({
        kind: "array",
        itemType: { kind: "ref", name: "finding" },
      });
    });

    it("parses enum values", () => {
      expect(parseSchemaType("low | medium | high")).toEqual({
        kind: "enum",
        values: ["low", "medium", "high"],
      });
    });

    it("parses non-primitive as ref", () => {
      expect(parseSchemaType("finding")).toEqual({ kind: "ref", name: "finding" });
    });
  });

  describe("parseSchemaFields", () => {
    it("parses basic fields", () => {
      const body = `    severity: low | medium | high
    rule: string
    line: integer`;
      const fields = parseSchemaFields(body);
      expect(fields).toHaveLength(3);
      expect(fields[0]).toEqual({
        name: "severity",
        type: { kind: "enum", values: ["low", "medium", "high"] },
        optional: false,
      });
      expect(fields[1]).toEqual({
        name: "rule",
        type: { kind: "primitive", value: "string" },
        optional: false,
      });
      expect(fields[2]).toEqual({
        name: "line",
        type: { kind: "primitive", value: "integer" },
        optional: false,
      });
    });

    it("parses optional fields with ? prefix", () => {
      const body = `    line: ?integer
    message: ?string`;
      const fields = parseSchemaFields(body);
      expect(fields).toHaveLength(2);
      expect(fields[0].optional).toBe(true);
      expect(fields[0].type).toEqual({ kind: "primitive", value: "integer" });
      expect(fields[1].optional).toBe(true);
    });

    it("parses array fields", () => {
      const body = `    findings: array of finding`;
      const fields = parseSchemaFields(body);
      expect(fields).toHaveLength(1);
      expect(fields[0].type).toEqual({
        kind: "array",
        itemType: { kind: "ref", name: "finding" },
      });
    });
  });

  describe("Agent with input-schema", () => {
    it("parses input-schema block on agent", () => {
      const src = `
topology test : [pipeline] {
  agent analyzer {
    model: sonnet
    input-schema {
      pr-url: string
      base-branch: string
    }
  }
  flow {
    analyzer -> done
  }
}`;
      const ast = parse(src);
      const agent = ast.nodes.find((n) => n.id === "analyzer") as AgentNode;
      expect(agent.inputSchema).toBeDefined();
      expect(agent.inputSchema).toHaveLength(2);
      expect(agent.inputSchema![0]).toEqual({
        name: "pr-url",
        type: { kind: "primitive", value: "string" },
        optional: false,
      });
    });
  });

  describe("Agent with output-schema", () => {
    it("parses output-schema block on agent", () => {
      const src = `
topology test : [pipeline] {
  agent analyzer {
    model: sonnet
    output-schema {
      risk-level: low | medium | high | critical
      confidence: number
      findings: array of finding
    }
  }
  flow {
    analyzer -> done
  }
}`;
      const ast = parse(src);
      const agent = ast.nodes.find((n) => n.id === "analyzer") as AgentNode;
      expect(agent.outputSchema).toBeDefined();
      expect(agent.outputSchema).toHaveLength(3);
      expect(agent.outputSchema![0]).toEqual({
        name: "risk-level",
        type: { kind: "enum", values: ["low", "medium", "high", "critical"] },
        optional: false,
      });
      expect(agent.outputSchema![1]).toEqual({
        name: "confidence",
        type: { kind: "primitive", value: "number" },
        optional: false,
      });
      expect(agent.outputSchema![2]).toEqual({
        name: "findings",
        type: { kind: "array", itemType: { kind: "ref", name: "finding" } },
        optional: false,
      });
    });
  });

  describe("Top-level schemas block", () => {
    it("parses named schemas from top-level schemas block", () => {
      const src = `
topology test : [pipeline] {
  schemas {
    schema finding {
      severity: low | medium | high | critical
      rule: string
      file: string
      line: integer
      message: string
    }

    schema review-result {
      verdict: approve | request-changes | reject
      confidence: number
      findings: array of finding
    }
  }

  agent reviewer {
    model: sonnet
  }

  flow {
    reviewer -> done
  }
}`;
      const ast = parse(src);
      expect(ast.schemas).toHaveLength(2);
      expect(ast.schemas[0].id).toBe("finding");
      expect(ast.schemas[0].fields).toHaveLength(5);
      expect(ast.schemas[1].id).toBe("review-result");
      expect(ast.schemas[1].fields).toHaveLength(3);
      expect(ast.schemas[1].fields[2]).toEqual({
        name: "findings",
        type: { kind: "array", itemType: { kind: "ref", name: "finding" } },
        optional: false,
      });
    });
  });

  describe("Backward compatibility", () => {
    it("agents without schemas still work", () => {
      const src = `
topology test : [pipeline] {
  agent worker {
    model: sonnet
    tools: [Read, Write]
  }
  flow {
    worker -> done
  }
}`;
      const ast = parse(src);
      const agent = ast.nodes.find((n) => n.id === "worker") as AgentNode;
      expect(agent.inputSchema).toBeUndefined();
      expect(agent.outputSchema).toBeUndefined();
      expect(ast.schemas).toEqual([]);
    });
  });

  describe("Validator V46: schema type names valid", () => {
    function minimalAST(overrides: Partial<TopologyAST> = {}): TopologyAST {
      return {
        topology: { name: "test", version: "1.0.0", description: "", patterns: ["pipeline"] },
        nodes: [
          { id: "orchestrator", type: "orchestrator", label: "Orchestrator", model: "opus", handles: ["intake"] },
          { id: "intake", type: "action", label: "Intake" },
          { id: "worker", type: "agent", label: "Worker", model: "sonnet" },
        ],
        edges: [
          { from: "intake", to: "worker", condition: null, maxIterations: null },
        ],
        depth: { factors: [], levels: [] },
        memory: {},
        batch: {},
        environments: {},
        triggers: [],
        hooks: [],
        settings: {},
        mcpServers: {},
        metering: null,
        defaults: null,
        schemas: [],
        observability: null,
        skills: [],
        toolDefs: [],
        roles: {},
        context: {},
        env: {},
        providers: [],
        schedules: [],
        interfaces: [],
        params: [],
        interfaceEndpoints: null,
        imports: [],
        includes: [],
        ...overrides,
      };
    }

    it("valid schema types produce no V46 errors", () => {
      const ast = minimalAST({
        schemas: [
          {
            id: "finding",
            fields: [
              { name: "severity", type: { kind: "enum", values: ["low", "high"] }, optional: false },
              { name: "line", type: { kind: "primitive", value: "integer" }, optional: false },
              { name: "tags", type: { kind: "array", itemType: { kind: "primitive", value: "string" } }, optional: false },
            ],
          },
        ],
      });
      const issues = validate(ast);
      const v46 = issues.filter((i) => i.rule === "V46");
      expect(v46).toHaveLength(0);
    });

    it("passes for agent input-schema with valid types", () => {
      const ast = minimalAST({
        nodes: [
          { id: "orchestrator", type: "orchestrator", label: "Orchestrator", model: "opus", handles: ["intake"] },
          { id: "intake", type: "action", label: "Intake" },
          {
            id: "worker", type: "agent", label: "Worker", model: "sonnet",
            inputSchema: [
              { name: "url", type: { kind: "primitive", value: "string" }, optional: false },
            ],
          } as AgentNode,
        ],
      });
      const issues = validate(ast);
      const v46 = issues.filter((i) => i.rule === "V46");
      expect(v46).toHaveLength(0);
    });
  });

  describe("Validator V47: schema ref resolves", () => {
    function minimalAST(overrides: Partial<TopologyAST> = {}): TopologyAST {
      return {
        topology: { name: "test", version: "1.0.0", description: "", patterns: ["pipeline"] },
        nodes: [
          { id: "orchestrator", type: "orchestrator", label: "Orchestrator", model: "opus", handles: ["intake"] },
          { id: "intake", type: "action", label: "Intake" },
          { id: "worker", type: "agent", label: "Worker", model: "sonnet" },
        ],
        edges: [
          { from: "intake", to: "worker", condition: null, maxIterations: null },
        ],
        depth: { factors: [], levels: [] },
        memory: {},
        batch: {},
        environments: {},
        triggers: [],
        hooks: [],
        settings: {},
        mcpServers: {},
        metering: null,
        defaults: null,
        schemas: [],
        observability: null,
        skills: [],
        toolDefs: [],
        roles: {},
        context: {},
        env: {},
        providers: [],
        schedules: [],
        interfaces: [],
        params: [],
        interfaceEndpoints: null,
        imports: [],
        includes: [],
        ...overrides,
      };
    }

    it("resolved ref produces no V47 error", () => {
      const ast = minimalAST({
        schemas: [
          {
            id: "finding",
            fields: [
              { name: "message", type: { kind: "primitive", value: "string" }, optional: false },
            ],
          },
          {
            id: "report",
            fields: [
              { name: "findings", type: { kind: "array", itemType: { kind: "ref", name: "finding" } }, optional: false },
            ],
          },
        ],
      });
      const issues = validate(ast);
      const v47 = issues.filter((i) => i.rule === "V47");
      expect(v47).toHaveLength(0);
    });

    it("unresolved ref produces V47 error", () => {
      const ast = minimalAST({
        schemas: [
          {
            id: "report",
            fields: [
              { name: "findings", type: { kind: "array", itemType: { kind: "ref", name: "nonexistent" } }, optional: false },
            ],
          },
        ],
      });
      const issues = validate(ast);
      const v47 = issues.filter((i) => i.rule === "V47");
      expect(v47).toHaveLength(1);
      expect(v47[0].message).toContain("nonexistent");
    });

    it("unresolved ref in agent output-schema produces V47 error", () => {
      const ast = minimalAST({
        nodes: [
          { id: "orchestrator", type: "orchestrator", label: "Orchestrator", model: "opus", handles: ["intake"] },
          { id: "intake", type: "action", label: "Intake" },
          {
            id: "worker", type: "agent", label: "Worker", model: "sonnet",
            outputSchema: [
              { name: "results", type: { kind: "ref", name: "missing-schema" }, optional: false },
            ],
          } as AgentNode,
        ],
      });
      const issues = validate(ast);
      const v47 = issues.filter((i) => i.rule === "V47");
      expect(v47).toHaveLength(1);
      expect(v47[0].message).toContain("missing-schema");
    });
  });
});

// =========================================================================
// Wave 3C: Secret URI References + Sensitive Modifier (F11, F22)
// =========================================================================

describe("Sensitive and Secret env values", () => {
  const minimalPrefix = `topology t : [pipeline] {
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  flow { a -> a }`;

  it("parses sensitive env var reference as SensitiveValue", () => {
    const src = `${minimalPrefix}
  env {
    API_KEY: sensitive "\${API_KEY}"
  }
}`;
    const ast = parse(src);
    const val = ast.env["API_KEY"] as SensitiveValue;
    expect(val).toBeDefined();
    expect(typeof val).toBe("object");
    expect(val.value).toBe("${API_KEY}");
    expect(val.sensitive).toBe(true);
    expect(val.secretRef).toBeUndefined();
  });

  it("parses secret URI as SensitiveValue with SecretRef", () => {
    const src = `${minimalPrefix}
  env {
    api-key: secret "vault://secret/data/prod#key"
  }
}`;
    const ast = parse(src);
    const val = ast.env["api-key"] as SensitiveValue;
    expect(val).toBeDefined();
    expect(typeof val).toBe("object");
    expect(val.value).toBe("vault://secret/data/prod#key");
    expect(val.sensitive).toBe(true);
    expect(val.secretRef).toBeDefined();
    expect(val.secretRef!.scheme).toBe("vault");
    expect(val.secretRef!.uri).toBe("vault://secret/data/prod#key");
  });

  it("plain string env values still work (backward compat)", () => {
    const src = `${minimalPrefix}
  env {
    NODE_ENV: "production"
    REGION: "us-east-1"
  }
}`;
    const ast = parse(src);
    expect(ast.env["NODE_ENV"]).toBe("production");
    expect(ast.env["REGION"]).toBe("us-east-1");
  });

  it("handles mixed plain, sensitive, and secret values in same env block", () => {
    const src = `${minimalPrefix}
  env {
    NODE_ENV: "production"
    API_KEY: sensitive "\${API_KEY}"
    DB_PASS: secret "op://prod/db/password"
  }
}`;
    const ast = parse(src);
    expect(ast.env["NODE_ENV"]).toBe("production");
    const apiKey = ast.env["API_KEY"] as SensitiveValue;
    expect(apiKey.sensitive).toBe(true);
    expect(apiKey.value).toBe("${API_KEY}");
    const dbPass = ast.env["DB_PASS"] as SensitiveValue;
    expect(dbPass.sensitive).toBe(true);
    expect(dbPass.secretRef!.scheme).toBe("op");
  });

  it("parses all supported secret URI schemes", () => {
    const schemes = ["vault", "op", "awssm", "ssm", "gcpsm", "azurekv"];
    for (const scheme of schemes) {
      const src = `${minimalPrefix}
  env {
    KEY: secret "${scheme}://path/to/secret"
  }
}`;
      const ast = parse(src);
      const val = ast.env["KEY"] as SensitiveValue;
      expect(val.secretRef!.scheme).toBe(scheme);
    }
  });
});

describe("V51 - Sensitive literal warning", () => {
  const minimalPrefix = `topology t : [pipeline] {
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  flow { a -> a }`;

  it("warns when sensitive is used with a literal string", () => {
    const src = `${minimalPrefix}
  env {
    API_KEY: sensitive "my-literal-secret"
  }
}`;
    const ast = parse(src);
    const issues = validate(ast);
    const v51 = issues.filter((i) => i.rule === "V51");
    expect(v51).toHaveLength(1);
    expect(v51[0].level).toBe("warning");
    expect(v51[0].message).toContain("sensitive value should reference an environment variable");
  });

  it("does not warn when sensitive references an env var", () => {
    const src = `${minimalPrefix}
  env {
    API_KEY: sensitive "\${API_KEY}"
  }
}`;
    const ast = parse(src);
    const issues = validate(ast);
    const v51 = issues.filter((i) => i.rule === "V51");
    expect(v51).toHaveLength(0);
  });

  it("does not warn for plain string values", () => {
    const src = `${minimalPrefix}
  env {
    NODE_ENV: "production"
  }
}`;
    const ast = parse(src);
    const issues = validate(ast);
    const v51 = issues.filter((i) => i.rule === "V51");
    expect(v51).toHaveLength(0);
  });

  it("does not warn for secret URIs (those have secretRef)", () => {
    const src = `${minimalPrefix}
  env {
    KEY: secret "vault://secret/data/prod#key"
  }
}`;
    const ast = parse(src);
    const issues = validate(ast);
    const v51 = issues.filter((i) => i.rule === "V51");
    expect(v51).toHaveLength(0);
  });
});

describe("V52 - Secret URI scheme validation", () => {
  const minimalPrefix = `topology t : [pipeline] {
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  flow { a -> a }`;

  it("errors on unknown secret URI scheme", () => {
    const src = `${minimalPrefix}
  env {
    KEY: secret "unknown://path/to/secret"
  }
}`;
    const ast = parse(src);
    const issues = validate(ast);
    const v52 = issues.filter((i) => i.rule === "V52");
    expect(v52).toHaveLength(1);
    expect(v52[0].level).toBe("error");
    expect(v52[0].message).toContain('unknown secret URI scheme "unknown"');
  });

  it("valid schemes all pass", () => {
    const schemes = ["vault", "op", "awssm", "ssm", "gcpsm", "azurekv"];
    for (const scheme of schemes) {
      const src = `${minimalPrefix}
  env {
    KEY: secret "${scheme}://path/to/secret"
  }
}`;
      const ast = parse(src);
      const issues = validate(ast);
      const v52 = issues.filter((i) => i.rule === "V52");
      expect(v52).toHaveLength(0);
    }
  });

  it("does not apply to sensitive values (no secretRef)", () => {
    const src = `${minimalPrefix}
  env {
    KEY: sensitive "\${MY_KEY}"
  }
}`;
    const ast = parse(src);
    const issues = validate(ast);
    const v52 = issues.filter((i) => i.rule === "V52");
    expect(v52).toHaveLength(0);
  });
});

// =========================================================================
// Wave 3: Observability block (F12)
// =========================================================================

describe("Wave 3: Observability block parsing", () => {
  it("full observability block parses correctly", () => {
    const src = `topology t : [pipeline] {
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  flow { a -> a }
  observability {
    enabled: true
    level: debug
    exporter: otlp
    endpoint: "\${OTEL_ENDPOINT}"
    service: "my-service"
    sample-rate: 0.5
    capture {
      prompts: true
      completions: true
      tool-args: false
      tool-results: false
    }
    spans {
      agents: true
      tools: true
      gates: false
      memory: true
    }
  }
}`;
    const ast = parse(src);
    expect(ast.observability).not.toBeNull();
    expect(ast.observability!.enabled).toBe(true);
    expect(ast.observability!.level).toBe("debug");
    expect(ast.observability!.exporter).toBe("otlp");
    expect(ast.observability!.endpoint).toBe("${OTEL_ENDPOINT}");
    expect(ast.observability!.service).toBe("my-service");
    expect(ast.observability!.sampleRate).toBe(0.5);
    expect(ast.observability!.capture.prompts).toBe(true);
    expect(ast.observability!.capture.completions).toBe(true);
    expect(ast.observability!.capture.toolArgs).toBe(false);
    expect(ast.observability!.capture.toolResults).toBe(false);
    expect(ast.observability!.spans.agents).toBe(true);
    expect(ast.observability!.spans.tools).toBe(true);
    expect(ast.observability!.spans.gates).toBe(false);
    expect(ast.observability!.spans.memory).toBe(true);
  });

  it("observability with only capture sub-block", () => {
    const src = `topology t : [pipeline] {
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  flow { a -> a }
  observability {
    level: info
    exporter: langsmith
    capture {
      prompts: true
      completions: false
    }
  }
}`;
    const ast = parse(src);
    expect(ast.observability).not.toBeNull();
    expect(ast.observability!.level).toBe("info");
    expect(ast.observability!.exporter).toBe("langsmith");
    expect(ast.observability!.capture.prompts).toBe(true);
    expect(ast.observability!.capture.completions).toBe(false);
    expect(ast.observability!.capture.toolArgs).toBe(false);
    expect(ast.observability!.capture.toolResults).toBe(false);
    // spans should get defaults
    expect(ast.observability!.spans.agents).toBe(true);
    expect(ast.observability!.spans.tools).toBe(true);
    expect(ast.observability!.spans.gates).toBe(true);
    expect(ast.observability!.spans.memory).toBe(false);
  });

  it("observability with only spans sub-block", () => {
    const src = `topology t : [pipeline] {
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  flow { a -> a }
  observability {
    exporter: datadog
    spans {
      agents: false
      memory: true
    }
  }
}`;
    const ast = parse(src);
    expect(ast.observability).not.toBeNull();
    expect(ast.observability!.exporter).toBe("datadog");
    expect(ast.observability!.capture.prompts).toBe(false);
    expect(ast.observability!.capture.completions).toBe(false);
    expect(ast.observability!.capture.toolArgs).toBe(false);
    expect(ast.observability!.capture.toolResults).toBe(false);
    expect(ast.observability!.spans.agents).toBe(false);
    expect(ast.observability!.spans.tools).toBe(true);
    expect(ast.observability!.spans.gates).toBe(true);
    expect(ast.observability!.spans.memory).toBe(true);
  });

  it("defaults are applied when fields omitted", () => {
    const src = `topology t : [pipeline] {
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  flow { a -> a }
  observability {
  }
}`;
    const ast = parse(src);
    expect(ast.observability).not.toBeNull();
    expect(ast.observability!.enabled).toBe(true);
    expect(ast.observability!.level).toBe("info");
    expect(ast.observability!.exporter).toBe("otlp");
    expect(ast.observability!.sampleRate).toBe(1.0);
    expect(ast.observability!.endpoint).toBeUndefined();
    expect(ast.observability!.service).toBeUndefined();
    expect(ast.observability!.capture.prompts).toBe(false);
    expect(ast.observability!.capture.completions).toBe(false);
    expect(ast.observability!.capture.toolArgs).toBe(false);
    expect(ast.observability!.capture.toolResults).toBe(false);
    expect(ast.observability!.spans.agents).toBe(true);
    expect(ast.observability!.spans.tools).toBe(true);
    expect(ast.observability!.spans.gates).toBe(true);
    expect(ast.observability!.spans.memory).toBe(false);
  });

  it("backward compat: topology without observability -> null", () => {
    const src = `topology t : [pipeline] {
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  flow { a -> a }
}`;
    const ast = parse(src);
    expect(ast.observability).toBeNull();
  });

  it("observability with enabled: false", () => {
    const src = `topology t : [pipeline] {
  orchestrator { model: opus handles: [a] }
  action a { kind: inline }
  flow { a -> a }
  observability {
    enabled: false
    exporter: none
  }
}`;
    const ast = parse(src);
    expect(ast.observability).not.toBeNull();
    expect(ast.observability!.enabled).toBe(false);
    expect(ast.observability!.exporter).toBe("none");
  });
});

describe("Wave 3: Validator rules V48-V50 (observability)", () => {
  function minimalAST(overrides: Partial<TopologyAST> = {}): TopologyAST {
    return {
      topology: { name: "test", version: "1.0.0", description: "", patterns: ["pipeline"] },
      nodes: [
        { id: "orchestrator", type: "orchestrator", label: "Orchestrator", model: "opus", handles: ["intake"] },
        { id: "intake", type: "action", label: "Intake" },
        { id: "worker", type: "agent", label: "Worker", model: "sonnet" },
      ],
      edges: [
        { from: "intake", to: "worker", condition: null, maxIterations: null },
      ],
      depth: { factors: [], levels: [] },
      memory: {},
      batch: {},
      environments: {},
      triggers: [],
      hooks: [],
      settings: {},
      mcpServers: {},
      metering: null,
      defaults: null,
      schemas: [],
      observability: null,
      skills: [],
      toolDefs: [],
      roles: {},
      context: {},
      env: {},
      providers: [],
      schedules: [],
      interfaces: [],
      params: [],
      interfaceEndpoints: null,
      imports: [],
      includes: [],
      ...overrides,
    };
  }

  it("V48: invalid observability level -> error", () => {
    const ast = minimalAST({
      observability: {
        enabled: true, level: "verbose", exporter: "otlp", sampleRate: 1.0,
        capture: { prompts: false, completions: false, toolArgs: false, toolResults: false },
        spans: { agents: true, tools: true, gates: true, memory: false },
      },
    });
    const results = validate(ast);
    const v48 = results.filter((r) => r.rule === "V48");
    expect(v48.length).toBeGreaterThan(0);
    expect(v48[0].level).toBe("error");
    expect(v48[0].message).toContain("verbose");
  });

  it("V48: valid observability level -> no error", () => {
    const ast = minimalAST({
      observability: {
        enabled: true, level: "warn", exporter: "otlp", sampleRate: 1.0,
        capture: { prompts: false, completions: false, toolArgs: false, toolResults: false },
        spans: { agents: true, tools: true, gates: true, memory: false },
      },
    });
    const results = validate(ast);
    const v48 = results.filter((r) => r.rule === "V48");
    expect(v48).toHaveLength(0);
  });

  it("V49: invalid observability exporter -> error", () => {
    const ast = minimalAST({
      observability: {
        enabled: true, level: "info", exporter: "prometheus", sampleRate: 1.0,
        capture: { prompts: false, completions: false, toolArgs: false, toolResults: false },
        spans: { agents: true, tools: true, gates: true, memory: false },
      },
    });
    const results = validate(ast);
    const v49 = results.filter((r) => r.rule === "V49");
    expect(v49.length).toBeGreaterThan(0);
    expect(v49[0].level).toBe("error");
    expect(v49[0].message).toContain("prometheus");
  });

  it("V49: valid observability exporter -> no error", () => {
    const ast = minimalAST({
      observability: {
        enabled: true, level: "info", exporter: "datadog", sampleRate: 1.0,
        capture: { prompts: false, completions: false, toolArgs: false, toolResults: false },
        spans: { agents: true, tools: true, gates: true, memory: false },
      },
    });
    const results = validate(ast);
    const v49 = results.filter((r) => r.rule === "V49");
    expect(v49).toHaveLength(0);
  });

  it("V50: sample-rate > 1 -> error", () => {
    const ast = minimalAST({
      observability: {
        enabled: true, level: "info", exporter: "otlp", sampleRate: 1.5,
        capture: { prompts: false, completions: false, toolArgs: false, toolResults: false },
        spans: { agents: true, tools: true, gates: true, memory: false },
      },
    });
    const results = validate(ast);
    const v50 = results.filter((r) => r.rule === "V50");
    expect(v50.length).toBeGreaterThan(0);
    expect(v50[0].level).toBe("error");
  });

  it("V50: sample-rate < 0 -> error", () => {
    const ast = minimalAST({
      observability: {
        enabled: true, level: "info", exporter: "otlp", sampleRate: -0.1,
        capture: { prompts: false, completions: false, toolArgs: false, toolResults: false },
        spans: { agents: true, tools: true, gates: true, memory: false },
      },
    });
    const results = validate(ast);
    const v50 = results.filter((r) => r.rule === "V50");
    expect(v50.length).toBeGreaterThan(0);
  });

  it("V50: valid sample-rate (0.5) -> no error", () => {
    const ast = minimalAST({
      observability: {
        enabled: true, level: "info", exporter: "otlp", sampleRate: 0.5,
        capture: { prompts: false, completions: false, toolArgs: false, toolResults: false },
        spans: { agents: true, tools: true, gates: true, memory: false },
      },
    });
    const results = validate(ast);
    const v50 = results.filter((r) => r.rule === "V50");
    expect(v50).toHaveLength(0);
  });

  it("V50: sample-rate 0 (boundary) -> no error", () => {
    const ast = minimalAST({
      observability: {
        enabled: true, level: "info", exporter: "otlp", sampleRate: 0,
        capture: { prompts: false, completions: false, toolArgs: false, toolResults: false },
        spans: { agents: true, tools: true, gates: true, memory: false },
      },
    });
    const results = validate(ast);
    const v50 = results.filter((r) => r.rule === "V50");
    expect(v50).toHaveLength(0);
  });

  it("V50: sample-rate 1 (boundary) -> no error", () => {
    const ast = minimalAST({
      observability: {
        enabled: true, level: "info", exporter: "otlp", sampleRate: 1,
        capture: { prompts: false, completions: false, toolArgs: false, toolResults: false },
        spans: { agents: true, tools: true, gates: true, memory: false },
      },
    });
    const results = validate(ast);
    const v50 = results.filter((r) => r.rule === "V50");
    expect(v50).toHaveLength(0);
  });

  it("no observability block -> no V48/V49/V50 errors", () => {
    const ast = minimalAST({ observability: null });
    const results = validate(ast);
    const obsRules = results.filter((r) => ["V48", "V49", "V50"].includes(r.rule));
    expect(obsRules).toHaveLength(0);
  });
});

// =========================================================================
// Wave 4: Composition — params, interface, imports, includes, fragment
// =========================================================================

describe("Wave 4 — Composition", () => {
  // ── Params block ────────────────────────────────────────────────────────

  describe("params block parsing", () => {
    it("parses typed params with defaults (string, number, boolean)", () => {
      const body = `
        output-path: string = "workspace/research/"
        model-name: string = "gpt-4o"
        max-depth: number = 3
        strict-mode: boolean = false
      `;
      const params = parseParams(body);
      expect(params).toHaveLength(4);
      expect(params[0]).toEqual({ name: "output-path", type: "string", required: false, default: "workspace/research/" });
      expect(params[1]).toEqual({ name: "model-name", type: "string", required: false, default: "gpt-4o" });
      expect(params[2]).toEqual({ name: "max-depth", type: "number", required: false, default: 3 });
      expect(params[3]).toEqual({ name: "strict-mode", type: "boolean", required: false, default: false });
    });

    it("parses required params (no default)", () => {
      const body = `
        api-key: string
        count: number
        verbose: boolean
      `;
      const params = parseParams(body);
      expect(params).toHaveLength(3);
      expect(params[0]).toEqual({ name: "api-key", type: "string", required: true });
      expect(params[1]).toEqual({ name: "count", type: "number", required: true });
      expect(params[2]).toEqual({ name: "verbose", type: "boolean", required: true });
    });

    it("parses mixed required and optional params", () => {
      const body = `
        api-key: string
        model: string = "sonnet"
      `;
      const params = parseParams(body);
      expect(params).toHaveLength(2);
      expect(params[0].required).toBe(true);
      expect(params[1].required).toBe(false);
      expect(params[1].default).toBe("sonnet");
    });

    it("parses params block from full topology", () => {
      const src = `
topology test : [pipeline] {
  params {
    output-path: string = "workspace/"
    max-depth: number = 5
  }
  agent worker {
    model: sonnet
  }
  flow {
    intake -> worker -> done
  }
}`;
      const ast = parse(src);
      expect(ast.params).toHaveLength(2);
      expect(ast.params[0].name).toBe("output-path");
      expect(ast.params[0].type).toBe("string");
      expect(ast.params[0].default).toBe("workspace/");
      expect(ast.params[1].name).toBe("max-depth");
      expect(ast.params[1].type).toBe("number");
      expect(ast.params[1].default).toBe(5);
    });

    it("empty params block returns empty array", () => {
      const params = parseParams("");
      expect(params).toEqual([]);
    });
  });

  // ── Interface block ────────────────────────────────────────────────────

  describe("interface block parsing", () => {
    it("parses entry and exit endpoints", () => {
      const body = `
        entry: intake
        exit: report
      `;
      const endpoints = parseInterfaceEndpoints(body);
      expect(endpoints).not.toBeNull();
      expect(endpoints!.entry).toBe("intake");
      expect(endpoints!.exit).toBe("report");
    });

    it("returns null if entry or exit is missing", () => {
      expect(parseInterfaceEndpoints("entry: intake")).toBeNull();
      expect(parseInterfaceEndpoints("exit: report")).toBeNull();
      expect(parseInterfaceEndpoints("")).toBeNull();
    });

    it("parses interface block from full topology", () => {
      const src = `
topology scanner : [pipeline] {
  interface {
    entry: intake
    exit: report
  }
  agent intake {
    model: sonnet
  }
  agent report {
    model: sonnet
  }
  flow {
    intake -> report -> done
  }
}`;
      const ast = parse(src);
      expect(ast.interfaceEndpoints).not.toBeNull();
      expect(ast.interfaceEndpoints!.entry).toBe("intake");
      expect(ast.interfaceEndpoints!.exit).toBe("report");
    });

    it("does not confuse interface block with interfaces block", () => {
      const src = `
topology test : [pipeline] {
  interfaces {
    slack {
      type: webhook
      channel: general
    }
  }
  agent worker {
    model: sonnet
  }
  flow {
    intake -> worker -> done
  }
}`;
      const ast = parse(src);
      // Should NOT produce interface endpoints from the "interfaces" block
      expect(ast.interfaceEndpoints).toBeNull();
      // Should correctly parse interfaces
      expect(ast.interfaces).toHaveLength(1);
    });
  });

  // ── Import statements ──────────────────────────────────────────────────

  describe("import parsing", () => {
    it("parses import with alias", () => {
      const body = `
        import "./topologies/research.at" as research
      `;
      const imports = parseImports(body);
      expect(imports).toHaveLength(1);
      expect(imports[0].source).toBe("./topologies/research.at");
      expect(imports[0].alias).toBe("research");
      expect(imports[0].params).toEqual({});
    });

    it("parses import with 'with' clause", () => {
      const body = `
        import "./topologies/research.at" as research
          with {
            model: "sonnet"
            output-path: "workspace/"
          }
      `;
      const imports = parseImports(body);
      expect(imports).toHaveLength(1);
      expect(imports[0].source).toBe("./topologies/research.at");
      expect(imports[0].alias).toBe("research");
      expect(imports[0].params).toEqual({
        model: "sonnet",
        "output-path": "workspace/",
      });
    });

    it("parses import with numeric and boolean params in with clause", () => {
      const body = `
        import "./sub.at" as sub
          with {
            depth: 3
            verbose: true
          }
      `;
      const imports = parseImports(body);
      expect(imports).toHaveLength(1);
      expect(imports[0].params.depth).toBe(3);
      expect(imports[0].params.verbose).toBe(true);
    });

    it("parses multiple imports", () => {
      const body = `
        import "./a.at" as alpha
        import "./b.at" as beta
      `;
      const imports = parseImports(body);
      expect(imports).toHaveLength(2);
      expect(imports[0].alias).toBe("alpha");
      expect(imports[1].alias).toBe("beta");
    });

    it("parses imports from full topology", () => {
      const src = `
topology factory : [pipeline] {
  import "./topologies/research.at" as research
    with {
      model: "sonnet"
    }
  agent editor {
    model: opus
  }
  flow {
    intake -> research -> editor -> done
  }
}`;
      const ast = parse(src);
      expect(ast.imports).toHaveLength(1);
      expect(ast.imports[0].source).toBe("./topologies/research.at");
      expect(ast.imports[0].alias).toBe("research");
      expect(ast.imports[0].params.model).toBe("sonnet");
    });
  });

  // ── Include statements ────────────────────────────────────────────────

  describe("include parsing", () => {
    it("parses include statement", () => {
      const body = `
        include "./fragments/observability.at"
      `;
      const includes = parseIncludes(body);
      expect(includes).toHaveLength(1);
      expect(includes[0].source).toBe("./fragments/observability.at");
    });

    it("parses multiple includes", () => {
      const body = `
        include "./fragments/observability.at"
        include "./fragments/security.at"
      `;
      const includes = parseIncludes(body);
      expect(includes).toHaveLength(2);
    });

    it("parses includes from full topology", () => {
      const src = `
topology test : [pipeline] {
  include "./fragments/observability.at"
  agent worker {
    model: sonnet
  }
  flow {
    intake -> worker -> done
  }
}`;
      const ast = parse(src);
      expect(ast.includes).toHaveLength(1);
      expect(ast.includes[0].source).toBe("./fragments/observability.at");
    });
  });

  // ── Fragment root type ─────────────────────────────────────────────────

  describe("fragment parsing", () => {
    it("parses a fragment file", () => {
      const src = `
fragment observability {
  metering {
    track: [tokens-in, tokens-out, cost]
    per: [agent, run]
    output: "metrics/"
    format: jsonl
    pricing: anthropic-current
  }
}`;
      const ast = parse(src);
      expect(ast.isFragment).toBe(true);
      expect(ast.topology.name).toBe("observability");
      expect(ast.topology.patterns).toEqual([]);
      expect(ast.metering).not.toBeNull();
      expect(ast.metering!.format).toBe("jsonl");
    });

    it("fragment with hooks", () => {
      const src = `
fragment security-hooks {
  hooks {
    hook audit-log {
      on: AgentStop
      matcher: "*"
      run: "scripts/audit.sh"
      type: command
    }
  }
}`;
      const ast = parse(src);
      expect(ast.isFragment).toBe(true);
      expect(ast.topology.name).toBe("security-hooks");
      expect(ast.hooks).toHaveLength(1);
      expect(ast.hooks[0].name).toBe("audit-log");
    });
  });

  // ── Backward compatibility ──────────────────────────────────────────────

  describe("backward compatibility", () => {
    it("topology without params/interface/imports/includes has empty defaults", () => {
      const src = `
topology simple : [pipeline] {
  agent worker {
    model: sonnet
  }
  flow {
    intake -> worker -> done
  }
}`;
      const ast = parse(src);
      expect(ast.params).toEqual([]);
      expect(ast.interfaceEndpoints).toBeNull();
      expect(ast.imports).toEqual([]);
      expect(ast.includes).toEqual([]);
      expect(ast.isFragment).toBeUndefined();
    });
  });

  // ── Validator rules V53-V56 ──────────────────────────────────────────

  describe("V53-V56 composition validation", () => {
    function minimalAST(overrides: Partial<TopologyAST> = {}): TopologyAST {
      return {
        topology: { name: "test", version: "1.0.0", description: "", patterns: ["pipeline"] },
        nodes: [
          { id: "orchestrator", type: "orchestrator", label: "Orchestrator", model: "opus", handles: ["intake"] },
          { id: "intake", type: "action", label: "Intake" },
          { id: "worker", type: "agent", label: "Worker", model: "sonnet" },
        ],
        edges: [
          { from: "intake", to: "worker", condition: null, maxIterations: null },
        ],
        depth: { factors: [], levels: [] },
        memory: {},
        batch: {},
        environments: {},
        triggers: [],
        hooks: [],
        settings: {},
        mcpServers: {},
        metering: null,
        defaults: null,
        schemas: [],
        observability: null,
        skills: [],
        toolDefs: [],
        roles: {},
        context: {},
        env: {},
        providers: [],
        schedules: [],
        interfaces: [],
        params: [],
        interfaceEndpoints: null,
        imports: [],
        includes: [],
        ...overrides,
      };
    }

    // V53: param types
    it("V53: valid param types -> no error", () => {
      const ast = minimalAST({
        params: [
          { name: "key", type: "string", required: true },
          { name: "count", type: "number", required: false, default: 3 },
          { name: "flag", type: "boolean", required: false, default: true },
        ],
      });
      const results = validate(ast);
      const v53 = results.filter((r) => r.rule === "V53");
      expect(v53).toHaveLength(0);
    });

    it("V53: empty params -> no error", () => {
      const ast = minimalAST({ params: [] });
      const results = validate(ast);
      const v53 = results.filter((r) => r.rule === "V53");
      expect(v53).toHaveLength(0);
    });

    // V54: interface entry/exit must reference declared nodes
    it("V54: valid interface endpoints -> no error", () => {
      const ast = minimalAST({
        interfaceEndpoints: { entry: "intake", exit: "worker" },
      });
      const results = validate(ast);
      const v54 = results.filter((r) => r.rule === "V54");
      expect(v54).toHaveLength(0);
    });

    it("V54: invalid entry -> error", () => {
      const ast = minimalAST({
        interfaceEndpoints: { entry: "nonexistent", exit: "worker" },
      });
      const results = validate(ast);
      const v54 = results.filter((r) => r.rule === "V54");
      expect(v54).toHaveLength(1);
      expect(v54[0].message).toContain("nonexistent");
    });

    it("V54: invalid exit -> error", () => {
      const ast = minimalAST({
        interfaceEndpoints: { entry: "intake", exit: "nonexistent" },
      });
      const results = validate(ast);
      const v54 = results.filter((r) => r.rule === "V54");
      expect(v54).toHaveLength(1);
      expect(v54[0].message).toContain("nonexistent");
    });

    it("V54: both invalid -> two errors", () => {
      const ast = minimalAST({
        interfaceEndpoints: { entry: "foo", exit: "bar" },
      });
      const results = validate(ast);
      const v54 = results.filter((r) => r.rule === "V54");
      expect(v54).toHaveLength(2);
    });

    it("V54: no interface block -> no error", () => {
      const ast = minimalAST({ interfaceEndpoints: null });
      const results = validate(ast);
      const v54 = results.filter((r) => r.rule === "V54");
      expect(v54).toHaveLength(0);
    });

    // V55: unique import aliases
    it("V55: unique import aliases -> no error", () => {
      const ast = minimalAST({
        imports: [
          { source: "./a.at", alias: "alpha", params: {} },
          { source: "./b.at", alias: "beta", params: {} },
        ],
      });
      const results = validate(ast);
      const v55 = results.filter((r) => r.rule === "V55");
      expect(v55).toHaveLength(0);
    });

    it("V55: duplicate import alias -> error", () => {
      const ast = minimalAST({
        imports: [
          { source: "./a.at", alias: "research", params: {} },
          { source: "./b.at", alias: "research", params: {} },
        ],
      });
      const results = validate(ast);
      const v55 = results.filter((r) => r.rule === "V55");
      expect(v55).toHaveLength(1);
      expect(v55[0].message).toContain("research");
    });

    it("V55: no imports -> no error", () => {
      const ast = minimalAST({ imports: [] });
      const results = validate(ast);
      const v55 = results.filter((r) => r.rule === "V55");
      expect(v55).toHaveLength(0);
    });

    // V56: import source path validation
    it("V56: valid relative paths -> no error", () => {
      const ast = minimalAST({
        imports: [
          { source: "./topologies/research.at", alias: "a", params: {} },
          { source: "../shared/utils.at", alias: "b", params: {} },
        ],
      });
      const results = validate(ast);
      const v56 = results.filter((r) => r.rule === "V56");
      expect(v56).toHaveLength(0);
    });

    it("V56: registry address -> no error", () => {
      const ast = minimalAST({
        imports: [
          { source: "registry/my-topology@1.0.0", alias: "reg", params: {} },
        ],
      });
      const results = validate(ast);
      const v56 = results.filter((r) => r.rule === "V56");
      expect(v56).toHaveLength(0);
    });

    it("V56: invalid source path (bare name) -> error", () => {
      const ast = minimalAST({
        imports: [
          { source: "research.at", alias: "r", params: {} },
        ],
      });
      const results = validate(ast);
      const v56 = results.filter((r) => r.rule === "V56");
      expect(v56).toHaveLength(1);
      expect(v56[0].message).toContain("research.at");
    });

    it("V56: absolute path -> error", () => {
      const ast = minimalAST({
        imports: [
          { source: "/absolute/path.at", alias: "abs", params: {} },
        ],
      });
      const results = validate(ast);
      const v56 = results.filter((r) => r.rule === "V56");
      expect(v56).toHaveLength(1);
    });
  });
});
