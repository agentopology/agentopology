/**
 * The plugin seam (EXPERIMENTAL). A test plugin `acme` (fixtures/acme) owns
 * one block, `widget`, has one rule, writes one file and one hook for
 * claude-code, and sets the check of a gate that carries
 * `extensions { acme { } }`.
 *
 * Without a plugin everything is what it was: the scaffold of every example
 * and e2e fixture still hashes to guards-golden.json.
 */

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import { serializeAST } from "../../import/serializer.js";
import { topics } from "../../docs/content.js";
import { PluginError, pluginStateOf, preparePluginTarget, setActivePlugins } from "../runtime.js";
import type { AtPlugin } from "../types.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
let acme: AtPlugin;

beforeAll(async () => {
  acme = (await import(pathToFileURL(join(here, "fixtures/acme.mjs")).href)).default as AtPlugin;
});
afterEach(() => setActivePlugins([]));

const HEAD = `topology w : [pipeline] {
  meta {
    version: "1.0.0"
    description: "widgets"
  }
  orchestrator {
    model: sonnet
  }
  agent a {
    model: sonnet
    prompt { Do a. }
  }
  agent b {
    model: sonnet
    prompt { Do b. }
  }
  flow {
    a -> b
  }
`;
const topo = (...extra: string[]) => `${HEAD}${extra.join("\n")}\n}\n`;
const WIDGETS = [
  "  widget w1 {",
  '    a: "one"',
  "    b: 2",
  "  }",
  "  widget w2 {",
  "    b: 3",
  "  }",
].join("\n");
const GATE = ["  gates {", "    gate g {", "      after: a", "      before: b", "      extensions {", "        acme { }", "      }", "    }", "  }"].join("\n");

const quiet = <T>(f: () => T): T => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return f();
  } finally {
    console.warn = warn;
  }
};
const scaffold = (src: string, plugins: AtPlugin[] = []) => quiet(() => claudeCodeBinding.scaffold(parse(src, { plugins })));
const settings = (files: Array<{ path: string; content: string }>) =>
  JSON.parse(files.find((f) => f.path === ".claude/settings.json")?.content ?? "{}") as { hooks?: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>> };
const errors = (src: string, plugins: AtPlugin[] = [], target?: string) =>
  validate(parse(src, { plugins }), target ? { target } : {}).filter((r) => r.level === "error");

describe("no plugin: byte-identical", () => {
  const hash = (s: string) => createHash("sha256").update(s).digest("hex");
  const golden = JSON.parse(fs.readFileSync(join(repo, "src/bindings/lib/__tests__/guards-golden.json"), "utf8")) as Record<string, Record<string, string>>;
  const sources = ["examples", "src/__tests__/e2e/fixtures"].flatMap((dir) =>
    fs.readdirSync(join(repo, dir)).filter((f) => f.endsWith(".at")).sort().map((f) => `${dir}/${f}`),
  );

  it("every example and e2e fixture scaffolds to the recorded golden hashes, with no plugin and with acme loaded", () => {
    expect(sources.length).toBeGreaterThanOrEqual(14);
    for (const plugins of [[], [acme]]) {
      for (const rel of sources) {
        const files: Record<string, string> = {};
        for (const f of scaffold(fs.readFileSync(join(repo, rel), "utf8"), plugins)) files[f.path] = hash(`${f.executable ? "x" : "-"}\n${f.content}`);
        expect(files, `${rel} with ${plugins.length} plugin(s)`).toEqual(golden[rel]);
      }
    }
  });

  it("the AST of a topology without plugin blocks is the same JSON with and without the plugin, and has no enumerable plugin field", () => {
    const plain = parse(topo());
    const withAcme = parse(topo(), { plugins: [acme] });
    expect(JSON.stringify(withAcme)).toBe(JSON.stringify(plain));
    const withWidgets = parse(topo(WIDGETS), { plugins: [acme] });
    expect(Object.keys(withWidgets).filter((k) => k.includes("plugin"))).toEqual([]);
    expect(JSON.stringify(withWidgets)).not.toContain('"w1"');
  });
});

describe("acme loaded", () => {
  it("the widget blocks parse to the plugin's data, with no V102", () => {
    const ast = parse(topo(WIDGETS), { plugins: [acme] });
    expect(pluginStateOf(ast)?.data).toEqual({ acme: { widget: [{ id: "w1", a: "one", b: "2" }, { id: "w2", b: "3" }], gadget: [] } });
    expect(validate(ast).filter((r) => r.rule === "V102")).toEqual([]);
  });

  it("the plugin's rule fires on the widget without a:", () => {
    expect(errors(topo(WIDGETS), [acme])).toEqual([{ rule: "acme/widget-needs-a", level: "error", message: "widget w2 has no a:", node: "w2" }]);
  });

  it("a field the block does not take is V102, as in a core block", () => {
    const found = errors(topo("  widget w3 {\n    a: 1\n    c: 2\n  }"), [acme]);
    expect(found.map((r) => r.rule)).toEqual(["V102"]);
    expect(found[0].message).toContain("`c:`");
  });

  it("the plugin's file and PreToolUse hook are in the claude-code output; every core file is unchanged", () => {
    const core = scaffold(topo(WIDGETS));
    const plugged = scaffold(topo(WIDGETS), [acme]);
    expect(plugged.find((f) => f.path === ".claude/acme/widget.json")?.content).toBe(
      JSON.stringify([{ id: "w1", a: "one", b: "2" }, { id: "w2", b: "3" }], null, 2) + "\n",
    );
    expect(settings(plugged).hooks?.PreToolUse).toEqual([{ matcher: "Bash", hooks: [{ type: "command", command: 'bash "$CLAUDE_PROJECT_DIR/.claude/acme/hook.sh"' }] }]);
    const corePaths = new Set(core.map((f) => f.path));
    for (const f of core) {
      if (f.path === ".claude/settings.json") continue;
      expect(plugged.find((p) => p.path === f.path)?.content, f.path).toBe(f.content);
    }
    // This topology writes no settings.json of its own; the plugin's hook is the whole file.
    expect(plugged.filter((f) => !corePaths.has(f.path)).map((f) => f.path).sort()).toEqual([".claude/acme/hook.sh", ".claude/acme/widget.json", ".claude/settings.json"]);
  });

  it("a gate with extensions { acme { } } gets the plugin's check through the gate wiring", () => {
    const src = topo(GATE);
    const before = scaffold(src);
    expect(settings(before).hooks?.SubagentStop).toBeUndefined();
    const plugged = scaffold(src, [acme]);
    expect(settings(plugged).hooks?.SubagentStop).toEqual([{ matcher: "a", hooks: [{ type: "command", command: 'bash "$CLAUDE_PROJECT_DIR/.claude/skills/w/scripts/gate-g.sh"' }] }]);
    // The run script is the plugin's, not a core stub.
    expect(plugged.find((f) => f.path === ".claude/acme/check.sh")?.content).toContain("# acme gate check");
    expect(plugged.find((f) => f.path === ".claude/skills/w/scripts/gate-g.sh")?.content).toContain(".claude/acme/check.sh");
    // The prepared AST carries the run; the parsed one does not change.
    const ast = parse(src, { plugins: [acme] });
    const prepared = preparePluginTarget(ast, "claude-code");
    expect(prepared.nodes.find((n) => n.id === "g")).toMatchObject({ run: "bash .claude/acme/check.sh" });
    expect(ast.nodes.find((n) => n.id === "g")).not.toHaveProperty("run");
    expect(preparePluginTarget(prepared, "claude-code")).toBe(prepared);
  });

  it("V135 sees the plugin's check: a gate after a report action that no hook runs is an error once the plugin sets its run", () => {
    const src = topo(
      ["  action finish {", "    kind: report", '    description: "sum up"', "  }", "  gates {", "    gate g2 {", "      after: finish", "      extensions {", "        acme { }", "      }", "    }", "  }"].join("\n"),
    ).replace("orchestrator {\n    model: sonnet\n  }", "orchestrator {\n    model: sonnet\n    handles: [finish]\n  }").replace("a -> b\n", "a -> b\n    b -> finish\n");
    const ast = parse(src, { plugins: [acme] });
    // Without the plugin the gate has no run:, so V135 has nothing to judge; validate prepares the plugin's check itself.
    expect(validate(parse(src), { target: "claude-code" }).filter((r) => r.rule === "V135")).toEqual([]);
    expect(validate(ast, { target: "claude-code" }).filter((r) => r.rule === "V135").map((r) => r.node)).toEqual(["g2"]);
    const v135 = validate(preparePluginTarget(ast, "claude-code"), { target: "claude-code" }).filter((r) => r.rule === "V135");
    expect(v135.map((r) => [r.level, r.node])).toEqual([["error", "g2"]]);
  });

  it("imports and includes use the same plugin set: the CLI's set is the default of every parse", () => {
    setActivePlugins([acme]);
    expect(pluginStateOf(parse(topo(WIDGETS)))?.data.acme.widget).toHaveLength(2);
    setActivePlugins([]);
    expect(pluginStateOf(parse(topo(WIDGETS)))).toBeUndefined();
  });
});

describe("uses-plugins", () => {
  it("a block a declared, unloaded plugin would own is V158, not V102", () => {
    const found = errors(topo("  uses-plugins: [acme]", WIDGETS));
    expect(found).toEqual([
      { rule: "V158", level: "error", message: "block widget needs plugin acme; run with --plugin acme" },
      { rule: "V158", level: "error", message: "block widget needs plugin acme; run with --plugin acme" },
    ]);
  });

  it("a declared plugin that is not loaded is V158 with no block too", () => {
    expect(errors(topo("  uses-plugins: [acme]"))).toEqual([
      { rule: "V158", level: "error", message: "uses-plugins names plugin acme, which is not loaded; run with --plugin acme" },
    ]);
  });

  it("with the plugin loaded, uses-plugins is satisfied", () => {
    const ast = parse(topo("  uses-plugins: [acme]", WIDGETS), { plugins: [acme] });
    expect(ast.usesPlugins).toEqual(["acme"]);
    expect(validate(ast).filter((r) => r.rule === "V158" || r.rule === "V102")).toEqual([]);
  });

  it("uses-plugins survives the serializer round trip", () => {
    const ast = parse(topo("  uses-plugins: [acme]"));
    expect(parse(serializeAST(ast)).usesPlugins).toEqual(["acme"]);
  });

  it("without uses-plugins and without the plugin, a widget block is today's V102 exactly", () => {
    expect(errors(topo(WIDGETS))).toEqual([
      { rule: "V102", level: "error", message: "the topology has a `widget w1 { }` block, which is not a topology section, so it is ignored" },
      { rule: "V102", level: "error", message: "the topology has a `widget w2 { }` block, which is not a topology section, so it is ignored" },
    ]);
  });
});

describe("docs", () => {
  it("the plugins topic states the flags, uses-plugins, rule ids, the API, the experimental label and the security note", () => {
    const page = topics.plugins.content();
    for (const s of ["EXPERIMENTAL: may change before 1.0", "--plugin <module>", '"agentopology": { "plugins"', "uses-plugins", "<id>/<name>", "agentopology/plugins", "apiVersion: 1", "runs with your rights at compile time", "Load only plugins\nyou trust", "loaded plugin <id>@<version> from <path>"]) {
      expect(page, s).toContain(s);
    }
  });
});

describe("safety errors name the plugin", () => {
  const variant = (over: Partial<AtPlugin> & Record<string, unknown>): AtPlugin => ({ ...acme, ...over }) as AtPlugin;

  it("a block keyword that is a core section", () => {
    const bad = variant({ blocks: { agent: { multiplicity: "repeated" } } });
    expect(() => parse(topo(), { plugins: [bad] })).toThrow(PluginError);
    expect(() => parse(topo(), { plugins: [bad] })).toThrow(/plugin acme: block keyword "agent" is a core section/);
  });

  it("an apiVersion other than 1", () => {
    expect(() => parse(topo(), { plugins: [variant({ apiVersion: 2 as unknown as 1 })] })).toThrow(/plugin acme is written for plugin API version 2; this agentopology supports apiVersion 1 only/);
  });

  it("a rule id outside the plugin's namespace", () => {
    for (const rule of ["widget-needs-a", "other/widget-needs-a", "acme/has space"]) {
      const bad = variant({ validate: () => [{ rule, level: "error", message: "x" }] });
      expect(() => validate(parse(topo(WIDGETS), { plugins: [bad] })), rule).toThrow(/plugin acme returned rule id/);
    }
  });

  it("a file path a core generator writes", () => {
    const bad = variant({ scaffold: { "claude-code": () => ({ files: [{ path: ".claude/agents/a/AGENT.md", content: "x" }] }) } });
    expect(() => scaffold(topo(), [bad])).toThrow(/plugin acme: file ".claude\/agents\/a\/AGENT.md" is a file the core claude-code scaffold writes/);
  });

  it("a hook a core generator writes", () => {
    const hooks = ["  hooks {", "    hook lint {", "      on: PreToolUse", '      matcher: "Bash"', '      run: "bash .claude/lint.sh"', "    }", "  }"].join("\n");
    const command = quiet(() => settings(scaffold(topo(hooks))).hooks!.PreToolUse[0].hooks[0].command);
    const bad = variant({ scaffold: { "claude-code": () => ({ settingsHooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command }] }] } }) } });
    expect(() => scaffold(topo(hooks), [bad])).toThrow(/plugin acme: its PreToolUse hook runs .* a hook the core claude-code scaffold writes/);
  });

  it("a hook that breaks the hook contract", () => {
    const bad = variant({ scaffold: { "claude-code": () => ({ settingsHooks: { NotAnEvent: [{ hooks: [{ type: "command", command: "true" }] }] } }) } });
    expect(() => scaffold(topo(), [bad])).toThrow(/plugin acme: its NotAnEvent hook breaks the Claude Code hook contract: "NotAnEvent" is not a Claude Code hook event/);
  });
});
