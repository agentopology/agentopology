/**
 * F1 / F1b: a `run:` that opens with one of the topology's own scripts runs
 * that script, whatever follows it on the line.
 *
 * Measured on main after #50 (S-11): `run: "scripts/guard.sh 2>/dev/null"`
 * holds an operator, so it was emitted as written. Re-scaffolding a project
 * 0.11.2 had scaffolded turned the working
 * `bash "$CLAUDE_PROJECT_DIR/.claude/skills/<t>/scripts/guard.sh" 2>/dev/null`
 * into `scripts/guard.sh 2>/dev/null`, which exits 127 (and 127 does not
 * block). The same for `bun scripts/x.ts` and for a gate's run.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import { isShellCommand } from "../../parser/run.js";
import { hookCommand, settingsHooksOf, claudeCodeBinding } from "../../bindings/claude-code.js";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, "../../../dist/cli/index.js");
const FIX = join(here, "fixtures/upgrade-0112");
const SKILL = (f: string) => `"$CLAUDE_PROJECT_DIR/.claude/skills/t/scripts/${f}"`;

describe("F1: a topology script followed by redirects or operators", () => {
  it("[F-1] resolves the script and keeps the rest of the line verbatim", () => {
    expect(hookCommand("scripts/guard.sh 2>/dev/null", "t")).toBe(`bash ${SKILL("guard.sh")} 2>/dev/null`);
    expect(hookCommand("scripts/guard.sh || exit 2", "t")).toBe(`bash ${SKILL("guard.sh")} || exit 2`);
    expect(hookCommand("scripts/a.sh && scripts/b.sh", "t")).toBe(`bash ${SKILL("a.sh")} && scripts/b.sh`);
    expect(hookCommand("python3 scripts/x.py > out.txt", "t")).toBe(`python3 ${SKILL("x.py")} > out.txt`);
    expect(hookCommand("scripts/guard.sh --msg 'a  b' | tee log", "t")).toBe(`bash ${SKILL("guard.sh")} --msg 'a  b' | tee log`);
  });

  it("[F-1b] bun and deno running a topology script resolve it, as 0.11.2 did", () => {
    expect(hookCommand("bun scripts/guard.ts", "t")).toBe(`bun ${SKILL("guard.ts")}`);
    expect(hookCommand("bun run scripts/guard.ts --x", "t")).toBe(`bun run ${SKILL("guard.ts")} --x`);
    expect(hookCommand("deno run scripts/x.ts 2>&1", "t")).toBe(`deno run ${SKILL("x.ts")} 2>&1`);
  });

  it("[F-1] is not shell: the binding writes a stub for the script", () => {
    expect(isShellCommand("scripts/guard.sh 2>/dev/null")).toBe(false);
    expect(isShellCommand("bun scripts/guard.ts")).toBe(false);
  });

  it("[F-1] what is not a topology script stays as written (S-11)", () => {
    for (const run of [
      "jq -r '.x' | grep -q y",
      "lint-tool update --quiet 2>/dev/null || true",
      "uv run scripts/x.py",
      "npx tool@1 scripts/x.sh",
      "bun run lint",
      "deno fmt",
      "cd scripts && ./x.sh",
      "check-review | tee /tmp/log",
      "bash .claude/hooks/x.sh 2>/dev/null || true",
      "command scripts/x.sh",
    ]) {
      expect(isShellCommand(run), run).toBe(true);
      expect(hookCommand(run, "t"), run).toBe(run);
    }
  });

  const at = (hooks: string, gateRun = "scripts/check.sh") => parse([
    "topology t : [pipeline] {",
    "  meta {", '    version: "1.0.0"', '    description: "t"', "  }",
    "  orchestrator {", "    model: sonnet", "  }",
    "  agent a {", "    model: sonnet", '    description: "a"', "  }",
    "  agent b {", "    model: sonnet", '    description: "b"', "  }",
    "  flow { a -> b }",
    "  gates {", "    gate g {", "      after: a", "      before: b", `      run: ${JSON.stringify(gateRun)}`, "    }", "  }",
    "  hooks {", hooks, "  }",
    "}",
  ].join("\n"));
  const hook = (id: string, run: string) => `    hook ${id} {\n      on: PreToolUse\n      matcher: "Bash"\n      run: ${JSON.stringify(run)}\n      type: command\n    }`;

  it("[F-1] a bare name the topology scaffolds as a script is that script, operators kept", () => {
    const ast = at([hook("plain", "check-review"), hook("piped", "check-review | tee /tmp/log")].join("\n"));
    const cmds = (settingsHooksOf(ast).PreToolUse as Array<{ hooks: Array<{ command: string }> }>).flatMap((g) => g.hooks.map((h) => h.command));
    expect(cmds).toContain(`bash ${SKILL("check-review")} | tee /tmp/log`);
  });

  it("[F-1] scaffold writes the stub of a redirected hook script", () => {
    const paths = claudeCodeBinding.scaffold(at(hook("g2", "scripts/guard.sh 2>/dev/null"))).map((f) => f.path);
    expect(paths).toContain(".claude/skills/t/scripts/guard.sh");
  });

  it("[F-1b] a gate run with a redirect runs the gate's script, and its stub is written", () => {
    const files = claudeCodeBinding.scaffold(at(hook("x", "scripts/x.sh"), "scripts/check.sh > /dev/null"));
    const wrapper = files.find((f) => f.path === ".claude/skills/t/scripts/gate-g.sh")!;
    expect(wrapper.content).toContain(`bash ${SKILL("check.sh")} > /dev/null`);
    expect(files.map((f) => f.path)).toContain(".claude/skills/t/scripts/check.sh");
  });
});

describe("F1 acceptance: a project 0.11.2 scaffolded, re-scaffolded, runs its guard for real", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(join(os.tmpdir(), "at-f1-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** 0.11.2's settings.json and manifest for this .at, then the user's script, then scaffold with this build. */
  const upgrade = (kind: "hook" | "gate", script: string) => {
    fs.mkdirSync(join(root, ".claude/skills/simple-pipeline/scripts"), { recursive: true });
    fs.copyFileSync(join(FIX, kind, "t.at"), join(root, "t.at"));
    fs.copyFileSync(join(FIX, kind, "settings.json"), join(root, ".claude/settings.json"));
    fs.copyFileSync(join(FIX, kind, "scaffold-manifest.json"), join(root, ".claude/.scaffold-manifest.json"));
    fs.writeFileSync(join(root, ".claude/skills/simple-pipeline/scripts", script), "#!/usr/bin/env bash\necho REFUSED-BY-USER-SCRIPT >&2\nexit 2\n");
    const r = spawnSync(process.execPath, [CLI, "scaffold", "t.at", "--target", "claude-code"], { cwd: root, encoding: "utf8" });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
  };
  const bash = (cmd: string, input: object) =>
    spawnSync("bash", ["-c", cmd], { cwd: root, encoding: "utf8", input: JSON.stringify(input), env: { ...process.env, CLAUDE_PROJECT_DIR: root } });

  it("[F-1] the hook's command exits 2 when the user's guard.sh exits 2", () => {
    upgrade("hook", "guard.sh");
    const settings = JSON.parse(fs.readFileSync(join(root, ".claude/settings.json"), "utf8"));
    const cmds: string[] = settings.hooks.PreToolUse.filter((g: { matcher?: string }) => g.matcher === "Bash")
      .flatMap((g: { hooks: Array<{ command: string }> }) => g.hooks.map((h) => h.command))
      .filter((c: string) => c.includes("guard.sh"));
    expect(cmds).toEqual(['bash "$CLAUDE_PROJECT_DIR/.claude/skills/simple-pipeline/scripts/guard.sh" 2>/dev/null']);
    const r = bash(cmds[0], { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } });
    expect(r.status).toBe(2);
  });

  it("[F-1b] the gate's result is the script's: exit 2", () => {
    upgrade("gate", "check-quality.sh");
    const r = bash('bash "$CLAUDE_PROJECT_DIR/.claude/skills/simple-pipeline/scripts/gate-quality-check.sh"', { hook_event_name: "SubagentStop", agent_type: "writer" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("REFUSED-BY-USER-SCRIPT");
  });
});
