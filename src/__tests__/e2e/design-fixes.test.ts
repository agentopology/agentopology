/**
 * [D-n] Design-review fixes (2026-11-13): findings from the design review of the
 * guards and of `guard --check`, each closed red-first.
 *
 * The scripts run the way each host runs a hook: a shell, the event's JSON on
 * stdin; CLAUDE_PROJECT_DIR set on Claude Code, no variable on Codex.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import { codexBinding } from "../../bindings/codex.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "fixtures/codex-gates.at");
const SRC = fs.readFileSync(FIXTURE, "utf8");
const hasJq = spawnSync("/bin/sh", ["-c", "command -v jq"]).status === 0;

type Target = "claude-code" | "codex";
const TARGETS: Target[] = ["claude-code", "codex"];
const DIR: Record<Target, string> = { "claude-code": ".claude/skills/ship/scripts", codex: ".codex/scripts/ship" };

let root: string;
const at = (p: string) => join(root, p);

function quiet<T>(fn: () => T): T {
  const w = vi.spyOn(console, "warn").mockImplementation(() => {});
  const l = vi.spyOn(console, "log").mockImplementation(() => {});
  try { return fn(); } finally { w.mockRestore(); l.mockRestore(); }
}

function scaffold(target: Target, src = SRC) {
  const ast = parse(src);
  const files = quiet(() => (target === "codex" ? codexBinding : claudeCodeBinding).scaffold(ast));
  for (const f of files) {
    fs.mkdirSync(dirname(at(f.path)), { recursive: true });
    fs.writeFileSync(at(f.path), f.content);
    if (f.executable) fs.chmodSync(at(f.path), 0o755);
  }
  return { ast, files };
}

/** Run a generated guard the way its host runs a hook. */
function hook(target: Target, file: string, stdin: string) {
  const env = { ...process.env } as Record<string, string>;
  if (target === "claude-code") env.CLAUDE_PROJECT_DIR = root;
  else delete env.CLAUDE_PROJECT_DIR;
  return spawnSync("/bin/sh", ["-c", `bash "${root}/${DIR[target]}/${file}"`], {
    cwd: root, input: stdin, env, encoding: "utf8", timeout: 20_000,
  });
}
const bash = (command: string) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
const okRecord = (path: string, unit: string) => {
  fs.mkdirSync(dirname(at(path)), { recursive: true });
  fs.appendFileSync(at(path), JSON.stringify({ step: "render", unit, ok: true }) + "\n");
};

beforeEach(() => { root = fs.mkdtempSync(join(os.tmpdir(), "at-design-")); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// D-1
// ---------------------------------------------------------------------------

describe.skipIf(!hasJq)("[D-1] Claude Code: the action script's gate check gets no usage exemption", () => {
  const run = (args: string[]) => {
    const e = { ...process.env } as Record<string, string>;
    delete e.CLAUDE_PROJECT_DIR;
    return spawnSync("bash", [".claude/skills/ship/scripts/action-publish.sh", ...args], { cwd: root, env: e, encoding: "utf8" });
  };
  const setup = () => {
    scaffold("claude-code");
    // the step's side effect: ./tool logs what it ran
    fs.writeFileSync(at("tool"), `#!/usr/bin/env bash\necho "$*" >> "${root}/ran.txt"\n`, { mode: 0o755 });
  };
  for (const arg of ["--help", "-h", "--version", "ep1"]) {
    it(`[D-1] with no ledger, bash action-publish.sh ${arg} exits non-zero and ./tool never runs`, () => {
      setup();
      const r = run([arg]);
      expect(r.status, r.stderr).not.toBe(0);
      expect(fs.existsSync(at("ran.txt"))).toBe(false);
    });
  }
  it("[D-1] with no argument it does not run either (no unit)", () => {
    setup();
    expect(run([]).status).not.toBe(0);
    expect(fs.existsSync(at("ran.txt"))).toBe(false);
  });
  it("[D-1] with an ok record for ep1, action-publish.sh ep1 runs; ep1 --help and two words do not", () => {
    setup();
    okRecord("logs/ep1/trace.jsonl", "ep1");
    expect(run(["ep1", "--help"]).status).not.toBe(0);
    expect(run(["ep1", "ep2"]).status).not.toBe(0);
    expect(fs.existsSync(at("ran.txt"))).toBe(false);
    const r = run(["ep1"]);
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readFileSync(at("ran.txt"), "utf8")).toContain("publish");
  });
  it("[D-1] before-action.sh honors AT_NO_USAGE=1: `./tool publish --help` is a step then", () => {
    setup();
    const env = { ...process.env, CLAUDE_PROJECT_DIR: root } as Record<string, string>;
    const sh = `${root}/${DIR["claude-code"]}/before-action.sh`;
    const plain = spawnSync("bash", [sh], { cwd: root, input: bash("./tool publish --help"), env, encoding: "utf8" });
    expect(plain.status, plain.stderr).toBe(0);
    const strict = spawnSync("bash", [sh], { cwd: root, input: bash("./tool publish --help"), env: { ...env, AT_NO_USAGE: "1" }, encoding: "utf8" });
    expect(strict.status).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// D-2
// ---------------------------------------------------------------------------

const FLAT = SRC.replace('path: "logs/{unit}/trace.jsonl"', 'path: "logs/trace.jsonl"');

describe.skipIf(!hasJq)("[D-2] a flat ledger on a unit-from step: no unit read is refused", () => {
  it("[D-2] the flat fixture really is flat", () => {
    expect(FLAT).toContain('path: "logs/trace.jsonl"');
  });
  for (const target of TARGETS) {
    it(`[D-2] ${target}: an ok record for ep1 only: publish ep2 and -v publish ep1 are refused, publish ep1 runs`, () => {
      scaffold(target, FLAT);
      okRecord("logs/trace.jsonl", "ep1");
      const ep2 = hook(target, "before-action.sh", bash("./tool publish ep2"));
      expect(ep2.status, ep2.stderr).toBe(2);
      const flag = hook(target, "before-action.sh", bash("./tool -v publish ep1"));
      expect(flag.status, flag.stderr).toBe(2);
      expect(flag.stderr).toMatch(/no unit/);
      const ok = hook(target, "before-action.sh", bash("./tool publish ep1"));
      expect(ok.status, ok.stderr).toBe(0);
    });
  }
  it("[D-2] an empty capture counts as no unit, and is refused", () => {
    const src = FLAT.replace(String.raw`unit-from: "./tool (?:re)?publish (\S+)"`, String.raw`unit-from: "./tool (?:re)?publish ?(\S*)"`);
    expect(src).not.toBe(FLAT);
    scaffold("claude-code", src);
    okRecord("logs/trace.jsonl", "ep1");
    const r = hook("claude-code", "before-action.sh", bash("./tool publish"));
    expect(r.status, r.stderr).toBe(2);
    expect(hook("claude-code", "before-action.sh", bash("./tool publish ep1")).status).toBe(0);
  });
  it("[D-2] step check refuses a unit-from step with no --unit on a flat ledger", async () => {
    const { checkStep } = await import("../../step/check.js");
    scaffold("claude-code", FLAT);
    okRecord("logs/trace.jsonl", "ep1");
    const ast = parse(FLAT);
    expect(checkStep(ast, "publish", { dir: root }).ok).toBe(false);
    expect(checkStep(ast, "publish", { dir: root, unit: "ep2" }).ok).toBe(false);
    expect(checkStep(ast, "publish", { dir: root, unit: "ep1" }).ok).toBe(true);
  });
  it("[D-2] validate warns when a unit-from step's gate ledger has no {unit}, naming both", async () => {
    const { validate } = await import("../../parser/validator.js");
    const w = validate(parse(FLAT)).filter((r) => r.level === "warning" && /unit-from/.test(r.message) && /\{unit\}/.test(r.message));
    expect(w.length).toBe(1);
    expect(w[0].message).toContain("publish");
    expect(w[0].message).toContain("logs/trace.jsonl");
    expect(validate(parse(SRC)).some((r) => /unit-from/.test(r.message) && /\{unit\}/.test(r.message))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// D-3
// ---------------------------------------------------------------------------

/** design.VKjX/cite.at: a gate credited by a PostToolUse, async hook that declares strength: refuse. */
const CITE = (hook: string) => `topology strong : [pipeline] {
  meta {
    version: "1.0.0"
    description: "Strength probe"
  }
  orchestrator {
    model: sonnet
    handles: [publish]
  }
  agent writer {
    model: sonnet
    description: "Writes the post"
  }
  action publish {
    kind: inline
    description: "Posts it"
  }
  hooks {
    hook lock-bash {
${hook}
      matcher: "Bash"
      run: "harness/lock/hook.py"
      strength: refuse
    }
  }
  gates {
    gate doctrine {
      after: writer
      before: publish
      on-fail: halt
    }
  }
  flow { writer -> publish [guard: lock-bash] }
}
`;
const POST_ASYNC = '      on: PostToolUse\n      async: true';

describe("[D-3] guard --check credits a cited hook's refuse only when it can block", () => {
  const gradeOf = async (src: string) => {
    const { checkGuards } = await import("../../guard/check.js");
    const ast = parse(src);
    const files = quiet(() => claudeCodeBinding.scaffold(ast));
    for (const f of files) { fs.mkdirSync(dirname(at(f.path)), { recursive: true }); fs.writeFileSync(at(f.path), f.content); }
    fs.mkdirSync(at("harness/lock"), { recursive: true });
    fs.writeFileSync(at("harness/lock/hook.py"), "import sys\nsys.exit(2)\n");
    return checkGuards(ast, root).items.find((i) => i.kind === "gate" && i.id === "doctrine")!;
  };
  it("[D-3] the o-cite shape (PostToolUse, async) grades none, with a note naming why", async () => {
    const item = await gradeOf(CITE(POST_ASYNC));
    expect(item.strength).toBe("none");
    expect(item.notes.join(" ")).toMatch(/PostToolUse/);
    expect(item.notes.join(" ")).toMatch(/async/);
  });
  it("[D-3] a PostToolUse hook that is not async grades none too", async () => {
    const item = await gradeOf(CITE("      on: PostToolUse"));
    expect(item.strength).toBe("none");
    expect(item.notes.join(" ")).toMatch(/PostToolUse cannot block/);
  });
  it("[D-3] an async PreToolUse hook grades none", async () => {
    const item = await gradeOf(CITE("      on: PreToolUse\n      async: true"));
    expect(item.strength).toBe("none");
    expect(item.notes.join(" ")).toMatch(/async/);
  });
  it("[D-3] a PreToolUse command hook with onFailure: block grades refuse", async () => {
    const item = await gradeOf(CITE("      on: PreToolUse"));
    expect(item.strength).toBe("refuse");
    expect(item.gradeNote).toBeUndefined();
  });
  it("[D-3] validate warns for strength: refuse on an event that cannot block", async () => {
    const { validate } = await import("../../parser/validator.js");
    const warn = (src: string) => validate(parse(src)).filter((r) => r.level === "warning" && /cannot block/.test(r.message));
    expect(warn(CITE(POST_ASYNC)).length).toBe(1);
    expect(warn(CITE(POST_ASYNC))[0].message).toContain("lock-bash");
    expect(warn(CITE("      on: PreToolUse")).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// D-4
// ---------------------------------------------------------------------------

/** design.VKjX/two.at: two approval steps before one agent. */
const TWO = `topology two : [pipeline] {
  meta {
    version: "1.0.0"
    description: "Two approvals"
  }
  orchestrator {
    model: sonnet
    handles: [a, b, editor]
  }
  action a {
    kind: inline
    description: "A"
  }
  action b {
    kind: inline
    description: "B"
  }
  human legal {
    description: "Legal approves"
  }
  human brand {
    description: "Brand approves"
  }
  agent editor {
    model: sonnet
    description: "Edits"
  }
  flow {
    a -> legal -> editor
    b -> brand -> editor
  }
}
`;

describe.skipIf(!hasJq)("[D-4] Claude Code: two approval steps before one agent print one decision", () => {
  it("[D-4] before-agent.sh prints exactly one JSON object carrying both reasons", () => {
    scaffold("claude-code", TWO);
    const env = { ...process.env, CLAUDE_PROJECT_DIR: root } as Record<string, string>;
    const r = spawnSync("bash", [at(".claude/skills/two/scripts/before-agent.sh")], {
      cwd: root, env, encoding: "utf8",
      input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: "editor", prompt: "x" } }),
    });
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("legal");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("brand");
  });
  it("[D-4] one approval step still prints one ask, and an agent with none prints nothing", () => {
    scaffold("claude-code", TWO.replace("b -> brand -> editor", "b -> editor"));
    const env = { ...process.env, CLAUDE_PROJECT_DIR: root } as Record<string, string>;
    const run = (agent: string) => spawnSync("bash", [at(".claude/skills/two/scripts/before-agent.sh")], {
      cwd: root, env, encoding: "utf8",
      input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: agent } }),
    });
    const one = JSON.parse(run("editor").stdout);
    expect(one.hookSpecificOutput.permissionDecisionReason).toBe('Approval step "legal": Legal approves');
    expect(run("general-purpose").stdout).toBe("");
  });
});

// ---------------------------------------------------------------------------
// D-5
// ---------------------------------------------------------------------------

/** design.VKjX/mx.at shape: one hook, named h, on a Codex-model topology. */
const MX = (hook: string) => `topology mx : [pipeline] {
  meta {
    version: "1.0.0"
    description: "Matchers"
  }
  orchestrator {
    model: gpt-5.2
    handles: [w]
  }
  agent w {
    model: gpt-5.2
    description: "W"
    invocation: manual
  }
  hooks {
    hook h {
${hook}
      run: "scripts/s1.sh"
    }
  }
  flow { w }
}
`;
const refuseOn = (lines: string) => MX(`${lines}\n      strength: refuse`);

describe("[D-5] Codex: a refuse hook that can never fire, or never block, is a validate error", () => {
  const codexIssues = async (src: string) => {
    const { validate } = await import("../../parser/validator.js");
    return validate(parse(src), { target: "codex" }).filter((r) => r.rule.startsWith("CX8"));
  };
  it("[D-5a] a regex over tools Codex lacks (Web.*) is a CX8-regex error for refuse, a warning otherwise", async () => {
    const errs = (await codexIssues(refuseOn('      on: PreToolUse\n      matcher: "Web.*"'))).filter((r) => r.rule === "CX8-regex");
    expect(errs.map((r) => r.level)).toEqual(["error"]);
    expect(errs[0].message).toMatch(/never fire/);
    const warns = (await codexIssues(MX('      on: PreToolUse\n      matcher: "Web.*"'))).filter((r) => r.rule === "CX8-regex");
    expect(warns.map((r) => r.level)).toEqual(["warning"]);
    // a regex naming an MCP server, or matching a Codex tool, is not flagged
    expect((await codexIssues(refuseOn('      on: PreToolUse\n      matcher: "mcp__github__.*"'))).filter((r) => r.rule === "CX8-regex")).toEqual([]);
    expect((await codexIssues(refuseOn('      on: PreToolUse\n      matcher: "B.sh"'))).filter((r) => r.rule === "CX8-regex")).toEqual([]);
  });
  it("[D-5b] a list with spaces (Edit , Write) is rewritten to apply_patch", () => {
    const src = refuseOn('      on: PreToolUse\n      matcher: "Edit , Write"');
    const files = quiet(() => codexBinding.scaffold(parse(src)));
    const hooks = JSON.parse(files.find((f) => f.path === ".codex/hooks.json")!.content);
    expect(hooks.hooks.PreToolUse[0].matcher).toBe("apply_patch");
    const bar = refuseOn('      on: PreToolUse\n      matcher: " Edit | Bash "');
    const hooks2 = JSON.parse(quiet(() => codexBinding.scaffold(parse(bar))).find((f) => f.path === ".codex/hooks.json")!.content);
    expect(hooks2.hooks.PreToolUse[0].matcher).toBe("apply_patch|Bash");
  });
  it("[D-5c] if: Read(secrets/**) with no matcher is a CX8-tool error for refuse and gets no entry", async () => {
    const src = refuseOn('      on: PreToolUse\n      if: "Read(secrets/**)"');
    const errs = (await codexIssues(src)).filter((r) => r.rule === "CX8-tool");
    expect(errs.map((r) => r.level)).toEqual(["error"]);
    expect(errs[0].message).toContain('"Read"');
    const hooks = JSON.parse(quiet(() => codexBinding.scaffold(parse(src))).find((f) => f.path === ".codex/hooks.json")?.content ?? "{\"hooks\":{}}");
    expect(hooks.hooks.PreToolUse ?? []).toEqual([]);
    expect((await codexIssues(MX('      on: PreToolUse\n      if: "Read(secrets/**)"'))).filter((r) => r.rule === "CX8-tool").map((r) => r.level)).toEqual(["warning"]);
  });
  it("[D-5d] on: PostToolUse with strength: refuse is a CX8-event error", async () => {
    const errs = (await codexIssues(refuseOn('      on: PostToolUse\n      matcher: "Bash"'))).filter((r) => r.rule === "CX8-event");
    expect(errs.map((r) => r.level)).toEqual(["error"]);
    expect(errs[0].message).toMatch(/cannot block/);
    expect((await codexIssues(MX('      on: PostToolUse\n      matcher: "Bash"'))).filter((r) => r.rule === "CX8-event")).toEqual([]);
  });
  it("[D-5e] a regex with lookaround is a CX8-regex warning", async () => {
    for (const m of ["^(?!Bash).*$", "(?<=x)Bash"]) {
      const w = (await codexIssues(refuseOn(`      on: PreToolUse\n      matcher: "${m}"`))).filter((r) => /lookaround/.test(r.message));
      expect(w.map((r) => [r.rule, r.level])).toEqual([["CX8-regex", "warning"]]);
    }
  });
  it("[D-5] a plain list naming a tool Codex lacks is an ERROR for refuse, a warning otherwise", async () => {
    expect((await codexIssues(refuseOn('      on: PreToolUse\n      matcher: "Read"'))).filter((r) => r.rule === "CX8-tool").map((r) => r.level)).toEqual(["error"]);
    expect((await codexIssues(refuseOn('      on: PreToolUse\n      matcher: "Bash|Read"'))).filter((r) => r.rule === "CX8-tool").map((r) => r.level)).toEqual(["error"]);
    expect((await codexIssues(MX('      on: PreToolUse\n      matcher: "Read"'))).filter((r) => r.rule === "CX8-tool").map((r) => r.level)).toEqual(["warning"]);
  });
});

// ---------------------------------------------------------------------------
// D-6
// ---------------------------------------------------------------------------

describe("[D-6] the ledger note appears wherever a grade is shown", () => {
  const NOTE = "ledger agent-writable until the signed gate";
  const page = async () => {
    const { generateVisualization } = await import("../../visualizer/index.js");
    const { collectFacts } = await import("../../visualizer/facts.js");
    const { drawPage } = await import("../../visualizer/__tests__/vm-draw.js");
    const ast = parse(SRC);
    scaffold("claude-code");
    const facts = collectFacts(ast, { source: SRC, dir: root });
    return { ast, facts, page: drawPage(generateVisualization(ast, { facts })) };
  };
  it("[D-6] the Guards lens table row shows the note beside the grade chip", async () => {
    const { page: p } = await page();
    const html = p.read<string>("renderGuardsView()");
    const row = html.split("<tr").find((r) => r.includes(">publish-ready<"))!;
    expect(row, html).toBeDefined();
    expect(row.split('class="where"')[0]).toContain(NOTE);
  });
  it("[D-6] the headline qualifies the refuse count with the ledger gates", async () => {
    const { page: p } = await page();
    const guards = p.read<Array<{ key: string; value: string }>>("headlineFacts()").find((f) => f.key === "guards")!;
    expect(guards.value).toMatch(/refuse \d+ \(1 with an agent-writable ledger\)/);
    p.read("(renderHeadline(), 0)");
    expect(p.read<string>("document.getElementById('headline').innerHTML")).toContain("(1 with an agent-writable ledger)");
  });
  it("[D-6] visualize --print-summary and guard --check qualify the refuse count too", async () => {
    const { ast, facts } = await page();
    const { summaryLines } = await import("../../visualizer/command.js");
    expect(summaryLines(ast, facts).find((l) => l.startsWith("guard:"))).toMatch(/refuse \d+ \(1 with an agent-writable ledger\)/);
    const { checkGuards, renderGuardReport } = await import("../../guard/check.js");
    const lines = renderGuardReport(checkGuards(ast, root));
    expect(lines.find((l) => l.startsWith("enforcement:"))).toMatch(/steps refuse \(1 with an agent-writable ledger\)/);
  });
});

// ---------------------------------------------------------------------------
// D-7
// ---------------------------------------------------------------------------

describe.skipIf(!hasJq)("[D-7] before-edit.sh compares paths without regard to case", () => {
  const write = (file_path: string) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path, content: "{}" } });
  const patch = (path: string) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { command: `*** Begin Patch\n*** Add File: ${path}\n+x\n*** End Patch\n` } });
  for (const target of TARGETS) {
    it(`[D-7] ${target}: an edit of logs/ep1/TRACE.JSONL (and LOGS/Ep1/trace.jsonl) is refused; logs/ep1/notes.md is not`, () => {
      scaffold(target);
      const edit = target === "codex" ? patch : write;
      for (const p of ["logs/ep1/TRACE.JSONL", "LOGS/Ep1/trace.jsonl", `${root}/Logs/ep1/Trace.Jsonl`]) {
        const r = hook(target, "before-edit.sh", edit(p));
        expect(r.status, `${p}: ${r.stderr}`).toBe(2);
      }
      expect(hook(target, "before-edit.sh", edit("logs/ep1/notes.md")).status).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// D-8
// ---------------------------------------------------------------------------

const STOP_GATE = `topology review : [pipeline] {
  meta {
    version: "1.0.0"
    description: "A gate between two agents"
  }
  orchestrator {
    model: sonnet
    handles: [writer, editor]
  }
  agent writer {
    model: sonnet
    description: "Writes"
  }
  agent editor {
    model: sonnet
    description: "Edits"
  }
  gates {
    gate checked {
      after: writer
      before: editor
      run: "scripts/check.sh"
      on-fail: halt
    }
  }
  flow { writer -> editor }
}
`;

describe("[D-8] guard --check says on the grade line when a refuse fails open or sits on a stop event", () => {
  const FAILS_OPEN = "fails open on a crash (no onFailure: block)";
  const grades = async (src: string, strip: boolean) => {
    const { checkGuards, renderGuardReport } = await import("../../guard/check.js");
    const { ast } = scaffold("claude-code", src);
    if (strip) {
      const p = at(".claude/settings.json");
      const settings = JSON.parse(fs.readFileSync(p, "utf8"));
      for (const entries of Object.values(settings.hooks) as Array<Array<{ hooks: Array<Record<string, unknown>> }>>) {
        for (const e of entries) for (const h of e.hooks) delete h.onFailure;
      }
      fs.writeFileSync(p, JSON.stringify(settings, null, 2));
    }
    const report = checkGuards(ast, root);
    return { items: report.items, lines: renderGuardReport(report) };
  };
  it("[D-8] with no onFailure: block, the before-action, before-agent and approval grades read 'refuse, fails open on a crash'", async () => {
    const { items, lines } = await grades(SRC, true);
    for (const id of ["publish-ready", "render-check", "approve"]) {
      const item = items.find((i) => i.id === id)!;
      expect(item.strength, id).toBe("refuse");
      expect(item.gradeNote, id).toContain(FAILS_OPEN);
      expect(lines.find((l) => l.includes(` ${id} `)), id).toContain(`refuse, ${FAILS_OPEN}`.slice(0, 20));
    }
    // the ledger note stays beside it
    expect(items.find((i) => i.id === "publish-ready")!.gradeNote).toContain("ledger agent-writable until the signed gate");
  });
  it("[D-8] with onFailure: block, no fails-open note", async () => {
    const { items } = await grades(SRC, false);
    for (const id of ["render-check", "approve"]) expect(items.find((i) => i.id === id)!.gradeNote ?? "").not.toContain("fails open");
  });
  it("[D-8] a SubagentStop gate's grade says a stop event cannot block a call", async () => {
    fs.mkdirSync(at("scripts"), { recursive: true });
    const { items } = await grades(STOP_GATE, false);
    const item = items.find((i) => i.id === "checked")!;
    expect(item.where).toMatch(/SubagentStop/);
    expect(item.strength).toBe("refuse");
    expect(item.gradeNote).toMatch(/stop event: it cannot block a call/);
  });
});
