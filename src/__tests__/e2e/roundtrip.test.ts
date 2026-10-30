/**
 * End to end: a system built by hand comes into .at without losing anything.
 *
 * The rule (Nadav, 2026-10-29): AgentTopology gives the structure; bringing a
 * hand-built system into it must never delete its internals. Before this,
 * import then scaffold on this repo's own .claude left 0 of 72 files
 * identical, 37 missing and the rest cut down (a 404-line SKILL.md came back
 * as 9 lines), and the imported .at had 22 validation errors.
 *
 * The fixture (fixtures/handbuilt) holds what was lost: a flat and a folder
 * agent, frontmatter the language has no field for, a comma-string tools
 * list, a skill with scripts and references, a command, real permissions and
 * a hand-written hook.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import { deepMergeSettingsJson } from "../../scaffold/merge.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const CLI = resolve(root, "dist/cli/index.js");
const HANDBUILT = resolve(here, "fixtures/handbuilt");

function cli(args: string[]): { out: string; code: number } {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { out, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { out: `${e.stdout ?? ""}${e.stderr ?? ""}`, code: e.status ?? 1 };
  }
}

/** path -> sha1 of every file under dir. */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
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

let tmp: string;
let project: string;
let at: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(join(os.tmpdir(), "at-roundtrip-"));
  project = join(tmp, "project");
  fs.cpSync(HANDBUILT, project, { recursive: true });
  at = join(tmp, "handbuilt.at");
  expect(cli(["import", "--target", "claude-code", "--dir", project, "--name", "handbuilt", "--output", tmp]).code).toBe(0);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("import then scaffold loses nothing (e2e)", () => {
  it("[R3] the imported .at validates with no errors", () => {
    const errors = validate(parse(fs.readFileSync(at, "utf-8"))).filter((r) => r.level === "error");
    expect(errors.map((e) => `[${e.rule}] ${e.message}`)).toEqual([]);
  });

  it("[R1] every hand-built file is still there after scaffolding the import back", () => {
    const before = snapshot(project);
    expect(cli(["scaffold", at, "--target", "claude-code", "--output", project]).code).toBe(0);
    const after = snapshot(project);
    const missing = [...before.keys()].filter((p) => !after.has(p));
    expect(missing).toEqual([]);
  });

  it("[R2] every hand-built file is byte-identical, settings.json included", () => {
    const before = snapshot(project);
    cli(["scaffold", at, "--target", "claude-code", "--output", project]);
    const after = snapshot(project);
    const changed = [...before].filter(([p, h]) => after.get(p) !== h).map(([p]) => p);
    expect(changed).toEqual([]);
  });

  it("[A4] even --force leaves every hand-written file byte-identical", () => {
    // Two layers protect a hand-built file: scaffold keeps files it did not
    // create (G1), and file: means the binding never generates them at all.
    // --force removes the first layer, so this proves the second on its own.
    const before = snapshot(project);
    expect(cli(["scaffold", at, "--target", "claude-code", "--output", project, "--force"]).code).toBe(0);
    const after = snapshot(project);
    const changed = [...before].filter(([p, h]) => after.get(p) !== h).map(([p]) => p);
    expect(changed).toEqual([]);
  });

  it("[G12] a second scaffold of the import changes nothing", () => {
    cli(["scaffold", at, "--target", "claude-code", "--output", project]);
    expect(cli(["scaffold", at, "--target", "claude-code", "--output", project]).out).toMatch(/ 0 created, 0 updated/);
  });

  it("[R4] import keeps what the language has no field for, and the real permissions", () => {
    const ast = parse(fs.readFileSync(at, "utf-8"));
    const reviewer = ast.nodes.find((n) => n.id === "reviewer")!;
    expect(reviewer.file).toBe(".claude/agents/reviewer.md");
    // effort and color are first-class now (effort is the language's thinking)
    expect(reviewer).toMatchObject({ thinking: "high", color: "purple" });
    expect((reviewer as { tools?: string[] }).tools).toEqual(["Read", "Grep", "Glob"]);
    expect(ast.settings.allow).toContain("Read");
    expect(ast.settings.ask).toEqual(["Bash(git push:*)"]);
  });

  it("[A4] skills, commands and agents found on disk are marked file: and never generated", () => {
    const ast = parse(fs.readFileSync(at, "utf-8"));
    expect(ast.skills.find((s) => s.id === "story")?.file).toBe(".claude/skills/story/SKILL.md");
    expect(ast.triggers.find((t) => t.name === "ship")?.file).toBe(".claude/commands/ship.md");
    const paths = claudeCodeBinding.scaffold(ast).map((f) => f.path);
    expect(paths.filter((p) => p.startsWith(".claude/skills/story/"))).toEqual([]);
    expect(paths).not.toContain(".claude/commands/ship.md");
    expect(paths).not.toContain(".claude/agents/reviewer/AGENT.md");
    expect(paths).not.toContain(".claude/agents/writer/AGENT.md");
  });

  it("[G13] an agent's extensions never leak into project-wide settings", () => {
    cli(["scaffold", at, "--target", "claude-code", "--output", project]);
    const settings = JSON.parse(fs.readFileSync(join(project, ".claude/settings.json"), "utf-8"));
    expect(settings.effort).toBeUndefined();
    expect(settings.color).toBeUndefined();
  });

  it("[G14] an imported hook and its compiled form are one hook, not two", () => {
    const existing = JSON.stringify({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "bash .claude/hooks/guard.sh" }] }] },
    });
    const generated = JSON.stringify({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: 'bash "$CLAUDE_PROJECT_DIR/.claude/hooks/guard.sh"' }] }] },
    });
    const merged = JSON.parse(deepMergeSettingsJson(existing, generated));
    expect(merged.hooks.PreToolUse).toHaveLength(1);
  });
});

describe("an on-demand agent needs no flow path", () => {
  it("[G17] V11 skips a reader or writer with invocation: manual", () => {
    const src = fs.readFileSync(at, "utf-8")
      .replace("agent reviewer {", 'agent reviewer {\n    reads: ["drafts/"]')
      .replace("agent writer {", 'agent writer {\n    writes: ["drafts/"]');
    expect(validate(parse(src)).filter((r) => r.rule === "V11")).toEqual([]);
  });
});

describe("file: is checked, and scaffold's two overrides are separate", () => {
  it("[G15] V97 refuses a file: outside the project", () => {
    const src = fs.readFileSync(at, "utf-8").replace("file: .claude/agents/reviewer.md", 'file: "../elsewhere/reviewer.md"');
    const errors = validate(parse(src)).filter((r) => r.rule === "V97");
    expect(errors).toHaveLength(1);
  });

  it("[F3] --allow-invalid compiles despite errors; --force alone does not", () => {
    fs.writeFileSync(at, fs.readFileSync(at, "utf-8").replace("file: .claude/agents/reviewer.md", 'file: "../x.md"'));
    const forced = cli(["scaffold", at, "--target", "claude-code", "--output", project, "--force"]);
    expect(forced.code).toBe(1);
    expect(forced.out).toContain("Nothing was written");
    const allowed = cli(["scaffold", at, "--target", "claude-code", "--output", project, "--allow-invalid"]);
    expect(allowed.code).toBe(0);
    // --allow-invalid does not overwrite what scaffold did not create.
    expect(fs.readFileSync(join(project, ".claude/hooks/guard.sh"), "utf-8")).toContain("Blocks a push");
  });

  it("[C5] a hook's own script is never overwritten, even with --force, and not reported as a conflict", () => {
    const { out } = cli(["scaffold", at, "--target", "claude-code", "--output", project, "--force"]);
    expect(fs.readFileSync(join(project, ".claude/hooks/guard.sh"), "utf-8")).toContain("Blocks a push");
    expect(out).not.toContain("guard.sh (exists");
    const manifest = JSON.parse(fs.readFileSync(join(project, ".claude/.scaffold-manifest.json"), "utf-8"));
    expect(manifest.files[".claude/hooks/guard.sh"]).toBeUndefined();
  });

  it("[G16] scaffold names a hand-written file the project lacks", () => {
    fs.rmSync(join(project, ".claude/commands/ship.md"));
    const { out } = cli(["scaffold", at, "--target", "claude-code", "--output", project, "--dry-run"]);
    expect(out).toContain(".claude/commands/ship.md");
    expect(out).toMatch(/hand-written file\(s\) named by file: are not in/);
  });
});
