/**
 * [S-29] A project with both a Codex tree (.codex, .agents) and a Claude Code
 * tree (.claude) has files at the same relative place: skill X, agent X, rule
 * X, the same hook, the same MCP server. They used to share one inventory id
 * and the dedup kept the Codex one only. Now every distinct file or entry is
 * its own item: the Claude Code one keeps the bare id, the Codex one is
 * `codex:<id>` (only on a collision), and a same-platform collision is
 * `<id> @<path>`. Spec: docs/plans/s29-skill-ids.md.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import { codexBinding } from "../../bindings/codex.js";
import { collectInventory, coverage, type InventoryItem } from "../../inventory/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, "../../../dist/cli/index.js");
// Codex refuses Claude model names (CX-5), so the fixture gets a Codex one.
const ast = parse(fs.readFileSync(resolve(here, "fixtures/compile.at"), "utf8").replace(/^(\s*model:\s*)(opus|sonnet|haiku|fable)\b.*$/gm, "$1gpt-5.2"));
const both = [...claudeCodeBinding.scaffold(ast), ...codexBinding.scaffold(ast)];
const NO = { launchAgentsDir: "/nonexistent", crontab: "" };

let root: string;
const write = (p: string, text: string) => { fs.mkdirSync(dirname(join(root, p)), { recursive: true }); fs.writeFileSync(join(root, p), text); };
const byPath = (items: InventoryItem[], p: string) => items.filter((i) => i.path === p);

beforeEach(() => {
  root = fs.mkdtempSync(join(os.tmpdir(), "at-s29-"));
  for (const f of both) write(f.path, f.content);
  write(".claude/rules/style.md", "# style\n");
  write(".codex/rules/style.rules", "prefix_rule(pattern=[\"ls\"], decision=\"allow\")\n");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("[S-29] ids that collide across platforms", () => {
  it("[S-29] keeps the Claude Code and the Codex skill, each with its own path", () => {
    const items = collectInventory(root, NO);
    const brief = items.filter((i) => i.kind === "skill" && /\/skills\/brief\/SKILL\.md$/.test(i.path ?? ""));
    expect(brief.map((i) => [i.id, i.path]).sort()).toEqual([
      ["codex:skill:brief", ".agents/skills/brief/SKILL.md"],
      ["skill:brief", ".claude/skills/brief/SKILL.md"],
    ]);
  });

  it("[S-29] every scaffolded file is an item, and every id is unique", () => {
    const items = collectInventory(root, NO);
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
    const paths = new Set(items.map((i) => i.path));
    const lost = both.map((f) => f.path).filter((p) => p !== ".codex/hooks.json" && !paths.has(p));
    expect(lost).toEqual([]);
  });

  it("[S-29] agents, rules and MCP servers on both platforms are both kept", () => {
    const items = collectInventory(root, NO);
    const agents = items.filter((i) => i.kind === "agent" && /drafter/.test(i.id));
    expect(agents.map((i) => i.id).sort()).toEqual(["agent:drafter", "codex:agent:drafter"]);
    expect(byPath(items, ".codex/rules/style.rules").map((i) => i.id)).toEqual(["codex:rule:style"]);
    expect(byPath(items, ".claude/rules/style.md").map((i) => i.id)).toEqual(["rule:style"]);
    expect(items.filter((i) => i.kind === "mcp-server" && /search$/.test(i.id)).map((i) => [i.id, i.path]).sort()).toEqual([
      ["codex:mcp:search", ".codex/config.toml"],
      ["mcp:search", ".mcp.json"],
    ]);
  });

  it("[S-29] each hook handler of each file is an item", () => {
    const items = collectInventory(root, NO);
    const count = (hooks: Record<string, Array<{ hooks?: unknown[] }>>) => Object.values(hooks ?? {}).flat().reduce((n, e) => n + (e.hooks?.length ?? 0), 0);
    const cc = count(JSON.parse(fs.readFileSync(join(root, ".claude/settings.json"), "utf8")).hooks);
    const cx = count(JSON.parse(fs.readFileSync(join(root, ".codex/hooks.json"), "utf8")).hooks);
    expect(cx).toBeGreaterThan(0);
    expect(items.filter((i) => i.kind === "hook" && i.path === ".claude/settings.json").length).toBe(cc);
    expect(items.filter((i) => i.kind === "hook" && i.path === ".codex/hooks.json").length).toBe(cx);
  });

  it("[S-29] a hook in settings.json and settings.local.json is two items", () => {
    const s = JSON.parse(fs.readFileSync(join(root, ".claude/settings.json"), "utf8"));
    write(".claude/settings.local.json", JSON.stringify({ hooks: s.hooks }));
    const items = collectInventory(root, NO);
    const local = items.filter((i) => i.kind === "hook" && i.path === ".claude/settings.local.json");
    expect(local.length).toBe(items.filter((i) => i.kind === "hook" && i.path === ".claude/settings.json").length);
    expect(local.every((i) => i.id.endsWith(" @.claude/settings.local.json") && i.tag === "e")).toBe(true);
  });

  it("[S-29] coverage maps both copies of a scaffolded skill, agent, hook and server", () => {
    const items = collectInventory(root, NO);
    const r = coverage(ast, items, root, { home: "/nonexistent-home" });
    const unmapped = r.unmapped.map((i) => i.id);
    for (const id of ["skill:brief", "codex:skill:brief", "agent:drafter", "codex:agent:drafter", "mcp:search", "codex:mcp:search"]) expect(unmapped).not.toContain(id);
    expect(unmapped.filter((id) => id.startsWith("codex:hook:") || id.startsWith("hook:"))).toEqual([]);
    expect(r.total).toBe(items.filter((i) => i.tag !== "e").length);
  });

  it("[S-29] a single-platform project keeps its ids unchanged", () => {
    const solo = fs.mkdtempSync(join(os.tmpdir(), "at-s29-solo-"));
    try {
      for (const f of codexBinding.scaffold(ast)) { fs.mkdirSync(dirname(join(solo, f.path)), { recursive: true }); fs.writeFileSync(join(solo, f.path), f.content); }
      const ids = collectInventory(solo, NO).map((i) => i.id);
      expect(ids).toContain("skill:brief");
      expect(ids.some((id) => id.startsWith("codex:") || id.includes(" @"))).toBe(false);
    } finally { fs.rmSync(solo, { recursive: true, force: true }); }
  });

  it("[S-29] validate --inventory still reads an inventory.json saved before S-29", () => {
    // Before S-29: one item per id, the Codex one kept, no codex: prefix.
    const seen = new Set<string>();
    const old = collectInventory(root, NO)
      .map((i) => ({ ...i, id: i.id.replace(/^codex:/, "").replace(/ @\S+$/, "") }))
      .sort((a, b) => Number(/^\.(codex|agents)\//.test(b.path ?? "")) - Number(/^\.(codex|agents)\//.test(a.path ?? "")))
      .filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)));
    const file = join(root, "old-inventory.json");
    fs.writeFileSync(file, JSON.stringify({ version: 1, items: old }));
    const atFile = join(root, "t.at");
    fs.writeFileSync(atFile, fs.readFileSync(resolve(here, "fixtures/compile.at"), "utf8").replace(/^(\s*model:\s*)(opus|sonnet|haiku|fable)\b.*$/gm, "$1gpt-5.2"));
    const out = spawnSync("node", [CLI, "validate", atFile, "--inventory", file, "--dir", root], { encoding: "utf-8", cwd: root, timeout: 60000 });
    const r = coverage(ast, old, root);
    expect(out.stdout).toContain(`coverage: ${r.mapped} of ${r.total} live things are in the .at`);
    expect(r.total).toBe(old.filter((i) => i.tag !== "e").length);
  });
});
