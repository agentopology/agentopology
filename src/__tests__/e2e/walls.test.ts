/**
 * Per-agent walls: `never-reads` on an agent and a top-level `secrets` block compile to one
 * PreToolUse hook on Read|Grep|Glob|Bash (before-read.sh). The script is run the way Claude Code
 * runs a hook: a shell, a subfolder as the current directory, the event's JSON on stdin,
 * CLAUDE_PROJECT_DIR set. `agent_type` is in the input when the call comes from a subagent (or a
 * session started with --agent) and absent in the main session
 * (https://code.claude.com/docs/en/hooks, "Common input fields").
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { parse } from "../../parser/index.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";

const hasJq = spawnSync("/bin/sh", ["-c", "command -v jq"]).status === 0;

const SRC = `topology walls : [pipeline] {
  orchestrator {
    model: opus
    handles: [a]
  }
  action a { kind: inline }
  agent reviewer {
    model: opus
    never-reads: [".env", "private/**", "**/*.pem"]
  }
  agent deployer {
    model: opus
  }
  flow { a -> reviewer -> deployer }
  secrets {
    secret prod { path: "config/prod/**", readers: [deployer] }
    secret ops { path: "ops.key", readers: [deployer, main] }
  }
}`;

const SCRIPT = ".claude/skills/walls/scripts/before-read.sh";
let root: string;
const at = (p: string) => join(root, p);

function scaffold() {
  const ast = parse(SRC);
  const files = claudeCodeBinding.scaffold(ast);
  for (const f of files) {
    fs.mkdirSync(dirname(at(f.path)), { recursive: true });
    fs.writeFileSync(at(f.path), f.content);
    if (f.executable) fs.chmodSync(at(f.path), 0o755);
  }
  fs.mkdirSync(at("src/deep"), { recursive: true });
  return files;
}

function hook(input: object, cwd = root) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: root } as Record<string, string>;
  return spawnSync("/bin/sh", ["-c", `bash "${at(SCRIPT)}"`], {
    // Relative paths are the session's: the project root, except where a test says otherwise.
    cwd, input: JSON.stringify({ hook_event_name: "PreToolUse", ...input }), env, encoding: "utf8", timeout: 20_000,
  });
}
const read = (file_path: string, agent_type?: string) => hook({ tool_name: "Read", tool_input: { file_path }, ...(agent_type ? { agent_id: "x1", agent_type } : {}) });
const grep = (path: string, agent_type?: string, glob?: string) => hook({ tool_name: "Grep", tool_input: { pattern: "k", path, ...(glob ? { glob } : {}) }, ...(agent_type ? { agent_type } : {}) });
const globTool = (pattern: string, path: string | undefined, agent_type?: string) => hook({ tool_name: "Glob", tool_input: { pattern, ...(path ? { path } : {}) }, ...(agent_type ? { agent_type } : {}) });
const bash = (command: string, agent_type?: string) => hook({ tool_name: "Bash", tool_input: { command }, ...(agent_type ? { agent_type } : {}) });

beforeEach(() => { root = fs.mkdtempSync(join(os.tmpdir(), "at-walls-")); spawnSync("git", ["init", "-q", root]); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("per-agent walls: what is generated", () => {
  it("writes before-read.sh and one PreToolUse hook on Read|Grep|Glob|Bash that blocks on failure", () => {
    const files = scaffold();
    expect(files.some((f) => f.path === SCRIPT && f.executable)).toBe(true);
    const settings = JSON.parse(files.find((f) => f.path === ".claude/settings.json")!.content);
    const entries = (settings.hooks.PreToolUse as Array<{ matcher: string; hooks: Array<{ command: string }> }>)
      .filter((e) => e.matcher === "Read|Grep|Glob|Bash");
    expect(entries).toHaveLength(1);
    expect(entries[0].hooks[0].command).toContain("before-read.sh");
  });

  it("writes no read guard when the topology has no wall", () => {
    const files = claudeCodeBinding.scaffold(parse(SRC.replace(/never-reads:[^\n]*\n/, "").replace(/secrets \{[\s\S]*?\n  \}\n/, "")));
    expect(files.some((f) => f.path.endsWith("before-read.sh"))).toBe(false);
  });
});

describe.skipIf(!hasJq)("per-agent walls: never-reads", () => {
  beforeEach(() => { scaffold(); });
  it("refuses the agent's own never-reads paths on every tool", () => {
    expect(read(at(".env"), "reviewer").status).toBe(2);
    // a relative path is the session's own: from a subfolder, ../../.env is the project's .env
    expect(hook({ tool_name: "Read", tool_input: { file_path: "../../.env" }, agent_type: "reviewer" }, at("src/deep")).status).toBe(2);
    expect(hook({ tool_name: "Read", tool_input: { file_path: "../../src/ok.ts" }, agent_type: "reviewer" }, at("src/deep")).status).toBe(0);
    expect(read("private/notes.txt", "reviewer").status).toBe(2);
    expect(read("a/b/server.pem", "reviewer").status).toBe(2);
    expect(grep("private", "reviewer").status).toBe(2);
    expect(grep(".", "reviewer", "*.pem").status).toBe(2);
    expect(globTool("private/**", undefined, "reviewer").status).toBe(2);
    expect(globTool("*", "private", "reviewer").status).toBe(2);
    expect(bash("cat private/notes.txt", "reviewer").status).toBe(2);
    expect(bash("cat .en\"\"v", "reviewer").status).toBe(2);
    expect(bash("head -n1 x/server.pem", "reviewer").status).toBe(2);
  });
  it("names the agent and the path on stderr", () => {
    const r = read(".env", "reviewer");
    expect(r.stderr).toContain("reviewer");
    expect(r.stderr).toContain(".env");
  });
  it("lets the agent read everything else, and other agents read its never-reads paths", () => {
    expect(read("src/app.ts", "reviewer").status).toBe(0);
    expect(bash("ls src && cat README.md", "reviewer").status).toBe(0);
    expect(read(".env", "deployer").status).toBe(0);
    expect(read(".env").status).toBe(0);
  });
});

describe.skipIf(!hasJq)("per-agent walls: secrets", () => {
  beforeEach(() => { scaffold(); });
  it("refuses a secret's path to an agent that is not a reader", () => {
    expect(read("config/prod/db.yml", "reviewer").status).toBe(2);
    expect(bash("cat config/prod/db.yml", "reviewer").status).toBe(2);
    expect(grep("config/prod", "reviewer").status).toBe(2);
    expect(read("config/prod/db.yml", "Explore").status).toBe(2);
  });
  it("lets a listed reader through", () => {
    expect(read("config/prod/db.yml", "deployer").status).toBe(0);
    expect(bash("cat config/prod/db.yml", "deployer").status).toBe(0);
  });
  it("refuses the main session (no agent_type) unless main is a reader", () => {
    expect(read("config/prod/db.yml").status).toBe(2);
    expect(bash("cat config/prod/db.yml").status).toBe(2);
    expect(read("ops.key").status).toBe(0);
    expect(read("ops.key", "reviewer").status).toBe(2);
  });
  it("compares the agent name the way the other guards do (case, path, plugin prefix)", () => {
    expect(read("config/prod/db.yml", "Deployer").status).toBe(0);
    expect(read("config/prod/db.yml", "plugin:Deployer").status).toBe(0);
  });
  it("blocks input it cannot read", () => {
    const r = spawnSync("/bin/sh", ["-c", `bash "${at(SCRIPT)}"`], {
      cwd: at("src/deep"), input: "not json", env: { ...process.env, CLAUDE_PROJECT_DIR: root }, encoding: "utf8",
    });
    expect(r.status).toBe(2);
  });
});
