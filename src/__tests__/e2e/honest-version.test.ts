/**
 * [T01] The version line tells the truth about the installed Claude Code.
 * Every test controls PATH itself: CI has no claude binary.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import { VERIFIED_ON } from "../../conformance/claude-code.js";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, "../../../dist/cli/index.js");
const FIXTURE = resolve(here, "fixtures/compile.at");
// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

function fakeBin(output: string, sleep = 0): string {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "at-t01-bin-"));
  const f = join(dir, "claude");
  fs.writeFileSync(f, `#!/bin/sh\n${sleep ? `/bin/sleep ${sleep}\n` : ""}echo "${output}"\n`, { mode: 0o755 });
  return dir;
}
const emptyDir = () => fs.mkdtempSync(join(os.tmpdir(), "at-t01-empty-"));

function run(pathDirs: string[], ...args: string[]) {
  // node is invoked by absolute path so PATH can hold only the fake dir.
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, PATH: pathDirs.join(":"), NO_COLOR: "1" } });
}

let project: string;
beforeAll(() => {
  project = fs.mkdtempSync(join(os.tmpdir(), "at-t01-proj-"));
  const ast = parse(fs.readFileSync(FIXTURE, "utf-8"));
  for (const f of claudeCodeBinding.scaffold(ast)) {
    fs.mkdirSync(dirname(join(project, f.path)), { recursive: true });
    fs.writeFileSync(join(project, f.path), f.content);
  }
  fs.mkdirSync(join(project, "docs/tools"), { recursive: true });
  fs.writeFileSync(join(project, "docs/tools/check.py"), "print('ok')\n");
});

describe("[T01] honest version", () => {
  it("[T01] validate: a different installed version is marked unverified", () => {
    const r = run([fakeBin("2.1.999 (Claude Code)")], "validate", FIXTURE);
    expect(plain(r.stdout)).toContain("installed 2.1.999: unverified");
  });

  it("[T01] validate: the verified version leaves output unchanged", () => {
    const r = run([fakeBin(`${VERIFIED_ON} (Claude Code)`)], "validate", FIXTURE);
    const out = plain(r.stdout);
    expect(out).not.toContain("unverified");
    expect(out).not.toContain("not installed");
  });

  it("[T01] validate: no claude on PATH prints 'Claude Code not installed', exit unchanged", () => {
    const with_ = run([fakeBin(`${VERIFIED_ON}`)], "validate", FIXTURE);
    const without = run([emptyDir()], "validate", FIXTURE);
    expect(plain(without.stdout)).toContain("Claude Code not installed");
    expect(without.status).toBe(with_.status);
  });

  it("[T01] validate: unparsable output is 'unknown version: unverified', exit unchanged", () => {
    const base = run([fakeBin(VERIFIED_ON)], "validate", FIXTURE);
    const r = run([fakeBin("hello")], "validate", FIXTURE);
    expect(plain(r.stdout)).toContain("unknown version: unverified");
    expect(r.status).toBe(base.status);
  });

  it("[T01] validate: a timeout is 'unknown version: unverified', exit unchanged", () => {
    const base = run([fakeBin(VERIFIED_ON)], "validate", FIXTURE);
    const r = run([fakeBin("2.1.999", 6)], "validate", FIXTURE);
    expect(plain(r.stdout)).toContain("unknown version: unverified");
    expect(r.status).toBe(base.status);
  }, 20000);

  const GUARD_FILE = resolve(here, "fixtures/compile.at");
  const guard = (pathDirs: string[]) => run(pathDirs, "guard", GUARD_FILE, "--check", "--dir", project);

  it("[T01] guard --check: with a different version, no refuse line lacks the mark", () => {
    const r = guard([fakeBin("2.1.999")]);
    const out = plain(r.stdout);
    expect(out).toContain("installed 2.1.999: unverified");
    const refuse = out.split("\n").filter((l) => /refuse/.test(l));
    expect(refuse.length).toBeGreaterThan(0);
    for (const l of refuse) expect(l).toMatch(/unverified/);
  });

  it("[T01] guard --check: the verified version leaves output unchanged", () => {
    const out = plain(guard([fakeBin(VERIFIED_ON)]).stdout);
    expect(out).not.toContain("unverified");
    expect(out).toMatch(/refuse/);
  });

  it("[T01] guard --check: no claude prints 'Claude Code not installed', exit unchanged", () => {
    const a = guard([fakeBin(VERIFIED_ON)]);
    const b = guard([emptyDir()]);
    expect(plain(b.stdout)).toContain("Claude Code not installed");
    expect(b.status).toBe(a.status);
  });
});
