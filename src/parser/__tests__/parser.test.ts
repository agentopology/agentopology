import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "../index.js";
import { validate } from "../validator.js";
import type { TopologyAST, AgentNode, GateNode, OrchestratorNode } from "../ast.js";
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
      expect(ast.edges[0]).toEqual({ from: "a", to: "b", condition: null, maxIterations: null });
      expect(ast.edges[1]).toEqual({ from: "b", to: "c", condition: null, maxIterations: null });
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
      skills: [],
      toolDefs: [],
      roles: {},
      context: {},
      env: {},
      providers: [],
      schedules: [],
      interfaces: [],
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
