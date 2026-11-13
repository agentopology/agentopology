/**
 * Findings F-6..F-29 (batch b): generated safety checks fail closed and their
 * reports say what holds. Each test plants the case the finding named and runs
 * the generated output the way the host runs it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { codexBinding } from "../../bindings/codex.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, "../../../dist/cli/index.js");
const FIXTURE = resolve(here, "fixtures/codex-gates.at");
const hasJq = spawnSync("/bin/sh", ["-c", "command -v jq"]).status === 0;
// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

let root: string;
const at = (p: string) => join(root, p);

function quiet<T>(fn: () => T): T {
  const w = vi.spyOn(console, "warn").mockImplementation(() => {});
  try { return fn(); } finally { w.mockRestore(); }
}

type Binding = { scaffold(ast: ReturnType<typeof parse>): Array<{ path: string; content: string; executable?: boolean }> };
function scaffoldInto(src: string, dir = root, binding: Binding = codexBinding) {
  const files = quiet(() => binding.scaffold(parse(src)));
  for (const f of files) {
    const p = join(dir, f.path);
    fs.mkdirSync(dirname(p), { recursive: true });
    fs.writeFileSync(p, f.content);
    if (f.executable) fs.chmodSync(p, 0o755);
  }
  return files;
}

const cli = (args: string[], cwd = root) => {
  const r = spawnSync("node", [CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  return { ...r, out: plain((r.stdout ?? "") + (r.stderr ?? "")) };
};

beforeEach(() => { root = fs.mkdtempSync(join(os.tmpdir(), "at-fb-")); spawnSync("git", ["init", "-q", root]); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("[F-20/F-27] validate --target codex prints the Codex version line", () => {
  it("[F-27] plain validate --target codex names Codex CLI, not Claude Code", () => {
    const r = cli(["validate", FIXTURE, "--target", "codex"]);
    expect(r.out).toContain("checked against Codex CLI");
    expect(r.out).not.toContain("checked against Claude Code");
  });
  it("[F-27] validate --target codex --inventory names Codex CLI, not Claude Code", () => {
    cli(["scaffold", FIXTURE, "--target", "codex", "--dir", root]);
    const r = cli(["validate", FIXTURE, "--target", "codex", "--inventory", root]);
    expect(r.out).toContain("checked against Codex CLI");
    expect(r.out).not.toContain("checked against Claude Code");
  });
  it("[F-27] validate with no target still names Claude Code", () => {
    expect(cli(["validate", FIXTURE]).out).toContain("checked against Claude Code");
  });
});

describe("[F-28] inventory on a Codex-only scaffold", () => {
  it("[F-28] the scaffold manifest is mapped and no Claude Code file is listed as not scaffolded", () => {
    cli(["scaffold", FIXTURE, "--target", "codex", "--dir", root]);
    expect(fs.existsSync(at(".codex/.scaffold-manifest.json"))).toBe(true);
    const r = cli(["validate", FIXTURE, "--target", "codex", "--inventory", root]);
    expect(r.out).not.toContain(".scaffold-manifest.json");
    expect(r.out).not.toMatch(/not scaffolded/);
    expect(r.out).toMatch(/coverage: (\d+) of \1 /);
  });
});

const RUN_GATE_BEFORE_STEP = `topology runstep : [pipeline] {
  meta {
    version: "1.0.0"
    description: "A run: gate before a script step, and one between two steps"
  }
  orchestrator {
    model: gpt-5.2
    handles: [render, publish]
  }
  action render {
    kind: external
    commands: ["./tool render"]
  }
  action publish {
    kind: external
    commands: ["./tool publish"]
  }
  agent editor {
    model: gpt-5.2
    description: "Edits"
  }
  gates {
    gate checked {
      after: render
      before: publish
      run: "scripts/checked.sh"
      on-fail: halt
    }
  }
  flow { render -> publish }
}
`;
const INLINE_GATE = RUN_GATE_BEFORE_STEP
  .replace("    handles: [render, publish]\n", "    handles: [render, publish]\n    delegation: inline\n")
  .replace('      before: publish\n', "      before: editor\n")
  .replace("  flow { render -> publish }", "  flow { render -> editor -> publish }");

describe("[F-29] AGENTS.md wording matches the grade guard --check gives", () => {
  const enforcement = (md: string, gate: string) => {
    const lines = md.split("\n");
    const at = lines.findIndex((l) => l.startsWith("### ") && l.toLowerCase().includes(gate));
    return lines.slice(at).find((l) => l.includes("**Enforcement:**"))!;
  };
  it("[F-29] a run: gate with no ledger before a script step names the gate script, not a ledger", () => {
    const md = quiet(() => codexBinding.scaffold(parse(RUN_GATE_BEFORE_STEP))).find((f) => f.path === "AGENTS.md")!.content;
    const line = enforcement(md, "checked");
    expect(line).toContain("before-action.sh");
    expect(line).not.toMatch(/ledger/);
    expect(line).toMatch(/gate script passes/);
  });
  it("[F-29] a gate no Codex event marks reads hope in AGENTS.md, as in guard --check", () => {
    const f = join(root, "t.at");
    fs.writeFileSync(f, INLINE_GATE);
    const md = quiet(() => codexBinding.scaffold(parse(INLINE_GATE))).find((x) => x.path === "AGENTS.md")!.content;
    const line = enforcement(md, "checked");
    expect(line).not.toContain("script-level");
    expect(line).toMatch(/\*\*Enforcement:\*\* hope/);
    const r = cli(["guard", f, "--check", "--target", "codex", "--dir", root]);
    expect(r.out).toMatch(/checked\s+hope/);
  });
});

const AGENT_GATE = (run: string, extra = "") => `topology review : [pipeline] {
  meta {
    version: "1.0.0"
    description: "Write, then review"
  }
  orchestrator {
    model: gpt-5.2
    handles: [writer, reviewer]
  }
  agent writer {
    model: gpt-5.2
    description: "Writes"
  }
  agent reviewer {
    model: gpt-5.2
    description: "Reviews"
  }
  gates {
    gate checked {
      after: writer
      before: reviewer
      run: "${run}"
      on-fail: halt
${extra}    }
  }
  flow { writer -> reviewer }
}
`;
type HookEntry = { matcher?: string; hooks: Array<{ type: string; command: string; timeout?: number; onFailure?: string }> };
const hooksOf = (dir = root): Record<string, HookEntry[]> => JSON.parse(fs.readFileSync(join(dir, ".codex/hooks.json"), "utf8")).hooks;
const bashPayload = (command: string) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
const spawnPayload = (agent_type: unknown) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "collaborationspawn_agent", tool_input: { task_name: "t", ...(agent_type === undefined ? {} : { agent_type }), message: "m" } });
function runHook(command: string, cwd: string, stdin: string, timeout = 30_000, env: Record<string, string> = {}) {
  const e = { ...process.env, ...env } as Record<string, string>;
  delete e.CLAUDE_PROJECT_DIR;
  return spawnSync("/bin/sh", ["-c", command], { cwd, input: stdin, env: e, encoding: "utf8", timeout });
}
const spawnCommand = (dir = root) => hooksOf(dir).PreToolUse.find((e) => e.matcher === "collaborationspawn_agent")!.hooks[0].command;

describe.skipIf(!hasJq)("[F-22] a Codex gate stub is written where the gate wrapper runs it", () => {
  it("[F-22] run: \"checks/review.sh\": the stub is at checks/review.sh, and filling it lets the gate pass", () => {
    const files = scaffoldInto(AGENT_GATE("checks/review.sh"));
    const stub = files.find((f) => f.path.endsWith("review.sh") && f.content.includes("AGENTOPOLOGY_STUB"))!;
    expect(stub.path).toBe("checks/review.sh");
    expect(runHook(spawnCommand(), root, spawnPayload("reviewer")).status).toBe(2);
    fs.writeFileSync(at("checks/review.sh"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    const r = runHook(spawnCommand(), root, spawnPayload("reviewer"));
    expect(r.status, r.stderr).toBe(0);
  });
  it("[F-22] a bare name still goes to .codex/scripts/ and passes once filled", () => {
    scaffoldInto(AGENT_GATE("scripts/review.sh"));
    fs.writeFileSync(at(".codex/scripts/review.sh"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    expect(runHook(spawnCommand(), root, spawnPayload("reviewer")).status).toBe(0);
  });
});
