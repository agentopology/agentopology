/**
 * [RW-1] The surface map for Claude Code is held to the binding's output.
 * Scaffold kitchen-sink.at and the session-agents fixture, collect every hook
 * event, handler field, payload field, frontmatter key, settings key, written
 * path and CLI flag, and fail on any with no entry in the map.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import { collectSurface, unmappedItems, itemKey, type SurfaceMap } from "../../conformance/surface.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const mapPath = resolve(root, "spec/surface/claude-code.surface.json");
const realMap = (): SurfaceMap => JSON.parse(fs.readFileSync(mapPath, "utf8"));

const sources = ["kitchen-sink.at", "src/__tests__/e2e/fixtures/session-ops.at"];
function items() {
  const out = [];
  for (const s of sources) {
    const files = claudeCodeBinding.scaffold(parse(fs.readFileSync(resolve(root, s), "utf8")));
    out.push(...collectSurface(files));
  }
  return out;
}
const names = (list: ReturnType<typeof items>) => [...new Set(list.map(itemKey))];

describe("[RW-1] surface map, Claude Code", () => {
  it("[RW-1] the scaffold exposes every kind of surface item", () => {
    const areas = new Set(items().map((i) => i.area));
    for (const a of ["hooks.events", "hooks.handler", "hooks.payload", "settings", "permissions.modes",
      "permissions.rules", "agents.file", "sessions", "skills", "mcp", "cli", "env", "schedules", "instructions"]) {
      expect(areas.has(a), a).toBe(true);
    }
  });

  it("[RW-1] red: with an empty map, every item is named", () => {
    const empty: SurfaceMap = { platform: "claude-code", areas: [], entries: [] };
    const all = names(items());
    const missing = names(unmappedItems(items(), empty));
    expect(missing).toEqual(all);
    expect(missing).toContain("hooks.events:PreToolUse");
    expect(missing).toContain("hooks.handler:onFailure");
    expect(missing).toContain("cli:--agent");
    expect(missing).toContain("env:CLAUDE_PROJECT_DIR");
  });

  it("[RW-1] green: the real map leaves zero items unmapped", () => {
    expect(names(unmappedItems(items(), realMap()))).toEqual([]);
  });

  it("[RW-1] ids follow <platform>.<area>.<name>, unique, with the fields the reader needs", () => {
    const m = realMap();
    const ids = m.entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of m.entries) {
      expect(e.id, e.id).toMatch(/^cc\.[a-z]+(\.[a-z]+)?\.[A-Za-z0-9_\-:.*/]+$/);
      expect(m.areas, e.id).toContain(e.area);
      expect(e.tokens.length, e.id).toBeGreaterThan(0);
      for (const f of ["usedBy", "language", "proof", "ifBroken", "grade"] as const) expect(e[f], `${e.id}.${f}`).toBeTruthy();
    }
    for (const id of ["cc.hooks.event.PreToolUse", "cc.hooks.handler.onFailure", "cc.hooks.handler.exit2",
      "cc.hooks.payload.subagent_type", "cc.permissions.modes.auto"]) expect(ids).toContain(id);
    expect(m.watchOnly?.some((w) => w.id === "cc.new.code-mode")).toBe(true);
  });

  it("[RW-1] every proof and usedBy path in the map exists", () => {
    for (const e of realMap().entries) {
      for (const p of [e.proof, ...(Array.isArray(e.usedBy) ? e.usedBy : [e.usedBy])]) {
        expect(fs.existsSync(resolve(root, p as string)), `${e.id}: ${p}`).toBe(true);
      }
    }
  });

  it("[RW-1] planted negative: deleting cc.hooks.event.PreToolUse in a temp copy fails, naming it", () => {
    const m = realMap();
    const copy: SurfaceMap = { ...m, entries: m.entries.filter((e) => e.id !== "cc.hooks.event.PreToolUse") };
    const missing = names(unmappedItems(items(), copy));
    expect(missing).toEqual(["hooks.events:PreToolUse"]);
  });
});
