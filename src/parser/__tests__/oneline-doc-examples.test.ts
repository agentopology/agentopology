/**
 * Every one-line block shown in the CHANGELOG, the spec and the docs topics
 * separates its fields with commas. `{ path: "a" readers: [x] }` reads
 * `"a" readers: [x]` as the path (V157), so an example written that way
 * teaches a wall that refuses nothing. A field after a closing `]` is read by
 * the list reader, so `[..] key:` is allowed. The examples of what NOT to
 * write are listed by name below.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "../index.js";
import { validate } from "../validator.js";

const ROOT = join(__dirname, "..", "..", "..");
const FILES = [
  "CHANGELOG.md",
  ...readdirSync(join(ROOT, "spec")).filter((f) => f.endsWith(".md")).map((f) => `spec/${f}`),
  "src/docs/content.ts",
  "README.md",
];

/** Examples that show the mistake on purpose. */
const NEGATIVE = [
  "{ model: sonnet retry: 3 }",
  '{ on: Stop run: "x" }',
  '{ path: "config/prod/**" readers: [worker] }',
];

/** One-line `{ key: ... }` bodies with no nested braces. */
function oneLineBlocks(text: string): string[] {
  return [...text.matchAll(/\{ [a-z][a-z-]*: [^{}\n]*\}/g)].map((m) => m[0]);
}

/** A field run into the one before it: `" key:` or `value key:` with no comma. */
function runOn(block: string): boolean {
  const body = block.replace(/\[[^\]]*\]/g, "[]");
  return /("|[A-Za-z0-9_>)*-]) +[a-z][a-z-]*: /.test(body.replace(/"[^"]*"/g, (q) => `"${"x".repeat(q.length - 2)}"`).replace(/^\{ [a-z][a-z-]*: /, ""));
}

describe("one-line examples in the docs", () => {
  for (const f of FILES) {
    it(`${f} writes commas between fields`, () => {
      const text = readFileSync(join(ROOT, f), "utf8").replace(/\\`/g, "`");
      const bad = oneLineBlocks(text).filter((b) => runOn(b) && !NEGATIVE.includes(b));
      expect(bad).toEqual([]);
    });
  }

  const H = [
    "topology t : [pipeline] {",
    '  meta { version: "1.0.0"',
    '    description: "x" }',
    "  orchestrator { model: sonnet }",
    "  agent worker { model: sonnet",
    "    skills: [testing]",
    "    prompt { Do. } }",
    "  flow { worker -> worker }",
  ].join("\n");
  const at = (b: string) => `${H}\n${b}\n}\n`;

  it("the tool and skill examples parse into their fields", () => {
    const ast = parse(at('  skill testing { description: "Tests", scripts: [run-tests] }\n  tools { tool run-tests { command: "npm test", description: "Run the suite" } }'));
    expect(ast.skills[0]).toMatchObject({ description: "Tests", scripts: ["run-tests"] });
    expect(ast.toolDefs[0]).toMatchObject({ command: "npm test", description: "Run the suite" });
    expect(validate(ast).filter((r) => r.rule === "V157")).toEqual([]);
  });

  it("the secret example parses into its fields", () => {
    const ast = parse(at('  secrets { secret prod { path: "config/prod/**", readers: [worker] } }'));
    expect(ast.secrets?.[0]).toEqual({ id: "prod", path: "config/prod/**", readers: ["worker"] });
  });

  it("the README store sources example parses into its fields", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    const line = readme.split("\n").find((l) => l.includes('gmail { color: "#EA4335"'))!.trim();
    const ast = parse(at(`  memory {\n    store brain {\n      type: brain\n      sources {\n        ${line}\n        slack { color: "#4A154B" }\n      }\n    }\n  }`));
    const store = ast.stores?.[0] as unknown as { sources: Record<string, unknown> };
    expect(store.sources).toEqual({
      gmail: { color: "#EA4335", icon: "./gmail.svg" },
      slack: { color: "#4A154B" },
    });
  });

  it("the CHANGELOG tool example errors in its broken form", () => {
    const ast = parse(at('  tools { tool run-tests { command: "npm test" description: "Run the suite" } }'));
    expect(validate(ast).some((r) => r.rule === "V157" && r.level === "error")).toBe(true);
  });
});
