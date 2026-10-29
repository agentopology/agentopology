/**
 * Tests for Change 3: Non-destructive scaffold of settings.json.
 *
 * Verifies that when settings.json already exists on disk, re-scaffolding
 * without --force performs a MERGE:
 *   - permissions.allow is union-merged (existing entries survive)
 *   - permissions.deny is union-merged
 *   - env is merged (generated wins on conflict)
 *   - hooks are rewritten (topology owns hooks)
 *   - user-only keys survive
 *
 * Also verifies that invalid existing JSON fails loudly.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { deepMergeSettingsJson } from "../merge.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { computeIncrementalPlan } from "../incremental.js";
import { hashContent } from "../manifest.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-merge-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// deepMergeSettingsJson — the core merge function for settings.json
// ---------------------------------------------------------------------------

describe("Change 3 — deepMergeSettingsJson", () => {
  it("union-merges permissions.allow arrays", () => {
    const existing = JSON.stringify({
      permissions: { allow: ["Read(/tmp/**)", "Write(/tmp/**)"] },
      hooks: {},
    });
    const generated = JSON.stringify({
      permissions: { allow: ["Read(**)", "Bash"] },
      hooks: { PostToolUse: [] },
    });

    const merged = JSON.parse(deepMergeSettingsJson(existing, generated));
    // All entries from both must be present
    expect(merged.permissions.allow).toContain("Read(/tmp/**)");
    expect(merged.permissions.allow).toContain("Write(/tmp/**)");
    expect(merged.permissions.allow).toContain("Read(**)");
    expect(merged.permissions.allow).toContain("Bash");
  });

  it("union-merges permissions.deny arrays", () => {
    const existing = JSON.stringify({
      permissions: { deny: ["Bash", "Write"] },
    });
    const generated = JSON.stringify({
      permissions: { deny: ["Edit"] },
    });

    const merged = JSON.parse(deepMergeSettingsJson(existing, generated));
    expect(merged.permissions.deny).toContain("Bash");
    expect(merged.permissions.deny).toContain("Write");
    expect(merged.permissions.deny).toContain("Edit");
  });

  it("deduplicates union-merged permission arrays", () => {
    const existing = JSON.stringify({
      permissions: { allow: ["Read(**)", "Bash"] },
    });
    const generated = JSON.stringify({
      permissions: { allow: ["Read(**)", "Write"] },
    });

    const merged = JSON.parse(deepMergeSettingsJson(existing, generated));
    const count = merged.permissions.allow.filter((a: string) => a === "Read(**)").length;
    expect(count).toBe(1);
  });

  it("generated wins on env key conflicts", () => {
    const existing = JSON.stringify({
      env: { FOO: "old-value", BAR: "preserved" },
    });
    const generated = JSON.stringify({
      env: { FOO: "new-value", BAZ: "added" },
    });

    const merged = JSON.parse(deepMergeSettingsJson(existing, generated));
    // Generated wins on conflict
    expect(merged.env.FOO).toBe("new-value");
    // Existing-only key preserved
    expect(merged.env.BAR).toBe("preserved");
    // Generated-only key added
    expect(merged.env.BAZ).toBe("added");
  });

  it("hooks the topology owns are replaced; the user's are kept", () => {
    const existing = JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "old", hooks: [{ type: "command", command: "old.sh" }] }],
      },
    });
    const generated = JSON.stringify({
      hooks: {
        SubagentStop: [{ matcher: "new", hooks: [{ type: "command", command: "new.sh" }] }],
      },
    });

    // old.sh is the topology's own script: its hook is replaced.
    const owned = JSON.parse(deepMergeSettingsJson(existing, generated, ["old.sh"]));
    expect(owned.hooks.PreToolUse).toBeUndefined();
    expect(owned.hooks.SubagentStop).toBeDefined();
    // Nothing claimed: old.sh is the user's hook and survives.
    const user = JSON.parse(deepMergeSettingsJson(existing, generated));
    expect(user.hooks.PreToolUse[0].hooks[0].command).toBe("old.sh");
    expect(user.hooks.SubagentStop).toBeDefined();
  });

  it("preserves user-only top-level keys", () => {
    const existing = JSON.stringify({
      model: "claude-opus-4-5",
      theme: "dark",
    });
    const generated = JSON.stringify({
      permissions: { allow: ["Read"] },
    });

    const merged = JSON.parse(deepMergeSettingsJson(existing, generated));
    expect(merged.model).toBe("claude-opus-4-5");
    expect(merged.theme).toBe("dark");
    expect(merged.permissions.allow).toContain("Read");
  });

  it("throws a descriptive error when existing JSON is invalid", () => {
    const existing = `{ "permissions": { "allow": ["Read"] `;  // truncated
    const generated = JSON.stringify({ permissions: { allow: ["Write"] } });

    expect(() => deepMergeSettingsJson(existing, generated)).toThrow(/invalid JSON/i);
  });

  it("returns generated as-is when existing is empty string", () => {
    const existing = "";
    const generated = JSON.stringify({ permissions: { allow: ["Read"] } });
    // Empty string means no prior settings — just use generated
    const result = deepMergeSettingsJson(existing, generated);
    expect(JSON.parse(result)).toEqual(JSON.parse(generated));
  });
});

// ---------------------------------------------------------------------------
// Regression: the domain-aware merge must actually be REACHED by the scaffold
// pipeline. It was written and fully tested here, but `incremental.ts` routed
// `shared-config` to the generic `deepMergeJson`, which keeps the existing
// value whenever a key exists on both sides and either side is not a plain
// object. `hooks[event]` is an ARRAY, so:
//   - adding a hook to an event the file already declared silently DROPPED it
//   - removing a hook was impossible, since the generic merge never deletes
// ---------------------------------------------------------------------------

describe("settings.json merge is wired into the scaffold pipeline", () => {
  const settings = (obj: unknown) => JSON.stringify(obj, null, 2);

  // `owned` lists scripts an earlier scaffold of this topology wrote: hooks
  // that run them are the topology's; every other hook is the user's.
  const plan = (existing: string, generated: string, owned: string[] = []) => {
    const dir = mkdtempSync(join(tmpdir(), "at-settings-"));
    const rel = ".claude/settings.json";
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, rel), existing);

    const generatedFiles = [
      { path: rel, content: generated, category: "shared-config" as const },
    ];
    const manifest = {
      source: "t.at",
      sourceHash: "x",
      target: "claude-code",
      generatedAt: new Date().toISOString(),
      files: {
        [rel]: { hash: hashContent(existing), category: "shared-config" },
        ...Object.fromEntries(owned.map((p) => [p, { hash: "x", category: "script" }])),
      },
    };
    const actions = computeIncrementalPlan(dir, "claude-code", generatedFiles, manifest as never);
    rmSync(dir, { recursive: true, force: true });
    const action = actions.find((a) => a.path === rel)!;
    // FileAction is a union; only the writing variants carry content.
    return action as Extract<typeof action, { content: string }>;
  };

  it("adds a hook to an event the existing file already declares", () => {
    const existing = settings({
      hooks: { SubagentStop: [{ matcher: "old", hooks: [{ type: "command", command: "a.sh" }] }] },
    });
    const generated = settings({
      hooks: {
        SubagentStop: [
          { matcher: "old", hooks: [{ type: "command", command: "a.sh" }] },
          { matcher: "new", hooks: [{ type: "command", command: "b.sh" }] },
        ],
      },
    });
    const action = plan(existing, generated);
    expect(action.type).toBe("update");
    // The generic merge kept the one-entry array and this assertion failed.
    expect(action.content).toContain("b.sh");
  });

  it("removes a hook when the topology no longer declares one", () => {
    const existing = settings({
      permissions: { allow: ["Read"] },
      hooks: { SubagentStop: [{ matcher: "gone", hooks: [{ type: "command", command: "x.sh" }] }] },
    });
    const generated = settings({ permissions: { allow: ["Read"] } });
    const action = plan(existing, generated, ["x.sh"]);
    expect(action.type).toBe("update");
    expect(action.content).not.toContain("x.sh");
    // The user's own permissions must survive the removal.
    expect(action.content).toContain("Read");
  });

  // A re-scaffold deleted every hook the user added by hand, and rebuilt
  // permissions from allow/deny alone — ask and defaultMode vanished.
  it("keeps the user's own hooks, ask rules and defaultMode on re-scaffold", () => {
    const existing = settings({
      permissions: { allow: ["Read"], ask: ["Bash(git push:*)"], defaultMode: "acceptEdits", additionalDirectories: ["../docs"] },
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "bash ./my-guard.sh" }] }],
        SubagentStop: [{ matcher: "writer", hooks: [{ type: "command", command: "bash .claude/skills/t/scripts/gate-old.sh" }] }],
      },
    });
    const generated = settings({
      permissions: { allow: ["Write"] },
      hooks: { SubagentStop: [{ matcher: "writer", hooks: [{ type: "command", command: "bash .claude/skills/t/scripts/gate-new.sh" }] }] },
    });
    const merged = JSON.parse(plan(existing, generated, [".claude/skills/t/scripts/gate-old.sh"]).content);
    expect(merged.hooks.PreToolUse[0].hooks[0].command).toBe("bash ./my-guard.sh");
    expect(JSON.stringify(merged.hooks.SubagentStop)).toContain("gate-new.sh");
    expect(JSON.stringify(merged.hooks.SubagentStop)).not.toContain("gate-old.sh");
    expect(merged.permissions.ask).toEqual(["Bash(git push:*)"]);
    expect(merged.permissions.defaultMode).toBe("acceptEdits");
    expect(merged.permissions.additionalDirectories).toEqual(["../docs"]);
    expect(merged.permissions.allow).toEqual(["Read", "Write"]);
  });

  it("still unions permissions the user added by hand", () => {
    const existing = settings({ permissions: { allow: ["Read", "MyOwnTool"] } });
    const generated = settings({ permissions: { allow: ["Read", "Write"] } });
    const action = plan(existing, generated);
    expect(action.content).toContain("MyOwnTool");
    expect(action.content).toContain("Write");
  });

  it("leaves non-settings shared-config on the generic merge", () => {
    const dir = mkdtempSync(join(tmpdir(), "at-cfg-"));
    const rel = ".claude/other.json";
    mkdirSync(join(dir, ".claude"), { recursive: true });
    const existing = JSON.stringify({ hooks: { A: [1] }, keep: true }, null, 2);
    writeFileSync(join(dir, rel), existing);
    const manifest = {
      source: "t.at",
      sourceHash: "x",
      target: "claude-code",
      generatedAt: new Date().toISOString(),
      files: { [rel]: { hash: hashContent(existing), category: "shared-config" } },
    };
    const actions = computeIncrementalPlan(
      dir,
      "claude-code",
      [{ path: rel, content: JSON.stringify({ added: 1 }, null, 2), category: "shared-config" }],
      manifest as never
    );
    rmSync(dir, { recursive: true, force: true });
    const action = actions.find((a) => a.path === rel)!;
    const written = action as Extract<typeof action, { content: string }>;
    // Generic merge never deletes, so the existing hooks key survives here.
    expect(written.content).toContain("hooks");
    expect(written.content).toContain("added");
  });
});
