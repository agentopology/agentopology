/**
 * Frozen AST differential: every .at file in the repo parses to the AST the
 * 0.12.0 candidate parser produced before prose regions were masked (recorded
 * once, from that build, into fixtures/prose-freeze/base-ast.json). None of
 * these files holds a section or a field in its prose, so masking prose must
 * not change a byte of their AST. Never regenerate the fixture to make this
 * pass: a difference here is a parse change a user would see.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../index.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const frozen = JSON.parse(readFileSync(join(here, "fixtures", "prose-freeze", "base-ast.json"), "utf8")) as Record<string, unknown>;

describe("every .at file in the repo parses as before", () => {
  it("the fixture covers the bundled examples", () => {
    expect(Object.keys(frozen).filter((f) => f.startsWith("examples/")).length).toBeGreaterThanOrEqual(10);
  });
  for (const [file, ast] of Object.entries(frozen)) {
    it(file, () => {
      const now = JSON.parse(JSON.stringify(parse(readFileSync(join(repo, file), "utf8"))));
      expect(now).toEqual(ast);
    });
  }
});
