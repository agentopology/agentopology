/**
 * guard --check: a gate that only cites code (at:) is "cited", not "refuse".
 * It refuses only through its own generated hook: the hook guard --target
 * writes from the gate's run:. No other hook counts for a cited gate: not a
 * hand-written settings hook, not a CI workflow, not a hook declared in
 * hooks { } and cited on its edge, not another gate. The enforcement line
 * counts the classes apart, so a harness that may enforce nothing never
 * scores "N of N steps refuse".
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { parse } from "../../parser/index.js";
import { claudeCodeBinding, settingsHooksOf } from "../../bindings/claude-code.js";
import { checkGuards, renderGuardReport, type GuardItem } from "../../guard/check.js";
import { checkCodexGuards } from "../../guard/check-codex.js";

const gates = (n: number) =>
  Array.from({ length: n }, (_, i) => `    gate g${i + 1} {
      after: manager
      before: worker
      run: "python3 -I tools/g${i + 1}.py --check"
      at: "tools/g${i + 1}.py"
      behavior: blocking
    }`).join("\n");

/** A topology: agents manager -> worker -> reviewer, the given gates, optional hooks {} and edge guards. */
const topology = (gateBody: string, hooks = "", guard = "", extraFlow = "") => `topology cited : [pipeline] {
  meta {
    version: "1.0.0"
    description: "Cited gates probe"
  }

  agent manager {
    model: sonnet
    description: "Runs the venture"
    prompt {
      Run it.
    }
  }

  agent worker {
    model: sonnet
    description: "Does the work"
    prompt {
      Do it.
    }
  }

  agent reviewer {
    model: sonnet
    description: "Reviews the work"
    prompt {
      Review it.
    }
  }
${hooks ? `\n  hooks {\n${hooks}\n  }\n` : ""}
  gates {
${gateBody}
  }

  flow {
    manager -> worker${guard ? ` [guard: ${guard}]` : ""}
    worker -> reviewer${extraFlow ? ` [guard: ${extraFlow}]` : ""}
  }
}
`;

const declaredHook = (on: string) => `    hook g1run {
      on: ${on}
      matcher: "Bash"
      run: "python3 tools/g1.py"
      strength: refuse
    }`;

let root: string;
const put = (p: string, text: string) => { fs.mkdirSync(dirname(join(root, p)), { recursive: true }); fs.writeFileSync(join(root, p), text); };
const tools = (n: number) => { for (let i = 1; i <= n; i++) put(`tools/g${i}.py`, "import sys\nsys.exit(0)\n"); };
const settings = (s: Record<string, unknown>) => put(".claude/settings.json", JSON.stringify(s));
const settingsHook = (event: string, command: string, matcher = "Bash") => settings({ hooks: { [event]: [{ matcher, hooks: [{ type: "command", command }] }] } });
/** settings.json holding exactly what scaffold compiles from the topology's hooks { }. */
const compiledSettings = (ast: ReturnType<typeof parse>) => settings({ hooks: settingsHooksOf(ast) });
/** Write everything scaffold writes for the topology (generated hooks and their scripts). */
const scaffoldInto = (ast: ReturnType<typeof parse>) => {
  for (const f of claudeCodeBinding.scaffold(ast)) {
    put(f.path, f.content);
    if (f.executable) fs.chmodSync(join(root, f.path), 0o755);
  }
};
const enforcementLine = (lines: string[]) => lines.find((l) => l.startsWith("enforcement:")) ?? "";
const gate = (ast: ReturnType<typeof parse>, id: string) => checkGuards(ast, root).items.find((i: GuardItem) => i.id === id)!;

beforeEach(() => { root = fs.mkdtempSync(join(os.tmpdir(), "at-cited-")); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("a gate that only cites code is not counted as refusing", () => {
  it("(1) 8 cited gates, no settings.json, no CI: never '8 of 8 steps refuse'; the classes are counted apart; the advice names guard --target", () => {
    const ast = parse(topology(gates(8)));
    tools(8);
    const report = checkGuards(ast, root);
    const gs = report.items.filter((i: GuardItem) => i.kind === "gate");
    expect(gs).toHaveLength(8);
    for (const g of gs) {
      expect(g.strength).toBe("cited");
      expect(g.notes.join(" ")).toMatch(/cited, not proven/);
    }
    expect(report.enforcement.refuse).toBe(0);
    const lines = renderGuardReport(report);
    expect(enforcementLine(lines)).not.toMatch(/8 of 8 steps refuse/);
    expect(enforcementLine(lines)).toMatch(/0 of 8 steps refuse \(8 cited, 0 wired, 0 proven\)/);
    expect(lines.join("\n")).toMatch(/give the gate a run: and let guard --target write its hook/);
  });

  it("(2) the gate's own generated hook (guard --target from its run:) wires it: refuse, wired", () => {
    const body = `    gate g1 {
      after: manager
      before: worker
      run: "scripts/check-g1.sh"
      at: "tools/g1.py"
      behavior: blocking
    }`;
    const ast = parse(topology(body));
    tools(1);
    scaffoldInto(ast);
    put(".claude/skills/cited/scripts/check-g1.sh", "#!/usr/bin/env bash\npython3 tools/g1.py\n");
    const report = checkGuards(ast, root);
    expect(report.items.find((i) => i.id === "g1")).toMatchObject({ strength: "refuse", citation: "wired" });
    expect(enforcementLine(renderGuardReport(report))).toMatch(/1 of 1 steps refuse \(0 cited, 1 wired, 0 proven\)/);
  });

  it("(2b) a hand-written settings hook that runs the cited file: still cited", () => {
    const ast = parse(topology(gates(1)));
    tools(1);
    settingsHook("PreToolUse", 'python3 -I "$CLAUDE_PROJECT_DIR/tools/g1.py" --check');
    const report = checkGuards(ast, root);
    expect(report.items.find((i) => i.id === "g1")!.strength).toBe("cited");
    expect(report.unattributed.length).toBe(1);
  });

  it("(2c) a CI workflow that runs the cited file: still cited", () => {
    const ast = parse(topology(gates(1)));
    tools(1);
    put(".github/workflows/check.yml", "on: [pull_request]\njobs:\n  c:\n    runs-on: ubuntu-latest\n    steps:\n      - run: python3 -I tools/g1.py --check\n");
    expect(gate(ast, "g1").strength).toBe("cited");
  });

  it("(2d) a hook declared in hooks { } and cited on the edge, in settings exactly as compiled: still cited (only the generated hook counts)", () => {
    const ast = parse(topology(gates(2), declaredHook("PreToolUse"), "g1run"));
    tools(2);
    compiledSettings(ast);
    const report = checkGuards(ast, root);
    expect(report.items.find((i) => i.id === "g1")!.strength).toBe("cited");
    expect(report.enforcement.refuse).toBe(0);
  });

  it("(2e) the same declared hook on PostToolUse: still cited, never none, no failure", () => {
    const ast = parse(topology(gates(1), declaredHook("PostToolUse"), "g1run"));
    tools(1);
    compiledSettings(ast);
    const report = checkGuards(ast, root);
    expect(report.items.find((i) => i.id === "g1")!.strength).toBe("cited");
    expect(report.missing).toBe(0);
  });

  it("(2f) a cited gate whose edge cites another gate that refuses: still cited", () => {
    const body = `    gate b {
      after: manager
      before: worker
      behavior: blocking
    }
    gate a {
      after: worker
      before: reviewer
      run: "python3 -I tools/g2.py --check"
      at: "tools/g2.py"
      behavior: blocking
    }`;
    const ast = parse(topology(body, declaredHook("PreToolUse"), "g1run", "b"));
    tools(2);
    compiledSettings(ast);
    const report = checkGuards(ast, root);
    expect(report.items.find((i) => i.id === "b")!.strength).toBe("refuse");
    expect(report.items.find((i) => i.id === "a")!.strength).toBe("cited");
  });

  it("(2g) an advisory gate is never graded refuse by its citation", () => {
    const advisory = `    gate adv {
      after: manager
      run: "python3 -I tools/adv.py"
      at: "tools/adv.py"
      behavior: advisory
    }`;
    const ast = parse(topology(advisory));
    put("tools/adv.py", "print('ok')\n");
    expect(gate(ast, "adv").strength).toBe("cited");
  });

  it("(3) codex and claude-code grade the same citation the same: cited", () => {
    const ast = parse(topology(gates(1)));
    tools(1);
    const cc = gate(ast, "g1");
    const cx = checkCodexGuards(ast, root).items.find((i) => i.id === "g1")!;
    expect(cc.strength).toBe("cited");
    expect(cx.strength).toBe(cc.strength);
  });

  it("(3b) on Codex the report gives no claude-code advice line", () => {
    const ast = parse(topology(gates(1)));
    tools(1);
    expect(renderGuardReport(checkCodexGuards(ast, root)).join("\n")).not.toMatch(/guard --target write its hook/);
  });
});

describe("the count line agrees with the grades", () => {
  it("(P2) a cited gate the file declares weaker (detect) prints no citation suffix", () => {
    const ast = parse(topology(gates(1).replace("behavior: blocking", "behavior: blocking\n      strength: detect")));
    tools(1);
    expect(enforcementLine(renderGuardReport(checkGuards(ast, root)))).not.toMatch(/cited, .* wired/);
  });
});

describe("malformed settings near a cited gate never crash where 0.12.3 did not", () => {
  it("(R5-8) a settings event given as a string: a report, no TypeError", () => {
    const ast = parse(topology(gates(1), declaredHook("PreToolUse"), "g1run"));
    tools(1);
    settings({ hooks: { PreToolUse: "python3 tools/g1.py" } });
    expect(() => renderGuardReport(checkGuards(ast, root))).not.toThrow();
    expect(gate(ast, "g1").strength).toBe("cited");
  });
});
