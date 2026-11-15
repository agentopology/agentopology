/**
 * [SP-9] The generated hook reads the head files (Spec B, piece 4), and the
 * shell path protects them (piece 3 rests on them).
 *
 * Before SP-9 the hook's check_ledger read only the last line for the step: a
 * ledger whose earlier line was rewritten, its last line still ok, passed the
 * hook while `step check` refused it. And before-edit.sh refused a tool write
 * to a head file, but a shell `echo > .agentopology/records/x.head` or `rm` of
 * it passed; a removed head makes the next check a first run, which accepts a
 * rewritten ledger.
 *
 * Proof by execution: scaffold, plant a ledger and a head, run the generated
 * before-action.sh / before-edit.sh with bash on a planted payload, assert the
 * exit code (2 refuses, 0 allows).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { parse } from "../../parser/index.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import { codexBinding } from "../../bindings/codex.js";
import { checkStep } from "../../step/check.js";
import { checkRecordHead, headPath } from "../../records/head.js";

const hasJq = spawnSync("/bin/sh", ["-c", "command -v jq"]).status === 0;

const SRC = `topology ship : [pipeline] {
  meta {
    version: "1.0.0"
    description: "Render, then publish (made-up content)"
  }
  orchestrator {
    model: sonnet
    handles: [render, publish, ship-unit, release]
  }
  action render {
    kind: external
    commands: ["./tool render"]
  }
  action publish {
    kind: external
    commands: ["./tool publish"]
  }
  action ship-unit {
    kind: external
    commands: ["./tool ship"]
    unit-from: "./tool ship (\\S+)"
  }
  action release {
    kind: external
    commands: ["./tool release"]
  }
  hooks {
    hook protect-records {
      on: PreToolUse
      matcher: "Write|Edit|MultiEdit|NotebookEdit"
      run: "hooks/protect-records.sh"
      type: command
    }
  }
  records {
    record approvals {
      path: "records/approvals.jsonl"
      written-by: ["scripts/approve.py"]
      append-only: true
    }
    record trace {
      path: "work/{unit}/trace.jsonl"
      written-by: ["scripts/trace.py"]
      append-only: true
    }
    record plain {
      path: "records/plain.jsonl"
      written-by: ["scripts/approve.py"]
    }
    record cited {
      path: "records/cited.jsonl"
      written-by: ["scripts/approve.py"]
      append-only: true
      guard: [protect-records]
    }
  }
  gates {
    gate publish-ready {
      after: render
      before: publish
      ledger: approvals
    }
    gate ship-ready {
      after: render
      before: ship-unit
      ledger: trace
    }
    gate plain-ready {
      after: render
      before: release
      ledger: plain
    }
  }
  flow {
    render -> publish -> ship-unit -> release
  }
}
`;

/** Only a cited (hand-built) append-only ledger: no record is held by the generated record guard. */
const CITED_ONLY = `topology ship : [pipeline] {
  meta {
    version: "1.0.0"
    description: "A hand-built ledger guard (made-up content)"
  }
  orchestrator {
    model: sonnet
    handles: [render, publish]
  }
  action render {
    kind: external
    commands: ["./tool render"]
  }
  action publish {
    kind: external
    commands: ["./tool publish"]
  }
  hooks {
    hook protect-records {
      on: PreToolUse
      matcher: "Write|Edit|MultiEdit|NotebookEdit"
      run: "hooks/protect-records.sh"
      type: command
    }
  }
  records {
    record approvals {
      path: "records/approvals.jsonl"
      written-by: ["scripts/approve.py"]
      append-only: true
      guard: [protect-records]
    }
  }
  gates {
    gate publish-ready {
      after: render
      before: publish
      ledger: approvals
    }
  }
  flow {
    render -> publish
  }
}
`;

type Target = "claude-code" | "codex";
const DIR: Record<Target, string> = { "claude-code": ".claude/skills/ship/scripts", codex: ".codex/scripts/ship" };

let root: string;
const at = (p: string) => join(root, p);
const write = (rel: string, text: string) => {
  fs.mkdirSync(dirname(at(rel)), { recursive: true });
  fs.writeFileSync(at(rel), text);
};
const read = (rel: string) => fs.readFileSync(at(rel), "utf8");
const row = (step: string, ok: boolean, tag = "", unit?: string) =>
  JSON.stringify({ step, ...(unit ? { unit } : {}), ok, at: `2026-01-01T00:00:0${tag || "0"}Z` }) + "\n";

function scaffold(target: Target, src = SRC, dir = root) {
  const ast = parse(target === "codex" ? src.replace(/model: sonnet/g, "model: gpt-5.2") : src);
  for (const f of (target === "codex" ? codexBinding : claudeCodeBinding).scaffold(ast)) {
    fs.mkdirSync(dirname(join(dir, f.path)), { recursive: true });
    fs.writeFileSync(join(dir, f.path), f.content);
    if (f.executable) fs.chmodSync(join(dir, f.path), 0o755);
  }
  for (const p of ["scripts/approve.py", "scripts/trace.py", "hooks/protect-records.sh"]) {
    fs.mkdirSync(dirname(join(dir, p)), { recursive: true });
    fs.writeFileSync(join(dir, p), "# stub\n");
  }
  return ast;
}

function hook(target: Target, file: string, stdin: string) {
  const env = { ...process.env } as Record<string, string>;
  if (target === "claude-code") env.CLAUDE_PROJECT_DIR = root;
  else delete env.CLAUDE_PROJECT_DIR;
  return spawnSync("/bin/sh", ["-c", `bash "${root}/${DIR[target]}/${file}"`], { cwd: root, input: stdin, env, encoding: "utf8", timeout: 20_000 });
}
const bash = (command: string) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
const edit = (file_path: string) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path, content: "{}" } });
const run = (target: Target, command: string) => hook(target, "before-action.sh", bash(command));

const HEAD = headPath("approvals");
const TWO = row("render", false, "1") + row("render", true, "2");

beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "at-sp9-heads-"))); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

for (const target of ["claude-code", "codex"] as const) {
  describe.skipIf(!hasJq)(`[SP-9] ${target}: before-action.sh runs the append-only check before it reads a ledger`, () => {
    it("[SP-9] an intact ledger with no head: exit 0, and the head written is byte-identical to step check's", () => {
      scaffold(target);
      write("records/approvals.jsonl", TWO);
      const r = run(target, "./tool publish");
      expect(r.status, r.stderr).toBe(0);
      const other = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "at-sp9-twin-")));
      try {
        fs.mkdirSync(join(other, "records"), { recursive: true });
        fs.writeFileSync(join(other, "records/approvals.jsonl"), TWO);
        expect(checkStep(parse(SRC), "publish", { dir: other }).ok).toBe(true);
        expect(read(HEAD)).toBe(fs.readFileSync(join(other, HEAD), "utf8"));
      } finally {
        fs.rmSync(other, { recursive: true, force: true });
      }
    });

    it("[SP-9] after step check set the head, one appended ok line: exit 0, and the head moves forward", () => {
      const ast = scaffold(target);
      write("records/approvals.jsonl", TWO);
      expect(checkStep(ast, "publish", { dir: root }).ok).toBe(true);
      fs.appendFileSync(at("records/approvals.jsonl"), row("render", true, "3"));
      const r = run(target, "./tool publish");
      expect(r.status, r.stderr).toBe(0);
      expect(JSON.parse(read(HEAD)).lines).toBe(3);
      expect(checkRecordHead(ast.records!.find((x) => x.id === "approvals")!, "", root).status).toBe("same");
    });

    it("[SP-9] one earlier line rewritten, the last line still ok: exit 2 (step check exits 1 on the same file), the head stays", () => {
      const ast = scaffold(target);
      write("records/approvals.jsonl", TWO);
      expect(checkStep(ast, "publish", { dir: root }).ok).toBe(true);
      const before = read(HEAD);
      write("records/approvals.jsonl", row("render", true, "1") + row("render", true, "2"));
      const r = run(target, "./tool publish");
      expect(r.status, r.stderr).toBe(2);
      expect(r.stderr).toContain("rewritten");
      expect(read(HEAD)).toBe(before);
      expect(checkStep(ast, "publish", { dir: root }).ok).toBe(false);
    });

    it("[SP-9] truncated (one line removed, the last still ok): exit 2", () => {
      const ast = scaffold(target);
      write("records/approvals.jsonl", TWO);
      expect(checkStep(ast, "publish", { dir: root }).ok).toBe(true);
      write("records/approvals.jsonl", row("render", true, "2"));
      const r = run(target, "./tool publish");
      expect(r.status, r.stderr).toBe(2);
      expect(r.stderr).toContain("truncated");
    });

    it("[SP-9] the ledger deleted after lines were seen: exit 2, named truncated", () => {
      const ast = scaffold(target);
      write("records/approvals.jsonl", TWO);
      expect(checkStep(ast, "publish", { dir: root }).ok).toBe(true);
      fs.unlinkSync(at("records/approvals.jsonl"));
      const r = run(target, "./tool publish");
      expect(r.status, r.stderr).toBe(2);
      expect(r.stderr).toContain("truncated");
    });

    it("[SP-9] a head that is not the JSON step check writes, or a symlink: exit 2", () => {
      scaffold(target);
      write("records/approvals.jsonl", TWO);
      write(HEAD, "not json\n");
      expect(run(target, "./tool publish").status).toBe(2);
      write(HEAD, JSON.stringify({ record: "approvals", path: "records/approvals.jsonl", lines: 1.5, sha256: "0".repeat(64) }) + "\n");
      expect(run(target, "./tool publish").status).toBe(2);
      fs.unlinkSync(at(HEAD));
      write("elsewhere.head", JSON.stringify({ record: "approvals", path: "records/approvals.jsonl", lines: 0, sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" }) + "\n");
      fs.symlinkSync(at("elsewhere.head"), at(HEAD));
      expect(run(target, "./tool publish").status).toBe(2);
    });

    it("[SP-9] a last line that is not ok still refuses with an intact head (the 0.11.0 check is unchanged)", () => {
      scaffold(target);
      write("records/approvals.jsonl", row("render", true, "1") + row("render", false, "2"));
      const r = run(target, "./tool publish");
      expect(r.status, r.stderr).toBe(2);
      expect(r.stderr).toContain("its last record must have ok: true");
    });

    it("[SP-9] a {unit} ledger keeps one head per unit: unit u1 rewritten exits 2, unit u2 intact exits 0", () => {
      const ast = scaffold(target);
      write("work/u1/trace.jsonl", row("render", false, "1", "u1") + row("render", true, "2", "u1"));
      write("work/u2/trace.jsonl", row("render", true, "1", "u2"));
      expect(checkStep(ast, "ship-unit", { dir: root, unit: "u1" }).ok).toBe(true);
      expect(run(target, "./tool ship u2").status).toBe(0);
      expect(fs.existsSync(at(headPath("trace", "u2")))).toBe(true);
      write("work/u1/trace.jsonl", row("render", true, "1", "u1") + row("render", true, "2", "u1"));
      const r = run(target, "./tool ship u1");
      expect(r.status, r.stderr).toBe(2);
      expect(r.stderr).toContain("rewritten");
      expect(run(target, "./tool ship u2").status).toBe(0);
    });

    it("[SP-9] a ledger that is not append-only is not head-checked: an earlier line rewritten still exits 0 (Spec B scope)", () => {
      scaffold(target);
      write("records/plain.jsonl", row("render", false, "1") + row("render", true, "2"));
      expect(run(target, "./tool release").status).toBe(0);
      write("records/plain.jsonl", row("render", true, "1") + row("render", true, "2"));
      expect(run(target, "./tool release").status).toBe(0);
      expect(fs.existsSync(at(headPath("plain")))).toBe(false);
    });
  });

  describe.skipIf(!hasJq)(`[SP-9] ${target}: the shell path protects the head files`, () => {
    const REFUSED = [
      `echo x > ${HEAD}`,
      `echo x >> ${HEAD}`,
      `rm ${HEAD}`,
      `rm -f ./${HEAD}`,
      "rm -rf .agentopology",
      "rm -rf .agentopology/records",
      `cp /dev/null ${HEAD}`,
      `sed -i 's/2/9/' ${HEAD}`,
      `truncate -s 0 ${headPath("trace", "u1")}`,
    ];
    const ALLOWED = [
      `cat ${HEAD}`,
      "ls .agentopology/records",
      "npx agentopology record check ship.at",
      "echo hello > out.txt",
    ];
    for (const cmd of REFUSED) {
      it(`[SP-9] refuses ${cmd}`, () => {
        scaffold(target);
        const r = run(target, cmd);
        expect(r.status, r.stderr).toBe(2);
        expect(r.stderr).toContain(".agentopology/records");
      });
    }
    for (const cmd of ALLOWED) {
      it(`[SP-9] allows ${cmd}`, () => {
        scaffold(target);
        const r = run(target, cmd);
        expect(r.status, r.stderr).toBe(0);
      });
    }

    it("[SP-9] with only a cited (hand-built) append-only ledger, both guards still protect the heads", () => {
      scaffold(target, CITED_ONLY);
      for (const cmd of REFUSED.slice(0, 5)) expect(run(target, cmd).status, cmd).toBe(2);
      expect(run(target, `cat ${HEAD}`).status).toBe(0);
      if (target === "claude-code") {
        expect(hook(target, "before-edit.sh", edit(at(HEAD))).status).toBe(2);
        expect(hook(target, "before-edit.sh", edit(at("README.md"))).status).toBe(0);
      }
    });
  });
}
