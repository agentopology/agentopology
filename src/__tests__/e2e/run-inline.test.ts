/**
 * A gate `run:` whose first word is a program (`grep -q closed his.md`,
 * `npm test`, a pipeline) is a command to run as written. It used to be read
 * as a project script, so scaffold wrote a stub `scripts/grep` that exits 2
 * always and the gate refused with and without the file.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import { codexBinding } from "../../bindings/codex.js";
import { checkGuards } from "../../guard/check.js";
import { isInlineRun } from "../../parser/run.js";

const source = (run: string) => `topology inl : [pipeline] {
  meta { version: "1.0.0"  description: "inline gate" }
  orchestrator { model: sonnet  handles: [writer, reviewer] }
  agent writer { model: sonnet  description: "Writes"  prompt { Write. } }
  agent reviewer { model: sonnet  description: "Reviews"  prompt { Review. } }
  flow { writer -> reviewer }
  gates {
    gate check {
      after: writer
      run: ${JSON.stringify(run)}
    }
  }
}
`;

let root: string;
const at = (p: string) => join(root, p);
beforeEach(() => { root = fs.mkdtempSync(join(os.tmpdir(), "at-inline-")); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function scaffold(run: string) {
  const ast = parse(source(run));
  const files = claudeCodeBinding.scaffold(ast);
  for (const f of files) {
    fs.mkdirSync(dirname(at(f.path)), { recursive: true });
    fs.writeFileSync(at(f.path), f.content);
  }
  return { ast, files };
}
const wrapper = () => spawnSync("bash", [at(".claude/skills/inl/scripts/gate-check.sh")], { cwd: root, env: { ...process.env, CLAUDE_PROJECT_DIR: root }, encoding: "utf8", timeout: 20_000 });

describe("which run: values are inline commands", () => {
  it.each([
    "grep -q closed his.md",
    "cmd | grep -q x",
    "npm test",
    "git diff --quiet",
    "jq -e .ok out.json",
    "bash -c 'test -s out.json'",
  ])("%s is inline", (run) => expect(isInlineRun(run)).toBe(true));

  it.each([
    "scripts/check.sh",
    "check-review",
    "python3 tools/check.py --x",
    "bash .claude/hooks/x.sh",
    "./check.sh",
    "node scripts/c.js",
    "python3 check.py",
  ])("%s names a script and stays one", (run) => expect(isInlineRun(run)).toBe(false));
});

describe("an inline gate run", () => {
  it("writes no stub script for it", () => {
    const { files } = scaffold("grep -q closed his.md");
    expect(files.some((f) => f.stub === "gate")).toBe(false);
    expect(files.some((f) => /\/scripts\/grep$/.test(f.path))).toBe(false);
  });

  it("refuses without the file and passes with it", () => {
    scaffold("grep -q closed his.md");
    expect(wrapper().status).toBe(2);
    fs.writeFileSync(at("his.md"), "all closed\n");
    expect(wrapper().status).toBe(0);
    fs.writeFileSync(at("his.md"), "still open\n");
    expect(wrapper().status).toBe(2);
  });

  it("runs a pipeline as a whole", () => {
    scaffold("cat his.md | grep -q closed");
    fs.writeFileSync(at("his.md"), "closed\n");
    expect(wrapper().status).toBe(0);
    fs.writeFileSync(at("his.md"), "open\n");
    expect(wrapper().status).toBe(2);
  });

  it("runs from the project folder, whatever the hook's folder is", () => {
    scaffold("grep -q closed his.md");
    fs.writeFileSync(at("his.md"), "closed\n");
    fs.mkdirSync(at("sub"));
    const r = spawnSync("bash", [at(".claude/skills/inl/scripts/gate-check.sh")], { cwd: at("sub"), env: { ...process.env, CLAUDE_PROJECT_DIR: root }, encoding: "utf8", timeout: 20_000 });
    expect(r.status).toBe(0);
  });

  it("passes validation", () => {
    for (const run of ["grep -q closed his.md", "cat a | grep -q x", "npm test"]) {
      expect(validate(parse(source(run))).filter((r) => r.rule === "V96" && r.level === "error"), run).toEqual([]);
    }
  });

  it("is graded by the gate's strength, not as a missing or stub script", () => {
    const { ast } = scaffold("grep -q closed his.md");
    const g = checkGuards(ast, root).items.find((i) => i.id === "check")!;
    expect(g.strength).toBe("refuse");
    expect(g.notes.join(" ")).not.toMatch(/missing|stub/);
  });

  it("writes no stub on Codex either", () => {
    const files = codexBinding.scaffold(parse(source("grep -q closed his.md")));
    expect(files.some((f) => f.stub === "gate")).toBe(false);
  });

  it("keeps `[` refused, and says to write test", () => {
    const r = validate(parse(source("[ -f his.md ]"))).filter((x) => x.rule === "V96");
    expect(r.length).toBe(1);
    expect(r[0].message).toMatch(/test -f/);
  });
});

describe("a run: that names a script is unchanged", () => {
  it("a bare script name still gets a stub", () => {
    const { files } = scaffold("check-review");
    expect(files.some((f) => f.stub === "gate")).toBe(true);
  });
  it("a project path that does not exist yet still gets a stub", () => {
    const { files } = scaffold("python3 tools/check.py");
    expect(files.some((f) => f.stub === "gate" && f.path === "tools/check.py")).toBe(true);
  });
});
