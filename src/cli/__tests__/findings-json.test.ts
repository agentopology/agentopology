/**
 * `validate --json` and `guard --check --json` print one findings document,
 * checked here against spec/findings-output.schema.json over every example.
 * The exit code is the one the command has without --json.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const CLI = resolve(root, "dist/cli/index.js");
const schema = JSON.parse(readFileSync(resolve(root, "spec/findings-output.schema.json"), "utf8"));

function run(args: string[]): { stdout: string; stderr: string; code: number } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8", timeout: 60_000 });
  return { stdout: r.stdout, stderr: r.stderr, code: r.status ?? 1 };
}

/**
 * The part of JSON Schema the findings schema uses: type, const, enum,
 * required, properties, additionalProperties: false, items, minLength,
 * minimum and local $ref. Returns the paths that fail, empty when valid.
 */
function check(value: unknown, s: Record<string, any>, at = "$"): string[] {
  if (s.$ref) {
    const target = (s.$ref as string).replace(/^#\//, "").split("/").reduce((o: any, k) => o[k], schema);
    return check(value, target, at);
  }
  const errs: string[] = [];
  const typeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
  if (s.type) {
    const types: string[] = Array.isArray(s.type) ? s.type : [s.type];
    const t = typeOf(value);
    if (!types.includes(t) && !(t === "integer" && types.includes("number"))) return [`${at}: type ${t}, want ${types.join("|")}`];
  }
  if ("const" in s && value !== s.const) errs.push(`${at}: not ${JSON.stringify(s.const)}`);
  if (s.enum && !s.enum.includes(value)) errs.push(`${at}: ${JSON.stringify(value)} not in enum`);
  if (typeof value === "string" && s.minLength !== undefined && value.length < s.minLength) errs.push(`${at}: too short`);
  if (typeof value === "number" && s.minimum !== undefined && value < s.minimum) errs.push(`${at}: below minimum`);
  if (Array.isArray(value) && s.items) value.forEach((v, i) => errs.push(...check(v, s.items, `${at}[${i}]`)));
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const k of s.required ?? []) if (!(k in obj)) errs.push(`${at}: missing ${k}`);
    for (const [k, v] of Object.entries(obj)) {
      if (s.properties?.[k]) errs.push(...check(v, s.properties[k], `${at}.${k}`));
      else if (s.additionalProperties === false) errs.push(`${at}: unexpected ${k}`);
    }
  }
  return errs;
}

const examples = readdirSync(resolve(root, "examples")).filter((f) => f.endsWith(".at")).sort();

const variants: Array<{ name: string; args: (f: string) => string[] }> = [
  { name: "validate", args: (f) => ["validate", f] },
  { name: "validate --target codex", args: (f) => ["validate", f, "--target", "codex"] },
  { name: "guard --check", args: (f) => ["guard", f, "--check", "--dir", "."] },
  { name: "guard --check --target codex", args: (f) => ["guard", f, "--check", "--dir", ".", "--target", "codex"] },
];

describe("the schema checker itself", () => {
  it("refuses a document that breaks the schema", () => {
    expect(check({ version: 2, command: "validate", findings: [], exitCode: 0 }, schema)).not.toEqual([]);
    expect(check({ version: 1, command: "validate", findings: [{ id: "V1", severity: "fatal", message: "m", file: "f", line: null, source: "validator" }], exitCode: 0 }, schema)).not.toEqual([]);
    expect(check({ version: 1, command: "validate", findings: [], exitCode: 0, extra: 1 }, schema)).not.toEqual([]);
    expect(check({ version: 1, command: "validate", findings: [{ id: "V1", severity: "error", message: "m", file: "f", line: 0, source: "validator" }], exitCode: 1 }, schema)).not.toEqual([]);
    expect(check({ version: 1, command: "validate", findings: [{ id: "V1", severity: "error", message: "m", file: "f", line: 3, source: "validator" }], exitCode: 1 }, schema)).toEqual([]);
  });
});

describe.each(variants)("$name --json over every example", ({ name, args }) => {
  it.each(examples)("%s", (example) => {
    const f = `examples/${example}`;
    const plain = run(args(f));
    const json = run([...args(f), "--json"]);
    const doc = JSON.parse(json.stdout);
    expect(check(doc, schema)).toEqual([]);
    expect(doc.command).toBe(name.startsWith("guard") ? "guard --check" : "validate");
    expect(json.code).toBe(plain.code);
    expect(doc.exitCode).toBe(json.code);
    if (name.endsWith("codex")) expect(doc.target).toBe("codex");
    if (doc.command === "validate") {
      const errors = doc.findings.filter((x: { severity: string }) => x.severity === "error").length;
      expect(errors > 0 ? 1 : 0).toBe(doc.exitCode);
      for (const x of doc.findings) expect(x.file).toBe(f);
    } else {
      expect(doc.findings.some((x: { severity: string }) => x.severity === "error") ? 1 : 0).toBe(doc.exitCode);
    }
  });
});

describe("validate --json on findings and failures", () => {
  const dir = mkdtempSync(join(tmpdir(), "at-json-"));

  it("carries each rule's id, severity and line, and exits 1 on an error", () => {
    const f = join(dir, "bad.at");
    writeFileSync(f, readFileSync(resolve(root, "examples/simple-pipeline.at"), "utf8").replace(/\n\s*flow\s*\{/, "\n  flow {\n    ghost -> nowhere"));
    const plain = run(["validate", f]);
    const json = run(["validate", f, "--json"]);
    const doc = JSON.parse(json.stdout);
    expect(check(doc, schema)).toEqual([]);
    expect(plain.code).toBe(1);
    expect(json.code).toBe(1);
    expect(doc.exitCode).toBe(1);
    const errors = doc.findings.filter((x: { severity: string }) => x.severity === "error");
    expect(errors.length).toBeGreaterThan(0);
    for (const e of errors) {
      expect(e.id).toMatch(/^V\d+$/);
      expect(e.source).toBe("validator");
      expect(plain.stdout).toContain(`ERROR [${e.id}]`);
    }
  });

  it("a parse error is one error finding and exit 1", () => {
    const f = join(dir, "broken.at");
    writeFileSync(f, "topology broken : [pipeline] {\n  agent a {\n");
    const json = run(["validate", f, "--json"]);
    const doc = JSON.parse(json.stdout);
    expect(check(doc, schema)).toEqual([]);
    expect(json.code).toBe(1);
    expect(doc.findings).toHaveLength(1);
    expect(doc.findings[0]).toMatchObject({ id: "parse", severity: "error", source: "parser", file: f });
  });

  it("a missing file and an unknown target are error findings and exit 1", () => {
    const missing = JSON.parse(run(["validate", join(dir, "nope.at"), "--json"]).stdout);
    expect(check(missing, schema)).toEqual([]);
    expect(missing.findings[0]).toMatchObject({ id: "file.not-found", severity: "error", source: "cli" });
    const unknown = run(["validate", "examples/simple-pipeline.at", "--target", "nope", "--json"]);
    const doc = JSON.parse(unknown.stdout);
    expect(check(doc, schema)).toEqual([]);
    expect(unknown.code).toBe(1);
    expect(doc.findings[0]).toMatchObject({ id: "cli.unknown-target", severity: "error", source: "cli" });
  });

  it("several files make one document", () => {
    const json = run(["validate", "examples/simple-pipeline.at", "examples/code-review.at", "--json"]);
    const doc = JSON.parse(json.stdout);
    expect(check(doc, schema)).toEqual([]);
    expect(json.code).toBe(0);
  });
});
