/**
 * [SP-9] Records in `guard --check` (Spec B, "The honest grade"): one block per
 * record, one line per way in, read from disk. B9 (a cited hook whose matcher
 * lacks a file-writing tool → a warning naming it), the B6 half (the bypass
 * line under every record), the generated and the missing cases.
 *
 * Every project is written inside the test (mkdtemp), scaffolded by the
 * binding, then changed on purpose.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import { checkGuards, renderGuardReport } from "../../guard/check.js";
import { checkCodexGuards } from "../../guard/check-codex.js";
import { RECORD_BYPASS_LINE } from "../../records/guard.js";

const here = dirname(fileURLToPath(import.meta.url));
const B9 = fs.readFileSync(resolve(here, "fixtures/records/b9/topology.at"), "utf8");
const GUARDS = fs.readFileSync(resolve(here, "fixtures/records/guards/topology.at"), "utf8");

let root: string;
const at = (p: string) => join(root, p);
function project(src: string, stubs: string[]) {
  const ast = parse(src);
  for (const f of claudeCodeBinding.scaffold(ast)) {
    fs.mkdirSync(dirname(at(f.path)), { recursive: true });
    fs.writeFileSync(at(f.path), f.content);
  }
  for (const s of stubs) {
    fs.mkdirSync(dirname(at(s)), { recursive: true });
    fs.writeFileSync(at(s), "# stub (made-up)\n");
  }
  return ast;
}
const report = (src: string) => {
  const r = checkGuards(parse(src), root);
  return { r, text: renderGuardReport(r).join("\n") };
};
const line = (text: string, record: string, way: string) => {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`  record ${record} `));
  return lines.slice(start + 1).find((l) => l.startsWith(`    ${way} `)) ?? "";
};

beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "at-sp9-report-"))); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("[SP-9][B9] a cited hook whose matcher lacks a file-writing tool", () => {
  it("[SP-9][B9] the tools line is the cited refuse, and a warning names NotebookEdit", () => {
    project(B9, ["scripts/approve.py", "hooks/protect-records.sh", "hooks/protect-bash.sh"]);
    const { r, text } = report(B9);
    expect(line(text, "approvals", "tools")).toContain("refuse, by hook (cited)");
    expect(text).toContain("⚠ the cited hooks' matchers miss NotebookEdit: that tool writes the record unrefused");
    expect(line(text, "approvals", "shell")).toMatch(/detect\s+PreToolUse Bash → protect-bash/);
    expect(r.missing).toBe(0);
  });

  it("[SP-9][B9] a cited hook absent from settings.json grades none and counts as missing", () => {
    project(B9, ["scripts/approve.py"]);
    const s = JSON.parse(fs.readFileSync(at(".claude/settings.json"), "utf8"));
    s.hooks.PreToolUse = s.hooks.PreToolUse.filter((e: { hooks: Array<{ command: string }> }) => !e.hooks.some((h) => h.command.includes("protect-records.sh")));
    fs.writeFileSync(at(".claude/settings.json"), JSON.stringify(s));
    const { r, text } = report(B9);
    expect(line(text, "approvals", "tools")).toMatch(/^\s+tools\s+none/);
    expect(text).toContain("✗ the cited hook protect-records is not in .claude/settings.json");
    expect(r.missing).toBeGreaterThan(0);
  });
});

describe("[SP-9] the generated record guards in guard --check", () => {
  const STUBS = ["scripts/approve.py", "scripts/trace.py", "scripts/protect-records.sh"];

  it("[SP-9] a generated record: tools refuse (generated, unverified), shell detect, later detect by code, other none", () => {
    project(GUARDS, STUBS);
    const { r, text } = report(GUARDS);
    expect(line(text, "approvals", "tools")).toMatch(/refuse, by hook \(generated\)\s+PreToolUse on .*→ before-edit.sh/);
    expect(line(text, "approvals", "shell")).toMatch(/detect\s+PreToolUse on Bash\|Monitor\|PowerShell → before-action.sh/);
    expect(line(text, "approvals", "later")).toContain("detect, by code");
    expect(line(text, "approvals", "other")).toMatch(/none\s+a path built at run time/);
    expect(text).toContain("unverified: the conformance suite has not proven");
    expect(r.missing).toBe(0);
  });

  it("[SP-9] a record with no written-by: none on both lines, anyone may write it, not missing", () => {
    project(GUARDS, STUBS);
    const { text } = report(GUARDS);
    expect(line(text, "notes", "tools")).toMatch(/none\s+no guard/);
    expect(text).toContain("anyone may write this record");
    expect(line(text, "notes", "later")).toBe(""); // not append-only
  });

  it("[SP-9] before-edit.sh removed: the generated tools line is none, and guard --check counts it missing", () => {
    project(GUARDS, STUBS);
    fs.unlinkSync(at(".claude/skills/records-guards/scripts/before-edit.sh"));
    const { r, text } = report(GUARDS);
    expect(line(text, "approvals", "tools")).toMatch(/^\s+tools\s+none/);
    expect(text).toContain("✗ .claude/skills/records-guards/scripts/before-edit.sh is missing");
    expect(r.missing).toBeGreaterThan(0);
  });

  it("[SP-9][B6] the bypass line is printed under every record, word for word, and nothing says protected", () => {
    project(GUARDS, STUBS);
    const { text } = report(GUARDS);
    const count = text.split("\n").filter((l) => l.includes(`bypass: ${RECORD_BYPASS_LINE}`)).length;
    expect(count).toBe(parse(GUARDS).records!.length);
    expect(text).not.toMatch(/\bprotected\b/);
  });

  it("[SP-9] codex says the records lines are graded for Claude Code only, rather than printing nothing", () => {
    const r = checkCodexGuards(parse(GUARDS.replace(/model: sonnet/g, "model: gpt-5.2")), root);
    expect(renderGuardReport(r).join("\n")).toContain("records: 4 declared; their lines (one per way in) are graded for Claude Code only");
  });
});
