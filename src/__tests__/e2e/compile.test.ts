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
import { STUB_MARKER } from "../../bindings/lib/stub.js";

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

describe("the topology's context does not compete with the project's own", () => {
  it("[C2] context goes to .claude/rules/<topology>.md, never a CLAUDE.md", () => {
    expect([...files.keys()].filter((p) => /(^|\/)CLAUDE\.md$/.test(p))).toEqual([]);
    expect(read(".claude/rules/compile.md")).toMatch(/^# Compile\n/);
  });
});

describe("a skill's instructions reach the model", () => {
  it("[N12] prompt: path tells Claude to read and follow the file; a prompt block is the body", () => {
    const brief = read(".claude/skills/brief/SKILL.md");
    expect(brief).not.toContain("See:");
    expect(brief).toContain("Read `prompts/brief.md` before anything else and follow it");
    expect(read(".claude/skills/tone/SKILL.md")).toMatch(/## Instructions\n\n### Tone\nShort sentences\. No jargon\./);
  });
});

describe("actions, tools and schedules run what they declare", () => {
  it("[A3] an action's commands are emitted whatever its kind; one without commands is a marked stub that fails", () => {
    expect(read(".claude/skills/compile/scripts/action-fetch.sh")).toContain("curl -fsS https://feeds.example.com/brief -o brief.json");
    const digest = read(".claude/skills/compile/scripts/action-digest.sh");
    expect(digest).toContain(STUB_MARKER);
    expect(digest).toMatch(/exit 1\n$/);
    // an inline action is done in conversation: not a stub
    expect(read(".claude/skills/compile/scripts/action-intake.sh")).not.toContain(STUB_MARKER);
  });

  it("[A3b] a tool's stub goes where its script: points, never a copy beside it", () => {
    expect(files.get("tools/render.py")?.createOnly).toBe(true);
    expect(files.has(".claude/skills/compile/scripts/render.py")).toBe(false);
    expect(read(".claude/skills/compile/scripts/count.sh")).toContain(STUB_MARKER);
  });

  it("[B4] schedules run headless from the project root, call the real action path, and every: becomes cron", () => {
    const nightly = read("scripts/schedule-nightly.sh");
    expect(nightly).toContain('cd "$(dirname "$0")/.."');
    expect(nightly).toContain('claude -p "Run your scheduled task (nightly)." --agent drafter');
    expect(read("scripts/schedule-weekly-digest.sh")).toContain("bash .claude/skills/compile/scripts/action-digest.sh");
    const cron = read("crontab.fragment");
    expect(cron).toContain("*/15 * * * * bash scripts/schedule-nightly.sh");
    expect(cron).toContain("0 0 * * 0 bash scripts/schedule-weekly-digest.sh");
    // 7 minutes has no cron form: left commented, and scaffold warns
    expect(cron).toContain("# every: 7m bash scripts/schedule-odd.sh");
  });
});

describe("nothing written in the .at is dropped without a message", () => {
  it("[N21] a gate (or hook, tool, job) outside its container block is a V98 error, not silently ignored", () => {
    const src = fs.readFileSync(resolve(here, "fixtures/compile.at"), "utf-8").replace(
      "  flow {",
      '  gate stray {\n    after: drafter\n    run: "scripts/stray.sh"\n  }\n\n  job lost {\n    cron: "0 * * * *"\n    agent: drafter\n  }\n\n  flow {',
    );
    const v98 = validate(parse(src)).filter((r) => r.rule === "V98");
    expect(v98.map((r) => r.message)).toEqual([
      '"gate stray" is outside a "gates { }" block, so it is ignored — move it inside "gates { ... }"',
      '"job lost" is outside a "schedule { }" block, so it is ignored — move it inside "schedule { ... }"',
    ]);
    expect(v98.every((r) => r.level === "error")).toBe(true);
  });

  it("[N21] no shipped example trips V98", () => {
    const dir = resolve(here, "../../../examples");
    const hits = fs.readdirSync(dir).filter((f) => f.endsWith(".at"))
      .filter((f) => validate(parse(fs.readFileSync(resolve(dir, f), "utf-8"))).some((r) => r.rule === "V98"));
    expect(hits).toEqual([]);
  });
});

describe("references resolve", () => {
  it("[N18] an undeclared skill, MCP server or skill agent is a V99 warning", () => {
    const src = fs.readFileSync(resolve(here, "fixtures/compile.at"), "utf-8")
      .replace('    permissions: bypass\n', '    permissions: bypass\n    skills: [tone, toen]\n    mcp-servers: [search, serch]\n')
      .replace('    description: "Write a brief"\n', '    description: "Write a brief"\n    agent: draftr\n');
    const v99 = validate(parse(src)).filter((r) => r.rule === "V99");
    expect(v99.map((r) => r.message.split(",")[0])).toEqual([
      'Agent "auditor" uses skill "toen"',
      'Agent "auditor" uses MCP server "serch"',
      'Skill "brief" runs in agent "draftr"',
    ]);
    expect(v99.every((r) => r.level === "warning")).toBe(true);
    // declared names and built-in agents pass
    expect(validate(ast).filter((r) => r.rule === "V99")).toEqual([]);
  });
});

describe("model ids are checked for the target", () => {
  it("[N16] a model Claude Code does not have is omitted with a warning; aliases and claude-* ids pass", () => {
    const src = fs.readFileSync(resolve(here, "fixtures/compile.at"), "utf-8")
      .replace("  agent auditor {\n    model: sonnet", "  agent auditor {\n    model: gpt-4o")
      .replace("  agent drafter {\n    model: sonnet", "  agent drafter {\n    model: claude-opus-5-5");
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => void warnings.push(a.join(" "));
    let out: Map<string, string>;
    try {
      out = new Map(claudeCodeBinding.scaffold(parse(src)).map((f) => [f.path, f.content]));
    } finally {
      console.warn = warn;
    }
    expect(out.get(".claude/agents/auditor/AGENT.md")).not.toMatch(/^model:/m);
    expect(warnings.some((w) => w.includes('model "gpt-4o" is not a Claude Code model'))).toBe(true);
    expect(out.get(".claude/agents/drafter/AGENT.md")).toMatch(/^model: claude-opus-5-5$/m);
  });
});

describe("phase 4: the language says what Claude Code can do", () => {
  const scaffoldWarnings = (src: string) => {
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => void warnings.push(a.join(" "));
    try {
      claudeCodeBinding.scaffold(parse(src));
    } finally {
      console.warn = warn;
    }
    return warnings;
  };
  const fixture = fs.readFileSync(resolve(here, "fixtures/compile.at"), "utf-8");
  const rule = (src: string, id: string) => validate(parse(src)).filter((r) => r.rule === id);

  it("[F1] agent color, initial-prompt, omit-claude-md and thinking (as effort), and skill fields, are first-class", () => {
    expect(auditor).toContain("effort: max\ncolor: orange\ninitialPrompt: Start with the newest draft.\nomitClaudeMd: true");
    const tone = read(".claude/skills/tone/SKILL.md");
    for (const line of [
      "disallowed-tools: Bash", "when_to_use: Before any draft is shown to a reader", 'argument-hint: "<draft path>"',
      "arguments:\n  - draft", "paths:\n  - drafts/**/*.md", "shell: bash", "model: haiku", "effort: low",
    ]) expect(tone).toContain(line);
  });

  it("[F2] hooks are a typed union: http, mcp_tool, agent and async command hooks compile to their own shapes", () => {
    expect(settings.hooks.Notification).toEqual([{ hooks: [{ type: "http", url: "https://hooks.example.com/claude" }] }]);
    expect(settings.hooks.PostToolUse).toContainEqual({ matcher: "Write", hooks: [{ type: "mcp_tool", server: "notes", tool: "append" }] });
    expect(settings.hooks.SubagentStop).toContainEqual({
      hooks: [{ type: "agent", prompt: "Check the subagent's answer cites a source; reply ok false if not." }],
    });
    expect(JSON.stringify(settings.hooks.PostToolUse)).toContain('"async":true');
    // no shell stub for a hook that runs no script
    expect([...files.keys()].filter((p) => /notify|record|second-look/.test(p))).toEqual([]);
  });

  it("[F2] V100: each hook type needs its fields, on an event that takes it", () => {
    const bad = fixture
      .replace('      url: "https://hooks.example.com/claude"\n', "")
      .replace('      tool: "append"\n', "")
      .replace("    hook second-look {\n      on: SubagentStop", "    hook second-look {\n      on: SessionEnd");
    expect(rule(bad, "V100").map((r) => r.message)).toEqual([
      'Hook "notify" is type http but has no url: — name the endpoint the event is sent to.',
      'Hook "record" is type mcp_tool but needs server: and tool:.',
      'Hook "second-look" is a agent hook on SessionEnd, which Claude Code runs only command, http and mcp_tool hooks for — it would never fire.',
    ]);
    expect(rule(fixture, "V100")).toEqual([]);
  });

  it("[M1] runs: fork and runs: inline compile to skills (context: fork for fork), never to a subagent", () => {
    expect(files.has(".claude/agents/critic/AGENT.md")).toBe(false);
    expect(files.has(".claude/agents/tidy/AGENT.md")).toBe(false);
    expect(read(".claude/skills/critic/SKILL.md")).toMatch(/^context: fork$/m);
    expect(read(".claude/skills/tidy/SKILL.md")).not.toMatch(/^context:/m);
    expect(read(".claude/skills/tidy/SKILL.md")).toMatch(/^disable-model-invocation: true$/m);
    expect(read(".claude/skills/compile/SKILL.md")).toContain("- **tidy**: invoke the `tidy` skill yourself; it runs in your own context.");
    expect(rule(fixture.replace("runs: inline", "runs: thread"), "V101").map((r) => r.message)).toEqual([
      'Agent "tidy" has runs: thread — a node runs as subagent, inline, fork.',
    ]);
  });

  it("[M2] an independent node is told to judge only its artifacts, the playbook hands it nothing else, and it cannot run inline", () => {
    expect(read(".claude/skills/critic/SKILL.md")).toContain("## Independence\n\nYou are independent of the author");
    expect(read(".claude/skills/compile/SKILL.md")).toContain("it is independent: hand it only the artifacts it reads, never your reasoning");
    expect(rule(fixture.replace("runs: fork", "runs: inline"), "V101").map((r) => r.message)[0]).toContain(
      'Agent "critic" is independent but runs inline',
    );
  });

  it("[B5] an agent asking for a looser permission mode gets a warning: a subagent cannot widen its session", () => {
    const w = scaffoldWarnings(fixture);
    expect(w.some((m) => m.includes('Agent "auditor" permissions: bypass compiles to permissionMode bypassPermissions'))).toBe(true);
    expect(w.some((m) => m.includes('Agent "drafter" permissions'))).toBe(false); // confirm is the default, no warning
  });
});
