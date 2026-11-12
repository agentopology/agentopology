import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parse } from "../../parser/index.js";
import {
  project,
  projectNode,
  ruleFor,
  unclaimedFields,
  unclaimedEdgeFields,
  DEFAULT_RULE,
  NODE_RULES,
} from "../project.js";

const ROOT = path.resolve(__dirname, "../../..");
const files = [
  path.join(ROOT, "kitchen-sink.at"),
  ...fs
    .readdirSync(path.join(ROOT, "examples"))
    .filter((f) => f.endsWith(".at"))
    .map((f) => path.join(ROOT, "examples", f)),
];

describe("[VZ-2] zero-drop projection", () => {
  it("[VZ-2] there is at least kitchen-sink and one example", () => {
    expect(files.length).toBeGreaterThan(2);
  });

  for (const f of files) {
    it(`[VZ-2] ${path.basename(f)}: every parsed node and edge field reaches the page or is claimed dropped`, () => {
      const ast = parse(fs.readFileSync(f, "utf8"));
      const data = project(ast);
      const lost: string[] = [];
      ast.nodes.forEach((n, i) => {
        for (const k of unclaimedFields(n as any, data.nodes[i])) lost.push(`${n.id}.${k}`);
      });
      ast.edges.forEach((e, i) => {
        for (const k of unclaimedEdgeFields(e as any, data.edges[i])) lost.push(`${e.from}->${e.to}.${k}`);
      });
      expect(lost).toEqual([]);
    });

    it(`[VZ-2] ${path.basename(f)}: same node ids and edges in the data`, () => {
      const ast = parse(fs.readFileSync(f, "utf8"));
      const data = project(ast);
      expect(data.nodes.map((n: any) => n.id)).toEqual(ast.nodes.map((n) => n.id));
      expect(data.edges.map((e: any) => [e.from, e.to, e.condition, e.maxIterations])).toEqual(
        ast.edges.map((e) => [e.from, e.to, e.condition, e.maxIterations]),
      );
    });
  }

  it("[VZ-2] fails on a planted unclaimed field", () => {
    const ast = parse(fs.readFileSync(files[0], "utf8"));
    const agent: any = ast.nodes.find((n) => n.type === "agent");
    agent.plantedNewField = "x";
    const lost = unclaimedFields(agent, projectNode(agent));
    expect(lost).toEqual(["plantedNewField"]);
  });

  it("[VZ-2] a field the table claims as dropped is not reported", () => {
    const orig = NODE_RULES.human;
    try {
      (NODE_RULES as any).human = { ...orig, dropped: { plantedNewField: "test only" } };
      const node: any = { id: "h", type: "human", label: "H", plantedNewField: 1 };
      expect(unclaimedFields(node, projectNode(node))).toEqual([]);
    } finally {
      (NODE_RULES as any).human = orig;
    }
  });

  it("[VZ-2] an unknown node kind draws with the default rule and keeps its fields", () => {
    expect(ruleFor("widget")).toBe(DEFAULT_RULE);
    const node: any = { id: "w", type: "widget", label: "W", size: 3 };
    const out = projectNode(node);
    expect(out).toEqual({ id: "w", type: "widget", label: "W", size: 3 });
    expect(unclaimedFields(node, out)).toEqual([]);
  });

  it("[VZ-2] gate anchors stay strings with the full list alongside", () => {
    const node: any = { id: "g", type: "gate", label: "G", after: ["a", "b"], before: "c" };
    const out = projectNode(node);
    expect(out.after).toBe("a");
    expect(out.afterAll).toEqual(["a", "b"]);
    expect(out.before).toBe("c");
    expect(unclaimedFields(node, out)).toEqual([]);
  });

  it("[VZ-2] project is pure: same AST gives equal data, AST unchanged", () => {
    const ast = parse(fs.readFileSync(files[0], "utf8"));
    const before = JSON.stringify(ast);
    expect(JSON.stringify(project(ast))).toBe(JSON.stringify(project(ast)));
    expect(JSON.stringify(ast)).toBe(before);
  });

  it("[VZ-2] facts, when given, ride along under `facts`; absent otherwise", () => {
    const ast = parse(fs.readFileSync(files[0], "utf8"));
    expect(project(ast).facts).toBeUndefined();
    expect(project(ast, { k: 1 }).facts).toEqual({ k: 1 });
  });
});
