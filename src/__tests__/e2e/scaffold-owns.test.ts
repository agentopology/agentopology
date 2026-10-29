/**
 * End to end: scaffold only changes what it owns.
 *
 * Each test runs the built CLI as a user would, against a temporary project
 * that holds the hazards a real harness hit on 2026-10-28. Test names carry
 * the guarantee id from spec/testing.md; spec-testing-sync.test.ts fails if a
 * guarantee there has no test here or elsewhere.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const CLI = resolve(root, "dist/cli/index.js");
const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/hazards.at");

function cli(args: string[]): { out: string; code: number } {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { out, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { out: `${e.stdout ?? ""}${e.stderr ?? ""}`, code: e.status ?? 1 };
  }
}

let tmp: string;
let project: string;
let otherRepo: string;
let at: string;

const file = (rel: string) => join(project, rel);
const read = (rel: string) => fs.readFileSync(file(rel), "utf-8");
const put = (rel: string, content: string) => {
  fs.mkdirSync(dirname(file(rel)), { recursive: true });
  fs.writeFileSync(file(rel), content);
};
const scaffold = (...extra: string[]) =>
  cli(["scaffold", at, "--target", "claude-code", "--output", project, ...extra]);

const USER_SETTINGS = {
  permissions: { ask: ["Bash(git push:*)"], defaultMode: "acceptEdits" },
  hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "bash ./my-guard.sh" }] }] },
};

beforeEach(() => {
  tmp = fs.mkdtempSync(join(os.tmpdir(), "at-e2e-"));
  project = join(tmp, "project");
  otherRepo = join(tmp, "other-repo");
  at = join(tmp, "hazards.at");
  fs.copyFileSync(FIXTURE, at);

  // A hand-written skill, a skill linked from another repository, and the
  // user's own settings — what the content repo actually had.
  put(".claude/skills/story/SKILL.md", "REAL STORY SKILL\n");
  fs.mkdirSync(join(otherRepo, "the-book"), { recursive: true });
  fs.writeFileSync(join(otherRepo, "the-book/SKILL.md"), "OTHER REPO BOOK\n");
  fs.symlinkSync(join(otherRepo, "the-book"), file(".claude/skills/the-book"));
  put(".claude/settings.json", JSON.stringify(USER_SETTINGS, null, 2));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("scaffold only changes what it owns (e2e)", () => {
  it("[G1] the first scaffold keeps a file it did not create", () => {
    const { out, code } = scaffold();
    expect(code).toBe(0);
    expect(read(".claude/skills/story/SKILL.md")).toBe("REAL STORY SKILL\n");
    expect(out).toContain("exists, not created by scaffold — kept");
    expect(fs.existsSync(file(".claude/agents/writer/AGENT.md"))).toBe(true);
  });

  it("[G2] never writes through a symlink, even with --force", () => {
    scaffold("--force");
    expect(fs.readFileSync(join(otherRepo, "the-book/SKILL.md"), "utf-8")).toBe("OTHER REPO BOOK\n");
  });

  it("[G3] keeps the user's hooks, ask rules and defaultMode across runs", () => {
    scaffold();
    scaffold();
    const settings = JSON.parse(read(".claude/settings.json"));
    expect(settings.permissions.ask).toEqual(["Bash(git push:*)"]);
    expect(settings.permissions.defaultMode).toBe("acceptEdits");
    expect(JSON.stringify(settings.hooks)).toContain("my-guard.sh");
    expect(settings.permissions.allow).toContain("Read");
  });

  it("[G4] a second run changes nothing", () => {
    scaffold();
    const { out } = scaffold();
    expect(out).toMatch(/ 0 created, 0 updated, \d+ unchanged/);
  });

  it("[G5] --dry-run writes nothing", () => {
    const before = fs.readdirSync(project, { recursive: true }).length;
    expect(scaffold("--dry-run").code).toBe(0);
    expect(fs.readdirSync(project, { recursive: true }).length).toBe(before);
  });

  it("[G6] prose in a gate's run fails validate and scaffold, and nothing is written", () => {
    const prose = "pxframes gate mean >= 3.85, no frame < 3; frames 0.0 / 0.5 / 3.0 s differ";
    fs.writeFileSync(at, fs.readFileSync(at, "utf-8").replace('run: "scripts/check-quality.sh"', `run: "${prose}"`));
    const v = cli(["validate", at]);
    expect(v.code).toBe(1);
    expect(v.out).toContain("[V96]");
    const s = scaffold();
    expect(s.code).toBe(1);
    expect(s.out).toContain("Nothing was written");
    expect(fs.existsSync(file(".claude/agents"))).toBe(false);
  });

  it("[G7] an edited file scaffold owns is kept on the next run", () => {
    scaffold();
    put(".claude/CLAUDE.md", read(".claude/CLAUDE.md") + "my own note\n");
    const { out } = scaffold();
    expect(read(".claude/CLAUDE.md")).toContain("my own note");
    expect(out).toContain(".claude/CLAUDE.md (user edited — kept)");
  });

  it("[G8] --prune removes untouched leftovers and keeps edited ones", () => {
    scaffold();
    const wrapper = ".claude/skills/hazards/scripts/gate-quality-check.sh";
    const check = ".claude/skills/hazards/scripts/check-quality.sh";
    expect(fs.existsSync(file(wrapper))).toBe(true);
    put(check, "#!/bin/bash\n# my real check\n");
    // Rename the gate and its script: both old files are now leftovers.
    fs.writeFileSync(
      at,
      fs.readFileSync(at, "utf-8")
        .replace("gate quality-check {", "gate quality-check-v2 {")
        .replace('run: "scripts/check-quality.sh"', 'run: "scripts/check-v2.sh"'),
    );
    const { code, out } = scaffold("--prune");
    expect(code, out).toBe(0);
    expect(fs.existsSync(file(wrapper))).toBe(false);
    expect(read(check)).toContain("my real check");
    expect(out).toContain("no longer generated, but edited — kept");
  });

  it("[G9] a second topology in the same project keeps its own manifest", () => {
    scaffold();
    const other = join(tmp, "other.at");
    fs.writeFileSync(other, fs.readFileSync(at, "utf-8").replace("topology hazards :", "topology other :"));
    cli(["scaffold", other, "--target", "claude-code", "--output", project]);
    expect(fs.existsSync(file(".claude/.scaffold-manifest.json"))).toBe(true);
    expect(fs.existsSync(file(".claude/.scaffold-manifest.other.at.json"))).toBe(true);
    // The first topology still owns its files: a rerun changes nothing.
    expect(scaffold().out).toMatch(/ 0 created, 0 updated/);
  });
});

describe("every example compiles to files Claude Code can load", () => {
  const examples = fs.readdirSync(resolve(root, "examples")).filter((f) => f.endsWith(".at"));

  it.each(examples)("[G10] %s: no ${…} reference reaches settings env", (name) => {
    const out = join(tmp, name);
    expect(cli(["scaffold", resolve(root, "examples", name), "--target", "claude-code", "--output", out]).code).toBe(0);
    const settingsPath = join(out, ".claude/settings.json");
    if (!fs.existsSync(settingsPath)) return;
    const env = JSON.parse(fs.readFileSync(settingsPath, "utf-8")).env ?? {};
    for (const [k, v] of Object.entries(env)) {
      expect(String(v), `env.${k}`).not.toContain("${");
      expect(k).not.toMatch(/^#/);
    }
  });
});
