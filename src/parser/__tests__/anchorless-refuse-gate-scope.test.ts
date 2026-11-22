/**
 * V135, where it reaches and what credits a gate (review round 2).
 *
 * - The target reaches every command that knows one: `scaffold --target codex`
 *   and `guard --target codex` judge a gate after the entry agent the way
 *   `validate --target codex` does (Codex has no entry agent).
 * - An imported file's V135 is relayed as V8; it still does not hold back
 *   cursor, claude-workflow or plan.
 * - `strength:`, the fix V135 names, survives scaffold then import.
 * - A declared refusing hook that runs the gate's own command runs the gate.
 * - Edge credit uses the same blocking events guard --check does, per platform.
 * - A gate after an `execution: workflow` agent has no SubagentStop on Claude
 *   Code: scaffold writes no agent file for it.
 * - guard --check still grades the unset-strength N33 shape, without validate.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../index.js";
import { validate } from "../validator.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import { checkGuards } from "../../guard/check.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const CLI = resolve(root, "dist/cli/index.js");
const FIXTURE = resolve(here, "fixtures/anchorless-refuse-gate.at");

const run = (args: string[], cwd: string) => {
  try {
    return { out: execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], cwd }), code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { out: `${e.stdout ?? ""}${e.stderr ?? ""}`, code: e.status ?? 1 };
  }
};

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(join(tmpdir(), "at-v135-scope-")); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
const put = (name: string, text: string) => { fs.mkdirSync(dirname(join(dir, name)), { recursive: true }); fs.writeFileSync(join(dir, name), text); return join(dir, name); };

const v135 = (src: string, target?: string) =>
  validate(parse(src), target ? { target } : {}).filter((r) => r.rule === "V135");

/** A topology with a human, a report step (finish) and two agents; `guard` is put on the h -> finish edge. */
const topo = (gates: string, opts: { hooks?: string; guard?: string; model?: string; meta?: string; agentExtra?: string } = {}) => {
  const model = opts.model ?? "sonnet";
  return `topology t : [pipeline] {
  meta {
    version: "1.0.0"
    description: "scope"
${opts.meta ?? ""}  }
  orchestrator {
    model: ${model}
    handles: [intake, finish]
  }
  action intake {
    kind: inline
    description: "Take the request"
  }
  agent a {
    model: ${model}
    description: "First worker"
    prompt { Do a. }
  }
  agent w {
    model: ${model}
    description: "Second worker"
${opts.agentExtra ?? ""}    prompt { Do w. }
  }
  human h {
    description: "A person approves"
  }
  action finish {
    kind: report
    description: "Hand the result back"
  }
${opts.hooks ? `  hooks {\n${opts.hooks}\n  }\n` : ""}  flow {
    intake -> a
    a -> w
    w -> h
    h -> finish${opts.guard ? ` [guard: ${opts.guard}]` : ""}
  }
  gates {
${gates}
  }
}
`;
};

const hook = (name: string, on: string, runCmd: string, strength?: string) =>
  `    hook ${name} {\n      on: ${on}\n      matcher: "Bash"\n      run: "${runCmd}"\n      type: command${strength ? `\n      strength: ${strength}` : ""}\n    }`;

describe("blocking 1: scaffold and guard --target codex judge V135 for codex", () => {
  const entryGate = topo(`    gate g {\n      after: a\n      run: "scripts/check.sh"\n    }`, { model: "gpt-5.2", meta: "    entry: a\n" });

  it("validate --target codex passes (control)", () => {
    put("t.at", entryGate);
    const v = run(["validate", "t.at", "--target", "codex"], dir);
    expect(v.out).not.toContain("[V135]");
  });
  it("scaffold --target codex --dry-run is not refused by V135", () => {
    put("t.at", entryGate);
    const s = run(["scaffold", "t.at", "--target", "codex", "--dry-run"], dir);
    expect(s.out).not.toContain("[V135]");
    expect(s.code, s.out).toBe(0);
  });
  it("guard --target codex --dry-run is not refused by V135", () => {
    put("t.at", entryGate);
    const g = run(["guard", "t.at", "--target", "codex", "--dir", dir, "--dry-run"], dir);
    expect(g.out).not.toContain("[V135]");
    expect(g.code, g.out).toBe(0);
  });
  it("scaffold --target claude-code is still refused: the entry agent is the session there", () => {
    put("t.at", entryGate.replace(/gpt-5\.2/g, "sonnet"));
    const s = run(["scaffold", "t.at", "--target", "claude-code", "--dry-run"], dir);
    expect(s.code, s.out).toBe(1);
    expect(s.out).toContain("[V135]");
  });
});

describe("blocking 2: an imported file's V135 (relayed as V8) keeps its scope", () => {
  const parent = `topology p : [pipeline] {
  meta {
    version: "1.0.0"
    description: "imports a file with an anchorless gate"
  }
  orchestrator {
    model: sonnet
    handles: [a]
  }
  agent a {
    model: sonnet
    description: "d"
  }
  import "./shared.at" as shared
  flow {
    orchestrator -> a
  }
}
`;
  beforeEach(() => {
    put("shared.at", fs.readFileSync(FIXTURE, "utf8"));
    put("p.at", parent);
  });

  it("validate with no target relays it: [V8] ... [V135], exit 1 (control)", () => {
    const v = run(["validate", "p.at"], dir);
    expect(v.code, v.out).toBe(1);
    expect(v.out).toMatch(/\[V8\].*\[V135\]/);
  });
  for (const target of ["cursor", "claude-workflow"]) {
    it(`validate --target ${target} does not report it`, () => {
      const v = run(["validate", "p.at", "--target", target], dir);
      expect(v.out).not.toContain("V135");
      expect(v.code, v.out).toBe(0);
    });
  }
  it("scaffold --target cursor --dry-run is not refused by it", () => {
    const s = run(["scaffold", "p.at", "--target", "cursor", "--dry-run"], dir);
    expect(s.out).not.toContain("V135");
    expect(s.code, s.out).toBe(0);
  });
  it("plan --brief is not refused by it", () => {
    const p = run(["plan", "p.at", "--brief"], dir);
    expect(p.out).not.toContain("V135");
    expect(p.code, p.out).toBe(0);
  });
  it("validate() with a target in the API drops it too", () => {
    const ast = parse(parent);
    const file = join(dir, "p.at");
    expect(validate(ast, { filePath: file, target: "cursor" }).filter((r) => r.message.includes("V135"))).toEqual([]);
    expect(validate(ast, { filePath: file }).filter((r) => r.message.includes("V135"))).toHaveLength(1);
  });
});

describe("blocking 3: strength survives scaffold then import", () => {
  it("a gate with strength: hope validates clean after scaffold -> import -> validate", () => {
    const src = topo(`    gate g {\n      before: finish\n      run: "scripts/check.sh"\n      strength: hope\n    }`);
    expect(validate(parse(src)).filter((r) => r.level === "error")).toEqual([]);
    put("t.at", src);
    const proj = join(dir, "proj");
    fs.mkdirSync(proj);
    const s = run(["scaffold", join(dir, "t.at"), "--target", "claude-code", "--output", proj], dir);
    expect(s.code, s.out).toBe(0);
    const out = join(dir, "out");
    const i = run(["import", "--target", "claude-code", "--dir", proj, "--name", "t", "--output", out], dir);
    expect(i.code, i.out).toBe(0);
    const back = parse(fs.readFileSync(join(out, "t.at"), "utf8"));
    const gate = back.nodes.find((n) => n.type === "gate" && n.id === "g") as { strength?: string } | undefined;
    expect(gate?.strength).toBe("hope");
    expect(validate(back).filter((r) => r.rule === "V135")).toEqual([]);
  });
});

describe("minor 4: a declared refusing hook that runs the gate's own command runs the gate", () => {
  const gate = `    gate g {\n      before: finish\n      run: "bash tools/numbers.sh"\n      strength: refuse\n      at: "tools/checks.py"\n    }`;

  it("no error: a PreToolUse command hook with strength: refuse runs the same command (whitespace aside); a warning says so", () => {
    expect(v135(topo(gate, { hooks: hook("practice-numbers", "PreToolUse", "bash   tools/numbers.sh", "refuse") })).map((r) => r.level)).toEqual(["warning"]);
  });
  it("no error on codex too (PreToolUse blocks there); a warning says so", () => {
    expect(v135(topo(gate, { hooks: hook("practice-numbers", "PreToolUse", "bash tools/numbers.sh", "refuse") }), "codex").map((r) => r.level)).toEqual(["warning"]);
  });
  it("errors: the hook runs another command", () => {
    expect(v135(topo(gate, { hooks: hook("practice-numbers", "PreToolUse", "bash tools/other.sh", "refuse") }))).toHaveLength(1);
  });
  it("errors: the hook declares strength: detect", () => {
    expect(v135(topo(gate, { hooks: hook("practice-numbers", "PreToolUse", "bash tools/numbers.sh", "detect") }))).toHaveLength(1);
  });
  it("errors: the hook is on PostToolUse (cannot block)", () => {
    expect(v135(topo(gate, { hooks: hook("practice-numbers", "PostToolUse", "bash tools/numbers.sh", "refuse") }))).toHaveLength(1);
  });
  it("the scaffold warning names the hook that runs it", () => {
    const src = topo(gate, { hooks: hook("practice-numbers", "PreToolUse", "bash tools/numbers.sh", "refuse") });
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    try {
      claudeCodeBinding.scaffold(parse(src));
    } finally {
      console.warn = original;
    }
    const line = warnings.find((w) => w.includes('Gate "g"'));
    expect(line).toContain('hook "practice-numbers" (PreToolUse, matcher Bash) runs the same command');
  });
  it("a cited gate the message also offers dropping run: (the citation is the claim)", () => {
    const [hit] = v135(topo(gate));
    expect(hit.message).toContain("drop run:");
  });
});

describe("minor 5: edge credit uses guard --check's blocking events, per platform", () => {
  const gate = `    gate g {\n      after: h\n      before: finish\n      run: "scripts/check.sh"\n    }`;
  const withHook = (on: string) => topo(gate, { hooks: hook("lock", on, "python3 harness/lock.py", "refuse"), guard: "lock" });

  for (const on of ["PostCompact", "TaskCompleted"]) {
    it(`errors: the cited hook is on ${on}, which cannot block`, () => {
      expect(v135(withHook(on))).toHaveLength(1);
    });
  }
  it("passes: PermissionRequest blocks on Claude Code", () => {
    expect(v135(withHook("PermissionRequest"))).toEqual([]);
  });
  it("errors on codex: PermissionRequest does not block there", () => {
    expect(v135(withHook("PermissionRequest"), "codex")).toHaveLength(1);
  });
  it("passes: PreToolUse, on both", () => {
    expect(v135(withHook("PreToolUse"))).toEqual([]);
    expect(v135(withHook("PreToolUse"), "codex")).toEqual([]);
  });
});

describe("minor 6: a gate after an execution: workflow agent", () => {
  const src = topo(`    gate g {\n      after: w\n      run: "scripts/check.sh"\n    }`, {
    agentExtra: "    extensions {\n      claude-workflow {\n        execution: workflow\n      }\n    }\n",
  });

  it("errors on claude-code: scaffold writes no agent file for w, so SubagentStop never fires for it", () => {
    const hits = v135(src, "claude-code");
    expect(hits).toHaveLength(1);
    expect(hits[0].message).toContain('after: "w"');
  });
  it("scaffold emits no SubagentStop matcher for w", () => {
    const original = console.warn;
    console.warn = () => {};
    let files;
    try {
      files = claudeCodeBinding.scaffold(parse(src));
    } finally {
      console.warn = original;
    }
    const settings = files.find((f) => f.path === ".claude/settings.json");
    const stop = settings ? (JSON.parse(settings.content).hooks?.SubagentStop ?? []) : [];
    expect(stop.map((e: { matcher?: string }) => e.matcher)).not.toContain("w");
  });
  it("passes on codex: Codex writes the agent", () => {
    expect(v135(src, "codex")).toEqual([]);
  });
});

describe("minor 8: guard --check on the unset-strength N33 shape, without validate", () => {
  it("a gate whose edge cites a hook with no strength stays hope, and says why", () => {
    const src = topo(`    gate lock-voice {\n      after: h\n      before: finish\n      run: "scripts/lock-voice.sh"\n      on-fail: halt\n    }`, {
      hooks: `    hook note-bash {\n      on: PostToolUse\n      matcher: "Bash"\n      run: "python3 harness/note.py"\n    }`,
      guard: "note-bash",
    });
    const item = checkGuards(parse(src), dir).items.find((i) => i.kind === "gate" && i.id === "lock-voice")!;
    expect(item.strength).toBe("hope");
    expect(item.notes.join(" ")).toMatch(/note-bash declares no strength/);
  });
});

describe("round 3: a gate credited only by a same-command hook is a V135 warning, not silence", () => {
  const gate = `    gate g {\n      before: finish\n      run: "bash tools/numbers.sh"\n      strength: refuse\n      at: "tools/checks.py"\n    }`;
  const sameHook = (on: string, matcher: string | null, ifLine = "") =>
    `    hook n {\n      on: ${on}\n${matcher ? `      matcher: "${matcher}"\n` : ""}${ifLine ? `      if: "${ifLine}"\n` : ""}      run: "bash tools/numbers.sh"\n      type: command\n      strength: refuse\n    }`;
  const results = (src: string) => validate(parse(src)).filter((r) => r.rule === "V135");

  const CASES: Array<[string, string, string]> = [
    ["PreToolUse, matcher WebFetch", sameHook("PreToolUse", "WebFetch"), '(PreToolUse, matcher WebFetch)'],
    ["PreToolUse Bash with if:", sameHook("PreToolUse", "Bash", "Bash(rm -rf *)"), '(PreToolUse, matcher Bash, if: Bash(rm -rf *))'],
    ["UserPromptSubmit", sameHook("UserPromptSubmit", null), "(UserPromptSubmit)"],
    ["PermissionRequest", sameHook("PermissionRequest", null), "(PermissionRequest)"],
    ["the at-skill shape: PreToolUse, matcher Bash", sameHook("PreToolUse", "Bash"), "(PreToolUse, matcher Bash)"],
  ];
  for (const [name, hooks, desc] of CASES) {
    it(`warns, no error: ${name}`, () => {
      const hits = results(topo(gate, { hooks }));
      expect(hits.map((h) => h.level)).toEqual(["warning"]);
      expect(hits[0].node).toBe("g");
      expect(hits[0].message).toBe(`Gate "g" is run only by hook "n" ${desc}, which runs its command; guard --check grades it hope.`);
    });
  }

  it("the scaffold warning line carries the matcher and if:", () => {
    const src = topo(gate, { hooks: sameHook("PreToolUse", "Bash", "Bash(rm -rf *)") });
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    try {
      claudeCodeBinding.scaffold(parse(src));
    } finally {
      console.warn = original;
    }
    expect(warnings.find((w) => w.includes('Gate "g"'))).toContain('hook "n" (PreToolUse, matcher Bash, if: Bash(rm -rf *)) runs the same command');
  });

  it("a gate a hook of its own runs gives no V135 at all", () => {
    expect(results(topo(`    gate g {\n      after: a\n      run: "bash tools/numbers.sh"\n    }`, { hooks: sameHook("PreToolUse", "Bash") }))).toEqual([]);
  });
});
