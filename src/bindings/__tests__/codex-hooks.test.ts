import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { codexBinding } from "../codex.js";
import { checkHooks } from "../../conformance/codex.js";
import { isStubContent } from "../lib/stub.js";
import { codexSource } from "./codex-models.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const kitchen = fs.readFileSync(path.resolve(here, "../../../kitchen-sink.at"), "utf8");

afterEach(() => vi.restoreAllMocks());

const topo = (hooks: string) => `topology t : [pipeline] {
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

const scaffold = (src: string) => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const files = codexBinding.scaffold(parse(codexSource(src)));
  const warnings = warn.mock.calls.map((c) => String(c[0]));
  warn.mockRestore();
  return { files, warnings, json: JSON.parse(files.find((f) => f.path === ".codex/hooks.json")?.content ?? "null") };
};

describe("[CX-8] hooks compile to .codex/hooks.json", () => {
  const { files, json } = scaffold(kitchen);

  it("[CX-8] the kitchen-sink `exit 2` hook on PreToolUse and Bash is that inline command, and no file named exit is written", () => {
    const pre = json.hooks.PreToolUse;
    const entry = pre.find((e: any) => e.hooks.some((h: any) => /\bexit 2'?$/.test(h.command)));
    expect(entry).toBeDefined();
    expect(entry.matcher).toBe("Bash");
    expect(files.some((f) => f.path.replace(/^.*\//, "") === "exit")).toBe(false);
  });

  it("[CX-8] the `if:` on that hook is kept: the command runs only when the tool call matches", () => {
    const entry = json.hooks.PreToolUse.find((e: any) => /exit 2'?$/.test(e.hooks[0].command));
    expect(entry.hooks[0].command).toContain("at-if.sh\" Bash 'rm -rf *' sh -c 'exit 2'");
    expect(files.find((f) => f.path === ".codex/scripts/at-if.sh")?.executable).toBe(true);
  });

  it("[CX-8] the universal events map to Codex events and Error (no Codex event) is not registered", () => {
    expect(Object.keys(json.hooks).sort()).toEqual(["PostToolUse", "PreToolUse", "SubagentStart", "SubagentStop"]);
    expect(JSON.stringify(json)).not.toContain("alert-on-error");
  });

  it("[CX-8] the generated hooks.json has no violation of the Codex contract", () => {
    expect(checkHooks(json)).toEqual([]);
  });

  it("[CX-8] every script is executable, carries the stub marker, and every command is anchored to the repo root", () => {
    const scripts = files.filter((f) => f.path.startsWith(".codex/scripts/"));
    expect(scripts.length).toBeGreaterThan(0);
    for (const f of scripts) expect(f.executable, f.path).toBe(true);
    for (const f of scripts.filter((s) => !s.path.endsWith("at-if.sh") && s.content.includes("Hook:"))) expect(isStubContent(f.content), f.path).toBe(true);
    for (const entries of Object.values<any[]>(json.hooks)) {
      for (const e of entries) {
        for (const h of e.hooks) {
          if (/exit 2$/.test(h.command) && !h.command.includes(".codex/")) continue;
          expect(h.command, h.command).toContain("git rev-parse --show-toplevel");
        }
      }
    }
  });

  it("[CX-8] the kitchen-sink timeouts pass through in seconds as written", () => {
    const start = json.hooks.SubagentStart[0].hooks[0];
    expect(start.timeout).toBe(5000);
  });
});

describe("[CX-8] what Codex cannot run gets one warning and no entry", () => {
  it("[CX-8] a hook on an event Codex lacks gives one validate warning and no entry", () => {
    const src = topo(`    hook alert {
      on: Notification
      run: "scripts/alert.sh"
      type: command
    }`);
    const w = validate(parse(src), { target: "codex" }).filter((r) => r.rule === "CX8-event");
    expect(w).toHaveLength(1);
    expect(w[0].message).toContain('"alert"');
    const out = scaffold(src);
    expect(out.json).toBeNull();
    expect(out.files.some((f) => f.path.endsWith("alert.sh"))).toBe(false);
  });

  it("[CX-8] a prompt handler and an agent handler are skipped with a warning each", () => {
    const src = topo(`    hook judge {
      on: PreToolUse
      matcher: "Bash"
      run: "Is this safe?"
      type: prompt
    }
    hook judge2 {
      on: PreToolUse
      matcher: "Bash"
      run: "Is this safe too?"
      type: agent
    }`);
    const w = validate(parse(src), { target: "codex" }).filter((r) => r.rule === "CX8-handler");
    expect(w).toHaveLength(2);
    expect(scaffold(src).json).toBeNull();
  });

  it("[CX-8] a matcher on Stop warns and the entry is written without it", () => {
    const src = topo(`    hook done {
      on: Stop
      matcher: "Bash"
      run: "scripts/done.sh"
      type: command
    }`);
    expect(validate(parse(src), { target: "codex" }).filter((r) => r.rule === "CX8-matcher")).toHaveLength(1);
    const { json } = scaffold(src);
    expect(json.hooks.Stop[0].matcher).toBeUndefined();
  });

  it("[CX-8] an if: that is not Tool(pattern) leaves the hook out rather than firing on every call", () => {
    const src = topo(`    hook odd {
      on: PreToolUse
      matcher: "Bash"
      if: "contains rm"
      run: "exit 2"
      type: command
    }`);
    expect(validate(parse(src), { target: "codex" }).filter((r) => r.rule === "CX8-if")).toHaveLength(1);
    expect(scaffold(src).json).toBeNull();
  });

  it("[CX-8] Claude Code users see none of these warnings", () => {
    const src = topo(`    hook alert {
      on: Notification
      run: "scripts/alert.sh"
      type: command
    }`);
    expect(validate(parse(src)).filter((r) => r.rule.startsWith("CX"))).toEqual([]);
  });

  it("[CX-8] scaffold prints the warnings and the /hooks trust note", () => {
    const src = topo(`    hook alert {
      on: Notification
      run: "scripts/alert.sh"
      type: command
    }
    hook ok {
      on: PreToolUse
      matcher: "Bash"
      run: "exit 2"
      type: command
    }`);
    const { warnings } = scaffold(src);
    expect(warnings.filter((w) => w.includes('"alert"') && w.includes("not a Codex hook event"))).toHaveLength(1);
    expect(warnings.some((w) => w.includes("/hooks"))).toBe(true);
  });
});

describe("[CX-8] scripts", () => {
  it("[CX-8] two hooks whose scripts share a basename get two files", () => {
    const src = topo(`    hook a {
      on: PreToolUse
      matcher: "Bash"
      run: "scripts/one/check.sh"
      type: command
    }
    hook b {
      on: PostToolUse
      run: "scripts/two/check.sh"
      type: command
    }`);
    const { files, json } = scaffold(src);
    const names = files.filter((f) => f.path.startsWith(".codex/scripts/")).map((f) => f.path);
    expect(new Set(names).size).toBe(names.length);
    const cmds = [json.hooks.PreToolUse[0].hooks[0].command, json.hooks.PostToolUse[0].hooks[0].command];
    expect(cmds[0]).not.toBe(cmds[1]);
  });

  it("[CX-8] a refuse hook's stub fails closed (exit 2) until it is written", () => {
    const src = topo(`    hook guard {
      on: PreToolUse
      matcher: "Bash"
      run: "scripts/guard.sh"
      type: command
      strength: refuse
    }`);
    const stub = scaffold(src).files.find((f) => f.path === ".codex/scripts/guard.sh")!;
    expect(stub.content).toContain("exit 2");
  });

  it("[CX-8] the if-filter runs the command only on a matching call (needs jq)", () => {
    if (spawnSync("jq", ["--version"]).status !== 0) return;
    const src = topo(`    hook g {
      on: PreToolUse
      matcher: "Bash"
      if: "Bash(rm -rf *)"
      run: "exit 2"
      type: command
    }`);
    const { files } = scaffold(src);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cx8-"));
    const f = files.find((x) => x.path === ".codex/scripts/at-if.sh")!;
    const p = path.join(dir, "at-if.sh");
    fs.writeFileSync(p, f.content, { mode: 0o755 });
    const run = (cmd: string, tool = "Bash") =>
      spawnSync("bash", [p, "Bash", "rm -rf *", "exit 2"], { input: JSON.stringify({ tool_name: tool, tool_input: { command: cmd } }), encoding: "utf8" }).status;
    expect(run("rm -rf /tmp/x")).toBe(2);
    expect(run("ls -la")).toBe(0);
    expect(run("rm -rf /tmp/x", "Read")).toBe(0);
  });
});
