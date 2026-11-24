/**
 * A gate before a script step with both a `ledger` and a `run:` check. Both checks hold the step:
 * the ledger first, then the run, and each refusal says which one failed. The generated
 * before-action.sh is run the way each platform runs a hook (a shell, a subfolder as the current
 * directory, the event's JSON on stdin), on Claude Code and on Codex.
 *
 * guard --check grades such a gate from the script on disk: a before-action.sh that has the gate's
 * line but no longer runs its check (or no longer reads its ledger), for example one kept from an
 * older scaffold or edited by hand, holds less than the .at says, so it is not graded as refusing.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { parse } from "../../parser/index.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import { codexBinding } from "../../bindings/codex.js";
import { checkGuards } from "../../guard/check.js";
import { checkCodexGuards } from "../../guard/check-codex.js";

const hasJq = spawnSync("/bin/sh", ["-c", "command -v jq"]).status === 0;

const topology = (model: string, gateExtra = "") => `topology kpi : [pipeline] {
  meta {
    version: "1.0.0"
    description: "Measure then keep"
  }
  orchestrator {
    model: ${model}
    handles: [measure, keep]
  }
  action measure {
    kind: external
    commands: ["./tool measure"]
  }
  action keep {
    kind: external
    commands: ["./tool keep"]
  }
  records {
    record kpix { path: "logs/kpi-x.jsonl" }
  }
  gates {
    gate keep-ready {
      after: measure
      before: keep
      ledger: kpix
      run: "bash tools/check.sh"
      on-fail: halt${gateExtra}
    }
  }
  flow { measure -> keep }
}
`;

interface Platform {
  name: string;
  model: string;
  binding: typeof claudeCodeBinding;
  script: string;
  run: (stdin: string) => ReturnType<typeof spawnSync>;
  check: typeof checkGuards;
  holds: string;
}

let root: string;
const at = (p: string) => join(root, p);

const PLATFORMS: Platform[] = [
  {
    name: "claude-code",
    model: "sonnet",
    binding: claudeCodeBinding,
    script: ".claude/skills/kpi/scripts/before-action.sh",
    run: (stdin) => spawnSync("/bin/sh", ["-c", `bash "$CLAUDE_PROJECT_DIR/.claude/skills/kpi/scripts/before-action.sh"`], {
      cwd: at("src/deep"), input: stdin, env: { ...process.env, CLAUDE_PROJECT_DIR: root }, encoding: "utf8", timeout: 30_000,
    }),
    check: checkGuards,
    holds: "refuse",
  },
  {
    name: "codex",
    model: "gpt-5.2",
    binding: codexBinding,
    script: ".codex/scripts/kpi/before-action.sh",
    run: (stdin) => {
      const e = { ...process.env } as Record<string, string>;
      delete e.CLAUDE_PROJECT_DIR;
      return spawnSync("/bin/sh", ["-c", `bash "$(git -C . rev-parse --show-toplevel)/.codex/scripts/kpi/before-action.sh"`], {
        cwd: at("src/deep"), input: stdin, env: e, encoding: "utf8", timeout: 30_000,
      });
    },
    check: checkCodexGuards,
    holds: "unverified",
  },
];

function scaffold(p: Platform, src = topology(p.model)) {
  const ast = parse(src);
  for (const f of p.binding.scaffold(ast)) {
    fs.mkdirSync(dirname(at(f.path)), { recursive: true });
    fs.writeFileSync(at(f.path), f.content);
    if (f.executable) fs.chmodSync(at(f.path), 0o755);
  }
  fs.mkdirSync(at("src/deep"), { recursive: true });
  return ast;
}

/** The gate's check: it leaves a mark that it ran, then exits with `code`. */
const checkExits = (code: number) =>
  fs.writeFileSync(at("tools/check.sh"), `#!/usr/bin/env bash\ntouch "${at("check-ran")}"\nexit ${code}\n`, { mode: 0o755 });
const ledger = (ok: boolean) => {
  fs.mkdirSync(at("logs"), { recursive: true });
  fs.writeFileSync(at("logs/kpi-x.jsonl"), JSON.stringify({ step: "measure", ok, at: "2026-01-01T00:00:00Z" }) + "\n");
};
const bash = (command: string) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
const ran = () => fs.existsSync(at("check-ran"));

beforeEach(() => { root = fs.mkdtempSync(join(os.tmpdir(), "at-ledger-run-")); spawnSync("git", ["init", "-q", root]); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe.skipIf(!hasJq).each(PLATFORMS)("a gate with a ledger and a run: check holds the step on both ($name)", (p) => {
  beforeEach(() => { scaffold(p); });

  it("the ledger row is ok but the check exits 1: the step is refused, naming the check", () => {
    ledger(true);
    checkExits(1);
    const r = p.run(bash("./tool keep"));
    expect(r.status).toBe(2);
    expect(ran()).toBe(true);
    expect(r.stderr).toContain("gate keep-ready refuses this command");
    expect(r.stderr).toContain("its check script failed");
  });

  it("the ledger row is ok and the check exits 0: the step runs", () => {
    ledger(true);
    checkExits(0);
    const r = p.run(bash("./tool keep"));
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(ran()).toBe(true);
  });

  it("the ledger row is not ok and the check passes: refused by the ledger, named, before the check runs", () => {
    ledger(false);
    checkExits(0);
    const r = p.run(bash("./tool keep"));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("ledger logs/kpi-x.jsonl");
    expect(r.stderr).not.toContain("its check script failed");
    expect(ran()).toBe(false);
  });

  it("no ledger file and the check passes: refused by the ledger", () => {
    checkExits(0);
    const r = p.run(bash("./tool keep"));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("the ledger logs/kpi-x.jsonl does not exist");
    expect(ran()).toBe(false);
  });

  it("a command that is not the step runs neither check", () => {
    checkExits(1);
    expect(p.run(bash("ls")).status).toBe(0);
    expect(ran()).toBe(false);
  });
});

describe("the before-action hook timeout counts the gate's run budget when it also has a ledger", () => {
  it("claude-code: a gate timeout of 100s makes the hook timeout 100 + 2 + 30", () => {
    root = fs.mkdtempSync(join(os.tmpdir(), "at-ledger-run-"));
    scaffold(PLATFORMS[0], topology("sonnet", "\n      timeout: 100s"));
    const settings = JSON.parse(fs.readFileSync(at(".claude/settings.json"), "utf8"));
    const entry = (settings.hooks.PreToolUse as Array<{ hooks: Array<{ command: string; timeout: number }> }>)
      .flatMap((e) => e.hooks).find((h) => h.command.includes("before-action.sh"));
    expect(entry?.timeout).toBe(132);
  });

  it("codex: the hook timeout is above the same budget", () => {
    scaffold(PLATFORMS[1], topology("gpt-5.2", "\n      timeout: 100s"));
    const hooks = JSON.parse(fs.readFileSync(at(".codex/hooks.json"), "utf8")).hooks;
    const entry = (hooks.PreToolUse as Array<{ hooks: Array<{ command: string; timeout: number }> }>)
      .flatMap((e) => e.hooks).find((h) => h.command.includes("before-action.sh"));
    expect(entry!.timeout).toBeGreaterThanOrEqual(132);
  });
});

describe.each(PLATFORMS)("guard --check grades the gate from what before-action.sh runs ($name)", (p) => {
  const grade = (ast: ReturnType<typeof parse>) => p.check(ast, root).items.find((i) => i.kind === "gate" && i.id === "keep-ready")!;
  const edit = (from: RegExp) => {
    const text = fs.readFileSync(at(p.script), "utf8");
    expect(text).toMatch(new RegExp(from.source, "m"));
    fs.writeFileSync(at(p.script), text.split("\n").filter((l) => !from.test(l)).join("\n"));
  };

  it("as generated: the gate holds", () => {
    const ast = scaffold(p);
    checkExits(0);
    expect(grade(ast).strength).toBe(p.holds);
  });

  it("before-action.sh no longer runs the gate's check: graded none, and the note says so", () => {
    const ast = scaffold(p);
    checkExits(0);
    edit(/^\s*at_gate 'keep-ready' /);
    const g = grade(ast);
    expect(g.strength).toBe("none");
    expect(g.notes.join("\n")).toContain("before-action.sh does not run the run: check of gate keep-ready");
  });

  it("before-action.sh no longer reads the gate's ledger: graded none, and the note says so", () => {
    const ast = scaffold(p);
    checkExits(0);
    edit(/^\s*check_ledger 'keep-ready' /);
    const g = grade(ast);
    expect(g.strength).toBe("none");
    expect(g.notes.join("\n")).toContain("before-action.sh does not read the ledger of gate keep-ready");
  });
});
