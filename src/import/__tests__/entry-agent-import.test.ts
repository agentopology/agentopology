/**
 * Import reads `.claude/settings.json` `agent` (the agent every session starts
 * as) back into `meta { entry }` when it names an imported agent. A name the
 * import has no agent file for (a plugin's or a built-in agent) is reported,
 * not invented.
 */

import { describe, it, expect, vi } from "vitest";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import type { AgentNode } from "../../parser/ast.js";
import { serializeAST } from "../serializer.js";
import { importClaudeCode, parseSettingsJson } from "../claude-code.js";
import type { PlatformFile } from "../../sync/index.js";
import type { TopologyAST } from "../../parser/ast.js";

/** Read through casts so this file compiles before the fields exist. */
const entryOf = (ast: TopologyAST) => (ast.topology as { entry?: string }).entry;
const settingsAgent = (content: string) => (parseSettingsJson(content) as { agent?: string }).agent;

const agentFile = (id: string): PlatformFile => ({
  path: `.claude/agents/${id}.md`,
  content: `---\nname: ${id}\ndescription: ${id} agent\nmodel: sonnet\n---\nDo ${id} work.\n`,
});

describe("import: settings.json agent becomes meta { entry }", () => {
  it("parseSettingsJson returns the agent key", () => {
    expect(settingsAgent(JSON.stringify({ agent: "lead" }))).toBe("lead");
    expect(settingsAgent(JSON.stringify({}))).toBeUndefined();
  });

  it("sets topology.entry when the agent was imported, and the .at round-trips", () => {
    const files: PlatformFile[] = [
      agentFile("lead"),
      agentFile("worker"),
      { path: ".claude/settings.json", content: JSON.stringify({ agent: "lead" }) },
    ];
    const ast = importClaudeCode(files, "t");
    expect(entryOf(ast)).toBe("lead");
    const text = serializeAST(ast);
    expect(text).toMatch(/^\s+entry: lead$/m);
    expect(entryOf(parse(text))).toBe("lead");
  });

  it("does not set entry for an agent it has no file for, and says so", () => {
    let warnings: string[] = [];
    const files: PlatformFile[] = [
      agentFile("worker"),
      { path: ".claude/settings.json", content: JSON.stringify({ agent: "my-plugin:reviewer" }) },
    ];
    const ast = importClaudeCode(files, "t", (r) => { warnings = r.warnings ?? []; });
    expect(entryOf(ast)).toBeUndefined();
    expect(warnings.some((w) => w.includes("my-plugin:reviewer"))).toBe(true);
  });

  it("matches settings agent against an agent file's frontmatter name, sets entry to the node id, and keeps the name", () => {
    const files: PlatformFile[] = [
      { path: ".claude/agents/review.md", content: `---\nname: code-reviewer\ndescription: Reviews\nmodel: sonnet\n---\nReview.\n` },
      agentFile("worker"),
      { path: ".claude/settings.json", content: JSON.stringify({ agent: "code-reviewer" }) },
    ];
    const ast = importClaudeCode(files, "t");
    expect(entryOf(ast)).toBe("review");
    const text = serializeAST(ast);
    const back = parse(text);
    expect(entryOf(back)).toBe("review");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const settings = JSON.parse(claudeCodeBinding.scaffold(back).find((f) => f.path === ".claude/settings.json")!.content);
      expect(settings.agent).toBe("code-reviewer");
    } finally {
      warn.mockRestore();
    }
  });

  it("the entry agent is not stamped invocation: manual, and the imported .at validates clean", () => {
    const files: PlatformFile[] = [
      agentFile("lead"),
      agentFile("worker"),
      { path: ".claude/settings.json", content: JSON.stringify({ agent: "lead" }) },
    ];
    const ast = importClaudeCode(files, "t");
    const lead = ast.nodes.find((n) => n.id === "lead") as AgentNode;
    expect(lead.invocation).toBeUndefined();
    const back = parse(serializeAST(ast));
    expect(validate(back).filter((r) => r.level === "error")).toEqual([]);
    expect((back.nodes.find((n) => n.id === "lead") as AgentNode).invocation).toBeUndefined();
  });

  it("the flow report does not list the entry agent as imported manual", () => {
    let unwired: string[] = [];
    const files: PlatformFile[] = [
      agentFile("lead"),
      agentFile("worker"),
      { path: ".claude/settings.json", content: JSON.stringify({ agent: "lead" }) },
    ];
    importClaudeCode(files, "t", (r) => { unwired = r.unwired; });
    expect(unwired).toEqual(["worker"]);
  });

  it("the no-match warning says what it checked, without guessing", () => {
    let warnings: string[] = [];
    const files: PlatformFile[] = [
      agentFile("worker"),
      { path: ".claude/settings.json", content: JSON.stringify({ agent: "ghost" }) },
    ];
    importClaudeCode(files, "t", (r) => { warnings = r.warnings ?? []; });
    const w = warnings.find((x) => x.includes("ghost"))!;
    expect(w).toMatch(/no imported agent has that name or id/);
    expect(w).not.toMatch(/plugin/);
  });

  it("no agent key, no entry", () => {
    const ast = importClaudeCode([agentFile("worker"), { path: ".claude/settings.json", content: "{}" }], "t");
    expect(entryOf(ast)).toBeUndefined();
  });
});
