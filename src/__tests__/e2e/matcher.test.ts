/**
 * Hook matchers, read the way Claude Code reads them (N36), and the two hook
 * findings that ride with them (N29, N30).
 *
 * From https://code.claude.com/docs/en/hooks.md (checked 2026-11-10 against
 * the raw page): a matcher of only letters, digits, `_`, `-`, spaces, `,` and
 * `|` is an exact name or a list of names; anything else is a JavaScript
 * regex, unanchored. `*`, `""` and no matcher match all. MCP tools are named
 * `mcp__<server>__<tool>`, so `mcp__memory` (exact) matches no tool. An
 * argument filter goes in the handler's `if` (permission-rule syntax, tool
 * events only; on any other event the hook never runs). Only exit 2 blocks.
 */

import { describe, it, expect } from "vitest";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { serializeAST } from "../../import/serializer.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import { matcherMatches } from "../../conformance/claude-code.js";
import { matcherGaps } from "../../inventory/index.js";

const topology = (hooks: string, agentExtra = "") => `topology probe : [pipeline] {
  meta {
    version: "1.0.0"
    description: "Matcher probe"
  }

  orchestrator {
    model: sonnet
  }

  agent writer {
    model: sonnet
    description: "Writes the post"
    tools: [Read, mcp.chrome.file_upload, mcp.chrome.upload_image, mcp.chrome.browser_batch]
${agentExtra}    prompt {
      Write the post.
    }
  }

  flow {
    writer -> writer [max 1]
  }

  hooks {
${hooks}  }
}
`;
const hook = (name: string, fields: string) => `    hook ${name} {\n${fields.split("\n").map((l) => `      ${l}`).join("\n")}\n    }\n`;
const rules = (src: string, rule: string, level?: "error" | "warning") =>
  validate(parse(src)).filter((r) => r.rule === rule && (!level || r.level === level));
const files = (src: string) => claudeCodeBinding.scaffold(parse(src));
const settingsOf = (src: string) => JSON.parse(files(src).find((f) => f.path === ".claude/settings.json")!.content);

describe("a matcher is read the way Claude Code reads it", () => {
  it("[N36] exact names and lists, unanchored regexes, match-all", () => {
    expect(matcherMatches("PreToolUse", "Bash", "Bash")).toBe(true);
    expect(matcherMatches("PreToolUse", "Bash", "BashOutput")).toBe(false);
    expect(matcherMatches("PreToolUse", "Edit|Write", "Write")).toBe(true);
    expect(matcherMatches("PreToolUse", "Edit, Write", "Edit")).toBe(true);
    expect(matcherMatches("SubagentStop", "code-reviewer", "code-reviewer")).toBe(true);
    expect(matcherMatches("PreToolUse", "^Notebook", "NotebookEdit")).toBe(true);
    expect(matcherMatches("PreToolUse", "Edit.*", "NotebookEdit")).toBe(true);
    expect(matcherMatches("PreToolUse", "^Edit$", "NotebookEdit")).toBe(false);
    expect(matcherMatches("PreToolUse", "*", "anything")).toBe(true);
    expect(matcherMatches("PreToolUse", "", "anything")).toBe(true);
  });

  it("[N36] MCP: the server prefix alone matches no tool; with .* it matches every tool on it", () => {
    expect(matcherMatches("PreToolUse", "mcp__memory", "mcp__memory__create_entities")).toBe(false);
    expect(matcherMatches("PreToolUse", "mcp__memory__.*", "mcp__memory__create_entities")).toBe(true);
  });

  it("[N36] on FileChanged and StopFailure a hyphen keeps the matcher on the regex path", () => {
    expect(matcherMatches("FileChanged", "a-b", "xa-by")).toBe(true);
    expect(matcherMatches("PreToolUse", "a-b", "xa-by")).toBe(false);
  });
});

describe("V107: a matcher that can never match is an error", () => {
  it("[N30] permission-rule syntax in a matcher never matches a tool name; the filter belongs in if:", () => {
    const e = rules(topology(hook("guard", 'on: PreToolUse\nmatcher: "Bash(rm -rf *)"\nrun: "scripts/guard.sh"')), "V107", "error");
    expect(e).toHaveLength(1);
    expect(e[0].message).toMatch(/matcher: "Bash".*if: "Bash\(rm -rf \*\)"/);
  });

  it("[N36] the .at's dotted mcp form is not a tool name; the server prefix alone matches nothing", () => {
    const dotted = rules(topology(hook("lock", 'on: PreToolUse\nmatcher: "mcp.chrome.*"\nrun: "scripts/lock.sh"')), "V107", "error");
    expect(dotted[0]?.message).toContain("mcp__chrome__.*");
    const bare = rules(topology(hook("lock", 'on: PreToolUse\nmatcher: "mcp__chrome"\nrun: "scripts/lock.sh"')), "V107", "error");
    expect(bare[0]?.message).toContain("mcp__chrome__.*");
  });

  it("[N36] a matcher that is not a valid regex is an error; agent-level hooks are checked too", () => {
    expect(rules(topology(hook("bad", 'on: PreToolUse\nmatcher: "Edit|(Write"\nrun: "scripts/x.sh"')), "V107", "error")).toHaveLength(1);
    const agentHook = `    hooks {\n      hook lint {\n        on: PostToolUse\n        matcher: "Write(*.md)"\n        run: "scripts/lint.sh"\n      }\n    }\n`;
    expect(rules(topology(hook("ok", 'on: PreToolUse\nmatcher: "Bash"\nrun: "scripts/x.sh"'), agentHook), "V107", "error")).toHaveLength(1);
  });

  it("[N36] good matchers pass", () => {
    const src = topology(
      hook("a", 'on: PreToolUse\nmatcher: "Bash"\nrun: "scripts/a.sh"') +
      hook("b", 'on: PreToolUse\nmatcher: "mcp__chrome__.*"\nrun: "scripts/b.sh"') +
      hook("c", 'on: PostToolUse\nmatcher: "Edit|Write"\nrun: "scripts/c.sh"'),
    );
    expect(rules(src, "V107")).toEqual([]);
  });
});

describe("if: filters on the tool's arguments", () => {
  const src = topology(hook("guard", 'on: PreToolUse\nmatcher: "Bash"\nif: "Bash(rm -rf *)"\nrun: "scripts/guard.sh"'));

  it("[N30] if: is read, round-trips, and is written on the settings.json handler", () => {
    expect(parse(src).hooks[0]).toMatchObject({ matcher: "Bash", if: "Bash(rm -rf *)" });
    expect(parse(serializeAST(parse(src))).hooks).toEqual(parse(src).hooks);
    const entry = settingsOf(src).hooks.PreToolUse.find((e: any) => e.matcher === "Bash");
    expect(entry.hooks[0].if).toBe("Bash(rm -rf *)");
    expect(validate(parse(src)).filter((r) => r.level === "error")).toEqual([]);
  });

  it("[N30] if: on an event that is not a tool event is an error: the hook would never run", () => {
    const e = rules(topology(hook("g", 'on: Stop\nif: "Bash(rm *)"\nrun: "scripts/g.sh"')), "V107", "error");
    expect(e[0]?.message).toMatch(/never runs/);
  });
});

describe("a run: that is a shell command, not a script", () => {
  it("[N29] run: \"exit 2\" is written as the command itself, with no stub script named after exit", () => {
    const out = files(topology(hook("block", 'on: PreToolUse\nmatcher: "Bash"\nrun: "exit 2"')));
    expect(out.some((f) => /\/exit$/.test(f.path))).toBe(false);
    const s = JSON.parse(out.find((f) => f.path === ".claude/settings.json")!.content);
    expect(s.hooks.PreToolUse[0].hooks[0].command).toBe("exit 2");
  });

  it("[N29] V108: exit 1 (or any code but 0 and 2) does not block; it is a warning", () => {
    const w = rules(topology(hook("block", 'on: PreToolUse\nmatcher: "Bash"\nrun: "exit 1"')), "V108", "warning");
    expect(w[0]?.message).toMatch(/only exit 2 blocks/);
    expect(rules(topology(hook("block", 'on: PreToolUse\nmatcher: "Bash"\nrun: "exit 2"')), "V108")).toEqual([]);
  });
});

describe("V109: a refuse hook that misses a tool its server offers", () => {
  const lock = (matcher: string, strength = "strength: refuse\n") =>
    topology(hook("lock-chrome", `on: PreToolUse\nmatcher: "${matcher}"\nrun: "scripts/lock.sh"\n${strength}`.trimEnd()));

  it("[N36] lock-chrome covers file_upload and browser_batch but not upload_image: named as a gap", () => {
    const src = lock("mcp__chrome__(file_upload|browser_batch)");
    const w = rules(src, "V109", "warning");
    expect(w).toHaveLength(1);
    expect(w[0].message).toContain("mcp__chrome__upload_image");
    expect(w[0].message).toContain("lock-chrome");
    expect(matcherGaps(parse(src))).toEqual([{ hook: "lock-chrome", server: "chrome", tool: "mcp__chrome__upload_image" }]);
  });

  it("[N36] a matcher that covers the server has no gap; a hook that declares no refuse is not held to it", () => {
    expect(rules(lock("mcp__chrome__.*"), "V109")).toEqual([]);
    expect(rules(lock("mcp__chrome__(file_upload|browser_batch)", ""), "V109")).toEqual([]);
  });

  it("[N36] tool names the inventory lists count too", () => {
    const ast = parse(lock("mcp__chrome__.*").replace("mcp.chrome.upload_image, ", ""));
    const gaps = matcherGaps(parse(lock("mcp__chrome__file_upload")), ["mcp__chrome__navigate"]);
    expect(gaps.map((g) => g.tool)).toEqual(expect.arrayContaining(["mcp__chrome__navigate", "mcp__chrome__upload_image", "mcp__chrome__browser_batch"]));
    expect(matcherGaps(ast, ["mcp__chrome__navigate"])).toEqual([]);
  });
});
