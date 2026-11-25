/**
 * The wall-time cap's own files, the renewal's order, the schedule gate's reach and speed, and typing into a
 * terminal (0.13.3).
 *
 * - The session's start file (.claude/state/**) is the hooks' alone: an Edit or Write, a Bash write, an rm, the
 *   sandbox and the permission rules all refuse the agent. wall-time.sh refuses a start later than now. The go
 *   hook does not renew through a symlinked state folder.
 * - The renewal happens only after the go row is written, and only when its own row is written too.
 * - RemoteTrigger is read by the schedule gate, like CronCreate and ScheduleWakeup.
 * - A long prompt is never the go and a long scheduled string is never scheduled; both hooks answer fast.
 * - With a go word, a command that types into a terminal is refused, whatever it types.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { parse } from "../../parser/index.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";

const hasJq = spawnSync("/bin/sh", ["-c", "command -v jq"]).status === 0;
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

function src(extra = ""): string {
  return `topology probe : [pipeline, human-gate] {
  meta {
    version: "0.1.0"
    description: "probe"
    entry: lead
  }
  person owner {
  }
  agent lead {
    model: opus
    description: "Leads"
    wall-time: 1h
    renew-on: owner-go
  }
  action draft {
    kind: inline
    description: "Draft"
    commands: ["./tool draft"]
  }
  human owner-go {
    description: "The owner types go"
    who: owner
    word: "go release"
    stop-word: [stop, עצור]
    stop-from: any
${extra}  }
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
    lead -> draft
    draft -> owner-go
    owner-go -> release
  }
}
`;
}

let root: string;
const at = (p: string) => join(root, p);
const SCRIPTS = ".claude/skills/probe/scripts";
const STATE = ".claude/state/wall-time";

function scaffold(s = src()) {
  const files = claudeCodeBinding.scaffold(parse(s));
  for (const f of files) {
    fs.mkdirSync(dirname(at(f.path)), { recursive: true });
    fs.writeFileSync(at(f.path), f.content);
    if (f.executable || f.path.endsWith(".sh")) fs.chmodSync(at(f.path), 0o755);
  }
  fs.mkdirSync(at("work/deep"), { recursive: true });
  return files;
}
function run(command: string, stdin: string, now = 1_800_000_000, timeout = 60_000) {
  const base: Record<string, string | undefined> = { ...process.env, CLAUDE_PROJECT_DIR: root, AGENTOPOLOGY_TEST: "1", AT_NOW: String(now) };
  delete base.AT_SESSION;
  return spawnSync("/bin/sh", ["-c", command], { cwd: at("work/deep"), input: stdin, env: base as NodeJS.ProcessEnv, encoding: "utf8", timeout });
}
function hookCmd(event: string, script: string): string {
  const settings = JSON.parse(fs.readFileSync(at(".claude/settings.json"), "utf8"));
  const e = (settings.hooks?.[event] ?? []).find((x: any) => x.hooks.some((h: any) => h.command.includes(script)));
  expect(e, `a ${event} entry for ${script}`).toBeTruthy();
  return e.hooks.find((h: any) => h.command.includes(script)).command;
}
const pre = (tool_name: string, tool_input: Record<string, unknown>) => JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s1", tool_name, tool_input });
const action = (cmd: string) => run(`bash "${at(`${SCRIPTS}/before-action.sh`)}"`, pre("Bash", { command: cmd }));
const editHook = (tool: string, path: string) => run(`bash "${at(`${SCRIPTS}/before-edit.sh`)}"`, pre(tool, { file_path: path, content: "1", old_string: "a", new_string: "b" }));
const schedule = (tool: string, input: Record<string, unknown>) => run(`bash "${at(`${SCRIPTS}/before-schedule.sh`)}"`, pre(tool, input));
const begin = (now: number) => run(hookCmd("SessionStart", "wall-start.sh"), JSON.stringify({ session_id: "s1", hook_event_name: "SessionStart", source: "startup" }), now);
const type = (text: string, now = 1_800_000_000) => run(hookCmd("UserPromptSubmit", "go-owner-go.sh"), JSON.stringify({ session_id: "s1", hook_event_name: "UserPromptSubmit", cwd: root, prompt: text }), now);
const capCheck = (now: number) => run(hookCmd("PreToolUse", "wall-time.sh"), pre("Bash", { command: "ls" }), now);
const rows = () => (fs.existsSync(at("logs/go.jsonl")) ? fs.readFileSync(at("logs/go.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const timed = <T>(f: () => T): [T, number] => { const t = Date.now(); const r = f(); return [r, Date.now() - t]; };

beforeEach(() => { root = fs.mkdtempSync(join(os.tmpdir(), "at-cap-state-")); });
afterEach(() => {
  try { fs.chmodSync(at("logs/go.jsonl"), 0o644); } catch { /* none */ }
  fs.rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!hasJq)("the cap's start file is the hooks' alone", () => {
  it("an Edit or Write of the start file is refused", () => {
    scaffold();
    for (const tool of ["Write", "Edit"]) {
      const r = editHook(tool, at(`${STATE}/s1`)); // Claude Code sends an absolute file_path
      expect.soft(r.status, `${tool}: ${r.stderr}`).toBe(2);
      const d = editHook(tool, at(".claude/state/x.json"));
      expect.soft(d.status, `${tool} other state file: ${d.stderr}`).toBe(2);
    }
    for (const tool of ["Write", "Edit"]) {
      const r = editHook(tool, at("src/state/wall-time.ts")); // a project file merely named like it
      expect.soft(r.status, `${tool} src: ${r.stderr}`).toBe(0);
    }
  });

  it("a Bash write or removal of the state folder is refused", () => {
    scaffold();
    for (const cmd of [`echo 99999999999 > ${STATE}/s1`, `date +%s > ${STATE}/s1`, `rm -rf ${STATE}`, "rm -rf .claude/state", `cp /tmp/x ${STATE}/s1`, `mv x ${STATE}/s1`]) {
      const r = action(cmd);
      expect.soft(r.status, `${cmd}: ${r.stderr}`).toBe(2);
    }
  });

  it("the sandbox and the permission rules deny the state folder", () => {
    scaffold();
    const s = JSON.parse(fs.readFileSync(at(".claude/settings.json"), "utf8"));
    expect(s.sandbox.filesystem.denyWrite).toContain("./.claude/state");
    expect(s.permissions.deny).toContain("Edit(/.claude/state/**)");
  });

  it("wall-time.sh refuses a start later than now", () => {
    scaffold();
    begin(1000);
    fs.writeFileSync(at(`${STATE}/s1`), "99999999999\n");
    const r = capCheck(2000);
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toMatch(/later than now/);
    fs.writeFileSync(at(`${STATE}/s1`), "1000\n");
    expect(capCheck(2000).status).toBe(0);
  });

  it("the go hook does not renew through a symlinked state folder", () => {
    scaffold();
    begin(1000);
    fs.renameSync(at(".claude/state"), at("elsewhere"));
    fs.symlinkSync(at("elsewhere"), at(".claude/state"));
    expect(type("go release", 9000).status).toBe(0);
    expect(fs.readFileSync(at("elsewhere/wall-time/s1"), "utf8").trim()).toBe("1000");
    expect(rows().some((x) => x.previous_start !== undefined)).toBe(false);
  });
});

describe.skipIf(!hasJq || isRoot)("the renewal follows the go row", () => {
  it("with a ledger that cannot be written, the start is not renewed", () => {
    scaffold();
    begin(1000);
    fs.mkdirSync(at("logs"), { recursive: true });
    fs.writeFileSync(at("logs/go.jsonl"), "");
    fs.chmodSync(at("logs/go.jsonl"), 0o444);
    expect(type("go release", 9000).status).toBe(0);
    expect(fs.readFileSync(at(`${STATE}/s1`), "utf8").trim()).toBe("1000");
  });
  it("with a writable ledger the go row comes first, then the renewal row, and the start moves", () => {
    scaffold();
    begin(1000);
    expect(type("go release", 9000).status).toBe(0);
    const l = rows();
    expect(l.map((x) => (x.previous_start !== undefined ? "renew" : x.ok === true ? "go" : "other"))).toEqual(["go", "renew"]);
    expect(fs.readFileSync(at(`${STATE}/s1`), "utf8").trim()).toBe("9000");
  });
});

describe.skipIf(!hasJq)("RemoteTrigger is read by the schedule gate", () => {
  it("is in the matcher, and a go-shaped prompt in its body is refused", () => {
    scaffold();
    const s = JSON.parse(fs.readFileSync(at(".claude/settings.json"), "utf8"));
    const e = s.hooks.PreToolUse.find((x: any) => x.hooks.some((h: any) => h.command.includes("before-schedule.sh")));
    expect(e.matcher.split("|")).toEqual(expect.arrayContaining(["CronCreate", "ScheduleWakeup", "RemoteTrigger"]));
    const r = schedule("RemoteTrigger", { action: "create", body: { name: "x", cron_expression: "0 * * * *", job_config: { ccr: { events: [{ data: { message: { content: "Go release" } } }] } } } });
    expect(r.status, r.stderr).toBe(2);
    expect(schedule("RemoteTrigger", { action: "list" }).status).toBe(0);
  });
  it("the hook entry carries a timeout and blocks on failure", () => {
    scaffold();
    const s = JSON.parse(fs.readFileSync(at(".claude/settings.json"), "utf8"));
    const h = s.hooks.PreToolUse.find((x: any) => x.hooks.some((y: any) => y.command.includes("before-schedule.sh"))).hooks[0];
    expect(h.onFailure).toBe("block");
    expect(typeof h.timeout).toBe("number");
  });
});

describe.skipIf(!hasJq)("long input: never a go, never scheduled, answered fast", () => {
  const ELL = "…";
  it("the go hook answers a go word padded with 1000 and 3000 ellipses in under 3 s, and writes no go", () => {
    scaffold();
    for (const n of [1000, 3000]) {
      const [r, ms] = timed(() => type(`go release${ELL.repeat(n)}`));
      expect(r.status).toBe(0);
      expect.soft(ms, `${n}: ${ms} ms`).toBeLessThan(3000);
    }
    const [r2, ms2] = timed(() => type(`.${ELL}`.repeat(1500) + "go release"));
    expect(r2.status).toBe(0);
    expect.soft(ms2, `alternating: ${ms2} ms`).toBeLessThan(3000);
    expect(rows().filter((x) => x.ok === true)).toEqual([]);
  });
  it("the schedule gate answers the same strings in under 5 s, and refuses any string over 4 KB", () => {
    scaffold();
    // 3 KB: under the cap, and not a go (the go hook writes no go row for it, above), so it may be scheduled
    const [r0, ms0] = timed(() => schedule("CronCreate", { cron: "* * * * *", prompt: `go release${ELL.repeat(1000)}` }));
    expect([0, 2]).toContain(r0.status);
    expect.soft(ms0, `3 KB: ${ms0} ms`).toBeLessThan(5000);
    for (const p of [`go release${ELL.repeat(3000)}`, `.${ELL}`.repeat(1500) + "go release", "a".repeat(5000)]) {
      const [r, ms] = timed(() => schedule("CronCreate", { cron: "* * * * *", prompt: p }));
      expect.soft(r.status, `${p.length}`).toBe(2);
      expect.soft(ms, `${p.length}: ${ms} ms`).toBeLessThan(5000);
    }
    expect(schedule("CronCreate", { cron: "* * * * *", prompt: "check the deploy" }).status).toBe(0);
    expect(schedule("CronCreate", { cron: "* * * * *", prompt: `go release\n${"notes ".repeat(500)}` }).status).toBe(2);
  });
  it("a short go with a little punctuation still counts", () => {
    scaffold();
    expect(type("go release!!!").status).toBe(0);
    expect(rows().filter((x) => x.ok === true)).toHaveLength(1);
  });
});

describe.skipIf(!hasJq)("typing into a terminal is refused outright with a go word", () => {
  const REFUSED = [
    "tmux send-keys -H -t x 67 6f 20 72 65 6c 65 61 73 65",
    'X=release; tmux send-keys -t x "go $X" Enter',
    "T=tmux; $T send-keys -t x hi",
    "tmux send -t x ls Enter",
    "screen -S x -X stuff ls",
    "printf 'Z28gcmVsZWFzZQ==' | base64 -d | xdotool type --file -",
    "echo esaeler og | rev | wtype -",
    "ydotool type hi",
    "osascript -e 'tell application \"System Events\" to keystroke \"hi\"'",
    "kitty @ send-text --match title:x hi",
    "wezterm cli send-text hi",
    "zellij action write-chars hi",
    "zellij action write 104 105",
    "paneput pane type x",
  ];
  it("refuses each, whatever it carries", () => {
    scaffold(src('    typed-only-programs: [paneput]\n'));
    for (const cmd of REFUSED) {
      const r = action(cmd);
      expect.soft(r.status, `${cmd}: ${r.stderr}`).toBe(2);
    }
  });
  it("lets tmux and screen run when they type nothing", () => {
    scaffold(src('    typed-only-programs: [paneput]\n'));
    for (const cmd of ["tmux ls", "tmux new-session -d -s x", "screen -ls", "git status"]) {
      const r = action(cmd);
      expect.soft(r.status, `${cmd}: ${r.stderr}`).toBe(0);
    }
  });
});
