/**
 * Conformance v0: the claude-code binding's generated hooks, run against
 * Claude Code's hook contract (src/conformance/claude-code.ts, checked against
 * the docs for Claude Code 2.1.323).
 *
 * For every example and fixture: the settings.json hooks and each agent's
 * frontmatter hooks are checked statically, then every command hook is run
 * the way Claude Code runs it (a shell, the session's current directory,
 * CLAUDE_PROJECT_DIR set, the event's JSON on stdin). The working directory is
 * a subfolder on purpose: hooks run where Claude is, not at the project root.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import { checkHooks, checkStdout, payloadFor, unanchoredScript, VERIFIED_ON, HOOK_EVENTS } from "../../conformance/claude-code.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const CORPUS = [
  ...fs.readdirSync(join(repo, "examples")).filter((f) => f.endsWith(".at")).map((f) => join(repo, "examples", f)),
  join(here, "fixtures/compile.at"),
  join(here, "fixtures/hazards.at"),
  join(repo, "kitchen-sink.at"),
];
const hasJq = spawnSync("/bin/sh", ["-c", "command -v jq"]).status === 0;

interface Hook { event: string; matcher?: string; command: string; where: string }

/** Command hooks from settings.json and from agent frontmatter. */
function commandHooks(files: Array<{ path: string; content: string }>): Hook[] {
  const out: Hook[] = [];
  const settings = files.find((f) => f.path === ".claude/settings.json");
  for (const [event, entries] of Object.entries((settings ? JSON.parse(settings.content).hooks : {}) ?? {})) {
    for (const e of entries as Array<{ matcher?: string; hooks: Array<{ type: string; command?: string }> }>) {
      for (const h of e.hooks) if (h.type === "command" && h.command) out.push({ event, matcher: e.matcher, command: h.command, where: "settings.json" });
    }
  }
  for (const f of files.filter((x) => x.path.startsWith(".claude/agents/") && x.path.endsWith(".md"))) {
    const front = f.content.split(/\n---\n/)[0];
    let event = "";
    for (const line of front.split("\n")) {
      const ev = /^ {2}([A-Za-z]+):\s*$/.exec(line);
      if (ev) event = ev[1];
      const cmd = /^\s+(?:- )?command: (".*")\s*$/.exec(line);
      if (cmd && event) out.push({ event: event === "Stop" ? "SubagentStop" : event, command: JSON.parse(cmd[1]), where: f.path });
    }
  }
  return out;
}

it(`[N28] [CF0] the contract names the Claude Code version it was checked on (${VERIFIED_ON})`, () => {
  expect(VERIFIED_ON).toMatch(/^\d+\.\d+\.\d+$/);
  expect(HOOK_EVENTS.size).toBe(33);
});

it("[N28] [CF0] a relative script path is caught; an anchored or absolute one is not", () => {
  expect(unanchoredScript("bash .claude/skills/t/scripts/x.sh")).toBe(".claude/skills/t/scripts/x.sh");
  expect(unanchoredScript('bash "$CLAUDE_PROJECT_DIR/.claude/skills/t/scripts/x.sh"')).toBeNull();
  expect(unanchoredScript("python3 /opt/check.py --strict")).toBeNull();
  expect(unanchoredScript("echo hi")).toBeNull();
});

for (const file of CORPUS) {
  const name = file.replace(repo + "/", "");
  describe(`conformance: ${name}`, () => {
    const files = claudeCodeBinding.scaffold(parse(fs.readFileSync(file, "utf8")));
    const settings = files.find((f) => f.path === ".claude/settings.json");
    const hooks = commandHooks(files);
    let root: string;
    let sub: string;

    beforeAll(() => {
      root = fs.mkdtempSync(join(os.tmpdir(), "at-conformance-"));
      for (const f of files) {
        const p = join(root, f.path);
        fs.mkdirSync(dirname(p), { recursive: true });
        fs.writeFileSync(p, f.content);
        if (f.executable) fs.chmodSync(p, 0o755);
      }
      sub = join(root, "src/deep");
      fs.mkdirSync(sub, { recursive: true });
    });
    afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

    it("[N28] [CF1] settings.json hooks match the contract (events, matchers, handler fields, onFailure, anchored paths)", () => {
      expect(checkHooks(settings ? JSON.parse(settings.content).hooks ?? {} : {})).toEqual([]);
    });

    it("[N28] [CF1] agent frontmatter command hooks name their scripts by an anchored path", () => {
      const loose = hooks.filter((h) => h.where !== "settings.json").map((h) => unanchoredScript(h.command)).filter(Boolean);
      expect(loose).toEqual([]);
    });

    it.skipIf(!hasJq)("[N28] [CF2] every command hook runs from a subfolder: found, exits 0 or 2 (1 for an unwritten stub, E-1), and its stdout is valid for its event", () => {
      const results = hooks.map((h) => {
        const r = spawnSync("/bin/sh", ["-c", h.command], {
          cwd: sub,
          input: JSON.stringify(payloadFor(h.event, sub, h.matcher)),
          env: { ...process.env, CLAUDE_PROJECT_DIR: root },
          encoding: "utf8",
          timeout: 20_000,
        });
        const bad = r.status !== 0 && r.status !== 2 && !(r.status === 1 && /TODO: /.test(r.stderr)) ? `exit ${r.status}: ${r.stderr.trim().split("\n").pop()}` : r.status === 0 ? checkStdout(h.event, r.stdout) : null;
        return bad ? `${h.event} ${h.matcher ?? ""} ${h.command} → ${bad}` : null;
      });
      expect(results.filter(Boolean)).toEqual([]);
    });
  });
}
