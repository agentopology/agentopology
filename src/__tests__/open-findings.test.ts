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
  it.todo("[N12] A skill `prompt: \"path\"` emits `See: path`; the instructions never reach Claude");
  it.todo("[A3] `kind: external` actions ignore `commands:` and emit a TODO stub");
  it.todo("[A3b] Tools with a real `script:` get stub copies");
  it.todo("[B4] Schedule scripts call the wrong action path; `every:` becomes a commented-out cron line");
  it.todo("[H1] Human nodes compile to frontmatter-less AGENT.md files that Claude Code ignores; they should be an approval step");
  it.todo("[N4] `.mcp.json` drops `type`, so a url server is skipped");
  it.todo("[N5] `type: prompt` hooks are emitted as commands");
  it.todo("[N6] Universal events (AgentStop, ToolUse, Error) are emitted unmapped, so the hook never fires");
  it.todo("[N7] MCP tool names: whole-server and dotted names mis-converted; permissions not converted");
  it.todo("[N8] V27 accepts `confirm` and `bypass`, emitted as invalid `permissionMode`");
  it.todo("[N9] A hook matcher with a regex breaks the agent file's YAML");
  it.todo("[N10] `invocation: manual` drops the description, so the agent is not registered");
  it.todo("[N14] `settings.ask` is parsed but never emitted");
  it.todo("[N16] Model ids are not checked per target");
  it.todo("[N17] Unquoted YAML scalars change type (`yes` becomes `true`)");
  it.todo("[N18] No reference checks for `skills:`, `mcp-servers:`, skill `agent:`");
  it.todo("[N19] Hook stubs carry the date, so output is not byte-stable");
  it.todo("[C1] `scaffold --dry-run` says settings.json and .mcp.json would be \"config merged\" but does not show the diff (content session, 2026-10-29)");
  it.todo("[C2] Scaffold adds `.claude/CLAUDE.md`, which competes with a project's root CLAUDE.md (content session, 2026-10-29)");
  it.todo("[C3] Run-line parsing takes placeholders and file arguments as scripts (`SLUG`, `frames-critic.json`) and plans stubs for them (content session, 2026-10-29)");
  it.todo("[C4] A gate whose `after:` is an action or a human compiles to no enforceable hook (10 gates in content-harness)");
  it.todo("[B5] An agent's permissions read as per-agent grants; Claude Code allow rules are session-wide");
  it.todo("[F1] Missing first-class fields: agent effort, initialPrompt, omitClaudeMd, cache TTL, color; skill when_to_use, arguments, paths, shell");
  it.todo("[F2] Hooks as a typed union (http, mcp_tool, agent; once, async, if)");
});
