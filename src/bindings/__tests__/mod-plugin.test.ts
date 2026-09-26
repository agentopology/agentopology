/**
 * `type: mod` hooks on claude-code → a plugin directory, never settings.json.
 *
 * The engine loads ONE module per plugin (measured, Claude Code 2.1.283), so
 * the plugin's single entry is a generated register.ts that registers every
 * Mod. Command hooks keep going to settings.json exactly as before.
 */

import { describe, it, expect, vi } from "vitest";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { claudeCodeBinding, bindings } from "../index.js";
import type { GeneratedFile } from "../types.js";

const topology = (hooks: string) =>
  [
    "topology mini : [pipeline] {",
    "  meta {",
    '    version: "1.2.0"',
    '    description: "mods"',
    "  }",
    "  orchestrator {",
    "    model: sonnet",
    "  }",
    "  agent a {",
    "    model: sonnet",
    '    description: "a"',
    "  }",
    "  flow { a }",
    "  hooks {",
    hooks,
    "  }",
    "}",
  ].join("\n");

const REDACT = [
  "    hook redact {",
  "      on: tool.call",
  '      run: "harness-plugin/hooks/redact.ts"',
  "      type: mod",
  "      flag: MY_MOD_REDACT",
  "    }",
].join("\n");
const STATE = [
  "    hook state {",
  "      on: prompt.submit",
  '      run: "harness-plugin/hooks/state_mod.ts"',
  "      type: mod",
  "      flag: MY_MOD_STATE",
  "    }",
].join("\n");
const GATE = [
  "    hook gate {",
  "      on: PreToolUse",
  '      matcher: "Bash"',
  '      run: "gate.sh"',
  "    }",
].join("\n");

const PLUGIN = "harness-plugin"; // the folder that holds the Mods' modules
const scaffold = (src: string) => claudeCodeBinding.scaffold(parse(src));
const file = (files: GeneratedFile[], p: string) => files.find((f) => f.path === p);

describe("claude-code: Mods become a plugin", () => {
  const files = scaffold(topology([REDACT, STATE, GATE].join("\n")));

  it("emits the plugin's four files", () => {
    expect(files.filter((f) => f.path.startsWith(PLUGIN + "/")).map((f) => f.path).sort()).toEqual([
      `${PLUGIN}/.claude-plugin/plugin.json`,
      `${PLUGIN}/hooks/at-register.ts`,
      `${PLUGIN}/hooks/hooks.json`,
      `${PLUGIN}/launch-mods.sh`,
    ]);
  });

  it("names ONE entry module in hooks.json", () => {
    expect(JSON.parse(file(files, `${PLUGIN}/hooks/hooks.json`)!.content).modules).toEqual(["./at-register.ts"]);
    const manifest = JSON.parse(file(files, `${PLUGIN}/.claude-plugin/plugin.json`)!.content);
    expect(manifest).toMatchObject({ name: "mini-mods", version: "1.2.0" });
  });

  it("registers every Mod from the entry, passing on as it came", () => {
    const reg = file(files, `${PLUGIN}/hooks/at-register.ts`)!.content;
    // Inside the plugin folder: the engine refuses an import outside it (2.1.283).
    expect(reg).toContain("import { register as mod_redact } from './redact'");
    expect(reg).toContain("import { register as mod_state } from './state_mod'");
    expect(reg).not.toContain("../");
    // The engine refuses a wrapped or kept `on`, and a module has no `process`
    // (both measured, 2.1.283): the entry passes `on` as it came.
    expect(reg).toContain("  mod_redact(on)");
    expect(reg).toContain("  mod_state(on)");
    expect(reg).toContain("the Mod reads its own switch, MY_MOD_REDACT");
    expect(reg).not.toContain("process.");
    expect(reg).not.toMatch(/\bon\)\s*=>|behind\(/);
    expect(reg).toContain("export function register(on: On)");
  });

  it("launches with the engine switch, each flag and --plugin-dir", () => {
    const launch = file(files, `${PLUGIN}/launch-mods.sh`)!;
    expect(launch.executable).toBe(true);
    expect(launch.content).toContain("export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1");
    expect(launch.content).toContain('export MY_MOD_REDACT="${MY_MOD_REDACT:-1}"');
    expect(launch.content).toContain('export MY_MOD_STATE="${MY_MOD_STATE:-1}"');
    expect(launch.content).toContain('exec claude --plugin-dir "$PLUGIN_DIR" "$@"');
  });

  it("keeps Mods out of settings.json; the command hook stays there", () => {
    const hooks = JSON.parse(file(files, ".claude/settings.json")!.content).hooks;
    expect(Object.keys(hooks)).toEqual(["PreToolUse"]);
    expect(hooks.PreToolUse[0].hooks[0]).toEqual({ type: "command", command: "bash .claude/skills/mini/scripts/gate.sh" });
    expect(JSON.stringify(hooks)).not.toContain("mod");
  });

  it("never writes over a Mod's own module", () => {
    expect(files.some((f) => f.path.includes("redact") || f.path.includes("state_mod"))).toBe(false);
  });

  it("never overwrites a hand-written hooks/register.ts", () => {
    expect(files.some((f) => f.path.endsWith("/register.ts"))).toBe(false);
  });
});

describe("claude-code: the plugin root holds the modules", () => {
  it("is the project root when the Mods share no folder, still without ../", () => {
    const src = topology([REDACT, STATE.replace("harness-plugin/hooks/state_mod.ts", "mods/state_mod.ts")].join("\n"));
    const files = scaffold(src);
    expect(files.map((f) => f.path)).toContain("hooks/at-register.ts");
    expect(files.map((f) => f.path)).toContain(".claude-plugin/plugin.json");
    const reg = file(files, "hooks/at-register.ts")!.content;
    expect(reg).toContain("from '../harness-plugin/hooks/redact'");
    expect(reg).toContain("from '../mods/state_mod'");
  });

  it("keeps a nested folder that is not hooks/", () => {
    const src = topology(REDACT.replace("harness-plugin/hooks/redact.ts", "tools/mods/redact.ts"));
    expect(file(scaffold(src), "tools/mods/hooks/at-register.ts")!.content).toContain("from '../redact'");
  });

  it("skips the plugin, with a warning, when a run: path is absolute", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const files = scaffold(topology(REDACT.replace("harness-plugin/hooks/redact.ts", "/opt/redact.ts")));
    expect(files.some((f) => f.path.endsWith("at-register.ts"))).toBe(false);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("is absolute"))).toBe(true);
    warn.mockRestore();
  });
});

describe("claude-code: no Mods, no change", () => {
  it("emits no plugin for a topology without Mods", () => {
    const files = scaffold(topology(GATE));
    expect(files.some((f) => f.path.startsWith(".claude/plugins/"))).toBe(false);
  });

  it("emits the same files with or without the Mods, apart from the plugin", () => {
    const plain = scaffold(topology(GATE));
    const withMods = scaffold(topology([REDACT, GATE].join("\n")));
    const strip = (fs: { path: string; content: string }[]) =>
      fs.filter((f) => !f.path.startsWith(PLUGIN)).map((f) => [f.path, f.content]);
    expect(strip(withMods)).toEqual(strip(plain));
  });
});

describe("other targets cannot host a Mod", () => {
  it("drops it with a warning instead of writing a shell command for a .ts file", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const [name, b] of Object.entries(bindings)) {
      if (name === "claude-code") continue;
      const out = b.scaffold(parse(topology([REDACT, GATE].join("\n"))));
      expect(out.some((f) => f.content.includes("redact.ts")), name).toBe(false);
    }
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("cannot host them"))).toHaveLength(7);
    warn.mockRestore();
  });
});

describe("V94: a Mod is engine-wide", () => {
  it("refuses a mod declared inside an agent", () => {
    const src = topology(GATE).replace(
      '    description: "a"\n',
      '    description: "a"\n    hooks {\n      hook m {\n        on: tool.call\n        run: "m.ts"\n        type: mod\n      }\n    }\n',
    );
    const v94 = validate(parse(src)).filter((r) => r.rule === "V94");
    expect(v94.map((r) => r.message)).toEqual([
      'Hook "a.m" is a mod inside an agent — a Mod runs in the engine for the whole session; declare it in the topology\'s hooks block.',
    ]);
  });
});
