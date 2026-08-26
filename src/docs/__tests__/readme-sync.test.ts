/**
 * The README must not make claims the package cannot honour.
 *
 * It documented `agentopology/plan` and `agentopology/render` subpath imports
 * that did not exist in package.json `exports` — so the example in it would
 * have thrown for anyone who copied it. Counts drift the same way.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "../../parser/validator.js";
import { parse } from "../../parser/index.js";
import { topics } from "../content.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

describe("README stays honest", () => {
  const readme = read("README.md");
  const pkg = JSON.parse(read("package.json")) as {
    exports: Record<string, unknown>;
  };

  it("only documents subpath imports the package actually exports", () => {
    const imports = [...readme.matchAll(/from ["']agentopology(\/[a-z-]+)?["']/g)].map(
      (m) => m[1] ?? "."
    );
    expect(imports.length, "README should show at least one import").toBeGreaterThan(0);
    for (const sub of new Set(imports)) {
      const key = sub === "." ? "." : `.${sub}`;
      expect(pkg.exports[key], `README imports "agentopology${sub === "." ? "" : sub}" but package.json does not export "${key}"`).toBeDefined();
    }
  });

  it("states the real validation rule count", () => {
    const src = read("src/parser/validator.ts");
    const body = src.slice(src.indexOf("export function validate("));
    const count = new Set(
      [...body.matchAll(/\.\.\.v(\d+)[A-Za-z0-9_]*\(ast\)/g)].map((m) => m[1])
    ).size;
    const claims = [...readme.matchAll(/(\d+)\s+(?:built-in\s+)?rules/g)].map((m) =>
      Number(m[1])
    );
    expect(claims.length, "README should state a rule count").toBeGreaterThan(0);
    for (const c of claims) expect(c, `README says ${c} rules; validator has ${count}`).toBe(count);
  });

  it("only points at docs topics that exist", () => {
    const referenced = [...readme.matchAll(/agentopology docs ([a-z][a-z-]*)/g)].map(
      (m) => m[1]
    );
    for (const t of new Set(referenced)) {
      if (t === "topic") continue; // the placeholder in the CLI reference
      expect(topics[t], `README points at "agentopology docs ${t}", which is not a topic`).toBeDefined();
    }
  });

  it("every .at snippet in the README parses", () => {
    // Fenced ```at blocks are shown as real syntax; a broken one teaches the
    // wrong shape to every reader and every agent that scrapes it.
    const blocks = [...readme.matchAll(/```at\n([\s\S]*?)```/g)].map((m) => m[1]);
    for (const b of blocks) {
      if (!/^\s*topology\s/.test(b)) continue; // fragments are illustrative
      expect(() => parse(b), `README .at block failed to parse:\n${b.slice(0, 120)}`).not.toThrow();
      const errors = validate(parse(b)).filter((r) => r.level === "error");
      expect(errors.map((e) => `${e.rule}: ${e.message}`), "README .at block").toEqual([]);
    }
  });
});
