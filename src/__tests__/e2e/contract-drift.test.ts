/**
 * Claude Code's hook contract as a committed snapshot (N37).
 *
 * spec/claude-code/hooks-contract.json is extracted from the hooks reference
 * page by scripts/claude-code-drift.mjs; the minimum version's contract
 * (hooks-contract.2.1.295.json) is derived from it by dropping what requires a
 * newer version. These tests are offline: they hold the code to the snapshot,
 * and the script holds the snapshot to the live page.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import {
  HOOK_EVENTS, NO_MATCHER_EVENTS, HANDLER_REQUIRED, ON_FAILURE_TYPES, VERIFIED_ON, MINIMUM_VERSION,
  ON_FAILURE_SINCE, ON_FAILURE_CASES, preToolUseOutcome,
} from "../../conformance/claude-code.js";
import { extractHookContract, contractAt, diffContracts, hasDrift, renderDiff, type HookContract } from "../../conformance/extract.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const read = (p: string): HookContract => JSON.parse(fs.readFileSync(join(repo, p), "utf8"));
const current = read("spec/claude-code/hooks-contract.json");
const minimum = read(`spec/claude-code/hooks-contract.${MINIMUM_VERSION}.json`);
const fieldsOf = (c: HookContract, type: string) => ({ ...c.fields.common, ...c.fields[type === "agent" ? "prompt" : type] });

describe("the code agrees with the snapshot", () => {
  it("[N37] [SD1] the event list, the no-matcher events, the handler types and onFailure match the snapshot", () => {
    expect([...HOOK_EVENTS].sort()).toEqual([...current.events].sort());
    expect([...NO_MATCHER_EVENTS].sort()).toEqual(current.noMatcherEvents);
    expect(Object.keys(HANDLER_REQUIRED).sort()).toEqual([...current.handlerTypes].sort());
    for (const type of current.handlerTypes) {
      const required = Object.entries(fieldsOf(current, type)).filter(([n, f]) => f.required && n !== "type").map(([n]) => n);
      expect([...HANDLER_REQUIRED[type]].sort(), type).toEqual(required.sort());
    }
    const withOnFailure = current.handlerTypes.filter((t) => "onFailure" in fieldsOf(current, t));
    expect([...ON_FAILURE_TYPES].sort()).toEqual(withOnFailure.sort());
  });

  it("[N37] [SD2] the snapshot is of the verified version; the minimum's is derived from it at MINIMUM_VERSION", () => {
    expect(current.claudeCode).toBe(VERIFIED_ON);
    expect(minimum).toEqual(contractAt(current, MINIMUM_VERSION));
    expect(minimum).toMatchObject({ derived: true, claudeCode: MINIMUM_VERSION });
  });

  it("[N37] [SD3] everything the binding writes exists at the minimum version: every event, every handler field", () => {
    const files = [
      ...fs.readdirSync(join(repo, "examples")).filter((f) => f.endsWith(".at")).map((f) => join(repo, "examples", f)),
      ...["compile.at", "hazards.at"].map((f) => join(here, "fixtures", f)),
      join(repo, "kitchen-sink.at"),
    ];
    const problems: string[] = [];
    for (const file of files) {
      const out = claudeCodeBinding.scaffold(parse(fs.readFileSync(file, "utf8")));
      const settings = out.find((f) => f.path === ".claude/settings.json");
      if (!settings) continue;
      for (const [event, entries] of Object.entries(JSON.parse(settings.content).hooks ?? {})) {
        if (!minimum.events.includes(event)) problems.push(`${file}: event ${event}`);
        for (const entry of entries as Array<Record<string, any>>) {
          for (const h of entry.hooks ?? []) {
            const allowed = fieldsOf(minimum, h.type);
            for (const key of Object.keys(h)) if (!(key in allowed)) problems.push(`${file}: ${event} ${h.type}.${key}`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });
});

const PAGE = `# Hooks reference

### Matcher patterns

| Matcher value | Evaluated as | Example |
| :- | :- | :- |
| \`"*"\` | Match all | every |
| Only letters | Exact string | \`Bash\` |

| Event | What the matcher filters | Example matcher values |
| :- | :- | :- |
| \`PreToolUse\` | tool name | \`Bash\` |
| \`Stop\`, \`Ping\` | no matcher support | always fires |

#### Common fields

| Field | Required | Description |
| :- | :- | :- |
| \`type\` | yes | \`"command"\` or \`"http"\` |
| \`timeout\` | no | Seconds |

#### Command hook fields

| Field | Required | Description |
| :- | :- | :- |
| \`command\` | yes | Shell command |
| \`onFailure\` | no | Block or continue. Requires Claude Code v2.1.295 or later |

## Hook input and output

### Exit code output

| Stdout | Exit 0 | Exit 2 | Any other exit code |
| :- | :- | :- | :- |
| JSON object that passes [schema validation](#json-output) | Success | Blocking error | Success. The fields alone decide |
| [Plain text](#exit-code-0), or nothing | Success | Blocking error | Non-blocking error |

#### Other exit codes

> [!WARNING]
>
> Exit code 1 without valid JSON output is a non-blocking error.

#### Block the action when a hook fails

Each of these counts as a failure:

* **Can't start**: a command hook fails to start
* **Exit code other than 0 or 2**: counts even if it printed JSON that allows the action
* **Timeout**: the hook reaches its [\`timeout\`](#common-fields)

With \`"block"\` set, a failure does what exit code 2 does on that event.

The field has no effect on these hooks:

* **Background command hooks**: command hooks that set \`async\`

## Hook events

### PreToolUse

\`\`\`bash
#!/bin/bash
# a comment in an example, not a heading
\`\`\`

### Ping

Ping requires Claude Code v2.1.400 or later.

### Stop

## Debug hooks
`;
const meta = { source: "test", fetched: "2026-11-10", claudeCode: "2.1.319" };

describe("the extractor and the diff", () => {
  it("[S-32] [SD7] the onFailure facts: each failure case, the block rule, where it has no effect, the exit table, the exit-1 warning, with their lines", () => {
    const c = extractHookContract(PAGE, meta);
    const lines = PAGE.split("\n");
    expect(c.onFailure!.requires).toBe("2.1.295");
    expect(Object.keys(c.onFailure!.failures)).toEqual(["cant-start", "exit-code-other-than-0-or-2", "timeout"]);
    const exitCode = c.onFailure!.failures["exit-code-other-than-0-or-2"];
    expect(exitCode.quote).toBe("**Exit code other than 0 or 2**: counts even if it printed JSON that allows the action");
    expect(lines[exitCode.line - 1]).toBe(`* ${exitCode.quote}`);
    expect(c.onFailure!.block.quote).toBe('With `"block"` set, a failure does what exit code 2 does on that event.');
    expect(Object.keys(c.onFailure!.noEffect)).toEqual(["background-command-hooks"]);
    expect(Object.keys(c.onFailure!.exitTable)).toEqual(["json-object-that-passes-schema-validation", "plain-text-or-nothing"]);
    expect(c.onFailure!.exitTable["plain-text-or-nothing"].quote).toBe("| [Plain text](#exit-code-0), or nothing | Success | Blocking error | Non-blocking error |");
    expect(c.onFailure!.exit1.quote).toBe("Exit code 1 without valid JSON output is a non-blocking error.");
    expect(lines[c.onFailure!.exit1.line - 1]).toBe(`> ${c.onFailure!.exit1.quote}`);
  });

  it("[S-32] [SD8] below the version onFailure needs, the contract has no onFailure facts", () => {
    const c = extractHookContract(PAGE, meta);
    expect(contractAt(c, "2.1.295").onFailure).toEqual(c.onFailure);
    expect(contractAt(c, "2.1.290").onFailure).toBeUndefined();
  });

  it("[S-32] [SD9] a reworded failure case is drift; a fact that only moved lines is not", () => {
    const before = extractHookContract(PAGE, meta);
    const moved = extractHookContract(PAGE.replace("## Hook input and output", "## Hook input and output\n\nA new paragraph.\n"), meta);
    expect(hasDrift(diffContracts(before, moved))).toBe(false);
    const reworded = extractHookContract(PAGE.replace("counts even if it printed JSON that allows the action", "counts unless it printed JSON"), meta);
    const d = diffContracts(before, reworded);
    expect(d.onFailureChanged).toEqual(["failures.exit-code-other-than-0-or-2"]);
    expect(renderDiff(d).join("\n")).toMatch(/onFailure facts changed \(1\): failures\.exit-code-other-than-0-or-2/);
  });
  it("[N37] [SD4] events, their versions, the no-matcher events, handler fields; a # comment in a code block is not a heading", () => {
    const c = extractHookContract(PAGE, meta);
    expect(c.events).toEqual(["PreToolUse", "Ping", "Stop"]);
    expect(c.eventRequires).toEqual({ Ping: "2.1.400" });
    expect(c.noMatcherEvents).toEqual(["Ping", "Stop"]);
    expect(c.handlerTypes).toEqual(["command", "http"]);
    expect(c.fields.command).toEqual({ command: { required: true }, onFailure: { required: false, requires: "2.1.295" } });
    expect(c.matcherRules).toHaveLength(2);
  });

  it("[N37] [SD5] the contract at an older version drops what needs a newer one", () => {
    const c = extractHookContract(PAGE, meta);
    expect(contractAt(c, "2.1.300").events).toEqual(["PreToolUse", "Stop"]);
    expect(Object.keys(contractAt(c, "2.1.290").fields.command)).toEqual(["command"]);
  });

  it("[N37] [SD6] a diff names what moved, and the same page has none", () => {
    const before = extractHookContract(PAGE, meta);
    expect(hasDrift(diffContracts(before, before))).toBe(false);
    expect(renderDiff(diffContracts(before, before))).toEqual(["no drift"]);
    const page = PAGE.replace("### Stop", "### Stop\n\n### Wake").replace("v2.1.295", "v2.1.300").replace("| `timeout` | no | Seconds |\n", "");
    const d = diffContracts(before, extractHookContract(page, meta));
    expect(d.eventsAdded).toEqual(["Wake"]);
    expect(d.fieldsRemoved).toEqual(["common.timeout"]);
    expect(d.changed).toEqual(["command.onFailure: requires 2.1.295 → 2.1.300"]);
    expect(hasDrift(d)).toBe(true);
  });
});

describe("[S-32] what onFailure: \"block\" covers, from the snapshot", () => {
  const f = current.onFailure!;
  it("[S-32] [SD10] the snapshot holds the five documented failure cases, verbatim, and the version floor", () => {
    expect(Object.keys(f.failures)).toEqual([...ON_FAILURE_CASES]);
    expect(f.failures["cant-start"].quote).toBe("**Can't start**: a command hook fails to start, for example because the script or executable doesn't exist");
    expect(f.failures["exit-code-other-than-0-or-2"].quote).toBe('**Exit code other than 0 or 2**: counts for a command hook even if it printed JSON that allows the action, such as `permissionDecision: "allow"`. To return a JSON decision, exit 0');
    expect(f.failures.timeout.quote).toBe("**Timeout**: the hook reaches its [`timeout`](#common-fields)");
    expect(f.failures["invalid-output"].quote).toMatch(/^\*\*Invalid output\*\*: the JSON output \[can't be parsed\]\(#exit-code-0\) or fails \[schema validation\]\(#json-output\)/);
    expect(f.block.quote).toMatch(/^With `"block"` set, a failure does what \[exit code 2 does on that event\]/);
    expect(f.exitTable["json-object-that-passes-schema-validation"].quote).toContain("Success. Claude Code ignores the exit code, and the fields alone decide. For hooks [whose failure blocks the action](#block-the-action-when-a-hook-fails), the run counts as a failure instead");
    expect(f.exit1.quote).toBe("Exit code 1 without valid JSON output is a non-blocking error unless the hook is one [whose failure blocks the action](#block-the-action-when-a-hook-fails), even though 1 is the conventional Unix failure code. If your hook is meant to enforce a policy, use `exit 2`.");
    expect(f.requires).toBe(ON_FAILURE_SINCE);
    expect(current.fields.command.onFailure.requires).toBe(ON_FAILURE_SINCE);
    expect(minimum.onFailure).toEqual(f);
  });

  it("[S-32] [SD11] (a) with onFailure: block, exit 1 with JSON that allows the call blocks it: the exit code counts as a failure", () => {
    expect(preToolUseOutcome({ exit: 1, stdout: "valid-json", decision: "allow" }, "block")).toBe("block");
    expect(preToolUseOutcome({ exit: 1, stdout: "valid-json", decision: "deny" }, "block")).toBe("block");
    // exit 0 is the way to return a JSON decision under block
    expect(preToolUseOutcome({ exit: 0, stdout: "valid-json", decision: "allow" }, "block")).toBe("allow");
  });

  it("[S-32] [SD12] (b) without onFailure, exit 1 with valid JSON: the fields decide", () => {
    expect(preToolUseOutcome({ exit: 1, stdout: "valid-json", decision: "allow" })).toBe("allow");
    expect(preToolUseOutcome({ exit: 1, stdout: "valid-json", decision: "deny" })).toBe("deny");
    expect(preToolUseOutcome({ exit: 1, stdout: "valid-json", decision: "deny" }, "continue")).toBe("deny");
  });

  it("[S-32] [SD13] (c) without onFailure, exit 1 without valid JSON goes ahead; with block it blocks", () => {
    for (const stdout of ["plain", "invalid-json"] as const) {
      expect(preToolUseOutcome({ exit: 1, stdout }), stdout).toBe("proceed");
      expect(preToolUseOutcome({ exit: 1, stdout }, "block"), stdout).toBe("block");
    }
  });

  it("[S-32] [SD14] the other cases: cannot start, a timeout, invalid JSON on exit 0, and exit 2", () => {
    for (const exit of ["cant-start", "timeout"] as const) {
      expect(preToolUseOutcome({ exit }), exit).toBe("proceed");
      expect(preToolUseOutcome({ exit }, "block"), exit).toBe("block");
    }
    expect(preToolUseOutcome({ exit: 0, stdout: "invalid-json" })).toBe("proceed");
    expect(preToolUseOutcome({ exit: 0, stdout: "invalid-json" }, "block")).toBe("block");
    expect(preToolUseOutcome({ exit: 0, stdout: "plain" }, "block")).toBe("proceed");
    expect(preToolUseOutcome({ exit: 2, stdout: "valid-json", decision: "allow" })).toBe("block");
  });
});
