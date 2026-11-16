/**
 * S-19: permission rules are first-class. Declared on the topology
 * (`settings { allow ask deny default-mode }`) and on an agent
 * (`allow ask deny`), parsed by parsePermissionRule, and checked by V130-V135.
 *
 * Every platform fact a check relies on is quoted from the Claude Code
 * permissions docs (P = permissions, PM = permission modes, SR = settings
 * reference) in the check's message or in spec/validation.md.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../index.js";
import { validate } from "../validator.js";
import { serializeAST } from "../../import/serializer.js";
import { importFromPlatform } from "../../import/index.js";
import type { PlatformFile } from "../../sync/index.js";
import type { AgentNode } from "../ast.js";

// Loaded dynamically so the rest of this file runs (and fails for its own
// reason) before the module exists.
/** Written out so this file type-checks before AgentNode has the fields. */
type RuleAgent = AgentNode & { allow?: string[]; ask?: string[]; deny?: string[] };
interface Rule { raw: string; tool: string; specifier?: string; form: string; problems: string[] }
const rulePath = "../permission-rule.js";
const ruleModule = (await import(rulePath).catch(() => ({}))) as { parsePermissionRule?: (raw: string) => Rule };
const parsePermissionRule = (raw: string): Rule => {
  if (!ruleModule.parsePermissionRule) throw new Error("src/parser/permission-rule.ts does not exist yet");
  return ruleModule.parsePermissionRule(raw);
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Rule numbers on this branch (V134-V139 in the spec, renumbered when integrate/sp merges first). */
const MALFORMED = "V130";
const SKIPPED = "V131";
const UNUSABLE = "V132";
const SHADOWED = "V133";
const MODE_MOOT = "V134";
const SUSPECT = "V135";

/** A small valid topology: agents a (Read, Write, Bash) and b (Read), flow a -> b. */
function topo(opts: { settings?: string; a?: string; b?: string } = {}): string {
  return `topology t : [pipeline] {
  meta {
    version: "1.0.0"
    description: "permission rules"
  }
  orchestrator {
    model: sonnet
    handles: [intake]
  }
  action intake {
    kind: inline
  }
  agent a {
    model: sonnet
    tools: [Read, Write, Bash]
${opts.a ?? ""}
  }
  agent b {
    model: sonnet
    tools: [Read]
${opts.b ?? ""}
  }
  flow {
    intake -> a
    a -> b
  }
  settings {
${opts.settings ?? ""}
  }
}
`;
}

function hits(source: string, rule: string) {
  return validate(parse(source)).filter((r) => r.rule === rule);
}

describe("grammar and AST", () => {
  it("parses agent-level allow / ask / deny as raw rule strings", () => {
    const ast = parse(topo({ a: `    ask: ["Bash(kubectl apply *)"]\n    deny: ["Bash(kubectl delete *)", Write]\n    allow: [Read]` }));
    const a = ast.nodes.find((n) => n.id === "a") as RuleAgent;
    expect(a.ask).toEqual(["Bash(kubectl apply *)"]);
    expect(a.deny).toEqual(["Bash(kubectl delete *)", "Write"]);
    expect(a.allow).toEqual(["Read"]);
  });

  it("parses settings default-mode", () => {
    const ast = parse(topo({ settings: "    default-mode: acceptEdits" }));
    expect(ast.settings.defaultMode).toBe("acceptEdits");
  });

  it("keeps a comma, a bracket and a quote inside a rule string", () => {
    const ast = parse(topo({ settings: `    deny: ["Bash(git commit -m \\"a, b\\")", "Bash(echo [x])", Read]` }));
    expect(ast.settings.deny).toEqual(['Bash(git commit -m "a, b")', "Bash(echo [x])", "Read"]);
  });

  it("does not read an agent's nested extensions or hooks as its rules", () => {
    const ast = parse(topo({ a: `    extensions {\n      claude-code {\n        deny: [Bash]\n      }\n    }` }));
    const a = ast.nodes.find((n) => n.id === "a") as RuleAgent;
    expect(a.deny).toBeUndefined();
  });

  it("agent allow / ask / deny are known fields (no V102)", () => {
    expect(hits(topo({ a: `    deny: ["Bash(rm *)"]\n    ask: ["Bash(git push *)"]\n    allow: ["Bash(npm test)"]` }), "V102")).toEqual([]);
  });
});

describe("parsePermissionRule", () => {
  const cases: Array<[string, string, string | undefined, string]> = [
    ["Bash", "Bash", undefined, "bare"],
    ["Bash(npm run *)", "Bash", "npm run *", "command"],
    ["Edit(./Finance (2024)/**)", "Edit", "./Finance (2024)/**", "path"],
    ["WebFetch(domain:docs.example.com)", "WebFetch", "domain:docs.example.com", "domain"],
    ["Agent(model:opus)", "Agent", "model:opus", "param"],
    ["Bash(run_in_background:true)", "Bash", "run_in_background:true", "param"],
    ["Bash(ls:*)", "Bash", "ls:*", "command"],
    ["Agent(Explore)", "Agent", "Explore", "agent"],
    ["mcp__db__query", "mcp__db__query", undefined, "mcp"],
    ["mcp.db.query", "mcp__db__query", undefined, "mcp"],
    ["mcp.db.*", "mcp__db__*", undefined, "mcp"],
    ["mcp.db", "mcp__db", undefined, "mcp"],
    ["*", "*", undefined, "glob"],
  ];
  for (const [raw, tool, specifier, form] of cases) {
    it(`${raw} -> ${form}`, () => {
      const r = parsePermissionRule(raw);
      expect(r).toMatchObject({ raw, tool, form, problems: [] });
      expect(r.specifier).toBe(specifier);
    });
  }

  for (const bad of ["Bash(npm", "Bash()", "(rm *)", "Bash(x) y", "Stop Task", "mcp.", "mcp..x", "mcp.db.x(y)", ""]) {
    it(`"${bad}" is malformed`, () => {
      expect(parsePermissionRule(bad).problems.length).toBeGreaterThan(0);
    });
  }
});

describe("T1: a bare deny removes a tool an agent declares (V136 -> " + UNUSABLE + ")", () => {
  const file = resolve(root, "examples/code-review.at");
  const shipped = readFileSync(file, "utf8");
  const before = shipped.replace(/deny: \[[^\]]*\]/, 'deny: ["Write", "Edit", "Bash"]');

  it("fires on code-review.at as shipped before S-19: bare Write deny vs reporter's Write", () => {
    const r = hits(before, UNUSABLE);
    expect(r.some((x) => x.node === "reporter" && x.message.includes('"Write"'))).toBe(true);
    expect(r.every((x) => x.level === "warning")).toBe(true);
    expect(r[0].message).toContain("removes the tool from Claude's context entirely");
  });

  it("the shipped example scopes its deny and keeps the reporter's Write", () => {
    const ast = parse(shipped);
    const deny = ast.settings.deny ?? [];
    expect(deny).not.toContain("Write");
    expect(deny).not.toContain("Edit");
    expect((ast.nodes.find((n) => n.id === "reporter") as AgentNode).tools).toContain("Write");
    expect(hits(shipped, UNUSABLE)).toEqual([]);
  });

  it("S-50: scheduled-monitor.at scopes its Edit deny, so its reporter keeps Write", () => {
    const src = readFileSync(resolve(root, "examples/scheduled-monitor.at"), "utf8");
    const ast = parse(src);
    expect(ast.settings.deny ?? []).not.toContain("Edit");
    expect((ast.nodes.find((n) => n.id === "reporter") as AgentNode).tools).toContain("Write");
    expect(hits(src, UNUSABLE)).toEqual([]);
  });

  it("a bare Edit deny also covers Write (Edit rules apply to all built-in tools that edit files)", () => {
    const r = hits(topo({ settings: "    deny: [Edit]" }), UNUSABLE);
    expect(r.some((x) => x.node === "a" && x.message.includes("Write"))).toBe(true);
  });

  it("a Tool(*) deny and a tool-name glob deny count as bare", () => {
    expect(hits(topo({ settings: '    deny: ["Bash(*)"]' }), UNUSABLE).some((x) => x.node === "a")).toBe(true);
    expect(hits(topo({ settings: '    deny: ["Re*"]' }), UNUSABLE).some((x) => x.node === "b")).toBe(true);
  });

  it("an Agent(x) deny on an agent the flow invokes", () => {
    const r = hits(topo({ settings: '    deny: ["Agent(b)"]' }), UNUSABLE);
    expect(r.some((x) => x.message.includes("Agent(b)"))).toBe(true);
  });

  it("an agent-level rule on a tool the agent lacks", () => {
    const r = hits(topo({ b: '    deny: ["Bash(rm *)"]' }), UNUSABLE);
    expect(r.some((x) => x.node === "b" && x.message.includes("Bash"))).toBe(true);
  });

  it("a scoped deny keeps the tool: no warning", () => {
    expect(hits(topo({ settings: '    deny: ["Edit(/src/**)", "Bash(rm *)"]' }), UNUSABLE)).toEqual([]);
  });
});

describe("T2: malformed rules (V134 -> " + MALFORMED + ") and rules Claude Code skips (V135 -> " + SKIPPED + ")", () => {
  const malformed: Array<[string, string]> = [
    ["unbalanced parens", '"Bash(npm"'],
    ["empty specifier", '"Bash()"'],
    ["no tool name", '"(rm *)"'],
    ["text after the specifier", '"Bash(x) y"'],
    ["a label, not a tool name", '"Stop Task"'],
    ["unknown dotted mcp form", '"mcp..x"'],
    ["dotted mcp with parens", '"mcp.db.x(y)"'],
  ];
  for (const [name, rule] of malformed) {
    it(`${name}: ${rule}`, () => {
      const r = hits(topo({ settings: `    deny: [${rule}]` }), MALFORMED);
      expect(r.length).toBe(1);
      expect(r[0].level).toBe("error");
      expect(r[0].message).toContain("Tool(specifier)");
    });
  }

  it("an unknown default-mode", () => {
    const r = hits(topo({ settings: "    default-mode: yolo" }), MALFORMED);
    expect(r.length).toBe(1);
    expect(r[0].level).toBe("error");
  });

  const skipped: Array<[string, string, string, string]> = [
    ["mcp rule with parens", "deny", '"mcp__db__query(sql:DROP *)"', "skips any `mcp__` rule that has parentheses"],
    ["primary field param (Bash command)", "deny", '"Bash(command:rm *)"', "Claude Code ignores it"],
    ["primary field param (Read file_path)", "deny", '"Read(file_path:/etc/passwd)"', "Claude Code ignores it"],
    ["path rule on Grep", "deny", '"Grep(docs/**)"', "doesn't match a read, search, or edit against it"],
    ["path rule on Write", "ask", '"Write(docs/**)"', "doesn't match a read, search, or edit against it"],
    ["path rule on Glob", "deny", '"Glob(src/**)"', "doesn't match a read, search, or edit against it"],
    ["path rule on NotebookEdit", "deny", '"NotebookEdit(nb/**)"', "doesn't match a read, search, or edit against it"],
    ["unanchored allow glob *", "allow", '"*"', "is skipped and doesn't auto-approve anything"],
    ["unanchored allow glob B*", "allow", '"B*"', "is skipped and doesn't auto-approve anything"],
    ["unanchored allow glob mcp__*", "allow", '"mcp__*"', "is skipped and doesn't auto-approve anything"],
    ["mcp allow with a specifier", "allow", '"mcp__db__query(select)"', "the rule doesn't match any call"],
    [":* not at the end", "deny", '"Bash(git:* push)"', "only recognized at the end of a pattern"],
    ["param rule in allow", "allow", '"Agent(model:opus)"', "allow rules continue to use each tool's own specifier syntax"],
  ];
  for (const [name, list, rule, quote] of skipped) {
    it(`${name}: ${list} ${rule}`, () => {
      const r = hits(topo({ settings: `    ${list}: [${rule}]` }), SKIPPED);
      expect(r.length).toBe(1);
      expect(r[0].level).toBe("error");
      expect(r[0].message).toContain(quote);
    });
  }

  const fine: Array<[string, string]> = [
    ["deny", '"Bash(ls:*)"'],
    ["deny", '"Agent(model:opus)"'],
    ["allow", '"mcp__github__get_*"'],
    ["deny", '"mcp__*"'],
    ["deny", '"Read(./.env)"'],
    ["allow", '"WebFetch(domain:docs.example.com)"'],
    ["deny", '"Edit(./Finance (2024)/**)"'],
    ["deny", '"Grep(*)"'],
    ["deny", '"mcp.db.drop"'],
  ];
  for (const [list, rule] of fine) {
    it(`accepts ${list} ${rule}`, () => {
      const src = topo({ settings: `    ${list}: [${rule}]` });
      expect(hits(src, MALFORMED)).toEqual([]);
      expect(hits(src, SKIPPED)).toEqual([]);
    });
  }

  it("checks agent-level rules too", () => {
    expect(hits(topo({ a: '    deny: ["Bash(command:rm *)"]' }), SKIPPED).length).toBe(1);
  });
});

describe("T3: an allow a deny or ask always covers (V137 -> " + SHADOWED + ")", () => {
  it("allow Bash(aws s3 ls) under deny Bash(aws *)", () => {
    const r = hits(topo({ settings: '    allow: ["Bash(aws s3 ls)"]\n    deny: ["Bash(aws *)"]' }), SHADOWED);
    expect(r.length).toBe(1);
    expect(r[0].level).toBe("warning");
    expect(r[0].message).toContain("deny, then ask, then allow");
    expect(r[0].message).toContain("Bash(aws s3 ls)");
  });

  it("allow under an ask, and allow under a bare deny", () => {
    expect(hits(topo({ settings: '    allow: ["Bash(git push origin main)"]\n    ask: ["Bash(git push *)"]' }), SHADOWED).length).toBe(1);
    expect(hits(topo({ settings: '    allow: ["Bash(npm test)"]\n    deny: [Bash]' }), SHADOWED).length).toBe(1);
  });

  it("the same rule in two lists", () => {
    const r = hits(topo({ settings: '    ask: ["Bash(rm *)"]\n    deny: ["Bash(rm *)"]' }), SHADOWED);
    expect(r.length).toBe(1);
    expect(r[0].message).toContain("Bash(rm *)");
  });

  it("an agent allow under a topology deny", () => {
    expect(hits(topo({ settings: '    deny: ["Bash(aws *)"]', a: '    allow: ["Bash(aws s3 ls)"]' }), SHADOWED).length).toBe(1);
  });

  it("no warning when the allow is outside the deny", () => {
    expect(hits(topo({ settings: '    allow: ["Bash(npm test)"]\n    deny: ["Bash(aws *)"]' }), SHADOWED)).toEqual([]);
  });
});

describe("T4: a mode makes a rule moot (V138 -> " + MODE_MOOT + ")", () => {
  it("permissions: unrestricted with any allow", () => {
    const r = hits(topo({ settings: "    allow: [Read]", a: "    permissions: unrestricted" }), MODE_MOOT);
    expect(r.length).toBe(1);
    expect(r[0].level).toBe("warning");
    expect(r[0].message).toContain("Allow rules have no effect in `bypassPermissions`");
  });

  it("permissions: auto with allow Bash", () => {
    const r = hits(topo({ settings: "    allow: [Bash]", a: "    permissions: auto" }), MODE_MOOT);
    expect(r.length).toBe(1);
    expect(r[0].message).toContain("broad allow rules that grant arbitrary code execution are dropped");
  });

  it("auto drops interpreter, Agent and Monitor allows, keeps narrow ones", () => {
    const r = hits(topo({ settings: '    allow: ["Bash(python*)", Agent, Monitor, "Bash(npm test)"]\n    default-mode: auto' }), MODE_MOOT);
    const dropped = r.filter((x) => x.message.includes("dropped"));
    expect(dropped.length).toBe(3);
  });

  it("an ask under dontAsk denies", () => {
    const r = hits(topo({ settings: '    ask: ["Bash(git push *)"]\n    default-mode: dontAsk' }), MODE_MOOT);
    expect(r.length).toBe(1);
    expect(r[0].message).toContain("denies a matching tool use instead of prompting");
  });

  it("default-mode auto or bypassPermissions in project settings", () => {
    for (const mode of ["auto", "bypassPermissions"]) {
      const r = hits(topo({ settings: `    default-mode: ${mode}` }), MODE_MOOT);
      expect(r.some((x) => x.message.includes("don't take effect from project or local settings"))).toBe(true);
    }
  });

  it("no warning for permissions: autonomous with allows", () => {
    expect(hits(topo({ settings: "    allow: [Read, Bash]", a: "    permissions: autonomous" }), MODE_MOOT)).toEqual([]);
  });
});

describe("V139 -> " + SUSPECT + ": wildcard before the subcommand, unknown tool names", () => {
  it("allow Bash(git * main)", () => {
    const r = hits(topo({ settings: '    allow: ["Bash(git * main)"]' }), SUSPECT);
    expect(r.length).toBe(1);
    expect(r[0].level).toBe("warning");
  });

  it("a tool name matching no known tool", () => {
    const r = hits(topo({ settings: "    deny: [Delete]" }), SUSPECT);
    expect(r.length).toBe(1);
    expect(r[0].message).toContain("Delete");
  });

  it("exempts names with _ or *, MCP names, and known tools", () => {
    expect(hits(topo({ settings: '    deny: [my_tool, "Foo*", TaskOutput, WebSearch, "mcp.db.q"]' }), SUSPECT)).toEqual([]);
    // Every tool a shipped example names in its rules.
    expect(hits(topo({ settings: "    allow: [Read, Write, Edit, Glob, Grep, Bash, WebFetch, WebSearch]" }), SUSPECT)).toEqual([]);
  });
});

describe("T8: rule strings round-trip byte for byte", () => {
  const rules = [
    "Edit(./Finance (2024)/**)",
    'Bash(git commit -m "a, b")',
    "Bash(echo [x])",
    "Read(C:\\Users\\x\\secret.txt)",
    "mcp__db__query",
    "WebFetch(domain:docs.example.com)",
    "Read",
  ];

  it("import -> serialize -> parse keeps every settings rule", () => {
    const file = {
      path: ".claude/settings.json",
      content: JSON.stringify({ permissions: { allow: rules, ask: rules.slice(0, 2), deny: rules.slice(2) } }),
    } as PlatformFile;
    const at = importFromPlatform([file], "claude-code", "rt");
    const ast = parse(at);
    expect(ast.settings.allow).toEqual(rules);
    expect(ast.settings.ask).toEqual(rules.slice(0, 2));
    expect(ast.settings.deny).toEqual(rules.slice(2));
  });

  it("parse -> serialize -> parse keeps agent rules and default-mode", () => {
    const first = parse(topo({ settings: "    default-mode: plan\n    deny: [Read]", a: '    deny: ["Edit(./Finance (2024)/**)", "Bash(rm *)"]\n    ask: ["Bash(git push *)"]' }));
    const second = parse(serializeAST(first));
    const a = second.nodes.find((n) => n.id === "a") as RuleAgent;
    expect(a.deny).toEqual(["Edit(./Finance (2024)/**)", "Bash(rm *)"]);
    expect(a.ask).toEqual(["Bash(git push *)"]);
    expect(second.settings.defaultMode).toBe("plan");
  });
});
