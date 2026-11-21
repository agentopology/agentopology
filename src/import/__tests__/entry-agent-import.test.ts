/**
 * Import reads `.claude/settings.json` `agent` (the agent every session starts
 * as) back into `meta { entry }` when it names an imported agent. A name the
 * import has no agent file for (a plugin's or a built-in agent) is reported,
 * not invented.
 */

import { describe, it, expect } from "vitest";
import { parse } from "../../parser/index.js";
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

  it("no agent key, no entry", () => {
    const ast = importClaudeCode([agentFile("worker"), { path: ".claude/settings.json", content: "{}" }], "t");
    expect(entryOf(ast)).toBeUndefined();
  });
});
