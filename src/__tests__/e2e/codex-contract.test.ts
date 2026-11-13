/**
 * The Codex contract (CX-2): constants, snapshots, extractor, drift script.
 * Offline: no model call, no `codex` binary, no network, no real home directory.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  VERIFIED_ON, MINIMUM_VERSION, HOOK_EVENTS, NO_MATCHER_EVENTS, RUNNING_HANDLERS, SKIPPED_HANDLERS,
  BLOCKING_EVENTS, PRE_TOOL_DECISIONS, APPROVAL_POLICIES, SANDBOX_MODES, PROJECT_FORBIDDEN_KEYS,
  CODEX_HOOKS_PROVEN, verifiedOnLine, parseInstalled, checkHooks,
} from "../../conformance/codex.js";
import {
  extractCodexHookContract, diffCodexContracts, hasCodexDrift, renderCodexDiff, parseFeaturesList,
  type CodexHookContract,
} from "../../conformance/extract-codex.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const readJson = (p: string) => JSON.parse(fs.readFileSync(join(repo, p), "utf8"));
const snapshot: CodexHookContract = readJson("spec/codex/hooks-contract.json");
const keys = readJson("spec/codex/config-keys.json");
const features = readJson("spec/codex/features.json");

describe("checkHooks", () => {
  it("[CX-2] a planted hooks.json with event Notification, a prompt handler and a matcher on Stop gives exactly 3 violations", () => {
    const planted = {
      hooks: {
        Notification: [{ hooks: [{ type: "command", command: "echo hi" }] }],
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "prompt", prompt: "be careful" }] }],
        Stop: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo done" }] }],
      },
    };
    const v = checkHooks(planted);
    expect(v.map((x) => x.check).sort()).toEqual(["handler-not-run", "matcher-ignored", "unknown-event"]);
    expect(v).toHaveLength(3);
  });

  it("[CX-2] a clean hooks.json in the measured shape has no violations", () => {
    const real = { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "x", timeout: 10 }] }], PreToolUse: [{ matcher: "Bash", hooks: [{ type: "mcp_tool" }] }] } };
    expect(checkHooks(real)).toEqual([]);
  });
});

describe("the code agrees with the snapshot", () => {
  it("[CX-2] events, no-matcher events, handlers, blocking events and decisions match spec/codex/hooks-contract.json", () => {
    expect([...HOOK_EVENTS].sort()).toEqual([...snapshot.events].sort());
    expect(HOOK_EVENTS.size).toBe(14);
    expect([...NO_MATCHER_EVENTS].sort()).toEqual(snapshot.noMatcherEvents);
    expect([...RUNNING_HANDLERS].sort()).toEqual(snapshot.runningHandlers);
    expect([...SKIPPED_HANDLERS].sort()).toEqual(snapshot.skippedHandlers);
    expect([...BLOCKING_EVENTS].sort()).toEqual(snapshot.blockingEvents);
    expect([...PRE_TOOL_DECISIONS].sort()).toEqual(snapshot.preToolDecisions);
    expect(PRE_TOOL_DECISIONS.has("ask")).toBe(false);
  });

  it("[CX-2] config values and forbidden keys match spec/codex/config-keys.json", () => {
    expect([...APPROVAL_POLICIES].sort()).toEqual(keys.approvalPolicies);
    expect([...SANDBOX_MODES].sort()).toEqual(keys.sandboxModes);
    expect([...PROJECT_FORBIDDEN_KEYS].sort()).toEqual([...keys.projectForbidden].sort());
    for (const absent of keys.absent) expect(keys.keys, absent).not.toContain(absent);
  });

  it("[CX-2] the snapshots are of the verified version; the feature facts match", () => {
    expect(snapshot.codex).toBe(VERIFIED_ON);
    expect(keys.codex).toBe(VERIFIED_ON);
    expect(features.codex).toBe(VERIFIED_ON);
    expect(MINIMUM_VERSION).toBe(VERIFIED_ON);
    const f = Object.fromEntries(features.features.map((x: any) => [x.name, `${x.stage}/${x.enabled}`]));
    expect(f).toMatchObject({ hooks: "stable/true", multi_agent: "stable/true", multi_agent_v2: "stable/false" });
  });

  it("[CX-2] no hook is proven until tier E records a run", () => {
    expect(Object.values(CODEX_HOOKS_PROVEN).every((v) => v === false)).toBe(true);
    expect(Object.keys(CODEX_HOOKS_PROVEN).sort()).toEqual(["applyPatch", "bash", "mcp", "queue", "spawn", "subagentStop"]);
  });
});

describe("version line and installed mark", () => {
  it("[CX-2] the version line names both constants", () => {
    expect(verifiedOnLine()).toBe("checked against Codex CLI 0.156.1 (supports 0.156.1 and later)");
  });
  it("[CX-2] codex --version output is classified into the four states", () => {
    expect(parseInstalled("codex-cli 0.156.1\n")).toEqual({ state: "verified", version: "0.156.1" });
    expect(parseInstalled("codex-cli 0.157.0")).toEqual({ state: "different", version: "0.157.0" });
    expect(parseInstalled("something else")).toEqual({ state: "unknown" });
  });
});

const PAGE = `# Hooks

## Hook events

| Event | When |
| :- | :- |
${[...HOOK_EVENTS].map((e) => `| \`${e}\` | x |`).join("\n")}

Matchers are ignored on ${[...NO_MATCHER_EVENTS].map((e) => `\`${e}\``).join(", ")}.

\`command\` and \`mcp_tool\` handlers run. \`prompt\` and \`agent\` handlers are parsed and skipped.

Exit 2 blocks on \`PreToolUse\` and \`UserPromptSubmit\`.

\`permissionDecision\` may be \`deny\` or \`allow\`.
`;
const meta = { source: "test", fetched: "2026-11-13", codex: VERIFIED_ON };

describe("the extractor and the drift watch", () => {
  it("[CX-2] a page laid out as the docs describe extracts to the committed snapshot", () => {
    const got = extractCodexHookContract(PAGE, meta);
    expect(hasCodexDrift(diffCodexContracts(snapshot, got))).toBe(false);
    expect(renderCodexDiff(diffCodexContracts(snapshot, got))).toEqual(["no drift"]);
  });

  it("[CX-2] a page with one event removed prints that one difference", () => {
    const page = PAGE.replace("| `Interrupt` | x |\n", "").replace("`Interrupt`, ", "");
    const d = diffCodexContracts(snapshot, extractCodexHookContract(page, meta));
    expect(renderCodexDiff(d)).toEqual(["events removed (1): Interrupt", "matcher support added (1): Interrupt"]);
  });

  it("[CX-2] features list output parses", () => {
    expect(parseFeaturesList("hooks  stable  true\nmulti_agent_v2  stable  false\nagent_message_board  under development  false\n")).toEqual([
      { name: "hooks", stage: "stable", enabled: true },
      { name: "multi_agent_v2", stage: "stable", enabled: false },
      { name: "agent_message_board", stage: "under development", enabled: false },
    ]);
  });

  const built = fs.existsSync(join(repo, "dist/conformance/extract-codex.js"));
  it.skipIf(!built)("[CX-2] scripts/codex-drift.mjs, given a planted snapshot with one event removed, prints that one difference and exits 1", () => {
    const dir = fs.mkdtempSync(join(os.tmpdir(), "codex-drift-"));
    const planted = { ...snapshot, events: snapshot.events.filter((e) => e !== "SessionEnd") };
    fs.writeFileSync(join(dir, "snap.json"), JSON.stringify(planted));
    fs.writeFileSync(join(dir, "page.md"), PAGE);
    const r = spawnSync("node", [join(repo, "scripts/codex-drift.mjs"), "--from", join(dir, "page.md"), "--snapshot", join(dir, "snap.json")], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("events added (1): SessionEnd");
    expect(r.stdout.split("\n").filter((l) => l.startsWith("  "))).toHaveLength(1);
  });
});
