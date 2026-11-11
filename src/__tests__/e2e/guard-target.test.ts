/**
 * [N41] `guard <file> --target claude-code` writes only the guard part of what
 * scaffold would write, into a project that was built by hand: the hook
 * scripts settings.json runs, the gate wrappers and check scripts they call,
 * and the `hooks` and `permissions` keys of settings.json, merged. It never
 * writes an agent, skill, command, rule, .mcp.json or CLAUDE.md, never
 * overwrites a script the user edited or a check that is no longer a stub,
 * and a rerun changes nothing.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import { guardFiles, planGuardTarget } from "../../guard/target.js";
import { checkGuards } from "../../guard/check.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "fixtures/compile.at");
const CLI = resolve(here, "../../../dist/cli/index.js");
const ast = parse(fs.readFileSync(FIXTURE, "utf-8"));
const SCRIPTS = ".claude/skills/compile/scripts";
const AGENT = ".claude/agents/drafter/AGENT.md";
const AGENT_BYTES = "---\nname: drafter\ndescription: by hand\n---\nWrite the copy. Hand-written, do not touch.\n";
const USER_CHECK = "#!/usr/bin/env python3\nprint('my own check')\n";
const USER_BRIEF = "#!/usr/bin/env bash\n# mine, implemented\nexit 0\n";

let root: string;
const at = (p: string) => join(root, p);
const settings = () => JSON.parse(fs.readFileSync(at(".claude/settings.json"), "utf8"));
const cli = (...a: string[]) => spawnSync("node", [CLI, "guard", FIXTURE, "--target", "claude-code", "--dir", root, ...a], { encoding: "utf8" });

function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { out[relative(root, p) + "/"] = ""; walk(p); }
      else out[relative(root, p)] = createHash("sha256").update(fs.readFileSync(p)).digest("hex");
    }
  };
  walk(root);
  return out;
}

beforeEach(() => {
  root = fs.mkdtempSync(join(os.tmpdir(), "at-guard-target-"));
  fs.mkdirSync(at(".claude/agents/drafter"), { recursive: true });
  fs.writeFileSync(at(AGENT), AGENT_BYTES);
  fs.writeFileSync(at(".claude/settings.json"), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "bash \"$CLAUDE_PROJECT_DIR/.claude/hooks/mine.sh\"" }] }] },
    permissions: { allow: ["Bash(ls:*)"] },
    model: "sonnet",
  }, null, 2));
  fs.mkdirSync(at("docs/tools"), { recursive: true });
  fs.writeFileSync(at("docs/tools/check.py"), USER_CHECK);
  fs.mkdirSync(at(SCRIPTS), { recursive: true });
  fs.writeFileSync(at(`${SCRIPTS}/brief-check.sh`), USER_BRIEF);
});

describe("[N41] guard --target", () => {
  it("[N41] keeps the hook scripts, the gates they call and the checks the gates run, and nothing else", () => {
    const paths = guardFiles(claudeCodeBinding.scaffold(ast)).map((f) => f.path).sort();
    expect(paths).toContain(`${SCRIPTS}/before-agent.sh`);
    expect(paths).toContain(`${SCRIPTS}/gate-brief-check.sh`);
    expect(paths).toContain(`${SCRIPTS}/gate-copy-check.sh`);
    expect(paths).toContain(`${SCRIPTS}/brief-check.sh`);
    expect(paths).toContain("docs/tools/check.py");
    expect(paths).toContain(".claude/settings.json");
    for (const p of paths) expect(p).not.toMatch(/AGENT\.md|SKILL\.md|\.mcp\.json|CLAUDE\.md|rules\/|commands\/|crontab|schedule-|action-/);
  });

  it("[N41] the function plans the same as the command and writes nothing", () => {
    const before = snapshot();
    const plan = planGuardTarget(ast, root, "compile.at");
    expect(snapshot()).toEqual(before);
    expect(plan.actions.some((a) => a.path === `${SCRIPTS}/before-agent.sh` && a.type === "create")).toBe(true);
  });

  it("[N41] writes our guard, leaves the agent and the user's hook and permission", () => {
    const r = cli();
    expect(r.status).toBe(0);
    expect(fs.readFileSync(at(AGENT), "utf8")).toBe(AGENT_BYTES);
    const s = settings();
    expect(JSON.stringify(s.hooks.PreToolUse)).toContain(".claude/hooks/mine.sh");
    expect(s.permissions.allow).toContain("Bash(ls:*)");
    expect(s.permissions.deny).toContain("mcp__notes__delete");
    expect(JSON.stringify(s.hooks.PreToolUse)).toContain("before-agent.sh");
    expect(JSON.stringify(s.hooks.SubagentStop)).toContain("gate-copy-check.sh");
    expect(s.model).toBe("sonnet");
    expect(fs.existsSync(at(`${SCRIPTS}/before-agent.sh`))).toBe(true);
    expect(fs.existsSync(at(`${SCRIPTS}/gate-brief-check.sh`))).toBe(true);
    for (const p of [".mcp.json", "CLAUDE.md", ".claude/skills/compile/SKILL.md", ".claude/rules/compile.md", ".claude/agents/auditor/AGENT.md", "crontab.fragment"]) {
      expect(fs.existsSync(at(p)), p).toBe(false);
    }
    expect(s.hooks.Stop).toBeUndefined(); // a prompt hook is not a guard script
  });

  it("[N41] a second run changes nothing and adds no duplicates", () => {
    cli();
    const first = snapshot();
    const hooks = JSON.stringify(settings().hooks);
    const r = cli();
    expect(r.status).toBe(0);
    expect(snapshot()).toEqual(first);
    expect(JSON.stringify(settings().hooks)).toBe(hooks);
    const perms: string[] = settings().permissions.allow;
    expect(new Set(perms).size).toBe(perms.length);
  });

  it("[N41] --dry-run prints the plan and writes nothing", () => {
    const before = snapshot();
    const r = cli("--dry-run");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("before-agent.sh");
    expect(snapshot()).toEqual(before);
  });

  it("[N41] a hand-written check, and a check no longer a stub, are untouched and reported", () => {
    const r = cli();
    expect(fs.readFileSync(at("docs/tools/check.py"), "utf8")).toBe(USER_CHECK);
    expect(fs.readFileSync(at(`${SCRIPTS}/brief-check.sh`), "utf8")).toBe(USER_BRIEF);
    expect(r.stdout).toContain("docs/tools/check.py");
    expect(r.stdout).toMatch(/brief-check\.sh.*(skipped|kept)/);
  });

  it("[N41] a script the user edited after a guard run is kept on the next one", () => {
    cli();
    const p = at(`${SCRIPTS}/gate-brief-check.sh`);
    fs.appendFileSync(p, "# my edit\n");
    const edited = fs.readFileSync(p, "utf8");
    const r = cli();
    expect(fs.readFileSync(p, "utf8")).toBe(edited);
    expect(r.stdout).toMatch(/gate-brief-check\.sh.*(edited|kept)/);
  });

  it("[N41] then runs guard --check: the gates refuse and the exit is 0", () => {
    const r = cli();
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/brief-check[^\n]*refuse/);
    expect(r.stdout).toMatch(/copy-check[^\n]*refuse/);
    const report = checkGuards(ast, root);
    expect(report.items.filter((i) => i.kind === "gate").every((i) => i.strength === "refuse")).toBe(true);
    expect(report.missing).toBe(0);
  });

  it("[N41] on a bare directory it exits 1 until the stubs are written, like --check", () => {
    const bare = fs.mkdtempSync(join(os.tmpdir(), "at-guard-target-bare-"));
    const r = spawnSync("node", [CLI, "guard", FIXTURE, "--target", "claude-code", "--dir", bare], { encoding: "utf8" });
    expect(fs.existsSync(join(bare, SCRIPTS, "before-agent.sh"))).toBe(true);
    expect(r.stdout).toContain("enforcement:");
  });
});
