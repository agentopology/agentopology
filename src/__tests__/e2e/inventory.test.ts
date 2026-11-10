/**
 * `agentopology inventory <dir>` and `validate <file> --inventory` (N34):
 * which live things in a project the .at accounts for, and which things the
 * .at points at that are not there.
 *
 * inventory lists what is live under a project (the .claude tree, each
 * settings.json hook handler, .mcp.json servers, package.json scripts), with a
 * sha256 fingerprint per file. It reads and prints; it never writes.
 *
 * Coverage matches each live thing to the .at in two ways: the file or hook is
 * what scaffold would write from this .at, or the .at points at it by hand
 * (file:, a hook's run, a gate's run, a tool's script, at:, an mcp server).
 * A live thing nothing accounts for is unmapped (a warning). A path the .at
 * points at that is not on disk is missing (an error, exit 1). Things tagged
 * "e" (the platform, the machine) are counted apart and never required.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import { collectInventory, coverage, type InventoryItem } from "../../inventory/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "fixtures/compile.at");
const CLI = resolve(here, "../../../dist/cli/index.js");
const source = fs.readFileSync(FIXTURE, "utf-8");
const ast = parse(source);

let root: string;
const at = (p: string) => join(root, p);
const write = (p: string, text: string) => { fs.mkdirSync(dirname(at(p)), { recursive: true }); fs.writeFileSync(at(p), text); };
const settings = () => JSON.parse(fs.readFileSync(at(".claude/settings.json"), "utf8"));
const report = () => coverage(ast, collectInventory(root), root);
const ids = (items: InventoryItem[]) => items.map((i) => i.id);
const cli = (...a: string[]) => spawnSync("node", [CLI, ...a], { encoding: "utf-8", cwd: root });

beforeEach(() => {
  root = fs.mkdtempSync(join(os.tmpdir(), "at-inventory-"));
  for (const f of claudeCodeBinding.scaffold(ast)) write(f.path, f.content);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("inventory lists what is live", () => {
  it("[N34] [IV1] agents, skills, skill scripts, settings hooks and mcp servers, each file with its sha256", () => {
    const items = collectInventory(root);
    const byId = new Map(items.map((i) => [i.id, i]));
    expect(byId.get("agent:drafter")).toMatchObject({ kind: "agent", path: ".claude/agents/drafter/AGENT.md" });
    expect(byId.get("skill:tone")).toMatchObject({ kind: "skill", path: ".claude/skills/tone/SKILL.md" });
    expect(byId.get("skill-file:compile/scripts/before-agent.sh")).toMatchObject({ kind: "skill-file" });
    expect(byId.get("mcp:search")).toMatchObject({ kind: "mcp-server" });
    expect(items.filter((i) => i.kind === "hook").length).toBeGreaterThan(3);
    const tone = byId.get("skill:tone")!;
    expect(tone.fingerprint).toBe(createHash("sha256").update(fs.readFileSync(at(tone.path!))).digest("hex"));
  });

  it("[N34] [IV1] the listing is sorted and stable, and settings.local.json is suggested as e (machine-local)", () => {
    write(".claude/settings.local.json", "{}\n");
    const a = collectInventory(root);
    expect(ids(a)).toEqual([...ids(a)].sort());
    expect(collectInventory(root)).toEqual(a);
    expect(a.find((i) => i.path === ".claude/settings.local.json")).toMatchObject({ tag: "e" });
  });

  it("[N34] [IV1] worktrees and node_modules are skipped, and a skill's working folder is one item, not every file in it", () => {
    write(".claude/worktrees/agent-1/.claude/agents/copy.md", "x\n");
    write(".claude/node_modules/pkg/index.js", "x\n");
    write(".claude/skills/tone/scripts/node_modules/dep/index.js", "x\n");
    write(".claude/skills/tone/references/style.md", "x\n");
    write(".claude/skills/tone/workspace/p1/render.mp4", "x\n");
    write(".claude/skills/tone/workspace/p2/render.mp4", "x\n");
    write(".claude/skills/tone/scripts/__pycache__/lock.cpython-312.pyc", "x\n");
    const got = ids(collectInventory(root));
    expect(got.filter((id) => /worktrees|node_modules|__pycache__/.test(id))).toEqual([]);
    expect(got).toContain("skill-file:tone/references/style.md");
    expect(got.filter((id) => id.includes("tone/workspace"))).toEqual(["skill-dir:tone/workspace"]);
  });

  it("[N34] [IV1] package.json scripts are live things too", () => {
    write("package.json", JSON.stringify({ scripts: { post: "node media.js post", test: "vitest" } }));
    expect(ids(collectInventory(root))).toEqual(expect.arrayContaining(["script:post", "script:test"]));
  });
});

describe("coverage: the .at against what is live", () => {
  it("[N34] [IV2] a freshly scaffolded project is fully covered, nothing unmapped, nothing missing", () => {
    const r = report();
    expect(r.unmapped).toEqual([]);
    expect(r.missing).toEqual([]);
    expect(r.mapped).toBe(r.total);
    expect(r.total).toBeGreaterThan(20);
  });

  it("[N34] [IV3] hand-built things nothing in the .at accounts for are unmapped, by kind", () => {
    write(".claude/agents/stray.md", "---\nname: stray\n---\nA hand-made agent.\n");
    write(".claude/commands/ship.md", "Ship it.\n");
    const s = settings();
    s.hooks.PreToolUse = [...(s.hooks.PreToolUse ?? []), { matcher: "mcp__chrome__upload_image", hooks: [{ type: "command", command: "python3 \"$CLAUDE_PROJECT_DIR/tools/lock.py\"" }] }];
    fs.writeFileSync(at(".claude/settings.json"), JSON.stringify(s, null, 2));
    const mcp = JSON.parse(fs.readFileSync(at(".mcp.json"), "utf8"));
    mcp.mcpServers.chrome = { command: "chrome-mcp" };
    fs.writeFileSync(at(".mcp.json"), JSON.stringify(mcp));

    const r = report();
    const un = ids(r.unmapped);
    expect(un).toEqual(expect.arrayContaining(["agent:stray", "command:ship", "mcp:chrome"]));
    expect(un.some((id) => id.startsWith("hook:PreToolUse") && id.includes("tools/lock.py"))).toBe(true);
    expect(r.unmapped).toHaveLength(4);
    expect(r.mapped).toBe(r.total - 4);
  });

  it("[N34] [IV3] a hand-written file inside a skill the .at declares counts under that skill", () => {
    write(".claude/skills/tone/references/house-style.md", "Short sentences.\n");
    expect(report().unmapped).toEqual([]);
  });

  it("[N34] [IV3] a declared store's data files count under the store", () => {
    const mem = parse(fs.readFileSync(resolve(here, "../../../examples/memory-system.at"), "utf-8").replace('".memory/semantic/"', '".claude/stores/semantic/"'));
    write(".claude/stores/semantic/index.db", "x\n");
    write(".claude/stores/stray/rows.json", "x\n");
    const un = ids(coverage(mem, collectInventory(root), root).unmapped);
    expect(un).toContain("claude-file:stores/stray/rows.json");
    expect(un).not.toContain("claude-file:stores/semantic/index.db");
  });

  it("[N34] [IV4] a path the .at points at that is not on disk is missing, named with what points at it", () => {
    fs.rmSync(at("docs/tools/check.py"));
    fs.rmSync(at("tools/render.py"));
    const r = report();
    expect(r.missing.map((m) => m.path).sort()).toEqual(["docs/tools/check.py", "tools/render.py"]);
    expect(r.missing.find((m) => m.path === "docs/tools/check.py")!.from).toContain("copy-check");
    expect(r.missing.find((m) => m.path === "tools/render.py")!.from).toContain("render");
  });

  it("[N34] [IV4] a generated file that is not there is reported as not scaffolded, not as missing", () => {
    fs.rmSync(at(".claude/skills/compile/scripts/before-agent.sh"));
    const r = report();
    expect(r.missing).toEqual([]);
    expect(r.notScaffolded).toContain(".claude/skills/compile/scripts/before-agent.sh");
  });

  it("[N34] [IV5] things tagged e are counted apart and never required", () => {
    write(".claude/agents/stray.md", "x\n");
    const items = collectInventory(root).map((i) => (i.id === "agent:stray" ? { ...i, tag: "e" as const } : i));
    const r = coverage(ast, items, root);
    expect(r.unmapped).toEqual([]);
    expect(ids(r.external)).toEqual(["agent:stray"]);
    expect(r.total).toBe(items.length - 1);
  });

  it("[N34] [IV6] a hand-written hook the .at declares by its run maps the hand-built settings entry", () => {
    const withLock = parse(source.replace("    hook finished {", `    hook lock {\n      on: PreToolUse\n      matcher: "Bash"\n      run: "tools/lock.py"\n    }\n    hook finished {`));
    write("tools/lock.py", "print('ok')\n");
    const s = settings();
    s.hooks.PreToolUse = [...(s.hooks.PreToolUse ?? []), { matcher: "Bash", hooks: [{ type: "command", command: "python3 \"$CLAUDE_PROJECT_DIR/tools/lock.py\" --strict" }] }];
    fs.writeFileSync(at(".claude/settings.json"), JSON.stringify(s, null, 2));
    expect(coverage(withLock, collectInventory(root), root).unmapped).toEqual([]);
    expect(coverage(ast, collectInventory(root), root).unmapped).toHaveLength(1);
  });
});

describe("the CLI", () => {
  it("[N34] [IV7] inventory <dir> prints JSON and writes nothing", () => {
    const before = fs.readdirSync(root, { recursive: true }).sort();
    const r = cli("inventory", root);
    expect(r.status).toBe(0);
    const json = JSON.parse(r.stdout);
    expect(json.version).toBe(1);
    expect(json.items.map((i: InventoryItem) => i.id)).toContain("agent:drafter");
    expect(fs.readdirSync(root, { recursive: true }).sort()).toEqual(before);
  });

  it("[N34] [IV7] validate --inventory <dir> prints coverage; unmapped warns, exit 0", () => {
    write(".claude/agents/stray.md", "x\n");
    const r = cli("validate", FIXTURE, "--inventory", root);
    expect(r.stdout).toMatch(/coverage: \d+ of \d+ live things are in the \.at/);
    expect(r.stdout).toContain("agent:stray");
    expect(r.status).toBe(0);
  });

  it("[N34] [IV7] validate --inventory reads a saved inventory.json; a missing path exits 1", () => {
    fs.rmSync(at("tools/render.py"));
    const saved = join(root, "inventory.json");
    fs.writeFileSync(saved, cli("inventory", root).stdout);
    const r = cli("validate", FIXTURE, "--inventory", saved, "--dir", root);
    expect(r.stdout).toMatch(/missing \(1\)/);
    expect(r.stdout).toContain("tools/render.py");
    expect(r.status).toBe(1);
  });
});
