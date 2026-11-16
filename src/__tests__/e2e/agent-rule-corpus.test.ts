/**
 * The agent deny/ask hook (scripts/agent-rule.sh) against a corpus of inputs,
 * each run as a real process (manager condition 1).
 *
 * One row = [rule, kind, input, expected, source, env?]:
 * - kind "deny": expected "block" (exit 2) or "pass" (exit 0, nothing printed);
 * - kind "ask": expected "ask" (exit 0, permissionDecision ask) or "pass";
 * - kind "both": the row runs as deny and as ask; "block" means deny blocks
 *   and ask asks.
 * Doubt is denied (an ask asks): over-blocking is accepted (ruling R5).
 *
 * Bash rows are gone: an agent deny or ask on Bash is refused before any hook
 * exists (ruling c; permission-scaffold.test.ts tests the refusal). What is
 * left: malformed input, the environment (jq missing or lying, a CRLF
 * checkout), domains, parameters and Agent(name).
 * Sources: fable-r3 (malformed input, environment, domains, params), R3, R4,
 * R8, R12, R14 (the rulings). Adding a case is one line.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { parse } from "../../parser/index.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";

type Kind = "deny" | "ask" | "both";
type Expected = "block" | "ask" | "pass";
/** Environment changes for a row: no jq on PATH, a jq that prints nothing or `true`, the script saved with CRLF. */
type Env = "nojq" | "jq-empty" | "jq-true" | "crlf";
type Row = [rule: string, kind: Kind, input: object | string, expected: Expected, source: string, env?: Env];

const fetch = (url: unknown) => ({ hook_event_name: "PreToolUse", tool_name: "WebFetch", tool_input: { url } });
const agent = (tool_input: unknown) => ({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input });
const D = "WebFetch(domain:evil.com)";
const B = "both";

const ROWS: Row[] = [
  // --- fable r3: malformed input (doubt)
  [D, B, "", "block", "fable-r3"],
  [D, B, "   ", "block", "fable-r3"],
  [D, B, "{ not json", "block", "fable-r3"],
  [D, B, "null", "block", "fable-r3"],
  [D, B, "[]", "block", "fable-r3"],
  [D, B, '"s"', "block", "fable-r3"],
  [D, B, "{}", "block", "fable-r3"],
  [D, B, { tool_name: "WebFetch", tool_input: null }, "block", "fable-r3"],
  [D, B, { tool_name: "WebFetch", tool_input: "https://evil.com/" }, "block", "fable-r3"],
  [D, B, JSON.stringify(fetch("https://good.com/")) + JSON.stringify(fetch("https://evil.com/")), "block", "fable-r3"],
  [D, B, JSON.stringify(fetch("https://evil.com/")) + JSON.stringify(fetch("https://good.com/")), "block", "fable-r3"],
  // --- fable r3: environment
  [D, B, fetch("https://good.com/"), "block", "fable-r3", "nojq"],
  [D, B, fetch("https://evil.com/"), "block", "fable-r3", "jq-empty"],
  [D, B, fetch("https://evil.com/"), "block", "fable-r3", "jq-true"],
  [D, B, fetch("https://evil.com/"), "block", "R14", "crlf"],
  [D, B, fetch("https://good.com/"), "pass", "R14", "crlf"],
  // --- R3/R4/R12: domains
  [D, B, fetch("https://evil.com/"), "block", "fable-r3"],
  [D, B, fetch("HTTPS://EVIL.COM/x"), "block", "fable-r3"],
  [D, B, fetch("https://evil.com:443/x"), "block", "fable-r3"],
  [D, B, fetch("https://evil.com?x=1"), "block", "fable-r3"],
  [D, B, fetch("http://evil.com./"), "block", "R12"],
  [D, B, fetch("https://user@evil.com/"), "block", "fable-r3"],
  [D, B, fetch("https://good.com@evil.com/"), "block", "fable-r3"],
  [D, B, fetch("https://a@b@evil.com/"), "block", "R3"],
  [D, B, fetch("https://evil.com\\.good.com/"), "block", "R3"],
  [D, B, fetch("https://evil.com\\@good.com/"), "block", "R3"],
  [D, B, fetch("https://ev%69l.com/"), "block", "R3"],
  [D, B, fetch("https://evil%2Ecom/"), "block", "R3"],
  [D, B, fetch("https://ｅvil.com/"), "block", "R3"],
  [D, B, fetch("https://evil。com/"), "block", "R3"],
  [D, B, fetch("https://ev­il.com/"), "block", "R3"],
  [D, B, fetch("https://ev\til.com/"), "block", "R3"],
  [D, B, fetch("https://evil\n.com/"), "block", "R3"],
  [D, B, fetch("https://evil.com /"), "block", "R3"],
  [D, B, fetch(" https://evil.com/"), "block", "R3"],
  [D, B, fetch("https:/evil.com/"), "block", "R3"],
  [D, B, fetch("ftp://evil.com/"), "block", "R3"],
  [D, B, fetch("evil.com"), "block", "R3"],
  [D, B, fetch(""), "block", "R3"],
  [D, B, fetch(1), "block", "fable-r3"],
  [D, B, { tool_name: "WebFetch" }, "block", "fable-r3"],
  [D, B, fetch("https://api.evil.com/"), "pass", "R12"],
  [D, B, fetch("https://notevil.com/"), "pass", "R12"],
  [D, B, fetch("https://good.com/evil.com"), "pass", "R12"],
  ["WebFetch(domain:*.evil.com)", B, fetch("https://api.evil.com/"), "block", "R4"],
  ["WebFetch(domain:*.evil.com)", B, fetch("https://a.b.evil.com/"), "block", "R4"],
  ["WebFetch(domain:*.evil.com)", B, fetch("https://evil.com/"), "pass", "R4"],
  ["WebFetch(domain:*.evil.com)", B, fetch("https://notevil.com/"), "pass", "R4"],
  ["WebFetch(domain:*.evil.com)", B, fetch("https://evil.com /"), "block", "R3"],
  // --- R8: param rules
  ["Agent(model:opus)", B, agent({ model: "opus" }), "block", "fable-r3"],
  ["Agent(model:opus)", B, agent({ model: "sonnet" }), "pass", "fable-r3"],
  ["Agent(model:opus)", B, agent({ prompt: "x" }), "pass", "fable-r3"],
  ["Agent(model:opus)", B, agent({ model: ["opus"] }), "block", "fable-r3"],
  ["Agent(model:opus)", B, { tool_name: "Agent" }, "block", "R8"],
  ["Agent(model:opus)", B, agent(null), "block", "R8"],
  ["Agent(model:opus)", B, agent(false), "block", "R8"],
  // --- R12: Agent(name) matches tool_input.subagent_type
  ["Agent(Explore)", B, agent({ subagent_type: "Explore", prompt: "x" }), "block", "R12"],
  ["Agent(Explore)", B, agent({ subagent_type: "Plan", prompt: "x" }), "pass", "R12"],
  ["Agent(Explore)", B, agent({ prompt: "x" }), "block", "R12"],
  ["Agent(Explore)", B, agent({ subagent_type: 1 }), "block", "R12"],
];

// ---------------------------------------------------------------------------

const topo = (list: "deny" | "ask", rule: string) => `topology t : [pipeline] {
  meta {
    version: "1.0.0"
    description: "corpus"
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
    tools: [WebFetch, Agent, Read]
    ${list}: [${JSON.stringify(rule)}]
  }
  flow {
    intake -> a
  }
}
`;

const SCRIPT = ".claude/skills/t/scripts/agent-rule.sh";
let root: string;
const projects = new Map<string, { dir: string; command: string }>();
const envDirs = new Map<Env, string>();

/** A project scaffolded for one rule, written once. */
function project(list: "deny" | "ask", rule: string, env?: Env) {
  const key = `${list} ${rule} ${env ?? ""}`;
  const known = projects.get(key);
  if (known) return known;
  const dir = fs.mkdtempSync(join(root, "p-"));
  const files = claudeCodeBinding.scaffold(parse(topo(list, rule)));
  for (const f of files) {
    fs.mkdirSync(dirname(join(dir, f.path)), { recursive: true });
    fs.writeFileSync(join(dir, f.path), env === "crlf" ? f.content.replace(/\n/g, "\r\n") : f.content);
  }
  const md = fs.readFileSync(join(dir, ".claude/agents/a/AGENT.md"), "utf8").replace(/\r\n/g, "\n");
  const line = md.split("\n").find((l) => /^\s+(- )?command: "/.test(l));
  if (!line) throw new Error(`no hook command for ${key}`);
  const command = JSON.parse(line.replace(/^\s+(- )?command: /, "")) as string;
  const p = { dir, command };
  projects.set(key, p);
  return p;
}

/** A PATH for an environment row: bash and cat, and no jq, or a jq that lies. */
function envPath(env: Env): string | undefined {
  if (env === "crlf") return undefined;
  const known = envDirs.get(env);
  if (known) return known;
  const bin = fs.mkdtempSync(join(root, `bin-${env}-`));
  for (const tool of ["bash", "cat", "sh"]) {
    const real = spawnSync("/bin/sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
    if (real) fs.symlinkSync(real, join(bin, tool));
  }
  if (env === "jq-empty") fs.writeFileSync(join(bin, "jq"), "#!/bin/sh\ncat >/dev/null\nexit 0\n", { mode: 0o755 });
  if (env === "jq-true") fs.writeFileSync(join(bin, "jq"), "#!/bin/sh\ncat >/dev/null\necho true\nexit 0\n", { mode: 0o755 });
  envDirs.set(env, bin);
  return bin;
}

function run(list: "deny" | "ask", rule: string, input: object | string, env?: Env) {
  const { dir, command } = project(list, rule, env);
  const path = env ? envPath(env) : undefined;
  return spawnSync("/bin/sh", ["-c", command], {
    cwd: dir,
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, ...(path ? { PATH: path } : {}) },
  });
}

const verdict = (list: "deny" | "ask", r: ReturnType<typeof run>): string => {
  if (list === "deny") return r.status === 2 ? "block" : r.status === 0 && r.stdout.trim() === "" ? "pass" : `other(exit ${r.status}, ${r.stdout.slice(0, 60)} ${r.stderr.slice(0, 120)})`;
  if (r.status !== 0) return `other(exit ${r.status}, ${r.stderr.slice(0, 120)})`;
  if (r.stdout.trim() === "") return "pass";
  try {
    return JSON.parse(r.stdout).hookSpecificOutput.permissionDecision === "ask" ? "ask" : `other(${r.stdout.slice(0, 60)})`;
  } catch {
    return `other(${r.stdout.slice(0, 60)})`;
  }
};

const show = (v: unknown) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 70 ? `${s.slice(0, 50)}…(${s.length} chars)` : s;
};

beforeAll(() => {
  root = fs.mkdtempSync(join(os.tmpdir(), "at-corpus-"));
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("agent-rule.sh corpus (condition 1)", () => {
  for (const [rule, kind, input, expected, source, env] of ROWS) {
    const lists = kind === "both" ? (["deny", "ask"] as const) : ([kind] as const);
    for (const list of lists) {
      const want = expected === "pass" ? "pass" : list === "deny" ? "block" : "ask";
      const name = `[${source}] ${list} ${rule} ${show(typeof input === "object" && input && "tool_input" in input ? (input as { tool_input: unknown }).tool_input : input)}${env ? ` (${env})` : ""} -> ${want}`;
      it(name, () => {
        expect(verdict(list, run(list, rule, input, env))).toBe(want);
      });
    }
  }
  it("the generated script exists where the hooks run it", () => {
    const { dir } = project("deny", D);
    expect(fs.existsSync(join(dir, SCRIPT))).toBe(true);
  });
});
