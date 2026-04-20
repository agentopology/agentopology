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

  it("hooks are REWRITTEN by generated (topology owns hooks)", () => {
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

    const merged = JSON.parse(deepMergeSettingsJson(existing, generated));
    // Old hooks gone — topology owns hooks
    expect(merged.hooks.PreToolUse).toBeUndefined();
    // New hooks present
    expect(merged.hooks.SubagentStop).toBeDefined();
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
