/**
 * A gate's mode and let-go rule compile into the generated check scripts, and
 * `agentopology guard <file.at> --test` feeds a gate's tests rows through them.
 *
 * The scripts are run the way Claude Code runs a hook (see action-guard.test.ts):
 * a shell, a subfolder as the current directory, CLAUDE_PROJECT_DIR set, the
 * event's JSON on stdin.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";

const hasJq = spawnSync("/bin/sh", ["-c", "command -v jq"]).status === 0;
const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, "../../../dist/cli/index.js");

const topology = (gate: string, extra = "") => `topology ship : [pipeline] {
  meta { version: "1.0.0" description: "Render then publish" }
  orchestrator { model: sonnet handles: [render, publish] }
  action render {
    kind: external
    commands: ["./tool render"]
  }
  action publish {
    kind: external
    commands: ["./tool publish"]
    unit-from: "./tool publish (\\\\S+)"
  }
  human sign { description: "ok to publish" }
  records {
    record trace { path: "logs/{unit}/trace.jsonl" }
  }
  gates {
    gate publish-ready {
      after: render
      before: publish
      ledger: trace
      on-fail: halt
${gate}
    }
  }
  flow { render -> publish }
${extra}}
`;

let root: string;
const at = (p: string) => join(root, p);
const SCRIPT = ".claude/skills/ship/scripts/before-action.sh";

function scaffold(src: string, dir = root) {
  const ast = parse(src);
  for (const f of claudeCodeBinding.scaffold(ast)) {
    fs.mkdirSync(dirname(join(dir, f.path)), { recursive: true });
    fs.writeFileSync(join(dir, f.path), f.content);
    if (f.executable) fs.chmodSync(join(dir, f.path), 0o755);
  }
  fs.mkdirSync(join(dir, "src/deep"), { recursive: true });
}

function hook(stdin: string) {
  return spawnSync("/bin/sh", ["-c", `bash "$CLAUDE_PROJECT_DIR/${SCRIPT}"`], {
    cwd: at("src/deep"),
    input: stdin,
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    encoding: "utf8",
    timeout: 20_000,
  });
}
const bash = (command: string) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
const readLines = (p: string) =>
  fs.existsSync(at(p)) ? fs.readFileSync(at(p), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const writeLedger = (unit: string, lines: object[]) => {
  fs.mkdirSync(at(`logs/${unit}`), { recursive: true });
  fs.writeFileSync(at(`logs/${unit}/trace.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
};

beforeEach(() => {
  root = fs.mkdtempSync(join(os.tmpdir(), "at-gate-tests-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!hasJq)("mode: shadow", () => {
  it("logs what it would refuse to logs/shadow.jsonl and exits 0", () => {
    scaffold(topology("      mode: shadow"));
    const r = hook(bash("./tool publish ep1"));
    expect(r.status, r.stderr).toBe(0);
    const rows = readLines("logs/shadow.jsonl");
    expect(rows).toHaveLength(1);
    expect(rows[0].gate).toBe("publish-ready");
    expect(rows[0].command).toBe("./tool publish ep1");
    expect(typeof rows[0].reason).toBe("string");
  });

  it("logs nothing when the gate would not refuse", () => {
    scaffold(topology("      mode: shadow"));
    writeLedger("ep1", [{ step: "render", unit: "ep1", ok: true, at: "2026-01-01T00:00:00Z" }]);
    const r = hook(bash("./tool publish ep1"));
    expect(r.status, r.stderr).toBe(0);
    expect(readLines("logs/shadow.jsonl")).toEqual([]);
  });

  it("mode: refuse (and no mode) still refuses with exit 2", () => {
    for (const gate of ["      mode: refuse", ""]) {
      scaffold(topology(gate));
      const r = hook(bash("./tool publish ep1"));
      expect(r.status, r.stderr).toBe(2);
      expect(fs.existsSync(at("logs/shadow.jsonl"))).toBe(false);
    }
  });
});

describe.skipIf(!hasJq)("let-go: once", () => {
  const GATE = "      let-go: once\n      lift: sign";
  const signRow = (at: string, extra: object = {}) => ({ step: "sign", unit: "ep1", ok: true, gate: "publish-ready", "let-go": true, at, ...extra });

  it("refuses with no human row", () => {
    scaffold(topology(GATE));
    expect(hook(bash("./tool publish ep1")).status).toBe(2);
  });

  it("lifts exactly one run once the human's row is newer than the last refusal", () => {
    scaffold(topology(GATE));
    expect(hook(bash("./tool publish ep1")).status).toBe(2); // the refusal
    writeLedger("ep1", [signRow("2099-01-01T00:00:00Z")]);
    const first = hook(bash("./tool publish ep1"));
    expect(first.status, first.stderr).toBe(0);
    const used = readLines("logs/let-go.jsonl");
    expect(used).toHaveLength(1);
    expect(used[0].gate).toBe("publish-ready");
    // used up: the next run is refused again
    expect(hook(bash("./tool publish ep1")).status).toBe(2);
    expect(readLines("logs/let-go.jsonl")).toHaveLength(1);
  });

  it("a second row lifts one more run", () => {
    scaffold(topology(GATE));
    expect(hook(bash("./tool publish ep1")).status).toBe(2);
    writeLedger("ep1", [signRow("2099-01-01T00:00:00Z")]);
    expect(hook(bash("./tool publish ep1")).status).toBe(0);
    expect(hook(bash("./tool publish ep1")).status).toBe(2);
    writeLedger("ep1", [signRow("2099-01-01T00:00:00Z"), signRow("2099-02-01T00:00:00Z")]);
    expect(hook(bash("./tool publish ep1")).status).toBe(0);
    expect(hook(bash("./tool publish ep1")).status).toBe(2);
  });

  it("ignores a row that is not ok, names another gate, lacks let-go, or comes from another human", () => {
    scaffold(topology(GATE));
    for (const bad of [
      signRow("2099-01-01T00:00:00Z", { ok: false }),
      signRow("2099-01-01T00:00:00Z", { gate: "other" }),
      signRow("2099-01-01T00:00:00Z", { "let-go": false }),
      signRow("2099-01-01T00:00:00Z", { step: "someone-else" }),
    ]) {
      writeLedger("ep1", [bad]);
      expect(hook(bash("./tool publish ep1")).status).toBe(2);
    }
  });

  it("ignores a row older than the last refusal", () => {
    scaffold(topology(GATE));
    writeLedger("ep1", [signRow("2000-01-01T00:00:00Z")]);
    expect(hook(bash("./tool publish ep1")).status).toBe(2); // refused: the row is older than any refusal
    expect(hook(bash("./tool publish ep1")).status).toBe(2); // and it never lifts a later one
    expect(readLines("logs/let-go.jsonl")).toEqual([]);
  });

  it("a row written before any refusal lifts nothing", () => {
    scaffold(topology(GATE));
    writeLedger("ep1", [signRow("2099-01-01T00:00:00Z")]);
    expect(hook(bash("./tool publish ep1")).status).toBe(2);
  });
});

describe.skipIf(!hasJq)("agentopology guard --test", () => {
  const cli = (...args: string[]) => spawnSync("node", [CLI, ...args], { encoding: "utf8", timeout: 120_000 });
  const write = (name: string, src: string) => {
    fs.writeFileSync(at(name), src);
    return at(name);
  };

  it("exits 0 when every row matches, and prints refused or allowed per row", () => {
    const f = write("ok.at", topology(`      tests {
        refuse: ["./tool publish ep1"]
        allow: ["./tool render ep1", "ls -la"]
      }`));
    const r = cli("guard", f, "--test");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/refused/);
    expect(r.stdout).toMatch(/allowed/);
    expect(r.stdout).toContain("./tool publish ep1");
  });

  it("exits 1 when a refuse row is allowed", () => {
    const f = write("bad.at", topology(`      tests { refuse: ["./tool render ep1"] }`));
    const r = cli("guard", f, "--test");
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toContain("./tool render ep1");
  });

  it("exits 1 when an allow row is refused", () => {
    const f = write("bad2.at", topology(`      tests { allow: ["./tool publish ep1"] }`));
    expect(cli("guard", f, "--test").status).toBe(1);
  });

  it("uses --dir for the project folder", () => {
    const f = write("ok2.at", topology(`      tests { refuse: ["./tool publish ep1"] }`));
    const dir = at("proj");
    fs.mkdirSync(dir);
    const r = cli("guard", f, "--test", "--dir", dir);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(fs.existsSync(join(dir, SCRIPT))).toBe(true);
  });

  it("feeds a hook's tests through the hook's script", () => {
    const src = topology(`      tests { refuse: ["./tool publish ep1"] }`, `  hooks {
    hook no-rm {
      on: PreToolUse
      matcher: "Bash"
      run: "bash scripts/no-rm.sh"
      tests { refuse: ["rm -rf /"] allow: ["ls"] }
    }
  }
`);
    const f = write("hook.at", src);
    const dir = at("proj");
    fs.mkdirSync(join(dir, "scripts"), { recursive: true });
    fs.writeFileSync(join(dir, "scripts/no-rm.sh"), '#!/bin/sh\nif grep -q "rm -rf"; then echo no >&2; exit 2; fi\nexit 0\n');
    const r = cli("guard", f, "--test", "--dir", dir);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("rm -rf /");
  });

  it("feeds an agent name to a gate that holds an agent launch", () => {
    const src = `topology ship : [pipeline] {
  meta { version: "1.0.0" description: "x" }
  orchestrator { model: sonnet handles: [render, reviewer] }
  action render { kind: external commands: ["./tool render"] }
  agent reviewer { model: sonnet description: "reviews" prompt { Review. } }
  gates {
    gate review-ready {
      after: render
      before: reviewer
      run: "scripts/ready.sh"
      tests { refuse: ["reviewer"] allow: ["someone-else"] }
    }
  }
  flow { render -> reviewer }
}
`;
    const f = write("agent.at", src);
    const dir = at("proj");
    fs.mkdirSync(join(dir, "scripts"), { recursive: true });
    fs.writeFileSync(join(dir, "scripts/ready.sh"), "#!/bin/sh\nexit 1\n");
    fs.chmodSync(join(dir, "scripts/ready.sh"), 0o755);
    const r = cli("guard", f, "--test", "--dir", dir);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("reviewer");
  });

  it("refuses a file with no tests rows", () => {
    const f = write("none.at", topology(""));
    const r = cli("guard", f, "--test");
    expect(r.status).toBe(1);
  });
});
