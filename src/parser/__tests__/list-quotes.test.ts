/**
 * A list item in quotes is one item, whatever it holds.
 *
 * A permission rule may hold a glob class (`Bash(rm -rf [a-z]*)`) or a comma.
 * The list reader used to stop at the first `]` and split at every comma, so
 * a deny list lost every rule after the first bracket and validate passed.
 * Every list path is pinned here; a list that is not closed, or a quoted item
 * that is not closed, stops the parse with a message instead of keeping part
 * of the list.
 */
import { describe, it, expect } from "vitest";
import { parse } from "../index.js";
import { validate } from "../validator.js";
import { parseList, parseMultilineList } from "../lexer.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import { coerceCcValue, ccKey } from "../../bindings/claude-code-schema.js";
import { codexBinding } from "../../bindings/codex.js";
import { codexSource } from "../../bindings/__tests__/codex-models.js";
import { parse as parseToml } from "smol-toml";
import type { AgentNode } from "../ast.js";

const DENY = ['"Bash(rm -rf [a-z]*)"', '"Read(./.env)"', '"Bash(curl:*)"'];
const DENY_OUT = ["Bash(rm -rf [a-z]*)", "Read(./.env)", "Bash(curl:*)"];

const topo = (agentExtra: string, extra = ""): string => `topology t : [pipeline] {
  meta {
    version: "1.0.0"
    description: "lists"
  }
  agent alpha {
    description: "Alpha"
    model: sonnet
${agentExtra}
    prompt {
      x
    }
  }
  agent beta {
    model: haiku
    prompt {
      Do beta.
    }
  }
${extra}
  flow {
    alpha -> beta
  }
}
`;

const alpha = (src: string): AgentNode => parse(src).nodes.find((n) => n.id === "alpha") as AgentNode;
const file = (src: string, p: string): string => claudeCodeBinding.scaffold(parse(src)).find((f) => f.path === p)!.content;

describe("a quoted list item holding ] or a comma", () => {
  const src = topo(
    '    disallowed-tools: ["Bash(rm [a-z]*)", Write, Edit]',
    `  settings {\n    deny: [${DENY.join(", ")}]\n    allow: ["Read"]\n  }`,
  );

  it("settings deny keeps every rule, and validate has no error", () => {
    const ast = parse(src);
    expect(ast.settings?.deny).toEqual(DENY_OUT);
    expect(ast.settings?.allow).toEqual(["Read"]);
    expect(validate(ast).filter((r) => r.level === "error")).toEqual([]);
  });

  it("settings.json carries all three deny rules", () => {
    const s = JSON.parse(file(src, ".claude/settings.json"));
    expect(s.permissions.deny).toEqual(DENY_OUT);
  });

  it("an agent's disallowed-tools keeps every tool, in the AST and in the agent file", () => {
    expect(alpha(src).disallowedTools).toEqual(["Bash(rm [a-z]*)", "Write", "Edit"]);
    const agentFile = file(src, ".claude/agents/alpha/AGENT.md");
    expect(agentFile).toContain("Bash(rm [a-z]*)");
    expect(agentFile).toContain("Write");
    expect(agentFile).toContain("Edit");
  });

  it("allow and ask read the same way, across lines too", () => {
    const s = parse(topo("", `  settings {\n    allow: [\n      "Bash(ls [ab]*)",\n      "Read"\n    ]\n    ask: ["Bash(git push [x]*)", "Write"]\n  }`)).settings!;
    expect(s.allow).toEqual(["Bash(ls [ab]*)", "Read"]);
    expect(s.ask).toEqual(["Bash(git push [x]*)", "Write"]);
  });

  it("a comma inside quotes stays inside the item", () => {
    expect(parse(topo("", '  settings {\n    deny: ["Bash(git commit -m a, b)", "Read"]\n  }')).settings!.deny).toEqual(["Bash(git commit -m a, b)", "Read"]);
  });

  it("an unquoted item with balanced brackets stays one item", () => {
    expect(alpha(topo("    tools: [Bash(rm [a-z]*), Read]")).tools).toEqual(["Bash(rm [a-z]*)", "Read"]);
  });

  it("agent tools, skills, reads, writes, mcp-servers", () => {
    const a = alpha(topo([
      '    tools: ["Bash(ls [a-z]*)", Read]',
      '    skills: ["s[1]", helper]',
      '    reads: ["docs/[a-z]*.md", "a.md"]',
      '    writes: ["out/[0-9].txt", "b.md"]',
      '    mcp-servers: ["db[1]", other]',
    ].join("\n")));
    expect(a.tools).toEqual(["Bash(ls [a-z]*)", "Read"]);
    expect(a.skills).toEqual(["s[1]", "helper"]);
    expect(a.reads).toEqual(["docs/[a-z]*.md", "a.md"]);
    expect(a.writes).toEqual(["out/[0-9].txt", "b.md"]);
    expect(a.mcpServers).toEqual(["db[1]", "other"]);
  });

  it("a skill's allowed-tools, disallowed-tools, paths and arguments", () => {
    const ast = parse(topo("", [
      "  skills {",
      "    skill helper {",
      '      description: "Helps"',
      '      paths: ["docs/[a-z]*.md", "src/**"]',
      '      arguments: ["[issue]", all]',
      '      allowed-tools: ["Bash(git commit:*)", "Bash(rm [a-z]*)", Read]',
      '      disallowed-tools: ["Bash(curl [x]*)", Write]',
      "    }",
      "  }",
    ].join("\n")));
    const sk = ast.skills!.find((s) => s.id === "helper")!;
    expect(sk.paths).toEqual(["docs/[a-z]*.md", "src/**"]);
    expect(sk.arguments).toEqual(["[issue]", "all"]);
    expect(sk.allowedTools).toEqual(["Bash(git commit:*)", "Bash(rm [a-z]*)", "Read"]);
    expect(sk.disallowedTools).toEqual(["Bash(curl [x]*)", "Write"]);
  });

  it("a hook matcher holding brackets is kept whole", () => {
    const ast = parse(topo("", '  hooks {\n    hook g {\n      on: PreToolUse\n      matcher: "Bash(rm [a-z]*)"\n      run: "echo g"\n    }\n  }'));
    expect(ast.hooks.find((h) => h.name === "g")!.matcher).toBe("Bash(rm [a-z]*)");
  });

  it("inventory roots, needs lists and decisions", () => {
    const ast = parse(topo("", [
      '  inventory {\n    roots: ["harness/[x]/", "more/"]\n  }',
      '  needs {\n    connectors: ["mail[1]", "cal"]\n    user-skills: ["a]b", c]\n  }',
      '  decisions: ["pick [x]", other]',
    ].join("\n")));
    expect(ast.inventoryRoots).toEqual(["harness/[x]/", "more/"]);
    expect(ast.needs?.connectors).toEqual(["mail[1]", "cal"]);
    expect(ast.needs?.userSkills).toEqual(["a]b", "c"]);
    expect(ast.decisions).toEqual(["pick [x]", "other"]);
  });

  it("a Claude Code extension list keeps a quoted comma and bracket; a malformed one is refused, not split", () => {
    expect(coerceCcValue(ccKey("settings", "permissions.additionalDirectories"), '["../a,b", "../[x]"]')).toEqual({ ok: true, value: ["../a,b", "../[x]"] });
    expect(coerceCcValue(ccKey("settings", "permissions.additionalDirectories"), '["../a", "../b"')).toMatchObject({ ok: false });
  });

  it("an MCP server's args and enabled-tools keep a quoted comma and bracket (Codex)", () => {
    const src = topo("", [
      "  mcp-servers {",
      "    pager {",
      '      command: "npx"',
      '      args: ["-y", "--only=a,b", "--glob=[a-z]*"]',
      '      enabled-tools: ["page[1]", "a,ck"]',
      "    }",
      "  }",
    ].join("\n"));
    const toml = parseToml(codexBinding.scaffold(parse(codexSource(src))).find((f) => f.path === ".codex/config.toml")!.content) as {
      mcp_servers: Record<string, { args: string[]; enabled_tools: string[] }>;
    };
    expect(toml.mcp_servers.pager.args).toEqual(["-y", "--only=a,b", "--glob=[a-z]*"]);
    expect(toml.mcp_servers.pager.enabled_tools).toEqual(["page[1]", "a,ck"]);
  });
});

describe("a list that is not closed is an error, never part of a list", () => {
  it("an unclosed list", () => {
    expect(() => parse(topo("", '  settings {\n    deny: ["Bash(rm:*)", "Read(./.env)"\n  }'))).toThrow(/deny/);
  });

  it("an unclosed quoted item", () => {
    expect(() => parse(topo("", '  settings {\n    deny: ["Bash(rm:*), "Read(./.env)"]\n  }'))).toThrow(/deny/);
  });

  it("an unquoted item with an unmatched ] (text left after the list ends)", () => {
    expect(() => parse(topo("    disallowed-tools: [Bash(rm a-z]*), Write]"))).toThrow(/disallowed-tools/);
  });

  it("the lexer: closed lists read the same as before", () => {
    expect(parseList("[a, b, c]")).toEqual(["a", "b", "c"]);
    expect(parseList('["a", "b"]')).toEqual(["a", "b"]);
    expect(parseList("[]")).toEqual([]);
    expect(parseList("solo")).toEqual(["solo"]);
    expect(parseMultilineList("tools: [\n  a,\n  b,\n]", "tools")).toEqual(["a", "b"]);
    expect(parseMultilineList("other: x", "tools")).toEqual([]);
  });

  it("another field on the list's line is not an error", () => {
    expect(parseMultilineList('commands: ["./tool publish"] unit-from: "x"', "commands")).toEqual(["./tool publish"]);
    expect(parseMultilineList("hook h { matcher: x tools: [a, b] }", "tools")).toEqual(["a", "b"]);
  });
});

describe("list-like text in prose is never a parse error", () => {
  const PROSE = ["      Use tools: [Read, Grep", '      deny: ["x"', "      skills: [", "      allowed-tools: [Read"].join("\n");
  const agentWith = (fields: string, prompt: string) => `topology t : [pipeline] {
  meta {
    version: "1.0.0"
    description: "prose"
  }
  agent alpha {
    description: "Alpha"
    model: sonnet
${fields}
    prompt {
${prompt}
    }
  }
  agent beta {
    model: haiku
    prompt {
      Do beta.
    }
  }
  settings {
    deny: ["Bash(rm:*)"]
  }
  flow {
    alpha -> beta
  }
}
`;
  const noErrors = (src: string) => expect(validate(parse(src)).filter((r) => r.level === "error")).toEqual([]);

  it("an agent prompt with unclosed list lines validates, and the real fields parse as before", () => {
    const src = agentWith('    tools: [Read, Write]\n    reads: ["docs/[a-z]*.md"]\n    writes: ["out/[0-9].md"]', PROSE);
    noErrors(src);
    const a = alpha(src);
    expect(a.tools).toEqual(["Read", "Write"]);
    expect(a.reads).toEqual(["docs/[a-z]*.md"]);
    expect(a.writes).toEqual(["out/[0-9].md"]);
    expect(a.skills).toBeUndefined();
    expect(parse(src).settings?.deny).toEqual(["Bash(rm:*)"]);
  });

  it("a real field after the prompt is still the field", () => {
    const src = agentWith("", PROSE).replace("    }\n  }\n  agent beta", "    }\n    tools: [Write]\n  }\n  agent beta");
    noErrors(src);
    expect(alpha(src).tools).toEqual(["Write"]);
  });

  it("an agent with no tools field and a prompt that mentions one still parses", () => {
    expect(() => parse(agentWith("", PROSE))).not.toThrow();
  });

  it("a skill prompt and a description string with unclosed list text validate", () => {
    const src = agentWith('    tools: [Read]', "      x").replace(
      "  settings {",
      [
        "  skills {",
        "    skill helper {",
        '      description: "Lists allowed-tools: [Read and more"',
        '      allowed-tools: ["Bash(git log:*)", Read]',
        "      prompt {",
        "        Pass allowed-tools: [Read, Grep",
        '        paths: ["src/',
        "      }",
        "    }",
        "  }",
        "  settings {",
      ].join("\n"),
    ).replace('    description: "Alpha"', '    description: "Alpha has tools: [Read and more"');
    noErrors(src);
    const sk = parse(src).skills!.find((s) => s.id === "helper")!;
    expect(sk.allowedTools).toEqual(["Bash(git log:*)", "Read"]);
    expect(sk.paths).toBeUndefined();
    expect(alpha(src).tools).toEqual(["Read"]);
  });

  it("a variant prompt with unclosed list text validates", () => {
    const src = agentWith("    tools: [Read]\n    variants {\n      variant v1 {\n        prompt {\n          tools: [Grep\n        }\n      }\n    }", "      x");
    expect(() => parse(src)).not.toThrow();
    expect(alpha(src).tools).toEqual(["Read"]);
  });
});
