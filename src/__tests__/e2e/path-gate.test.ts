/**
 * A gate on an edit of a path, and a target directory.
 *
 * `before: write "<glob>"` on a gate refuses an edit of a matching path (and a
 * Bash command that writes one) until the gate holds: its ledger row, or its
 * run: check. `meta { target: "<dir>" }` makes the generated hooks resolve
 * project paths against that directory instead of the project root.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import type { GateNode } from "../../parser/ast.js";

const hasJq = spawnSync("/bin/sh", ["-c", "command -v jq"]).status === 0;

function topology(opts: { target?: string; gate?: string } = {}): string {
  return `topology ship : [pipeline] {
  meta {
    version: "1.0.0"
    description: "Render, then open the source"
${opts.target !== undefined ? `    target: "${opts.target}"\n` : ""}  }
  orchestrator {
    model: opus
    handles: [render, editor]
  }
  action render {
    kind: external
    commands: ["./tool render"]
  }
  agent editor {
    model: sonnet
    description: "Edits the source"
  }
  records {
    record trace { path: "logs/trace.jsonl" }
  }
  gates {
${opts.gate ?? `    gate src-open {
      after: render
      before: write "src/**"
      ledger: trace
      on-fail: halt
    }`}
  }
  flow { render -> editor }
}
`;
}

let root: string;
const at = (p: string) => join(root, p);

function scaffold(src: string) {
  const ast = parse(src);
  const files = claudeCodeBinding.scaffold(ast);
  for (const f of files) {
    fs.mkdirSync(dirname(at(f.path)), { recursive: true });
    fs.writeFileSync(at(f.path), f.content);
    if (f.executable) fs.chmodSync(at(f.path), 0o755);
  }
  return { ast, files };
}

function hook(file: string, stdin: string, cwd = root) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: root } as Record<string, string>;
  return spawnSync("/bin/sh", ["-c", `bash "${root}/.claude/skills/ship/scripts/${file}"`], {
    cwd, input: stdin, env, encoding: "utf8", timeout: 20_000,
  });
}
const bash = (command: string) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
const edit = (file_path: string, tool = "Edit") => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: { file_path } });

beforeEach(() => { root = fs.mkdtempSync(join(os.tmpdir(), "at-path-gate-")); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function ledger(path: string, ok: boolean) {
  fs.mkdirSync(dirname(at(path)), { recursive: true });
  fs.writeFileSync(at(path), JSON.stringify({ step: "render", unit: "", ok, at: "2026-01-01T00:00:00Z" }) + "\n");
}

describe("write anchor and target: parse and validate", () => {
  it("parses before: write into the gate's write globs and keeps it out of the step anchors", () => {
    const ast = parse(topology({ target: "work" }));
    const gate = ast.nodes.find((n) => n.id === "src-open") as GateNode;
    expect((gate as GateNode & { beforeWrite?: string[] }).beforeWrite).toEqual(["src/**"]);
    expect(gate.before).toBeUndefined();
    expect((ast.topology as { target?: string }).target).toBe("work");
  });

  it("V151: a write anchor with an empty glob is an error", () => {
    const src = topology({ gate: `    gate src-open {\n      after: render\n      before: write ""\n      ledger: trace\n    }` });
    const r = validate(parse(src)).filter((x) => x.rule === "V151");
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].level).toBe("error");
  });

  it("V152: a target that is not a path is an error", () => {
    for (const bad of ["", "a;b", "$(x)", "dir\\nnext"]) {
      const r = validate(parse(topology({ target: bad }))).filter((x) => x.rule === "V152");
      expect(r.length, JSON.stringify(bad)).toBeGreaterThan(0);
      expect(r[0].level).toBe("error");
    }
    expect(validate(parse(topology({ target: "work/app" }))).filter((x) => x.rule === "V152")).toEqual([]);
  });

  it("a good topology has no V151 or V152", () => {
    expect(validate(parse(topology())).filter((x) => x.rule === "V151" || x.rule === "V152")).toEqual([]);
  });
});

describe.skipIf(!hasJq)("before-edit.sh refuses an edit of a gated path until the gate holds", () => {
  it("wires before-edit.sh on the edit tools", () => {
    const { files } = scaffold(topology());
    expect(files.some((f) => f.path.endsWith("scripts/before-edit.sh"))).toBe(true);
    const settings = files.find((f) => f.path === ".claude/settings.json")!.content;
    expect(settings).toContain("before-edit.sh");
  });

  it("refuses an edit of a matching path with no ledger, and with a not-ok row", () => {
    scaffold(topology());
    expect(hook("before-edit.sh", edit(at("src/a.ts"))).status).toBe(2);
    ledger("logs/trace.jsonl", false);
    const r = hook("before-edit.sh", edit(at("src/a.ts"), "Write"));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("src-open");
  });

  it("allows the edit once the ledger holds an ok row, and always allows another path", () => {
    scaffold(topology());
    expect(hook("before-edit.sh", edit(at("docs/a.md"))).status).toBe(0);
    ledger("logs/trace.jsonl", true);
    expect(hook("before-edit.sh", edit(at("src/a.ts"))).status).toBe(0);
    expect(hook("before-edit.sh", edit("src/deep/b.ts", "MultiEdit")).status).toBe(0);
  });

  it("refuses a Bash write to the glob until the gate holds, and lets a read through", () => {
    scaffold(topology());
    expect(hook("before-action.sh", bash("echo x > src/a.ts")).status).toBe(2);
    expect(hook("before-action.sh", bash("sed -i s/a/b/ src/a.ts")).status).toBe(2);
    expect(hook("before-action.sh", bash("cat src/a.ts")).status).toBe(0);
    expect(hook("before-action.sh", bash("echo x > docs/a.md")).status).toBe(0);
    ledger("logs/trace.jsonl", true);
    expect(hook("before-action.sh", bash("echo x > src/a.ts")).status).toBe(0);
  });

  it("runs the gate's run: check", () => {
    const gate = `    gate src-open {\n      before: write "src/**"\n      run: "scripts/open-check.sh"\n      on-fail: halt\n    }`;
    scaffold(topology({ gate }));
    const dir = ".claude/skills/ship/scripts";
    fs.mkdirSync(at("scripts"), { recursive: true });
    fs.writeFileSync(at("scripts/open-check.sh"), "#!/bin/sh\nexit 1\n");
    fs.writeFileSync(at(`${dir}/open-check.sh`), "#!/bin/sh\nexit 1\n");
    fs.chmodSync(at(`${dir}/open-check.sh`), 0o755);
    expect(hook("before-edit.sh", edit(at("src/a.ts"))).status).toBe(2);
    fs.writeFileSync(at("scripts/open-check.sh"), "#!/bin/sh\nexit 0\n");
    fs.writeFileSync(at(`${dir}/open-check.sh`), "#!/bin/sh\nexit 0\n");
    expect(hook("before-edit.sh", edit(at("src/a.ts"))).status).toBe(0);
  });
});

describe.skipIf(!hasJq)("meta target resolves project paths against the target directory", () => {
  it("reads the ledger and the glob under the target, not the project root", () => {
    scaffold(topology({ target: "work" }));
    fs.mkdirSync(at("work/src"), { recursive: true });
    expect(hook("before-edit.sh", edit(at("work/src/a.ts"))).status).toBe(2);
    // a ledger at the project root does not count
    ledger("logs/trace.jsonl", true);
    expect(hook("before-edit.sh", edit(at("work/src/a.ts"))).status).toBe(2);
    ledger("work/logs/trace.jsonl", true);
    expect(hook("before-edit.sh", edit(at("work/src/a.ts"))).status).toBe(0);
    // src/ at the project root is not under the target
    ledger("work/logs/trace.jsonl", false);
    expect(hook("before-edit.sh", edit(at("src/a.ts"))).status).toBe(0);
  });

  it("an absolute target is used as written", () => {
    const other = fs.mkdtempSync(join(os.tmpdir(), "at-path-target-"));
    try {
      scaffold(topology({ target: other }));
      expect(hook("before-edit.sh", edit(join(other, "src/a.ts"))).status).toBe(2);
      fs.mkdirSync(join(other, "logs"), { recursive: true });
      fs.writeFileSync(join(other, "logs/trace.jsonl"), JSON.stringify({ step: "render", unit: "", ok: true }) + "\n");
      expect(hook("before-edit.sh", edit(join(other, "src/a.ts"))).status).toBe(0);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it("routes every generated use of the project directory through one variable", () => {
    const { files } = scaffold(topology({ target: "work" }));
    for (const f of files.filter((x) => x.path.includes("/scripts/") && /before-(edit|action)\.sh$/.test(x.path))) {
      const uses = f.content.split("\n").filter((l) => l.includes("CLAUDE_PROJECT_DIR") && !l.trim().startsWith("#"));
      // only the lines that set the one root variable may read it
      expect(uses.length, f.path).toBeLessThanOrEqual(2);
      expect(f.content, f.path).toContain('AT_PROJECT="');
    }
  });

  it("a project-relative run: script is found in the target, in the wrapper and in settings", () => {
    const gate = `    gate src-open {\n      before: write "src/**"\n      run: "./tools/open-check.sh"\n    }`;
    const { files } = scaffold(topology({ target: "work", gate }));
    const wrapper = files.find((f) => f.path.endsWith("scripts/gate-src-open.sh"))!.content;
    expect(wrapper).toContain('cd "$AT_PROJECT"');
    expect(wrapper).toContain('"$CLAUDE_PROJECT_DIR/work/tools/open-check.sh"');
    expect(wrapper).not.toContain('"$CLAUDE_PROJECT_DIR/tools/open-check.sh"');
  });

  it("without a target nothing changes: the project root is the root", () => {
    const { files } = scaffold(topology());
    const edit = files.find((f) => f.path.endsWith("scripts/before-edit.sh"))!.content;
    expect(edit).toContain('ROOT="$(cd "$CLAUDE_PROJECT_DIR" && pwd)"');
    expect(edit).not.toContain("AT_PROJECT");
  });

  it("a target that is missing blocks the edit", () => {
    scaffold(topology({ target: "nowhere" }));
    expect(hook("before-edit.sh", edit(at("nowhere/src/a.ts"))).status).toBe(2);
  });
});
