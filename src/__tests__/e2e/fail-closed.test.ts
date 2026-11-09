/**
 * Generated gates fail closed (N27).
 *
 * Claude Code blocks only on exit 2. Measured on 0.9.1 (2026-11-09): with
 * CLAUDE_PROJECT_DIR unset before-agent.sh exited 1, with jq missing 127, and
 * a gate script nobody had written exited 0. In all three the agent launched
 * with its gate and its approval step skipped. Each case below runs the
 * generated scripts the way Claude Code does, with stdin and an environment.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";

const here = dirname(fileURLToPath(import.meta.url));
const ast = parse(fs.readFileSync(resolve(here, "fixtures/compile.at"), "utf-8"));
const LAUNCH_DRAFTER = JSON.stringify({ tool_name: "Agent", tool_input: { subagent_type: "drafter" } });

let root: string;
/**
 * Every case runs under /bin/bash (3.2 on macOS, whose EXIT trap sees status 0
 * after an unset variable) and under the bash on PATH, which Claude Code's
 * `bash "..."` command uses.
 */
const pathBash = spawnSync("/bin/bash", ["-c", "command -v bash"], { encoding: "utf8" }).stdout.trim();
const SHELLS = [...new Set(["/bin/bash", pathBash].filter(Boolean))];
let BASH = "/bin/bash";
const scripts = () => join(root, ".claude/skills/compile/scripts");

function run(script: string, opts: { env?: Record<string, string | undefined>; stdin?: string } = {}) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, CLAUDE_PROJECT_DIR: root, ...opts.env })) {
    if (v !== undefined) env[k] = v;
  }
  const r = spawnSync(BASH, [join(scripts(), script)], { input: opts.stdin ?? LAUNCH_DRAFTER, env, cwd: root, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** A PATH holding only bash and the basics, so a named command is missing. */
function pathWithout(...missing: string[]): string {
  const bin = join(root, "bin-" + missing.join("-"));
  fs.mkdirSync(bin, { recursive: true });
  for (const c of ["bash", "env", "cat", "jq", "python3", "date", "echo"]) {
    if (missing.includes(c)) continue;
    const which = spawnSync("/bin/bash", ["-c", `command -v ${c}`], { encoding: "utf8" }).stdout.trim();
    if (which.startsWith("/") && !fs.existsSync(join(bin, c))) fs.symlinkSync(which, join(bin, c));
  }
  return bin;
}

const hasJq = spawnSync("/bin/bash", ["-c", "command -v jq"]).status === 0;

beforeAll(() => {
  root = fs.mkdtempSync(join(os.tmpdir(), "at-fail-closed-"));
  for (const f of claudeCodeBinding.scaffold(ast)) {
    const p = join(root, f.path);
    fs.mkdirSync(dirname(p), { recursive: true });
    fs.writeFileSync(p, f.content);
    if (f.executable) fs.chmodSync(p, 0o755);
  }
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

for (const shell of SHELLS) describe(`a generated gate blocks when it cannot run (${shell})`, () => {
  beforeAll(() => { BASH = shell; });
  it("[N27] before-agent.sh blocks (exit 2) when CLAUDE_PROJECT_DIR is unset", () => {
    const r = run("before-agent.sh", { env: { CLAUDE_PROJECT_DIR: undefined } });
    expect(r.code).toBe(2);
    expect(r.err).toContain("blocked");
  });

  it("[N27] before-agent.sh blocks (exit 2) when jq is missing", () => {
    const r = run("before-agent.sh", { env: { PATH: pathWithout("jq") } });
    expect(r.code).toBe(2);
  });

  it("[N27] a gate script nobody has written fails, so the launch is blocked", () => {
    const stub = fs.readFileSync(join(scripts(), "brief-check.sh"), "utf8");
    expect(stub).toContain("AGENTOPOLOGY_STUB");
    expect(run("brief-check.sh").code).toBe(2);
    expect(run("before-agent.sh").code).toBe(2);
  });

  it("[N27] a SubagentStop gate wrapper blocks (exit 2) when its check's interpreter is missing", () => {
    const r = run("gate-copy-check.sh", { env: { PATH: pathWithout("python3") }, stdin: "{}" });
    expect(r.code).toBe(2);
  });

  it.skipIf(!hasJq)("[N27] a written gate that passes still lets the launch through to its approval step", () => {
    const stub = join(scripts(), "brief-check.sh");
    const saved = fs.readFileSync(stub, "utf8");
    fs.writeFileSync(stub, "#!/usr/bin/env bash\nexit 0\n");
    try {
      const r = run("before-agent.sh");
      expect(r.code).toBe(0);
      expect(JSON.parse(r.out).hookSpecificOutput.permissionDecision).toBe("ask");
    } finally {
      fs.writeFileSync(stub, saved);
    }
  });

  it.skipIf(!hasJq)("[N27] an agent with no gate launches untouched", () => {
    const r = run("before-agent.sh", { stdin: JSON.stringify({ tool_input: { subagent_type: "critic" } }) });
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
  });

  it("[N27] the guard's settings entry asks Claude Code to block when the hook itself fails", () => {
    const settings = JSON.parse(claudeCodeBinding.scaffold(ast).find((f) => f.path === ".claude/settings.json")!.content);
    const guard = settings.hooks.PreToolUse.find((e: { matcher: string }) => e.matcher === "Agent|Task");
    expect(guard.hooks[0].onFailure).toBe("block");
  });
});
