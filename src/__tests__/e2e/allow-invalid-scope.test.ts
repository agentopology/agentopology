/**
 * `scaffold --allow-invalid` writes only what validation errors do not touch.
 *
 * It used to write the whole plan as if the topology were valid: one agent
 * failing V15 among seven rewrote all seven agents, settings.json, .mcp.json,
 * the rules file and every stub script, and exited 0. Now:
 * - each error is attributed to the node it names; that node's own files
 *   (its agent file, its hook scripts) are not written;
 * - files shared by the whole topology (settings.json, settings.local.json,
 *   .mcp.json, .codex/hooks.json, the topology skill, rules, scripts) are never
 *   written while any error is open: a half-built guard set is worse than none;
 * - an error that names no node writes nothing at all;
 * - the exit code is 1 while errors remain, so CI never reads it as success;
 * - a dry run lists exactly what the real run writes and skips.
 * Without the flag nothing changed.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, "../../../dist/cli/index.js");

/** Seven agents; planner's conditional edges miss `wait` (V15). planner and builder each have their own hook. */
const SEVEN = `topology seven : [pipeline] {
  meta {
    version: "1.0.0"
    description: "Seven agents; one routes on conditions that miss a value"
  }
  orchestrator { model: sonnet }
  agent planner {
    model: sonnet
    prompt { Plan the work. }
    outputs: {
      decision: go | stop | wait
    }
    hooks {
      hook plan-check {
        on: PreToolUse
        matcher: "Bash"
        run: "scripts/plan-check.sh"
        type: command
      }
    }
  }
  agent builder {
    model: sonnet
    prompt { Build it. }
    hooks {
      hook build-check {
        on: PreToolUse
        matcher: "Bash"
        run: "scripts/build-check.sh"
        type: command
      }
    }
  }
  agent tester { model: sonnet
    prompt { Test it. } }
  agent reviewer { model: sonnet
    prompt { Review it. } }
  agent documenter { model: sonnet
    prompt { Document it. } }
  agent packager { model: sonnet
    prompt { Package it. } }
  agent reporter { model: sonnet
    prompt { Report it. } }
  flow {
    planner -> builder [when planner.decision == go]
    planner -> reporter [when planner.decision == stop]
    builder -> tester
    tester -> reviewer
    reviewer -> documenter
    documenter -> packager
    packager -> reporter
  }
  hooks {
    hook log-stop {
      on: AgentStop
      run: "scripts/log-stop.sh"
      type: command
    }
  }
  mcp-servers {
    storage {
      type: stdio
      command: "npx"
      args: ["-y", "storage-mcp-server"]
    }
  }
  settings {
    allow: ["Read"]
    deny: ["Bash(rm -rf *)"]
  }
}
`;

/** The same topology with every value of planner.decision routed: no errors. */
const SEVEN_VALID = SEVEN.replace(
  "    planner -> reporter [when planner.decision == stop]\n",
  "    planner -> reporter [when planner.decision == stop]\n    planner -> reviewer [when planner.decision == wait]\n",
);

/** Two default providers (V17): an error that names no node. */
const NO_NODE = SEVEN_VALID.replace(
  "  orchestrator { model: sonnet }",
  [
    "  providers {",
    "    anthropic {",
    '      api-key: "${ANTHROPIC_API_KEY}"',
    "      models: [sonnet]",
    "      default: true",
    "    }",
    "    backup {",
    '      api-key: "${BACKUP_API_KEY}"',
    "      models: [sonnet]",
    "      default: true",
    "    }",
    "  }",
    "  orchestrator { model: sonnet }",
  ].join("\n"),
);

const AGENTS = ["planner", "builder", "tester", "reviewer", "documenter", "packager", "reporter"];
const CLEAN = AGENTS.filter((a) => a !== "planner");
const SETTINGS_BEFORE = '{\n  "permissions": {\n    "allow": ["Bash(ls)"]\n  }\n}\n';
const MCP_BEFORE = '{\n  "mcpServers": {}\n}\n';

/** relative path -> sha1 of every file under dir (none when dir is missing). */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!fs.existsSync(dir)) return out;
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.set(relative(dir, p), createHash("sha1").update(fs.readFileSync(p)).digest("hex"));
    }
  };
  walk(dir);
  return out;
}

/** The plan lines: `+ path`, `~ path ...`, `⊘ path (...)`, without colour. */
function planLines(out: string): string[] {
  return out
    .split("\n")
    .map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""))
    .filter((l) => /^ {2}[+~⊘] /.test(l))
    .sort();
}

describe("scaffold --allow-invalid writes only what the errors do not touch", () => {
  let tmp: string;
  let project: string;
  let at: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(join(os.tmpdir(), "at-allow-invalid-"));
    project = join(tmp, "project");
    fs.mkdirSync(project);
    at = join(tmp, "seven.at");
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const cli = (args: string[]) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: tmp, encoding: "utf8", timeout: 60_000 });
    return { out: `${r.stdout ?? ""}${r.stderr ?? ""}`, code: r.status };
  };
  const scaffold = (...extra: string[]) => cli(["scaffold", at, "--target", "claude-code", "--output", project, ...extra]);
  const seed = () => {
    fs.mkdirSync(join(project, ".claude"), { recursive: true });
    fs.writeFileSync(join(project, ".claude/settings.json"), SETTINGS_BEFORE);
    fs.writeFileSync(join(project, ".mcp.json"), MCP_BEFORE);
  };

  it("one agent failing V15 among seven: the six clean agents are written, settings.json and .mcp.json untouched, exit 1", () => {
    fs.writeFileSync(at, SEVEN);
    seed();
    const { out, code } = scaffold("--allow-invalid");

    expect(code).toBe(1);
    for (const a of CLEAN) expect(fs.existsSync(join(project, `.claude/agents/${a}/AGENT.md`)), a).toBe(true);
    expect(fs.existsSync(join(project, ".claude/agents/planner/AGENT.md"))).toBe(false);
    expect(fs.readFileSync(join(project, ".claude/settings.json"), "utf-8")).toBe(SETTINGS_BEFORE);
    expect(fs.readFileSync(join(project, ".mcp.json"), "utf-8")).toBe(MCP_BEFORE);
    // Shared files wait for a valid topology too.
    expect(fs.existsSync(join(project, ".claude/rules"))).toBe(false);
    expect(fs.existsSync(join(project, ".claude/skills/seven/SKILL.md"))).toBe(false);
    expect(fs.existsSync(join(project, ".claude/skills/seven/scripts/log-stop.sh"))).toBe(false);

    expect(out).toContain("⊘ .claude/agents/planner/AGENT.md (not written: node planner has validation errors)");
    expect(out).toContain("⊘ .claude/settings.json (not written while validation errors are open)");
    expect(out).toContain("⊘ .mcp.json (not written while validation errors are open)");
    expect(out).toContain("⊘ .claude/rules/seven.md (not written while validation errors are open)");
    expect(out).not.toContain("scaffolding anyway");
  });

  it("an errored node's hook script and its settings hook entry are not written; a clean node's hook script is", () => {
    fs.writeFileSync(at, SEVEN);
    const { out, code } = scaffold("--allow-invalid");

    expect(code).toBe(1);
    expect(fs.existsSync(join(project, ".claude/skills/seven/scripts/planner-plan-check.sh"))).toBe(false);
    expect(out).toContain(
      "⊘ .claude/skills/seven/scripts/planner-plan-check.sh (not written: node planner has validation errors)",
    );
    // No settings.json at all, so no hook entry pointing at a script that is not there.
    expect(fs.existsSync(join(project, ".claude/settings.json"))).toBe(false);
    expect(fs.existsSync(join(project, ".claude/skills/seven/scripts/builder-build-check.sh"))).toBe(true);
    const builder = fs.readFileSync(join(project, ".claude/agents/builder/AGENT.md"), "utf-8");
    expect(builder).toContain("builder-build-check.sh");
  });

  it("an error that names no node (V17) writes nothing, and says why", () => {
    fs.writeFileSync(at, NO_NODE);
    seed();
    const before = snapshot(project);
    const { out, code } = scaffold("--allow-invalid");

    expect(code).toBe(1);
    expect(snapshot(project)).toEqual(before);
    expect(out).toContain("[V17]");
    expect(out).toContain("Nothing was written: [V17] names no node");
  });

  it("the dry run lists exactly what the real run writes and skips", () => {
    fs.writeFileSync(at, SEVEN);
    seed();
    const dry = scaffold("--allow-invalid", "--dry-run");
    expect(dry.code).toBe(1);
    expect(fs.existsSync(join(project, ".claude/agents"))).toBe(false);

    const real = scaffold("--allow-invalid");
    expect(planLines(dry.out).length).toBeGreaterThan(0);
    expect(planLines(dry.out)).toEqual(planLines(real.out));
    // Every + line is a file now on disk; every ⊘ line is a file that is not (or is as it was).
    for (const line of planLines(real.out)) {
      const p = line.slice(4).replace(/ \(.*$/, "");
      if (line.startsWith("  + ")) expect(fs.existsSync(join(project, p)), p).toBe(true);
    }
  });

  it("over an earlier valid scaffold: the errored agent's file and settings.json stay as they were, a clean agent is updated", () => {
    fs.writeFileSync(at, SEVEN_VALID);
    expect(scaffold().code).toBe(0);
    const plannerBefore = fs.readFileSync(join(project, ".claude/agents/planner/AGENT.md"), "utf-8");
    const settingsBefore = fs.readFileSync(join(project, ".claude/settings.json"), "utf-8");

    // Both agents move to haiku; planner still fails V15.
    const toHaiku = (src: string) =>
      src.replace("agent planner {\n    model: sonnet", "agent planner {\n    model: haiku").replace("agent builder {\n    model: sonnet", "agent builder {\n    model: haiku");
    fs.writeFileSync(at, toHaiku(SEVEN));
    const { out, code } = scaffold("--allow-invalid");

    expect(code).toBe(1);
    expect(fs.readFileSync(join(project, ".claude/agents/planner/AGENT.md"), "utf-8")).toBe(plannerBefore);
    expect(fs.readFileSync(join(project, ".claude/settings.json"), "utf-8")).toBe(settingsBefore);
    expect(fs.readFileSync(join(project, ".claude/agents/builder/AGENT.md"), "utf-8")).toContain("model: haiku");
    expect(out).toContain("⊘ .claude/agents/planner/AGENT.md (not written: node planner has validation errors)");

    // Once the topology validates again, the next run writes what was held back.
    fs.writeFileSync(at, toHaiku(SEVEN_VALID));
    expect(scaffold().code).toBe(0);
    expect(fs.readFileSync(join(project, ".claude/agents/planner/AGENT.md"), "utf-8")).toContain("model: haiku");
  });

  it("without the flag nothing changed: nothing written, exit 1, the same message", () => {
    fs.writeFileSync(at, SEVEN);
    const { out, code } = scaffold();
    expect(code).toBe(1);
    expect(snapshot(project).size).toBe(0);
    expect(out).toContain(
      '  1 validation error(s). Nothing was written.\n  [V15] Node "planner" has only conditional edges on "planner.decision" but does not cover: wait\n  Run: agentopology validate seven.at (--allow-invalid scaffolds anyway)\n',
    );
  });

  it("on a valid topology the flag changes nothing: the same output and the same files", () => {
    fs.writeFileSync(at, SEVEN_VALID);
    const plain = scaffold();
    const plainFiles = snapshot(project);
    fs.rmSync(project, { recursive: true, force: true });
    fs.mkdirSync(project);
    const flagged = scaffold("--allow-invalid");

    expect(plain.code).toBe(0);
    expect(flagged.code).toBe(0);
    expect(flagged.out).toBe(plain.out);
    // The manifest carries a timestamp; every other file is byte for byte the same.
    const flaggedFiles = snapshot(project);
    plainFiles.delete(".claude/.scaffold-manifest.json");
    flaggedFiles.delete(".claude/.scaffold-manifest.json");
    expect(flaggedFiles).toEqual(plainFiles);
  });
});
