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
  it.todo("[I4] V14 refuses an agent with both `tools` and `disallowed-tools`, but Claude Code accepts both, so an honest import of such a hand-built agent has validation errors");
  it.todo("[B3] Agent teams (peers that message each other) have no node or edge type; experimental in Claude Code, interactive sessions only");
  it.todo("[B7] The `observability { }` block is ignored by the claude-code binding");
  it.todo("[N22] Subagent nesting depth (Claude Code: 3) and fan-out (20 at once) are not checked");
  it.todo("[F4] Agent `memory` scope (user/project/local) and `autoCompactWindow` are not first-class; `memory:` already names stores, so the scope needs another word");
  it.todo("[N25] An agent's `role:` is documented but never read; the role text comes only from the roles block by agent id");
  it.todo("[N26] V102 does not look inside free-form or not-yet-listed blocks (prompt, extensions, settings, env, memory, providers, mcp-servers, interfaces, triggers, depth, flow, ...)");
  it.todo("[N35] A second top-level `hooks { }` block is dropped silently: only the first block's hooks are parsed and nothing warns");
});
