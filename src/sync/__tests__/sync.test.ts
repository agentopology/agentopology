/**
 * Tests for the sync-back module's Claude Code prompt extraction.
 *
 * Covers the flat `agents/<id>.md` layout and the frontmatter-stripping
 * fallback used for hand-authored files that carry no `## Instructions`
 * section — content our own scaffold always produces, but imported configs
 * do not.
 */

import { describe, it, expect } from "vitest";
import { syncFromPlatform } from "../index.js";
import type { PlatformFile } from "../index.js";

const AT_SOURCE = `
topology test : [pipeline] {
  agent worker {
    model: sonnet
    prompt {
      old prompt
    }
  }
}
`;

describe("syncFromPlatform — claude-code", () => {
  it("extracts from the nested agents/<id>/AGENT.md layout our scaffold emits", () => {
    const files: PlatformFile[] = [
      {
        path: ".claude/agents/worker/AGENT.md",
        content: `---\nname: worker\n---\n\n## Instructions\n\nNested layout prompt.\n\n## Role\n\nsomething\n`,
      },
    ];

    const result = syncFromPlatform(AT_SOURCE, files, "claude-code");
    expect(result).toContain("Nested layout prompt.");
  });

  it("extracts from the flat agents/<id>.md layout hand-authored configs use", () => {
    const files: PlatformFile[] = [
      {
        path: "agents/worker.md",
        content: `---\nname: worker\n---\n\n## Instructions\n\nFlat layout prompt.\n\n## Role\n\nsomething\n`,
      },
    ];

    const result = syncFromPlatform(AT_SOURCE, files, "claude-code");
    expect(result).toContain("Flat layout prompt.");
  });

  it("falls back to the whole body when a flat file has no ## Instructions heading", () => {
    const files: PlatformFile[] = [
      {
        path: "agents/worker.md",
        content: `---\nname: worker\ndescription: a frontmatter-only field\n---\n\nJust write the whole body back.\n`,
      },
    ];

    const result = syncFromPlatform(AT_SOURCE, files, "claude-code");
    expect(result).toContain("Just write the whole body back.");
    // The frontmatter itself must not leak into the prompt block.
    expect(result).not.toContain("frontmatter-only field");
  });

  it("does not match a flat file outside the agents/ directory", () => {
    const files: PlatformFile[] = [
      { path: "skills/worker.md", content: `## Instructions\n\nShould not sync.\n` },
    ];

    const result = syncFromPlatform(AT_SOURCE, files, "claude-code");
    expect(result).not.toContain("Should not sync.");
    expect(result).toContain("old prompt");
  });

  it("handles the nested and flat layouts for different agents in one project", () => {
    const nestedAt = `
topology test : [pipeline] {
  agent worker {
    model: sonnet
    prompt { old worker prompt }
  }
  agent helper {
    model: sonnet
    prompt { old helper prompt }
  }
}
`;
    const files: PlatformFile[] = [
      { path: "agents/worker/AGENT.md", content: `## Instructions\n\nNested prompt.\n` },
      { path: "agents/helper.md", content: `## Instructions\n\nFlat prompt.\n` },
    ];

    const result = syncFromPlatform(nestedAt, files, "claude-code");
    expect(result).toContain("Nested prompt.");
    expect(result).toContain("Flat prompt.");
  });
});
