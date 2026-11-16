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

/**
 * Run a hook command the way Claude Code does: a shell in the project, the
 * payload on stdin, CLAUDE_PROJECT_DIR set. The scaffold is written to a temp
 * project first, since the command runs a generated script. `stdin` replaces
 * the payload (for broken input); `path` replaces PATH (for a PATH without jq).
 */
function runHook(files: Array<{ path: string; content: string }>, command: string, payload: object, opts: { stdin?: string; path?: string } = {}) {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "at-hook-"));
  try {
    for (const f of files) {
      fs.mkdirSync(dirname(join(dir, f.path)), { recursive: true });
      fs.writeFileSync(join(dir, f.path), f.content);
    }
    return spawnSync("/bin/sh", ["-c", command], {
      cwd: dir,
      input: opts.stdin ?? JSON.stringify(payload),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir, ...(opts.path !== undefined ? { PATH: opts.path } : {}) },
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A PATH holding bash and tr but no jq. */
function pathWithoutJq(): string {
  const bin = fs.mkdtempSync(join(os.tmpdir(), "at-nojq-"));
  for (const tool of ["bash", "tr", "cat", "sh"]) {
    const real = spawnSync("/bin/sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
    if (real) fs.symlinkSync(real, join(bin, tool));
  }
  return bin;
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
    // R6: no `if:`; the script decides, the matcher stays.
    expect(h.if).toBeUndefined();
    // A deny hook that cannot start must not let the call through (Claude Code 2.1.295+).
    expect(h.onFailure).toBe("block");
    const r = runHook(files, h.command as string, { tool_name: "Bash", tool_input: { command: "kubectl delete pod x" } });
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
    const r = runHook(files, h.command as string, { tool_name: "Bash", tool_input: { command: "echo 'x' y" } });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("Bash(echo 'x' *)");
  });

  it("one handler per rule (\"The `if` field holds exactly one permission rule\")", () => {
    const { value: files } = scaffold(topo({ a: '    deny: ["Bash(rm *)", "Bash(curl *)"]' }));
    const pre = frontmatterHooks(file(files, AGENT_MD)).PreToolUse;
    const rules = pre.flatMap((g) => g.hooks.map((h) => String(h.command).includes("'Bash(rm *)'") ? "Bash(rm *)" : String(h.command).includes("'Bash(curl *)'") ? "Bash(curl *)" : "?"));
    expect(rules).toEqual(["Bash(rm *)", "Bash(curl *)"]);
    expect(pre.flatMap((g) => g.hooks.map((h) => h.if))).toEqual([undefined, undefined]);
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

describe("S-51: an agent Edit deny says what it does not block", () => {
  for (const rule of ["Edit", '"Edit(/src/**)"']) {
    it(`deny: [${rule}] warns that Write, MultiEdit and NotebookEdit are not blocked`, () => {
      const { warnings } = scaffold(topo({ a: `    deny: [${rule}]` }));
      const w = warnings.find((x) => x.includes("S-51") || x.includes("NotebookEdit"));
      expect(w).toBeDefined();
      expect(w).toContain('agent "a"');
      expect(w).toContain("Write, MultiEdit and NotebookEdit are not blocked");
      expect(w).toContain("settings { deny");
      expect(w).toContain("`Edit` rules apply to all built-in tools that edit files");
    });
  }

  it("the matcher stays Edit (not widened)", () => {
    const { value: files } = scaffold(topo({ a: '    deny: ["Edit(/src/**)"]' }));
    expect(frontmatterHooks(file(files, AGENT_MD)).PreToolUse[0].matcher).toBe("Edit");
  });

  it("no such warning for a deny on another tool", () => {
    const { warnings } = scaffold(topo({ a: '    deny: ["Bash(rm *)"]' }));
    expect(warnings.some((x) => x.includes("NotebookEdit"))).toBe(false);
  });
});

describe("T5: agent ask -> a frontmatter PreToolUse hook that asks", () => {
  it("returns permissionDecision ask in hookSpecificOutput", () => {
    const { value: files } = scaffold(topo({ a: '    ask: ["Bash(git push *)"]' }));
    const [group] = frontmatterHooks(file(files, AGENT_MD)).PreToolUse;
    expect(group.matcher).toBe("Bash");
    const h = group.hooks[0];
    expect(h.if).toBeUndefined();
    const r = runHook(files, h.command as string, { tool_name: "Bash", tool_input: { command: "git push origin main" } });
    expect(r.status).toBe(0);
    expect(checkStdout("PreToolUse", r.stdout)).toBeNull();
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("Bash(git push *)");
  });
});

describe("condition C: the agent hook matches the rule itself and fails closed", () => {
  /** The scaffold and the one rule hook of agent a. */
  function rig(list: "deny" | "ask", rule: string) {
    const { value: files, warnings } = scaffold(topo({ a: `    ${list}: [${JSON.stringify(rule)}]` }));
    const h = frontmatterHooks(file(files, AGENT_MD)).PreToolUse[0].hooks[0];
    const run = (payload: object, opts: { stdin?: string; path?: string } = {}) => runHook(files, h.command as string, payload, opts);
    return { h, run, warnings };
  }
  const bash = (command: string) => ({ tool_name: "Bash", tool_input: { command } });
  const asked = (r: { status: number | null; stdout: string }) =>
    r.status === 0 && r.stdout.trim() !== "" && JSON.parse(r.stdout).hookSpecificOutput.permissionDecision === "ask";

  describe("deny", () => {
    const deny = () => rig("deny", "Bash(kubectl delete *)");

    it("R6: carries no if:", () => {
      expect(deny().h.if).toBeUndefined();
    });
    it("a non-matching Bash call passes", () => {
      const r = deny().run(bash("kubectl get pods"));
      expect(r.status, r.stderr).toBe(0);
    });
    it("a matching call blocks", () => {
      const r = deny().run(bash("kubectl delete pod web-1"));
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("Bash(kubectl delete *)");
    });
    it("a compound command containing the match blocks", () => {
      for (const c of ["echo hi && kubectl delete pod x", "true; kubectl delete pod x", "ls | kubectl delete -f -", "(kubectl delete ns a)"]) {
        expect(deny().run(bash(c)).status, c).toBe(2);
      }
    });
    it("a wrapper or an assignment in front still blocks (as Claude Code strips them)", () => {
      for (const c of ["timeout 30 kubectl delete pod x", "nohup kubectl delete pod x", "KUBECONFIG=/x kubectl delete pod x", "command kubectl delete pod x"]) {
        expect(deny().run(bash(c)).status, c).toBe(2);
      }
    });
    it("a trailing ' *' also matches the bare command; 'ls *' does not match lsof", () => {
      const ls = rig("deny", "Bash(ls *)");
      expect(ls.run(bash("ls")).status).toBe(2);
      expect(ls.run(bash("ls -la")).status).toBe(2);
      expect(ls.run(bash("lsof")).status).toBe(0);
    });
    it("broken stdin blocks, and says why", () => {
      const r = deny().run({}, { stdin: "{ not json" });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("not valid JSON");
    });
    it("jq missing blocks, and says why", () => {
      const r = deny().run(bash("kubectl get pods"), { path: pathWithoutJq() });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("jq");
    });
    it("a command substitution that could hide the match blocks", () => {
      expect(deny().run(bash("echo $(kubectl delete pod x)")).status).toBe(2);
      expect(deny().run(bash("x=`kubectl delete pod x`")).status).toBe(2);
    });
    it("an unsupported rule form blocks with its reason, and scaffold says so", () => {
      const e = rig("deny", "Edit(/src/**)");
      const r = e.run({ tool_name: "Edit", tool_input: { file_path: "/p/README.md" } });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("cannot match");
      expect(e.warnings.some((w) => w.includes("Edit(/src/**)") && w.includes("every Edit call"))).toBe(true);
    });
    it("a parameter rule matches the input field", () => {
      const p = rig("deny", "Agent(model:opus)");
      expect(p.run({ tool_name: "Agent", tool_input: { model: "opus", prompt: "x" } }).status).toBe(2);
      expect(p.run({ tool_name: "Agent", tool_input: { model: "sonnet", prompt: "x" } }).status).toBe(0);
      expect(p.run({ tool_name: "Agent", tool_input: { prompt: "x" } }).status).toBe(0);
    });
    it("a domain rule matches the host and its subdomains", () => {
      const d = rig("deny", "WebFetch(domain:example.com)");
      expect(d.run({ tool_name: "WebFetch", tool_input: { url: "https://example.com/a" } }).status).toBe(2);
      expect(d.run({ tool_name: "WebFetch", tool_input: { url: "https://docs.example.com/a" } }).status).toBe(2);
      expect(d.run({ tool_name: "WebFetch", tool_input: { url: "https://other.org/" } }).status).toBe(0);
      expect(d.run({ tool_name: "WebFetch", tool_input: { url: "not a url" } }).status).toBe(2);
    });
    it("a bare tool rule blocks every call, even without jq", () => {
      const w = rig("deny", "Write");
      expect(w.run({ tool_name: "Write", tool_input: { file_path: "x" } }, { path: pathWithoutJq() }).status).toBe(2);
    });
  });

  describe("ask", () => {
    const ask = () => rig("ask", "Bash(git push *)");

    it("a non-matching call prints nothing and exits 0", () => {
      const r = ask().run(bash("git status"));
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.trim()).toBe("");
    });
    it("a matching call, also inside a compound command, asks", () => {
      expect(asked(ask().run(bash("git push origin main")))).toBe(true);
      expect(asked(ask().run(bash("git add . && git push")))).toBe(true);
    });
    it("asks on every doubt: broken stdin, jq missing, a command substitution, an unsupported form", () => {
      expect(asked(ask().run({}, { stdin: "nope" }))).toBe(true);
      expect(asked(ask().run(bash("git status"), { path: pathWithoutJq() }))).toBe(true);
      expect(asked(ask().run(bash("echo $(git push)")))).toBe(true);
      const e = rig("ask", "Read(./secrets/**)");
      const r = e.run({ tool_name: "Read", tool_input: { file_path: "a" } });
      expect(asked(r)).toBe(true);
      expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason).toContain("cannot match");
    });
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

  it("R7: the warning and the skill say an agent hook is a guardrail, not a security boundary", () => {
    const { value: files, warnings } = scaffold(topo({ a: '    deny: ["Bash(rm *)"]' }));
    const skill = file(files, ".claude/skills/t/SKILL.md");
    const limit = "An agent hook is a guardrail, not a security boundary: the agent can edit the files that hold it. For a hard deny, use settings { deny }.";
    const quote = "use the permission system rather than a hook to enforce a hard allow or deny";
    for (const text of [skill, warnings.join("\n")]) {
      expect(text).toContain(limit);
      expect(text).toContain(quote);
    }
    // No settings deny on the script.
    const settings = files.find((f) => f.path === ".claude/settings.json");
    expect(settings?.content ?? "").not.toContain("agent-rule.sh");
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
