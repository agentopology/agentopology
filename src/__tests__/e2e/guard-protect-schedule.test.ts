/**
 * before-schedule.sh is one of the guards' own files (0.13.0).
 *
 * The go-entry change added before-schedule.sh (it refuses a scheduled prompt that starts with a go
 * word); the self-protection change refuses an edit or a Bash write of the guards' own files. With
 * both in, before-schedule.sh must be in that set too, or the model could empty it and then schedule
 * the go. It is written only on Claude Code and only with a human who has a go word, so it is named
 * only then.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { parse } from "../../parser/index.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import { guardOwnFiles, CLAUDE_CODE_GUARDS } from "../../bindings/lib/guards.js";

const hasJq = spawnSync("/bin/sh", ["-c", "command -v jq"]).status === 0;

const topo = (word: boolean) => `topology p09-human : [pipeline, human-gate] {
  meta {
    version: "0.1.0"
    description: "The owner's go: a human node guarding a script step"
  }
  person owner {
  }
  orchestrator {
    model: opus
    handles: [draft, release]
  }
  action draft {
    kind: inline
    description: "Draft the release"
    commands: ["./tool draft"]
  }
  human owner-go {
    description: "The owner types go for the release"
    who: owner
    valid: "2026-11-01..2026-12-31"
${word ? '    word: "go release"\n' : ""}  }
  action release {
    kind: external
    description: "Release"
    commands: ["./tool release"]
  }
  records {
    record go-ledger { path: "logs/go.jsonl" }
  }
  gates {
    gate go-given {
      after: owner-go
      before: release
      ledger: go-ledger
      strength: refuse
    }
  }
  flow {
    draft -> owner-go
    owner-go -> release
  }
}
`;

const SC = ".claude/skills/p09-human/scripts";
let root: string;
const at = (p: string) => join(root, p);

function scaffold(src: string) {
  const files = claudeCodeBinding.scaffold(parse(src));
  for (const f of files) {
    fs.mkdirSync(dirname(at(f.path)), { recursive: true });
    fs.writeFileSync(at(f.path), f.content);
    if (f.executable || f.path.endsWith(".sh")) fs.chmodSync(at(f.path), 0o755);
  }
  return files;
}

function hook(script: string, payload: string) {
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_PROJECT_DIR: root };
  delete env.AT_TODAY;
  delete env.AGENTOPOLOGY_TEST;
  return spawnSync("bash", [script], { cwd: root, input: payload, env: env as NodeJS.ProcessEnv, encoding: "utf8", timeout: 20_000 });
}
const bash = (command: string) => JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Bash", tool_input: { command } });
const edit = (tool: string, path: string) =>
  JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s1", tool_name: tool, tool_input: { file_path: path, content: "x", old_string: "a", new_string: "b" } });

beforeEach(() => { root = fs.mkdtempSync(join(os.tmpdir(), "at-protect-sched-")); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("before-schedule.sh among the guards' own files", () => {
  it("is named when it is written, and only then", () => {
    const withWord = parse(topo(true));
    const files = claudeCodeBinding.scaffold(withWord).map((f) => f.path);
    expect(files).toContain(`${SC}/before-schedule.sh`);
    expect(guardOwnFiles(withWord, CLAUDE_CODE_GUARDS)).toContain(`${SC}/before-schedule.sh`);

    const noWord = parse(topo(false));
    expect(claudeCodeBinding.scaffold(noWord).map((f) => f.path)).not.toContain(`${SC}/before-schedule.sh`);
    expect(guardOwnFiles(noWord, CLAUDE_CODE_GUARDS)).not.toContain(`${SC}/before-schedule.sh`);
  });

  it.skipIf(!hasJq)("refuses an Edit or Write of before-schedule.sh", () => {
    scaffold(topo(true));
    for (const tool of ["Edit", "Write"]) {
      const r = hook(at(`${SC}/before-edit.sh`), edit(tool, `${SC}/before-schedule.sh`));
      expect.soft(r.status, `${tool}\n${r.stderr}`).toBe(2);
      expect.soft(r.stderr, tool).toMatch(/^agentopology: the edit changes /);
    }
  });

  it.skipIf(!hasJq)("refuses a Bash write of before-schedule.sh, and lets a read run", () => {
    scaffold(topo(true));
    for (const cmd of [
      `echo 'exit 0' > ${SC}/before-schedule.sh`,
      `cp /tmp/x ${SC}/before-schedule.sh`,
      `S=${SC}; echo 'exit 0' > $S/before-schedule.sh`,
    ]) {
      const r = hook(at(`${SC}/before-action.sh`), bash(cmd));
      expect.soft(r.status, `${cmd}\n${r.stderr}`).toBe(2);
      expect.soft(r.stderr, cmd).toMatch(/^agentopology: the command /);
    }
    const read = hook(at(`${SC}/before-action.sh`), bash(`cat ${SC}/before-schedule.sh`));
    expect(read.status, read.stderr).toBe(0);
  });
});
