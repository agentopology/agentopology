/**
 * SP-6: the record rules in validate (Spec B, "Validation rules").
 *
 * V130 a `written-by` program that is not on disk (error, the "missing" class)
 * V131 a record with no `written-by` (warning: "anyone may write this record")
 * V132 a record id equal to a store id (warning)
 * V133 a `guard:` id that is not a declared hook (error); the cited hooks
 *      leave a file-writing tool from the conformance facts unmatched (warning
 *      naming the tool)
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { recordRules } from "../../records/index.js";
import { FILE_WRITE_TOOLS } from "../../conformance/claude-code.js";

const FIX = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/records");
const at = (name: string) => resolve(FIX, name, "topology.at");
const load = (file: string) => parse(fs.readFileSync(file, "utf8"));
const findings = (name: string, rule: string) =>
  validate(load(at(name)), { filePath: at(name) }).filter((r) => r.rule === rule);

describe("[SP-6] record rules", () => {
  it("[SP-6][B2] a written-by program that is not on disk is an error naming the record", () => {
    const r = findings("b2", "V130");
    expect(r).toHaveLength(1);
    expect(r[0].level).toBe("error");
    expect(r[0].message).toMatch(/"approvals"/);
    expect(r[0].message).toMatch(/nope\.py/);
    expect(r[0].message).toMatch(/missing/);
  });

  it("[SP-6][B2] a written-by program present on disk, or naming a node, finds nothing", () => {
    expect(findings("b1", "V130")).toEqual([]);
    expect(findings("b9", "V130")).toEqual([]); // "maker" is an agent, not a file
  });

  it("[SP-6][B2] without a file path the disk is not read", () => {
    const r = validate(load(at("b2"))).filter((x) => x.rule === "V130");
    expect(r).toEqual([]);
  });

  it("[SP-6][B2] a written-by path that leaves the project is an error", () => {
    const src = fs.readFileSync(at("b2"), "utf8").replace('"nope.py"', '"../outside.py"');
    const r = validate(parse(src), { filePath: at("b2") }).filter((x) => x.rule === "V130");
    expect(r).toHaveLength(1);
    expect(r[0].level).toBe("error");
    expect(r[0].message).toMatch(/project-relative/);
  });

  it("[SP-6][B3] a record with no written-by gives one warning", () => {
    const r = findings("b3", "V131");
    expect(r).toHaveLength(1);
    expect(r[0].level).toBe("warning");
    expect(r[0].message).toMatch(/anyone may write this record/);
    expect(r[0].message).toMatch(/"approvals"/);
    expect(validate(load(at("b3")), { filePath: at("b3") }).filter((x) => x.level === "error")).toEqual([]);
  });

  it("[SP-6][B3] a record with written-by gives no such warning", () => {
    expect(findings("b1", "V131")).toEqual([]);
  });

  it("[SP-6] a record id equal to a store id is a warning", () => {
    const r = findings("same-id", "V132");
    expect(r).toHaveLength(1);
    expect(r[0].level).toBe("warning");
    expect(r[0].message).toMatch(/declared as a store agents write and as a record only programs write/);
    expect(r[0].message).toMatch(/"notes"/);
    expect(findings("b1", "V132")).toEqual([]);
  });

  it("[SP-6] a guard: id that is not a declared hook is an error", () => {
    const r = findings("guard-unknown", "V133");
    expect(r).toHaveLength(1);
    expect(r[0].level).toBe("error");
    expect(r[0].message).toMatch(/protect-records/);
  });

  it("[SP-6][B9] a cited hook whose matcher lacks one file-writing tool gives a warning naming the tool", () => {
    expect(FILE_WRITE_TOOLS).toContain("NotebookEdit");
    const r = findings("b9", "V133");
    expect(r).toHaveLength(1);
    expect(r[0].level).toBe("warning");
    expect(r[0].message).toMatch(/NotebookEdit/);
    expect(r[0].message).toMatch(/"approvals"/);
    expect(validate(load(at("b9")), { filePath: at("b9") }).filter((x) => x.level === "error")).toEqual([]);
  });

  it("[SP-6][B9] cited hooks that together match every file-writing tool find nothing", () => {
    const src = fs.readFileSync(at("b9"), "utf8").replace('"Write|Edit|MultiEdit"', `"${FILE_WRITE_TOOLS.join("|")}"`);
    expect(validate(parse(src), { filePath: at("b9") }).filter((x) => x.rule === "V133")).toEqual([]);
  });

  it("[SP-6] recordRules is what validate runs for records", () => {
    const ast = load(at("b2"));
    const ids = recordRules(ast, { filePath: at("b2") }).map((r) => r.rule);
    expect(ids).toEqual(["V130"]);
  });
});
