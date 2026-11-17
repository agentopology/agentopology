/**
 * The .at states it, Claude Code must get it at the documented place.
 *
 * Claude Code ignores a key it does not know, silently. Each case below
 * validated clean and then wrote the value nowhere, at the wrong level, or
 * under a key Claude Code has no use for. Either the value lands where the
 * Claude Code docs put it, or validation says it cannot (rule V130).
 */

import { describe, it, expect } from "vitest";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { claudeCodeBinding } from "../claude-code.js";

const topo = (body: string, topExtra = "") => `topology t : [pipeline] {
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
${body}
  flow {
    intake -> a
  }
${topExtra}
}`;

const agentA = (extra = "") => `  agent a {
    model: sonnet
    description: "worker"
    prompt { Do the work. }
${extra}
  }`;

function build(src: string) {
  const ast = parse(src);
  const results = validate(ast);
  const files = claudeCodeBinding.scaffold(ast);
  const settingsFile = files.find((f) => f.path === ".claude/settings.json");
  const settings = settingsFile ? JSON.parse(settingsFile.content) : {};
  const agent = files.find((f) => f.path === ".claude/agents/a/AGENT.md")?.content ?? "";
  const skill = (id: string) => files.find((f) => f.path === `.claude/skills/${id}/SKILL.md`)?.content ?? "";
  const errors = results.filter((r) => r.level === "error");
  const v130 = results.filter((r) => r.rule === "V130");
  return { ast, results, errors, v130, files, settings, agent, skill };
}

/** The YAML frontmatter block at the top of a generated markdown file. */
const fmOf = (md: string) => md.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";

describe("settings the .at states land at the documented settings.json path", () => {
  it("settings { sandbox: true } turns on sandbox.enabled", () => {
    const b = build(topo(agentA(), `  settings {\n    sandbox: true\n  }`));
    expect(b.errors).toEqual([]);
    expect(b.settings.sandbox).toEqual({ enabled: true });
  });

  it("settings { sandbox: false } writes sandbox.enabled false", () => {
    const b = build(topo(agentA(), `  settings {\n    sandbox: false\n  }`));
    expect(b.settings.sandbox).toEqual({ enabled: false });
  });

  it("settings { fallback-chain } becomes fallbackModel, in order", () => {
    const b = build(topo(agentA(), `  settings {\n    fallback-chain: [sonnet, haiku]\n  }`));
    expect(b.errors).toEqual([]);
    expect(b.settings.fallbackModel).toEqual(["sonnet", "haiku"]);
  });

  it("a topology extension defaultMode lands under permissions, not at the top level", () => {
    const b = build(topo(agentA(), `  extensions {\n    claude-code {\n      defaultMode: plan\n    }\n  }`));
    expect(b.errors).toEqual([]);
    expect(b.settings.defaultMode).toBeUndefined();
    expect(b.settings.permissions?.defaultMode).toBe("plan");
  });

  it("a topology extension additionalDirectories lands under permissions as a list, not a string", () => {
    const b = build(topo(agentA(), `  extensions {\n    claude-code {\n      additionalDirectories: ["../shared", "../docs"]\n    }\n  }`));
    expect(b.errors).toEqual([]);
    expect(b.settings.additionalDirectories).toBeUndefined();
    expect(b.settings.permissions?.additionalDirectories).toEqual(["../shared", "../docs"]);
  });

  it("a dotted extension key lands at its nested path, beside the .at's own permissions", () => {
    const b = build(topo(agentA(), `  settings {\n    deny: ["Bash(rm *)"]\n  }\n  extensions {\n    claude-code {\n      permissions.defaultMode: acceptEdits\n      sandbox.autoAllowBashIfSandboxed: true\n    }\n  }`));
    expect(b.errors).toEqual([]);
    expect(b.settings.permissions).toEqual({ deny: ["Bash(rm *)"], defaultMode: "acceptEdits" });
    expect(b.settings.sandbox).toEqual({ autoAllowBashIfSandboxed: true });
  });

  it("a top-level settings key in the extension stays at the top level", () => {
    const b = build(topo(agentA(), `  extensions {\n    claude-code {\n      outputStyle: "Explanatory"\n    }\n  }`));
    expect(b.errors).toEqual([]);
    expect(b.settings.outputStyle).toBe("Explanatory");
  });

  it("an unknown topology extension key is an error naming the nearest known key", () => {
    const b = build(topo(agentA(), `  extensions {\n    claude-code {\n      defaultMod: plan\n    }\n  }`));
    expect(b.v130.some((r) => r.level === "warning" && /defaultMod\b/.test(r.message) && /permissions\.defaultMode/.test(r.message))).toBe(true);
    // A warning, not an error (a patch release keeps the file valid), and the key is not written.
    expect(b.errors).toEqual([]);
    expect(JSON.stringify(b.settings)).not.toContain("defaultMod\"");
  });

  it("an extension value outside the documented values is an error", () => {
    const b = build(topo(agentA(), `  extensions {\n    claude-code {\n      defaultMode: yolo\n    }\n  }`));
    expect(b.v130.some((r) => r.level === "warning" && /yolo/.test(r.message))).toBe(true);
  });

  it("a settings key a project file cannot set is an error", () => {
    const b = build(topo(agentA(), `  extensions {\n    claude-code {\n      skipAutoPermissionPrompt: true\n    }\n  }`));
    expect(b.v130.some((r) => r.level === "warning" && /skipAutoPermissionPrompt/.test(r.message))).toBe(true);
    expect(b.settings.skipAutoPermissionPrompt).toBeUndefined();
  });
});

describe("agent frontmatter carries only Claude Code keys", () => {
  it("an agent's sandbox and fallback-chain are not written as frontmatter, and validation says so", () => {
    const b = build(topo(agentA(`    sandbox: "network-only"\n    fallback-chain: [haiku, sonnet]`)));
    const fm = fmOf(b.agent);
    expect(fm).not.toMatch(/^sandbox:/m);
    expect(fm).not.toMatch(/^fallback-chain:/m);
    expect(b.v130.some((r) => r.level === "warning" && /sandbox/.test(r.message))).toBe(true);
    expect(b.v130.some((r) => r.level === "warning" && /fallback-chain/.test(r.message))).toBe(true);
  });

  it("a numeric agent extension value is written (autoCompactWindow)", () => {
    const b = build(topo(agentA(`    extensions {\n      claude-code {\n        autoCompactWindow: 200000\n      }\n    }`)));
    expect(b.errors).toEqual([]);
    expect(fmOf(b.agent)).toMatch(/^autoCompactWindow: 200000$/m);
  });

  it("an agent extension memory scope is written", () => {
    const b = build(topo(agentA(`    extensions {\n      claude-code {\n        memory: project\n      }\n    }`)));
    expect(b.errors).toEqual([]);
    expect(fmOf(b.agent)).toMatch(/^memory: project$/m);
  });

  it("an unknown agent extension key is an error naming the nearest known key", () => {
    const b = build(topo(agentA(`    extensions {\n      claude-code {\n        maxturns: 5\n      }\n    }`)));
    expect(b.v130.some((r) => r.level === "warning" && /maxturns/.test(r.message) && /maxTurns/.test(r.message))).toBe(true);
    expect(b.errors).toEqual([]);
    expect(fmOf(b.agent)).not.toMatch(/^maxturns:/m);
  });

  it("an agent extension value outside the documented values is an error", () => {
    const b = build(topo(agentA(`    extensions {\n      claude-code {\n        color: magenta\n      }\n    }`)));
    expect(b.v130.some((r) => r.level === "warning" && /magenta/.test(r.message))).toBe(true);
    expect(fmOf(b.agent)).not.toMatch(/^color:/m);
  });
});

describe("skill frontmatter takes the skill's claude-code extension", () => {
  const withSkill = (ext: string) => topo(agentA(), `  skill helper {\n    description: "helps"\n    prompt: "Help."\n    extensions {\n      claude-code {\n${ext}\n      }\n    }\n  }`);

  it("schema-known skill extension keys reach SKILL.md", () => {
    const b = build(withSkill(`        background: false\n        compatibility: "needs git"`));
    expect(b.errors).toEqual([]);
    const fm = fmOf(b.skill("helper"));
    expect(fm).toMatch(/^background: false$/m);
    expect(fm).toMatch(/^compatibility: needs git$/m);
  });

  it("an unknown skill extension key is an error naming the nearest known key", () => {
    const b = build(withSkill(`        when-to-use: "on deploy"`));
    expect(b.v130.some((r) => r.level === "warning" && /when-to-use/.test(r.message) && /when_to_use/.test(r.message))).toBe(true);
    expect(b.errors).toEqual([]);
    expect(fmOf(b.skill("helper"))).not.toMatch(/^when-to-use:/m);
  });
});
