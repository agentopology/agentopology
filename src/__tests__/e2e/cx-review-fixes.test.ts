/**
 * Review findings R-1..R-12 on the Codex binding (and the guards it shares
 * with Claude Code). Each test plants the case the review named and runs the
 * generated script the way the host runs it.
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
import { isVerifiedVersion, verifiedListProblems } from "../../conformance/claude-code.js";
import { deepMergeSettingsJson } from "../../scaffold/merge.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "fixtures/codex-gates.at");
const hasJq = spawnSync("/bin/sh", ["-c", "command -v jq"]).status === 0;

let root: string;
const at = (p: string) => join(root, p);

function quiet<T>(fn: () => T): T {
  const w = vi.spyOn(console, "warn").mockImplementation(() => {});
  try { return fn(); } finally { w.mockRestore(); }
}

/** Scaffold a source for Codex into `dir` (default: root). */
function scaffoldInto(src: string, dir = root) {
  const files = quiet(() => codexBinding.scaffold(parse(src)));
  for (const f of files) {
    const p = join(dir, f.path);
    fs.mkdirSync(dirname(p), { recursive: true });
    fs.writeFileSync(p, f.content);
    if (f.executable) fs.chmodSync(p, 0o755);
  }
  return files;
}

beforeEach(() => { root = fs.mkdtempSync(join(os.tmpdir(), "at-rfix-")); spawnSync("git", ["init", "-q", root]); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("[R-10] a verified-list entry counts only with a clean suite", () => {
  const list = (entry: object) => {
    const f = join(root, "verified.json");
    fs.writeFileSync(f, JSON.stringify({ versions: [entry] }));
    return f;
  };
  const withList = <T>(file: string, fn: () => T): T => {
    const old = process.env.AGENTOPOLOGY_VERIFIED_LIST;
    process.env.AGENTOPOLOGY_VERIFIED_LIST = file;
    try { return fn(); } finally { if (old === undefined) delete process.env.AGENTOPOLOGY_VERIFIED_LIST; else process.env.AGENTOPOLOGY_VERIFIED_LIST = old; }
  };

  it("[R-10] an entry whose suite failed 12 tests is a problem and the version reads unverified", () => {
    const entry = { version: "9.9.1", proof: { run: "X", date: "2026-11-13", suite: { passed: 3, failed: 12, skipped: 0 } } };
    expect(verifiedListProblems({ versions: [entry] }).length).toBe(1);
    expect(withList(list(entry), () => isVerifiedVersion("9.9.1"))).toBe(false);
  });

  it("[R-10] an entry with no suite is a problem and the version reads unverified", () => {
    const entry = { version: "9.9.2", proof: { run: "X", date: "2026-11-13" } };
    expect(verifiedListProblems({ versions: [entry] }).length).toBe(1);
    expect(withList(list(entry), () => isVerifiedVersion("9.9.2"))).toBe(false);
  });

  it("[R-10] an entry with a clean suite still counts", () => {
    const entry = { version: "9.9.3", proof: { run: "X", date: "2026-11-13", suite: { passed: 3, failed: 0, skipped: 0 } } };
    expect(verifiedListProblems({ versions: [entry] })).toEqual([]);
    expect(withList(list(entry), () => isVerifiedVersion("9.9.3"))).toBe(true);
  });
});

describe("[R-9] guard --target codex writes the gate's check script and the Codex version line", () => {
  const CLI = resolve(here, "../../../dist/cli/index.js");
  it("[R-9] into an empty project: the check stub exists and the output carries the Codex line", () => {
    const r = spawnSync("node", [CLI, "guard", FIXTURE, "--target", "codex", "--dir", root], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1", AGENTOPOLOGY_CODEX_VERSION: "0.156.1" } });
    expect(fs.existsSync(at(".codex/scripts/render-check.sh"))).toBe(true);
    expect(fs.readFileSync(at(".codex/scripts/render-check.sh"), "utf8")).toContain("AGENTOPOLOGY_STUB");
    expect(r.stdout).toContain("checked against Codex CLI");
    expect(r.stdout).not.toContain("checked against Claude Code");
  });

  it("[R-9] an existing check script is never overwritten", () => {
    const mine = "#!/usr/bin/env bash\nexit 0\n";
    fs.mkdirSync(at(".codex/scripts"), { recursive: true });
    fs.writeFileSync(at(".codex/scripts/render-check.sh"), mine);
    spawnSync("node", [CLI, "guard", FIXTURE, "--target", "codex", "--dir", root], { encoding: "utf8" });
    expect(fs.readFileSync(at(".codex/scripts/render-check.sh"), "utf8")).toBe(mine);
  });
});

type HookEntry = { matcher?: string; hooks: Array<{ type: string; command: string; timeout?: number }> };
const hooksOf = (dir = root): Record<string, HookEntry[]> => JSON.parse(fs.readFileSync(join(dir, ".codex/hooks.json"), "utf8")).hooks;
const bashPayload = (command: string) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
const spawnPayload = (agent_type: string) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "collaborationspawn_agent", tool_input: { task_name: "t", agent_type, message: "m" } });
/** Run a hooks.json command the way Codex does: a shell, from `cwd`, the payload on stdin, no Claude variable. */
function runHook(command: string, cwd: string, stdin: string, timeout = 20_000) {
  const env = { ...process.env } as Record<string, string>;
  delete env.CLAUDE_PROJECT_DIR;
  return spawnSync("/bin/sh", ["-c", command], { cwd, input: stdin, env, encoding: "utf8", timeout });
}

describe.skipIf(!hasJq)("[R-2] a guard's hook command blocks when its script is not found", () => {
  const actionCommand = (dir = root) => hooksOf(dir).PreToolUse.find((e) => e.hooks[0].command.includes("before-action.sh"))!.hooks[0].command;

  it("[R-2] from a nested git repository inside the project the guard still runs and blocks (exit 2)", () => {
    scaffoldInto(fs.readFileSync(FIXTURE, "utf8"));
    fs.mkdirSync(at("vendor/lib"), { recursive: true });
    spawnSync("git", ["init", "-q", at("vendor/lib")]);
    const r = runHook(actionCommand(), at("vendor/lib"), bashPayload("./tool publish ep1"));
    expect(r.status, r.stderr).toBe(2);
    expect(runHook(actionCommand(), at("vendor/lib"), bashPayload("ls")).status).toBe(0);
  });

  it("[R-2] from a subfolder of a project that is not a git repository the guard still runs and blocks", () => {
    const plain = fs.mkdtempSync(join(os.tmpdir(), "at-rfix-nogit-"));
    try {
      scaffoldInto(fs.readFileSync(FIXTURE, "utf8"), plain);
      fs.mkdirSync(join(plain, "src/deep"), { recursive: true });
      const r = runHook(actionCommand(plain), join(plain, "src/deep"), bashPayload("./tool publish ep1"));
      expect(r.status, r.stderr).toBe(2);
    } finally { fs.rmSync(plain, { recursive: true, force: true }); }
  });

  it("[R-2] a guard whose script is gone exits 2 with a reason, not 127", () => {
    scaffoldInto(fs.readFileSync(FIXTURE, "utf8"));
    fs.rmSync(at(".codex/scripts/ship/before-action.sh"));
    const r = runHook(actionCommand(), root, bashPayload("ls"));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("before-action.sh");
  });
});

const AGENT_GATE = (after: string) => `topology review : [pipeline] {
  meta {
    version: "1.0.0"
    description: "Write, then review"
  }
  orchestrator {
    model: gpt-5.2
    handles: [writer, editor, reviewer]
  }
  agent writer {
    model: gpt-5.2
    description: "Writes"
  }
  agent editor {
    model: gpt-5.2
    description: "Edits"
  }
  agent reviewer {
    model: gpt-5.2
    description: "Reviews"
  }
  gates {
    gate checked {
      after: ${after}
      before: reviewer
      run: "scripts/check.sh"
      on-fail: halt
    }
  }
  flow { writer -> editor -> reviewer }
}
`;

describe("[R-8] a rescaffold replaces the topology's own Codex hook groups", () => {
  const CLI = resolve(here, "../../../dist/cli/index.js");
  const scaffoldCli = (src: string) => {
    const f = join(root, "t.at");
    fs.writeFileSync(f, src);
    return spawnSync("node", [CLI, "scaffold", f, "--target", "codex", "--output", root], { encoding: "utf8" });
  };

  it("[R-8] moving a gate's anchor leaves exactly the new SubagentStop group; the user's group stays", () => {
    expect(scaffoldCli(AGENT_GATE("writer")).status).toBe(0);
    const file = at(".codex/hooks.json");
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    const mine = { matcher: "writer", hooks: [{ type: "command", command: "bash my-own-stop.sh" }] };
    doc.hooks.SubagentStop.push(mine);
    fs.writeFileSync(file, JSON.stringify(doc, null, 2));
    expect(scaffoldCli(AGENT_GATE("editor")).status).toBe(0);
    const stop = hooksOf().SubagentStop;
    const generated = stop.filter((g) => g.hooks[0].command.includes(".codex/scripts/review/"));
    expect(generated.map((g) => g.matcher)).toEqual(["editor"]);
    expect(stop.filter((g) => g.hooks[0].command === "bash my-own-stop.sh")).toHaveLength(1);
  });
});

describe("[R-8] ownership reads the Codex command form wherever the script path sits", () => {
  const owned = [".codex/scripts/review/gate-checked.sh"];
  const group = (matcher: string, command: string) => ({ matcher, hooks: [{ type: "command", command }] });
  const forms = [
    `bash "$(git rev-parse --show-toplevel 2>/dev/null || pwd)/.codex/scripts/review/gate-checked.sh"`,
    `AT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"; bash "$AT_ROOT/.codex/scripts/review/gate-checked.sh" || exit 2`,
  ];
  it.each(forms)("[R-8] a stale owned group in the form %s is removed; the user's group is kept", (cmd) => {
    const existing = { hooks: { SubagentStop: [group("writer", cmd), group("writer", "bash my-own-stop.sh")] } };
    const generated = { hooks: { SubagentStop: [group("editor", cmd)] } };
    const out = JSON.parse(deepMergeSettingsJson(JSON.stringify(existing), JSON.stringify(generated), owned));
    expect(out.hooks.SubagentStop.map((g: { matcher: string; hooks: Array<{ command: string }> }) => `${g.matcher}:${g.hooks[0].command === cmd ? "gen" : g.hooks[0].command}`))
      .toEqual(["writer:bash my-own-stop.sh", "editor:gen"]);
  });

  it("[R-8] a Claude Code group is owned exactly as before: by a token equal to the script path", () => {
    const cc = [".claude/skills/t/scripts/gate-x.sh"];
    const existing = { hooks: { SubagentStop: [group("a", "bash .claude/skills/t/scripts/gate-x.sh"), group("a", "bash ./mine/.claude/skills/t/scripts/gate-x.sh")] } };
    const generated = { hooks: { SubagentStop: [group("b", "bash .claude/skills/t/scripts/gate-x.sh")] } };
    const out = JSON.parse(deepMergeSettingsJson(JSON.stringify(existing), JSON.stringify(generated), cc));
    expect(out.hooks.SubagentStop.map((g: { matcher: string }) => g.matcher)).toEqual(["a", "b"]);
  });
});

describe.skipIf(!hasJq)("[R-1] a gate between two agents holds the second agent's spawn on Codex", () => {
  const S = ".codex/scripts/review";
  const check = (code: number) => fs.writeFileSync(at(".codex/scripts/check.sh"), `#!/usr/bin/env bash\nexit ${code}\n`, { mode: 0o755 });

  it("[R-1] hooks.json has a PreToolUse entry on collaborationspawn_agent for before-agent.sh", () => {
    scaffoldInto(AGENT_GATE("writer"));
    const spawn = hooksOf().PreToolUse?.find((e) => e.matcher === "collaborationspawn_agent");
    expect(spawn?.hooks[0].command).toContain(`${S}/before-agent.sh`);
  });

  it("[R-1] before-agent.sh holds reviewer (exit 2) while the gate script fails, and lets it start when it passes", () => {
    scaffoldInto(AGENT_GATE("writer"));
    fs.mkdirSync(at("src/deep"), { recursive: true });
    const cmd = hooksOf().PreToolUse.find((e) => e.matcher === "collaborationspawn_agent")!.hooks[0].command;
    check(1);
    const held = runHook(cmd, at("src/deep"), spawnPayload("reviewer"));
    expect(held.status, held.stderr).toBe(2);
    expect(runHook(cmd, at("src/deep"), spawnPayload("editor")).status).toBe(0);
    check(0);
    const open = runHook(cmd, at("src/deep"), spawnPayload("reviewer"));
    expect(open.status, open.stderr).toBe(0);
  });

  it("[R-1] AGENTS.md says the spawn of reviewer is what holds, not the stop of writer", () => {
    const files = scaffoldInto(AGENT_GATE("writer"));
    const md = files.find((f) => f.path === "AGENTS.md")!.content;
    expect(md).toMatch(/before-agent\.sh[^\n]*reviewer|reviewer[^\n]*before-agent\.sh/);
  });

  it("[R-1] a gate after the last agent, with no agent after it, is not called a blocking hook", () => {
    const files = scaffoldInto(AGENT_GATE("reviewer").replace("      before: reviewer\n", ""));
    const line = files.find((f) => f.path === "AGENTS.md")!.content.split("\n").find((l) => l.includes("**Enforcement:**"))!;
    expect(line).toMatch(/cannot block/);
  });
});

describe.skipIf(!hasJq)("[R-12] before-agent.sh reads agent_type trimmed and lowercased on Codex", () => {
  it("[R-12] agent_type \" Reviewer \" is held like reviewer", () => {
    scaffoldInto(AGENT_GATE("writer"));
    fs.writeFileSync(at(".codex/scripts/check.sh"), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });
    const cmd = hooksOf().PreToolUse.find((e) => e.matcher === "collaborationspawn_agent")!.hooks[0].command;
    expect(runHook(cmd, root, spawnPayload(" Reviewer ")).status).toBe(2);
  });
});

describe.skipIf(!hasJq)("[R-3] a slow gate check cannot outlast the Codex hook timeout", () => {
  const slow = (extra: string) => AGENT_GATE("writer").replace('      run: "scripts/check.sh"\n', `      run: "scripts/check.sh"\n${extra}`);
  const spawnEntry = () => hooksOf().PreToolUse.find((e) => e.matcher === "collaborationspawn_agent")!.hooks[0];

  it("[R-3] timeout: 10m retry: 2 raises the hook timeout above the gate's worst case (1802 s)", () => {
    scaffoldInto(slow("      timeout: 10m\n      retry: 2\n"));
    expect(spawnEntry().timeout!).toBeGreaterThan(3 * 600 + 2);
    const stop = hooksOf().SubagentStop.find((e) => e.matcher === "writer")!.hooks[0];
    expect(stop.timeout!).toBeGreaterThan(3 * 600 + 2);
  });

  it("[R-3] the hook command has its own deadline below the hook timeout", () => {
    scaffoldInto(AGENT_GATE("writer"));
    const e = spawnEntry();
    const m = /-k \d+ (\d+) /.exec(e.command);
    expect(m, e.command).not.toBeNull();
    expect(Number(m![1])).toBeLessThan(e.timeout!);
  });

  it("[R-3] a check that sleeps 200 s is cut at the deadline and the guard exits 2 (deadline set to 3 s here)", () => {
    scaffoldInto(AGENT_GATE("writer"));
    fs.writeFileSync(at(".codex/scripts/check.sh"), "#!/usr/bin/env bash\nsleep 200\nexit 0\n", { mode: 0o755 });
    const cmd = spawnEntry().command.replace(/-k (\d+) \d+ /, "-k $1 3 ");
    const t0 = Date.now();
    const r = runHook(cmd, root, spawnPayload("reviewer"), 30_000);
    expect(r.status, r.stderr).toBe(2);
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(r.stderr).toMatch(/deadline/);
  });

  it("[R-3] validate warns when a gate's worst case is longer than the default hook timeout", () => {
    const w = validate(parse(slow("      timeout: 10m\n      retry: 2\n")), { target: "codex" }).filter((r) => r.rule === "CX9-timeout");
    expect(w).toHaveLength(1);
    expect(w[0].message).toContain("checked");
  });
});

const HOOKED = (hooks: string) => `topology t : [pipeline] {
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
  flow { intake -> worker }
  hooks {
${hooks}
  }
}
`;
const refuseHook = (name: string, matcher: string, extra = "") => `    hook ${name} {
      on: PreToolUse
      matcher: "${matcher}"
      run: "scripts/${name}.sh"
      type: command
      strength: refuse
${extra}    }`;

describe("[R-5] Claude tool names in a matcher become their Codex names", () => {
  it("[R-5] Edit|Write becomes apply_patch and Task becomes collaborationspawn_agent; Bash stays", () => {
    scaffoldInto(HOOKED([refuseHook("files", "Edit|Write"), refuseHook("spawn", "Task"), refuseHook("sh", "Bash")].join("\n")));
    const matchers = hooksOf().PreToolUse.map((e) => e.matcher);
    expect(matchers).toEqual(["apply_patch", "collaborationspawn_agent", "Bash"]);
  });

  it("[R-5] a name with no Codex equivalent gets a warning", () => {
    const w = validate(parse(HOOKED(refuseHook("reads", "Read|Edit"))), { target: "codex" }).filter((r) => r.rule === "CX8-tool");
    expect(w).toHaveLength(1);
    expect(w[0].message).toContain('"Read"');
    scaffoldInto(HOOKED(refuseHook("reads", "Read|Edit")));
    expect(hooksOf().PreToolUse[0].matcher).toBe("apply_patch");
  });
});

const patchPayload = (patch: string) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { command: patch } });
const blockScript = (rel: string) => { fs.mkdirSync(dirname(at(rel)), { recursive: true }); fs.writeFileSync(at(rel), "#!/usr/bin/env bash\necho 'refused by hook' >&2\nexit 2\n", { mode: 0o755 }); };
const envHook = refuseHook("no-env", "Write", '      if: "Write(.env*)"\n');

describe.skipIf(!hasJq)("[R-6] the if: filter reads the paths of an apply_patch", () => {
  const cmd = () => hooksOf().PreToolUse[0].hooks[0].command;

  it("[R-6] an apply_patch that adds $PWD/.env runs the refuse hook (exit 2)", () => {
    scaffoldInto(HOOKED(envHook));
    blockScript(".codex/scripts/no-env.sh");
    const patch = `*** Begin Patch\n*** Add File: ${root}/.env\n+SECRET=1\n*** End Patch\n`;
    const r = runHook(cmd(), root, patchPayload(patch));
    expect(r.status, r.stderr).toBe(2);
  });

  it("[R-6] an Update File and a Move to are read too; an unrelated patch passes", () => {
    scaffoldInto(HOOKED(envHook));
    blockScript(".codex/scripts/no-env.sh");
    const update = `*** Begin Patch\n*** Update File: ${root}/src/a.ts\n*** Move to: ${root}/.env.local\n@@\n-a\n+b\n*** End Patch\n`;
    expect(runHook(cmd(), root, patchPayload(update)).status).toBe(2);
    const other = `*** Begin Patch\n*** Add File: ${root}/src/b.ts\n+x\n*** End Patch\n`;
    expect(runHook(cmd(), root, patchPayload(other)).status).toBe(0);
  });

  it("[R-6] stdin that is not JSON, or empty, on a refuse hook exits 2", () => {
    scaffoldInto(HOOKED(envHook));
    blockScript(".codex/scripts/no-env.sh");
    expect(runHook(cmd(), root, "not json").status).toBe(2);
    expect(runHook(cmd(), root, "").status).toBe(2);
  });
});

describe.skipIf(!hasJq)("[R-7] the if: filter runs its command as argv, so a path with a space works", () => {
  it("[R-7] in a project folder named \"fx 3\", a guarded git push exits 2", () => {
    const spaced = join(root, "fx 3");
    fs.mkdirSync(spaced);
    spawnSync("git", ["init", "-q", spaced]);
    scaffoldInto(HOOKED(refuseHook("no-push", "Bash", '      if: "Bash(git push*)"\n')), spaced);
    fs.writeFileSync(join(spaced, ".codex/scripts/no-push.sh"), "#!/usr/bin/env bash\necho 'no push' >&2\nexit 2\n", { mode: 0o755 });
    const cmd = hooksOf(spaced).PreToolUse[0].hooks[0].command;
    const r = runHook(cmd, spaced, bashPayload("git push origin main"));
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toContain("no push");
    expect(runHook(cmd, spaced, bashPayload("git status")).status).toBe(0);
  });

  it("[R-7] a refuse hook whose command is not found (127) blocks with exit 2", () => {
    scaffoldInto(HOOKED(refuseHook("no-push", "Bash", '      if: "Bash(git push*)"\n')));
    fs.rmSync(at(".codex/scripts/no-push.sh"));
    const r = runHook(hooksOf().PreToolUse[0].hooks[0].command, root, bashPayload("git push origin main"));
    expect(r.status).toBe(2);
  });

  it("[R-7] an inline shell command still runs through the filter", () => {
    scaffoldInto(HOOKED(`    hook g {
      on: PreToolUse
      matcher: "Bash"
      if: "Bash(rm -rf *)"
      run: "exit 2"
      type: command
    }`));
    const cmd = hooksOf().PreToolUse[0].hooks[0].command;
    expect(runHook(cmd, root, bashPayload("rm -rf /tmp/x")).status).toBe(2);
    expect(runHook(cmd, root, bashPayload("ls")).status).toBe(0);
  });
});

describe.skipIf(!hasJq)("[R-4] before-action.sh sees a guarded step however the command is written", () => {
  const BLOCK: string[] = [
    "./tool  publish ep1",
    "./tool\tpublish ep1",
    "if ./tool publish ep1; then :; fi",
    "while ./tool publish ep1; do break; done",
    "until ./tool publish ep1; do :; done",
    "! ./tool publish ep1",
    "echo $(./tool publish ep1)",
    "echo `./tool publish ep1`",
    "command ./tool publish ep1",
    "nice ./tool publish ep1",
    "nice -n 5 ./tool publish ep1",
    "sudo ./tool publish ep1",
    "sudo -u bot ./tool publish ep1",
    "env -i ./tool publish ep1",
    "echo ep1 | xargs ./tool publish",
    "\"./tool\" publish ep1",
    "./tool 'publish' ep1",
    "/opt/project/tool publish ep1",
    "cd x && ./tool publish ep1",
    "(./tool publish ep1)",
    "{ ./tool publish ep1; }",
    "FOO=1 ./tool publish ep1",
    "ls\n./tool publish ep1",
    "bash -c './tool publish ep1'",
    "eval ./tool publish ep1",
  ];
  const PASS: string[] = ["ls -la", "git status", "./tool render ep1", "./tool publisher ep1", "echo done"];
  const ast = () => parse(fs.readFileSync(FIXTURE, "utf8"));

  const platforms = [
    {
      name: "Codex",
      setup: () => { scaffoldInto(fs.readFileSync(FIXTURE, "utf8")); fs.mkdirSync(at("src/deep"), { recursive: true }); return at(".codex/scripts/ship/before-action.sh"); },
      env: {} as Record<string, string>,
    },
    {
      name: "Claude Code",
      setup: async () => {
        const { generateBeforeActionScript, CLAUDE_CODE_GUARDS } = await import("../../bindings/lib/guards.js");
        const f = generateBeforeActionScript(ast(), CLAUDE_CODE_GUARDS)!;
        fs.mkdirSync(dirname(at(f.path)), { recursive: true });
        fs.writeFileSync(at(f.path), f.content, { mode: 0o755 });
        fs.mkdirSync(at("src/deep"), { recursive: true });
        return at(f.path);
      },
      env: { CLAUDE_PROJECT_DIR: "" } as Record<string, string>,
    },
  ];

  for (const p of platforms) {
    const run = (script: string, command: string) => {
      const env = { ...process.env, ...p.env } as Record<string, string>;
      if (p.name === "Claude Code") env.CLAUDE_PROJECT_DIR = root; else delete env.CLAUDE_PROJECT_DIR;
      return spawnSync("bash", [script], { cwd: at("src/deep"), input: bashPayload(command), env, encoding: "utf8" });
    };
    it.each(BLOCK)(`[R-4] ${p.name}: %j exits 2 while the gate's ledger has no ok record`, async (command) => {
      const script = await p.setup();
      const r = run(script, command);
      expect(r.status, r.stderr).toBe(2);
    });
    it.each(PASS)(`[R-4] ${p.name}: %j is no guarded step and passes`, async (command) => {
      const script = await p.setup();
      const r = run(script, command);
      expect(r.status, r.stderr).toBe(0);
    });
    it(`[R-4] ${p.name}: with an ok ledger record the step passes in its unusual forms too`, async () => {
      const script = await p.setup();
      fs.mkdirSync(at("logs/ep1"), { recursive: true });
      fs.writeFileSync(at("logs/ep1/trace.jsonl"), JSON.stringify({ step: "render", unit: "ep1", ok: true, at: "2026-01-01T00:00:00Z" }) + "\n");
      for (const c of ["./tool  publish ep1", "echo $(./tool publish ep1)", "if ./tool publish ep1; then :; fi", "/opt/project/tool publish ep1"]) {
        const r = run(script, c);
        expect(r.status, `${c}: ${r.stderr}`).toBe(0);
      }
    });
  }
});

describe.skipIf(!hasJq)("[R-11] the human gate on Codex does not hand the model its own approval", () => {
  const gates = () => fs.readFileSync(FIXTURE, "utf8");
  const unrestricted = () => gates().replace('description: "Edits the rendered piece"', 'description: "Edits the rendered piece"\n    permissions: unrestricted');
  const forge = (src: string) => validate(parse(src), { target: "codex" }).filter((r) => r.rule === "CX11-forgeable");

  it("[R-11] validate warns when the sandbox lets the model write .codex (danger-full-access)", () => {
    const w = forge(unrestricted());
    expect(w).toHaveLength(1);
    expect(w[0].message).toContain("approve");
    expect(w[0].message).toContain("danger-full-access");
  });

  it("[R-11] under workspace-write there is no such warning", () => {
    const src = unrestricted().replace("  flow {", "  settings {\n    sandbox: workspace-write\n  }\n  flow {");
    expect(forge(src)).toEqual([]);
    expect(forge(gates())).toEqual([]);
  });

  it("[R-11] the block message names no ready-to-run command; AGENTS.md gives the record format", () => {
    const files = scaffoldInto(gates());
    fs.writeFileSync(at(".codex/scripts/render-check.sh"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    const cmd = hooksOf().PreToolUse.find((e) => e.matcher === "collaborationspawn_agent")!.hooks[0].command;
    const r = runHook(cmd, root, spawnPayload("editor"));
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/person/);
    expect(r.stderr).not.toMatch(/printf|>>|mkdir/);
    const md = files.find((f) => f.path === "AGENTS.md")!.content;
    expect(md).toContain(".codex/state/approvals.jsonl");
    expect(md).toContain('{"step":"approve","ok":true');
  });
});
