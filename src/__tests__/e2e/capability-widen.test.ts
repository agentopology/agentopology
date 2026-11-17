/**
 * End to end: scaffold does not widen a tool list the user narrowed by hand.
 *
 * The case a real harness hit: an agent file lists four named playwright
 * tools, the .at says `mcp.playwright.*`, and there is no manifest yet. The
 * frontmatter patch wrote `mcp__playwright__*` over the four names, with one
 * change line, giving the agent every playwright tool its owner had taken
 * away. It now keeps the file's list, says so, reports it in
 * `validate --inventory`, and only --force writes the .at's.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const CLI = resolve(root, "dist/cli/index.js");

const topology = (file: boolean) => `topology scout : [pipeline] {
  meta {
    version: "1.0.0"
    description: "Scouts signals in a browser"
  }

  mcp-servers {
    playwright {
      command: "npx"
      args: ["@playwright/mcp"]
    }
  }

  agent scout {
    model: sonnet
    description: "Scouts signals"
${file ? '    file: ".claude/agents/scout.md"\n' : ""}    tools: [Read, mcp.playwright.*]
  }

  agent writer {
    model: sonnet
    description: "Writes the report"
    tools: [Read, Write]
  }

  flow { scout -> writer }
}
`;

const NAMED = "Read, mcp__playwright__browser_navigate, mcp__playwright__browser_snapshot, mcp__playwright__browser_click, mcp__playwright__browser_take_screenshot";
const HAND = `---
name: scout
description: Scouts signals
model: sonnet
tools: ${NAMED}
---

Only navigate, snapshot, click and screenshot.
`;

const LINE = (path: string) =>
  `! ${path}: tools kept as written: the .at would widen them (+mcp__playwright__*); --force applies the .at's`;

let project: string;

function cli(args: string[]): { out: string; code: number } {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], { cwd: project, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { out, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { out: `${e.stdout ?? ""}${e.stderr ?? ""}`, code: e.status ?? 1 };
  }
}

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const toolsLine = (rel: string) => /^tools:.*$/m.exec(fs.readFileSync(join(project, rel), "utf-8"))?.[0];

beforeEach(() => {
  project = fs.mkdtempSync(join(os.tmpdir(), "at-widen-"));
});

for (const file of [true, false]) {
  const rel = file ? ".claude/agents/scout.md" : ".claude/agents/scout/AGENT.md";
  describe(`a hand-narrowed tool list ${file ? "(file:)" : "(generated path)"}`, () => {
    beforeEach(() => {
      fs.writeFileSync(join(project, "t.at"), topology(file));
      fs.mkdirSync(dirname(join(project, rel)), { recursive: true });
      fs.writeFileSync(join(project, rel), HAND);
    });

    it("scaffold keeps the named tools and prints one line saying why", () => {
      const r = cli(["scaffold", "t.at", "--target", "claude-code"]);
      expect(r.code).toBe(0);
      expect(toolsLine(rel)).toBe(`tools: ${NAMED}`);
      expect(fs.readFileSync(join(project, rel), "utf-8")).toBe(HAND);
      const out = plain(r.out);
      expect(out).toContain(LINE(rel));
      expect(out).not.toContain(`~ ${rel}: tools`);
    });

    it("--dry-run prints the same line and writes nothing", () => {
      const r = cli(["scaffold", "t.at", "--target", "claude-code", "--dry-run"]);
      expect(plain(r.out)).toContain(LINE(rel));
      expect(fs.readFileSync(join(project, rel), "utf-8")).toBe(HAND);
    });

    it("validate --inventory reports the kept key as drift, in --json too", () => {
      const human = cli(["validate", "t.at", "--inventory", "."]);
      expect(human.code).toBe(3);
      expect(plain(human.out)).toMatch(new RegExp(`${rel.replace(/[./]/g, "\\$&")}\\s+tools\\s+kept-narrower`));
      const json = cli(["validate", "t.at", "--inventory", ".", "--json"]);
      expect(json.code).toBe(3);
      const rows = (JSON.parse(json.out) as { drift: Array<Record<string, unknown>> }).drift.filter((d) => d.key === "tools");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ path: rel, kind: "agent", id: "scout", key: "tools", state: "kept-narrower", base: null });
      expect(rows[0].detail).toBe(LINE(rel).slice(`! ${rel}: `.length));
    });

    it("a second plain run still keeps them (nothing recorded as applied)", () => {
      cli(["scaffold", "t.at", "--target", "claude-code"]);
      const r = cli(["scaffold", "t.at", "--target", "claude-code"]);
      expect(toolsLine(rel)).toBe(`tools: ${NAMED}`);
      expect(plain(r.out)).toContain(LINE(rel));
    });

    it("--force writes the .at's tools", () => {
      const r = cli(["scaffold", "t.at", "--target", "claude-code", "--force"]);
      expect(r.code).toBe(0);
      expect(toolsLine(rel)).toBe('tools: "Read, mcp__playwright__*"');
      expect(plain(r.out)).not.toContain("tools kept as written");
    });
  });
}
