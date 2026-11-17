/**
 * Prose is never structure.
 *
 * The content of a `prompt { }` block, a quoted string and a `#` comment is
 * text. A block, a field or a block boundary written there (an example in an
 * agent's instructions, a brace in a description) is never read as part of
 * the topology: a `settings { }` example in a prompt used to replace the real
 * `settings { }` block that follows the agents, and a `tools: [...]` line in
 * a prompt became the agent's tools when the agent had none.
 */
import { describe, it, expect } from "vitest";
import { parse } from "../index.js";
import { validate } from "../validator.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import { serializeAST } from "../../import/serializer.js";
import { MERGED_SECTIONS, REPEATED_SECTIONS, SINGLE_SECTIONS } from "../sections.js";
import type { TopologyAST } from "../ast.js";

const ind = (s: string, n: number): string => s.replace(/^(?=.)/gm, " ".repeat(n));

/** A two-agent topology; `prose` goes inside alpha's prompt, `before`/`after` around the agents. */
const topo = (o: { prose?: string; before?: string; after?: string; alphaFields?: string; alphaDesc?: string; metaDesc?: string }): string => `topology t : [pipeline] {
  meta {
    version: "1.0.0"
    description: "${o.metaDesc ?? "prose test"}"
  }
${o.before ? ind(o.before, 2) + "\n" : ""}
  agent alpha {
    description: "${o.alphaDesc ?? "Alpha"}"
    model: sonnet
${o.alphaFields ? ind(o.alphaFields, 4) + "\n" : ""}    prompt {
      Example:
${ind(o.prose ?? "plain text", 6)}
    }
  }

  agent beta {
    model: haiku
    prompt {
      Do beta.
    }
  }
${o.after ? ind(o.after, 2) + "\n" : ""}
  flow {
    alpha -> beta
  }
}
`;

/** The same text with every prose line made bland, so only the prompt text differs. */
const bland = (prose: string): string => prose.split("\n").map(() => "text").join("\n");

/** An AST without the agents' prompt text, for comparing what the structure is. */
const structure = (ast: TopologyAST): unknown => {
  const copy = JSON.parse(JSON.stringify(ast));
  for (const n of copy.nodes) delete n.prompt;
  return copy;
};

const settingsJson = (src: string): { permissions?: { allow?: string[]; deny?: string[] } } => {
  const file = claudeCodeBinding.scaffold(parse(src)).find((f) => f.path === ".claude/settings.json");
  return file ? JSON.parse(file.content) : {};
};

const alpha = (ast: TopologyAST) => ast.nodes.find((n) => n.id === "alpha") as unknown as Record<string, unknown>;

describe("a section written in a prompt never replaces the real one", () => {
  it("a settings example in a prompt: the real settings block after the agents is used", () => {
    const src = topo({
      prose: 'settings {\n  allow: ["Bash"]\n}',
      after: 'settings {\n  deny: ["Bash(rm:*)", "Read(./.env)"]\n}',
    });
    const ast = parse(src);
    expect(ast.settings).toEqual({ allow: [], deny: ["Bash(rm:*)", "Read(./.env)"], ask: [] });
    const json = settingsJson(src);
    expect(json.permissions?.deny).toEqual(["Bash(rm:*)", "Read(./.env)"]);
    expect(json.permissions?.allow ?? []).not.toContain("Bash");
    // The example is not a second settings block.
    expect(validate(ast).filter((r) => r.rule === "V23")).toEqual([]);
  });

  it("a settings example in a prompt and no real settings: no settings", () => {
    const ast = parse(topo({ prose: 'settings {\n  allow: ["Bash"]\n}' }));
    expect(ast.settings).toEqual({});
  });

  it("a gates example in a prompt: the real gate is used", () => {
    const ast = parse(topo({
      prose: 'gates {\n  gate demo {\n    after: alpha\n    before: beta\n    run: "scripts/demo-gate.sh"\n    on-fail: halt\n  }\n}',
      after: 'gates {\n  gate real {\n    after: alpha\n    before: beta\n    run: "scripts/real-gate.sh"\n    on-fail: halt\n  }\n}',
    }));
    expect(ast.nodes.filter((n) => n.type === "gate").map((n) => n.id)).toEqual(["real"]);
  });

  it("an mcp-servers example in a prompt: the real servers are used", () => {
    const ast = parse(topo({
      prose: 'mcp-servers {\n  demo {\n    type: stdio\n    command: "curl"\n  }\n}',
      after: 'mcp-servers {\n  real {\n    type: stdio\n    command: "npx"\n  }\n}',
    }));
    expect(Object.keys(ast.mcpServers)).toEqual(["real"]);
  });

  it("a triggers example in a prompt: the real commands are used", () => {
    const ast = parse(topo({
      prose: 'triggers {\n  command demo {\n    pattern: "/demo"\n  }\n}',
      after: 'triggers {\n  command real {\n    pattern: "/real"\n  }\n}',
    }));
    expect(ast.triggers.map((t) => t.name)).toEqual(["real"]);
  });

  it("an extensions example in a prompt: the real topology extensions are used", () => {
    const ast = parse(topo({
      prose: "extensions {\n  claude-code {\n    defaultMode: bypassPermissions\n  }\n}",
      after: "extensions {\n  claude-code {\n    defaultMode: plan\n  }\n}",
    }));
    expect(ast.extensions).toEqual({ "claude-code": { defaultMode: "plan" } });
    expect(alpha(ast).extensions).toBeUndefined();
  });

  // Every section the parser reads at the top level, as an example in a
  // prompt, with and without an id: the structure is what it is with bland
  // prose of the same shape.
  const keywords = [...SINGLE_SECTIONS, ...REPEATED_SECTIONS, ...MERGED_SECTIONS];
  for (const kw of keywords) {
    for (const head of [`${kw} {`, `${kw} demo {`]) {
      it(`\`${head} }\` in a prompt is text`, () => {
        const prose = `${head}\n  description: "from prose"\n  model: opus\n  hook h {\n    on: PreToolUse\n    run: "x.sh"\n  }\n}`;
        const withProse = parse(topo({ prose }));
        const without = parse(topo({ prose: bland(prose) }));
        expect(structure(withProse)).toEqual(structure(without));
        expect(alpha(withProse).prompt).toContain(head);
      });
    }
  }
});

describe("a field exists only where a field is written", () => {
  const cases: Array<[string, { prose?: string; alphaFields?: string; alphaDesc?: string }, string]> = [
    ["tools line in a prompt", { prose: "The agent file has a line like\ntools: [Bash, Write]\nin it." }, "tools"],
    ["disallowed-tools line in a prompt", { alphaFields: "tools: [Read, Bash]", prose: "Never write\ndisallowed-tools: [Read]\nin a file." }, "disallowedTools"],
    ["skills line in a prompt", { prose: "skills: [deploy]" }, "skills"],
    ["mcp-servers line in a prompt", { prose: "mcp-servers: [prod-db]" }, "mcpServers"],
    ["reads/writes lines in a prompt", { prose: "reads: [secrets]\nwrites: [prod]" }, "reads"],
    ["an agent hook in a prompt", { prose: 'hooks {\n  hook demo {\n    on: PreToolUse\n    run: "scripts/demo.sh"\n  }\n}' }, "hooks"],
    ["an agent extensions block in a prompt", { prose: 'extensions {\n  claude-code {\n    permissionMode: "bypassPermissions"\n  }\n}' }, "extensions"],
    ["a retry block in a prompt", { prose: "retry {\n  max: 9\n}" }, "retry"],
    ["a scale block in a prompt", { prose: "scale {\n  mode: auto\n  max: 9\n}" }, "scale"],
    ["a custodian-of line in a prompt", { prose: "custodian-of: [vault]" }, "custodianOf"],
    ["tools text in the description", { alphaDesc: "Use tools: [Bash, Write] wisely" }, "tools"],
    ["disallowed-tools text in the description", { alphaDesc: "note disallowed-tools: [Read] is bad" }, "disallowedTools"],
  ];
  for (const [name, o, key] of cases) {
    it(`${name}: no ${key}`, () => {
      const a = alpha(parse(topo(o)));
      expect(a[key]).toBeUndefined();
    });
  }

  it("a field written after a prompt that shows the same key: the field wins", () => {
    const a = alpha(parse(topo({ prose: "tools: [Bash, Write]\ndisallowed-tools: [Read]" }).replace("    }\n  }\n\n  agent beta", "    }\n    tools: [Read]\n  }\n\n  agent beta")));
    expect(a.tools).toEqual(["Read"]);
    expect(a.disallowedTools).toBeUndefined();
  });

  it("a scalar line in a prompt is not a field", () => {
    const a = alpha(parse(topo({ prose: "permissions: unrestricted\nmax-turns: 99\nisolation: worktree\nbackground: true" })));
    expect(a.permissions).toBeUndefined();
    expect(a.maxTurns).toBeUndefined();
    expect(a.isolation).toBeUndefined();
    expect(a.background).toBeUndefined();
  });

  it("a variant's prompt and a skill's prompt are text too", () => {
    const src = topo({
      alphaFields: 'variants {\n  variant v1 {\n    weight: 1\n    prompt {\n      model: opus\n      temperature: 2\n    }\n  }\n}',
      after: 'skills {\n  skill s {\n    description: "s"\n    prompt {\n      allowed-tools: [Bash]\n      disallowed-tools: [Read]\n      extensions {\n        claude-code {\n          effort: max\n        }\n      }\n    }\n  }\n}',
    });
    const ast = parse(src);
    const v = (alpha(ast).variants as Array<Record<string, unknown>>)[0];
    expect(v.model).toBeUndefined();
    expect(v.temperature).toBeUndefined();
    const s = ast.skills[0] as unknown as Record<string, unknown>;
    expect(s.allowedTools).toBeUndefined();
    expect(s.disallowedTools).toBeUndefined();
    expect(s.extensions).toBeUndefined();
  });

  it("settings text in the meta description is not a settings block", () => {
    const ast = parse(topo({ metaDesc: "settings { allow: [Bash] } example" }));
    expect(ast.settings).toEqual({});
  });

  it("a settings block in a comment is not a settings block", () => {
    const ast = parse(topo({ after: '# settings {\n#   allow: ["Bash"]\n# }' }));
    expect(ast.settings).toEqual({});
  });
});

// todo: brace inside a quoted string: a follow-up release with its own
// declared differential. Block depth is still counted on the source, as in
// 0.11.4, so a `{` or `}` inside quotes counts; these cases record the target.
describe.todo("a brace inside a quoted string is text", () => {
  const messages = (src: string): string[] =>
    validate(parse(src)).filter((r) => ["V4", "V7", "V102"].includes(r.rule)).map((r) => `${r.rule} ${r.message}`);

  for (const desc of ["}", "{", "use {curly} braces } here", "a } b { c"]) {
    it(`description "${desc}": fields after it are read and nothing is reported`, () => {
      const src = topo({ alphaDesc: desc, alphaFields: "tools: [Read, Grep]" });
      const a = alpha(parse(src));
      expect(a.description).toBe(desc);
      expect(a.model).toBe("sonnet");
      expect(a.tools).toEqual(["Read", "Grep"]);
      expect(a.prompt).toContain("plain text");
      expect(parse(src).nodes.map((n) => n.id)).toEqual(["alpha", "beta"]);
      expect(messages(src)).toEqual([]);
    });
  }

  it('a "}" in the meta description: the sections after it are read', () => {
    const src = topo({ metaDesc: "closes } early", after: 'settings {\n  deny: ["Bash(rm:*)"]\n}' });
    const ast = parse(src);
    expect(ast.topology.description).toBe("closes } early");
    expect(ast.settings).toEqual({ allow: [], deny: ["Bash(rm:*)"], ask: [] });
    expect(messages(src)).toEqual([]);
  });

  it('a "{" in a hook command: the next hook is read', () => {
    const src = topo({
      after: 'hooks {\n  hook one {\n    on: PreToolUse\n    run: "echo {"\n  }\n  hook two {\n    on: PostToolUse\n    run: "echo two"\n  }\n}',
    });
    const ast = parse(src);
    expect(ast.hooks.map((h) => h.name)).toEqual(["one", "two"]);
    expect(ast.hooks[0].run).toBe("echo {");
    expect(messages(src)).toEqual([]);
  });

  it('a description holding "}" round-trips through the serializer', () => {
    const ast = parse(topo({ alphaDesc: "ends with }" }));
    const again = parse(serializeAST(ast));
    expect(alpha(again).description).toBe("ends with }");
    expect(validate(again).filter((r) => r.level === "error")).toEqual([]);
  });
});
