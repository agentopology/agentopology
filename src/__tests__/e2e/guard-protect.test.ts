/**
 * The guards protect their files however a command names them (0.13.0).
 *
 * An attack read on the release candidate found that before-action.sh and before-edit.sh refused a
 * protected file only when a command named it literally. Each row below is one command from that
 * read, as it was written: a glob on the go hook's name, a `cd` first, a `for` loop, `find -exec`, a
 * ledger row written through a variable, the guards and settings.json themselves, the session state
 * cleared through a parent folder, a glob or a variable. Then AT_TODAY (the production guard read
 * it). Ordinary commands still pass.
 *
 * The scripts run the way Claude Code runs a hook: a shell, CLAUDE_PROJECT_DIR set, the event's JSON
 * on stdin.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { parse } from "../../parser/index.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";

const hasJq = spawnSync("/bin/sh", ["-c", "command -v jq"]).status === 0;

/** The probe p09: the owner's go before a script step, with a go word, a bound file and a valid window. */
const GO = (valid = "2026-11-01..2026-12-31") => `topology p09-human : [pipeline, human-gate] {
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
    valid: "${valid}"
    word: "go release"
    binds: ["docs/release-notes.md"]
  }
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

/** The attack's sweep project, cut to the threat model and one record. */
const SW = `topology sw : [pipeline] {
  meta {
    version: "1.0.0"
    description: "sweep"
  }
  orchestrator {
    model: opus
    handles: [intake]
  }
  action intake {
    kind: inline
    description: "in"
  }
  agent worker {
    model: sonnet
    description: "Does the work"
    tools: [Read, Bash]
  }
  human boss {
    description: "Approves risky acts"
  }
  flow {
    intake -> worker
  }
  threat-model {
    untrusted: [web, "inbox/**"]
    refuse-after-untrusted: ["Bash(git push *)", "SendMessage"]
    lift: boss
  }
  records {
    record led { path: "logs/led.jsonl" }
  }
}
`;

let root: string;
const at = (p: string) => join(root, p);

function scaffold(src: string) {
  const files = claudeCodeBinding.scaffold(parse(src));
  for (const f of files) {
    fs.mkdirSync(dirname(at(f.path)), { recursive: true });
    fs.writeFileSync(at(f.path), f.content);
    if (f.executable || f.path.endsWith(".sh")) fs.chmodSync(at(f.path), 0o755);
  }
  fs.mkdirSync(at("docs"), { recursive: true });
  fs.writeFileSync(at("docs/release-notes.md"), "# 1.0\n");
  fs.mkdirSync(at("logs"), { recursive: true });
  return files;
}

function hook(script: string, payload: string, env: Record<string, string> = {}) {
  const base: Record<string, string | undefined> = { ...process.env, CLAUDE_PROJECT_DIR: root };
  delete base.AT_TODAY;
  delete base.AGENTOPOLOGY_TEST;
  return spawnSync("bash", [script], { cwd: root, input: payload, env: { ...base, ...env } as NodeJS.ProcessEnv, encoding: "utf8", timeout: 20_000 });
}
const bash = (command: string) => JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Bash", tool_input: { command } });
const edit = (tool: string, path: string) =>
  JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s1", tool_name: tool, tool_input: { file_path: path, notebook_path: path, content: "x", old_string: "a", new_string: "b" } });

beforeEach(() => { root = fs.mkdtempSync(join(os.tmpdir(), "at-protect-")); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe.skipIf(!hasJq)("the go hook and the go ledger, however a command names them", () => {
  const SC = ".claude/skills/p09-human/scripts";
  const action = (cmd: string, env: Record<string, string> = {}) => hook(at(`${SC}/before-action.sh`), bash(cmd), env);

  it("refuses the go hook run through a glob, after a cd, in a for loop or by find -exec", () => {
    scaffold(GO());
    for (const cmd of [
      String.raw`echo "{\"prompt\":\"go release\"}" | bash .claude/skills/p09-human/scripts/go-*.sh`,
      String.raw`cd .claude/skills/p09-human/scripts && echo "{\"prompt\":\"go release\"}" | bash go-own*`,
      String.raw`for f in .claude/skills/p09-human/scripts/go*; do echo "{\"prompt\":\"go release\"}" | bash $f; done`,
      String.raw`find .claude -name "go-*" -exec sh -c "echo {\\\"prompt\\\":\\\"go release\\\"} | bash \$0" {} \;`,
    ]) {
      const r = action(cmd);
      expect.soft(r.status, `${cmd}\n${r.stderr}`).toBe(2);
      expect.soft(r.stderr, cmd).toMatch(/^agentopology: the (command|edit) /);
    }
  });

  it("refuses a go row written to the ledger through a variable", () => {
    scaffold(GO());
    for (const cmd of [
      "L=logs/go; echo x >> $L.jsonl",
      String.raw`L=logs/go; echo "{\"step\":\"owner-go\",\"ok\":true,\"ts\":\"2026-11-24T00:00:00Z\",\"binds\":{\"docs/release-notes.md\":\"$(sha256sum < docs/release-notes.md | cut -d" " -f1)\"}}" >> $L.jsonl`,
      "L=logs/go; cp /tmp/forged ${L}.jsonl",
    ]) {
      const r = action(cmd);
      expect.soft(r.status, `${cmd}\n${r.stderr}`).toBe(2);
      expect.soft(r.stderr, cmd).toMatch(/^agentopology: the (command|edit) /);
    }
  });

  it("refuses removing or moving the folder that holds the go ledger; another folder still goes", () => {
    scaffold(GO());
    for (const cmd of ["rm -rf logs", "L=logs; rm -rf $L", "mv logs old"]) {
      const r = action(cmd);
      expect.soft(r.status, `${cmd}\n${r.stderr}`).toBe(2);
      expect.soft(r.stderr, cmd).toMatch(/^agentopology: the (command|edit) /);
    }
    fs.mkdirSync(at("build"), { recursive: true });
    const ok = action("rm -rf build");
    expect(ok.status, ok.stderr).toBe(0);
  });

  it("refuses a Bash write of the guards themselves and of settings.json", () => {
    scaffold(GO());
    for (const cmd of [
      "rm .claude/settings.json",
      'echo "{}" > .claude/settings.json',
      'echo "exit 0" > .claude/skills/p09-human/scripts/before-action.sh',
      "cp /tmp/x .claude/skills/p09-human/scripts/before-edit.sh",
      "echo '{}' > .claude/settings.local.json",
      "rm .claude/.scaffold-manifest.json",
      "S=.claude/skills/p09-human/scripts; echo 'exit 0' > $S/before-action.sh",
      "rm -rf .claude/skills/p09-human",
    ]) {
      const r = action(cmd);
      expect.soft(r.status, `${cmd}\n${r.stderr}`).toBe(2);
      expect.soft(r.stderr, cmd).toMatch(/^agentopology: the (command|edit) /);
    }
  });

  it("refuses an Edit, Write, MultiEdit or NotebookEdit of the guards, settings.json and the manifest", () => {
    scaffold(GO());
    for (const [tool, path] of [
      ["Edit", `${SC}/before-action.sh`],
      ["Edit", `${SC}/before-edit.sh`],
      ["Write", ".claude/settings.json"],
      ["Write", ".claude/settings.local.json"],
      ["MultiEdit", `${SC}/before-action.sh`],
      ["NotebookEdit", `${SC}/before-edit.sh`],
      ["Write", ".claude/.scaffold-manifest.json"],
      ["Edit", at(".claude/settings.json")],
    ]) {
      const r = hook(at(`${SC}/before-edit.sh`), edit(tool, path));
      expect.soft(r.status, `${tool} ${path}\n${r.stderr}`).toBe(2);
      expect.soft(r.stderr, path).toMatch(/^agentopology: the edit changes /);
    }
  });

  it("still lets ordinary commands and edits through", () => {
    scaffold(GO());
    for (const cmd of [
      "cat logs/go.jsonl",
      "ls .claude",
      "git status",
      "cat .claude/settings.json",
      `cat ${SC}/go-owner-go.sh`,
      "./tool draft",
      "npm test",
      "echo hi > out.txt",
      "mkdir -p build && echo x > build/a.txt",
      "rm -rf build/*",
      "ls logs/*",
      "for f in src/*.ts; do echo $f; done",
    ]) {
      const r = action(cmd);
      expect.soft(r.status, `${cmd}\n${r.stderr}`).toBe(0);
    }
    for (const path of ["src/a.ts", "README.md", ".claude/agents/x.md"]) {
      const r = hook(at(`${SC}/before-edit.sh`), edit("Write", path));
      expect.soft(r.status, `${path}\n${r.stderr}`).toBe(0);
    }
  });

  it("reads AT_TODAY only under AGENTOPOLOGY_TEST=1", () => {
    scaffold(GO("2026-01-01..2026-01-31"));
    const sha = createHash("sha256").update(fs.readFileSync(at("docs/release-notes.md"))).digest("hex");
    fs.writeFileSync(at("logs/go.jsonl"), JSON.stringify({ step: "owner-go", ok: true, ts: "2026-01-15T10:00:00Z", binds: { "docs/release-notes.md": sha } }) + "\n");
    const test = action("./tool release", { AT_TODAY: "2026-01-20", AGENTOPOLOGY_TEST: "1" });
    expect(test.status, test.stderr).toBe(0);
    const prod = action("./tool release", { AT_TODAY: "2026-01-20" });
    expect(prod.status, prod.stderr).toBe(2);
    expect(prod.stderr).toContain("2026-01-01..2026-01-31");
  });
});

describe("without jq: the guards' own files are still refused", () => {
  const SC = ".claude/skills/p09-human/scripts";
  /** A PATH with the usual tools and no jq. */
  const noJq = () => {
    const bin = fs.mkdtempSync(join(os.tmpdir(), "at-nojq-"));
    for (const t of ["bash", "sh", "cat", "tr", "dirname", "basename", "mkdir", "date", "sed", "grep", "git", "ls", "head", "cut", "sha256sum"]) {
      const w = spawnSync("/bin/sh", ["-c", `command -v ${t}`], { encoding: "utf8" }).stdout.trim();
      if (w) fs.symlinkSync(w, join(bin, t));
    }
    return bin;
  };

  it("refuses a Bash write and an edit of settings.json and of a guard; an ordinary call runs with a line on stderr", () => {
    scaffold(GO());
    const env = { PATH: noJq() };
    const action = (cmd: string) => hook(at(`${SC}/before-action.sh`), bash(cmd), env);
    const editOf = (path: string) => hook(at(`${SC}/before-edit.sh`), edit("Write", path), env);
    for (const r of [
      action("echo '{}' > .claude/settings.json"),
      action(`echo 'exit 0' > ${SC}/before-action.sh`),
      action("rm .claude/settings.local.json"),
      editOf(".claude/settings.json"),
      editOf(`${SC}/before-edit.sh`),
      editOf(".claude/.scaffold-manifest.json"),
    ]) {
      expect.soft(r.status, r.stderr).toBe(2);
      expect.soft(r.stderr).toMatch(/jq/);
    }
    // 0.11.4: without jq an ordinary call runs, and says jq is missing
    for (const r of [action("git status"), action("npm test"), editOf("src/a.ts")]) {
      expect.soft(r.status, r.stderr).toBe(0);
      expect.soft(r.stderr).toMatch(/jq is not installed/);
    }
  });
});

describe.skipIf(!hasJq)("the session state, however a command names them", () => {
  const SC = ".claude/skills/sw/scripts";
  const action = (cmd: string, env: Record<string, string> = {}) => hook(at(`${SC}/before-action.sh`), bash(cmd), env);
  const stateOn = () => { fs.mkdirSync(at(".claude/state/taint"), { recursive: true }); fs.writeFileSync(at(".claude/state/taint/s1"), ""); };

  it("refuses clearing the taint state through a parent folder, a glob or a variable", () => {
    scaffold(SW);
    stateOn();
    for (const cmd of [
      "rm -rf .claude/state",
      "rm -rf .claude/st*",
      "D=.claude; rm -rf $D/state",
      "A=.claude/state/approvals; echo x >> $A.jsonl",
      "mv .claude /tmp/gone",
      "cd .claude && rm -rf state",
      // find: a starting folder that holds a protected file, or a -name/-path that can match one
      "find . -name approvals.jsonl -delete",
      "find .claude -delete",
      "find . -name 'tain*' -exec rm -r {} +",
      String.raw`find . \( -name approvals.jsonl \) -delete`,
      "find . -path '*/state/*' -delete",
      "find . -type f -delete",
    ]) {
      const r = action(cmd);
      expect.soft(r.status, `${cmd}\n${r.stderr}`).toBe(2);
      expect.soft(r.stderr, cmd).toMatch(/^agentopology: the (command|edit) /);
    }
    expect(fs.existsSync(at(".claude/state/taint/s1"))).toBe(true);
  });

  it("still lets ordinary commands through", () => {
    scaffold(SW);
    stateOn();
    for (const cmd of ["ls .claude", "ls .claude/state", "cat .claude/state/approvals.jsonl", "git status", "cat logs/led.jsonl", "mkdir -p build", "echo hi > notes.txt", "find build -name '*.o' -delete", "find . -name '*.log' -delete", "find .claude -name '*.md' -exec cat {} +"]) {
      const r = action(cmd);
      expect.soft(r.status, `${cmd}\n${r.stderr}`).toBe(0);
    }
  });
});
