/**
 * [CX-9] [CX-11] Gates and the human gate on Codex. The generated guard
 * scripts run the way Codex runs a hook: a shell, a subfolder as the current
 * directory, no Claude variable set, the event's JSON on stdin. Exit 2 blocks
 * (probe P10: exit 1, 127 and a timeout let the command run, so every guard
 * must turn its own failure into exit 2).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import { codexBinding } from "../../bindings/codex.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "fixtures/codex-gates.at");
const hasJq = spawnSync("/bin/sh", ["-c", "command -v jq"]).status === 0;
const S = ".codex/scripts/ship";

let root: string;
const at = (p: string) => join(root, p);

function scaffold(src = fs.readFileSync(FIXTURE, "utf8")) {
  const files = codexBinding.scaffold(parse(src));
  for (const f of files) {
    fs.mkdirSync(dirname(at(f.path)), { recursive: true });
    fs.writeFileSync(at(f.path), f.content);
    if (f.executable) fs.chmodSync(at(f.path), 0o755);
  }
  fs.mkdirSync(at("src/deep"), { recursive: true });
  return files;
}
/** Run a hook command the way Codex does: from a subfolder, no Claude variable. */
function hook(script: string, stdin: string, env: Record<string, string | undefined> = {}) {
  const e = { ...process.env, ...env } as Record<string, string>;
  delete e.CLAUDE_PROJECT_DIR;
  return spawnSync("/bin/sh", ["-c", `bash "$(git -C . rev-parse --show-toplevel 2>/dev/null || echo ${root})/${script}"`], {
    cwd: at("src/deep"), input: stdin, env: e, encoding: "utf8", timeout: 20_000,
  });
}
const bash = (command: string) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
const spawnAgent = (agent_type: string) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "collaborationspawn_agent", tool_input: { task_name: "t", agent_type, message: "gAAAAA", fork_turns: "none" } });
const ledger = (unit: string, lines: object[]) => {
  fs.mkdirSync(at(`logs/${unit}`), { recursive: true });
  fs.writeFileSync(at(`logs/${unit}/trace.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
};
const rec = (step: string, ok: boolean, unit?: string) => ({ step, ...(unit ? { unit } : {}), ok, at: "2026-01-01T00:00:00Z" });

beforeEach(() => { root = fs.mkdtempSync(join(os.tmpdir(), "at-cx9-")); spawnSync("git", ["init", "-q", root]); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("[CX-9] the guards are written and registered", () => {
  it("[CX-9] writes before-action.sh, before-agent.sh and the gate wrapper, executable, with no Claude variable", () => {
    const files = scaffold();
    for (const n of ["before-action.sh", "before-agent.sh", "gate-render-check.sh"]) {
      const f = files.find((x) => x.path === `${S}/${n}`);
      expect(f, n).toBeTruthy();
      expect(f!.executable, n).toBe(true);
      expect(f!.content).not.toMatch(/CLAUDE_PROJECT_DIR|\.claude\//);
    }
  });

  it("[CX-9] hooks.json registers the guards: Bash and the spawn tool, anchored, timeout well above the script's own time", () => {
    scaffold();
    const hooks = JSON.parse(fs.readFileSync(at(".codex/hooks.json"), "utf8")).hooks;
    const pre = hooks.PreToolUse as Array<{ matcher: string; hooks: Array<{ type: string; command: string; timeout: number }> }>;
    const bashEntry = pre.find((e) => e.matcher === "Bash" && e.hooks[0].command.includes("before-action.sh"));
    const spawnEntry = pre.find((e) => e.matcher === "collaborationspawn_agent");
    expect(bashEntry).toBeTruthy();
    expect(spawnEntry).toBeTruthy();
    for (const e of [bashEntry!, spawnEntry!]) {
      expect(e.hooks[0].type).toBe("command");
      expect(e.hooks[0].command).toContain("git rev-parse --show-toplevel");
      expect(e.hooks[0].timeout).toBeGreaterThanOrEqual(60);
    }
  });

  it("[CX-9] AGENTS.md names the manual /hooks trust step", () => {
    const files = scaffold();
    const md = files.find((f) => f.path === "AGENTS.md")!.content;
    expect(md).toContain("/hooks");
    expect(md).toMatch(/trust/i);
    expect(files.some((f) => /trusted_hash/.test(f.content))).toBe(false);
  });
});

describe.skipIf(!hasJq)("[CX-9] before-action.sh refuses a script step until the ledger shows its gate held", () => {
  beforeEach(() => { scaffold(); });
  const run = (cmd: string) => hook(`${S}/before-action.sh`, bash(cmd));

  it("[CX-9] a guarded command exits 2 while the ledger has no ok record, and 0 after one is added", () => {
    const blocked = run("./tool publish ep1");
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toContain("publish-ready");
    ledger("ep1", [rec("render", true, "ep1")]);
    expect(run("./tool publish ep1").status).toBe(0);
  });

  it("[CX-9] the same inside an && chain", () => {
    expect(run("cd repo && ./tool publish ep1").status).toBe(2);
    ledger("ep1", [rec("render", true, "ep1")]);
    expect(run("cd repo && ./tool publish ep1").status).toBe(0);
    ledger("ep1", [rec("render", true, "ep1"), rec("render", false, "ep1")]);
    expect(run("cd repo && ./tool publish ep1").status).toBe(2);
  });

  it("[CX-9] a command that is no step passes", () => {
    expect(run("ls -la").status).toBe(0);
  });

  it("[CX-9] P10: a missing jq exits 2", () => {
    const bin = fs.mkdtempSync(join(os.tmpdir(), "at-nojq-"));
    for (const t of ["dirname", "cat", "git"]) {
      const w = spawnSync("/bin/sh", ["-c", `command -v ${t}`], { encoding: "utf8" }).stdout.trim();
      if (w) fs.symlinkSync(w, join(bin, t));
    }
    const r = spawnSync("/bin/bash", [at(`${S}/before-action.sh`)], { cwd: at("src/deep"), input: bash("./tool publish ep1"), env: { PATH: bin }, encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/jq/);
  });

  it("[CX-9] P10: unparsable stdin exits 2, and so does empty stdin", () => {
    expect(hook(`${S}/before-action.sh`, "{ not json").status).toBe(2);
    expect(hook(`${S}/before-action.sh`, "").status).toBe(2);
  });

  it("[CX-9] P10: an unreadable ledger exits 2", () => {
    fs.mkdirSync(at("logs/ep1/trace.jsonl"), { recursive: true });
    expect(run("./tool publish ep1").status).toBe(2);
  });
});

describe.skipIf(!hasJq)("[CX-9] before-agent.sh holds a gate before an agent (spawn tool, agent_type)", () => {
  beforeEach(() => { scaffold(); });
  it("[CX-9] a failing gate script blocks the spawn of the agent it guards; other agents pass", () => {
    fs.mkdirSync(at(".codex/scripts"), { recursive: true });
    fs.writeFileSync(at(".codex/scripts/render-check.sh"), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });
    // approve first so only the gate is in play
    fs.mkdirSync(at(".codex/state"), { recursive: true });
    fs.writeFileSync(at(".codex/state/approvals.jsonl"), JSON.stringify({ step: "approve", ok: true, at: "2026-01-01T00:00:00Z" }) + "\n");
    expect(hook(`${S}/before-agent.sh`, spawnAgent("editor")).status).toBe(2);
    expect(hook(`${S}/before-agent.sh`, spawnAgent("someone-else")).status).toBe(0);
    fs.writeFileSync(at(".codex/scripts/render-check.sh"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    expect(hook(`${S}/before-agent.sh`, spawnAgent("editor")).status).toBe(0);
  });

  it("[CX-9] P10: a missing jq, bad stdin and a gate that cannot start all exit 2", () => {
    fs.mkdirSync(at(".codex/state"), { recursive: true });
    fs.writeFileSync(at(".codex/state/approvals.jsonl"), JSON.stringify({ step: "approve", ok: true }) + "\n");
    expect(hook(`${S}/before-agent.sh`, "garbage").status).toBe(2);
    expect(hook(`${S}/before-agent.sh`, "").status).toBe(2);
    // the gate's script does not exist: bash exits 127, which must not let the spawn through
    expect(hook(`${S}/before-agent.sh`, spawnAgent("editor")).status).toBe(2);
    const bin = fs.mkdtempSync(join(os.tmpdir(), "at-nojq-"));
    const dn = spawnSync("/bin/sh", ["-c", "command -v dirname"], { encoding: "utf8" }).stdout.trim();
    fs.symlinkSync(dn, join(bin, "dirname"));
    const r = spawnSync("/bin/bash", [at(`${S}/before-agent.sh`)], { cwd: at("src/deep"), input: spawnAgent("editor"), env: { PATH: bin }, encoding: "utf8" });
    expect(r.status).toBe(2);
  });
});

describe.skipIf(!hasJq)("[CX-11] the human gate without ask", () => {
  beforeEach(() => {
    scaffold();
    fs.mkdirSync(at(".codex/scripts"), { recursive: true });
    fs.writeFileSync(at(".codex/scripts/render-check.sh"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  });
  it("[CX-11] a spawn behind a human step exits 2 with the reason; the record AGENTS.md describes (R-11, F-10) lets it start", () => {
    const r = hook(`${S}/before-agent.sh`, spawnAgent("editor"));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("approve");
    expect(r.stderr).toContain("The editor approves before editing");
    expect(r.stderr).toContain(".codex/state/approvals.jsonl");
    // neither stderr (R-11) nor AGENTS.md (F-10), both read by the model, holds a command that writes the record
    expect(r.stderr).not.toContain(">> .codex/state/approvals.jsonl");
    const md = fs.readFileSync(at("AGENTS.md"), "utf8");
    expect(md).not.toContain(">> .codex/state/approvals.jsonl");
    // the record the person writes, from the fields AGENTS.md names
    const line = md.split("\n").find((l) => l.includes("**Approval record:**"))!;
    for (const f of ["`step`", "`ok`", "`at`", "`approve`"]) expect(line).toContain(f);
    fs.mkdirSync(at(".codex/state"), { recursive: true });
    fs.writeFileSync(at(".codex/state/approvals.jsonl"), JSON.stringify({ step: "approve", ok: true, at: new Date().toISOString() }) + "\n");
    expect(hook(`${S}/before-agent.sh`, spawnAgent("editor")).status).toBe(0);
  });
  it("[CX-11] the last record decides: a later refusal blocks again", () => {
    fs.mkdirSync(at(".codex/state"), { recursive: true });
    fs.writeFileSync(at(".codex/state/approvals.jsonl"), [{ step: "approve", ok: true }, { step: "approve", ok: false }].map((l) => JSON.stringify(l)).join("\n") + "\n");
    expect(hook(`${S}/before-agent.sh`, spawnAgent("editor")).status).toBe(2);
  });
  it("[CX-11] no generated script prints \"ask\"", () => {
    const files = scaffold();
    for (const f of files.filter((x) => x.path.startsWith(".codex/scripts/"))) {
      expect(f.content, f.path).not.toMatch(/permissionDecision|"ask"/);
    }
  });
});

describe("[CX-9] release 1 label: Codex stays experimental and no guard is graded refuse", () => {
  it("[CX-9] the codex binding is marked experimental and no hook is proven", async () => {
    const { bindings } = await import("../../bindings/index.js");
    expect((bindings as Record<string, { experimental?: boolean }>)["codex"].experimental).toBe(true);
    const { CODEX_HOOKS_PROVEN } = await import("../../conformance/codex.js");
    expect(Object.values(CODEX_HOOKS_PROVEN).every((v) => v === false)).toBe(true);
  });

  it("[CX-9] guard --target codex prints no \"refuse\" grade, only the trust step", () => {
    const dir = fs.mkdtempSync(join(os.tmpdir(), "at-cx9-label-"));
    try {
      const r = spawnSync("node", [resolve(here, "../../../dist/cli/index.js"), "guard", FIXTURE, "--target", "codex", "--dir", dir], { encoding: "utf8" });
      expect(r.status).toBe(0);
      expect(r.stdout).not.toMatch(/\brefuse\b/i);
      expect(r.stdout).toContain("/hooks");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
