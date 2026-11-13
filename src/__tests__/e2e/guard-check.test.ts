/**
 * `agentopology guard <file> --check` (GC): which gates, approval steps and
 * permission rules a project actually enforces today. It reads; it never
 * writes. Built on compile.at: brief-check (a gate before an agent, run by
 * before-agent.sh), copy-check (a gate after an agent, a SubagentStop hook),
 * approve (a human step before drafter), and settings ask and deny rules.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import { checkGuards, type GuardItem } from "../../guard/check.js";
import { validate } from "../../parser/validator.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "fixtures/compile.at");
const CLI = resolve(here, "../../../dist/cli/index.js");
const ast = parse(fs.readFileSync(FIXTURE, "utf-8"));
const SCRIPTS = ".claude/skills/compile/scripts";

let root: string;
const at = (p: string) => join(root, p);
const settings = () => JSON.parse(fs.readFileSync(at(".claude/settings.json"), "utf8"));
const writeSettings = (s: unknown) => fs.writeFileSync(at(".claude/settings.json"), JSON.stringify(s, null, 2));
const item = (id: string) => checkGuards(ast, root).items.find((i: GuardItem) => i.id === id)!;

beforeEach(() => {
  root = fs.mkdtempSync(join(os.tmpdir(), "at-guard-check-"));
  for (const f of claudeCodeBinding.scaffold(ast)) {
    fs.mkdirSync(dirname(at(f.path)), { recursive: true });
    fs.writeFileSync(at(f.path), f.content);
  }
  // copy-check runs the user's own python script; give it one.
  fs.mkdirSync(at("docs/tools"), { recursive: true });
  fs.writeFileSync(at("docs/tools/check.py"), "print('ok')\n");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("guard --check on a freshly scaffolded project", () => {
  it("[N31] [GC1] a gate after an agent refuses by its SubagentStop hook", () => {
    const g = item("copy-check");
    expect(g).toMatchObject({ kind: "gate", strength: "refuse", by: "hook" });
    expect(g.where).toContain("SubagentStop");
    expect(g.where).toContain("drafter");
  });

  it("[N31] [GC1] a gate before an agent refuses by the before-agent guard; its unwritten script is reported as blocking every run", () => {
    const g = item("brief-check");
    expect(g).toMatchObject({ kind: "gate", strength: "refuse", by: "hook" });
    expect(g.where).toContain("PreToolUse");
    expect(g.notes.join(" ")).toMatch(/stub.*blocks every run/);
  });

  it("[N31] [GC1] a human step before an agent refuses by asking in the session, and says -p denies it", () => {
    const h = item("approve");
    expect(h).toMatchObject({ kind: "human", strength: "refuse", by: "hook" });
    expect(h.notes.join(" ")).toMatch(/-p/);
  });

  it("[N31] [GC1] deny and ask rules refuse by settings", () => {
    expect(item("deny mcp__notes__delete")).toMatchObject({ kind: "permission", strength: "refuse", by: "settings" });
    expect(item("ask Bash(git push:*)")).toMatchObject({ kind: "permission", strength: "refuse", by: "settings" });
  });

  it("[N31] [GC1] the summary counts steps that refuse: k of m (v10's enforcement number)", () => {
    const r = checkGuards(ast, root);
    expect(r.enforcement).toEqual({ refuse: 3, of: 3 });
    expect(r.missing).toBe(0);
  });
});

describe("guard --check reports what has gone missing", () => {
  it("[N31] [GC2] the SubagentStop entry removed from settings.json: the gate enforces nothing", () => {
    const s = settings();
    s.hooks.SubagentStop = s.hooks.SubagentStop.filter((e: { matcher: string }) => e.matcher !== "drafter");
    writeSettings(s);
    const g = item("copy-check");
    expect(g.strength).toBe("none");
    expect(g.notes.join(" ")).toContain("settings.json");
    expect(checkGuards(ast, root).enforcement).toEqual({ refuse: 2, of: 3 });
  });

  it("[N31] [GC2] a hook entry whose command is relative fails open off the project root", () => {
    const s = settings();
    for (const e of s.hooks.SubagentStop) for (const h of e.hooks) if (h.command) h.command = h.command.replace(/"\$CLAUDE_PROJECT_DIR\/(.*)"/, "$1");
    writeSettings(s);
    const g = item("copy-check");
    expect(g.strength).toBe("none");
    expect(g.notes.join(" ")).toMatch(/relative/);
  });

  it("[N31] [GC2] the before-agent guard without onFailure: block is reported as failing open if the hook can't start", () => {
    const s = settings();
    for (const e of s.hooks.PreToolUse) for (const h of e.hooks) delete h.onFailure;
    writeSettings(s);
    expect(item("brief-check").strength).toBe("refuse");
    expect(item("brief-check").notes.join(" ")).toMatch(/onFailure/);
  });

  it("[N31] [GC2] the gate wrapper script deleted: none", () => {
    fs.rmSync(at(`${SCRIPTS}/gate-copy-check.sh`));
    expect(item("copy-check").strength).toBe("none");
  });

  it("[N31] [GC2] before-agent.sh edited so it no longer runs the gate: none", () => {
    const p = at(`${SCRIPTS}/before-agent.sh`);
    fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace(/.*gate-brief-check\.sh.*\n/, ""));
    expect(item("brief-check").strength).toBe("none");
  });

  it("[N31] [GC2] the user's check script missing: the gate still refuses, and every run is blocked", () => {
    fs.rmSync(at("docs/tools/check.py"));
    const g = item("copy-check");
    expect(g.strength).toBe("refuse");
    expect(g.notes.join(" ")).toMatch(/missing.*blocks every run/);
  });

  it("[N31] [GC2] a deny rule removed from settings.json: none", () => {
    const s = settings();
    s.permissions.deny = [];
    writeSettings(s);
    expect(item("deny mcp__notes__delete").strength).toBe("none");
  });

  it("[N31] [GC2] a hand-built hook it cannot tie to a step is listed, not silently counted", () => {
    expect(checkGuards(ast, root).unattributed).toEqual([]);
    const s = settings();
    s.hooks.PreToolUse.push({ matcher: "Bash", hooks: [{ type: "command", command: 'python3 "$CLAUDE_PROJECT_DIR/harness/lock/hook.py"' }] });
    writeSettings(s);
    const r = checkGuards(ast, root);
    expect(r.unattributed).toEqual(['PreToolUse Bash: python3 "$CLAUDE_PROJECT_DIR/harness/lock/hook.py"']);
    expect(r.enforcement).toEqual({ refuse: 3, of: 3 });
  });

  it("[N31] [GC2] no .claude/settings.json at all: every hook and rule is none", () => {
    fs.rmSync(at(".claude/settings.json"));
    const r = checkGuards(ast, root);
    expect(r.enforcement.refuse).toBe(0);
    expect(r.items.filter((i: GuardItem) => i.strength === "none").length).toBe(r.items.length);
  });
});

describe("guard --check from the CLI", () => {
  const cli = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8" });

  it("[N31] [GC3] prints one line per item and the enforcement count, writes nothing, exits 0 when nothing is missing", () => {
    const before = spawnSync("find", [root, "-type", "f"], { encoding: "utf8" }).stdout;
    const r = cli("guard", FIXTURE, "--check", "--dir", root);
    expect(r.status).toBe(0);
    // D-8: a SubagentStop gate says on its grade that a stop event cannot block a call
    expect(r.stdout).toMatch(/gate copy-check\s+refuse, a stop event: it cannot block a call\s+by: hook/);
    expect(r.stdout).toMatch(/enforcement: 3 of 3 steps refuse/);
    expect(r.stdout).toMatch(/Claude Code \d+\.\d+\.\d+/);
    expect(spawnSync("find", [root, "-type", "f"], { encoding: "utf8" }).stdout).toBe(before);
  });

  it("[N31] [GC3] exits 1 when something the binding generates is missing on disk", () => {
    fs.rmSync(at(`${SCRIPTS}/gate-copy-check.sh`));
    const r = cli("guard", FIXTURE, "--check", "--dir", root);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/gate copy-check\s+none/);
  });

  it("[N31] [GC3] guard without --check says only the read-only mode exists yet", () => {
    const r = cli("guard", FIXTURE, "--dir", root);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/--check/);
  });
});

/**
 * Citations (N33). A hand-built guard can be credited when the file cites it:
 * a gate with `by: code` and `at: "path:line"` is checked on disk (the file,
 * the line, and the `match:` text within 5 lines), and a gate whose edge says
 * `[guard: lock-bash]` is credited with that hook when the hook is in
 * settings.json and declares its strength. A broken citation is `none` and
 * exits 1; a strength the file writes down as `none` is reported, not failed.
 */
// release and voice carry no commands: the binding compiles no hook for a gate
// before them, so only the cited guard can credit it. (With commands, such a
// gate is guarded by before-action.sh: see action-guard.test.ts.)
const CITED = `topology cited : [pipeline] {
  meta {
    version: "1.0.0"
    description: "Citation probe"
  }

  orchestrator {
    model: sonnet
    handles: [release, voice]
  }

  agent writer {
    model: sonnet
    description: "Writes the post"
    prompt {
      Write the post.
    }
  }

  human owner-yes {
    description: "The owner approves the post"
  }

  action release {
    kind: external
    description: "Posts it"
  }

  action voice {
    kind: external
    description: "Records the voice-over"
  }

  hooks {
    hook lock-bash {
      on: PreToolUse
      matcher: "Bash"
      run: "python3 harness/lock/hook.py"
      strength: refuse
      bypass: "AT_UNLOCK"
    }
    hook note-bash {
      on: PostToolUse
      matcher: "Bash"
      run: "python3 harness/lock/note.py"
    }
  }

  gates {
    gate lock-release {
      after: owner-yes
      before: release
      run: "scripts/lock.sh"
      on-fail: halt
    }
    gate lock-voice {
      after: owner-yes
      before: voice
      run: "scripts/lock-voice.sh"
      on-fail: halt
    }
    gate doctrine {
      after: owner-yes
      before: voice
      strength: refuse
      by: code
      at: "tools/px.py:5"
      match: "PX_ALLOW_NO_DOCTRINE"
      bypass: "PX_ALLOW_NO_DOCTRINE"
    }
  }

  flow {
    writer -> owner-yes
    owner-yes -> release [guard: lock-bash]
    owner-yes -> voice [guard: note-bash]
    writer -> voice [strength: none]
  }
}
`;

describe("guard --check credits what the file cites", () => {
  const cast = parse(CITED);
  let proj: string;
  const put = (p: string, text: string) => { fs.mkdirSync(dirname(join(proj, p)), { recursive: true }); fs.writeFileSync(join(proj, p), text); };
  const lines = (n: number, at: number, text: string) => Array.from({ length: n }, (_, i) => (i + 1 === at ? text : `line ${i + 1}`)).join("\n") + "\n";
  const handBuilt = (hooks: Record<string, unknown>) => put(".claude/settings.json", JSON.stringify({ hooks }, null, 2));
  const LOCK = { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: '/usr/bin/python3 "$CLAUDE_PROJECT_DIR/harness/lock/hook.py"' }] }] };
  const find = (id: string) => checkGuards(cast, proj).items.find((i: GuardItem) => i.id === id)!;

  beforeEach(() => {
    proj = fs.mkdtempSync(join(os.tmpdir(), "at-guard-cite-"));
    put("tools/px.py", lines(20, 7, 'if os.environ.get("PX_ALLOW_NO_DOCTRINE"): return'));
    handBuilt(LOCK);
  });
  afterEach(() => fs.rmSync(proj, { recursive: true, force: true }));

  it("[N33] the file parses and validates clean", () => {
    expect(validate(cast).filter((r) => r.level === "error")).toEqual([]);
  });

  it("[N33] a by: code citation whose match text is within 5 lines: refuse by code, cited not proven, bypass named", () => {
    const g = find("doctrine");
    expect(g).toMatchObject({ kind: "gate", strength: "refuse", by: "code" });
    expect(g.where).toContain("tools/px.py:5");
    expect(g.notes.join(" ")).toMatch(/cited, not proven/);
    expect(g.notes.join(" ")).toMatch(/bypass.*PX_ALLOW_NO_DOCTRINE/);
  });

  it("[N33] the match text moved away from the cited line: none, and exit-worthy", () => {
    put("tools/px.py", lines(20, 15, 'if os.environ.get("PX_ALLOW_NO_DOCTRINE"): return'));
    const g = find("doctrine");
    expect(g.strength).toBe("none");
    expect(g.notes.join(" ")).toMatch(/PX_ALLOW_NO_DOCTRINE.*not within 5 lines of line 5/);
    expect(checkGuards(cast, proj).missing).toBeGreaterThan(0);
  });

  it("[N33] the cited file missing, or the line past its end: none", () => {
    fs.rmSync(join(proj, "tools/px.py"));
    expect(find("doctrine").notes.join(" ")).toMatch(/tools\/px\.py is missing/);
    put("tools/px.py", lines(3, 2, "PX_ALLOW_NO_DOCTRINE"));
    expect(find("doctrine").strength).toBe("none");
    expect(find("doctrine").notes.join(" ")).toMatch(/has 3 lines/);
  });

  it("[N33] a gate with no hook of its own is credited by the guard its edge cites, when that hook is in settings.json", () => {
    const g = find("lock-release");
    expect(g).toMatchObject({ strength: "refuse", by: "hook" });
    expect(g.where).toContain("lock-bash");
    expect(g.notes.join(" ")).toMatch(/bypass.*AT_UNLOCK/);
    expect(checkGuards(cast, proj).unattributed).toEqual([]);
  });

  it("[N33] the cited hook missing from settings.json: the gate stays hope, and says why", () => {
    handBuilt({});
    const g = find("lock-release");
    expect(g.strength).toBe("hope");
    expect(g.notes.join(" ")).toMatch(/lock-bash.*not in .claude\/settings.json/);
  });

  it("[N33] a cited hook that declares no strength is not credited", () => {
    handBuilt({ ...LOCK, PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: 'python3 "$CLAUDE_PROJECT_DIR/harness/lock/note.py"' }] }] });
    const g = find("lock-voice");
    expect(g.strength).toBe("hope");
    expect(g.notes.join(" ")).toMatch(/note-bash declares no strength/);
  });

  it("[N33] an edge whose strength is written down as none is reported as declared, and is not a failure", () => {
    const e = find("writer -> voice");
    expect(e).toMatchObject({ kind: "edge", strength: "none", by: "prose" });
    expect(e.notes.join(" ")).toMatch(/declared/);
    put("tools/px.py", lines(20, 7, 'if os.environ.get("PX_ALLOW_NO_DOCTRINE"): return'));
    expect(checkGuards(cast, proj).missing).toBe(0);
  });

  it("[N33] the count reads the credit: 2 of 4 steps refuse (doctrine by code, lock-release by its cited hook)", () => {
    expect(checkGuards(cast, proj).enforcement).toEqual({ refuse: 2, of: 4 });
  });
});
