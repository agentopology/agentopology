/**
 * The Claude Code schema: its rows, the extractor that keeps them honest, and
 * the lookups the binding and validation use.
 */

import { describe, it, expect } from "vitest";
import {
  CLAUDE_CODE_SCHEMA, ccKey, ccKeys, nearestCcKey, resolveSettingsKey, coerceCcValue, PROBE_VERSION,
} from "../claude-code-schema.js";
import { extractSettingsKeys, extractFrontmatterKeys } from "../../conformance/extract-schema.js";

describe("schema rows", () => {
  it("every row names its doc page, a verifiedOn and a known enforcement", () => {
    for (const r of CLAUDE_CODE_SCHEMA) {
      expect(r.doc, `${r.surface}:${r.key}`).toMatch(/^https:\/\/code\.claude\.com\/docs\/en\/[a-z-]+\.md/);
      expect(r.verifiedOn, `${r.surface}:${r.key}`).toMatch(/^(\d+\.\d+\.\d+|docs \d{4}-\d{2}-\d{2})$/);
      expect(["refuses", "grants", "steers", "none", "unknown"]).toContain(r.enforcement);
      if (r.type === "enum") expect(r.values?.length, `${r.surface}:${r.key}`).toBeGreaterThan(0);
    }
  });

  it("keys are unique per surface", () => {
    const seen = new Set<string>();
    for (const r of CLAUDE_CODE_SCHEMA) {
      const id = `${r.surface}:${r.key}`;
      expect(seen.has(id), id).toBe(false);
      seen.add(id);
    }
  });

  it("the probe rows carry what the probe measured", () => {
    const row = (s: Parameters<typeof ccKey>[0], k: string) => ccKey(s, k)!;
    for (const [s, k, e] of [
      ["agent", "tools", "refuses"], ["agent", "disallowedTools", "refuses"],
      ["settings", "permissions.deny", "refuses"], ["settings", "permissions.ask", "refuses"],
      ["settings", "hooks", "refuses"], ["skill", "allowed-tools", "grants"], ["agent", "skills", "steers"],
    ] as const) {
      expect(row(s, k).enforcement, `${s}:${k}`).toBe(e);
      expect(row(s, k).verifiedOn, `${s}:${k}`).toBe(PROBE_VERSION);
    }
    // The follow-up probe: each value holds only under the conditions it states.
    expect(row("agent", "hooks")).toMatchObject({ enforcement: "none", verifiedOn: PROBE_VERSION, enforcedWhen: { afterTrust: true } });
    expect(row("agent", "maxTurns")).toMatchObject({ enforcement: "refuses", verifiedOn: PROBE_VERSION, enforcedWhen: { path: "subagent" } });
    expect(row("agent", "maxTurns").note).toMatch(/--agent/);
    expect(row("agent", "permissionMode")).toMatchObject({ enforcement: "none", verifiedOn: PROBE_VERSION });
    expect(row("agent", "skills").note).toMatch(/never refuses/);
    expect(row("settings", "permissions.allow").enforcedWhen).toEqual({ afterTrust: true });
  });

  it("a command file takes the skill keys except name and paths", () => {
    const skill = ccKeys("skill").map((r) => r.key).filter((k) => k !== "name" && k !== "paths").sort();
    expect(ccKeys("command").map((r) => r.key).sort()).toEqual(skill);
  });

  it("the settings rows hold the keys the binding builds itself", () => {
    for (const k of ["hooks", "env", "permissions.allow", "permissions.ask", "permissions.deny", "sandbox.enabled", "fallbackModel"]) {
      expect(ccKey("settings", k)?.projectFile, k).toBe(true);
    }
    expect(ccKey("settings", "permissions.defaultMode")?.values).toContain("plan");
  });
});

describe("lookups", () => {
  it("a top-level permissions or sandbox key resolves to its nested path", () => {
    expect(resolveSettingsKey("defaultMode")?.path).toBe("permissions.defaultMode");
    expect(resolveSettingsKey("additionalDirectories")?.path).toBe("permissions.additionalDirectories");
    expect(resolveSettingsKey("autoAllowBashIfSandboxed")?.path).toBe("sandbox.autoAllowBashIfSandboxed");
    expect(resolveSettingsKey("outputStyle")?.path).toBe("outputStyle");
    expect(resolveSettingsKey("statusLine.command")).toEqual({ path: "statusLine.command" });
    expect(resolveSettingsKey("project-type")).toBeUndefined();
    // sandbox lists its fields, so an unlisted child is unknown.
    expect(resolveSettingsKey("sandbox.enabld")).toBeUndefined();
  });

  it("the nearest key ignores case and separators", () => {
    expect(nearestCcKey("agent", "maxturns")).toBe("maxTurns");
    expect(nearestCcKey("skill", "when-to-use")).toBe("when_to_use");
    expect(nearestCcKey("settings", "defaultMod")).toBe("permissions.defaultMode");
    expect(nearestCcKey("agent", "zzzzzzzzzzzz")).toBeUndefined();
  });

  it("values are coerced to the documented type or refused with a reason", () => {
    expect(coerceCcValue(ccKey("settings", "permissions.additionalDirectories"), '["../a", "../b"]')).toEqual({ ok: true, value: ["../a", "../b"] });
    expect(coerceCcValue(ccKey("agent", "autoCompactWindow"), 200000)).toEqual({ ok: true, value: 200000 });
    expect(coerceCcValue(ccKey("agent", "autoCompactWindow"), 5)).toMatchObject({ ok: false });
    expect(coerceCcValue(ccKey("agent", "color"), "magenta")).toMatchObject({ ok: false });
    expect(coerceCcValue(ccKey("skill", "background"), "false")).toEqual({ ok: true, value: false });
    expect(coerceCcValue(ccKey("settings", "env"), "x")).toMatchObject({ ok: false });
  });
});

describe("extractor", () => {
  const page = [
    "## Permission settings",
    "### `permissions.defaultMode`",
    "Set the mode.",
    "* **Scope**: [`Any file`](#scopes). `auto` doesn't take effect from project settings.",
    "* **Type**: string, one of:",
    '  * `"default"`: asks',
    '  * `"plan"`: plans',
    "* **Default**: unset",
    "### `skipAutoPermissionPrompt`",
    "* **Scope**: [`User or managed`](#scopes). A repository can't set it.",
    "* **Type**: Boolean",
    "### `taskOutputMaxChars`",
    "> Removed.",
    "## Interface",
    "### `keybindingFlavor`",
    "* **Scope**: [`Any file`](#scopes)",
    '* **Type**: string, `"classic"` or `"readline"`',
  ].join("\n");

  it("reads each key's type, values and whether a project file may set it; a removed key has no type and is skipped", () => {
    expect(extractSettingsKeys(page)).toEqual([
      { key: "permissions.defaultMode", type: "enum", values: ["default", "plan"], projectFile: true },
      { key: "skipAutoPermissionPrompt", type: "boolean", projectFile: false },
      { key: "keybindingFlavor", type: "enum", values: ["classic", "readline"], projectFile: true },
    ]);
  });

  it("reads a frontmatter table's keys", () => {
    const table = "| Field | Required | Description |\n| :- | :- | :- |\n| `name` | Yes | id |\n| `when_to_use` | No | when |\n| `default` | Manual mode |";
    expect(extractFrontmatterKeys(table)).toEqual(["name", "when_to_use"]);
  });
});
