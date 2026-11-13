/**
 * [CX-10] The same guard builders, given the Codex platform record, write
 * scripts that name nothing of Claude Code, and they still hold a gate.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../../parser/index.js";
import { sessionAgentsOf, talkEdgesOf } from "../../../parser/session-graph.js";
import type { GeneratedFile } from "../../types.js";
import {
  CODEX_GUARDS,
  CLAUDE_CODE_GUARDS,
  generateBeforeActionScript,
  generateBeforeAgentScript,
  generateGateWrapperScripts,
  projectRootLines,
  promptLog,
  spawnGuard,
  talkGuard,
} from "../guards.js";
import { decidersWithIncomingTalk } from "../session.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(here, "../../../__tests__/e2e/fixtures");
const hasJq = spawnSync("/bin/sh", ["-c", "command -v jq"]).status === 0;

const ACTION_GATE = `topology ship : [pipeline] {
  meta { version: "1.0.0" description: "Render then publish" }
  orchestrator { model: sonnet handles: [render, publish] }
  action render {
    kind: external
    commands: ["./tool render"]
  }
  action publish {
    kind: external
    commands: ["./tool publish"]
  }
  records {
    record trace { path: "logs/trace.jsonl" }
  }
  gates {
    gate publish-ready {
      after: render
      before: publish
      ledger: trace
      on-fail: halt
    }
  }
  flow { render -> publish }
}
`;

function allGuards(src: string): GeneratedFile[] {
  const ast = parse(src);
  const name = ast.topology.name;
  const out: GeneratedFile[] = [];
  const add = (f: GeneratedFile | null) => f && out.push(f);
  add(generateBeforeAgentScript(ast, CODEX_GUARDS));
  add(generateBeforeActionScript(ast, CODEX_GUARDS));
  out.push(...generateGateWrapperScripts(ast, CODEX_GUARDS, (run) => `bash ${run}`));
  const sessions = sessionAgentsOf(ast);
  if (sessions.length > 0) {
    out.push(spawnGuard(name, sessions, CODEX_GUARDS));
    if (talkEdgesOf(ast).length > 0) out.push(talkGuard(name, ast, CODEX_GUARDS));
    for (const a of decidersWithIncomingTalk(ast)) out.push(promptLog(name, a, CODEX_GUARDS));
  }
  return out;
}

const sources: Array<[string, string]> = [
  ["action gate", ACTION_GATE],
  ["compile.at", fs.readFileSync(join(fixtures, "compile.at"), "utf8")],
  ["session-ops.at", fs.readFileSync(join(fixtures, "session-ops.at"), "utf8")],
];

describe("[CX-10] guards built with the Codex platform record", () => {
  it("[CX-10] no script names CLAUDE_PROJECT_DIR, .claude or Claude Code", () => {
    let count = 0;
    for (const [label, src] of sources) {
      for (const f of allGuards(src)) {
        count++;
        expect(f.content, `${label}: ${f.path}`).not.toMatch(/CLAUDE_PROJECT_DIR|\.claude|Claude Code/);
        expect(f.path, label).toMatch(/^\.codex\//);
      }
    }
    expect(count).toBeGreaterThanOrEqual(6);
  });

  it("[CX-10] the same guards built for Claude Code do name CLAUDE_PROJECT_DIR", () => {
    const ast = parse(ACTION_GATE);
    expect(generateBeforeActionScript(ast, CLAUDE_CODE_GUARDS)!.content).toContain("CLAUDE_PROJECT_DIR");
  });

  it("[CX-10] every Codex script is valid bash", () => {
    for (const [label, src] of sources) {
      for (const f of allGuards(src)) {
        const r = spawnSync("bash", ["-n"], { input: f.content, encoding: "utf8" });
        expect(r.status, `${label}: ${f.path}\n${r.stderr}`).toBe(0);
      }
    }
  });

  it("[CX-10] with no project-dir variable every root mode climbs from the script's place", () => {
    for (const mode of ["cd", "strict", "fallback"] as const) {
      const lines = projectRootLines(CODEX_GUARDS, "ship", mode).join("\n");
      expect(lines).toContain('dirname "${BASH_SOURCE[0]}")/../../..');
      expect(lines).not.toContain("CLAUDE");
    }
  });

  it("[CX-10] a platform that cannot ask writes no ask() function", () => {
    const ast = parse(fs.readFileSync(join(fixtures, "compile.at"), "utf8"));
    const f = generateBeforeAgentScript(ast, CODEX_GUARDS);
    if (f) expect(f.content).not.toContain("permissionDecision");
    const cc = generateBeforeAgentScript(ast, CLAUDE_CODE_GUARDS);
    expect(cc?.content ?? "").toContain("permissionDecision");
  });

  it.skipIf(!hasJq)("[CX-10] the Codex before-action script blocks without an ok record and passes with one, from a subfolder", () => {
    const root = fs.mkdtempSync(join(os.tmpdir(), "cx10-"));
    try {
      const f = generateBeforeActionScript(parse(ACTION_GATE), CODEX_GUARDS)!;
      const script = join(root, f.path);
      fs.mkdirSync(dirname(script), { recursive: true });
      fs.writeFileSync(script, f.content, { mode: 0o755 });
      fs.mkdirSync(join(root, "work/deep"), { recursive: true });
      const env = { ...process.env } as NodeJS.ProcessEnv;
      delete env.CLAUDE_PROJECT_DIR;
      const run = (command: string) =>
        spawnSync("bash", [script], { cwd: join(root, "work/deep"), input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }), env, encoding: "utf8" });

      expect(run("./tool publish").status).toBe(2);
      expect(run("cd x && ./tool publish").status).toBe(2);
      expect(run("ls").status).toBe(0);
      fs.mkdirSync(join(root, "logs"), { recursive: true });
      fs.writeFileSync(join(root, "logs/trace.jsonl"), JSON.stringify({ step: "render", unit: "", ok: true, at: "2026-01-01T00:00:00Z" }) + "\n");
      expect(run("./tool publish").status).toBe(0);
      expect(run("cd x && ./tool publish").status).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
