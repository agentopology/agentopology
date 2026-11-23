/**
 * `threat-model { untrusted, outside-sandbox, refuse-after-untrusted, lift }`.
 *
 * Reading an untrusted input marks the session; while the mark stands, a
 * call matching a refuse-after-untrusted rule is refused (exit 2). The mark
 * ends in a new session, or when the human named in `lift:` has an ok row for
 * that act in the approvals ledger, newer than the mark.
 *
 * The generated scripts run the way Claude Code runs a hook: a shell, a
 * subfolder as the current directory, the event's JSON on stdin,
 * CLAUDE_PROJECT_DIR set.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";

const hasJq = spawnSync("/bin/sh", ["-c", "command -v jq"]).status === 0;
const DIR = ".claude/skills/t/scripts";

const topo = (threat: string, servers = `mcp-servers {
    crm {
      command: "node"
      args: ["crm.js"]
      trust: untrusted
    }
    docs {
      command: "node"
      args: ["docs.js"]
    }
    other {
      command: "node"
      args: ["o.js"]
    }
  }`) => `topology t : [pipeline] {
  meta {
    version: "1.0.0"
    description: "x"
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
    prompt { Work. }
  }
  human boss {
    description: "Approves risky acts"
  }
  flow {
    intake -> worker
  }
  ${servers}
  ${threat}
}`;

const FULL = `threat-model {
    untrusted: [web, mcp:docs, "inbox/**"]
    refuse-after-untrusted: ["Bash(git push *)", "SendMessage"]
    outside-sandbox: ["npm"]
    lift: boss
  }`;

let root: string;
const at = (p: string) => join(root, p);

function scaffold(src = topo(FULL)) {
  const ast = parse(src);
  const files = claudeCodeBinding.scaffold(ast);
  for (const f of files) {
    fs.mkdirSync(dirname(at(f.path)), { recursive: true });
    fs.writeFileSync(at(f.path), f.content);
    if (f.executable) fs.chmodSync(at(f.path), 0o755);
  }
  fs.mkdirSync(at("src/deep"), { recursive: true });
  return { ast, files };
}

function run(file: string, stdin: string) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: root } as Record<string, string>;
  return spawnSync("/bin/sh", ["-c", `bash "${root}/${DIR}/${file}"`], {
    cwd: at("src/deep"), input: stdin, env, encoding: "utf8", timeout: 20_000,
  });
}
const post = (session_id: string, tool_name: string, tool_input: Record<string, unknown>) =>
  JSON.stringify({ session_id, hook_event_name: "PostToolUse", tool_name, tool_input, tool_response: {} });
const pre = (session_id: string, tool_name: string, tool_input: Record<string, unknown>) =>
  JSON.stringify({ session_id, hook_event_name: "PreToolUse", tool_name, tool_input });
const mark = (s: string, tool = "WebFetch", input: Record<string, unknown> = { url: "https://x.test" }) => run("taint-mark.sh", post(s, tool, input));
const bash = (s: string, command: string) => run("taint-guard.sh", pre(s, "Bash", { command }));
const lift = (rows: Array<Record<string, unknown>>) => {
  fs.mkdirSync(at(".claude/state"), { recursive: true });
  fs.writeFileSync(at(".claude/state/approvals.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
};
const FUTURE = "2999-01-01T00:00:00Z";
const PAST = "2000-01-01T00:00:00Z";

beforeEach(() => { root = fs.mkdtempSync(join(os.tmpdir(), "at-threat-")); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const errors = (src: string, target?: string) => validate(parse(src), target ? { target } : {}).filter((r) => r.level === "error");

describe("threat-model: the block validates", () => {
  it("a full block is accepted (no V102, no error)", () => {
    expect(errors(topo(FULL))).toEqual([]);
  });
  it("an untrusted mcp:<id> naming no declared server is an error", () => {
    const e = errors(topo(`threat-model { untrusted: [mcp:ghost] }`));
    expect(e.some((r) => r.rule === "V137" && r.message.includes("ghost"))).toBe(true);
  });
  it("lift naming no declared human is an error", () => {
    const e = errors(topo(`threat-model { untrusted: [web] refuse-after-untrusted: ["SendMessage"] lift: nobody }`));
    expect(e.some((r) => r.rule === "V137" && r.message.includes("nobody"))).toBe(true);
  });
  it("lift naming an agent, not a human, is an error", () => {
    const e = errors(topo(`threat-model { untrusted: [web] refuse-after-untrusted: ["SendMessage"] lift: worker }`));
    expect(e.some((r) => r.rule === "V137" && r.message.includes("worker"))).toBe(true);
  });
  it("a refuse rule that is not a permission rule is an error", () => {
    const e = errors(topo(`threat-model { untrusted: [web] refuse-after-untrusted: ["push to production"] }`));
    expect(e.some((r) => r.rule === "V137" && r.message.includes("push to production"))).toBe(true);
  });
  it("an untrusted entry that is not web, mcp:<id> or a path glob is an error", () => {
    const e = errors(topo(`threat-model { untrusted: [everything] }`));
    expect(e.some((r) => r.rule === "V137" && r.message.includes("everything"))).toBe(true);
  });
  it("an unknown field in the block is a V102 error", () => {
    const e = errors(topo(`threat-model {
    untrusted: [web]
    colour: red
  }`));
    expect(e.some((r) => r.rule === "V102")).toBe(true);
  });
  for (const target of ["codex", "cursor"]) {
    it(`${target}: validate warns the block is not written`, () => {
      const w = validate(parse(topo(FULL)), { target }).filter((r) => r.level === "warning" && r.rule === "V137");
      expect(w.length).toBeGreaterThan(0);
      expect(w[0].message).toContain("threat-model");
    });
  }
  it("claude-code: no not-written warning", () => {
    const w = validate(parse(topo(FULL)), { target: "claude-code" }).filter((r) => r.rule === "V137" && r.level === "warning" && r.message.includes("not written"));
    expect(w).toEqual([]);
  });
});

describe("threat-model: what is written to settings.json", () => {
  it("wires a PostToolUse mark and a PreToolUse guard, and the sandbox key", () => {
    const { files } = scaffold();
    const s = JSON.parse(files.find((f) => f.path === ".claude/settings.json")!.content);
    const postCmds = (s.hooks.PostToolUse ?? []).flatMap((e: { matcher?: string; hooks: Array<{ command: string }> }) => e.hooks.map((h) => ({ m: e.matcher ?? "", c: h.command })));
    const mark = postCmds.find((x: { c: string }) => x.c.includes("taint-mark.sh"));
    expect(mark).toBeTruthy();
    for (const tool of ["WebFetch", "WebSearch", "mcp__docs__", "mcp__crm__", "Read"]) expect(mark.m).toContain(tool);
    const preCmds = (s.hooks.PreToolUse ?? []).flatMap((e: { matcher?: string; hooks: Array<{ command: string; onFailure?: string }> }) => e.hooks.map((h) => ({ m: e.matcher ?? "", c: h.command, f: h.onFailure })));
    const guard = preCmds.find((x: { c: string }) => x.c.includes("taint-guard.sh"));
    expect(guard).toBeTruthy();
    expect(guard.m).toContain("Bash");
    expect(guard.m).toContain("SendMessage");
    expect(guard.f).toBe("block");
    expect(s.sandbox.excludedCommands).toEqual(["npm"]);
  });
  it("writes no taint hooks without the block", () => {
    const { files } = scaffold(topo("", "mcp-servers {\n    docs {\n      command: \"node\"\n    }\n  }"));
    expect(files.some((f) => f.path.endsWith("taint-mark.sh") || f.path.endsWith("taint-guard.sh"))).toBe(false);
  });
});

describe.skipIf(!hasJq)("threat-model: the taint mark and the guard", () => {
  it("a WebFetch result writes the session's mark with its source and time", () => {
    scaffold();
    const r = mark("s1");
    expect(r.status, r.stderr).toBe(0);
    const m = JSON.parse(fs.readFileSync(at(".claude/state/taint/s1"), "utf8"));
    expect(m.source).toBe("web");
    expect(typeof m.ts).toBe("number");
  });
  it("a push is refused in the tainted session, naming the source", () => {
    scaffold();
    mark("s1");
    const r = bash("s1", "git push origin main");
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toContain("web");
  });
  it("a push passes before any untrusted read", () => {
    scaffold();
    expect(bash("s1", "git push origin main").status).toBe(0);
  });
  it("a push passes in a new session", () => {
    scaffold();
    mark("s1");
    expect(bash("s2", "git push origin main").status).toBe(0);
  });
  it("a command that matches no rule passes in the tainted session", () => {
    scaffold();
    mark("s1");
    expect(bash("s1", "git status").status).toBe(0);
    expect(bash("s1", "echo git push is not run").status).toBe(0);
  });
  it("a push chained after another command is still refused", () => {
    scaffold();
    mark("s1");
    expect(bash("s1", "cd src && git push").status).toBe(2);
    expect(bash("s1", "git  'push' origin").status).toBe(2);
  });
  it("a rule with no argument refuses every call of that tool", () => {
    scaffold();
    mark("s1");
    const r = run("taint-guard.sh", pre("s1", "SendMessage", { to: "a", message: "hi" }));
    expect(r.status, r.stderr).toBe(2);
    expect(run("taint-guard.sh", pre("s2", "SendMessage", { to: "a" })).status).toBe(0);
  });
  it("an mcp tool of a listed server marks the session; another server does not", () => {
    scaffold();
    mark("s1", "mcp__docs__search", { q: "x" });
    expect(JSON.parse(fs.readFileSync(at(".claude/state/taint/s1"), "utf8")).source).toBe("mcp:docs");
    mark("s3", "mcp__other__search", { q: "x" });
    expect(fs.existsSync(at(".claude/state/taint/s3"))).toBe(false);
  });
  it("trust: untrusted on a server adds it to the list", () => {
    scaffold();
    mark("s4", "mcp__crm__find", {});
    expect(JSON.parse(fs.readFileSync(at(".claude/state/taint/s4"), "utf8")).source).toBe("mcp:crm");
  });
  it("a read of a file matching an untrusted glob marks the session; another file does not", () => {
    scaffold();
    mark("s5", "Read", { file_path: join(root, "inbox/a/b.txt") });
    expect(JSON.parse(fs.readFileSync(at(".claude/state/taint/s5"), "utf8")).source).toBe("inbox/**");
    mark("s6", "Read", { file_path: join(root, "src/a.txt") });
    expect(fs.existsSync(at(".claude/state/taint/s6"))).toBe(false);
    mark("s7", "Grep", { pattern: "x", path: "inbox" });
    expect(fs.existsSync(at(".claude/state/taint/s7"))).toBe(true);
  });
  it("a session id that is not a safe file name is refused, not written", () => {
    scaffold();
    const r = mark("../../evil");
    expect(r.status).not.toBe(0);
    expect(fs.existsSync(at(".claude/evil"))).toBe(false);
  });

  describe("other rule forms", () => {
    const RULES = topo(`threat-model {
    untrusted: [web]
    refuse-after-untrusted: ["Edit(.env*)", "WebFetch(domain:evil.test)", "mcp__other__send", "mcp.docs.write", "Bash(npm publish:*)"]
  }`);
    it("a path rule refuses an edit of a matching file, and only that file", () => {
      scaffold(RULES);
      mark("s1");
      expect(run("taint-guard.sh", pre("s1", "Write", { file_path: join(root, ".env.local"), content: "x" })).status).toBe(2);
      expect(run("taint-guard.sh", pre("s1", "Edit", { file_path: ".env" })).status).toBe(2);
      expect(run("taint-guard.sh", pre("s1", "Write", { file_path: join(root, "src/a.ts"), content: "x" })).status).toBe(0);
    });
    it("a domain rule refuses that host and its subdomains", () => {
      scaffold(RULES);
      mark("s1");
      expect(run("taint-guard.sh", pre("s1", "WebFetch", { url: "https://evil.test/x" })).status).toBe(2);
      expect(run("taint-guard.sh", pre("s1", "WebFetch", { url: "https://a.evil.test/x" })).status).toBe(2);
      expect(run("taint-guard.sh", pre("s1", "WebFetch", { url: "https://good.test/x" })).status).toBe(0);
    });
    it("an mcp tool rule, dotted or compiled, refuses that tool", () => {
      scaffold(RULES);
      mark("s1");
      expect(run("taint-guard.sh", pre("s1", "mcp__other__send", { a: 1 })).status).toBe(2);
      expect(run("taint-guard.sh", pre("s1", "mcp__docs__write", { a: 1 })).status).toBe(2);
      expect(run("taint-guard.sh", pre("s1", "mcp__docs__read", { a: 1 })).status).toBe(0);
    });
    it("a legacy prefix rule and a program run through sudo or sh -c are read", () => {
      scaffold(RULES);
      mark("s1");
      expect(bash("s1", "npm publish --tag x").status).toBe(2);
      expect(bash("s1", "sudo npm publish").status).toBe(2);
      expect(bash("s1", "sh -c 'npm publish'").status).toBe(2);
      expect(bash("s1", "FOO=1 /usr/bin/npm publish").status).toBe(2);
      expect(bash("s1", "npm install").status).toBe(0);
    });
    it("with no lift human, nothing lifts the hold in the session", () => {
      scaffold(RULES);
      mark("s1");
      lift([{ step: "boss", ok: true, act: "Bash(npm publish:*)", at: FUTURE }]);
      expect(bash("s1", "npm publish").status).toBe(2);
    });
  });

  describe("lift", () => {
    it("an ok row of the lift human naming the act, newer than the mark, lets it pass", () => {
      scaffold();
      mark("s1");
      lift([{ step: "boss", ok: true, act: "Bash(git push *)", at: FUTURE }]);
      expect(bash("s1", "git push origin main").status).toBe(0);
    });
    it("a row naming another act does not lift this one", () => {
      scaffold();
      mark("s1");
      lift([{ step: "boss", ok: true, act: "SendMessage", at: FUTURE }]);
      expect(bash("s1", "git push origin main").status).toBe(2);
      expect(run("taint-guard.sh", pre("s1", "SendMessage", { to: "a" })).status).toBe(0);
    });
    it("a row with no act, a row that is not ok, a row of another step and an older row do not lift", () => {
      scaffold();
      mark("s1");
      for (const row of [
        { step: "boss", ok: true, at: FUTURE },
        { step: "boss", ok: false, act: "Bash(git push *)", at: FUTURE },
        { step: "someone", ok: true, act: "Bash(git push *)", at: FUTURE },
        { step: "boss", ok: true, act: "Bash(git push *)", at: PAST },
      ]) {
        lift([row]);
        expect(bash("s1", "git push origin main").status, JSON.stringify(row)).toBe(2);
      }
    });
    it("a damaged ledger does not lift", () => {
      scaffold();
      mark("s1");
      fs.mkdirSync(at(".claude/state"), { recursive: true });
      fs.writeFileSync(at(".claude/state/approvals.jsonl"), "not json\n");
      expect(bash("s1", "git push origin main").status).toBe(2);
    });
    it("a taint after the lift row marks again and refuses again", () => {
      scaffold();
      mark("s1");
      // a row written in the past, then a later read of untrusted input
      lift([{ step: "boss", ok: true, act: "Bash(git push *)", at: "2020-01-01T00:00:00Z" }]);
      expect(bash("s1", "git push origin main").status).toBe(2);
    });
  });

  describe("the agent cannot write the mark or the lift ledger", () => {
    it("before-edit.sh refuses an edit of the taint folder and of the approvals file", () => {
      scaffold();
      for (const p of [".claude/state/taint/s1", ".claude/state/approvals.jsonl"]) {
        const r = run("before-edit.sh", pre("s1", "Write", { file_path: join(root, p), content: "{}" }));
        expect(r.status, p + r.stderr).toBe(2);
      }
      expect(run("before-edit.sh", pre("s1", "Write", { file_path: join(root, "src/a.ts"), content: "{}" })).status).toBe(0);
    });
    it("before-action.sh refuses a command that writes them and lets a read through", () => {
      scaffold();
      for (const c of ["rm .claude/state/taint/s1", "echo x > .claude/state/taint/s1", "echo '{}' >> .claude/state/approvals.jsonl"]) {
        const r = run("before-action.sh", pre("s1", "Bash", { command: c }));
        expect(r.status, c + r.stderr).toBe(2);
      }
      expect(run("before-action.sh", pre("s1", "Bash", { command: "ls src" })).status).toBe(0);
    });
  });
});
