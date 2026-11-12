/**
 * Session agents: binding, guards and launcher (N44b, T-04).
 *
 * The tests scaffold the session-ops fixture into a temp dir and run the
 * generated hook scripts the way Claude Code runs a hook: a shell, a
 * subfolder as the current directory, CLAUDE_PROJECT_DIR set, the event's JSON
 * on stdin, AT_SESSION in the environment when the start line set it.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import { codexBinding } from "../../bindings/codex.js";
import { cursorBinding } from "../../bindings/cursor.js";
import { claudeWorkflowBinding } from "../../bindings/claude-workflow.js";
import { checkGuards, renderGuardReport } from "../../guard/check.js";
import { SESSION_HOOKS_PROVEN } from "../../conformance/claude-code.js";

const here = dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(resolve(here, "fixtures/session-ops.at"), "utf8");
const SCRIPTS = ".claude/skills/session-ops/scripts";
const hasJq = spawnSync("/bin/sh", ["-c", "command -v jq"]).status === 0;

let root: string;
const at = (p: string) => join(root, p);

function scaffold(source = src) {
  const ast = parse(source);
  const files = claudeCodeBinding.scaffold(ast);
  for (const f of files) {
    fs.mkdirSync(dirname(at(f.path)), { recursive: true });
    fs.writeFileSync(at(f.path), f.content);
    if (f.executable || f.path.endsWith(".sh")) fs.chmodSync(at(f.path), 0o755);
  }
  fs.mkdirSync(at("work/deep"), { recursive: true });
  return { ast, files };
}

function hookCmd(event: string, matcher: string | undefined, file: string): string {
  const settings = JSON.parse(fs.readFileSync(at(".claude/settings.json"), "utf8"));
  const entries = settings.hooks?.[event] ?? [];
  const e = entries.find((x: any) => x.matcher === matcher && x.hooks.some((h: any) => h.command.includes(file)));
  expect(e, `${event} ${matcher} ${file} in settings.json`).toBeTruthy();
  return e.hooks.find((h: any) => h.command.includes(file)).command;
}

function run(command: string, stdin: string, env: Record<string, string | undefined> = {}) {
  const base: Record<string, string | undefined> = { ...process.env, CLAUDE_PROJECT_DIR: root };
  delete base.AT_SESSION;
  return spawnSync("/bin/sh", ["-c", command], { cwd: at("work/deep"), input: stdin, env: { ...base, ...env } as NodeJS.ProcessEnv, encoding: "utf8" });
}

const talkLines = () => {
  const p = at(".claude/state/talk.jsonl");
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};

beforeEach(() => { root = fs.mkdtempSync(join(os.tmpdir(), "at-session-binding-")); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("[N44b] scaffold", () => {
  it("[N44b] scaffold lists 4 agent files, sessions.md with 4 start lines, the launcher and both guards", () => {
    const { files } = scaffold();
    const paths = files.map((f) => f.path);
    for (const id of ["lane-manager", "lane-build", "lane-video", "lane-text"]) {
      expect(paths).toContain(`.claude/agents/${id}/AGENT.md`);
    }
    const sessions = files.find((f) => f.path === ".claude/sessions.md")!;
    const lines = sessions.content.split("\n").filter((l) => l.startsWith("AT_SESSION="));
    expect(lines).toHaveLength(4);
    expect(lines).toContain("AT_SESSION=lane-video claude --agent lane-video -n lane-video");
    expect(paths).toContain("scripts/start-sessions.sh");
    expect(paths).toContain(`${SCRIPTS}/spawn-guard.sh`);
    expect(paths).toContain(`${SCRIPTS}/talk-guard.sh`);
  });

  it("[N44b] a declared permission-mode adds --permission-mode to the start line", () => {
    const { files } = scaffold(src.replace("place: ops\n    decides", "place: ops\n    permission-mode: plan\n    decides"));
    const sessions = files.find((f) => f.path === ".claude/sessions.md")!.content;
    expect(sessions).toContain("AT_SESSION=lane-manager claude --agent lane-manager -n lane-manager --permission-mode plan");
    expect(sessions).toContain("AT_SESSION=lane-build claude --agent lane-build -n lane-build\n");
  });

  it("[N44b] the launcher runs herdr per place and split per extra session, and falls back to printing start lines", () => {
    const { files } = scaffold();
    const sh = files.find((f) => f.path === "scripts/start-sessions.sh")!.content;
    expect(sh.startsWith("#!/bin/sh")).toBe(true);
    expect(sh).toContain("herdr tab create ops");
    expect(sh).toContain("herdr tab create makers");
    expect(sh).toContain("herdr pane split");
    expect(sh).toContain("herdr pane run");
    expect(sh).toContain("command -v herdr");
    // plain POSIX: parses under sh -n, no bashisms
    expect(sh).not.toMatch(/\[\[|<<<|\$\{[^}]*\/\/|declare |mapfile/);
    expect(spawnSync("/bin/sh", ["-n", "-c", sh]).status).toBe(0);
  });

  it("[N44b] with herdr off PATH the launcher prints the start lines", () => {
    const { files } = scaffold();
    const sh = files.find((f) => f.path === "scripts/start-sessions.sh")!.content;
    const r = spawnSync("/bin/sh", ["-c", sh], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("AT_SESSION=lane-text claude --agent lane-text -n lane-text");
  });
});

describe.skipIf(!hasJq)("[N44b] spawn guard", () => {
  it("[N44b] an Agent call naming a session agent exits 2 with a reason; a normal subagent passes", () => {
    scaffold();
    const cmd = hookCmd("PreToolUse", "Agent|Task", "spawn-guard.sh");
    const settings = JSON.parse(fs.readFileSync(at(".claude/settings.json"), "utf8"));
    const entry = settings.hooks.PreToolUse.find((x: any) => x.hooks.some((h: any) => h.command.includes("spawn-guard.sh")));
    expect(entry.hooks[0].onFailure).toBe("block");
    const bad = run(cmd, JSON.stringify({ tool_name: "Agent", tool_input: { subagent_type: "lane-manager", prompt: "x" } }));
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("lane-manager");
    const ok = run(cmd, JSON.stringify({ tool_name: "Agent", tool_input: { subagent_type: "helper", prompt: "x" } }));
    expect(ok.status).toBe(0);
  });
});

describe.skipIf(!hasJq)("[N44b] talk guard", () => {
  const send = (to: string) => JSON.stringify({ tool_name: "SendMessage", tool_input: { to, message: "hi" } });

  it("[N44b] a send from lane-video to lane-text exits 2 and logs refused", () => {
    scaffold();
    const cmd = hookCmd("PreToolUse", "SendMessage", "talk-guard.sh");
    const r = run(cmd, send("lane-text"), { AT_SESSION: "lane-video" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("lane-text");
    const l = talkLines();
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ from: "lane-video", to: "lane-text", result: "refused" });
    expect(l[0].ts).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  });

  it("[N44b] a send from lane-video to lane-manager exits 0 and logs allowed", () => {
    scaffold();
    const cmd = hookCmd("PreToolUse", "SendMessage", "talk-guard.sh");
    const r = run(cmd, send("lane-manager"), { AT_SESSION: "lane-video" });
    expect(r.status).toBe(0);
    expect(talkLines()[0]).toMatchObject({ from: "lane-video", to: "lane-manager", result: "allowed" });
  });

  it("[N44b] AT_SESSION unset: the send passes, stderr says unguarded, talk.jsonl says unguarded", () => {
    scaffold();
    const cmd = hookCmd("PreToolUse", "SendMessage", "talk-guard.sh");
    const r = run(cmd, send("lane-text"));
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("talk guard: session not started from sessions.md, unguarded");
    expect(talkLines()[0]).toMatchObject({ to: "lane-text", result: "unguarded" });
  });

  it("[N44b] AT_SESSION set and the payload unparsable: fail closed (exit 2)", () => {
    scaffold();
    const cmd = hookCmd("PreToolUse", "SendMessage", "talk-guard.sh");
    const r = run(cmd, "not json{", { AT_SESSION: "lane-video" });
    expect(r.status).toBe(2);
  });

  it("[N44b] no talk guard is generated when no talk edges are declared", () => {
    const flat = src.replace("    talk: hub lane-manager\n", "").replace("    lane-manager -> lane-build [message: ticket]\n", "");
    const { files } = scaffold(flat);
    expect(files.map((f) => f.path)).not.toContain(`${SCRIPTS}/talk-guard.sh`);
  });
});

describe.skipIf(!hasJq)("[T04] decision seats", () => {
  const prompt = (text: string) => JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: text });

  it("[T04] a prompt starting with <cross-session-message writes kind arrived; a plain one writes typed; both exit 0", () => {
    scaffold();
    const settings = JSON.parse(fs.readFileSync(at(".claude/settings.json"), "utf8"));
    const e = settings.hooks.UserPromptSubmit.find((x: any) => x.hooks.some((h: any) => h.command.includes("lane-manager")));
    expect(e.matcher).toBeUndefined();
    const cmd = e.hooks[0].command;
    const a = run(cmd, prompt('<cross-session-message from="lane-build">package-yes</cross-session-message>'), { AT_SESSION: "lane-manager" });
    expect(a.status).toBe(0);
    const t = run(cmd, prompt("ship it"), { AT_SESSION: "lane-manager" });
    expect(t.status).toBe(0);
    const l = talkLines();
    expect(l.map((x) => x.kind)).toEqual(["arrived", "typed"]);
    expect(l[0].session).toBe("lane-manager");
  });

  it("[T04] the prompt hook is inert when AT_SESSION is another session or unset, and never blocks", () => {
    scaffold();
    const settings = JSON.parse(fs.readFileSync(at(".claude/settings.json"), "utf8"));
    const cmd = settings.hooks.UserPromptSubmit[0].hooks[0].command;
    expect(run(cmd, "garbage", { AT_SESSION: "lane-build" }).status).toBe(0);
    expect(run(cmd, "garbage").status).toBe(0);
    expect(run(cmd, "garbage", { AT_SESSION: "lane-manager" }).status).toBe(0);
    expect(talkLines().filter((x) => x.session === "lane-build")).toHaveLength(0);
  });

  it("[T04] validate warns when an agent with decides: has an incoming talk edge", () => {
    const w = validate(parse(src)).filter((r) => r.rule === "V120");
    expect(w).toHaveLength(1);
    expect(w[0].level).toBe("warning");
    expect(w[0].message).toContain("a decision can arrive here as a message");
    expect(w[0].message).toContain("lane-manager");
  });

  it("[T04] no V120 when the deciding agent has no incoming talk edge", () => {
    const one = src.replace("    talk: hub lane-manager\n", "    lane-manager -> lane-build\n");
    expect(validate(parse(one)).filter((r) => r.rule === "V120")).toHaveLength(0);
  });

  it("[T04] guard --check prints the bypass line under every talk guard", () => {
    const { ast } = scaffold();
    const out = renderGuardReport(checkGuards(ast, root)).join("\n");
    const bypass = "a send through a terminal command, a shared file or a session outside this repo is not seen";
    expect(out).toContain(bypass);
    const report = checkGuards(ast, root);
    const talk = report.items.filter((i) => i.kind === "session" && i.id === "talk guard");
    expect(talk).toHaveLength(1);
    expect(talk[0].notes).toContain(bypass);
  });
});

describe("[N44b] guard --check grades", () => {
  it("[N44b] the proven field exists in the conformance facts and is false", () => {
    expect(SESSION_HOOKS_PROVEN).toEqual({ sendMessage: false, agent: false });
  });

  it("[N44b] talk and spawn guards on disk grade unverified, never refuse, while unproven", () => {
    const { ast } = scaffold();
    const items = checkGuards(ast, root).items.filter((i) => i.kind === "session");
    expect(items.map((i) => i.id).sort()).toEqual(["spawn guard", "talk guard"]);
    for (const i of items) expect(i.strength).toBe("unverified");
  });

  it("[N44b] a missing guard grades none; a missing sessions.md grades the talk guard none", () => {
    const { ast } = scaffold();
    fs.rmSync(at(`${SCRIPTS}/spawn-guard.sh`));
    fs.rmSync(at(".claude/sessions.md"));
    const items = checkGuards(ast, root).items.filter((i) => i.kind === "session");
    expect(items.find((i) => i.id === "spawn guard")!.strength).toBe("none");
    expect(items.find((i) => i.id === "talk guard")!.strength).toBe("none");
  });

  it("[N44b] guard --check on every examples/ file lists no session items", () => {
    const dir = resolve(here, "../../../examples");
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".at"))) {
      const ast = parse(fs.readFileSync(join(dir, f), "utf8"));
      expect(checkGuards(ast, root).items.filter((i) => i.kind === "session"), f).toHaveLength(0);
    }
  });
});

describe("[N44b] other targets", () => {
  it("[N44b] codex, cursor and claude-workflow print the experimental notice for session agents", () => {
    const ast = parse(src);
    for (const b of [codexBinding, cursorBinding, claudeWorkflowBinding]) {
      const seen: string[] = [];
      const orig = console.warn;
      console.warn = (...a: unknown[]) => { seen.push(a.join(" ")); };
      try { b.scaffold(ast); } catch { /* the notice is what is tested */ } finally { console.warn = orig; }
      expect(seen.join("\n"), b.name).toContain("session agents: experimental, not compiled");
    }
  });
});
