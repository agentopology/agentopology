/**
 * Interpreter flags in a `run:` (src/parser/run.ts runParts).
 *
 * `python3 -I -B "$CLAUDE_PROJECT_DIR/tools/check.py" hook Stop` used to read
 * as a script named `python3`: a flag after the interpreter stopped the split,
 * so scaffold planned a stub named python3 and the hook ran it. Flags each
 * interpreter is known to take are now skipped to find the script, and they
 * travel to the command the binding writes. A flag that takes inline code
 * (`bash -c`, `python -c`, `python -m`, `node -e`, `perl -e`, ...) still names
 * no script file, as before, and so does a flag the table does not know.
 */
import { describe, it, expect } from "vitest";
import { parse } from "../index.js";
import { validate } from "../validator.js";
import { isProjectPath, proseInRun, runParts, scriptNameFromRun } from "../run.js";
import { commandParts } from "../../import/run-words.js";
import { claudeCodeBinding, hookCommand } from "../../bindings/claude-code.js";
import { codexBinding } from "../../bindings/codex.js";
import { codexGateCommand } from "../../bindings/lib/codex-hooks.js";
import { plannedStubs } from "../../scaffold/stubs.js";
import type { GeneratedFile } from "../../bindings/types.js";

const RUN = 'python3 -I -B "$CLAUDE_PROJECT_DIR/tools/check.py" hook Stop';

describe("runParts skips the flags an interpreter takes to find its script", () => {
  it.each<[string, { interpreter: string; flags: string[]; script: string; args: string[] }]>([
    [RUN, { interpreter: "python3", flags: ["-I", "-B"], script: "./tools/check.py", args: ["hook", "Stop"] }],
    // as a .at string holds it: `run: "python3 -I -B \"$CLAUDE_PROJECT_DIR/...\" hook Stop"` keeps the backslashes
    [RUN.replaceAll('"', '\\"'), { interpreter: "python3", flags: ["-I", "-B"], script: "./tools/check.py", args: ["hook", "Stop"] }],
    ["python3 -u tools/x.py", { interpreter: "python3", flags: ["-u"], script: "tools/x.py", args: [] }],
    ["python3 -IB tools/x.py a", { interpreter: "python3", flags: ["-IB"], script: "tools/x.py", args: ["a"] }],
    ["python3 -OO -q -s -S -E tools/x.py", { interpreter: "python3", flags: ["-OO", "-q", "-s", "-S", "-E"], script: "tools/x.py", args: [] }],
    ["python3 -X utf8 -W ignore tools/x.py a", { interpreter: "python3", flags: ["-X", "utf8", "-W", "ignore"], script: "tools/x.py", args: ["a"] }],
    ["python3 -Xdev -v tools/x.py", { interpreter: "python3", flags: ["-Xdev", "-v"], script: "tools/x.py", args: [] }],
    ["/usr/bin/python3.12 -I tools/x.py", { interpreter: "/usr/bin/python3.12", flags: ["-I"], script: "tools/x.py", args: [] }],
    ["node --no-warnings --max-old-space-size=4096 tools/a.mjs x", { interpreter: "node", flags: ["--no-warnings", "--max-old-space-size=4096"], script: "tools/a.mjs", args: ["x"] }],
    ["node -r ts-node/register tools/a.ts", { interpreter: "node", flags: ["-r", "ts-node/register"], script: "tools/a.ts", args: [] }],
    ["node --require ./hook.js tools/a.js", { interpreter: "node", flags: ["--require", "./hook.js"], script: "tools/a.js", args: [] }],
    ["node --import tsx tools/a.ts", { interpreter: "node", flags: ["--import", "tsx"], script: "tools/a.ts", args: [] }],
    ["node --loader ./l.mjs tools/a.mjs", { interpreter: "node", flags: ["--loader", "./l.mjs"], script: "tools/a.mjs", args: [] }],
    ["node --require=./hook.js tools/a.js", { interpreter: "node", flags: ["--require=./hook.js"], script: "tools/a.js", args: [] }],
    ["bun --smol tools/a.ts", { interpreter: "bun", flags: ["--smol"], script: "tools/a.ts", args: [] }],
    ["bash -eu tools/x.sh a", { interpreter: "bash", flags: ["-eu"], script: "tools/x.sh", args: ["a"] }],
    ["bash -e -o pipefail tools/x.sh", { interpreter: "bash", flags: ["-e", "-o", "pipefail"], script: "tools/x.sh", args: [] }],
    ["zsh -eo pipefail tools/x.sh", { interpreter: "zsh", flags: ["-eo", "pipefail"], script: "tools/x.sh", args: [] }],
    ["sh -x +o noglob tools/x.sh", { interpreter: "sh", flags: ["-x", "+o", "noglob"], script: "tools/x.sh", args: [] }],
    ["bash --norc --noprofile tools/x.sh", { interpreter: "bash", flags: ["--norc", "--noprofile"], script: "tools/x.sh", args: [] }],
  ])("%s", (run, want) => {
    expect(runParts(run)).toEqual(want);
  });

  it("a run with no flag keeps its old shape (no flags key)", () => {
    expect(runParts("python3 tools/x.py a")).toEqual({ interpreter: "python3", script: "tools/x.py", args: ["a"] });
    expect(runParts("scripts/check.sh")).toEqual({ script: "scripts/check.sh", args: [] });
  });
});

describe("a flag that takes inline code, or one the table does not know, still names no script (as before)", () => {
  it.each([
    "bash -c 'exit 2'",
    "sh -c 'exit 2'",
    "zsh -c 'exit 2'",
    "bash -ec 'exit 2'",
    "bash -e -c 'exit 2'",
    "python -c 'import sys'",
    "python3 -I -c 'import sys'",
    "python3 -m mypkg.guard",
    "python3 -I -m mypkg.guard",
    "node -e '1'",
    "node -p '1'",
    "node --eval '1'",
    "node --no-warnings -e '1'",
    "perl -e 'exit 2'",
    "ruby -e 'exit 2'",
    "python3 -Z tools/x.py",
    "bash -o",
  ])("%s", (run) => {
    const words = run.split(/\s+/);
    expect(runParts(run)).toEqual({ script: words[0], args: words.slice(1) });
  });
});

describe("a script word through a variable is a path, named by its basename without quotes", () => {
  it.each([
    "$CLAUDE_PROJECT_DIR/tools/x.py",
    '"$CLAUDE_PROJECT_DIR/tools/x.py"',
    '"${CLAUDE_PROJECT_DIR}/tools/x.py"',
    '"$CLAUDE_PROJECT_DIR"/tools/x.py',
    "${HOME}/bin/x.sh",
    '"$HOME/bin/x.sh"',
    "$SCRIPT",
  ])("isProjectPath(%s)", (word) => {
    expect(isProjectPath(word)).toBe(true);
  });

  it.each([
    [RUN, "check.py"],
    ['python3 "${CLAUDE_PROJECT_DIR}/tools/x.py"', "x.py"],
    ['bash "$HOME/bin/x.sh" --a', "x.sh"],
    ['"$CLAUDE_PROJECT_DIR/tools/x.sh" a', "x.sh"],
    ["bash -c 'exit 2'", "bash"],
  ])("scriptNameFromRun(%s) = %s", (run, name) => {
    expect(scriptNameFromRun(run)).toBe(name);
  });

  it("validate reads the flagged form as a command, also as a .at string holds it", () => {
    expect(proseInRun(RUN)).toBeNull();
    expect(proseInRun(RUN.replaceAll('"', '\\"'))).toBeNull();
    expect(scriptNameFromRun(RUN.replaceAll('"', '\\"'))).toBe("check.py");
  });

  it("import names the hook by the script, not by the interpreter", () => {
    expect(commandParts(RUN)).toMatchObject({ interpreter: "python3", script: "./tools/check.py" });
  });
});

describe("the flags travel to the command the binding writes", () => {
  it.each([
    [RUN, 'python3 -I -B "$CLAUDE_PROJECT_DIR/tools/check.py" hook Stop'],
    ["node -r ts-node/register tools/a.ts", 'node -r ts-node/register "$CLAUDE_PROJECT_DIR/tools/a.ts"'],
    ["bash -eu scripts/x.sh a", "bash -eu .claude/skills/t/scripts/x.sh a"],
    ['bash "$HOME/bin/x.sh" --a', 'bash "$HOME/bin/x.sh" --a'],
  ])("claude-code hookCommand(%s)", (run, command) => {
    expect(hookCommand(run, "t")).toBe(command);
  });

  it("codex gate command", () => {
    expect(codexGateCommand(RUN, "t")).toBe("python3 -I -B tools/check.py hook Stop");
  });
});

/** A topology whose gate and hook both run the flagged form. */
const SOURCE = [
  "topology t : [pipeline] {",
  "  meta {",
  '    version: "1.0.0"',
  '    description: "A gate and a hook run python with flags"',
  "  }",
  "  orchestrator {",
  "    model: MODEL",
  "  }",
  "  agent writer {",
  "    model: MODEL",
  '    description: "Writes the draft"',
  "    prompt { Write the draft. }",
  "  }",
  "  agent reviewer {",
  "    model: MODEL",
  '    description: "Reviews the draft"',
  "    prompt { Review the draft. }",
  "  }",
  "  flow {",
  "    writer -> reviewer",
  "  }",
  "  gates {",
  "    gate check {",
  "      after: writer",
  "      before: reviewer",
  `      run: ${JSON.stringify(RUN)}`,
  "    }",
  "  }",
  "  hooks {",
  "    hook on-stop {",
  "      on: Stop",
  `      run: ${JSON.stringify(RUN)}`,
  "      type: command",
  "    }",
  "  }",
  "}",
].join("\n");

const quiet = <T>(f: () => T): T => {
  const warn = console.warn;
  console.warn = () => {};
  try { return f(); } finally { console.warn = warn; }
};
const base = (f: GeneratedFile) => f.path.replace(/^.*\//, "");

describe("[e2e] a topology whose gate and hook run `python3 -I -B <script> ...`", () => {
  const ast = parse(SOURCE.replaceAll("MODEL", "sonnet"));

  it("validates with no error", () => {
    expect(validate(ast).filter((r) => r.level === "error").map((r) => `${r.rule} ${r.message}`)).toEqual([]);
  });

  it("claude-code: no stub named python3; the hook and the gate run the script with its flags", () => {
    const files = quiet(() => claudeCodeBinding.scaffold(ast));
    expect(files.filter((f) => base(f) === "python3").map((f) => f.path)).toEqual([]);
    const want = 'python3 -I -B "$CLAUDE_PROJECT_DIR/tools/check.py" hook Stop';
    const settings = JSON.parse(files.find((f) => f.path === ".claude/settings.json")!.content);
    const commands = Object.values(settings.hooks).flat().flatMap((g: any) => g.hooks.map((h: any) => h.command));
    expect(commands).toContain(want);
    const withRun = files.filter((f) => f.content.includes(want)).map((f) => f.path);
    expect(withRun).toContain(".claude/skills/t/scripts/gate-check.sh");
    // the user's script, created once as a python stub and never written over
    const stub = files.find((f) => f.path === "tools/check.py");
    expect(stub?.createOnly).toBe(true);
    expect(stub?.content).toMatch(/^#!\/usr\/bin\/env python3/);
  });

  it("claude-code: the planned stubs name the script, not the interpreter", () => {
    const plan = plannedStubs(ast, "claude-code");
    expect(plan).not.toBeNull();
    const paths = JSON.stringify(plan);
    expect(paths).not.toMatch(/python3"/);
    expect(paths).toContain('"tools/check.py"');
  });

  it("codex: no stub named python3; the gate and the hook run the script with its flags", () => {
    const files = quiet(() => codexBinding.scaffold(parse(SOURCE.replaceAll("MODEL", "gpt-5.2"))));
    expect(files.filter((f) => base(f) === "python3").map((f) => f.path)).toEqual([]);
    expect(files.some((f) => f.content.includes("python3 -I -B tools/check.py hook Stop"))).toBe(true);
    const hooks = files.find((f) => f.path === ".codex/hooks.json")!.content;
    expect(hooks).toContain("python3 -I -B");
    expect(hooks).toContain("tools/check.py");
  });
});
