/**
 * By default before-action.sh does not read a command's own leading assignments into their uses: any
 * expansion among a gated tool's words is doubt, and the step's gate checks run. Each row below is a
 * command that names the gated step `./tool publish` through a variable; the gate's check fails, so
 * the guard must block it (exit 2) after running the check.
 *
 * The generated scripts (Claude Code and Codex) carry no assignment reader at all by default.
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

const topologyFor = (model: string) => `topology ship : [pipeline] {
  meta { version: "1.0.0" description: "Open then publish" }
  orchestrator { model: ${model} handles: [open, publish] }
  action open {
    kind: external
    commands: ["./tool open"]
  }
  action publish {
    kind: external
    commands: ["./tool publish"]
  }
  gates {
    gate publish-ready {
      after: open
      before: publish
      run: "scripts/check.sh"
      on-fail: halt
    }
  }
  flow { open -> publish }
}
`;
const topology = topologyFor("sonnet");

const SCRIPT = ".claude/skills/ship/scripts/before-action.sh";
let root: string;
let marker: string;

beforeAll(() => {
  root = fs.mkdtempSync(join(os.tmpdir(), "at-guard-resolution-off-"));
  marker = join(root, "gate-ran");
  for (const f of claudeCodeBinding.scaffold(parse(topology))) {
    fs.mkdirSync(dirname(join(root, f.path)), { recursive: true });
    fs.writeFileSync(join(root, f.path), f.content);
    if (f.executable) fs.chmodSync(join(root, f.path), 0o755);
  }
  // the gate is unmet: its check records that it ran, then fails
  fs.writeFileSync(join(root, ".claude/skills/ship/scripts/check.sh"), `#!/usr/bin/env bash\necho ran >> '${marker}'\nexit 1\n`, { mode: 0o755 });
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function run(command: string) {
  fs.rmSync(marker, { force: true });
  const r = spawnSync("/bin/sh", ["-c", `bash "$CLAUDE_PROJECT_DIR/${SCRIPT}"`], {
    cwd: root,
    input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    encoding: "utf8",
    timeout: 20_000,
  });
  return { status: r.status, stderr: r.stderr, gateRan: fs.existsSync(marker) };
}

describe("the generated scripts carry no assignment reader by default", () => {
  it("Claude Code: no file holds at_resolve or at_subst", () => {
    const hits = claudeCodeBinding.scaffold(parse(topology)).filter((f) => /at_resolve|at_subst/.test(f.content)).map((f) => f.path);
    expect(hits).toEqual([]);
  });
  it("Codex: no file holds at_resolve or at_subst", () => {
    const files = codexBinding.scaffold(parse(topologyFor("gpt-5.2")));
    expect(files.some((f) => f.path.endsWith("before-action.sh"))).toBe(true);
    const hits = files.filter((f) => /at_resolve|at_subst/.test(f.content)).map((f) => f.path);
    expect(hits).toEqual([]);
  });
});

describe.skipIf(!hasJq)("an expansion among the tool's words is doubt: the unmet gate runs and blocks", () => {
  const rows: [string, string][] = [
    // a modifier after a plain use, read by another shell
    ["a :t modifier", "t=/x/publish; ./tool $t:t ep1"],
    ["a :h modifier", "t=/x/publish; ./tool $t:h ep1"],
    ["a [1] subscript", "t=publish; ./tool $t[1] ep1"],
    // names bash sets itself
    ["$_", "_=publish; ./tool $_ ep1"],
    ["REPLY", "REPLY=publish; ./tool $REPLY ep1"],
    // an upper-case name
    ["an upper-case name", "T=publish; ./tool $T ep1"],
    // a value read by a child
    ["env runs the tool", "t=publish; env ./tool $t ep1"],
    ["bash -c runs the tool", "t=publish; bash -c './tool $t ep1'"],
    // a setter behind jobs -x
    ["read behind jobs -x", "t=x; jobs -x read t <<< publish; ./tool $t ep1"],
    // a name built at run time
    ["a value made from another", "a=pub; b=$a; ./tool ${b}lish ep1"],
    // the plain shape: a step that is not gated, then another
    ["an assignment, an ungated step, && another", "t=/x; ./tool open $t build && ./tool enter map"],
  ];
  for (const [shape, command] of rows) {
    it(`doubted, the gate runs and blocks: ${shape}`, () => {
      const r = run(command);
      expect(r.gateRan).toBe(true);
      expect(r.status).toBe(2);
    });
  }

  it("the step written out is blocked the same way", () => {
    const r = run("./tool publish ep1");
    expect(r.gateRan).toBe(true);
    expect(r.status).toBe(2);
  });

  it("a command that names no gated step and has no expansion runs, with no gate", () => {
    const r = run("./tool open build && ./tool enter map");
    expect(r.gateRan).toBe(false);
    expect(r.status).toBe(0);
  });
});
