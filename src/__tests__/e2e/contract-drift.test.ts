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
