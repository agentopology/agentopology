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
  it.todo("[N11] sync pulls generated prose back into the .at, so the prompt grows each cycle");
  it.todo("[N16] Model ids are not checked per target");
  it.todo("[N18] No reference checks for `skills:`, `mcp-servers:`, skill `agent:`");
  it.todo("[N21] A `gate` written outside a `gates {}` block is dropped without a warning, and validate passes");
  it.todo("[B5] An agent's permissions read as per-agent grants; Claude Code allow rules are session-wide");
  it.todo("[F1] Missing first-class fields: agent effort, initialPrompt, omitClaudeMd, cache TTL, color; skill when_to_use, arguments, paths, shell");
  it.todo("[F2] Hooks as a typed union (http, mcp_tool, agent; once, async, if)");
});
