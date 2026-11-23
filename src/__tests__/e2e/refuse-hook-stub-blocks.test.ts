/**
 * An unwritten script of a `strength: refuse` hook blocks its call until it
 * is written, as a gate's stub does.
 *
 * Measured on 0.12.6: the bash stub of a refuse hook on PreToolUse exited 1,
 * which Claude Code does not read as a block, so the call went through while
 * the file said refuse. A python or node stub exited 2 on every event,
 * Stop and SubagentStop included. Now exit 2 is written where Claude Code
 * blocks on it (code.claude.com/docs/en/hooks, "Exit code 2 behavior per
 * event"), except Stop and SubagentStop, where exit 2 would keep the agent
 * from ever finishing: those stay exit 1. A hook that is not refuse keeps exit 1.
 */

import { describe, it, expect } from "vitest";
import { parse } from "../../parser/index.js";
import { bindings } from "../../bindings/index.js";
import { STUB_MARKER } from "../../bindings/lib/stub.js";
import { stubsOf } from "../../scaffold/stubs.js";

const hook = (name: string, on: string, run: string, strength?: string, matcher?: string) => `    hook ${name} {
      on: ${on}
${matcher ? `      matcher: "${matcher}"\n` : ""}      run: "${run}"
      type: command
${strength ? `      strength: ${strength}\n` : ""}    }`;

const SOURCE = `topology refuse-stubs : [pipeline] {
  meta {
    version: "0.1.0"
    description: "refuse hooks whose scripts are not written"
  }
  agent builder {
    model: sonnet
    description: "Builds"
    prompt {
      Build.
    }
    hooks {
${hook("own-guard", "PreToolUse", "bash tools/own-guard.sh", "refuse", "Bash")}
    }
  }
  hooks {
${hook("header-gate", "PreToolUse", "bash tools/header-gate.sh", "refuse", "Edit|Write")}
${hook("go-ledger", "UserPromptSubmit", "bash tools/go-ledger.sh", "refuse")}
${hook("cfg", "ConfigChange", "bash tools/config-guard.sh", "refuse")}
${hook("py-guard", "PreToolUse", "python3 tools/py-guard.py", "refuse", "Bash")}
${hook("node-guard", "PreToolUse", "node tools/node-guard.js", "refuse", "Bash")}
${hook("py-stop", "Stop", "python3 tools/py-stop.py", "refuse")}
${hook("sh-stop", "SubagentStop", "sh tools/sh-stop.sh", "refuse")}
${hook("pre-detect", "PreToolUse", "bash tools/pre-detect.sh", "detect", "Bash")}
${hook("py-detect", "PreToolUse", "python3 tools/py-detect.py", "detect", "Bash")}
${hook("lane-entry", "SessionStart", "bash tools/lane-entry.sh", "refuse")}
  }
}
`;

const files = () => bindings["claude-code"].scaffold(parse(SOURCE));
const script = (name: string) => {
  const f = files().find((x) => x.path.endsWith(`/${name}`) || x.path === name);
  expect(f, name).toBeDefined();
  return f!;
};
const exitCode = (content: string) => {
  const m = [...content.matchAll(/^(?:exit|sys\.exit\(|process\.exit\()\s*(\d)/gm)];
  return m.length ? Number(m[m.length - 1][1]) : undefined;
};

describe("a refuse hook's unwritten script blocks where exit 2 blocks", () => {
  for (const [name, event, file] of [
    ["header-gate", "PreToolUse", "tools/header-gate.sh"],
    ["go-ledger", "UserPromptSubmit", "tools/go-ledger.sh"],
    ["cfg", "ConfigChange", "tools/config-guard.sh"],
  ] as const) {
    it(`${name} (${event}) exits 2 and says how to unblock`, () => {
      const f = script(file);
      expect(f.content).toContain(STUB_MARKER);
      expect(exitCode(f.content)).toBe(2);
      expect(f.content).toContain(`${name} is a stub: it blocks every ${event} call until you write ${file} and remove its AGENTOPOLOGY_STUB line.`);
      expect(f.stub).toBe("hook");
    });
  }

  it("python and node stubs of a refuse PreToolUse hook exit 2 with the same line", () => {
    for (const [name, file] of [["py-guard", "tools/py-guard.py"], ["node-guard", "tools/node-guard.js"]] as const) {
      const f = script(file);
      expect(f.content).toContain(STUB_MARKER);
      expect(exitCode(f.content), file).toBe(2);
      expect(f.content).toContain(`${name} is a stub: it blocks every PreToolUse call until you write ${file} and remove its AGENTOPOLOGY_STUB line.`);
    }
  });

  it("an agent's own refuse PreToolUse hook stub exits 2", () => {
    const f = files().find((x) => x.path.endsWith("builder-own-guard.sh"));
    expect(f).toBeDefined();
    expect(f!.content).toContain(STUB_MARKER);
    expect(exitCode(f!.content)).toBe(2);
    expect(f!.content).toContain("own-guard is a stub: it blocks every PreToolUse call");
  });

  it("every one of them is counted as a hook stub", () => {
    const counted = stubsOf(files()).stubs.filter((s) => s.kind === "hook").map((s) => s.path.replace(/^.*\//, ""));
    for (const f of ["header-gate.sh", "go-ledger.sh", "config-guard.sh", "py-guard.py", "node-guard.js", "builder-own-guard.sh"]) expect(counted).toContain(f);
  });
});

describe("everywhere else a stub exits 1", () => {
  it("a refuse Stop / SubagentStop stub in python or sh exits 1", () => {
    expect(exitCode(script("tools/py-stop.py").content)).toBe(1);
    expect(exitCode(script("tools/sh-stop.sh").content)).toBe(1);
  });

  it("a detect PreToolUse hook's stub exits 1", () => {
    expect(exitCode(script("tools/pre-detect.sh").content)).toBe(1);
    expect(exitCode(script("tools/py-detect.py").content)).toBe(1);
  });

  it("a refuse hook on an event exit 2 does not block (SessionStart) exits 1", () => {
    expect(exitCode(script("tools/lane-entry.sh").content)).toBe(1);
  });
});
