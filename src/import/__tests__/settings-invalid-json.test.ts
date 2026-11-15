/**
 * A `.claude/settings.json` that is not valid JSON used to make `import` throw.
 * The import now goes on without settings and hooks and says so in one warning.
 */

import { describe, it, expect } from "vitest";
import { importClaudeCodeWithReport } from "../index.js";
import { parse } from "../../parser/index.js";
import type { PlatformFile } from "../../sync/index.js";

const files = (settings: string): PlatformFile[] => [
  { path: ".claude/agents/worker.md", content: "---\nname: worker\ndescription: Does the work\nmodel: sonnet\n---\n\nYou do the work.\n" },
  { path: ".claude/skills/notes/SKILL.md", content: "---\nname: notes\ndescription: Take notes\n---\n\nTake notes.\n" },
  { path: ".claude/settings.json", content: settings },
];

describe("import with a settings.json that is not JSON", () => {
  it("imports agents and skills, drops settings and hooks, and warns once with the line", () => {
    const { source, report } = importClaudeCodeWithReport(files('{\n  "permissions": { "allow": ["Read"] },\n}\n'), "t");
    const ast = parse(source);
    expect(ast.nodes.map((n) => n.id)).toContain("worker");
    expect(ast.skills.map((s) => s.id)).toContain("notes");
    expect(ast.hooks ?? []).toEqual([]);
    const warnings = report.warnings ?? [];
    const invalid = warnings.filter((w) => w.startsWith("settings.invalid-json:"));
    expect(invalid).toHaveLength(1);
    expect(invalid[0]).toContain(".claude/settings.json line 3:");
    expect(invalid[0]).toContain("settings and hooks not imported");
    expect(source).toContain("Import warning: settings.invalid-json: .claude/settings.json line 3:");
  });

  it("leaves out the line when the parser message gives none", () => {
    const { report } = importClaudeCodeWithReport(files(""), "t");
    const invalid = (report.warnings ?? []).filter((w) => w.startsWith("settings.invalid-json:"));
    expect(invalid).toHaveLength(1);
    expect(invalid[0]).toMatch(/^settings\.invalid-json: \.claude\/settings\.json: /);
  });

  it("a valid settings.json gives no such warning", () => {
    const { report } = importClaudeCodeWithReport(files('{"permissions":{"allow":["Read"]}}'), "t");
    expect((report.warnings ?? []).some((w) => w.startsWith("settings.invalid-json"))).toBe(false);
  });
});
