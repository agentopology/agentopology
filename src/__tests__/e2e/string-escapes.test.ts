/**
 * A quoted .at string reads two escapes: `\"` is one quote and `\\` is one
 * backslash. Any other backslash stays as written (`\S`, `\d`, `\n`).
 * The value every field sees is the unescaped one, so the files a binding
 * writes hold what the author meant: a `\"` in a command reaches settings.json
 * as one JSON-escaped quote, and a documented `unit-from` regex matches the
 * command it was written for.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { parse } from "../../parser/index.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import { serializeAST } from "../../import/serializer.js";
import type { ActionNode } from "../../parser/ast.js";

const hasJq = spawnSync("/bin/sh", ["-c", "command -v jq"]).status === 0;

const topo = (action: string, hooks = "") => `topology t : [pipeline] {
  meta { version: "1.0.0" description: "d" }
  orchestrator { model: sonnet handles: [render, publish] }
  action render {
    kind: external
    commands: ["./tool render"]
  }
  ${action}
  records { record trace { path: "logs/{unit}/trace.jsonl" } }
  gates {
    gate g {
      after: render
      before: publish
      ledger: trace
      on-fail: halt
    }
  }
  flow { render -> publish }
${hooks}}
`;

const publish = (unitFrom: string) => `action publish {
    kind: external
    commands: ["./tool publish"]
    unit-from: "${unitFrom}"
  }`;

const actionOf = (src: string) => parse(src).nodes.find((n) => n.id === "publish") as ActionNode;

describe("unescaping a quoted .at string (parse)", () => {
  // [.at text between the quotes, value the field holds]
  it.each<[string, string]>([
    ['say \\"hi\\"', 'say "hi"'],
    ["a\\\\b", "a\\b"],
    ["./tool publish (\\\\S+)", "./tool publish (\\S+)"],
    ["./tool publish (\\S+)", "./tool publish (\\S+)"],
    ["keep \\n and \\d as written", "keep \\n and \\d as written"],
    ["end with a backslash pair \\\\", "end with a backslash pair \\"],
    ["quote after pair \\\\\\\"x", 'quote after pair \\"x'],
    ["plain", "plain"],
  ])("unit-from %s", (written, held) => {
    expect(actionOf(topo(publish(written))).unitFrom).toBe(held);
  });

  it("a list item is unescaped too (commands)", () => {
    const src = topo(`action publish {
    kind: external
    commands: ["./tool \\"a b\\" x\\\\y"]
  }`);
    expect(actionOf(src).commands).toEqual(['./tool "a b" x\\y']);
  });
});

describe("what the binding writes", () => {
  it("the documented unit-from example compiles to a regex that matches its own sample", () => {
    const action = actionOf(topo(publish("./tool publish (\\\\S+)")));
    const re = new RegExp(action.unitFrom!);
    expect(re.exec("./tool publish ep42")?.[1]).toBe("ep42");
  });

  it.skipIf(!hasJq)("the generated gate script reads the unit with that regex", () => {
    const files = claudeCodeBinding.scaffold(parse(topo(publish("./tool publish (\\\\S+)"))));
    const script = files.find((f) => f.path.endsWith("before-action.sh"))!.content;
    expect(script).toContain("(\\S+)");
    expect(script).not.toContain("(\\\\S+)");
  });

  it("a \\\" in a hook command reaches settings.json as one quote, and runs as a quote", () => {
    const src = topo(
      publish("./tool publish (\\S+)"),
      `  hooks {\n    hook h {\n      on: PreToolUse\n      matcher: "Bash"\n      run: "echo \\"a b\\""\n      type: command\n    }\n  }\n`,
    );
    const settings = claudeCodeBinding.scaffold(parse(src)).find((f) => f.path === ".claude/settings.json")!;
    const raw = settings.content;
    const json = JSON.parse(raw);
    const command = (json.hooks.PreToolUse as { hooks: { command: string }[] }[])
      .flatMap((e) => e.hooks.map((h) => h.command))
      .find((c) => c.includes("echo"))!;
    expect(command).toBe('echo "a b"');
    expect(raw).toContain('echo \\"a b\\"');
    expect(raw).not.toContain('echo \\\\"');
    const ran = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8" });
    expect(ran.stdout.trim()).toBe("a b");
  });

  it("a description with \\\" and \\\\ is one quote and one backslash, then YAML-escaped once in the agent file", () => {
    const src = topo(publish("x (.)")).replace(
      "orchestrator { model: sonnet handles: [render, publish] }",
      'orchestrator { model: sonnet handles: [render, publish] }\n  agent helper {\n    model: sonnet\n    description: "says \\"hi\\" and a\\\\b"\n  }',
    );
    const ast = parse(src);
    expect((ast.nodes.find((n) => n.id === "helper") as { description?: string }).description).toBe('says "hi" and a\\b');
    const text = claudeCodeBinding.scaffold(ast).map((f) => f.content).join("\n");
    // never the raw backslash-quote pair twice over
    expect(text).not.toContain('\\\\"hi');
    expect(text).toMatch(/says (\\"hi\\"|"hi"|'hi'|.hi.) and a\\{1,2}b/);
  });
});

describe("import writes strings back so they read as the same value", () => {
  it("a quote and a backslash survive serialize → parse", () => {
    const ast = parse(topo(publish("x (.)")));
    const a = ast.nodes.find((n) => n.id === "publish") as ActionNode;
    a.unitFrom = 'p "q" (\\S+) \\\\';
    a.commands = ['./tool "a b" c\\d'];
    const again = parse(serializeAST(ast));
    const b = again.nodes.find((n) => n.id === "publish") as ActionNode;
    expect(b.unitFrom).toBe('p "q" (\\S+) \\\\');
    expect(b.commands).toEqual(['./tool "a b" c\\d']);
  });
});
