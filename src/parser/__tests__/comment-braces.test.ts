/**
 * A brace inside a `#` comment is text: it never opens or closes a block.
 * And a topology that parses to less than its source declares is an error
 * (V131), never a silent empty parse: validate and scaffold must not pass a
 * topology whose agents or settings were dropped.
 */
import { describe, it, expect } from "vitest";
import { parse } from "../index.js";
import { braceText } from "../lexer.js";
import { validate } from "../validator.js";
import type { AgentNode } from "../ast.js";

const base = (agentComment: string, topComment: string, settingsComment: string) => `topology t : [pipeline] {
  meta {
    version: "1.0.0"
    description: "comment braces"
  }
  agent alpha {
    description: "Alpha"
${agentComment}
    model: sonnet
    tools: [Read]
    prompt {
      Do alpha.
    }
  }
  agent beta {
    model: haiku
    prompt {
      Do beta.
    }
  }
${topComment}
  settings {
${settingsComment}
    deny: ["Bash(rm:*)", "Read(./.env)"]
  }
  flow {
    alpha -> beta
  }
}
`;

const shapes: Record<string, string> = {
  "no comment": base("", "", ""),
  "a commented-out balanced block between blocks": base("", "  # agent old {\n  #   model: opus\n  # }", ""),
  "a commented-out closing brace alone, in an agent": base("    # }", "", ""),
  "a } inside a comment sentence, in an agent": base("    # closes } here", "", ""),
  "a trailing comment holding } on a field line": base("", "", "").replace("    model: sonnet\n", "    model: sonnet # see } note\n"),
  "a } in a comment in the settings block": base("", "", "    # old rule }"),
  "a } in a comment between blocks": base("", "  # end of agents }", ""),
  "a { in a comment between blocks": base("", "  # start of settings {", ""),
  "a { in a comment in an agent": base("    # TODO: hooks {", "", ""),
  "} then { in one comment, in an agent": base("    # } else {", "", ""),
};

const errors = (src: string) => validate(parse(src)).filter((r) => r.level === "error");

describe("a brace inside a # comment is text", () => {
  for (const [name, src] of Object.entries(shapes)) {
    it(`${name}: both agents, their fields and the settings are read`, () => {
      const ast = parse(src);
      const agents = ast.nodes.filter((n): n is AgentNode => n.type === "agent");
      expect(agents.map((a) => a.id)).toEqual(["alpha", "beta"]);
      expect(agents[0].model).toBe("sonnet");
      expect(agents[0].tools).toEqual(["Read"]);
      expect(agents[1].model).toBe("haiku");
      expect(ast.settings.deny).toEqual(["Bash(rm:*)", "Read(./.env)"]);
      expect(ast.edges.map((e) => `${e.from}->${e.to}`)).toEqual(["alpha->beta"]);
      expect(errors(src)).toEqual([]);
    });
  }

  it("braceText blanks a comment's braces and nothing else", () => {
    const src = 'a { # x } y {\n  b: "c # {" # z }\n  url: https://x.test/p#frag}\n}';
    const out = braceText(src);
    expect(out.length).toBe(src.length);
    expect(out.split("\n").length).toBe(src.split("\n").length);
    // The comment's content is blanked; the string and the URL fragment stay.
    expect(out).toBe('a {          \n  b: "c # {"      \n  url: https://x.test/p#frag}\n}');
  });

  it("a # inside a quoted string or a URL is not a comment", () => {
    const src = base("", "", "").replace(
      '    description: "Alpha"\n',
      '    description: "Alpha #1 of #hash"\n'
    ).replace("  settings {\n", '  settings {\n    api: https://example.test/docs#section\n');
    const ast = parse(src);
    const alpha = ast.nodes.find((n) => n.id === "alpha") as AgentNode;
    expect(alpha.description).toBe("Alpha #1 of #hash");
    expect(ast.nodes.map((n) => n.id)).toEqual(["alpha", "beta"]);
    expect(ast.settings.deny).toEqual(["Bash(rm:*)", "Read(./.env)"]);
  });

  it("a # line with braces inside a prompt is prompt text, kept as written", () => {
    const src = base("", "", "").replace("      Do alpha.\n", "      # Step {1}\n      Do alpha.\n");
    const ast = parse(src);
    const alpha = ast.nodes.find((n) => n.id === "alpha") as AgentNode;
    expect(alpha.prompt).toContain("# Step {1}");
    expect(ast.nodes.map((n) => n.id)).toEqual(["alpha", "beta"]);
    expect(errors(src)).toEqual([]);
  });
});

describe("V131: a block present in the source and missing from the parse is an error", () => {
  const v131 = (src: string) => validate(parse(src)).filter((r) => r.rule === "V131");

  it("a stray } that closes the topology early names the line parsing stopped at", () => {
    const src = base("", "", "").replace("    }\n  }\n  agent beta", "    }\n  }\n  }\n  agent beta");
    const found = v131(src);
    expect(found.length).toBeGreaterThan(0);
    expect(found[0].level).toBe("error");
    // Line 15 holds the stray brace that closes the topology.
    expect(found[0].line).toBe(15);
    expect(found[0].message).toMatch(/line 15/);
    expect(found.map((r) => r.message).join("\n")).toMatch(/beta/);
  });

  it("a } inside a quoted string that ends the topology early is an error, not a silent empty parse", () => {
    const src = base("", "", "").replace('    description: "Alpha"\n', '    description: "Alpha }"\n');
    const found = v131(src);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((r) => r.level === "error")).toBe(true);
    expect(found.map((r) => r.message).join("\n")).toMatch(/settings/);
  });

  it("a quoted { in one block and a quoted } in a later one: the blocks between are named", () => {
    const src = base("", "", "")
      .replace('    description: "Alpha"\n', '    description: "Alpha {"\n')
      .replace("    model: haiku\n", '    model: haiku\n    description: "Beta }"\n');
    const found = v131(src);
    expect(found.length).toBeGreaterThan(0);
    expect(found.map((r) => r.message).join("\n")).toMatch(/agent beta/);
  });

  it("validates clean when nothing is lost", () => {
    expect(v131(base("", "", ""))).toEqual([]);
  });
});
