/**
 * [RW-2] The surface map for Codex, held to the schema snapshot.
 * The base already holds the CX-4 fixes (no `untrusted`, `max_threads`,
 * `max_depth`), so the drift is planted in a temp config.toml instead of
 * expected from the binding. The mechanism is the same: a `knownDrift` entry
 * with a ticket id excuses a mismatch; any other mismatch fails.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { parse } from "../../parser/index.js";
import { codexBinding } from "../../bindings/codex.js";
import {
  checkConfigAgainstSchema, collectCodexSurface, unmappedItems, itemKey, type SurfaceMap,
} from "../../conformance/surface.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const schema = JSON.parse(fs.readFileSync(resolve(root, "spec/codex/config.schema.json"), "utf8"));
const realMap = (): SurfaceMap => JSON.parse(fs.readFileSync(resolve(root, "spec/surface/codex.surface.json"), "utf8"));

const sources = ["kitchen-sink.at", "src/__tests__/e2e/fixtures/session-ops.at"];
function scaffolds() {
  return sources.map((s) => {
    const src = fs.readFileSync(resolve(root, s), "utf8").replace(/\bmodel: (opus|sonnet|haiku)\b/g, "model: gpt-5.2");
    return codexBinding.scaffold(parse(src));
  });
}
const configToml = (files: { path: string; content: string }[]) => files.find((f) => f.path === ".codex/config.toml")!.content;

/** A hand-written config.toml in a temp dir, read back from disk like a user's. */
function planted(toml: string): Record<string, unknown> {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "at-rw2-"));
  const f = join(dir, "config.toml");
  fs.writeFileSync(f, toml);
  return parseToml(fs.readFileSync(f, "utf8")) as Record<string, unknown>;
}
const PLANT = `
approval_policy = "untrusted"
sandbox_mode = "workspace-write"
[agents]
max_threads = 4
max_concurrent_threads_per_session = 5
`;

describe("[RW-2] surface map, Codex", () => {
  it("[RW-2] the snapshot is the 0.168.0 schema", () => {
    expect(schema.definitions.SandboxMode.enum).toEqual(["read-only", "workspace-write", "danger-full-access"]);
    expect(Object.keys(schema.properties).length).toBeGreaterThan(100);
  });

  it("[RW-2] green: the real binding output has zero mismatches against the snapshot", () => {
    for (const files of scaffolds()) {
      const cfg = parseToml(configToml(files)) as Record<string, unknown>;
      expect(checkConfigAgainstSchema(cfg, schema, [])).toEqual([]);
    }
  });

  it("[RW-2] planted: a config.toml with max_threads and approval_policy = untrusted names both", () => {
    const r = checkConfigAgainstSchema(planted(PLANT), schema, []);
    expect(r.map((m) => m.id).sort()).toEqual(["cx.config.agents.max_threads", "cx.config.approval_policy"]);
    expect(r.find((m) => m.id === "cx.config.approval_policy")!.value).toBe("untrusted");
  });

  it("[RW-2] with both in knownDrift, each with a CX ticket, the planted file passes", () => {
    const drift = [
      { id: "cx.config.agents.max_threads", value: "*", ticket: "CX-4", why: "0.10.1 wrote it; the schema has max_concurrent_threads_per_session" },
      { id: "cx.config.approval_policy", value: "untrusted", ticket: "CX-4", why: "0.10.1 passed it through" },
    ];
    expect(checkConfigAgainstSchema(planted(PLANT), schema, drift)).toEqual([]);
  });

  it("[RW-2] with both in knownDrift, any other mismatch still fails (an unknown sandbox_mode value)", () => {
    const drift = [
      { id: "cx.config.agents.max_threads", value: "*", ticket: "CX-4", why: "x" },
      { id: "cx.config.approval_policy", value: "untrusted", ticket: "CX-4", why: "x" },
    ];
    const r = checkConfigAgainstSchema({ ...planted(PLANT), sandbox_mode: "dangerous" }, schema, drift);
    expect(r.map((m) => m.id)).toEqual(["cx.config.sandbox_mode"]);
    // the excuse is for that value only: another approval value is still caught
    const r2 = checkConfigAgainstSchema({ approval_policy: "on-failure" }, schema, drift);
    expect(r2.map((m) => m.id)).toEqual(["cx.config.approval_policy"]);
  });

  it("[RW-2] a knownDrift item with no ticket id fails", () => {
    const r = checkConfigAgainstSchema(planted(PLANT), schema, [
      { id: "cx.config.agents.max_threads", value: "*", ticket: "", why: "x" },
      { id: "cx.config.approval_policy", value: "untrusted", ticket: "CX-4", why: "x" },
    ]);
    expect(r.map((m) => m.id).sort()).toEqual(["cx.config.agents.max_threads", "cx.knownDrift.cx.config.agents.max_threads"]);
  });

  it("[RW-2] the map holds every item the binding writes", () => {
    const all = scaffolds().flatMap((f) => collectCodexSurface(f));
    const missing = [...new Set(unmappedItems(all, realMap()).map(itemKey))];
    expect(missing).toEqual([]);
    expect(new Set(all.map((i) => i.area))).toContain("config.keys");
  });

  it("[RW-2] red: with an empty map, the config keys are named", () => {
    const empty: SurfaceMap = { platform: "codex", areas: [], entries: [] };
    const all = scaffolds().flatMap((f) => collectCodexSurface(f));
    const missing = unmappedItems(all, empty).map(itemKey);
    expect(missing).toContain("config.keys:approval_policy");
    expect(missing).toContain("sandbox:workspace-write");
  });

  it("[RW-2] the Codex map has cx ids, the proof files exist, and knownDrift items carry tickets", () => {
    const m = realMap();
    for (const e of m.entries) {
      expect(e.id, e.id).toMatch(/^cx\./);
      for (const p of [e.proof, ...(Array.isArray(e.usedBy) ? e.usedBy : [e.usedBy])]) expect(fs.existsSync(resolve(root, p)), `${e.id}: ${p}`).toBe(true);
    }
    for (const k of m.knownDrift ?? []) expect(k.ticket, k.id).toMatch(/^CX-?\d+/);
  });

  it("[RW-2] a guard script under .codex/scripts/<topology>/ maps to one entry whatever the topology is called", async () => {
    const { codexPathPattern } = await import("../../conformance/surface.js");
    expect(codexPathPattern(".codex/scripts/incident-response/before-action.sh")).toBe(".codex/scripts/*/*.sh");
    expect(codexPathPattern(".codex/scripts/ship/gate-render-check.sh")).toBe(".codex/scripts/*/*.sh");
    expect(codexPathPattern(".codex/scripts/at-if.sh")).toBe(".codex/scripts/*.sh");
  });
});
