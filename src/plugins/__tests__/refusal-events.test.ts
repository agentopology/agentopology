/**
 * The refusal event (EXPERIMENTAL): when a topology opts in, every generated guard that refuses
 * appends one JSON line to .claude/agentopology/events/refusals.jsonl just before its exit 2.
 * Opt in with `meta { refusal-events: true }` or by loading a plugin that declares
 * `reads: ["refusals"]`. Without the opt-in the output is what it was.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { parse } from "../../parser/index.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import { setActivePlugins } from "../runtime.js";
import type { AtPlugin } from "../types.js";

const hasJq = spawnSync("/bin/sh", ["-c", "command -v jq"]).status === 0;

const topo = (metaExtra: string) => `topology plain : [pipeline] {
  meta {
    version: "1.0.0"
    description: "Open then accept"
    ${metaExtra}
  }
  orchestrator { model: sonnet handles: [open, accept] }
  action open {
    kind: external
    commands: ["./tool open"]
  }
  action accept {
    kind: external
    commands: ["./tool accept"]
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

const EVENTS = ".claude/agentopology/events/refusals.jsonl";
let root: string;
const at = (p: string) => join(root, p);

function scaffold(src: string) {
  for (const f of claudeCodeBinding.scaffold(parse(src))) {
    fs.mkdirSync(dirname(at(f.path)), { recursive: true });
    fs.writeFileSync(at(f.path), f.content);
    if (f.executable || f.path.endsWith(".sh")) fs.chmodSync(at(f.path), 0o755);
  }
  // The gate's own check: it fails, so the step is held.
  fs.writeFileSync(at(".claude/skills/plain/scripts/check.sh"), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });
}

function bash(command: string, script = "before-action.sh") {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: root } as NodeJS.ProcessEnv;
  const payload = JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Bash", tool_input: { command } });
  return spawnSync("bash", [at(`.claude/skills/plain/scripts/${script}`)], { cwd: root, input: payload, env, encoding: "utf8", timeout: 20_000 });
}

/** A command the generated guard refuses: the step is held by a gate whose check fails. */
const REFUSED = "./tool accept --secret-word";

beforeEach(() => { root = fs.mkdtempSync(join(os.tmpdir(), "at-refusal-")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); setActivePlugins([]); });

describe.skipIf(!hasJq)("refusal events", () => {
  it("without the opt-in, no generated file knows the event file", () => {
    for (const f of claudeCodeBinding.scaffold(parse(topo("")))) {
      expect(f.content, f.path).not.toContain("refusals.jsonl");
    }
  });

  it("with meta { refusal-events: true }, a refusal appends one line and still exits 2", () => {
    scaffold(topo("refusal-events: true"));
    const r = bash(REFUSED);
    expect(r.status, r.stderr).toBe(2);
    const lines = fs.readFileSync(at(EVENTS), "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    const e = JSON.parse(lines[0]);
    expect(Object.keys(e).sort()).toEqual(["gate", "guard", "reason", "rule", "tool", "ts", "v"]);
    expect(e.v).toBe(1);
    expect(e.guard).toBe("before-action.sh");
    expect(e.gate).toBe("accept-ready");
    expect(e.tool).toBe("Bash");
    expect(typeof e.ts).toBe("string");
    expect(typeof e.reason).toBe("string");
    // The refused command's text is never logged.
    expect(lines[0]).not.toContain("secret-word");
    expect(lines[0]).not.toContain("tool_input");
  });

  it("a command that passes writes nothing", () => {
    scaffold(topo("refusal-events: true"));
    expect(bash("ls").status).toBe(0);
    expect(fs.existsSync(at(EVENTS))).toBe(false);
  });

  it("a failed append never turns a refusal into a pass", () => {
    scaffold(topo("refusal-events: true"));
    // The events folder is a plain file, so the folder cannot be made and nothing can be appended.
    fs.mkdirSync(at(".claude/agentopology"), { recursive: true });
    fs.writeFileSync(at(".claude/agentopology/events"), "not a folder\n");
    const r = bash(REFUSED);
    expect(r.status, r.stderr).toBe(2);
  });

  it("every generated script that can refuse carries the append, each before its exit 2", () => {
    const files = claudeCodeBinding.scaffold(parse(topo("refusal-events: true")));
    const guards = files.filter((f) => f.path.endsWith(".sh") && /\bexit 2\b/.test(f.content) && !f.stub);
    expect(guards.length).toBeGreaterThan(0);
    for (const f of guards) expect(f.content, f.path).toContain(EVENTS);
  });

  it("every script of every example still parses as bash with the event on", () => {
    const dir = join(__dirname, "../../../examples");
    const sources = fs.readdirSync(dir).filter((n) => n.endsWith(".at"));
    expect(sources.length).toBeGreaterThan(0);
    for (const name of sources) {
      const ast = parse(fs.readFileSync(join(dir, name), "utf8"));
      ast.topology.refusalEvents = true;
      for (const f of claudeCodeBinding.scaffold(ast).filter((x) => x.path.endsWith(".sh"))) {
        const r = spawnSync("bash", ["-n"], { input: f.content, encoding: "utf8" });
        expect(r.status, `${name} ${f.path}: ${r.stderr}`).toBe(0);
      }
    }
  });

  it("a loaded plugin that reads refusals opts in too", () => {
    const reader: AtPlugin = { id: "acme", apiVersion: 1, blocks: {}, reads: ["refusals"] };
    setActivePlugins([reader]);
    const files = claudeCodeBinding.scaffold(parse(topo("")));
    expect(files.some((f) => f.content.includes(EVENTS))).toBe(true);
  });

  it("the before-edit guard refuses Edit and Write of the event file", () => {
    scaffold(topo("refusal-events: true"));
    const edit = (tool: string, file: string) => {
      const env = { ...process.env, CLAUDE_PROJECT_DIR: root } as NodeJS.ProcessEnv;
      const payload = JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s1", tool_name: tool, tool_input: { file_path: join(root, file), content: "x" } });
      return spawnSync("bash", [at(".claude/skills/plain/scripts/before-edit.sh")], { cwd: root, input: payload, env, encoding: "utf8", timeout: 20_000 });
    };
    expect(edit("Write", EVENTS).status).toBe(2);
    expect(edit("Edit", EVENTS).status).toBe(2);
    expect(edit("Write", "notes.txt").status).toBe(0);
  });
});
