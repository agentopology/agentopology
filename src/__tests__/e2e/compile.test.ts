/**
 * End to end: what scaffold writes, Claude Code reads as meant.
 *
 * Phase 3 of the compile audit. Each test is a construct that used to compile
 * to config Claude Code skipped (an agent without a description, a url server
 * without type), misread (`yes` as a boolean, a regex matcher breaking YAML)
 * or never fired (a hook on AgentStop, a prompt hook sent as a command). The
 * fixture (fixtures/compile.at) holds them all; the live suite starts real
 * Claude Code on it too.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { scriptNameFromRun, runParts } from "../../parser/run.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";

const here = dirname(fileURLToPath(import.meta.url));
const ast = parse(fs.readFileSync(resolve(here, "fixtures/compile.at"), "utf-8"));
const files = new Map(claudeCodeBinding.scaffold(ast).map((f) => [f.path, f]));
const read = (p: string) => {
  const f = files.get(p);
  if (!f) throw new Error(`not generated: ${p}`);
  return f.content;
};
const settings = JSON.parse(read(".claude/settings.json"));
const drafter = read(".claude/agents/drafter/AGENT.md");
const auditor = read(".claude/agents/auditor/AGENT.md");

describe("the fixture itself", () => {
  it("validates with no errors", () => {
    expect(validate(ast).filter((r) => r.level === "error")).toEqual([]);
  });
});

describe("hooks fire on events Claude Code has, in the form it reads", () => {
  it("[N5] a prompt hook is a prompt handler, in settings and in an agent's frontmatter", () => {
    expect(settings.hooks.Stop[0].hooks[0]).toEqual({
      type: "prompt",
      prompt: "Check the session ended with a summary: reply ok true or false.",
    });
    expect(drafter).toContain('- type: "prompt"\n          prompt: "Did the draft cite a source? Answer ok: false if not."');
    // and no shell stub is planned for a prompt
    expect([...files.keys()].filter((p) => /judge|review/.test(p))).toEqual([]);
  });

  it("[N6] universal events map to Claude Code's (AgentStop is SubagentStop; Stop inside an agent)", () => {
    expect(settings.hooks.AgentStop).toBeUndefined();
    expect(settings.hooks.SubagentStop.map((e: { matcher?: string }) => e.matcher)).toContain("drafter");
    expect(drafter).not.toContain("AgentStop");
    expect(drafter).toMatch(/^ {2}Stop:$/m);
  });

  it("[N9] a regex matcher stays a valid YAML string in an agent's frontmatter", () => {
    // `\.` inside a YAML double-quoted string is an invalid escape: the whole
    // frontmatter failed to parse and Claude Code dropped the agent.
    expect(drafter).toContain(String.raw`- matcher: "Edit|Write\\.md$"`);
  });
});

describe("agents register as written", () => {
  it("[N10] a manual agent keeps its description (Claude Code skips an agent without one) and says it runs on request", () => {
    expect(auditor).toMatch(/^description: Audits a draft on request\. Use only when the user asks for this agent by name/m);
  });

  it("[N8] permissions confirm and bypass compile to real permissionMode values", () => {
    expect(drafter).not.toContain("permissionMode");
    expect(auditor).toContain("permissionMode: bypassPermissions");
  });

  it("[N17] a scalar YAML would read as another type is quoted", () => {
    expect(drafter).toContain('description: "yes"');
    expect(drafter).toMatch(/^model: sonnet$/m);
  });
});

describe("MCP and permissions", () => {
  it("[N4] a url server gets type: http, so Claude Code does not skip it", () => {
    const mcp = JSON.parse(read(".mcp.json"));
    expect(mcp.mcpServers.search).toEqual({ url: "https://search.example.com/mcp", type: "http" });
  });

  it("[N7] MCP names convert whole-server, wildcard and dotted forms, in tools and in permissions", () => {
    expect(drafter).toContain('tools: "Read, mcp__notes, mcp__search__*, mcp__search__find.all"');
    expect(settings.permissions.allow).toEqual(["Read", "mcp__search"]);
    expect(settings.permissions.deny).toEqual(["mcp__notes__delete"]);
  });

  it("[N14] settings ask rules are emitted", () => {
    expect(settings.permissions.ask).toEqual(["Bash(git push:*)"]);
  });
});

describe("a run: line is a command with arguments", () => {
  it("[C3] the script is the word after the interpreter, never an argument", () => {
    const run = "python3 docs/tools/check.py check-dir docs/show/SLUG --out OUT/frames-critic.json";
    expect(runParts(run)).toEqual({
      interpreter: "python3",
      script: "docs/tools/check.py",
      args: ["check-dir", "docs/show/SLUG", "--out", "OUT/frames-critic.json"],
    });
    expect(scriptNameFromRun(run)).toBe("check.py");
    const planned = [...files.keys()];
    expect(planned.filter((p) => /SLUG|frames-critic/.test(p))).toEqual([]);
    // the gate runs the real script, from the project root, arguments kept
    expect(read(".claude/skills/compile/scripts/gate-copy-check.sh")).toContain(
      'python3 "$CLAUDE_PROJECT_DIR/docs/tools/check.py" check-dir docs/show/SLUG --out OUT/frames-critic.json',
    );
    // a stub fills the gap only until the user's script exists
    expect(files.get("docs/tools/check.py")?.createOnly).toBe(true);
  });

  it("[N19] scaffold output is byte-stable: no date in any generated file", () => {
    const today = new Date().toISOString().slice(0, 10);
    expect([...files.values()].filter((f) => f.content.includes(today)).map((f) => f.path)).toEqual([]);
  });
});

describe("gates and human steps are enforced before the agent they guard", () => {
  const script = read(".claude/skills/compile/scripts/before-agent.sh");

  it("[C4] a gate after an action runs before its next agent launches (PreToolUse on the Agent tool)", () => {
    expect(settings.hooks.PreToolUse).toContainEqual({
      matcher: "Agent|Task",
      hooks: [{ type: "command", command: 'bash "$CLAUDE_PROJECT_DIR/.claude/skills/compile/scripts/before-agent.sh"' }],
    });
    expect(script).toMatch(/drafter\)\n[\s\S]*bash "\$DIR\/gate-brief-check\.sh" >&2 \|\| exit 2/);
    // not also a SubagentStop hook on a node Claude Code never registers
    const matchers = settings.hooks.SubagentStop.map((e: { matcher?: string }) => e.matcher);
    expect(matchers).not.toContain("intake");
  });

  it("[H1] a human node is an approval step: Claude Code asks before launching the next agent; no AGENT.md", () => {
    expect([...files.keys()]).not.toContain(".claude/agents/approve/AGENT.md");
    expect(script).toContain(`ask 'Approval step "approve": The editor approves the brief before drafting'`);
    expect(script).toContain(`permissionDecision: "ask"`);
    expect(read(".claude/skills/compile/SKILL.md")).toMatch(/## Approval steps[\s\S]*### Approve\nThe editor approves/);
  });
});
