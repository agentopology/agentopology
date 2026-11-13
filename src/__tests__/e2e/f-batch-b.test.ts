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
  const e = { ...process.env } as Record<string, string>;
  delete e.CLAUDE_PROJECT_DIR;
  Object.assign(e, env);
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

const HOOKED = (hooks: string, extra = "") => `topology t : [pipeline] {
  meta {
    version: "1.0.0"
    description: "t"
  }
  agent worker {
    description: "Does work"
    model: gpt-5.2
    permissions: autonomous
    tools: [Read]
  }
  action intake {
    kind: inline
    description: "entry"
  }
${extra}  flow { intake -> worker }
  hooks {
${hooks}
  }
}
`;
const hookDef = (name: string, matcher: string, run: string, extra = "") => `    hook ${name} {
      on: PreToolUse
      matcher: "${matcher}"
      run: "${run}"
      type: command
${extra}    }`;
const ccHooksOf = (dir = root): Record<string, HookEntry[]> => JSON.parse(fs.readFileSync(join(dir, ".claude/settings.json"), "utf8")).hooks;
const asClaude = (src: string) => src.replace(/gpt-5\.2/g, "sonnet");

describe("[F-24] a hook stub runs under the interpreter its hook command uses", () => {
  it("[F-24] Codex: run: \"sh scripts/note.sh\" (not refuse): the fresh stub exits 1, not 2, so a Bash call is not blocked by accident", () => {
    scaffoldInto(HOOKED(hookDef("note", "Bash", "sh scripts/note.sh")));
    const cmd = hooksOf().PreToolUse[0].hooks[0].command;
    expect(cmd).toMatch(/\bsh\b/);
    const r = runHook(cmd, root, bashPayload("ls"));
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain("TODO");
  });
  it("[F-24] Claude Code: run: \"sh scripts/note.sh\" (not refuse): the fresh stub exits 1, not 2", () => {
    scaffoldInto(asClaude(HOOKED(hookDef("note", "Bash", "sh scripts/note.sh"))), root, claudeCodeBinding);
    const cmd = ccHooksOf().PreToolUse.find((e) => e.hooks[0].command.includes("note.sh"))!.hooks[0].command;
    const r = runHook(cmd, root, bashPayload("ls"), 30_000, { CLAUDE_PROJECT_DIR: root });
    expect(r.status, r.stderr).toBe(1);
  });
  it("[F-24] a refuse hook stub run by sh still exits 2", () => {
    scaffoldInto(HOOKED(hookDef("guard", "Bash", "sh scripts/guard.sh", "      strength: refuse\n")));
    const r = runHook(hooksOf().PreToolUse[0].hooks[0].command, root, bashPayload("ls"));
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toContain("TODO");
  });
});

const hasPython = spawnSync("/bin/sh", ["-c", "command -v python3"]).status === 0;
describe.skipIf(!hasPython)("[F-25] a gate check stub is written in its file's language", () => {
  for (const [label, binding, dir] of [["Codex", codexBinding, ""], ["Claude Code", claudeCodeBinding, ""]] as const) {
    it(`[F-25] ${label}: checks/review.py is Python and exits 2; checks/review.mjs is JavaScript and exits 2`, () => {
      const src = (run: string) => (binding === claudeCodeBinding ? asClaude(AGENT_GATE(run)) : AGENT_GATE(run));
      const py = quiet(() => binding.scaffold(parse(src("checks/review.py")))).find((f) => f.path === `${dir}checks/review.py`)!;
      expect(py.content.split("\n")[0]).toMatch(/python/);
      fs.mkdirSync(at("checks"), { recursive: true });
      fs.writeFileSync(at("checks/review.py"), py.content);
      const rp = spawnSync("python3", [at("checks/review.py")], { encoding: "utf8" });
      expect(rp.stderr).not.toMatch(/SyntaxError/);
      expect(rp.status, rp.stderr).toBe(2);
      expect(py.content).toContain("AGENTOPOLOGY_STUB");
      const js = quiet(() => binding.scaffold(parse(src("checks/review.mjs")))).find((f) => f.path === `${dir}checks/review.mjs`)!;
      fs.writeFileSync(at("checks/review.mjs"), js.content);
      const rj = spawnSync("node", [at("checks/review.mjs")], { encoding: "utf8" });
      expect(rj.status, rj.stderr).toBe(2);
      expect(js.content).toContain("AGENTOPOLOGY_STUB");
    });
  }
  it("[F-25] Codex: the gate wrapper runs checks/review.mjs with node, so a filled-in check passes", () => {
    if (!hasJq) return;
    scaffoldInto(AGENT_GATE("checks/review.mjs"));
    fs.writeFileSync(at("checks/review.mjs"), "process.exit(0);\n");
    expect(runHook(spawnCommand(), root, spawnPayload("reviewer")).status).toBe(0);
  });
});

const patchPayload = (patch: string) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { command: patch } });
const blockScript = (rel: string) => { fs.mkdirSync(dirname(at(rel)), { recursive: true }); fs.writeFileSync(at(rel), "#!/usr/bin/env bash\necho 'refused by hook' >&2\nexit 2\n", { mode: 0o755 }); };
const add = (p: string) => `*** Begin Patch\n*** Add File: ${p}\n+SECRET=1\n*** End Patch\n`;

describe.skipIf(!hasJq)("[F-12] the at-if apply_patch path check canonicalizes paths", () => {
  const envHook = HOOKED(hookDef("no-env", "Write", "scripts/no-env.sh", '      strength: refuse\n      if: "Write(.env*)"\n'));
  const cmd = () => hooksOf().PreToolUse[0].hooks[0].command;
  for (const form of ["$ROOT/./.env", "$ROOT//.env", "sub/../.env", "./.env", "/proc/self/cwd/.env", "$ROOT/sub/../.env", "$ROOT/deep/dir/.env.local"]) {
    it(`[F-12] ${form} is seen as .env and blocked`, () => {
      scaffoldInto(envHook);
      blockScript(".codex/scripts/no-env.sh");
      const r = runHook(cmd(), root, patchPayload(add(form.replace("$ROOT", root))));
      expect(r.status, r.stderr).toBe(2);
      expect(r.stderr).toContain("refused by hook");
    });
  }
  it("[F-12] an unrelated file passes, also in its odd forms", () => {
    scaffoldInto(envHook);
    blockScript(".codex/scripts/no-env.sh");
    for (const p of [`${root}/src/a.ts`, `${root}/./src//b.ts`, "src/../README.md"]) expect(runHook(cmd(), root, patchPayload(add(p))).status, p).toBe(0);
  });
  it("[F-12] a pattern with a slash is matched against the whole project path, not the basename", () => {
    scaffoldInto(HOOKED(hookDef("no-cfg", "Write", "scripts/no-cfg.sh", '      strength: refuse\n      if: "Write(config/*.json)"\n')));
    blockScript(".codex/scripts/no-cfg.sh");
    expect(runHook(cmd(), root, patchPayload(add(`${root}/./config//app.json`))).status).toBe(2);
    expect(runHook(cmd(), root, patchPayload(add(`${root}/other/app.json`))).status).toBe(0);
  });
  it("[F-12, F-17b] a Delete File of .env is read and blocked", () => {
    scaffoldInto(envHook);
    blockScript(".codex/scripts/no-env.sh");
    const r = runHook(cmd(), root, patchPayload(`*** Begin Patch\n*** Delete File: ${root}/.env\n*** End Patch\n`));
    expect(r.status, r.stderr).toBe(2);
  });
});
describe.skipIf(!hasJq)("[F-12] a path holding a glob character is not expanded", () => {
  it("[F-12] $ROOT/*/../.env is still .env (the * is a name, not a glob)", () => {
    scaffoldInto(HOOKED(hookDef("no-env", "Write", "scripts/no-env.sh", '      strength: refuse\n      if: "Write(.env*)"\n')));
    blockScript(".codex/scripts/no-env.sh");
    fs.mkdirSync(at("a")); fs.mkdirSync(at("b"));
    const r = runHook(hooksOf().PreToolUse[0].hooks[0].command, root, patchPayload(add(`${root}/*/x/../../.env`)));
    expect(r.status, r.stderr).toBe(2);
  });
});

const SPELLINGS = ["reviewer", " Reviewer ", "REVIEWER", "re​viewer", "﻿reviewer", "review­er", "⁦reviewer⁩", "./reviewer", "agents/reviewer", "./agents/Reviewer", "reviewer:", "reviewer: ", "\treviewer\n"];
describe.skipIf(!hasJq)("[F-15] Codex before-agent.sh normalizes agent_type before it compares", () => {
  for (const name of SPELLINGS) {
    it(`[F-15] agent_type ${JSON.stringify(name)} is held like reviewer`, () => {
      scaffoldInto(AGENT_GATE("scripts/review.sh"));
      const r = runHook(spawnCommand(), root, spawnPayload(name));
      expect(r.status, r.stderr).toBe(2);
    });
  }
  it("[F-15] a missing or null agent_type is a default spawn and is let through; another agent too", () => {
    scaffoldInto(AGENT_GATE("scripts/review.sh"));
    expect(runHook(spawnCommand(), root, spawnPayload(undefined)).status).toBe(0);
    expect(runHook(spawnCommand(), root, spawnPayload(null)).status).toBe(0);
    expect(runHook(spawnCommand(), root, spawnPayload("writer")).status).toBe(0);
  });
});

describe("[F-14] Claude Code: a refuse PreToolUse hook blocks when it cannot run", () => {
  const src = asClaude(HOOKED([
    hookDef("guard", "Bash", "scripts/guard.sh", "      strength: refuse\n"),
    hookDef("note", "Bash", "scripts/note.sh"),
    hookDef("inline", "Bash", "exit 2", "      strength: refuse\n"),
  ].join("\n")));
  it("[F-14] a strength: refuse hook gets onFailure: block; a hook without strength does not", () => {
    scaffoldInto(src, root, claudeCodeBinding);
    const pre = ccHooksOf().PreToolUse;
    const of = (s: string) => pre.find((e) => e.hooks[0].command.includes(s))!.hooks[0];
    expect(of("guard.sh").onFailure).toBe("block");
    expect(of("exit 2").onFailure).toBe("block");
    expect(of("note.sh").onFailure).toBeUndefined();
  });
  it("[F-14] a per-agent refuse PreToolUse hook gets onFailure: block in the agent file", () => {
    const withAgentHook = asClaude(HOOKED("").replace("    tools: [Read]\n", `    tools: [Read]\n    hooks {\n${hookDef("agent-guard", "Bash", "scripts/ag.sh", "      strength: refuse\n")}\n    }\n`));
    const md = quiet(() => claudeCodeBinding.scaffold(parse(withAgentHook))).find((f) => f.path.includes("agents/worker"))!.content;
    expect(md).toMatch(/onFailure: "block"/);
  });
  it("[F-14] the existing guards keep their onFailure", () => {
    scaffoldInto(asClaude(fs.readFileSync(FIXTURE, "utf8")), root, claudeCodeBinding);
    for (const e of ccHooksOf().PreToolUse) expect(e.hooks[0].onFailure, e.hooks[0].command).toBe("block");
  });
  it("[F-14] validate warns when the Claude Code it checks against is below 2.1.295", () => {
    const f = join(root, "t.at");
    fs.writeFileSync(f, src);
    const env = { ...process.env, NO_COLOR: "1", AGENTOPOLOGY_CLAUDE_VERSION: "2.1.280" };
    const old = spawnSync("node", [CLI, "validate", f], { encoding: "utf8", env });
    expect(plain(old.stdout)).toMatch(/CC-onfailure.*2\.1\.295/);
    const fresh = spawnSync("node", [CLI, "validate", f], { encoding: "utf8", env: { ...env, AGENTOPOLOGY_CLAUDE_VERSION: "2.1.300" } });
    expect(plain(fresh.stdout)).not.toMatch(/CC-onfailure/);
  });
});

const CC_STEP_GATE = `topology review : [pipeline] {
  meta {
    version: "1.0.0"
    description: "Render, then review"
  }
  orchestrator {
    model: sonnet
    handles: [render, writer, reviewer]
  }
  action render {
    kind: external
    commands: ["./tool render"]
  }
  agent writer {
    model: sonnet
    description: "Writes"
  }
  agent reviewer {
    model: sonnet
    description: "Reviews"
  }
  gates {
    gate checked {
      after: render
      before: reviewer
      run: "scripts/review.sh"
      on-fail: halt
    }
  }
  flow { writer -> render -> reviewer }
}
`;
describe.skipIf(!hasJq)("[F-14] Claude Code before-agent.sh normalizes subagent_type", () => {
  const ccSpawn = (t: unknown) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: t, prompt: "p" } });
  for (const name of [" Reviewer ", "REVIEWER", "re​viewer", "agents/reviewer", "reviewer:"]) {
    it(`[F-14] subagent_type ${JSON.stringify(name)} is held like reviewer`, () => {
      // A gate after a script step and before an agent is held at that agent's launch on Claude Code.
      scaffoldInto(CC_STEP_GATE, root, claudeCodeBinding);
      const cmd = ccHooksOf().PreToolUse.find((e) => e.matcher === "Agent|Task")!.hooks[0].command;
      const r = runHook(cmd, root, ccSpawn(name), 30_000, { CLAUDE_PROJECT_DIR: root });
      expect(r.status, r.stderr).toBe(2);
      expect(runHook(cmd, root, ccSpawn("writer"), 30_000, { CLAUDE_PROJECT_DIR: root }).status).toBe(0);
    });
  }
});

describe("[F-7] a Codex matcher that is a regex naming Claude tools", () => {
  const refuse = (m: string) => HOOKED(hookDef("files", m, "scripts/files.sh", "      strength: refuse\n"));
  const plainHook = (m: string) => HOOKED(hookDef("files", m, "scripts/files.sh"));
  for (const [m, want] of [["(Write|Edit)", "(apply_patch)"], ["^Write$", "^apply_patch$"], ["^(Edit|Write|Bash)$", "^(apply_patch|Bash)$"], ["(?:Task|Agent)", "(?:collaborationspawn_agent)"]] as const) {
    it(`[F-7] ${m} is rewritten to ${want}, with no error`, () => {
      scaffoldInto(refuse(m));
      expect(hooksOf().PreToolUse[0].matcher).toBe(want);
      expect(validate(parse(refuse(m)), { target: "codex" }).filter((r) => r.level === "error")).toEqual([]);
    });
  }
  for (const m of ["Ed.*", "Task.*", "(Write|Edit)+", "W.ite"]) {
    it(`[F-7] ${m} cannot be rewritten: an ERROR for strength: refuse, a warning otherwise`, () => {
      const errs = validate(parse(refuse(m)), { target: "codex" }).filter((r) => r.rule === "CX8-regex");
      expect(errs).toHaveLength(1);
      expect(errs[0].level).toBe("error");
      expect(errs[0].message).toMatch(/never fire/);
      const warns = validate(parse(plainHook(m)), { target: "codex" }).filter((r) => r.rule === "CX8-regex");
      expect(warns).toHaveLength(1);
      expect(warns[0].level).toBe("warning");
    });
  }
  it("[F-7] a regex that also matches the Codex tool is fine (.*, apply_.*)", () => {
    for (const m of [".*", "apply_.*|Bash"]) expect(validate(parse(refuse(m)), { target: "codex" }).filter((r) => r.rule === "CX8-regex")).toEqual([]);
  });
});
