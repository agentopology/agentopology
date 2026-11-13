/**
 * [CX-18] Inventory and coverage for a Codex project: the agent files, skills,
 * hook entries, rules and MCP servers under .codex and .agents are listed, and
 * validate --inventory maps all of them. A hand-made hook shows as unmapped.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import { codexBinding } from "../../bindings/codex.js";
import { collectInventory, coverage } from "../../inventory/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, "../../../dist/cli/index.js");
const FIXTURE = resolve(here, "fixtures/compile.at");
const BRAIN = resolve(here, "../../../examples/company-brain-team.at");
// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

function scaffoldTo(file: string): { root: string; ast: ReturnType<typeof parse> } {
  // Codex refuses Claude model names (CX-5), so the fixtures get a Codex one.
  const ast = parse(fs.readFileSync(file, "utf8").replace(/^(\s*model:\s*)(opus|sonnet|haiku|fable)\b.*$/gm, "$1gpt-5.2"));
  const root = fs.mkdtempSync(join(os.tmpdir(), "at-cx18-"));
  for (const f of codexBinding.scaffold(ast)) {
    fs.mkdirSync(dirname(join(root, f.path)), { recursive: true });
    fs.writeFileSync(join(root, f.path), f.content);
  }
  return { root, ast };
}

describe("[CX-18] Codex inventory", () => {
  let root: string;
  let ast: ReturnType<typeof parse>;
  beforeEach(() => { ({ root, ast } = scaffoldTo(FIXTURE)); });

  it("[CX-18] lists agent files and skills", () => {
    const ids = collectInventory(root).map((i) => i.id);
    expect(ids).toContain("agent:drafter");
    expect(ids).toContain("skill:brief");
    expect(ids.filter((i) => i.startsWith("agent:")).length).toBeGreaterThan(0);
  });

  it("[CX-18] lists hook entries from hooks.json and rules files", () => {
    fs.writeFileSync(join(root, ".codex/hooks.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi", timeout: 5 }] }] } }));
    fs.mkdirSync(join(root, ".codex/rules"), { recursive: true });
    fs.writeFileSync(join(root, ".codex/rules/no-push.rules"), "prefix_rule(pattern=['git','push'], decision='forbidden')\n");
    const items = collectInventory(root);
    expect(items.map((i) => i.id)).toContain("hook:PreToolUse[Bash] echo hi");
    expect(items.map((i) => i.id)).toContain("rule:no-push");
  });

  it("[CX-18] lists MCP servers from config.toml", () => {
    const b = scaffoldTo(BRAIN);
    const ids = collectInventory(b.root).map((i) => i.id);
    expect(ids).toContain("mcp:gmail");
    expect(ids).toContain("mcp:slack");
  });

  it("[CX-18] a scaffolded project is fully mapped", () => {
    const r = coverage(ast, collectInventory(root), root);
    expect(r.total).toBeGreaterThan(0);
    expect(r.unmapped.map((i) => i.id)).toEqual([]);
    const b = scaffoldTo(BRAIN);
    const rb = coverage(b.ast, collectInventory(b.root), b.root);
    expect(rb.unmapped.map((i) => i.id)).toEqual([]);
  });

  it("[CX-18] a planted hand-made hook is unmapped", () => {
    fs.writeFileSync(join(root, ".codex/hooks.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "/usr/bin/true" }] }] } }));
    const r = coverage(ast, collectInventory(root), root);
    expect(r.unmapped.map((i) => i.id)).toEqual(["hook:Stop /usr/bin/true"]);
  });

  it("[CX-18] validate --inventory on a Codex project maps everything", () => {
    const at = join(fs.mkdtempSync(join(os.tmpdir(), "at-cx18-src-")), "compile.at");
    fs.writeFileSync(at, fs.readFileSync(FIXTURE, "utf8").replace(/^(\s*model:\s*)(opus|sonnet|haiku|fable)\b.*$/gm, "$1gpt-5.2"));
    const out = spawnSync("node", [CLI, "validate", at, "--inventory", root], { encoding: "utf8" });
    const text = plain(out.stdout);
    expect(text).toMatch(/coverage: ([1-9]\d*) of \1 live things/);
    expect(text).not.toContain("unmapped (");
  });
});
