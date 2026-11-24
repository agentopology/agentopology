/**
 * Ordinary commands still run (0.13.0). A read of the release candidate found that the path reading
 * added to before-action.sh refused ordinary commands in every project: a bare `*` was matched against
 * every protected file name, and any redirect (`2>/dev/null` included) made a read a write. Each row
 * below is one command from that read, as written; each must pass, in a plain topology (one gate, no
 * human, no ledger) and in a topology with a go word and a ledger. The protected-file rows of
 * guard-protect.test.ts stay refused.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { parse } from "../../parser/index.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";

const hasJq = spawnSync("/bin/sh", ["-c", "command -v jq"]).status === 0;

/** A plain topology: one gate before a script step, no human, no ledger. */
const PLAIN = `topology plain : [pipeline] {
  meta { version: "1.0.0" description: "Open then accept" }
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

/** The probe p09: a human with a go word, a ledger a refusing gate reads. */
const GO = `topology p09-human : [pipeline, human-gate] {
  meta {
    version: "0.1.0"
    description: "The owner's go"
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
    word: "go release"
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

/** The read's commands, exactly as it ran them. */
const ORDINARY = [
  'sqlite3 db.sqlite "select * from t"',
  'psql -c "SELECT * FROM users"',
  'curl -H "Accept: */*" https://example.com',
  'echo "*" >> .gitignore',
  'echo "5 * 3" > build/x',
  'node -e "console.log(1 * 2)"',
  'npm test -- --grep "*"',
  "cd build && rm -rf *",
  "ls * > build/files.txt",
  "rm -f *.json",
  "cat .claude/settings.json 2>/dev/null",
  "cat .claude/settings.json > build/s.json",
  "cp .claude/settings.json build/settings.backup.json",
  String.raw`find . -name '*.sh' -exec chmod +x {} \;`,
];

let root: string;
const at = (p: string) => join(root, p);

function scaffold(src: string) {
  for (const f of claudeCodeBinding.scaffold(parse(src))) {
    fs.mkdirSync(dirname(at(f.path)), { recursive: true });
    fs.writeFileSync(at(f.path), f.content);
    if (f.executable || f.path.endsWith(".sh")) fs.chmodSync(at(f.path), 0o755);
  }
  fs.mkdirSync(at("build"), { recursive: true });
  fs.mkdirSync(at("logs"), { recursive: true });
  for (const f of ["build/a.o", "build/b.txt", "db.sqlite", "package.json", "tsconfig.json"]) fs.writeFileSync(at(f), "x\n");
}

function action(name: string, command: string, cwd?: string) {
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_PROJECT_DIR: root };
  const payload = JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Bash", tool_input: { command }, ...(cwd ? { cwd } : {}) });
  return spawnSync("bash", [at(`.claude/skills/${name}/scripts/before-action.sh`)], { cwd: root, input: payload, env: env as NodeJS.ProcessEnv, encoding: "utf8", timeout: 20_000 });
}

beforeEach(() => { root = fs.mkdtempSync(join(os.tmpdir(), "at-ordinary-")); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe.skipIf(!hasJq)("ordinary commands run", () => {
  for (const [label, src, name] of [["a plain topology", PLAIN, "plain"], ["a topology with a go word and a ledger", GO, "p09-human"]] as const) {
    it.each(ORDINARY)(`${label}: %s`, (cmd) => {
      scaffold(src);
      const r = action(name, cmd);
      expect(r.status, r.stderr).toBe(0);
    });
  }

  it("a plain topology's before-action.sh carries none of the protected-file reading", () => {
    const ba = claudeCodeBinding.scaffold(parse(PLAIN)).find((f) => f.path.endsWith("/before-action.sh"))!;
    for (const marker of ["at_pw_init", "own_guard", "at_anc_named", "at_find_named", "own_guard", "settings.local.json"]) expect(ba.content).not.toContain(marker);
  });

  it("a glob is read in the folder the session is in (the hook's cwd)", () => {
    scaffold(GO);
    const sc = at(".claude/skills/p09-human/scripts");
    expect(action("p09-human", "rm -rf *", at("build")).status).toBe(0);
    expect(action("p09-human", `echo '{"prompt":"go release"}' | bash go-own*`, sc).status).toBe(2);
    fs.writeFileSync(at("logs/go.jsonl"), "");
    expect(action("p09-human", "rm -rf *", at("logs")).status).toBe(2);
  });

  it("a payload with no cwd is read from CLAUDE_PROJECT_DIR, wherever the hook process starts", () => {
    scaffold(GO);
    fs.writeFileSync(at("logs/go.jsonl"), "");
    const run = (command: string) => {
      const env: Record<string, string | undefined> = { ...process.env, CLAUDE_PROJECT_DIR: root };
      const payload = JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Bash", tool_input: { command } });
      return spawnSync("bash", [at(".claude/skills/p09-human/scripts/before-action.sh")], { cwd: at("build"), input: payload, env: env as NodeJS.ProcessEnv, encoding: "utf8", timeout: 20_000 });
    };
    expect(run("rm -rf *").status).toBe(2);
    expect(run("rm -rf l*").status).toBe(2);
    expect(run("cd build && rm -rf *").status).toBe(0);
    expect(run("ls *").status).toBe(0);
  });

  it("the message names only files the topology has", () => {
    scaffold(GO);
    const sc = ".claude/skills/p09-human/scripts";
    expect(fs.existsSync(at(`${sc}/talk-guard.sh`))).toBe(false);
    const absent = action("p09-human", `echo x > ${sc}/talk-guard.sh`);
    expect(absent.stderr).not.toContain("talk-guard.sh, which");
    const r = action("p09-human", `echo 'exit 0' > ${sc}/before-action.sh`);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(`${sc}/before-action.sh`);
  });
});
