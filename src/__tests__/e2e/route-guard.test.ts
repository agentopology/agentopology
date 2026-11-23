/**
 * A router's `when` edges compile, not only print (0.13.0).
 *
 * p10-router: agent router has `outputs: { class: question | change | status }`
 * and the flow routes each class (answerer, builder, the action status-screen).
 * Until 0.12.6 the edges were a `## Flow` list in SKILL.md and nothing refused
 * an off-route launch. Now the router records its choice with route.sh, and
 * before-agent.sh refuses to launch an agent whose route the last record does
 * not name. Each case runs the generated scripts the way Claude Code does, with
 * stdin and an environment, in a temp project.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import type { GeneratedFile } from "../../bindings/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = fs.readFileSync(resolve(here, "fixtures/p10-router.at"), "utf-8");
const ast = parse(SOURCE);
const SCRIPTS = ".claude/skills/p10-router/scripts";
const RECORD = ".claude/state/routes-p10-router.jsonl";
const hasJq = spawnSync("/bin/bash", ["-c", "command -v jq"]).status === 0;

let root: string;
let files: GeneratedFile[];

beforeEach(() => {
  root = fs.mkdtempSync(join(os.tmpdir(), "at-route-"));
  files = claudeCodeBinding.scaffold(ast);
  for (const f of files) {
    const p = join(root, f.path);
    fs.mkdirSync(dirname(p), { recursive: true });
    fs.writeFileSync(p, f.content);
    if (f.executable) fs.chmodSync(p, 0o755);
  }
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function run(script: string, args: string[] = [], stdin = "") {
  const r = spawnSync("bash", [join(root, SCRIPTS, script), ...args], {
    input: stdin,
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    cwd: root,
    encoding: "utf8",
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const launch = (agent: string) => run("before-agent.sh", [], JSON.stringify({ tool_name: "Agent", tool_input: { subagent_type: agent } }));
const route = (...args: string[]) => run("route.sh", args);
const file = (path: string) => files.find((f) => f.path === path);

describe("p10-router: the route record and the launch guard are generated", () => {
  it("scaffold writes route.sh and a route check in before-agent.sh for each routed agent", () => {
    const script = file(`${SCRIPTS}/route.sh`);
    expect(script, "route.sh").toBeDefined();
    expect(script!.executable).toBe(true);
    const guard = file(`${SCRIPTS}/before-agent.sh`)?.content ?? "";
    expect(guard).toMatch(/\n {2}answerer\)\n[^]*?route_check 'answerer' 'router\.class=question'/);
    expect(guard).toMatch(/\n {2}builder\)\n[^]*?route_check 'builder' 'router\.class=change'/);
    // the router itself is the target of no conditional edge: no branch for it
    expect(guard).not.toMatch(/\n {2}router\)/);
    const settings = JSON.parse(file(".claude/settings.json")!.content);
    const pre = settings.hooks.PreToolUse as Array<{ matcher: string; hooks: Array<{ command: string }> }>;
    expect(pre.find((h) => h.matcher === "Agent|Task")?.hooks[0].command).toContain("before-agent.sh");
    expect(pre.find((h) => h.matcher === "Write|Edit|MultiEdit|NotebookEdit")?.hooks[0].command).toContain("before-edit.sh");
    // the router is told to record its choice, with the route table
    const agent = file(".claude/agents/router/AGENT.md")!.content;
    expect(agent).toContain(`bash ${SCRIPTS}/route.sh router class <value>`);
    expect(agent).toMatch(/\| question \| answerer \|/);
    expect(agent).toMatch(/\| change \| builder \|/);
    expect(agent).toMatch(/\| status \| status-screen \|/);
  });
});

describe.skipIf(!hasJq)("p10-router: before-agent.sh holds the route", () => {
  it("launching builder after the router recorded question is refused, naming the value and the edge", () => {
    expect(route("router", "class", "question").code).toBe(0);
    const r = launch("builder");
    expect(r.code).toBe(2);
    expect(r.err).toContain('"question"');
    expect(r.err).toContain("router.class == change");
    expect(r.err).toContain("router -> builder");
  });

  it("after change, builder is allowed and answerer is refused", () => {
    expect(route("router", "class", "question").code).toBe(0);
    expect(route("router", "class", "change").code).toBe(0);
    expect(launch("builder").code).toBe(0);
    const a = launch("answerer");
    expect(a.code).toBe(2);
    expect(a.err).toContain('"change"');
  });

  it("with no route record, a conditional target is refused; an unrouted agent is not", () => {
    const r = launch("builder");
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/no route record for router\.class/);
    expect(launch("router").code).toBe(0);
  });

  it("route.sh with an undeclared value (or field) exits 2 and writes nothing", () => {
    const bad = route("router", "class", "bogus");
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("question, change, status");
    expect(fs.existsSync(join(root, RECORD))).toBe(false);
    expect(route("router", "mood", "question").code).toBe(2);
    expect(route("router", "class", "question change").code).toBe(2);
    expect(route("router", "class").code).toBe(2);
    expect(fs.existsSync(join(root, RECORD))).toBe(false);
    expect(route("router", "class", "status").code).toBe(0);
    const rows = fs.readFileSync(join(root, RECORD), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agent: "router", field: "class", value: "status" });
    expect(rows[0].ts).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it("an Edit or Write of the route record is refused; another file is not", () => {
    const edit = (tool: string, p: string) => run("before-edit.sh", [], JSON.stringify({ tool_name: tool, tool_input: { file_path: p } }));
    const e = edit("Edit", join(root, RECORD));
    expect(e.code).toBe(2);
    expect(e.err).toContain("route record");
    expect(edit("Write", RECORD).code).toBe(2);
    expect(edit("Write", join(root, ".claude/state/ROUTES-P10-ROUTER.JSONL")).code).toBe(2);
    expect(edit("Edit", join(root, "src/app.ts")).code).toBe(0);
  });
});

describe("a when edge that does not compile to a refusal warns", () => {
  it("a non-equality condition, and an edge to an action, are named as not enforced", async () => {
    const lib = "../../bindings/lib/route.js";
    const { routeWarnings } = await import(lib);
    const src = SOURCE.replace("router -> answerer [when router.class == question]", "router -> answerer [when router.class != change]");
    const w = routeWarnings(parse(src)).map((r: { message: string }) => r.message);
    expect(w.some((m: string) => m.includes('"router -> answerer"') && m.includes("router.class != change"))).toBe(true);
    expect(w.some((m: string) => m.includes('"router -> status-screen"') && m.includes("action"))).toBe(true);
    // the equality edge to an agent compiles, so it does not warn
    expect(w.some((m: string) => m.includes('"router -> builder"'))).toBe(false);
  });
});
