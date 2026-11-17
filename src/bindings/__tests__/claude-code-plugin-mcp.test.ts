/**
 * An MCP server a Claude Code plugin provides (`from: plugin "<name>"`).
 *
 * Claude Code names a plugin server's tools mcp__plugin_<plugin>_<server>__<tool>
 * (any character outside A-Za-z0-9_- becomes _) and registers the server as
 * plugin:<plugin>:<server> (code.claude.com/docs/en/mcp.md, "Plugin-provided
 * MCP servers"). A ref compiled to mcp__<server>__<tool> points at a project
 * server that does not exist, so the agent silently loses the tools.
 */

import { describe, it, expect, vi } from "vitest";
import { parse as parseToml } from "smol-toml";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { serializeAST } from "../../import/serializer.js";
import { claudeCodeBinding, convertMcpToolName } from "../claude-code.js";
import { codexBinding } from "../codex.js";
import { cursorBinding } from "../cursor.js";
import { codexSource } from "./codex-models.js";
import { checkGuards } from "../../guard/check.js";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join } from "node:path";

const SRC = `topology scout : [pipeline] {
  meta {
    version: "1.0.0"
    description: "Scouts signals in a browser"
  }

  mcp-servers {
    playwright {
      from: plugin "playwright"
    }
    db {
      from: plugin "my.plugin"
      server: "db tools"
    }
    search {
      url: "https://search.example.com/mcp"
    }
  }

  agent scout {
    model: sonnet
    description: "Scouts signals"
    tools: [Read, mcp.playwright.*, mcp.db.query, mcp.search.find]
    disallowed-tools: [mcp.playwright.browser_run_code_unsafe]
    mcp-servers: [playwright, search]
    hooks {
      hook shot {
        on: PostToolUse
        matcher: "mcp__playwright__browser_take_screenshot"
        run: "scripts/shot.sh"
      }
    }
  }

  agent quick {
    model: haiku
    description: "Checks one page"
    runs: fork
    tools: [mcp.playwright.browser_navigate]
    disallowed-tools: [mcp.playwright]
  }

  skill browse {
    description: "Browse a page"
    allowed-tools: [mcp.playwright.browser_navigate, mcp.search]
    prompt {
      Open the page.
    }
  }

  flow { scout -> quick }

  hooks {
    hook watch {
      on: PreToolUse
      matcher: "mcp__playwright__.*|mcp__search__find"
      run: "scripts/watch.sh"
    }
    hook note {
      on: PostToolUse
      matcher: "mcp__db__query"
      type: mcp_tool
      server: "playwright"
      tool: "browser_snapshot"
    }
  }

  settings {
    allow: ["mcp.playwright.*", "mcp.search"]
    ask: ["mcp.db"]
    deny: ["mcp.playwright.browser_evaluate"]
  }
}
`;

const ast = () => parse(SRC);
const scaffold = () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    return new Map(claudeCodeBinding.scaffold(ast()).map((f) => [f.path, f.content]));
  } finally {
    warn.mockRestore();
  }
};
/** A frontmatter line with its value unquoted (a value holding `*` is written as a YAML double-quoted scalar). */
const fmLine = (md: string, key: string) => {
  const line = md.split("\n").find((l) => l.startsWith(`${key}:`));
  return line?.replace(/^([^:]+): "(.*)"$/, "$1: $2");
};

describe("a plugin MCP server compiles to Claude Code's plugin names", () => {
  it("agent tools: mcp.playwright.* is mcp__plugin_playwright_playwright__*, and no .mcp.json entry is written", () => {
    const files = scaffold();
    const agent = files.get(".claude/agents/scout/AGENT.md")!;
    expect(fmLine(agent, "tools")).toBe(
      "tools: Read, mcp__plugin_playwright_playwright__*, mcp__plugin_my_plugin_db_tools__query, mcp__search__find",
    );
    expect(fmLine(agent, "disallowedTools")).toBe("disallowedTools: mcp__plugin_playwright_playwright__browser_run_code_unsafe");
    const mcp = JSON.parse(files.get(".mcp.json")!);
    expect(Object.keys(mcp.mcpServers)).toEqual(["search"]);
  });

  it("a topology whose only server is a plugin's writes no .mcp.json at all", () => {
    const only = SRC.replace(/    search \{\n      url: "https:\/\/search.example.com\/mcp"\n    \}\n/, "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const files = claudeCodeBinding.scaffold(parse(only)).map((f) => f.path);
    warn.mockRestore();
    expect(files).not.toContain(".mcp.json");
  });

  it("agent mcp-servers leaves out a plugin server (its scoped name is unverified there); other servers are written", () => {
    const agent = scaffold().get(".claude/agents/scout/AGENT.md")!;
    expect(agent).toContain("mcpServers:\n  - search\n");
    expect(agent).not.toMatch(/plugin:playwright|^\s+- playwright$/m);
  });

  it("an agent whose only mcp-servers entry is a plugin server gets no mcpServers key", () => {
    const src = SRC.replace("mcp-servers: [playwright, search]", "mcp-servers: [playwright]");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = claudeCodeBinding.scaffold(parse(src)).find((f) => f.path === ".claude/agents/scout/AGENT.md")!.content;
    warn.mockRestore();
    expect(agent).not.toContain("mcpServers");
  });

  it("validate notes the left-out entry, naming the scoped form the docs suggest", () => {
    const v130 = validate(ast()).filter((r) => r.rule === "V130").map((r) => r.message);
    expect(v130).toContain(
      'agent "scout" mcp-servers: "playwright" is a plugin\'s server; it is not written to mcpServers until Claude Code\'s scoped name plugin:playwright:playwright is verified; the agent\'s tools already reach it.',
    );
  });

  it("settings allow, ask and deny take the plugin form", () => {
    const settings = JSON.parse(scaffold().get(".claude/settings.json")!);
    expect(settings.permissions).toEqual({
      allow: ["mcp__plugin_playwright_playwright__*", "mcp__search"],
      ask: ["mcp__plugin_my_plugin_db_tools"],
      deny: ["mcp__plugin_playwright_playwright__browser_evaluate"],
    });
  });

  it("skill allowed-tools and a forked agent's skill take the plugin form", () => {
    const files = scaffold();
    expect(fmLine(files.get(".claude/skills/browse/SKILL.md")!, "allowed-tools")).toBe(
      "allowed-tools: mcp__plugin_playwright_playwright__browser_navigate, mcp__search",
    );
    const quick = [...files.entries()].find(([p]) => /quick/.test(p) && p.endsWith("SKILL.md"))![1];
    expect(fmLine(quick, "allowed-tools")).toBe("allowed-tools: mcp__plugin_playwright_playwright__browser_navigate");
    expect(fmLine(quick, "disallowed-tools")).toBe("disallowed-tools: mcp__plugin_playwright_playwright");
  });

  it("hook matchers on the server key compile to the plugin form; an mcp_tool hook's server is the registered name", () => {
    const files = scaffold();
    const settings = JSON.parse(files.get(".claude/settings.json")!);
    const pre = JSON.stringify(settings.hooks.PreToolUse);
    expect(pre).toContain('"matcher":"mcp__plugin_playwright_playwright__.*|mcp__search__find"');
    expect(settings.hooks.PostToolUse).toContainEqual({
      matcher: "mcp__plugin_my_plugin_db_tools__query",
      hooks: [{ type: "mcp_tool", server: "plugin:playwright:playwright", tool: "browser_snapshot" }],
    });
    expect(files.get(".claude/agents/scout/AGENT.md")!).toContain(
      '- matcher: "mcp__plugin_playwright_playwright__browser_take_screenshot"',
    );
  });

  it("the character rule: plugin my.plugin, server \"db tools\" is mcp__plugin_my_plugin_db_tools__*; - and _ are kept", () => {
    const src = SRC.replace('from: plugin "my.plugin"', 'from: plugin "my-plugin_v2"');
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const files = new Map(claudeCodeBinding.scaffold(parse(src)).map((f) => [f.path, f.content]));
    warn.mockRestore();
    expect(fmLine(files.get(".claude/agents/scout/AGENT.md")!, "tools")).toContain("mcp__plugin_my-plugin_v2_db_tools__query");
    expect(scaffold().get(".claude/agents/scout/AGENT.md")!).toContain("mcp__plugin_my_plugin_db_tools__query");
  });

  it("an agent using a plugin playwright server never gets mcp__playwright__ anywhere in the output", () => {
    for (const [path, content] of scaffold()) {
      expect(`${path}: ${/mcp__playwright\b/.test(content) ? "has mcp__playwright" : "clean"}`).toBe(`${path}: clean`);
    }
  });

  it("validates with no V130 or V99 finding for the plugin servers (beyond the left-out mcp-servers note)", () => {
    const found = validate(ast()).filter(
      (r) => (r.rule === "V130" || r.rule === "V99") && /playwright|db/.test(r.message) && !/is not written to mcpServers until/.test(r.message),
    );
    expect(found).toEqual([]);
  });

  it("a from: that is not plugin \"<name>\" is reported as an error", () => {
    const src = SRC.replace('from: plugin "playwright"', 'from: npm "playwright"');
    const errors = validate(parse(src)).filter((r) => r.level === "error").map((r) => r.message);
    expect(errors.some((m) => /mcp-servers playwright/.test(m) && /from: plugin "<plugin-name>"/.test(m))).toBe(true);
  });

  it("parse → serialize → parse keeps from: plugin and server:", () => {
    const text = serializeAST(ast());
    expect(text).toContain('from: plugin "playwright"');
    expect(text).toContain('from: plugin "my.plugin"');
    expect(parse(text).mcpServers).toEqual(ast().mcpServers);
  });
});

describe("only an MCP name is rewritten in tool lists and permission rules", () => {
  const OTHER = [
    "Read(./mcp__playwright/**)",
    "Bash(cat mcp__playwright__notes.txt)",
    "Bash(mcp__playwright:*)",
    "WebFetch(domain:mcp__playwright.example.com)",
    "Edit(/srv/mcp__playwright__data/*)",
    "Bash(mcp__playwright__run:*)",
    "mcp__playwright_extra__x",
    "mcp__playwright-extra",
    "xmcp__playwright__y",
  ];
  const src = SRC.replace(
    'deny: ["mcp.playwright.browser_evaluate"]',
    `deny: [${OTHER.map((r) => JSON.stringify(r)).join(", ")}, "mcp__playwright__browser_evaluate", "mcp__playwright__browser_click(*)"]`,
  ).replace(
    "tools: [Read, mcp.playwright.*, mcp.db.query, mcp.search.find]",
    `tools: [Read, mcp.playwright.*, mcp.db.query, mcp.search.find, ${OTHER.map((r) => JSON.stringify(r)).join(", ")}]`,
  );
  const build = () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      return new Map(claudeCodeBinding.scaffold(parse(src)).map((f) => [f.path, f.content]));
    } finally {
      warn.mockRestore();
    }
  };

  it("a rule or tool that only holds the text mcp__<key> stays byte-identical; a whole MCP name, or the tool before (, is rewritten", () => {
    const files = build();
    expect(JSON.parse(files.get(".claude/settings.json")!).permissions.deny).toEqual([
      ...OTHER,
      "mcp__plugin_playwright_playwright__browser_evaluate",
      "mcp__plugin_playwright_playwright__browser_click(*)",
    ]);
    const tools = fmLine(files.get(".claude/agents/scout/AGENT.md")!, "tools")!;
    for (const r of OTHER) expect(tools).toContain(r);
    expect(tools).not.toContain("mcp__plugin_playwright_playwright/");
  });

  it("a hook's if: (permission-rule syntax) follows the same rule: only its tool part is rewritten", () => {
    const withIf = (iff: string) =>
      SRC.replace('      matcher: "mcp__playwright__.*|mcp__search__find"\n', `      matcher: "mcp__playwright__.*|mcp__search__find"\n      if: ${JSON.stringify(iff)}\n`);
    const ifOf = (s: string) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const settings = JSON.parse(claudeCodeBinding.scaffold(parse(s)).find((f) => f.path === ".claude/settings.json")!.content);
        return settings.hooks.PreToolUse.flatMap((e: { hooks: Array<{ if?: string }> }) => e.hooks).find((h: { if?: string }) => h.if)?.if;
      } finally {
        warn.mockRestore();
      }
    };
    expect(ifOf(withIf("mcp__playwright__browser_navigate(*)"))).toBe("mcp__plugin_playwright_playwright__browser_navigate(*)");
    expect(ifOf(withIf("Bash(cat mcp__playwright__notes.txt)"))).toBe("Bash(cat mcp__playwright__notes.txt)");
  });

  it("guard --check reports each such deny rule as written, refusing", () => {
    const root = fs.mkdtempSync(join(os.tmpdir(), "at-plugin-mcp-rules-"));
    try {
      for (const [path, content] of build()) {
        fs.mkdirSync(dirname(join(root, path)), { recursive: true });
        fs.writeFileSync(join(root, path), content);
      }
      const items = checkGuards(parse(src), root).items.filter((i) => i.kind === "permission" && i.id.startsWith("deny "));
      expect(items.map((i) => `${i.id} ${i.strength}`)).toEqual([
        ...OTHER.map((r) => `deny ${r} refuse`),
        "deny mcp__plugin_playwright_playwright__browser_evaluate refuse",
        "deny mcp__plugin_playwright_playwright__browser_click(*) refuse",
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("a dotted if: now compiles to the Claude Code name, and validate says so", () => {
  // No plugin server here: the dotted if: compiles with project servers too.
  const src = (iff: string) => `topology t : [pipeline] {
  meta {
    version: "1.0.0"
    description: "t"
  }
  mcp-servers {
    storage {
      command: "npx"
    }
  }
  agent a {
    model: sonnet
    description: "A"
    tools: [Read]
  }
  flow { a }
  hooks {
    hook watch {
      on: PreToolUse
      matcher: "mcp__storage__.*"
      if: ${JSON.stringify(iff)}
      run: "scripts/watch.sh"
    }
  }
}
`;
  const compiledIf = (iff: string) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const settings = JSON.parse(claudeCodeBinding.scaffold(parse(src(iff))).find((f) => f.path === ".claude/settings.json")!.content);
      return settings.hooks.PreToolUse.flatMap((e: { hooks: Array<{ if?: string }> }) => e.hooks).find((h: { if?: string }) => h.if)?.if;
    } finally {
      warn.mockRestore();
    }
  };
  const ifNotes = (iff: string) => validate(parse(src(iff))).filter((r) => /if: .* now matches/.test(r.message));

  it.each([
    ["mcp.storage.get(*)", "mcp__storage__get(*)"],
    ["mcp.storage", "mcp__storage"],
    ["mcp.storage.*", "mcp__storage__*"],
    ["mcp.ghost.x(y)", "mcp__ghost__x(y)"],
  ])("if: %s compiles to %s and warns", (iff, compiled) => {
    expect(compiledIf(iff)).toBe(compiled);
    const notes = ifNotes(iff);
    expect(notes.map((r) => [r.rule, r.level, r.message])).toEqual([
      [
        "V130",
        "warning",
        `hook "watch" if: "${iff}" now matches ${compiled}; in 0.12.1 it was written as is and never matched, so this hook now runs.`,
      ],
    ]);
  });

  it.each(["mcp__storage__get(*)", "Bash(git push:*)"])("if: %s is written as is and does not warn", (iff) => {
    expect(compiledIf(iff)).toBe(iff);
    expect(ifNotes(iff)).toEqual([]);
  });
});

describe("a from: that is not an accepted form is an error", () => {
  const withFrom = (from: string) => SRC.replace('from: plugin "playwright"', `from: ${from}`);
  const fromErrors = (from: string) =>
    validate(parse(withFrom(from))).filter((r) => r.level === "error" && /mcp-servers playwright/.test(r.message));

  it.each([
    "plugin 'playwright'",
    'Plugin "playwright"',
    '"plugin playwright"',
    'plugin ""',
    "plugin",
    "plugin play wright",
    'plugin "a" "b"',
    'npm "playwright"',
  ])("from: %s stops validate, naming the expected form", (from) => {
    const errs = fromErrors(from);
    expect(errs.length).toBe(1);
    expect(errs[0].message).toContain('from: plugin "<plugin-name>"');
  });

  it.each(['plugin "playwright"', "plugin playwright", 'plugin "playwright" # the browser plugin', 'plugin "my.plugin"'])(
    "from: %s is accepted",
    (from) => {
      expect(fromErrors(from)).toEqual([]);
    },
  );
});

describe("a matcher that names a plugin server in a form scaffold cannot rewrite is reported", () => {
  const withMatcher = (m: string) =>
    SRC.replace('      matcher: "mcp__playwright__.*|mcp__search__find"\n', `      matcher: ${JSON.stringify(m)}\n`);
  const notes = (m: string) =>
    validate(parse(withMatcher(m))).filter((r) => r.rule === "V130" && /form scaffold can't rewrite/.test(r.message));

  it.each(["mcp__(playwright|x)__.*", "mcp__play.*", "mcp__playwrigh[t]__.*", "mcp__(?:playwright)__browser_click"])(
    "%s: a V130 warning naming the server and the form that fires",
    (m) => {
      const found = notes(m);
      expect(found.map((r) => r.level)).toEqual(["warning"]);
      expect(found[0].message).toBe(
        `hook "watch" matcher ${JSON.stringify(m)} names the plugin server playwright in a form scaffold can't rewrite, so it never fires for that server's tools; write mcp__plugin_playwright_playwright__… or mcp__playwright__… (rewritten to it) so it fires.`,
      );
    },
  );

  it("an agent's own hook is checked too", () => {
    const src = SRC.replace('matcher: "mcp__playwright__browser_take_screenshot"', 'matcher: "mcp__play.*"');
    const found = validate(parse(src)).filter((r) => r.rule === "V130" && /form scaffold can't rewrite/.test(r.message));
    expect(found.map((r) => r.message)).toEqual([
      `hook "shot" matcher "mcp__play.*" names the plugin server playwright in a form scaffold can't rewrite, so it never fires for that server's tools; write mcp__plugin_playwright_playwright__… or mcp__playwright__… (rewritten to it) so it fires.`,
    ]);
  });

  it.each(["mcp__playwright__.*|mcp__search__find", "mcp__.*", "mcp__plugin_playwright_playwright__.*", "Bash", "mcp__search__.*", "mcp__playwright__browser_(click|type)", "mcp__db__query"])(
    "%s: no warning (rewritten, reaches every server, or names none of the plugin servers)",
    (m) => {
      expect(notes(m)).toEqual([]);
    },
  );
});

describe("guard --check reads the plugin form", () => {
  it("a deny rule on a plugin server is found in the scaffolded settings.json as refusing", () => {
    const root = fs.mkdtempSync(join(os.tmpdir(), "at-plugin-mcp-"));
    try {
      for (const [path, content] of scaffold()) {
        fs.mkdirSync(dirname(join(root, path)), { recursive: true });
        fs.writeFileSync(join(root, path), content);
      }
      const item = checkGuards(ast(), root).items.find((i) => i.kind === "permission" && i.id.startsWith("deny "));
      expect(item).toMatchObject({ id: "deny mcp__plugin_playwright_playwright__browser_evaluate", strength: "refuse" });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("a project server compiles as before", () => {
  it("mcp.search.find, mcp.search and the search matcher keep the project form, and .mcp.json keeps its entry", () => {
    const files = scaffold();
    expect(fmLine(files.get(".claude/agents/scout/AGENT.md")!, "tools")).toContain("mcp__search__find");
    expect(JSON.parse(files.get(".mcp.json")!).mcpServers.search).toEqual({ url: "https://search.example.com/mcp", type: "http" });
    expect(convertMcpToolName("mcp.playwright.*")).toBe("mcp__playwright__*");
    expect(convertMcpToolName("mcp.search")).toBe("mcp__search");
  });
});

describe("Codex and Cursor have no Claude Code plugins", () => {
  it("Codex writes no [mcp_servers] table for a plugin server, and validate --target codex says so", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cfg = parseToml(codexBinding.scaffold(parse(codexSource(SRC))).find((f) => f.path === ".codex/config.toml")!.content) as {
      mcp_servers?: Record<string, unknown>;
    };
    warn.mockRestore();
    expect(Object.keys(cfg.mcp_servers ?? {})).toEqual(["search"]);
    const cx = validate(parse(codexSource(SRC)), { target: "codex" }).filter((r) => r.rule === "CX5-mcp-plugin").map((r) => r.node);
    expect(cx.sort()).toEqual(["db", "playwright"]);
  });

  it("Cursor writes no mcp.json entry for a plugin server and warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const files = cursorBinding.scaffold(ast());
    const said = warn.mock.calls.map((c) => String(c[0]));
    warn.mockRestore();
    const mcp = JSON.parse(files.find((f) => f.path === ".cursor/mcp.json")!.content);
    expect(Object.keys(mcp.mcpServers)).toEqual(["search"]);
    expect(said.some((m) => /playwright/.test(m) && /plugin/.test(m))).toBe(true);
  });
});
