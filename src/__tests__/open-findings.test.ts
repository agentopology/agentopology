/**
 * What the suite does NOT yet guarantee — visible in every run.
 *
 * Each todo is an open finding from spec/testing.md, under the same id. When
 * one is fixed, replace its todo with a real test (keeping the id in the name)
 * and move the row to Guarantees. spec-testing-sync.test.ts keeps the two
 * lists in step.
 */

import { describe, it } from "vitest";

describe("open findings (spec/testing.md)", () => {
  it.todo("[B3] Agent teams (peers that message each other) have no node or edge type; experimental in Claude Code, interactive sessions only");
  it.todo("[B7] The `observability { }` block is ignored by the claude-code binding");
  it.todo("[N22] Subagent nesting depth (Claude Code: 3) and fan-out (20 at once) are not checked");
  it.todo("[F4] Agent `memory` scope (user/project/local) and `autoCompactWindow` are not first-class; `memory:` already names stores, so the scope needs another word");
});
