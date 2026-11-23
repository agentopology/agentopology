/**
 * No block in a .at is dropped without a message.
 *
 * `hooks { }` may be written more than once: every block's hooks arrive, in
 * file order; a hook name used in two blocks is an error, twice in one block
 * a warning. Every other section is single: a second one is a V23 warning
 * (as in 0.11.4), never silent. A second `hooks { }` block used to validate
 * and vanish from settings.json.
 */
import { describe, it, expect } from "vitest";
import { parse } from "../index.js";
import { validate } from "../validator.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import { TOPOLOGY_BLOCKS } from "../known-fields.js";
import { CHILD_KEYWORDS, MERGED_SECTIONS, REPEATED_SECTIONS, SINGLE_SECTIONS } from "../sections.js";

const HEAD = [
  "topology t : [pipeline] {",
  '  meta { version: "1.0.0"',
  '    description: "two blocks" }',
  "  orchestrator { model: sonnet }",
  "  agent a { model: sonnet",
  "    prompt { Do a. } }",
  "  agent b { model: sonnet",
  "    prompt { Do b. } }",
  "  flow { a -> b }",
].join("\n");

const topo = (...blocks: string[]): string => `${HEAD}\n${blocks.join("\n")}\n}\n`;

const hooksBlock = (...names: string[]): string =>
  ["  hooks {", ...names.map((n) => `    hook ${n} {\n      on: PreToolUse\n      matcher: "Bash"\n      run: "echo ${n}"\n    }`), "  }"].join("\n");

const settingsJson = (src: string): { hooks?: Record<string, Array<{ hooks: Array<{ command: string }> }>> } => {
  const file = claudeCodeBinding.scaffold(parse(src)).find((f) => f.path === ".claude/settings.json");
  return JSON.parse(file!.content);
};

const commands = (src: string): string[] =>
  (settingsJson(src).hooks?.PreToolUse ?? []).flatMap((g) => g.hooks.map((h) => h.command));

describe("two hooks { } blocks", () => {
  it("both blocks' hooks arrive in settings.json, in file order", () => {
    const src = topo(hooksBlock("one"), hooksBlock("two"));
    expect(validate(parse(src)).filter((r) => r.level === "error")).toEqual([]);
    expect(parse(src).hooks.map((h) => h.name)).toEqual(["one", "two"]);
    const cmds = commands(src).join("\n");
    expect(cmds).toContain("echo one");
    expect(cmds).toContain("echo two");
    expect(cmds.indexOf("echo one")).toBeLessThan(cmds.indexOf("echo two"));
  });

  it("three blocks, several hooks each: all arrive", () => {
    const src = topo(hooksBlock("one", "two"), hooksBlock("three"), hooksBlock("four", "five"));
    expect(parse(src).hooks.map((h) => h.name)).toEqual(["one", "two", "three", "four", "five"]);
  });

  it("a hook name used in two blocks is an error that names the hook and both lines", () => {
    const src = topo(hooksBlock("guard"), hooksBlock("guard"));
    const errors = validate(parse(src)).filter((r) => r.level === "error");
    const dup = errors.filter((r) => /guard/.test(r.message) && /hook/i.test(r.message));
    expect(dup).toHaveLength(1);
    // HEAD is 9 lines; the first hooks block opens on line 10, the second on 17.
    expect(dup[0].message).toMatch(/\b10\b/);
    expect(dup[0].message).toMatch(/\b17\b/);
  });

  it("a hook name used twice in one block is a warning (it validated in 0.11.4, both hooks kept)", () => {
    const src = topo(hooksBlock("guard", "guard"));
    const found = validate(parse(src)).filter((r) => r.rule === "V23" && /guard/.test(r.message));
    expect(found).toHaveLength(1);
    expect(found[0].level).toBe("warning");
  });

  it("an agent's own hooks block is not a second top-level one", () => {
    const src = topo(hooksBlock("one")).replace(
      "  agent b { model: sonnet",
      '  agent b { model: sonnet\n    hooks {\n      hook one {\n        on: PostToolUse\n        run: "echo agent"\n      }\n    }',
    );
    expect(validate(parse(src)).filter((r) => r.level === "error")).toEqual([]);
    expect(parse(src).hooks.map((h) => h.name)).toEqual(["one"]);
    expect(commands(src).join("\n")).toContain("echo one");
  });

  it("a top-level hook named like an agent's hook is kept beside the other top-level hooks", () => {
    const src = topo(hooksBlock("one", "two")).replace(
      "  agent b { model: sonnet",
      '  agent b { model: sonnet\n    hooks {\n      hook one {\n        on: PostToolUse\n        run: "echo agent"\n      }\n    }',
    );
    expect(parse(src).hooks.map((h) => h.name)).toEqual(["one", "two"]);
    expect(commands(src).join("\n")).toContain("echo one");
  });
});

/**
 * Every top-level section that may appear once, with a body whose second copy
 * would be lost. Two of any of them is a V23 warning that names the section,
 * never silent.
 */
const SINGLE: Record<string, (m: string) => string> = {
  meta: (m) => `meta { version: "1.0.0"\n description: "${m}" }`,
  orchestrator: (m) => `orchestrator { model: ${m} }`,
  roles: (m) => `roles { ${m}: "x" }`,
  flow: (m) => `flow { a -> ${m} }`,
  gates: (m) => `gates {\n gate ${m} { after: a\n run: "scripts/${m}.sh" }\n }`,
  schedule: (m) => `schedule {\n job ${m} { cron: "0 * * * *"\n agent: a }\n }`,
  tools: (m) => `tools {\n tool ${m} { script: "scripts/${m}.sh"\n description: "d" }\n }`,
  artifacts: (m) => `artifacts {\n artifact ${m} { type: document\n path: "${m}.md" }\n }`,
  records: (m) => `records {\n record ${m} { path: "${m}.md" }\n }`,
  machines: (m) => `machines {\n machine ${m} { os: "linux" }\n }`,
  depth: (m) => `depth {\n factors: [${m}]\n }`,
  memory: (m) => `memory {\n workspace { path: "${m}/" }\n }`,
  batch: (m) => `batch { parallel: true\n per: ${m} }`,
  environments: (m) => `environments {\n ${m} { model: haiku }\n }`,
  triggers: (m) => `triggers {\n command ${m} { pattern: "/${m}" }\n }`,
  settings: (m) => `settings {\n allow: ["Bash(${m}:*)"]\n }`,
  "mcp-servers": (m) => `mcp-servers {\n ${m} { command: "npx" }\n }`,
  metering: (m) => `metering { track: [${m}]\n per: [agent]\n output: "m/"\n format: jsonl\n pricing: anthropic-current }`,
  context: (m) => `context { includes: ["${m}.md"] }`,
  env: (m) => `env { ${m.toUpperCase()}: "1" }`,
  providers: (m) => `providers {\n ${m} { models: [opus] }\n }`,
  interfaces: (m) => `interfaces {\n ${m} { type: slack }\n }`,
  defaults: (m) => `defaults { timeout: 5m }`,
  schemas: (m) => `schemas {\n schema ${m} { f: string }\n }`,
  observability: (m) => `observability { enabled: true\n service-name: "${m}" }`,
  checkpoint: (m) => `checkpoint { backend: ${m} }`,
  extensions: (m) => `extensions {\n claude-code { ${m}: "1" }\n }`,
  params: (m) => `params {\n ${m}: string\n }`,
  interface: (m) => `interface { entry: a\n exit: ${m} }`,
  inventory: (m) => `inventory { roots: ["${m}/"] }`,
  needs: (m) => `needs { memory: "~/${m}" }`,
  "threat-model": (m) => `threat-model { untrusted: ["${m}/**"] }`,
};

// HEAD already holds one of these.
const IN_HEAD = new Set(["meta", "orchestrator", "flow"]);

describe("a second copy of a single section is a V23 warning, never silent", () => {
  for (const [keyword, block] of Object.entries(SINGLE)) {
    it(`two "${keyword}" blocks`, () => {
      const src = IN_HEAD.has(keyword) ? topo(block("second")) : topo(block("first"), block("second"));
      const v23 = validate(parse(src)).filter((r) => r.rule === "V23");
      expect(v23).toHaveLength(1);
      expect(v23[0].level).toBe("warning");
      expect(v23[0].message).toContain(`"${keyword}"`);
    });
  }

  it("V131 says nothing about the unused copy: it is not a lost block", () => {
    for (const [keyword, block] of Object.entries(SINGLE)) {
      const src = IN_HEAD.has(keyword) ? topo(block("second")) : topo(block("first"), block("second"));
      const v131 = validate(parse(src)).filter((r) => r.rule === "V131");
      expect(v131, keyword).toEqual([]);
    }
  });

  it("one of each validates without V23", () => {
    for (const [keyword, block] of Object.entries(SINGLE)) {
      if (IN_HEAD.has(keyword)) continue;
      const v23 = validate(parse(topo(block("only")))).filter((r) => r.rule === "V23");
      expect(v23, keyword).toEqual([]);
    }
  });
});

describe("sections made of named entries keep every occurrence", () => {
  it("two skills { } blocks: both skills arrive", () => {
    const src = topo('  skills {\n    skill one { description: "d" }\n  }', '  skills {\n    skill two { description: "d" }\n  }');
    expect(validate(parse(src)).filter((r) => r.rule === "V23")).toEqual([]);
    expect(parse(src).skills.map((s) => s.id)).toEqual(["one", "two"]);
  });

  it("two person blocks: both arrive", () => {
    const src = topo('  person ann { away: "x" }', '  person bob { away: "y" }');
    expect(validate(parse(src)).filter((r) => r.rule === "V23")).toEqual([]);
    expect(parse(src).persons?.map((p) => p.id)).toEqual(["ann", "bob"]);
  });
});

describe("every top-level block has one count rule", () => {
  const lists: Record<string, readonly string[]> = {
    single: SINGLE_SECTIONS, merged: MERGED_SECTIONS, repeated: REPEATED_SECTIONS, child: CHILD_KEYWORDS,
  };

  it("each block the parser knows is in exactly one list", () => {
    for (const keyword of TOPOLOGY_BLOCKS) {
      const homes = Object.entries(lists).filter(([, l]) => l.includes(keyword)).map(([k]) => k);
      expect(homes, keyword).toHaveLength(1);
    }
  });

  it("each listed keyword is a block the parser knows", () => {
    for (const keyword of Object.values(lists).flat()) expect(TOPOLOGY_BLOCKS, keyword).toContain(keyword);
  });

  it("this file pins every single section", () => {
    expect(Object.keys(SINGLE).sort()).toEqual([...SINGLE_SECTIONS].sort());
  });
});
