import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import { resolveDefaults } from "../defaults.js";
import type { AgentNode, GateNode } from "../../parser/ast.js";

const example = (name: string) =>
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../examples", name), "utf8");

const MINIMAL = `topology t : [pipeline] {
  meta {
    version: "1.0.0"
    description: "x"
  }
  agent worker {
    model: sonnet
    description: "w"
  }
  action intake {
    kind: inline
    description: "in"
  }
  flow { intake -> worker }
}`;

describe("resolveDefaults", () => {
  it("fills agent.permissions with the SPEC default, not a binding's", () => {
    // The bindings disagree: codex.ts uses "supervised", openclaw.ts uses
    // "auto". spec/grammar.md:1717 says "autonomous". The spec wins here.
    const { ast } = resolveDefaults(parse(MINIMAL));
    const worker = ast.nodes.find((n) => n.id === "worker") as AgentNode;
    expect(worker.permissions).toBe("autonomous");
  });

  it("fills concrete agent defaults and leaves 'none' fields undefined", () => {
    const { ast } = resolveDefaults(parse(MINIMAL));
    const worker = ast.nodes.find((n) => n.id === "worker") as AgentNode;

    expect(worker.reads).toEqual([]);
    expect(worker.writes).toEqual([]);
    expect(worker.outputs).toEqual({});
    expect(worker.retry).toBe(0);
    expect(worker.background).toBe(false);
    expect(worker.behavior).toBe("blocking");

    // Rows whose spec default is "-- (none)" must stay absent — absence IS
    // their meaning, and inventing a value would change behaviour.
    expect(worker.phase).toBeUndefined();
    expect(worker.prompt).toBeUndefined();
    expect(worker.tools).toBeUndefined();
    expect(worker.isolation).toBeUndefined();
    expect(worker.maxTurns).toBeUndefined();
  });

  it("never overwrites an authored value", () => {
    // NB: fields must be newline-separated. parseFields is line-based, so two
    // fields on one line make the first key swallow the rest of the line.
    const src = MINIMAL.replace(
      'agent worker {\n    model: sonnet\n    description: "w"\n  }',
      [
        "agent worker {",
        "    model: sonnet",
        '    description: "w"',
        "    permissions: supervised",
        "    retry: 3",
        "  }",
      ].join("\n")
    );
    const { ast, applied } = resolveDefaults(parse(src));
    const worker = ast.nodes.find((n) => n.id === "worker") as AgentNode;
    expect(worker.permissions).toBe("supervised");
    expect(worker.retry).toBe(3);
    expect(applied.find((a) => a.node === "worker" && a.field === "permissions")).toBeUndefined();
    expect(applied.find((a) => a.node === "worker" && a.field === "retry")).toBeUndefined();
  });

  it("does not mutate the input AST", () => {
    const original = parse(MINIMAL);
    const before = original.nodes.find((n) => n.id === "worker") as AgentNode;
    expect(before.permissions).toBeUndefined();
    resolveDefaults(original);
    expect(before.permissions).toBeUndefined();
  });

  it("reports every field it filled, so a brief can name them", () => {
    const { applied } = resolveDefaults(parse(MINIMAL));
    const workerFields = applied.filter((a) => a.node === "worker").map((a) => a.field);
    expect(workerFields).toContain("permissions");
    expect(workerFields).toContain("mcp-servers");
    // grammar-name spelling, not the AST camelCase key
    expect(workerFields).not.toContain("mcpServers");
  });

  it("resolves gate defaults from the spec", () => {
    const { ast } = resolveDefaults(parse(example("simple-pipeline.at")));
    const gate = ast.nodes.find((n) => n.type === "gate") as GateNode;
    expect(gate.onFail).toBeDefined();
    expect(gate.behavior).toBeDefined();
    expect(gate.retry).toBeDefined();
  });

  it("leaves a real example's authored values intact", () => {
    const raw = parse(example("code-review.at"));
    const { ast } = resolveDefaults(raw);
    const analyzer = ast.nodes.find((n) => n.id === "analyzer") as AgentNode;
    expect(analyzer.permissions).toBe("supervised"); // authored
    expect(analyzer.tools).toEqual(["Read", "Grep", "Glob"]); // authored
    expect(analyzer.memory).toEqual([]); // filled
  });

  it("does not hand the caller a reference to the defaults table", () => {
    // Regression: `applied[].value` aliased the module-level table, so mutating
    // a reported value poisoned the default for every later topology in the
    // process.
    const first = resolveDefaults(parse(MINIMAL));
    const reads = first.applied.find((a) => a.field === "reads")!;
    (reads.value as string[]).push("POISON");

    const second = resolveDefaults(parse(MINIMAL));
    const worker = second.ast.nodes.find((n) => n.id === "worker") as AgentNode;
    expect(worker.reads).toEqual([]);
    expect(second.applied.find((a) => a.field === "reads")!.value).toEqual([]);
  });
});
