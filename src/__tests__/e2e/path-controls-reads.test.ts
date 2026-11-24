/**
 * S-205: never-reads and secrets accept `~/...` (the home folder) and `//...` (an absolute path), the
 * forms Claude Code writes in Read/Edit rules (https://code.claude.com/docs/en/permissions, "Read and
 * Edit"). The generated before-read.sh refuses them; ordinary commands must still pass.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { parse } from "../../parser/index.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";

const hasJq = spawnSync("/bin/sh", ["-c", "command -v jq"]).status === 0;

let root: string;
let home: string;
let abs: string;
const at = (p: string) => join(root, p);
const SCRIPT = ".claude/skills/pc/scripts/before-read.sh";

const src = () => `topology pc : [pipeline] {
  orchestrator {
    model: opus
    handles: [a]
  }
  action a { kind: inline }
  agent reviewer {
    model: opus
    never-reads: ["~/.ssh/**", "~/.netrc", "/${abs}/vault/**", "private/**"]
  }
  agent deployer {
    model: opus
  }
  flow { a -> reviewer -> deployer }
  secrets {
    secret cloud { path: "~/.aws/**", readers: [deployer] }
    secret root-key { path: "/${abs}/root.key", readers: [deployer] }
  }
}`;

function scaffold() {
  for (const f of claudeCodeBinding.scaffold(parse(src()))) {
    fs.mkdirSync(dirname(at(f.path)), { recursive: true });
    fs.writeFileSync(at(f.path), f.content);
    if (f.executable) fs.chmodSync(at(f.path), 0o755);
  }
}

function hook(input: object, cwd = root) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: root, HOME: home } as Record<string, string>;
  return spawnSync("/bin/sh", ["-c", `bash "${at(SCRIPT)}"`], {
    cwd, input: JSON.stringify({ hook_event_name: "PreToolUse", ...input }), env, encoding: "utf8", timeout: 20_000,
  });
}
const read = (file_path: string, agent_type?: string) => hook({ tool_name: "Read", tool_input: { file_path }, ...(agent_type ? { agent_type } : {}) });
const bash = (command: string, agent_type?: string) => hook({ tool_name: "Bash", tool_input: { command }, ...(agent_type ? { agent_type } : {}) });

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "at-pc-")));
  home = join(root, "fakehome");
  abs = join(root, "abs");
  fs.mkdirSync(home, { recursive: true });
  spawnSync("git", ["init", "-q", root]);
  scaffold();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe.skipIf(!hasJq)("S-205 must-refuse: home and absolute paths", () => {
  it("never-reads ~/... refuses the agent on Read, and on Bash with ~ or $HOME", () => {
    expect(read(join(home, ".ssh/id_rsa"), "reviewer").status).toBe(2);
    expect(read(join(home, ".netrc"), "reviewer").status).toBe(2);
    expect(bash("cat ~/.ssh/id_rsa", "reviewer").status).toBe(2);
    expect(bash("cat $HOME/.ssh/id_rsa", "reviewer").status).toBe(2);
    expect(bash(`cat ${home}/.netrc`, "reviewer").status).toBe(2);
  });
  it("never-reads //abs refuses the agent below that absolute path", () => {
    expect(read(join(abs, "vault/k.txt"), "reviewer").status).toBe(2);
    expect(bash(`head ${abs}/vault/k.txt`, "reviewer").status).toBe(2);
  });
  it("a message does not hide a read: a substitution inside it, or a command after it, is still seen", () => {
    expect(bash('gh pr create --body "$(cat ~/.ssh/id_rsa)"', "reviewer").status).toBe(2);
    expect(bash('git commit -m "x"; cat ~/.ssh/id_rsa', "reviewer").status).toBe(2);
  });
  it("a secret at ~/ or // is refused to a non-reader and to main, and names the path", () => {
    expect(read(join(home, ".aws/credentials"), "reviewer").status).toBe(2);
    expect(read(join(home, ".aws/credentials")).status).toBe(2);
    expect(read(join(abs, "root.key"), "reviewer").status).toBe(2);
    expect(read(join(abs, "root.key")).stderr).toContain("root.key");
  });
  it("a project path that is the absolute path is seen as it (the abs wall inside the project)", () => {
    expect(hook({ tool_name: "Read", tool_input: { file_path: "abs/vault/k.txt" }, agent_type: "reviewer" }).status).toBe(2);
  });
});

describe.skipIf(!hasJq)("S-205 must-pass: ordinary commands are not refused", () => {
  it("lets readers and other agents through", () => {
    expect(read(join(home, ".aws/credentials"), "deployer").status).toBe(0);
    expect(read(join(abs, "root.key"), "deployer").status).toBe(0);
    expect(read(join(home, ".ssh/id_rsa"), "deployer").status).toBe(0);
  });
  it("passes the ordinary commands for the walled agent", () => {
    for (const c of [
      "git status", "npm test", "ls", "grep x src", "ls ~", "cat ~/notes.txt", "cat $HOME/.bashrc", "ls ~/.sshfoo",
      'claude -p --agent x "summarize the logs"', 'gh pr create --body "see ~/.ssh docs"', "for f in a b; do echo $f; done",
      "cat private-notes.txt", `cat ${home}/.netrc2`, `ls ${abs}/vaulted`,
    ]) {
      expect(bash(c, "reviewer").status, c).toBe(0);
    }
  });
  it("passes Read of ordinary files", () => {
    expect(read(join(root, "src/app.ts"), "reviewer").status).toBe(0);
    expect(read(join(home, "notes.txt"), "reviewer").status).toBe(0);
  });
});
