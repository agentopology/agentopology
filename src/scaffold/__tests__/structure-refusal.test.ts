/**
 * When the writer cannot read what it would write, it refuses the file and
 * says which key and why; it never returns "nothing to do".
 */

import { describe, it, expect } from "vitest";
import { planStructurePatch } from "../structure.js";
import type { StructureSpec } from "../../bindings/types.js";

const spec = (content: string): StructureSpec => ({
  path: ".claude/skills/helper/SKILL.md",
  kind: "skill",
  id: "helper",
  content,
  owned: ["description", "paths"],
  authored: false,
});

describe("a structure the writer cannot read is refused out loud", () => {
  it("an unreadable list item in what the .at states blocks the file, naming the key and the reason", () => {
    const action = planStructurePatch(
      spec("---\nname: helper\ndescription: Helps\npaths:\n  - *.ts\n---\n"),
      "---\nname: helper\ndescription: mine\n---\n\nBODY\n",
      undefined,
      false,
    );
    expect(action.type).toBe("blocked");
    if (action.type !== "blocked") return;
    expect(action.detail).toContain('"paths"');
    expect(action.detail).toContain("anchor or alias");
  });
});
