/**
 * [N40] `validate` ends every run with the Claude Code version the output was
 * checked against, so a user reading old output can tell whether it is stale.
 * The numbers come from the conformance constants (themselves held to the
 * contract snapshot by N37), never from a second copy that could drift.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VERIFIED_ON, MINIMUM_VERSION, verifiedOnLine } from "../../conformance/claude-code.js";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, "../../../dist/cli/index.js");
const FIXTURE = resolve(here, "fixtures/compile.at");
const LINE = `checked against Claude Code ${VERIFIED_ON} (supports ${MINIMUM_VERSION} and later)`;
const run = (...args: string[]) => spawnSync("node", [CLI, ...args], { encoding: "utf8" });
const lastLine = (out: string) => out.trimEnd().split("\n").pop()!.trim();
// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("[N40] verified on", () => {
  it("[N40] the line is built from the conformance constants", () => {
    expect(verifiedOnLine()).toBe(LINE);
  });

  it("[N40] validate ends with the line on a clean file", () => {
    const dir = fs.mkdtempSync(join(os.tmpdir(), "at-vo-"));
    const f = join(dir, "ok.at");
    fs.writeFileSync(f, `topology ok : [pipeline] {\n  meta { version: "1.0.0" description: "x" }\n  orchestrator { model: sonnet handles: [a] }\n  action a { kind: inline description: "d" }\n  flow { a -> end }\n}\n`);
    const r = run("validate", f);
    expect(lastLine(plain(r.stdout))).toBe(LINE);
  });

  it("[N40] validate ends with the line on warnings and on errors", () => {
    const warn = run("validate", FIXTURE);
    expect(lastLine(plain(warn.stdout))).toBe(LINE);
    const dir = fs.mkdtempSync(join(os.tmpdir(), "at-vo-"));
    const bad = join(dir, "bad.at");
    fs.writeFileSync(bad, `topology bad : [pipeline] {\n  meta { version: "1.0.0" description: "x" bogus_field: 1 }\n  orchestrator { model: sonnet handles: [nope] }\n}\n`);
    const err = run("validate", bad);
    expect(err.status).toBe(1);
    expect(lastLine(plain(err.stdout))).toBe(LINE);
  });

  it("[N40] validate --inventory ends with the line", () => {
    const dir = fs.mkdtempSync(join(os.tmpdir(), "at-vo-"));
    const r = run("validate", FIXTURE, "--inventory", dir);
    expect(plain(r.stdout)).toContain(LINE);
    expect(lastLine(plain(r.stdout))).toBe(LINE);
  });

  it("[N40] scaffold --target claude-code and targets show it", () => {
    const dir = fs.mkdtempSync(join(os.tmpdir(), "at-vo-"));
    const s = run("scaffold", FIXTURE, "--target", "claude-code", "--dry-run", "--output", dir);
    expect(plain(s.stdout)).toContain(LINE);
    const t = plain(run("targets").stdout).split("\n").find((l) => l.includes("claude-code"))!;
    expect(t).toContain(LINE);
  });
});

// [RW-7] spec/claude-code/verified.json
import { verifiedListProblems, loadVerifiedList } from "../../conformance/claude-code.js";

describe("[RW-7] spec/claude-code/verified.json", () => {
  const file = resolve(dirname(fileURLToPath(import.meta.url)), "../../../spec/claude-code/verified.json");
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));

  it("[RW-7] every entry has a proof: run id, date, and suite counts", () => {
    expect(verifiedListProblems(doc)).toEqual([]);
    expect(doc.versions.length).toBeGreaterThan(0);
  });

  it("[RW-7] VERIFIED_ON is on the list", () => {
    expect(doc.versions.map((v: any) => v.version)).toContain(VERIFIED_ON);
  });

  it("[RW-7] planted: an entry with no proof field fails", () => {
    const planted = { versions: [...doc.versions, { version: "2.1.999" }] };
    const problems = verifiedListProblems(planted);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("2.1.999");
    expect(problems[0]).toContain("proof");
  });

  it("[RW-7] planted: a proof with no run id or date fails", () => {
    expect(verifiedListProblems({ versions: [{ version: "2.1.1", proof: { date: "2026-11-13" } }] })).toHaveLength(1);
    expect(verifiedListProblems({ versions: [{ version: "2.1.1", proof: { run: "r" } }] })).toHaveLength(1);
    expect(verifiedListProblems({ versions: [{ version: "x", proof: { run: "r", date: "d" } }] })).toHaveLength(1);
  });

  it("[RW-7] the loader returns the file's proven entries", () => {
    expect(loadVerifiedList().map((e) => e.version)).toContain(VERIFIED_ON);
  });
});
