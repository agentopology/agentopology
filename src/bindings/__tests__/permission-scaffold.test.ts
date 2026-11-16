/**
 * S-19 slice 2: the claude-code scaffold of the permission rules a topology
 * declares (spec §5a).
 *
 * - agent `deny: [R]` -> a PreToolUse hook in that agent's frontmatter that
 *   refuses a call matching R (exit 2: "Blocks the tool call");
 * - agent `ask: [R]`  -> a PreToolUse hook that returns permissionDecision
 *   "ask" ("`"ask"` prompts the user to confirm");
 * - agent `allow: [R]` -> refused: a subagent file has no rule field, and a
 *   settings allow is session-wide;
 * - `settings { default-mode: X }` -> permissions.defaultMode, refused for
 *   auto and bypassPermissions, which project settings ignore.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import { claudeCodeBinding, headlessAllowNote } from "../claude-code.js";
import { BindingRefusal } from "../types.js";
import { checkHooks, checkStdout, matcherMatches } from "../../conformance/claude-code.js";
import type { AgentNode } from "../../parser/ast.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const CLI = resolve(repo, "dist/cli/index.js");

function topo(opts: { settings?: string; a?: string; schedule?: string } = {}): string {
  return `topology t : [pipeline] {
  meta {
    version: "1.0.0"
    description: "permission scaffold"
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
  flow {
    intake -> a
  }
${opts.schedule ?? ""}
  settings {
${opts.settings ?? ""}
  }
}
`;
}

function quiet<T>(fn: () => T): { value: T; warnings: string[] } {
  const warnings: string[] = [];
  const w = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => { warnings.push(args.join(" ")); });
  try { return { value: fn(), warnings }; } finally { w.mockRestore(); }
}

function scaffold(src: string) {
  return quiet(() => claudeCodeBinding.scaffold(parse(src)));
}

function file(files: Array<{ path: string; content: string }>, path: string): string {
  const f = files.find((x) => x.path === path);
  if (!f) throw new Error(`${path} not generated; got ${files.map((x) => x.path).join(", ")}`);
  return f.content;
}

/**
 * The frontmatter `hooks:` block of an AGENT.md, read back into the object
 * shape settings.json uses. The binding writes every value as JSON, so each
 * value parses with JSON.parse.
 */
function frontmatterHooks(md: string): Record<string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>> {
  const fm = md.split("\n---")[0];
  const at = fm.indexOf("\nhooks:\n");
  if (at === -1) return {};
  const out: Record<string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>> = {};
  let event = "";
  let group: { matcher?: string; hooks: Array<Record<string, unknown>> } | null = null;
  let handler: Record<string, unknown> | null = null;
  for (const line of fm.slice(at + 8).split("\n")) {
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^ {2}(\w+):$/))) { event = m[1]; out[event] = []; continue; }
    if ((m = line.match(/^ {4}-(?: matcher: (.*))?$/))) { group = { ...(m[1] ? { matcher: JSON.parse(m[1]) } : {}), hooks: [] }; out[event].push(group); continue; }
    if (/^ {6}hooks:$/.test(line)) continue;
    if ((m = line.match(/^ {8}- (\w+): (.*)$/))) { handler = { [m[1]]: JSON.parse(m[2]) }; group!.hooks.push(handler); continue; }
    if ((m = line.match(/^ {10}(\w+): (.*)$/))) { handler![m[1]] = JSON.parse(m[2]); continue; }
    if (line.trim() === "") continue;
    break;
  }
  return out;
}

/** Run a hook command the way Claude Code does: a shell, the payload on stdin. */
function runHook(command: string, payload: object) {
  return spawnSync("/bin/sh", ["-c", command], { input: JSON.stringify(payload), encoding: "utf8" });
}

const AGENT_MD = ".claude/agents/a/AGENT.md";

describe("T5: agent deny -> a frontmatter PreToolUse hook that refuses", () => {
  it("a command rule: matcher on the tool, if: the rule, exit 2", () => {
    const { value: files } = scaffold(topo({ a: '    deny: ["Bash(kubectl delete *)"]' }));
    const hooks = frontmatterHooks(file(files, AGENT_MD));
    expect(hooks.PreToolUse).toHaveLength(1);
    const [group] = hooks.PreToolUse;
    expect(group.matcher).toBe("Bash");
    expect(group.hooks).toHaveLength(1);
    const h = group.hooks[0];
    expect(h.type).toBe("command");
    expect(h.if).toBe("Bash(kubectl delete *)");
    // A deny hook that cannot start must not let the call through (Claude Code 2.1.295+).
    expect(h.onFailure).toBe("block");
    const r = runHook(h.command as string, { tool_name: "Bash", tool_input: { command: "kubectl delete pod x" } });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("Bash(kubectl delete *)");
    // The frontmatter hooks pass the same contract settings.json hooks do.
    expect(checkHooks(hooks as Record<string, unknown>)).toEqual([]);
  });

  it("a bare tool: matcher only, no if", () => {
    const { value: files } = scaffold(topo({ a: "    deny: [Write]" }));
    const [group] = frontmatterHooks(file(files, AGENT_MD)).PreToolUse;
    expect(group.matcher).toBe("Write");
    expect(group.hooks[0].if).toBeUndefined();
  });

  it("a tool-name glob: an anchored regex matcher", () => {
    const { value: files } = scaffold(topo({ a: '    deny: ["mcp.db.*"]' }));
    const [group] = frontmatterHooks(file(files, AGENT_MD)).PreToolUse;
    expect(group.matcher).toBe("^mcp__db__.*$");
    expect(matcherMatches("PreToolUse", group.matcher, "mcp__db__drop")).toBe(true);
    expect(matcherMatches("PreToolUse", group.matcher, "mcp__dbx__drop")).toBe(false);
    expect(group.hooks[0].if).toBeUndefined();
  });

  it("a rule holding a single quote still runs and names the rule", () => {
    const { value: files } = scaffold(topo({ a: `    deny: ["Bash(echo 'x' *)"]` }));
    const h = frontmatterHooks(file(files, AGENT_MD)).PreToolUse[0].hooks[0];
    const r = runHook(h.command as string, { tool_name: "Bash" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("Bash(echo 'x' *)");
  });

  it("one handler per rule (\"The `if` field holds exactly one permission rule\")", () => {
    const { value: files } = scaffold(topo({ a: '    deny: ["Bash(rm *)", "Bash(curl *)"]' }));
    const pre = frontmatterHooks(file(files, AGENT_MD)).PreToolUse;
    const ifs = pre.flatMap((g) => g.hooks.map((h) => h.if));
    expect(ifs).toEqual(["Bash(rm *)", "Bash(curl *)"]);
  });

  it("keeps the agent's own hooks first, then the rule hooks", () => {
    const own = `    hooks {
      hook lint {
        on: PreToolUse
        matcher: "Write"
        run: "scripts/lint.sh"
      }
    }`;
    const { value: files } = scaffold(topo({ a: `${own}\n    deny: ["Bash(rm *)"]` }));
    const pre = frontmatterHooks(file(files, AGENT_MD)).PreToolUse;
    expect(pre.map((g) => g.matcher)).toEqual(["Write", "Bash"]);
  });

  it("writes no rule hook into settings.json: the rule is the agent's only", () => {
    const { value: files } = scaffold(topo({ a: '    deny: ["Bash(rm *)"]' }));
    const settings = files.find((f) => f.path === ".claude/settings.json");
    expect(settings?.content ?? "").not.toContain("Bash(rm *)");
  });
});

describe("T5: agent ask -> a frontmatter PreToolUse hook that asks", () => {
  it("returns permissionDecision ask in hookSpecificOutput", () => {
    const { value: files } = scaffold(topo({ a: '    ask: ["Bash(git push *)"]' }));
    const [group] = frontmatterHooks(file(files, AGENT_MD)).PreToolUse;
    expect(group.matcher).toBe("Bash");
    const h = group.hooks[0];
    expect(h.if).toBe("Bash(git push *)");
    const r = runHook(h.command as string, { tool_name: "Bash", tool_input: { command: "git push origin main" } });
    expect(r.status).toBe(0);
    expect(checkStdout("PreToolUse", r.stdout)).toBeNull();
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("Bash(git push *)");
  });
});

describe("T5: agent allow -> refused, nothing written", () => {
  it("the binding refuses with the reason", () => {
    expect(() => scaffold(topo({ a: '    allow: ["Bash(npm test)"]' }))).toThrow(BindingRefusal);
    try {
      scaffold(topo({ a: '    allow: ["Bash(npm test)"]' }));
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('agent "a"');
      expect(msg).toContain("Bash(npm test)");
      expect(msg).toContain("settings { allow");
      expect(msg).toContain("Nothing was written");
    }
  });
});

describe("default-mode", () => {
  it("is written to permissions.defaultMode", () => {
    const { value: files } = scaffold(topo({ settings: "    default-mode: acceptEdits" }));
    const s = JSON.parse(file(files, ".claude/settings.json"));
    expect(s.permissions.defaultMode).toBe("acceptEdits");
  });

  for (const mode of ["auto", "bypassPermissions"]) {
    it(`${mode} is refused: project settings ignore it`, () => {
      expect(() => scaffold(topo({ settings: `    default-mode: ${mode}` }))).toThrow(BindingRefusal);
      try {
        scaffold(topo({ settings: `    default-mode: ${mode}` }));
      } catch (e) {
        expect((e as Error).message).toContain("don't take effect from project or local settings");
      }
    });
  }
});

describe("notes: what holds less than it reads", () => {
  it("the topology skill says a per-agent rule needs a trusted folder", () => {
    const { value: files, warnings } = scaffold(topo({ a: '    deny: ["Bash(rm *)"]' }));
    const skill = file(files, ".claude/skills/t/SKILL.md");
    expect(skill).toContain("## Permission rules");
    expect(skill).toContain("Frontmatter hooks in a project subagent");
    expect(warnings.some((w) => w.includes("Frontmatter hooks in a project subagent"))).toBe(true);
  });

  it("a scheduled agent run is headless: the scaffold says project allow rules are not used there", () => {
    const schedule = `  schedule {
    job nightly {
      cron: "0 3 * * *"
      agent: a
    }
  }`;
    const src = topo({ settings: "    allow: [Read]", schedule });
    const note = headlessAllowNote(parse(src));
    expect(note).toContain("permissions.allow");
    expect(note).toContain("Not used");
    // The scaffold command prints it; the binding does not, so validate
    // --inventory (which runs the binding) prints nothing new.
    expect(scaffold(src).warnings.some((w) => w.includes("Not used"))).toBe(false);
    const root = fs.mkdtempSync(join(os.tmpdir(), "at-perm-"));
    try {
      fs.writeFileSync(join(root, "t.at"), src);
      const r = spawnSync("node", [CLI, "scaffold", "t.at", "--target", "claude-code"], { cwd: root, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
      expect(r.status).toBe(0);
      expect(r.stderr).toContain("Not used");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("no note when there are no agent rules and no scheduled agent", () => {
    const { value: files, warnings } = scaffold(topo({ settings: "    allow: [Read]" }));
    expect(file(files, ".claude/skills/t/SKILL.md")).not.toContain("## Permission rules");
    expect(warnings.some((w) => w.includes("Not used"))).toBe(false);
  });
});

describe("no shipped example uses the new fields, so guards-golden proves their scaffold is unchanged", () => {
  it("examples and e2e fixtures declare no agent rules and no default-mode", () => {
    const users: string[] = [];
    for (const dir of ["examples", "src/__tests__/e2e/fixtures"]) {
      for (const f of fs.readdirSync(join(repo, dir)).filter((x) => x.endsWith(".at"))) {
        const ast = parse(fs.readFileSync(join(repo, dir, f), "utf8"));
        const agentRules = ast.nodes.some((n) => n.type === "agent" && ((n as AgentNode).allow ?? (n as AgentNode).ask ?? (n as AgentNode).deny));
        if (agentRules || ast.settings.defaultMode) users.push(`${dir}/${f}`);
      }
    }
    expect(users).toEqual([]);
  });
});

describe("CLI: a refusal exits 1 and writes nothing", () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(join(os.tmpdir(), "at-perm-")); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const cases: Array<[string, string]> = [
    ["agent allow", topo({ a: '    allow: ["Bash(npm test)"]' })],
    ["default-mode bypassPermissions", topo({ settings: "    default-mode: bypassPermissions" })],
  ];
  for (const [name, src] of cases) {
    it(name, () => {
      fs.writeFileSync(join(root, "t.at"), src);
      const r = spawnSync("node", [CLI, "scaffold", "t.at", "--target", "claude-code"], { cwd: root, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("Nothing was written");
      expect(fs.readdirSync(root)).toEqual(["t.at"]);
    });
  }
});
