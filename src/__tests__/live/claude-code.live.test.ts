/**
 * Live: real Claude Code loads what scaffold generates.
 *
 * Unit tests check the files we write; only Claude Code can say whether it
 * reads them. This scaffolds every example (and the hazards fixture) into a
 * temporary project, starts a headless `claude -p` session there, and checks
 * the session's init report: every generated agent, skill and command is
 * registered, and the session itself succeeds.
 *
 * It found the first bug the moment it ran: settings `env` carried the literal
 * text "${ANTHROPIC_API_KEY}", which Claude Code applied as the key, so every
 * session in 6 of the 10 example projects failed with "Invalid API key".
 *
 * Opt-in, because it needs the `claude` CLI and makes one small model call per
 * project:  AT_LIVE=1 npx vitest run src/__tests__/live
 * The session is isolated from the developer's own setup: user settings (and
 * their hooks), MCP servers and session history are all left out.
 */

import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { resolve, dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const CLI = resolve(root, "dist/cli/index.js");

const LIVE = process.env.AT_LIVE === "1";

/**
 * The installed Claude Code, not a copy under some node_modules/.bin: npx puts
 * every ancestor's node_modules/.bin first on PATH, and a stale 1.0.x found
 * there rejected today's flags. AT_CLAUDE_BIN overrides.
 */
function claudeBin(): string {
  if (process.env.AT_CLAUDE_BIN) return process.env.AT_CLAUDE_BIN;
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (dir.includes("node_modules")) continue;
    const candidate = join(dir, "claude");
    if (fs.existsSync(candidate)) return candidate;
  }
  return "claude";
}

interface InitReport {
  agents: string[];
  skills: string[];
  slash_commands: string[];
}

interface LiveRun {
  init: InitReport;
  result: { is_error: boolean; result: string };
  stderr: string;
  events: Array<Record<string, unknown>>;
}

function runClaude(cwd: string, prompt = "Reply with the single word OK.", maxTurns = 1): LiveRun {
  const proc = spawnSync(
    claudeBin(),
    [
      "-p",
      prompt,
      "--setting-sources", "project,local",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--model", "haiku",
      "--max-turns", String(maxTurns),
      "--output-format", "stream-json",
      "--verbose",
    ],
    { cwd, encoding: "utf8", timeout: 180_000 },
  );
  const lines = (proc.stdout ?? "").split("\n").filter((l) => l.trim().startsWith("{"));
  const events = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  const init = events.find((e) => e.type === "system" && e.subtype === "init") as unknown as InitReport;
  const result = events.find((e) => e.type === "result") as unknown as LiveRun["result"];
  if (!init || !result) {
    throw new Error(`claude produced no init/result (exit ${proc.status}): ${proc.stderr}`);
  }
  return { init, result, stderr: proc.stderr ?? "", events };
}

/**
 * `name:` from a generated agent file's frontmatter, or null when it has none.
 * Human nodes are written to .claude/agents/<id>/AGENT.md without frontmatter;
 * Claude Code ignores such a file (open finding H1: they should compile to an
 * approval step), so only files that declare a subagent are expected to load.
 */
function frontmatterName(path: string): string | null {
  const m = fs.readFileSync(path, "utf-8").match(/^---\n[\s\S]*?^name:\s*"?([^"\n]+)"?\s*$/m);
  return m ? m[1].trim() : null;
}

const projects = [
  ...fs.readdirSync(resolve(root, "examples")).filter((f) => f.endsWith(".at")).map((f) => resolve(root, "examples", f)),
  resolve(here, "../e2e/fixtures/hazards.at"),
];

describe.skipIf(!LIVE)("[L1] Claude Code loads every scaffolded project", () => {
  it.each(projects.map((p) => [basename(p), p]))("%s", (_name, atFile) => {
    const project = fs.mkdtempSync(join(os.tmpdir(), "at-live-"));
    try {
      execFileSync(process.execPath, [CLI, "scaffold", atFile, "--target", "claude-code", "--output", project], {
        stdio: "ignore",
      });
      const run = runClaude(project);

      const agentsDir = join(project, ".claude/agents");
      const agents = fs.existsSync(agentsDir)
        ? fs.readdirSync(agentsDir)
            .map((d) => frontmatterName(join(agentsDir, d, "AGENT.md")))
            .filter((n): n is string => n !== null)
        : [];
      const skillsDir = join(project, ".claude/skills");
      const skills = fs.existsSync(skillsDir)
        ? fs.readdirSync(skillsDir).filter((d) => fs.existsSync(join(skillsDir, d, "SKILL.md")))
        : [];
      const commandsDir = join(project, ".claude/commands");
      const commands = fs.existsSync(commandsDir)
        ? fs.readdirSync(commandsDir).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, ""))
        : [];

      expect(run.result.is_error, `session failed: ${run.result.result}`).toBe(false);
      for (const a of agents) expect(run.init.agents, `agent ${a}`).toContain(a);
      for (const s of skills) expect(run.init.skills, `skill ${s}`).toContain(s);
      for (const c of commands) expect(run.init.slash_commands, `command ${c}`).toContain(c);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  }, 200_000);
});

describe.skipIf(!LIVE)("[L2] Claude Code loads a hand-built project after import then scaffold", () => {
  it("handbuilt fixture", () => {
    const tmp = fs.mkdtempSync(join(os.tmpdir(), "at-live-rt-"));
    const project = join(tmp, "project");
    try {
      fs.cpSync(resolve(here, "../e2e/fixtures/handbuilt"), project, { recursive: true });
      execFileSync(process.execPath, [CLI, "import", "--target", "claude-code", "--dir", project, "--name", "handbuilt", "--output", tmp], { stdio: "ignore" });
      execFileSync(process.execPath, [CLI, "scaffold", join(tmp, "handbuilt.at"), "--target", "claude-code", "--output", project], { stdio: "ignore" });
      const run = runClaude(project);
      expect(run.result.is_error, `session failed: ${run.result.result}`).toBe(false);
      for (const a of ["reviewer", "writer"]) expect(run.init.agents, `agent ${a}`).toContain(a);
      expect(run.init.skills).toContain("story");
      expect(run.init.slash_commands).toContain("ship");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 200_000);
});

describe.skipIf(!LIVE)("[L3] Claude Code reads the phase-3 constructs as meant", () => {
  it("compile.at: a manual agent registers, and a prompt hook fires", () => {
    const project = fs.mkdtempSync(join(os.tmpdir(), "at-live-compile-"));
    try {
      execFileSync(process.execPath, [CLI, "scaffold", resolve(here, "../e2e/fixtures/compile.at"), "--target", "claude-code", "--output", project], {
        stdio: "ignore",
      });
      const run = runClaude(project);
      // drafter carries a regex matcher and a prompt hook in its frontmatter: a
      // YAML error there would drop it. auditor is manual: without a
      // description Claude Code skipped it.
      expect(run.init.agents).toEqual(expect.arrayContaining(["drafter", "auditor"]));
      // runs: fork and runs: inline are skills, not agents (M1); auditor's new
      // frontmatter (color, initialPrompt, omitClaudeMd, effort) still loads (F1)
      expect(run.init.skills).toEqual(expect.arrayContaining(["critic", "tidy"]));
      // tone has paths: ["drafts/**/*.md"]: Claude Code holds a path-scoped
      // skill back until matching files are in play, so the field is honoured
      expect(run.init.skills).not.toContain("tone");
      expect(run.init.agents).not.toContain("critic");
      // The fixture's Stop prompt hook asks for a summary; "OK" is not one, so
      // Claude Code feeds the hook's verdict back: proof the prompt handler ran
      // (as a command it would have failed to execute).
      const fed = run.events.some((e) => e.type === "user" && JSON.stringify(e).includes("Stop hook feedback"));
      expect(fed, "the Stop prompt hook did not run").toBe(true);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  }, 200_000);
});

describe.skipIf(!LIVE)("[L4] Claude Code enforces a gate and an approval step before launching an agent", () => {
  const launch = "Launch the drafter subagent with the task: write one line about tea. Do nothing else.";
  const toolResults = (run: LiveRun) => JSON.stringify(run.events.filter((e) => e.type === "user"));

  it.each([
    ["a failing gate blocks the launch", "#!/usr/bin/env bash\necho 'brief missing' >&2\nexit 1\n", "Gate 'brief-check' FAILED"],
    ["a passing gate reaches the approval step, which asks (headless: denies with its reason)", "#!/usr/bin/env bash\nexit 0\n", 'Approval step \\"approve\\"'],
  ])("%s", (_name, gateScript, expected) => {
    const project = fs.mkdtempSync(join(os.tmpdir(), "at-live-before-"));
    try {
      execFileSync(process.execPath, [CLI, "scaffold", resolve(here, "../e2e/fixtures/compile.at"), "--target", "claude-code", "--output", project], {
        stdio: "ignore",
      });
      fs.writeFileSync(join(project, ".claude/skills/compile/scripts/brief-check.sh"), gateScript);
      const run = runClaude(project, launch, 2);
      const launched = run.events.some((e) => e.type === "assistant" && JSON.stringify(e).includes('"subagent_type":"drafter"'));
      expect(launched, "the model never tried to launch drafter").toBe(true);
      expect(toolResults(run)).toContain(expected);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  }, 200_000);
});

describe.skipIf(!LIVE)("[L5] Claude Code loads the topology context from .claude/rules", () => {
  it("compile.at: a line in .claude/rules/compile.md reaches the session", () => {
    const project = fs.mkdtempSync(join(os.tmpdir(), "at-live-rules-"));
    try {
      execFileSync(process.execPath, [CLI, "scaffold", resolve(here, "../e2e/fixtures/compile.at"), "--target", "claude-code", "--output", project], {
        stdio: "ignore",
      });
      fs.appendFileSync(join(project, ".claude/rules/compile.md"), "\nThe project codeword is TEAPOT-7731.\n");
      const run = runClaude(project, "Without using any tools: what is the project codeword? Reply with just the codeword, or NONE.");
      expect(run.result.result ?? JSON.stringify(run.events)).toContain("TEAPOT-7731");
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  }, 200_000);
});
