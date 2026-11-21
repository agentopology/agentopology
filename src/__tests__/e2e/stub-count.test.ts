/**
 * Stubs are counted, per kind, wherever a person looks before running the
 * topology (fixtures/stub-count/stubs.at: one action, gate, hook and tool stub, and one
 * action that points at its real commands).
 *
 * - validate prints how many of the files scaffold would write are stubs, by
 *   kind, from the binding's own output (plannedStubs), so validate and
 *   scaffold cannot disagree; --json carries the same count.
 * - scaffold (dry run and real) prints the same count by kind; a path that
 *   already holds the user's own file is not a stub and is not counted.
 * - an action's commands: is the call: its script runs them as written.
 * - guard --check grades a gate whose check script is still a stub `none`
 *   (it checks nothing), on Claude Code and on Codex, and counts it missing.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import { codexBinding } from "../../bindings/codex.js";
import { isStubContent, STUB_MARKER } from "../../bindings/lib/stub.js";
import { plannedStubs, stubKindLine } from "../../scaffold/stubs.js";
import { checkGuards } from "../../guard/check.js";
import { checkCodexGuards } from "../../guard/check-codex.js";
import type { GeneratedFile } from "../../bindings/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "fixtures/stub-count/stubs.at");
const CLI = resolve(here, "../../../dist/cli/index.js");
const SOURCE = fs.readFileSync(FIXTURE, "utf-8");
/** Codex runs no Claude model: the same topology with a Codex model. */
const CODEX_SOURCE = SOURCE.replaceAll("model: sonnet", "model: gpt-5.2");
const ast = parse(SOURCE);
const codexAst = parse(CODEX_SOURCE);
const ALL_KINDS = "1 gate check script, 1 hook script, 1 action script, 1 tool script";
const CODEX_KINDS = "1 gate check script, 1 hook script, 1 tool script";

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(join(os.tmpdir(), "at-stub-count-")); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const cli = (args: string[]) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  return { stdout: r.stdout, stderr: r.stderr, code: r.status };
};
const quiet = <T>(f: () => T): T => {
  const warn = console.warn;
  console.warn = () => {};
  try { return f(); } finally { console.warn = warn; }
};
const write = (root: string, files: GeneratedFile[]) => {
  for (const f of files) {
    fs.mkdirSync(dirname(join(root, f.path)), { recursive: true });
    fs.writeFileSync(join(root, f.path), f.content);
  }
};
const codexFile = () => { const p = join(tmp, "stubs-codex.at"); fs.writeFileSync(p, CODEX_SOURCE); return p; };

describe("every stub a binding writes says its kind", () => {
  it("claude-code: the action, gate, hook and tool stubs carry their kind; the action with commands is no stub", () => {
    const files = quiet(() => claudeCodeBinding.scaffold(ast));
    const stubs = files.filter((f) => isStubContent(f.content));
    expect(stubs.map((f) => [f.path, f.stub])).toEqual([
      [".claude/skills/stubs/scripts/action-pull.sh", "action"],
      [".claude/skills/stubs/scripts/check.sh", "gate"],
      [".claude/skills/stubs/scripts/block-push.sh", "hook"],
      ["tools/fmt.py", "tool"],
    ]);
  });

  it("codex: the gate, hook and tool stubs carry their kind", () => {
    const files = quiet(() => codexBinding.scaffold(codexAst));
    const stubs = files.filter((f) => isStubContent(f.content));
    expect(stubs.map((f) => [f.path, f.stub])).toEqual([
      [".codex/scripts/check.sh", "gate"],
      [".codex/scripts/block-push.sh", "hook"],
      ["tools/fmt.py", "tool"],
    ]);
  });
});

describe("plannedStubs: the count validate and scaffold share", () => {
  it("claude-code: 4 of 11 files, one per kind", () => {
    const plan = plannedStubs(ast, "claude-code")!;
    expect(plan.files).toBe(11);
    expect(plan.stubs.map((s) => s.kind)).toEqual(["action", "gate", "hook", "tool"]);
    expect(stubKindLine(plan.stubs)).toBe(ALL_KINDS);
  });

  it("codex: 3 of 10 files", () => {
    const plan = plannedStubs(codexAst, "codex")!;
    expect(plan.files).toBe(10);
    expect(stubKindLine(plan.stubs)).toBe(CODEX_KINDS);
  });

  it("a stub path that already holds the user's own file is not counted; one that still holds a stub is", () => {
    fs.mkdirSync(join(tmp, "tools"), { recursive: true });
    fs.writeFileSync(join(tmp, "tools/fmt.py"), "print('formatted')\n");
    const plan = plannedStubs(ast, "claude-code", tmp)!;
    expect(stubKindLine(plan.stubs)).toBe("1 gate check script, 1 hook script, 1 action script");
    expect(plan.yours).toEqual(["tools/fmt.py"]);
    fs.writeFileSync(join(tmp, "tools/fmt.py"), `#!/usr/bin/env python3\n${STUB_MARKER}\n`);
    expect(stubKindLine(plannedStubs(ast, "claude-code", tmp)!.stubs)).toBe(ALL_KINDS);
  });

  it("the plan prints none of the binding's warnings", () => {
    const warn = console.warn;
    const said: string[] = [];
    console.warn = (m: string) => { said.push(m); };
    try { plannedStubs(codexAst, "codex"); } finally { console.warn = warn; }
    expect(said).toEqual([]);
  });
});

describe("validate prints the stub count by kind", () => {
  it("claude-code (the default target)", () => {
    const r = cli(["validate", FIXTURE]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`stubs (claude-code): 4 of 11 generated files are stubs: ${ALL_KINDS}`);
  });

  it("codex, with --target codex", () => {
    const r = cli(["validate", codexFile(), "--target", "codex"]);
    expect(r.stdout).toContain(`stubs (codex): 3 of 10 generated files are stubs: ${CODEX_KINDS}`);
  });

  it("with --dir, a path that holds the user's own file is said apart", () => {
    fs.mkdirSync(join(tmp, "tools"), { recursive: true });
    fs.writeFileSync(join(tmp, "tools/fmt.py"), "print('formatted')\n");
    const r = cli(["validate", FIXTURE, "--dir", tmp]);
    expect(r.stdout).toContain("stubs (claude-code): 3 of 11 generated files are stubs: 1 gate check script, 1 hook script, 1 action script");
    expect(r.stdout).toContain("1 stub path already holds your own file: tools/fmt.py");
  });

  it("no stubs, no line", () => {
    const p = join(tmp, "plain.at");
    fs.writeFileSync(p, SOURCE.replace(/  gates \{[\s\S]*?\n  \}\n\n  hooks \{[\s\S]*?\n  \}\n\n  tools \{[\s\S]*?\n  \}\n/, "").replace(/  action pull \{[\s\S]*?\n  \}\n/, "").replace("handles: [fetch, pull]", "handles: [fetch]").replace("    fetch -> pull\n    pull -> writer", "    fetch -> writer"));
    const r = cli(["validate", p]);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("stubs (");
  });

  it("validate --json carries the count", () => {
    const r = cli(["validate", FIXTURE, "--inventory", tmp, "--json"]);
    const j = JSON.parse(r.stdout);
    expect(j.stubs).toEqual({ target: "claude-code", files: 11, total: 4, byKind: { gate: 1, hook: 1, action: 1, tool: 1 } });
  });
});

describe("scaffold prints the stub count by kind", () => {
  for (const dry of [true, false]) {
    it(`claude-code${dry ? ", dry run" : ""}`, () => {
      const r = cli(["scaffold", FIXTURE, "--target", "claude-code", "--output", join(tmp, "out"), ...(dry ? ["--dry-run"] : [])]);
      expect(r.code).toBe(0);
      expect(r.stderr).toContain("4 stub(s) need implementation before this topology can run:");
      expect(r.stderr).toContain(`by kind: ${ALL_KINDS}`);
    });

    it(`codex${dry ? ", dry run" : ""}`, () => {
      const r = cli(["scaffold", codexFile(), "--target", "codex", "--output", join(tmp, "out"), ...(dry ? ["--dry-run"] : [])]);
      expect(r.code).toBe(0);
      expect(r.stderr).toContain("3 stub(s) need implementation before this topology can run:");
      expect(r.stderr).toContain(`by kind: ${CODEX_KINDS}`);
    });
  }

  it("a stub path that holds the user's own file is neither listed nor counted", () => {
    const out = join(tmp, "out");
    fs.mkdirSync(join(out, "tools"), { recursive: true });
    fs.writeFileSync(join(out, "tools/fmt.py"), "print('formatted')\n");
    const r = cli(["scaffold", FIXTURE, "--target", "claude-code", "--output", out, "--dry-run"]);
    expect(r.stderr).toContain("3 stub(s) need implementation before this topology can run:");
    expect(r.stderr).toContain("by kind: 1 gate check script, 1 hook script, 1 action script");
    expect(r.stderr).not.toMatch(/·\s+tools\/fmt\.py/);
  });
});

describe("an action's commands: is the call, not a stub", () => {
  it("the script runs each command as written, interpreter flags and npx included", () => {
    const script = quiet(() => claudeCodeBinding.scaffold(ast)).find((f) => f.path === ".claude/skills/stubs/scripts/action-fetch.sh")!;
    expect(isStubContent(script.content)).toBe(false);
    const lines = script.content.split("\n");
    expect(lines).toContain("python3 -I tools/fetch.py --since 7d");
    expect(lines).toContain("npx foo");
  });
});

describe("guard --check grades a stubbed gate none", () => {
  // A stub blocks every run (it lets nothing through), so it is not counted
  // missing: the exit code is unchanged, the grade and its own line say it.
  it("claude-code: none while its check script is a stub, said on its own line, not missing (exit 0); refuse once written", () => {
    write(tmp, quiet(() => claudeCodeBinding.scaffold(ast)));
    let g = checkGuards(ast, tmp).items.find((i) => i.id === "check")!;
    expect(g.strength).toBe("none");
    expect(g.notes.join(" ")).toMatch(/still a stub: it checks nothing/);
    expect(checkGuards(ast, tmp).missing).toBe(0);
    expect(checkGuards(ast, tmp).enforcement.refuse).toBe(0);
    const r = cli(["guard", FIXTURE, "--check", "--dir", tmp]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/gate check\s+none\s+by: hook/);
    expect(r.stdout).toContain("1 gate(s) graded none because their check script is still a stub");
    expect(r.stdout).not.toContain("item(s) are missing");
    fs.writeFileSync(join(tmp, ".claude/skills/stubs/scripts/check.sh"), "#!/usr/bin/env bash\ntest -s draft.md\n");
    g = checkGuards(ast, tmp).items.find((i) => i.id === "check")!;
    expect(g.strength).toBe("refuse");
    expect(checkGuards(ast, tmp).enforcement.refuse).toBe(1);
    expect(cli(["guard", FIXTURE, "--check", "--dir", tmp]).stdout).not.toContain("still a stub");
  });

  it("codex: none while its check script is a stub, not missing; unverified once written", () => {
    write(tmp, quiet(() => codexBinding.scaffold(codexAst)));
    let g = checkCodexGuards(codexAst, tmp).items.find((i) => i.id === "check")!;
    expect(g.strength).toBe("none");
    expect(g.notes.join(" ")).toMatch(/still a stub/);
    expect(checkCodexGuards(codexAst, tmp).missing).toBe(0);
    fs.writeFileSync(join(tmp, ".codex/scripts/check.sh"), "#!/usr/bin/env bash\ntest -s draft.md\n");
    g = checkCodexGuards(codexAst, tmp).items.find((i) => i.id === "check")!;
    expect(g.strength).toBe("unverified");
    expect(checkCodexGuards(codexAst, tmp).missing).toBe(0);
  });
});
