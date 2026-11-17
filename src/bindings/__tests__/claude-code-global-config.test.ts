/**
 * Keys the settings reference scopes to `Global config` live in
 * ~/.claude.json, not in a settings file: Claude Code does not read them from
 * a project's .claude/settings.json. The binding never writes them, and
 * validation (V130) says why. Removed keys are not written either; deprecated
 * keys Claude Code still reads are written, with a warning quoting the docs.
 */

import { describe, it, expect } from "vitest";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { claudeCodeBinding } from "../claude-code.js";
import { ccKey, ccKeys } from "../claude-code-schema.js";
import { extractSettingsKeys } from "../../conformance/extract-schema.js";

const topo = (ext: string) => `topology t : [pipeline] {
  meta {
    version: "1.0.0"
    description: "x"
  }
  orchestrator {
    model: opus
    handles: [intake]
  }
  action intake {
    kind: inline
    description: "in"
  }
  agent a {
    model: sonnet
    description: "worker"
    prompt { Do the work. }
  }
  flow {
    intake -> a
  }
  extensions {
    claude-code {
      ${ext}
    }
  }
}`;

function build(ext: string) {
  const ast = parse(topo(ext));
  const results = validate(ast);
  const files = claudeCodeBinding.scaffold(ast);
  const settingsFile = files.find((f) => f.path === ".claude/settings.json");
  const settings = settingsFile ? JSON.parse(settingsFile.content) : {};
  return {
    settings,
    errors: results.filter((r) => r.level === "error"),
    v130: results.filter((r) => r.rule === "V130"),
  };
}

/** The settings reference scopes these to Global config (~/.claude.json). */
const GLOBAL_CONFIG: Record<string, string> = {
  autoConnectIde: "true",
  autoInstallIdeExtension: "false",
  claudeInChromeDefaultEnabled: "true",
  copyFullResponse: "true",
  copyOnSelect: "false",
  defaultToAgentsView: "true",
  diffTool: "terminal",
  externalEditorContext: "true",
  leftArrowOpensAgents: "false",
  prStatusFooterEnabled: "false",
  permissionExplainerEnabled: "false",
  teammateDefaultModel: "sonnet",
};

/** Removed: "Setting it has no effect on current versions." */
const REMOVED: Record<string, RegExp> = {
  permissionExplainerEnabled: /Removed in v2\.1\.257\b.*Setting it has no effect on current versions\./,
  teammateDefaultModel: /Removed in v2\.1\.234\b.*Setting it has no effect on current versions\./,
};

/** Deprecated but still read: written, with the docs' deprecation line. */
const DEPRECATED: Record<string, { value: string; written: unknown; quote: RegExp }> = {
  keybindingFlavor: { value: "readline", written: "readline", quote: /Deprecated since v2\.1\.261 and has no effect\./ },
  voiceEnabled: { value: "true", written: true, quote: /Deprecated since v2\.1\.92, when the `voice` object replaced it\./ },
  includeCoAuthoredBy: { value: "false", written: false, quote: /Deprecated since v2\.0\.62, when `attribution` replaced it\./ },
  disableArtifact: { value: "true", written: true, quote: /Deprecated, and replaced by `enableArtifact`\./ },
};

describe("global-config keys are not settings.json keys", () => {
  it.each(Object.keys(GLOBAL_CONFIG))("%s has no settings row; it is known as a global-config key", (k) => {
    expect(ccKey("settings", k)).toBeUndefined();
    expect(ccKey("global-config", k)?.key).toBe(k);
  });

  it("no settings row is a global-config key", () => {
    const global = new Set(ccKeys("global-config").map((r) => r.key));
    expect(ccKeys("global-config").map((r) => r.key).sort()).toEqual(Object.keys(GLOBAL_CONFIG).sort());
    expect(ccKeys("settings").filter((r) => global.has(r.key))).toEqual([]);
  });

  it.each(Object.entries(GLOBAL_CONFIG))("extensions { claude-code { %s } } is not written to settings.json and V130 says where it lives", (k, v) => {
    const b = build(`${k}: ${v}`);
    expect(b.errors).toEqual([]);
    expect(k in b.settings).toBe(false);
    const msgs = b.v130.map((r) => r.message).filter((m) => m.includes(k));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain(`${k} is a ~/.claude.json global-config key, not a project setting; Claude Code does not read it from .claude/settings.json`);
    expect(msgs[0]).toContain(`Scope "Global config"`);
    expect(msgs[0]).not.toMatch(/Did you mean/);
    expect(b.v130.every((r) => r.level === "warning")).toBe(true);
  });
});

describe("removed keys", () => {
  it.each(Object.entries(REMOVED))("%s is not written and V130 quotes its removal", (k, quote) => {
    expect(ccKey("global-config", k)?.removed).toMatch(quote);
    const b = build(`${k}: ${GLOBAL_CONFIG[k]}`);
    expect(k in b.settings).toBe(false);
    const msgs = b.v130.map((r) => r.message).filter((m) => m.includes(k));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatch(quote);
    expect(b.errors).toEqual([]);
  });
});

describe("deprecated keys Claude Code still reads", () => {
  it.each(Object.entries(DEPRECATED))("%s is written to settings.json and V130 quotes the deprecation", (k, d) => {
    expect(ccKey("settings", k)?.deprecated).toMatch(d.quote);
    const b = build(`${k}: ${d.value}`);
    expect(b.errors).toEqual([]);
    expect(b.settings[k]).toEqual(d.written);
    const msgs = b.v130.map((r) => r.message).filter((m) => m.includes(k));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatch(d.quote);
    expect(msgs[0]).toMatch(/still written/);
    expect(b.v130.every((r) => r.level === "warning")).toBe(true);
  });
});

describe("an ordinary settings key is unchanged", () => {
  it("outputStyle is written with no V130 finding", () => {
    const b = build(`outputStyle: "Explanatory"`);
    expect(b.errors).toEqual([]);
    expect(b.v130).toEqual([]);
    expect(b.settings.outputStyle).toBe("Explanatory");
    expect(ccKey("settings", "outputStyle")?.deprecated).toBeUndefined();
  });
});

describe("the extractor reads Scope and the warning box", () => {
  const page = [
    "## Interface",
    "### `copyOnSelect`",
    "Copy text.",
    "* **Scope**: [`Global config`](#scopes)",
    "* **Type**: Boolean",
    "### `teammateDefaultModel`",
    "> [!WARNING]",
    ">",
    "> Removed in v2.1.234, together with its `/config` row **Default teammate model**. Setting it has no effect on current versions.",
    "",
    "Through v2.1.233, you set this key.",
    "* **Scope**: [`Global config`](#scopes). On v2.1.233 and earlier.",
    "* **Type**: string, a model alias or full model ID, or `null`",
    "### `voiceEnabled`",
    "> [!WARNING]",
    ">",
    "> Deprecated since v2.1.92, when the [`voice`](#voice) object replaced it. Claude Code still reads it.",
    "* **Scope**: [`Any file`](#scopes)",
    "* **Type**: Boolean",
    "### `outputStyle`",
    "* **Scope**: [`Any file`](#scopes)",
    "* **Type**: string",
  ].join("\n");

  it("marks global-config keys and keeps the removal or deprecation line as plain text", () => {
    expect(extractSettingsKeys(page)).toEqual([
      { key: "copyOnSelect", type: "boolean", projectFile: false, globalConfig: true },
      {
        key: "teammateDefaultModel", type: "string", projectFile: false, globalConfig: true,
        removed: "Removed in v2.1.234, together with its `/config` row Default teammate model. Setting it has no effect on current versions.",
      },
      {
        key: "voiceEnabled", type: "boolean", projectFile: true,
        deprecated: "Deprecated since v2.1.92, when the `voice` object replaced it. Claude Code still reads it.",
      },
      { key: "outputStyle", type: "string", projectFile: true },
    ]);
  });
});
