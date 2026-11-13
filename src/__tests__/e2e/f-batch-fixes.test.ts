/**
 * F-batch findings from the adversarial attack and the RC end-to-end run
 * (2026-11-13), for the items outside the before-action matcher. Each test
 * plants the case the finding named and runs the generated output the way
 * the host runs it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { parse } from "../../parser/index.js";
import { codexBinding } from "../../bindings/codex.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import type { GeneratedFile } from "../../bindings/types.js";

const hasJq = spawnSync("/bin/sh", ["-c", "command -v jq"]).status === 0;
const hasPython = spawnSync("/bin/sh", ["-c", "command -v python3"]).status === 0;

let root: string;
const at = (p: string) => join(root, p);

function quiet<T>(fn: () => T): T {
  const w = vi.spyOn(console, "warn").mockImplementation(() => {});
  const l = vi.spyOn(console, "log").mockImplementation(() => {});
  try { return fn(); } finally { w.mockRestore(); l.mockRestore(); }
}

function write(files: GeneratedFile[], dir = root): GeneratedFile[] {
  for (const f of files) {
    const p = join(dir, f.path);
    fs.mkdirSync(dirname(p), { recursive: true });
    fs.writeFileSync(p, f.content);
    if (f.executable) fs.chmodSync(p, 0o755);
  }
  return files;
}
const scaffoldCodex = (src: string, dir = root) => write(quiet(() => codexBinding.scaffold(parse(src))), dir);
const scaffoldCc = (src: string, dir = root) => write(quiet(() => claudeCodeBinding.scaffold(parse(src))), dir);

function runHook(command: string, cwd: string, stdin: string, env: Record<string, string> = {}, timeout = 20_000) {
  const e = { ...process.env, ...env } as Record<string, string>;
  if (!("CLAUDE_PROJECT_DIR" in env)) delete e.CLAUDE_PROJECT_DIR;
  return spawnSync("/bin/sh", ["-c", command], { cwd, input: stdin, env: e, encoding: "utf8", timeout });
}

const spawnPayload = (agent: unknown) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "collaborationspawn_agent", tool_input: { agent_type: agent } });
const bashPayload = (command: string) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });

beforeEach(() => { root = fs.mkdtempSync(join(os.tmpdir(), "at-fbatch-")); spawnSync("git", ["init", "-q", root]); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

/** A gate before an agent, whose check is the project script `check`. */
const GATED = (check: string, model = "gpt-5.2") => `topology review : [pipeline] {
  meta {
    version: "1.0.0"
    description: "Write, then review"
  }
  orchestrator {
    model: ${model}
    handles: [writer, reviewer]
  }
  agent writer {
    model: ${model}
    description: "Writes"
  }
  agent reviewer {
    model: ${model}
    description: "Reviews"
  }
  gates {
    gate checked {
      after: writer
      before: reviewer
      run: "${check}"
      on-fail: halt
    }
  }
  flow { writer -> reviewer }
}
`;

type Hooks = Record<string, Array<{ matcher?: string; hooks: Array<{ command: string; timeout?: number; onFailure?: string }> }>>;
const codexHooks = (dir = root): Hooks => JSON.parse(fs.readFileSync(join(dir, ".codex/hooks.json"), "utf8")).hooks;
const spawnCommand = () => codexHooks().PreToolUse.find((e) => e.matcher === "collaborationspawn_agent")!.hooks[0].command;

describe.skipIf(!hasJq)("[F-22] Codex writes a gate's check stub at the path the gate runs", () => {
  it("[F-22] the stub sits at the declared project path, and once filled the gate passes", () => {
    const files = scaffoldCodex(GATED("tools/checks/ready.sh"));
    expect(files.map((f) => f.path)).toContain("tools/checks/ready.sh");
    expect(files.map((f) => f.path)).not.toContain(".codex/scripts/ready.sh");
    // Unfilled: the stub fails, the spawn is held.
    expect(runHook(spawnCommand(), root, spawnPayload("reviewer")).status).toBe(2);
    // The user fills the stub the scaffold wrote: the gate passes.
    fs.writeFileSync(at("tools/checks/ready.sh"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    const r = runHook(spawnCommand(), root, spawnPayload("reviewer"));
    expect(r.status, r.stderr).toBe(0);
  });

  it("[F-22] a declared project script that exists is never overwritten", () => {
    const files = quiet(() => codexBinding.scaffold(parse(GATED("tools/checks/ready.sh"))));
    expect(files.find((f) => f.path === "tools/checks/ready.sh")!.createOnly).toBe(true);
  });

  it("[F-22] a bare script name still lands in .codex/scripts/", () => {
    const files = scaffoldCodex(GATED("scripts/ready.sh"));
    expect(files.map((f) => f.path)).toContain(".codex/scripts/ready.sh");
  });
});

describe.skipIf(!hasPython)("[F-25] a check stub is written in its file's language", () => {
  for (const [target, scaffold] of [["codex", scaffoldCodex], ["claude-code", scaffoldCc]] as const) {
    it(`[F-25] ${target}: a .py gate check is a Python stub that fails on purpose, not by a SyntaxError`, () => {
      const model = target === "codex" ? "gpt-5.2" : "sonnet";
      const files = scaffold(GATED("tools/pre.py", model));
      const stub = files.find((f) => f.path === "tools/pre.py")!;
      expect(stub.content.split("\n")[0]).toBe("#!/usr/bin/env python3");
      const r = spawnSync("python3", [at("tools/pre.py")], { encoding: "utf8" });
      expect(r.stderr).not.toMatch(/SyntaxError/);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/TODO/);
    });
  }

  it("[F-25] a .js check is a node stub", () => {
    const files = scaffoldCodex(GATED("tools/pre.js"));
    expect(files.find((f) => f.path === "tools/pre.js")!.content.split("\n")[0]).toBe("#!/usr/bin/env node");
  });
});

/** A topology whose only hook runs a project script through `sh`, the RC's harness/bin/gate form. */
const SH_HOOK = (model: string, strength = "") => `topology t : [pipeline] {
  meta {
    version: "1.0.0"
    description: "t"
  }
  agent worker {
    description: "Does work"
    model: ${model}
    tools: [Read]
  }
  action intake {
    kind: inline
    description: "entry"
  }
  flow { intake -> worker }
  hooks {
    hook lock-bash {
      on: PreToolUse
      matcher: "Bash"
      run: "sh harness/bin/gate harness/lock/hook.py bash"
      type: command
${strength}    }
  }
}
`;

describe("[F-24] a hook stub run through sh has a body sh can run", () => {
  const cases = [
    { target: "codex", model: "gpt-5.2", scaffold: scaffoldCodex, command: () => codexHooks().PreToolUse[0].hooks[0].command, env: {} as Record<string, string> },
    { target: "claude-code", model: "sonnet", scaffold: scaffoldCc, command: () => (JSON.parse(fs.readFileSync(at(".claude/settings.json"), "utf8")).hooks as Hooks).PreToolUse[0].hooks[0].command, env: { CLAUDE_PROJECT_DIR: "" } as Record<string, string> },
  ];
  for (const c of cases) {
    it(`[F-24] ${c.target}: on a fresh scaffold a Bash call meets the unwritten stub's exit 1, not a dash error's exit 2`, () => {
      c.scaffold(SH_HOOK(c.model));
      const r = runHook(c.command(), root, bashPayload("ls"), c.target === "claude-code" ? { CLAUDE_PROJECT_DIR: root } : {});
      expect(r.stderr).not.toMatch(/Illegal option|pipefail/);
      expect(r.stderr).toMatch(/TODO/);
      expect(r.status, r.stderr).toBe(1);
    });
  }
});
