/**
 * The generated hooks answer fast, and a gate check that runs long cannot hold a step for longer
 * than its budget.
 *
 * - Speed: every hook a topology generates is timed on a fixed set of command shapes, with every
 *   gate check stubbed to pass at once. Each run must answer in under 1 s. Each shape runs up to
 *   3 times and the best run counts, so a loaded machine (the full suite in parallel) does not
 *   fail a hook that is fast on its own.
 * - Budget: before-action.sh runs each gate check for at most the gate's own timeout (plus 2 s,
 *   so the wrapper's own timeout reports first), or 60 s when it declares none. Past it the check
 *   is stopped and the step is blocked (exit 2), with a message naming the gate, the cause and
 *   the fix. The settings entry carries a hook timeout above the sum of those budgets.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { parse } from "../../parser/index.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import { codexBinding } from "../../bindings/codex.js";

const hasJq = spawnSync("/bin/sh", ["-c", "command -v jq"]).status === 0;
const X = "python3 tools/runstate.py";

/** A topology with every guard script kind: a gated step (a run: gate and a ledger gate), a spawn guard, an edit guard. */
const topology = (gateExtra = "") => `topology ship : [pipeline] {
  meta { version: "1.0.0" description: "Open, accept, review" }
  orchestrator { model: sonnet handles: [open, accept, review] }
  action open {
    kind: external
    commands: ["${X} open"]
  }
  action accept {
    kind: external
    commands: ["${X} enter accept", "./tool publish"]
  }
  agent reviewer {
    model: sonnet
    description: "Reviews the accepted work"
  }
  records {
    record trace { path: "logs/trace.jsonl" }
  }
  gates {
    gate accept-ready {
      after: open
      before: accept
      run: "scripts/check.sh"
      on-fail: halt${gateExtra}
    }
    gate accept-logged {
      after: open
      before: accept
      ledger: trace
      on-fail: halt
    }
    gate review-ready {
      after: accept
      before: reviewer
      run: "scripts/check.sh"
      on-fail: halt
    }
  }
  flow { open -> accept -> reviewer }
}
`;

function scaffoldInto(dir: string, src: string, binding = claudeCodeBinding) {
  for (const f of binding.scaffold(parse(src))) {
    fs.mkdirSync(dirname(join(dir, f.path)), { recursive: true });
    fs.writeFileSync(join(dir, f.path), f.content);
    if (f.executable) fs.chmodSync(join(dir, f.path), 0o755);
  }
}

interface Hook { type: string; command?: string; timeout?: number }
interface Entry { matcher?: string; hooks: Hook[] }
const settingsHooks = (dir: string): Record<string, Entry[]> =>
  JSON.parse(fs.readFileSync(join(dir, ".claude/settings.json"), "utf8")).hooks;

/** The payload a hook gets for one shape: the tool its matcher names first, the shape in every field a guard reads. */
function payload(event: string, matcher: string | undefined, shape: string): string {
  const tool = (matcher ?? "Bash").split("|")[0];
  return JSON.stringify({
    hook_event_name: event,
    tool_name: tool,
    tool_input: { command: shape, file_path: "notes.txt", content: shape, subagent_type: "reviewer", prompt: shape, description: shape },
    prompt: shape,
  });
}

const SHAPES: [string, string][] = [
  ["plain command", "ls -la"],
  ["assignment then &&", `T=/x; ${X} open $T build && ${X} enter map`],
  ["pipes", `cat a.txt | grep foo | ${X} enter map`],
  ["subshell", `(cd sub && ${X} enter map)`],
  ["quoted strings", `echo "a && b; c | d" 'e || f' && ${X} enter "the map"`],
  ["here-string", `${X} enter map <<< "$(cat notes.txt)"`],
  ["resolved: S=accept names the step", `S=accept; ${X} enter $S`],
  ["doubted: prefix assignment", `T=/x ${X} enter $T`],
  ["doubted: reassigned", `T=/x; ${X} enter $T; T=/y`],
  ["doubted: export", `export T=/x; ${X} enter $T`],
  ["the step written out", `${X} enter accept`],
];

describe.skipIf(!hasJq)("every generated hook answers in under 1 s on every shape", () => {
  let root: string;
  beforeAll(() => {
    root = fs.mkdtempSync(join(os.tmpdir(), "at-guard-speed-"));
    scaffoldInto(root, topology());
    // every gate program stubbed to pass at once
    fs.writeFileSync(join(root, ".claude/skills/ship/scripts/check.sh"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    fs.mkdirSync(join(root, "logs"), { recursive: true });
    fs.writeFileSync(join(root, "logs/trace.jsonl"), JSON.stringify({ step: "open", ok: true, at: "2026-01-01T00:00:00Z" }) + "\n");
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it("the topology generates the hooks this test times", () => {
    const commands = Object.values(settingsHooks(root)).flat().flatMap((e) => e.hooks).map((h) => h.command ?? "");
    for (const script of ["before-action.sh", "before-agent.sh", "before-edit.sh"]) {
      expect(commands.some((c) => c.includes(script)), script).toBe(true);
    }
  });

  it("times every hook on every shape (best of 3 runs)", () => {
    const rows: string[] = [];
    const slow: string[] = [];
    for (const [event, entries] of Object.entries(settingsHooks(root))) {
      for (const entry of entries) {
        for (const h of entry.hooks) {
          if (h.type !== "command" || !h.command) continue;
          const script = /([\w.-]+\.sh)/.exec(h.command)?.[1] ?? h.command;
          for (const [shape, command] of SHAPES) {
            let best = Infinity;
            let status: number | null = null;
            for (let i = 0; i < 3 && best >= 1000; i++) {
              const t0 = performance.now();
              const r = spawnSync("/bin/sh", ["-c", h.command], {
                cwd: root,
                input: payload(event, entry.matcher, command),
                env: { ...process.env, CLAUDE_PROJECT_DIR: root },
                encoding: "utf8",
                timeout: 20_000,
              });
              best = Math.min(best, performance.now() - t0);
              status = r.status;
            }
            const row = `[speed] ${event} ${entry.matcher ?? "-"} ${script} | ${shape}: ${Math.round(best)} ms, exit ${status}`;
            rows.push(row);
            if (best >= 1000) slow.push(row);
          }
        }
      }
    }
    console.log(rows.join("\n"));
    expect(rows.length).toBeGreaterThanOrEqual(3 * SHAPES.length);
    expect(slow).toEqual([]);
  });
});

describe.skipIf(!hasJq)("a gate check is bounded by its budget inside before-action.sh", () => {
  let root: string;
  const SCRIPT = ".claude/skills/ship/scripts/before-action.sh";
  const check = () => join(root, ".claude/skills/ship/scripts/check.sh");
  const run = (command: string, env: Record<string, string> = {}) => {
    const t0 = performance.now();
    const r = spawnSync("/bin/sh", ["-c", `bash "$CLAUDE_PROJECT_DIR/${SCRIPT}"`], {
      cwd: root,
      input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: root, ...env },
      encoding: "utf8",
      timeout: 40_000,
    });
    return { ...r, ms: performance.now() - t0 };
  };
  beforeAll(() => {
    root = fs.mkdtempSync(join(os.tmpdir(), "at-guard-budget-"));
    scaffoldInto(root, topology("\n      timeout: 2s"));
    fs.mkdirSync(join(root, "logs"), { recursive: true });
    fs.writeFileSync(join(root, "logs/trace.jsonl"), JSON.stringify({ step: "open", ok: true, at: "2026-01-01T00:00:00Z" }) + "\n");
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it("a check that ignores its own timeout is stopped at the budget, with every process it started, and the step is blocked", () => {
    // TERM is ignored by the check and by the sleep it starts, so the wrapper's own `timeout 2s` cannot stop it.
    fs.writeFileSync(check(), "#!/usr/bin/env bash\ntrap '' TERM\nsleep 27.25\nexit 0\n", { mode: 0o755 });
    const r = run(`${X} enter accept`);
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toContain("gate accept-ready refuses this command");
    expect(r.stderr).toContain("its check took over 4 s, so the step is blocked; raise the gate's timeout: if it needs longer");
    expect(r.ms).toBeLessThan(12_000);
    const left = spawnSync("/bin/sh", ["-c", "pgrep -f 'sleep 27.25' || true"], { encoding: "utf8" }).stdout.trim();
    expect(left).toBe("");
  });

  it("the same with no timeout program on PATH (stock macOS)", () => {
    const bin = fs.mkdtempSync(join(os.tmpdir(), "at-budget-path-"));
    try {
      for (const d of (process.env.PATH ?? "").split(":").filter(Boolean)) {
        for (const f of fs.existsSync(d) ? fs.readdirSync(d) : []) {
          if (f === "timeout" || f === "gtimeout" || fs.existsSync(join(bin, f))) continue;
          try { fs.symlinkSync(join(d, f), join(bin, f)); } catch { /* skip */ }
        }
      }
      expect(spawnSync("/bin/sh", ["-c", "command -v timeout || command -v gtimeout || echo none"], { env: { PATH: bin }, encoding: "utf8" }).stdout.trim()).toBe("none");
      // The wrapper itself is replaced: its own `timeout 2s` needs the timeout program too, so here the
      // budget inside before-action.sh is the only bound.
      const wrapper = join(root, ".claude/skills/ship/scripts/gate-accept-ready.sh");
      const original = fs.readFileSync(wrapper, "utf8");
      fs.writeFileSync(wrapper, "#!/usr/bin/env bash\ntrap '' TERM\nsleep 27.5 &\nwait\nexit 0\n", { mode: 0o755 });
      let r;
      try {
        r = run(`${X} enter accept`, { PATH: bin });
      } finally {
        fs.writeFileSync(wrapper, original, { mode: 0o755 });
      }
      expect(r.status, r.stderr).toBe(2);
      expect(r.stderr).toContain("its check took over 4 s, so the step is blocked");
      expect(r.ms).toBeLessThan(12_000);
      const left = spawnSync("/bin/sh", ["-c", "pgrep -f 'sleep 27.5' || true"], { encoding: "utf8" }).stdout.trim();
      expect(left).toBe("");
    } finally {
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });

  it("a passing check passes, a failing one blocks with its own message, and a check runs once per command", () => {
    const marker = join(root, "gate-ran");
    fs.rmSync(marker, { force: true });
    fs.writeFileSync(check(), `#!/usr/bin/env bash\necho ran >> '${marker}'\nexit 0\n`, { mode: 0o755 });
    const ok = run(`${X} enter accept && ./tool publish && ${X} enter accept`);
    expect(ok.status, ok.stderr).toBe(0);
    expect(fs.readFileSync(marker, "utf8").trim().split("\n")).toHaveLength(1);
    fs.writeFileSync(check(), "#!/usr/bin/env bash\necho 'the check says no' >&2\nexit 1\n", { mode: 0o755 });
    const bad = run(`${X} enter accept`);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("the check says no");
    expect(bad.stderr).toContain("its check script failed");
    expect(bad.stderr).not.toContain("took over");
  });

  it("a gate with no timeout: gets the 60 s default budget", () => {
    const dir = fs.mkdtempSync(join(os.tmpdir(), "at-budget-default-"));
    try {
      scaffoldInto(dir, topology());
      const text = fs.readFileSync(join(dir, SCRIPT), "utf8");
      expect(text).toContain("at_gate 'accept-ready' 60 'declare a timeout: on the gate if it needs longer'");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the hook timeout covers the gate budgets", () => {
  const many = (timeouts: string[]) => {
    const gates = timeouts.map((t, i) => `    gate g${i} {\n      after: open\n      before: accept\n      run: "scripts/check.sh"\n      on-fail: halt${t ? `\n      timeout: ${t}` : ""}\n    }`).join("\n");
    return `topology ship : [pipeline] {
  meta { version: "1.0.0" description: "Open then accept" }
  orchestrator { model: sonnet handles: [open, accept] }
  action open {
    kind: external
    commands: ["${X} open"]
  }
  action accept {
    kind: external
    commands: ["${X} enter accept"]
  }
  gates {
${gates}
  }
  flow { open -> accept }
}
`;
  };
  const claudeEntry = (src: string) => {
    const dir = fs.mkdtempSync(join(os.tmpdir(), "at-budget-settings-"));
    try {
      scaffoldInto(dir, src);
      return settingsHooks(dir).PreToolUse.find((e) => e.matcher === "Bash|Monitor|PowerShell")!.hooks[0];
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  const codexEntry = (src: string) => {
    const dir = fs.mkdtempSync(join(os.tmpdir(), "at-budget-codex-"));
    try {
      scaffoldInto(dir, src, codexBinding);
      const hooks = JSON.parse(fs.readFileSync(join(dir, ".codex/hooks.json"), "utf8")).hooks as Record<string, Entry[]>;
      return hooks.PreToolUse.find((e) => e.matcher === "Bash" && e.hooks[0].command!.includes("before-action.sh"))!.hooks[0];
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  it("Claude Code: before-action.sh's entry blocks on failure and carries a timeout above the budgets", () => {
    const one = claudeEntry(many([""]));
    expect(one).toMatchObject({ onFailure: "block", timeout: 120 });
    // three gates with no timeout: 3 x 60 s, plus 30 s for jq, the ledger reads and start-up
    expect(claudeEntry(many(["", "", ""])).timeout).toBe(210);
    // 5m and 10m: (300 + 2) + (600 + 2) + 60 + 30
    expect(claudeEntry(many(["5m", "10m", ""])).timeout).toBe(994);
  });

  it("Codex: before-action.sh's entry timeout covers the same budgets, and its deadline stays below it", () => {
    expect(codexEntry(many([""])).timeout).toBe(120);
    const three = codexEntry(many(["", "", ""]));
    // 3 x 60 s + 30 s, plus the 10 s between the guard's own deadline and the hook timeout
    expect(three.timeout).toBe(220);
    expect(three.command).toContain("-s KILL 210 ");
  });
});
