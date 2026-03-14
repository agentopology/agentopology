/**
 * Tests for the incremental scaffold system.
 *
 * Covers manifest I/O, merge logic, incremental planning, and action execution.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { hashContent, readManifest, writeManifest } from "../manifest.js";
import { mergeAgentFile, shouldOverwriteScript } from "../merge.js";
import { computeIncrementalPlan, executeActions } from "../incremental.js";
import type { ScaffoldManifest } from "../types.js";
import type { GeneratedFile } from "../../bindings/types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scaffold-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// hashContent
// ---------------------------------------------------------------------------

describe("hashContent", () => {
  it("returns a deterministic sha256 hex digest", () => {
    const hash1 = hashContent("hello world");
    const hash2 = hashContent("hello world");
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns different hashes for different content", () => {
    expect(hashContent("a")).not.toBe(hashContent("b"));
  });
});

// ---------------------------------------------------------------------------
// Manifest round-trip
// ---------------------------------------------------------------------------

describe("manifest round-trip", () => {
  it("writes and reads a manifest correctly", () => {
    const manifest: ScaffoldManifest = {
      source: "test.at",
      sourceHash: hashContent("topology TestTop"),
      target: "claude-code",
      generatedAt: "2025-01-01T00:00:00.000Z",
      files: {
        ".claude/agents/planner/AGENT.md": {
          hash: hashContent("planner content"),
          category: "agent",
        },
        ".claude/settings.json": {
          hash: hashContent("{}"),
          category: "machine",
        },
      },
    };

    writeManifest(tmpDir, "claude-code", manifest);
    const loaded = readManifest(tmpDir, "claude-code");

    expect(loaded).not.toBeNull();
    expect(loaded!.source).toBe("test.at");
    expect(loaded!.target).toBe("claude-code");
    expect(loaded!.files[".claude/agents/planner/AGENT.md"].category).toBe("agent");
    expect(loaded!.files[".claude/settings.json"].hash).toBe(hashContent("{}"));
  });

  it("returns null when no manifest exists", () => {
    const loaded = readManifest(tmpDir, "claude-code");
    expect(loaded).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// mergeAgentFile
// ---------------------------------------------------------------------------

describe("mergeAgentFile", () => {
  it("preserves ## Instructions from existing and takes machine zones from generated", () => {
    const existing = [
      "# Agent: Planner",
      "",
      "## Instructions",
      "",
      "My custom prompt that I carefully wrote.",
      "",
      "## Role",
      "",
      "old role description",
    ].join("\n");

    const generated = [
      "# Agent: Planner",
      "",
      "## Instructions",
      "",
      "Default generated instructions.",
      "",
      "## Role",
      "",
      "new role description",
    ].join("\n");

    const merged = mergeAgentFile(existing, generated, "claude-code");

    // Should contain the user's custom prompt
    expect(merged).toContain("My custom prompt that I carefully wrote.");
    // Should NOT contain the generated default instructions
    expect(merged).not.toContain("Default generated instructions.");
    // Should contain the new Role section from generated (machine zone)
    expect(merged).toContain("new role description");
    expect(merged).not.toContain("old role description");
  });

  it("returns generated as-is when existing has no ## Instructions", () => {
    const existing = "# Some other file\n\nNo instructions here.\n";
    const generated = "# Agent: Planner\n\n## Instructions\n\nGenerated.\n";

    const merged = mergeAgentFile(existing, generated, "claude-code");
    expect(merged).toBe(generated);
  });
});

// ---------------------------------------------------------------------------
// shouldOverwriteScript
// ---------------------------------------------------------------------------

describe("shouldOverwriteScript", () => {
  it("returns true when hash matches (file unmodified)", () => {
    const content = "#!/bin/bash\necho hello\n";
    const hash = hashContent(content);
    expect(shouldOverwriteScript(content, hash)).toBe(true);
  });

  it("returns false when hash differs (user edited)", () => {
    const original = "#!/bin/bash\necho hello\n";
    const hash = hashContent(original);
    const edited = "#!/bin/bash\necho hello world\n";
    expect(shouldOverwriteScript(edited, hash)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// computeIncrementalPlan
// ---------------------------------------------------------------------------

describe("computeIncrementalPlan", () => {
  it("marks all files as CREATE when no manifest exists", () => {
    const files: GeneratedFile[] = [
      { path: "a.md", content: "aaa", category: "machine" },
      { path: "b.md", content: "bbb", category: "agent" },
    ];
    const actions = computeIncrementalPlan(tmpDir, "claude-code", files, null);
    expect(actions).toHaveLength(2);
    expect(actions.every((a) => a.type === "create")).toBe(true);
  });

  it("marks existing machine file as UPDATE when content changes", () => {
    // Write a file to disk
    const filePath = path.join(tmpDir, "config.json");
    fs.writeFileSync(filePath, '{"old": true}', "utf-8");

    const manifest: ScaffoldManifest = {
      source: "t.at", sourceHash: "x", target: "claude-code",
      generatedAt: "", files: { "config.json": { hash: hashContent('{"old": true}'), category: "machine" } },
    };

    const files: GeneratedFile[] = [
      { path: "config.json", content: '{"new": true}', category: "machine" },
    ];

    const actions = computeIncrementalPlan(tmpDir, "claude-code", files, manifest);
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe("update");
  });

  it("marks existing machine file as UNCHANGED when content is the same", () => {
    const content = '{"same": true}';
    const filePath = path.join(tmpDir, "config.json");
    fs.writeFileSync(filePath, content, "utf-8");

    const manifest: ScaffoldManifest = {
      source: "t.at", sourceHash: "x", target: "claude-code",
      generatedAt: "", files: { "config.json": { hash: hashContent(content), category: "machine" } },
    };

    const files: GeneratedFile[] = [
      { path: "config.json", content, category: "machine" },
    ];

    const actions = computeIncrementalPlan(tmpDir, "claude-code", files, manifest);
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe("unchanged");
  });

  it("marks existing agent file as UPDATE with merge", () => {
    const existingContent = "# Agent\n\n## Instructions\n\nUser prompt.\n\n## Tools\n\n- old\n";
    const agentDir = path.join(tmpDir, "agents");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "AGENT.md"), existingContent, "utf-8");

    const manifest: ScaffoldManifest = {
      source: "t.at", sourceHash: "x", target: "claude-code",
      generatedAt: "", files: { "agents/AGENT.md": { hash: hashContent(existingContent), category: "agent" } },
    };

    const generated: GeneratedFile[] = [
      {
        path: "agents/AGENT.md",
        content: "# Agent\n\n## Instructions\n\nDefault.\n\n## Tools\n\n- new_tool\n",
        category: "agent",
      },
    ];

    const actions = computeIncrementalPlan(tmpDir, "claude-code", generated, manifest);
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe("update");
    if (actions[0].type === "update") {
      expect(actions[0].content).toContain("User prompt.");
      expect(actions[0].content).not.toContain("Default.");
    }
  });

  it("marks unmodified script as UPDATE when new content differs", () => {
    const originalScript = "#!/bin/bash\necho v1\n";
    fs.writeFileSync(path.join(tmpDir, "gate.sh"), originalScript, "utf-8");

    const manifest: ScaffoldManifest = {
      source: "t.at", sourceHash: "x", target: "claude-code",
      generatedAt: "", files: { "gate.sh": { hash: hashContent(originalScript), category: "script" } },
    };

    const files: GeneratedFile[] = [
      { path: "gate.sh", content: "#!/bin/bash\necho v2\n", category: "script" },
    ];

    const actions = computeIncrementalPlan(tmpDir, "claude-code", files, manifest);
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe("update");
  });

  it("marks user-edited script as CONFLICT", () => {
    const originalScript = "#!/bin/bash\necho v1\n";
    const editedScript = "#!/bin/bash\necho custom\n";
    fs.writeFileSync(path.join(tmpDir, "gate.sh"), editedScript, "utf-8");

    const manifest: ScaffoldManifest = {
      source: "t.at", sourceHash: "x", target: "claude-code",
      generatedAt: "", files: { "gate.sh": { hash: hashContent(originalScript), category: "script" } },
    };

    const files: GeneratedFile[] = [
      { path: "gate.sh", content: "#!/bin/bash\necho v2\n", category: "script" },
    ];

    const actions = computeIncrementalPlan(tmpDir, "claude-code", files, manifest);
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe("conflict");
  });

  it("marks file in manifest but not generated as DELETE", () => {
    const manifest: ScaffoldManifest = {
      source: "t.at", sourceHash: "x", target: "claude-code",
      generatedAt: "", files: {
        "keep.md": { hash: "abc", category: "machine" },
        "removed.md": { hash: "def", category: "machine" },
      },
    };

    const content = "kept";
    fs.writeFileSync(path.join(tmpDir, "keep.md"), content, "utf-8");

    const files: GeneratedFile[] = [
      { path: "keep.md", content, category: "machine" },
    ];

    const actions = computeIncrementalPlan(tmpDir, "claude-code", files, manifest);
    const deleteAction = actions.find((a) => a.type === "delete");
    expect(deleteAction).toBeDefined();
    expect(deleteAction!.path).toBe("removed.md");
  });
});

// ---------------------------------------------------------------------------
// executeActions
// ---------------------------------------------------------------------------

describe("executeActions", () => {
  it("creates files on disk", () => {
    const actions = [
      { type: "create" as const, path: "sub/new.txt", content: "hello" },
    ];
    const result = executeActions(tmpDir, actions, { prune: false, force: false });
    expect(result.created).toBe(1);
    expect(fs.readFileSync(path.join(tmpDir, "sub/new.txt"), "utf-8")).toBe("hello");
  });

  it("updates files on disk", () => {
    fs.writeFileSync(path.join(tmpDir, "file.txt"), "old", "utf-8");
    const actions = [
      { type: "update" as const, path: "file.txt", content: "new", detail: "updated" },
    ];
    const result = executeActions(tmpDir, actions, { prune: false, force: false });
    expect(result.updated).toBe(1);
    expect(fs.readFileSync(path.join(tmpDir, "file.txt"), "utf-8")).toBe("new");
  });

  it("deletes files only with prune=true", () => {
    fs.writeFileSync(path.join(tmpDir, "doomed.txt"), "bye", "utf-8");
    const actions = [{ type: "delete" as const, path: "doomed.txt" }];

    // Without prune — file stays
    const result1 = executeActions(tmpDir, actions, { prune: false, force: false });
    expect(result1.deleted).toBe(1); // counted but not actually removed
    expect(fs.existsSync(path.join(tmpDir, "doomed.txt"))).toBe(true);

    // With prune — file removed
    const result2 = executeActions(tmpDir, actions, { prune: true, force: false });
    expect(result2.deleted).toBe(1);
    expect(fs.existsSync(path.join(tmpDir, "doomed.txt"))).toBe(false);
  });

  it("skips conflicts unless force=true", () => {
    fs.writeFileSync(path.join(tmpDir, "script.sh"), "user version", "utf-8");
    const actions = [
      { type: "conflict" as const, path: "script.sh", content: "generated version", detail: "user edited" },
    ];

    // Without force — conflict preserved
    const result1 = executeActions(tmpDir, actions, { prune: false, force: false });
    expect(result1.conflicts).toBe(1);
    expect(fs.readFileSync(path.join(tmpDir, "script.sh"), "utf-8")).toBe("user version");

    // With force — overwritten
    const result2 = executeActions(tmpDir, actions, { prune: false, force: true });
    expect(result2.conflicts).toBe(1);
    expect(fs.readFileSync(path.join(tmpDir, "script.sh"), "utf-8")).toBe("generated version");
  });

  it("counts unchanged actions without modifying anything", () => {
    const actions = [{ type: "unchanged" as const, path: "stable.txt" }];
    const result = executeActions(tmpDir, actions, { prune: false, force: false });
    expect(result.unchanged).toBe(1);
  });
});
