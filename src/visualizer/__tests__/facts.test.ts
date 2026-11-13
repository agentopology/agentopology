import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import { checkGuards } from "../../guard/check.js";
import { versionStamp, verifiedOnLine, VERIFIED_ON, MINIMUM_VERSION } from "../../conformance/claude-code.js";
import { guardFacts } from "../../guard/check.js";
import { collectFacts, validateResult, NOT_CHECKED } from "../facts.js";
import { generateVisualization } from "../index.js";

const ROOT = path.resolve(__dirname, "../../..");
const SRC = fs.readFileSync(path.join(ROOT, "examples/code-review.at"), "utf8");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function scaffolded(source: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "at-vz3-"));
  for (const f of claudeCodeBinding.scaffold(parse(source))) {
    fs.mkdirSync(path.dirname(path.join(dir, f.path)), { recursive: true });
    fs.writeFileSync(path.join(dir, f.path), f.content, { mode: 0o755 });
  }
  return dir;
}

describe("[VZ3] structured results", () => {
  it("[VZ3] the version stamp is data and its line matches the text", () => {
    const v = versionStamp();
    expect(v.verifiedOn).toBe(VERIFIED_ON);
    expect(v.minimum).toBe(MINIMUM_VERSION);
    expect(v.line).toBe(verifiedOnLine());
    expect(["verified", "different", "unknown", "not-installed"]).toContain(v.installed.state);
  });

  it("[VZ3] validateResult carries the same results validate returns, with counts", () => {
    const ast = parse(SRC);
    const r = validateResult(ast, "/x/code-review.at");
    expect(r.results).toEqual(validate(ast, { filePath: "/x/code-review.at" }));
    expect(r.errors).toBe(r.results.filter((x) => x.level === "error").length);
    expect(r.warnings).toBe(r.results.filter((x) => x.level === "warning").length);
  });

  it("[VZ3] guardFacts is keyed by item id with strength, by and where", () => {
    const ast = parse(SRC);
    const dir = scaffolded(SRC);
    const report = checkGuards(ast, dir);
    const facts = guardFacts(report);
    expect(Object.keys(facts)).toEqual(report.items.map((i) => i.id));
    expect(facts["human-approval"]).toMatchObject({ kind: "gate", strength: "refuse", by: "hook" });
  });
});

describe("[VZ3] collectFacts", () => {
  const now = new Date("2026-01-02T03:04:05.000Z");

  it("[VZ3] with a project dir: sha256, time, validate, guard and inventory facts keyed by item id", () => {
    const dir = scaffolded(SRC);
    const f = collectFacts(parse(SRC), { source: SRC, filePath: path.join(ROOT, "examples/code-review.at"), dir, now });
    expect(f.checked).toBe(true);
    expect(f.sha256).toBe(sha(SRC));
    expect(f.at).toBe("2026-01-02T03:04:05.000Z");
    expect(f.version.verifiedOn).toBe(VERIFIED_ON);
    expect(f.items["human-approval"].guard).toMatchObject({ strength: "refuse" });
    expect(f.items["human-approval"].validate).not.toBe(NOT_CHECKED);
    expect(f.inventory).not.toBe(NOT_CHECKED);
    expect(f.inventory).toHaveProperty("total");
  });

  it("[VZ3] with no dir every fact reads not checked", () => {
    const ast = parse(SRC);
    const f = collectFacts(ast, { source: SRC, now });
    expect(f.checked).toBe(false);
    expect(f.sha256).toBe(sha(SRC));
    expect(f.validate).toBe(NOT_CHECKED);
    expect(f.guard).toBe(NOT_CHECKED);
    expect(f.inventory).toBe(NOT_CHECKED);
    for (const n of ast.nodes) {
      expect(f.items[n.id].validate).toBe(NOT_CHECKED);
      expect(f.items[n.id].guard).toBe(NOT_CHECKED);
    }
  });

  it("[VZ3] the page embeds the facts as page data", () => {
    const ast = parse(SRC);
    const facts = collectFacts(ast, { source: SRC, now });
    const html = generateVisualization(ast, { facts });
    expect(html).toContain('"sha256":"' + sha(SRC) + '"');
    expect(html).toContain('"checked":false');
  });
});
