/**
 * 0.11.1: the step and ledger guards fire for every Claude Code tool that runs
 * a shell command. Claude Code has three: Bash, Monitor and PowerShell. A hook
 * that matches only `Bash` never fires for PowerShell (hooks reference), and
 * fires for Monitor's commands only from Claude Code 2.1.314. 0.11.0 wired
 * before-action.sh on `Bash` alone, so on a PowerShell setup a gated step, or
 * a ledger write, met no guard.
 *
 * The PowerShell payload (tool_name "PowerShell", the command string in
 * tool_input.command) is from the docs, not measured on a live Claude Code;
 * guard --check says so on the grade line.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import { matcherMatches } from "../../conformance/claude-code.js";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, "../../../dist/cli/index.js");
const hasJq = spawnSync("/bin/sh", ["-c", "command -v jq"]).status === 0;

const TOPOLOGY = `topology ship : [pipeline] {
  meta { version: "1.0.0" description: "Render then publish" }
  orchestrator { model: sonnet handles: [render, publish] }
  action render {
    kind: external
    commands: ["./tool render"]
  }
  action publish {
    kind: external
    commands: ["./tool publish"]
    unit-from: "./tool publish (\\S+)"
  }
  records {
    record trace { path: "logs/{unit}/trace.jsonl" }
  }
  gates {
    gate publish-ready {
      after: render
      before: publish
      ledger: trace
      on-fail: halt
    }
  }
  flow { render -> publish }
}
`;

let root: string;
const at = (p: string) => join(root, p);
const SCRIPT = ".claude/skills/ship/scripts/before-action.sh";
type Entry = { matcher?: string; hooks: Array<{ type: string; command: string; onFailure?: string }> };
const settings = () => JSON.parse(fs.readFileSync(at(".claude/settings.json"), "utf8")) as { hooks: Record<string, Entry[]> };
const actionEntry = () => settings().hooks.PreToolUse.find((e) => e.hooks.some((h) => h.command.includes("before-action.sh")))!;

function scaffold() {
  for (const f of claudeCodeBinding.scaffold(parse(TOPOLOGY))) {
    fs.mkdirSync(dirname(at(f.path)), { recursive: true });
    fs.writeFileSync(at(f.path), f.content);
    if (f.executable) fs.chmodSync(at(f.path), 0o755);
  }
  fs.mkdirSync(at("src/deep"), { recursive: true });
}
function hook(stdin: string) {
  return spawnSync("/bin/sh", ["-c", `bash "$CLAUDE_PROJECT_DIR/${SCRIPT}"`], {
    cwd: at("src/deep"), input: stdin, env: { ...process.env, CLAUDE_PROJECT_DIR: root }, encoding: "utf8", timeout: 20_000,
  });
}
const payload = (tool_name: string, tool_input: Record<string, unknown>) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id: "t1" });
const pwsh = (command: string) => payload("PowerShell", { command });
const okRecord = (unit: string) => {
  fs.mkdirSync(at(`logs/${unit}`), { recursive: true });
  fs.writeFileSync(at(`logs/${unit}/trace.jsonl`), JSON.stringify({ step: "render", unit, ok: true, at: "2026-01-01T00:00:00Z" }) + "\n");
};

beforeEach(() => { root = fs.mkdtempSync(join(os.tmpdir(), "at-shell-tools-")); scaffold(); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("[0.11.1] before-action.sh is wired on every shell tool", () => {
  it("[0.11.1] the PreToolUse entry's matcher is Bash|Monitor|PowerShell, onFailure block", () => {
    expect(actionEntry()).toEqual({
      matcher: "Bash|Monitor|PowerShell",
      hooks: [{ type: "command", command: `bash "$CLAUDE_PROJECT_DIR/${SCRIPT}"`, onFailure: "block" }],
    });
    for (const tool of ["Bash", "Monitor", "PowerShell"]) expect(matcherMatches("PreToolUse", actionEntry().matcher, tool), tool).toBe(true);
    expect(matcherMatches("PreToolUse", actionEntry().matcher, "Write")).toBe(false);
  });
  it("[0.11.1] the script's header names the three tools it is wired on", () => {
    expect(fs.readFileSync(at(SCRIPT), "utf8")).toContain("PreToolUse hook on Bash, Monitor and PowerShell");
  });
});

describe.skipIf(!hasJq)("[0.11.1] a PowerShell payload goes through the same reading and deny-on-doubt", () => {
  for (const command of [
    "& ./tool publish ep1",
    '& "./tool" publish ep1',
    "./tool publish ep1; echo x",
    "./tool publish ep1 | Out-Null",
  ]) {
    it(`[0.11.1] ${command}: refused with no ok record`, () => {
      const r = hook(pwsh(command));
      expect(r.status, r.stderr).toBe(2);
      expect(r.stderr).toContain("publish-ready");
      expect(r.stderr).toContain("no ok record");
    });
  }
  it("[0.11.1] a backtick-escaped tool name (PowerShell's escape) is unreadable, so refused", () => {
    const r = hook(pwsh("./to`ol publish ep1"));
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toContain("publish-ready");
  });
  for (const command of [
    ".\\tool publish ep1",
    "& .\\tool publish ep1",
    'cmd /c ".\\tool publish ep1"',
  ]) {
    it(`[0.11.1] ${command}: a backslash is a path separator, so refused with no ok record`, () => {
      const r = hook(pwsh(command));
      expect(r.status, r.stderr).toBe(2);
      expect(r.stderr).toContain("no ok record");
    });
  }
  for (const command of [
    '& ./tool @("publish","ep1")',
    'Start-Process ./tool -ArgumentList "publish","ep1"',
    ".\\tool.exe publish ep1",
    "./tool.ps1 publish ep1",
  ]) {
    it(`[0.11.1] ${command}: a mention of the tool not read as a declared step is doubt, refused even with an ok record`, () => {
      okRecord("ep1");
      const r = hook(pwsh(command));
      expect(r.status, r.stderr).toBe(2);
      expect(r.stderr).toContain("a PowerShell form");
    });
  }
  it("[0.11.1] with an ok record the plain PowerShell forms pass, and an ungated step runs", () => {
    okRecord("ep1");
    expect(hook(pwsh("& ./tool publish ep1")).status).toBe(0);
    expect(hook(pwsh(".\\tool publish ep1")).status).toBe(0);
    expect(hook(pwsh(".\\tool render ep1")).status).toBe(0);
  });
  it("[0.11.1] the same doubt does not apply to a Bash payload (bash reads .\\tool as .tool)", () => {
    okRecord("ep1");
    const r = hook(payload("Bash", { command: './tool @("publish","ep1")' }));
    expect(r.status, r.stderr).toBe(0);
  });
  it("[0.11.1] Get-Content of the ledger only reads it, so it passes", () => {
    okRecord("ep1");
    for (const command of ["Get-Content logs/ep1/trace.jsonl", "Get-Content logs\\ep1\\trace.jsonl", "Select-String ok logs/ep1/trace.jsonl"]) {
      const r = hook(pwsh(command));
      expect(r.status, `${command}\n${r.stderr}`).toBe(0);
    }
  });
  it("[0.11.1] a PowerShell write to the ledger is refused by the ledger guard", () => {
    for (const command of [
      'Add-Content logs/ep1/trace.jsonl \'{"step":"render","unit":"ep1","ok":true}\'',
      'Set-Content -Path logs/ep1/trace.jsonl -Value x',
      'Set-Content logs\\ep1\\trace.jsonl x',
      'echo x > logs/ep1/trace.jsonl',
      'Get-Content x | Out-File logs/ep1/trace.jsonl',
    ]) {
      const r = hook(pwsh(command));
      expect(r.status, `${command}\n${r.stderr}`).toBe(2);
      expect(r.stderr).toContain("ledger");
    }
  });
});

describe.skipIf(!hasJq)("[0.11.1] Monitor", () => {
  it("[0.11.1] a Monitor call with no command (a ws input) is not a shell command and passes", () => {
    const r = hook(payload("Monitor", { ws: "ws://localhost:9000/events", description: "watch" }));
    expect(r.status, r.stderr).toBe(0);
  });
  it("[0.11.1] a Monitor shell command runs through the step guard", () => {
    const r = hook(payload("Monitor", { command: "./tool publish ep1", description: "watch" }));
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toContain("publish-ready");
  });
});

describe("[0.11.1] guard --check grades each shell tool on the grade line", () => {
  const check = (version: string) => {
    const file = at("ship.at");
    fs.writeFileSync(file, TOPOLOGY);
    const r = spawnSync("node", [CLI, "guard", file, "--check", "--dir", root], {
      encoding: "utf8", env: { ...process.env, NO_COLOR: "1", AGENTOPOLOGY_CLAUDE_VERSION: version },
    });
    return (r.stdout + r.stderr).split("\n").find((l) => l.includes("gate publish-ready")) ?? "";
  };
  it("[0.11.1] on 2.1.323: refuse (Bash), unverified (PowerShell: not measured); Monitor not flagged", () => {
    const line = check("2.1.323");
    expect(line).toContain("refuse (Bash), unverified (PowerShell: not measured)");
    expect(line).not.toContain("Monitor commands not checked");
    expect(line).toContain("PreToolUse on Bash|Monitor|PowerShell");
  });
  it("[0.11.1] on 2.1.300 (below 2.1.314) the line says Monitor commands are not checked", () => {
    const line = check("2.1.300");
    expect(line).toContain("refuse (Bash), unverified (PowerShell: not measured)");
    expect(line).toContain("Monitor commands not checked on Claude Code 2.1.300 (needs 2.1.314)");
  });
  it("[0.11.1] with the version unknown the line says Monitor commands are not checked", () => {
    expect(check("garbage")).toContain("Monitor commands not checked on an unknown Claude Code version (needs 2.1.314)");
  });
  it("[0.11.1] a 0.11.0 project (matcher Bash only) grades PowerShell none on the line", () => {
    const s = settings();
    actionEntryIn(s).matcher = "Bash";
    fs.writeFileSync(at(".claude/settings.json"), JSON.stringify(s, null, 2));
    const line = check("2.1.323");
    expect(line).toContain("refuse (Bash), none (PowerShell: not in the matcher; rerun guard --target claude-code)");
  });
});
const actionEntryIn = (s: { hooks: Record<string, Entry[]> }) => s.hooks.PreToolUse.find((e) => e.hooks.some((h) => h.command.includes("before-action.sh")))!;
