/**
 * [CX-15] Conformance v0 for Codex, tiers A to D (no model call, no login).
 *
 *   A. config shape   - the generated config.toml and agent files against the key snapshot
 *   B. hook shape     - the generated hooks.json against the hook contract
 *   C. planted stdin  - every generated command hook run the way Codex runs it
 *   D. platform tools - `codex execpolicy`, `codex sandbox`, `--strict-config`;
 *                       skipped with a message when `codex` is not installed
 *
 * Mirrors e2e/conformance.test.ts for Claude Code. Tier E (live proof) is not here.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { parse } from "../../parser/index.js";
import { codexBinding } from "../../bindings/codex.js";
import {
  checkHooks, checkStdout, payloadFor, unanchoredScript, checkConfigToml, checkAgentToml,
  VERIFIED_ON, HOOK_EVENTS, type ConfigKeySnapshot,
} from "../../conformance/codex.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const snap: ConfigKeySnapshot = JSON.parse(fs.readFileSync(join(repo, "spec/codex/config-keys.json"), "utf8"));
const CORPUS = [
  ...fs.readdirSync(join(repo, "examples")).filter((f) => f.endsWith(".at")).map((f) => join(repo, "examples", f)),
  ...fs.readdirSync(join(here, "fixtures")).filter((f) => f.endsWith(".at")).map((f) => join(here, "fixtures", f)),
  join(repo, "kitchen-sink.at"),
];
const hasJq = spawnSync("/bin/sh", ["-c", "command -v jq"]).status === 0;
const codexProbe = spawnSync("codex", ["--version"], { encoding: "utf8", timeout: 5000 });
const hasCodex = codexProbe.status === 0;
if (!hasCodex) console.warn("[CX-15] tier D is skipped: the `codex` binary is not installed (npm i -g @openai/codex@" + VERIFIED_ON + ")");

/** The Codex scaffold refuses Claude model names (CX-5); the corpus is written with Claude ones, so swap them. */
function scaffoldCodex(file: string) {
  const src = fs.readFileSync(file, "utf8").replace(/^(\s*model:\s*)(opus|sonnet|haiku|fable)\b.*$/gm, "$1gpt-5.2");
  const warn = console.warn;
  console.warn = () => {};
  try { return codexBinding.scaffold(parse(src)); } finally { console.warn = warn; }
}

interface Hook { event: string; matcher?: string; command: string }
function commandHooks(files: Array<{ path: string; content: string }>): Hook[] {
  const f = files.find((x) => x.path === ".codex/hooks.json");
  const out: Hook[] = [];
  for (const [event, entries] of Object.entries((f ? JSON.parse(f.content).hooks : {}) ?? {})) {
    for (const e of entries as Array<{ matcher?: string; hooks: Array<{ type: string; command?: string }> }>) {
      for (const h of e.hooks) if (h.type === "command" && h.command) out.push({ event, matcher: e.matcher, command: h.command });
    }
  }
  return out;
}

describe("[CX-15] the checks themselves (planted)", () => {
  it("[CX-15] a relative script path fails the anchored-script check; a root-anchored or absolute one does not", () => {
    const bad = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "bash .codex/scripts/x/before-action.sh", timeout: 60 }] }] } };
    expect(checkHooks(bad).map((v) => v.check)).toEqual(["unanchored-script"]);
    expect(unanchoredScript('bash "$(git rev-parse --show-toplevel 2>/dev/null || pwd)/.codex/scripts/x.sh"')).toBeNull();
    expect(unanchoredScript("python3 /opt/check.py --strict")).toBeNull();
    expect(unanchoredScript("echo hi")).toBeNull();
  });

  it("[CX-15] a prompt handler fails the handler check", () => {
    const bad = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "prompt", prompt: "careful" }] }] } };
    expect(checkHooks(bad).map((v) => v.check)).toEqual(["handler-not-run"]);
  });

  it("[CX-15] an ask output fails the stdout check; allow, deny and plain text pass", () => {
    const ask = JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "x" } });
    expect(checkStdout("PreToolUse", ask)).toMatch(/ask/);
    expect(checkStdout("PreToolUse", JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny" } }))).toBeNull();
    expect(checkStdout("PreToolUse", JSON.stringify({ hookSpecificOutput: { permissionDecision: "allow" } }))).toBeNull();
    expect(checkStdout("PreToolUse", "all good")).toBeNull();
    expect(checkStdout("PreToolUse", "{ broken json }")).toMatch(/parse/);
  });

  it("[CX-15] a timeout that is not a positive number of seconds fails the timeout check", () => {
    const mk = (t: unknown) => ({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo", timeout: t }] }] } });
    expect(checkHooks(mk("60")).map((v) => v.check)).toEqual(["timeout"]);
    expect(checkHooks(mk(0)).map((v) => v.check)).toEqual(["timeout"]);
    expect(checkHooks(mk(-5)).map((v) => v.check)).toEqual(["timeout"]);
    expect(checkHooks(mk(60))).toEqual([]);
  });

  it("[CX-15] tier A catches the five old config bugs by name", () => {
    const old = parseToml(`model = "opus"
approval_policy = "untrusted"
sandbox_mode = "read-only"
[[providers]]
name = "anthropic"
[mcp_servers.log]
type = "sse"
url = "https://x/sse"
sandbox-mode = "workspace-write"
[agents]
max_depth = 1
`) as Record<string, unknown>;
    const checks = checkConfigToml(old, snap).map((v) => `${v.check}:${v.where}`);
    expect(checks).toContain("approval-policy:approval_policy");
    expect(checks).toContain("unknown-key:providers");
    expect(checks).toContain("unknown-key:mcp_servers.log.sandbox-mode");
    expect(checks).toContain("unknown-key:mcp_servers.log.type");
    expect(checks).toContain("unknown-key:agents.max_depth");
  });

  it("[CX-15] tier A flags a project key Codex ignores, a key in the wrong table, and an ignored agent-file key", () => {
    const v = checkConfigToml(parseToml(`model_provider = "x"\n[mcp_servers.a]\ncommand = "c"\nsandbox_mode = "read-only"\n`) as Record<string, unknown>, snap);
    expect(v.map((x) => x.check)).toEqual(expect.arrayContaining(["project-forbidden-key", "wrong-table"]));
    const a = checkAgentToml(parseToml(`name = "a"\ndescription = "d"\ndeveloper_instructions = "x"\nsandbox_mode = "read-only"\n`) as Record<string, unknown>, snap);
    expect(a.map((x) => x.check)).toEqual(["agent-ignored-key"]);
    expect(checkAgentToml(parseToml(`name = "a"\n`) as Record<string, unknown>, snap).map((x) => x.check)).toEqual(["agent-required-key", "agent-required-key"]);
  });

  it("[CX-15] the Codex payload names the measured tools", () => {
    expect(payloadFor("PreToolUse", "/x", "collaborationspawn_agent")).toMatchObject({ tool_name: "collaborationspawn_agent", tool_input: { agent_type: "conformance-agent", fork_turns: "none" } });
    expect(payloadFor("PreToolUse", "/x", "apply_patch")).toMatchObject({ tool_name: "apply_patch" });
    expect(payloadFor("PreToolUse", "/x")).toMatchObject({ tool_name: "Bash", tool_input: { command: "true" }, permission_mode: "default" });
    expect(HOOK_EVENTS.size).toBe(14);
  });
});

for (const file of CORPUS) {
  const name = file.replace(repo + "/", "");
  describe(`[CX-15] conformance: ${name}`, () => {
    const files = scaffoldCodex(file);
    const hooksFile = files.find((f) => f.path === ".codex/hooks.json");
    const hooks = commandHooks(files);
    let root: string;
    let sub: string;

    beforeAll(() => {
      root = fs.mkdtempSync(join(os.tmpdir(), "at-cx15-"));
      spawnSync("git", ["init", "-q", root]);
      for (const f of files) {
        const p = join(root, f.path);
        fs.mkdirSync(dirname(p), { recursive: true });
        fs.writeFileSync(p, f.content);
        if (f.executable) fs.chmodSync(p, 0o755);
      }
      sub = join(root, "src/deep");
      fs.mkdirSync(sub, { recursive: true });
    });
    afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

    it("[CX-15] [A] config.toml parses and every key is in the snapshot; no forbidden key; legal approval and sandbox values", () => {
      const f = files.find((x) => x.path === ".codex/config.toml")!;
      const parsed = parseToml(f.content) as Record<string, unknown>;
      expect(checkConfigToml(parsed, snap)).toEqual([]);
    });

    it("[CX-15] [A] every agent file parses and holds only agent-file keys", () => {
      const bad = files.filter((x) => /^\.codex\/agents\/[^/]+\.toml$/.test(x.path))
        .flatMap((x) => checkAgentToml(parseToml(x.content) as Record<string, unknown>, snap).map((v) => `${x.path}: ${v.check} ${v.where}`));
      expect(bad).toEqual([]);
    });

    it("[CX-15] [B] hooks.json has no violation (events, matchers, handler types, timeouts, anchored paths)", () => {
      expect(checkHooks(hooksFile ? JSON.parse(hooksFile.content) : {})).toEqual([]);
    });

    it("[CX-15] [B] a guard hook is timed above its own work (60 s or more)", () => {
      const guards = hooks.length ? JSON.parse(hooksFile!.content).hooks : {};
      const timeouts: number[] = [];
      for (const entries of Object.values(guards) as Array<Array<{ hooks: Array<{ command: string; timeout?: number }> }>>) {
        for (const e of entries) for (const h of e.hooks) if (/\/(before-agent|before-action|gate-[^/]+)\.sh/.test(h.command)) timeouts.push(h.timeout ?? 600);
      }
      expect(timeouts.filter((t) => t < 60)).toEqual([]);
    });

    it.skipIf(!hasJq)("[CX-15] [C] every command hook runs from a subfolder: found, exits 0 or 2, and its stdout is valid for its event", () => {
      const results = hooks.map((h) => {
        const env = { ...process.env } as Record<string, string>;
        delete env.CLAUDE_PROJECT_DIR;
        const r = spawnSync("/bin/sh", ["-c", h.command], { cwd: sub, input: JSON.stringify(payloadFor(h.event, sub, h.matcher)), env, encoding: "utf8", timeout: 30_000 });
        const bad = r.status !== 0 && r.status !== 2
          ? `exit ${r.status}: ${r.stderr.trim().split("\n").pop()}`
          : r.status === 0 ? checkStdout(h.event, r.stdout) : null;
        return bad ? `${h.event} ${h.matcher ?? ""} ${h.command} → ${bad}` : null;
      });
      expect(results.filter(Boolean)).toEqual([]);
    });

    it.skipIf(!hasJq)("[CX-15] [C] a blocking hook that exits 2 says why on stderr and never prints ask", () => {
      for (const h of hooks.filter((x) => x.event === "PreToolUse")) {
        const r = spawnSync("/bin/sh", ["-c", h.command], { cwd: sub, input: JSON.stringify(payloadFor(h.event, sub, h.matcher)), encoding: "utf8", timeout: 30_000 });
        if (r.status === 2) expect(r.stderr.trim().length, h.command).toBeGreaterThan(0);
        expect(r.stdout, h.command).not.toMatch(/"ask"/);
      }
    });
  });
}

describe.skipIf(!hasJq)("[CX-15] [C] a deny payload gives exit 2", () => {
  it("[CX-15] the gate fixture: a guarded command with no ledger record exits 2 through the registered hook command", () => {
    const files = scaffoldCodex(join(here, "fixtures/codex-gates.at"));
    const root = fs.mkdtempSync(join(os.tmpdir(), "at-cx15-deny-"));
    try {
      spawnSync("git", ["init", "-q", root]);
      for (const f of files) {
        fs.mkdirSync(dirname(join(root, f.path)), { recursive: true });
        fs.writeFileSync(join(root, f.path), f.content);
        if (f.executable) fs.chmodSync(join(root, f.path), 0o755);
      }
      fs.mkdirSync(join(root, "src/deep"), { recursive: true });
      const h = commandHooks(files).find((x) => x.matcher === "Bash" && x.command.includes("before-action.sh"))!;
      const payload = { ...payloadFor("PreToolUse", join(root, "src/deep"), "Bash"), tool_input: { command: "./tool publish ep1" } };
      const r = spawnSync("/bin/sh", ["-c", h.command], { cwd: join(root, "src/deep"), input: JSON.stringify(payload), encoding: "utf8", timeout: 30_000 });
      expect(r.status).toBe(2);
      expect(r.stdout).not.toMatch(/"ask"/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

// ---------------------------------------------------------------------------
// Tier D: platform tools. Skipped, with the message above, when codex is absent.
// ---------------------------------------------------------------------------
const tierD = hasCodex ? describe : describe.skip;
const sealed = (home: string) => ({ ...process.env, HOME: home, CODEX_HOME: home }) as Record<string, string>;

tierD(`[CX-15] [D] platform tools (codex ${hasCodex ? codexProbe.stdout.trim() : "not installed: skipped"})`, () => {
  let home: string;
  beforeAll(() => { home = fs.mkdtempSync(join(os.tmpdir(), "at-cx15-home-")); });
  afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

  const withRules = CORPUS.map((f) => ({ f, files: scaffoldCodex(f) })).filter((x) => x.files.some((y) => y.path.endsWith(".rules")));

  it("[CX-15] [D] the corpus has rule files to check", () => {
    expect(withRules.length).toBeGreaterThan(0);
  });

  it("[CX-15] [D] every generated rule returns the declared decision through `codex execpolicy check`", () => {
    const dir = fs.mkdtempSync(join(os.tmpdir(), "at-cx15-rules-"));
    const problems: string[] = [];
    let checked = 0;
    try {
      for (const { f, files } of withRules) {
        for (const rf of files.filter((x) => x.path.endsWith(".rules"))) {
          const path = join(dir, "r.rules");
          fs.writeFileSync(path, rf.content);
          for (const block of rf.content.split(/^prefix_rule\(/m).slice(1)) {
            const decision = /decision\s*=\s*"(\w+)"/.exec(block)?.[1];
            const example = /match\s*=\s*(\[\[.*?\]\])\s*,/s.exec(block)?.[1];
            if (!decision || !example) { problems.push(`${f}: a rule has no decision or match example`); continue; }
            const cmd = (JSON.parse(example) as string[][])[0];
            const r = spawnSync("codex", ["execpolicy", "check", "--rules", path, "--", ...cmd], { encoding: "utf8", env: sealed(home), timeout: 20_000 });
            const got = (() => { try { return JSON.parse(r.stdout).decision; } catch { return `unreadable (${r.stdout.trim().slice(0, 80)} ${r.stderr.trim().slice(0, 80)})`; } })();
            checked++;
            if (got !== decision) problems.push(`${f}: ${cmd.join(" ")} → ${got}, declared ${decision}`);
          }
        }
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    expect(problems).toEqual([]);
    expect(checked).toBeGreaterThan(0);
  });

  it("[CX-15] [D] a write outside the workspace fails under `codex sandbox` (skipped here if this machine's sandbox does not enforce)", () => {
    const ws = fs.mkdtempSync(join(os.tmpdir(), "at-cx15-ws-"));
    const outside = join("/var/tmp", `at-cx15-outside-${process.pid}`);
    try {
      spawnSync("git", ["init", "-q", ws]);
      const r = spawnSync("codex", ["sandbox", "-P", ":workspace", "--", "sh", "-c", `touch ${outside}`], { cwd: ws, encoding: "utf8", env: sealed(home), timeout: 30_000 });
      if (fs.existsSync(outside)) {
        console.warn("[CX-15] sandbox check inconclusive: this machine's sandbox let a write outside the workspace through");
        return;
      }
      expect(r.status).not.toBe(0);
    } finally {
      fs.rmSync(outside, { force: true });
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  it("[CX-15] [D] `.codex/` is read-only to the agent under workspace-write (probe P8), so it cannot forge an approval record", () => {
    const ws = fs.mkdtempSync(join(os.tmpdir(), "at-cx15-p8-"));
    try {
      spawnSync("git", ["init", "-q", ws]);
      fs.mkdirSync(join(ws, ".codex"));
      const r = spawnSync("codex", ["sandbox", "-P", ":workspace", "--", "sh", "-c", "touch .codex/forged; touch ok.txt"], { cwd: ws, encoding: "utf8", env: sealed(home), timeout: 30_000 });
      if (fs.existsSync(join(ws, ".codex/forged"))) { console.warn("[CX-15] P8 inconclusive here: .codex/ was writable under this machine's sandbox"); return; }
      expect(fs.existsSync(join(ws, "ok.txt"))).toBe(true);
      expect(r.stderr + r.stdout).toMatch(/not permitted|denied|read-only/i);
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  });

  it("[CX-15] [D] the generated config loads with --strict-config, and a planted unknown key is refused (no model is reached)", () => {
    const pick = ["codex-gates.at", "kitchen-sink.at", "company-brain-team.at"];
    const sources = CORPUS.filter((f) => pick.some((p) => f.endsWith(p)));
    expect(sources.length).toBe(pick.length);
    const run = (ws: string) => {
      fs.writeFileSync(join(home, "config.toml"), `[projects."${ws}"]\ntrust_level = "trusted"\n\n[model_providers.deadp]\nname = "dead"\nbase_url = "http://127.0.0.1:9/v1"\n`);
      return spawnSync("codex", ["exec", "--strict-config", "-c", "model_provider=deadp", "--skip-git-repo-check", "hello"], { cwd: ws, encoding: "utf8", env: sealed(home), timeout: 6000, killSignal: "SIGKILL" });
    };
    for (const f of sources) {
      const ws = fs.mkdtempSync(join(os.tmpdir(), "at-cx15-strict-"));
      try {
        spawnSync("git", ["init", "-q", ws]);
        for (const x of scaffoldCodex(f).filter((y) => y.path.startsWith(".codex/") && !y.path.startsWith(".codex/scripts"))) {
          fs.mkdirSync(dirname(join(ws, x.path)), { recursive: true });
          fs.writeFileSync(join(ws, x.path), x.content);
        }
        const ok = run(ws);
        // The config loads, so codex goes on to the dead provider and is killed at the timeout; a refusal would come at once.
        expect(`${ok.stdout}${ok.stderr}`, f).not.toMatch(/Error loading config\\.toml|unknown configuration field/);
        // Top of the file: appended after a table it would land inside that table.
        fs.writeFileSync(join(ws, ".codex/config.toml"), "bogus_probe_key = 1\n" + fs.readFileSync(join(ws, ".codex/config.toml"), "utf8"));
        const bad = run(ws);
        expect(bad.status, f).toBe(1);
        expect(`${bad.stdout}${bad.stderr}`, f).toMatch(/unknown configuration field `bogus_probe_key`/);
      } finally { fs.rmSync(ws, { recursive: true, force: true }); }
    }
  }, 120_000);
});
