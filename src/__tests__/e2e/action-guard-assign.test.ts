/**
 * before-action.sh reads a variable the command itself sets to a plain literal at its start
 * (`T=/x; tool open $T build && tool enter map`) as that literal: the step's words are then read
 * as written, and a command that names no gated step runs without running the gate checks.
 * Every other shape of assignment stays unreadable, and the gate checks run as before.
 *
 * The gate's check script appends a line to a marker file, so each row can tell whether the
 * gate ran.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { parse } from "../../parser/index.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";

const topology = `topology ship : [pipeline] {
  meta { version: "1.0.0" description: "Open then accept" }
  orchestrator { model: sonnet handles: [open, accept] }
  action open {
    kind: external
    commands: ["python3 tools/runstate.py open"]
  }
  action accept {
    kind: external
    commands: ["python3 tools/runstate.py enter accept"]
  }
  gates {
    gate accept-ready {
      after: open
      before: accept
      run: "scripts/check.sh"
      on-fail: halt
    }
  }
  flow { open -> accept }
}
`;

const SCRIPT = ".claude/skills/ship/scripts/before-action.sh";
const X = "python3 tools/runstate.py";
let root: string;
let marker: string;

beforeAll(() => {
  root = fs.mkdtempSync(join(os.tmpdir(), "at-guard-assign-"));
  marker = join(root, "gate-ran");
  for (const f of claudeCodeBinding.scaffold(parse(topology))) {
    fs.mkdirSync(dirname(join(root, f.path)), { recursive: true });
    fs.writeFileSync(join(root, f.path), f.content);
    if (f.executable) fs.chmodSync(join(root, f.path), 0o755);
  }
  fs.writeFileSync(join(root, ".claude/skills/ship/scripts/check.sh"), `#!/usr/bin/env bash\necho ran >> '${marker}'\nexit 0\n`, { mode: 0o755 });
  fs.mkdirSync(join(root, "src/deep"), { recursive: true });
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
beforeEach(() => fs.rmSync(marker, { force: true }));

function run(command: string) {
  fs.rmSync(marker, { force: true });
  const t0 = performance.now();
  const r = spawnSync("/bin/sh", ["-c", `bash "$CLAUDE_PROJECT_DIR/${SCRIPT}"`], {
    cwd: join(root, "src/deep"),
    input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    encoding: "utf8",
    timeout: 20_000,
  });
  const ms = performance.now() - t0;
  return { status: r.status, stderr: r.stderr, ms, gateRan: fs.existsSync(marker) };
}

describe("a literal assignment at the command's start is read as its value", () => {
  it("the measured shape: an assignment, a step that is not gated, && another: no gate runs, under 1 s", () => {
    const r = run(`T=/x; ${X} open $T build && ${X} enter map`);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.gateRan).toBe(false);
    expect(r.ms).toBeLessThan(1000);
  });

  const resolved: [string, string][] = [
    ["; then $T", `T=/x; ${X} enter $T`],
    ["&& then \${T}", `T=/x && ${X} enter \${T}`],
    ["a newline then $T", `T=/x\n${X} enter $T`],
    ["two assignments, both used", `A=/x; B=map; ${X} $B $A`],
    ["the value quoted where it is used", `T=/x; ${X} enter "$T"`],
  ];
  for (const [shape, command] of resolved) {
    it(`resolved, no gated step named: ${shape}`, () => {
      const r = run(command);
      expect(r.status).toBe(0);
      expect(r.gateRan).toBe(false);
    });
  }
});

describe("a resolved value that names the step is still the step", () => {
  const literal = run.bind(null);
  const caught: [string, string][] = [
    ["S=accept; tool enter $S", `S=accept; ${X} enter $S`],
    ["S=accept && tool enter \${S}", `S=accept && ${X} enter \${S}`],
    ["A=enter; B=accept; tool $A $B", `A=enter; B=accept; ${X} $A $B`],
    ["a newline between", `S=accept\n${X} enter $S`],
  ];
  for (const [shape, command] of caught) {
    it(`caught like the literal command: ${shape}`, () => {
      const plain = literal(`${X} enter accept`);
      expect(plain.gateRan).toBe(true);
      const r = run(command);
      expect(r.gateRan).toBe(true);
      expect(r.status).toBe(plain.status);
    });
  }

  it("a failing check blocks the resolved form the way it blocks the literal one", () => {
    const check = join(root, ".claude/skills/ship/scripts/check.sh");
    const before = fs.readFileSync(check, "utf8");
    try {
      fs.writeFileSync(check, `#!/usr/bin/env bash\necho ran >> '${marker}'\nexit 1\n`, { mode: 0o755 });
      expect(run(`${X} enter accept`).status).toBe(2);
      const r = run(`S=accept; ${X} enter $S`);
      expect(r.gateRan).toBe(true);
      expect(r.status).toBe(2);
    } finally {
      fs.writeFileSync(check, before, { mode: 0o755 });
    }
  });
});

describe("every other assignment stays unreadable: the gate checks run", () => {
  const doubted: [string, string][] = [
    ["a reassignment later in the command", `T=/x; ${X} enter $T; T=/y`],
    ["an assignment inside a subshell", `( T=/x; ${X} enter $T )`],
    ["an assignment as a pipeline stage", `T=/x | ${X} enter $T`],
    ["a prefix assignment", `T=/x ${X} enter $T`],
    ["a conditional assignment", `false && T=/x; ${X} enter $T`],
    ["export T=x", `export T=/x; ${X} enter $T`],
    ["a value with $", `T=$HOME; ${X} enter $T`],
    ["a value with a glob", `T=/x*; ${X} enter $T`],
    ["a quoted value with a space", `T="/x y"; ${X} enter $T`],
    ["an assignment after the step's tool word", `${X} open; T=/x; ${X} enter $T`],
    ["T=/x; T=enter ...", `T=/x; T=enter; ${X} $T accept`],
    ["the same name assigned twice", `T=/x; T=/x; ${X} enter $T`],
    ["the name read into later", `T=/x; read T < f; ${X} enter $T`],
    ["eval in the command", `T=/x; eval "$Y"; ${X} enter $T`],
    ["a program named by an expansion", `T=/x; $P; ${X} enter $T`],
    ["IFS set in the command", `T=/x; IFS=/; ${X} enter $T`],
    ["a ${T:-default} use", `T=/x; ${X} enter \${T:-accept}`],
    ["a single & after the assignment", `T=/x & ${X} enter $T`],
    ["|| after the assignment", `T=/x || ${X} enter $T`],
  ];
  for (const [shape, command] of doubted) {
    it(`doubted: ${shape}`, () => {
      const r = run(command);
      expect(r.gateRan).toBe(true);
    });
  }
});
