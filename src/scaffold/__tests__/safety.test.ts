/**
 * Scaffold changes only what it owns.
 *
 * Found compiling a real harness (content-harness.at, 2026-10-28): the first
 * scaffold skipped the plan and wrote every file, so it would have overwritten
 * six hand-written SKILL.md files, settings.json, .mcp.json and a crontab —
 * two of the skills through symlinks into another repository — and then
 * crashed on a junk path with no manifest left behind.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { hashContent } from "../manifest.js";
import {
  computeIncrementalPlan,
  executeActions,
  nextManifestFiles,
  unsafePathReason,
} from "../incremental.js";
import type { ScaffoldManifest } from "../types.js";
import type { GeneratedFile } from "../../bindings/types.js";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { proseInRun, scriptNameFromRun } from "../../parser/run.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "at-safety-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const put = (rel: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), content, "utf-8");
};
const read = (rel: string) => fs.readFileSync(path.join(dir, rel), "utf-8");
const manifestOf = (files: ScaffoldManifest["files"]): ScaffoldManifest => ({
  source: "t.at", sourceHash: "x", target: "claude-code", generatedAt: "", files,
});

describe("first scaffold never overwrites a file it did not create", () => {
  it("plans an existing hand-written skill as a conflict and keeps it", () => {
    put(".claude/skills/story/SKILL.md", "REAL SKILL");
    const files: GeneratedFile[] = [
      { path: ".claude/skills/story/SKILL.md", content: "stub", category: "machine" },
      { path: ".claude/agents/a/AGENT.md", content: "agent", category: "agent" },
    ];
    const actions = computeIncrementalPlan(dir, "claude-code", files, null);
    expect(actions.map((a) => a.type)).toEqual(["conflict", "create"]);

    const result = executeActions(dir, actions, { prune: false, force: false });
    expect(read(".claude/skills/story/SKILL.md")).toBe("REAL SKILL");
    expect(read(".claude/agents/a/AGENT.md")).toBe("agent");

    // The kept file is never claimed, so a later --prune cannot delete it.
    const owned = nextManifestFiles(dir, actions, files, null, result);
    expect(Object.keys(owned)).toEqual([".claude/agents/a/AGENT.md"]);
  });

  it("overwrites it only with --force", () => {
    put("CLAUDE.md", "mine");
    const files: GeneratedFile[] = [{ path: "CLAUDE.md", content: "generated", category: "machine" }];
    const actions = computeIncrementalPlan(dir, "claude-code", files, null);
    executeActions(dir, actions, { prune: false, force: true });
    expect(read("CLAUDE.md")).toBe("generated");
  });
});

describe("symlinks are never written or deleted through", () => {
  it("blocks a file under a linked folder, even with --force", () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "at-other-repo-"));
    fs.writeFileSync(path.join(elsewhere, "SKILL.md"), "OTHER REPO");
    fs.mkdirSync(path.join(dir, ".claude/skills"), { recursive: true });
    fs.symlinkSync(elsewhere, path.join(dir, ".claude/skills/the-book"));

    const files: GeneratedFile[] = [
      { path: ".claude/skills/the-book/SKILL.md", content: "stub", category: "machine" },
    ];
    const actions = computeIncrementalPlan(dir, "claude-code", files, null);
    expect(actions[0].type).toBe("blocked");

    executeActions(dir, actions, { prune: false, force: true });
    expect(fs.readFileSync(path.join(elsewhere, "SKILL.md"), "utf-8")).toBe("OTHER REPO");
    fs.rmSync(elsewhere, { recursive: true, force: true });
  });
});

describe("an unsafe path aborts the run before anything is written", () => {
  it.each([
    [".claude/skills/t/scripts/", "ends in '/'"],
    [".claude/skills/t/scripts/E;", "unsafe name"],
    [".claude/skills/t/scripts/fail:", "unsafe name"],
    [".claude/skills/t/scripts/outputs.py)", "unsafe name"],
    ["../escape.sh", "climbs out"],
    ["/etc/passwd", "absolute"],
  ])("refuses %s", (p, why) => {
    expect(unsafePathReason(p)).toContain(why);
  });

  it("writes none of the good files when one path is bad", () => {
    const files: GeneratedFile[] = [
      { path: "good.md", content: "x", category: "machine" },
      { path: ".claude/skills/t/scripts/", content: "x", category: "script" },
    ];
    const actions = computeIncrementalPlan(dir, "claude-code", files, null);
    expect(() => executeActions(dir, actions, { prune: false, force: true })).toThrow(/unsafe path/);
    expect(fs.existsSync(path.join(dir, "good.md"))).toBe(false);
  });
});

describe("re-scaffold keeps edits to files scaffold owns", () => {
  it("treats an edited CLAUDE.md as a conflict, not an update", () => {
    put(".claude/CLAUDE.md", "generated\nmy own note\n");
    const manifest = manifestOf({ ".claude/CLAUDE.md": { hash: hashContent("generated\n"), category: "machine" } });
    const files: GeneratedFile[] = [{ path: ".claude/CLAUDE.md", content: "generated v2\n", category: "machine" }];
    const actions = computeIncrementalPlan(dir, "claude-code", files, manifest);
    expect(actions[0]).toMatchObject({ type: "conflict", detail: "user edited" });
  });

  it("updates an untouched owned file", () => {
    put(".claude/CLAUDE.md", "generated\n");
    const manifest = manifestOf({ ".claude/CLAUDE.md": { hash: hashContent("generated\n"), category: "machine" } });
    const files: GeneratedFile[] = [{ path: ".claude/CLAUDE.md", content: "generated v2\n", category: "machine" }];
    expect(computeIncrementalPlan(dir, "claude-code", files, manifest)[0].type).toBe("update");
  });
});

describe("--prune deletes only what scaffold left untouched", () => {
  it("keeps an edited leftover and removes a clean one with its empty folder", () => {
    put(".claude/agents/old/AGENT.md", "as generated");
    put(".claude/agents/edited/AGENT.md", "as generated + my edits");
    const manifest = manifestOf({
      ".claude/agents/old/AGENT.md": { hash: hashContent("as generated"), category: "agent" },
      ".claude/agents/edited/AGENT.md": { hash: hashContent("as generated"), category: "agent" },
    });
    const actions = computeIncrementalPlan(dir, "claude-code", [], manifest);
    executeActions(dir, actions, { prune: true, force: true });
    expect(fs.existsSync(path.join(dir, ".claude/agents/old"))).toBe(false);
    expect(read(".claude/agents/edited/AGENT.md")).toBe("as generated + my edits");
  });
});

describe("prose in run (V94)", () => {
  // Real values from content-harness.at.
  const prose = [
    "auto_gates.py: G1 truth, G2 vendor, G3 credit",
    "pxframes gate mean >= 3.85, no frame < 3; pooled 3 runs",
    "frames 0.0 / 0.5 / 3.0 s differ",
    "BUILT 10-28 (ME-R76): kit.py --at 'YYYY-MM-DD HH:MM'",
    "vowel_check.py (BUILT 10-28, ME-535) -> the LISTEN LIST",
  ];
  const commands = [
    "scripts/check-quality.sh",
    "./media validate --step all",
    "python3 docs/content-os/gift.py run",
    "bash -c 'echo (quoted) ok'",
    "test -f out.json && jq '.ok' out.json",
  ];

  it.each(prose)("flags %s", (r) => expect(proseInRun(r)).not.toBeNull());
  it.each(commands)("accepts %s", (r) => expect(proseInRun(r)).toBeNull());

  it("keeps the historical script name for real commands", () => {
    expect(scriptNameFromRun("scripts/check-quality.sh")).toBe("check-quality.sh");
    expect(scriptNameFromRun("frames 0.0 / 0.5 / 3.0 s differ")).toBeNull();
  });

  const example = fs.readFileSync(
    path.join(__dirname, "../../../examples/simple-pipeline.at"),
    "utf-8",
  );
  const at = (run: string) => example.replace('run: "scripts/check-quality.sh"', `run: "${run}"`);

  it("validate rejects it, and the binding emits no junk path even when forced", () => {
    const ast = parse(at("pxframes gate mean >= 3.85, no frame < 3; frames 0.0 / 0.5 / 3.0 s"));
    expect(validate(ast).some((r) => r.rule === "V94" && r.level === "error")).toBe(true);
    const files = claudeCodeBinding.scaffold(ast);
    expect(files.filter((f) => unsafePathReason(f.path))).toEqual([]);
  });

  it("a real command still compiles to its script and hook", () => {
    const ast = parse(at("scripts/check.sh"));
    expect(validate(ast).filter((r) => r.rule === "V94")).toEqual([]);
    const paths = claudeCodeBinding.scaffold(ast).map((f) => f.path);
    expect(paths).toContain(".claude/skills/simple-pipeline/scripts/check.sh");
    expect(paths).toContain(".claude/skills/simple-pipeline/scripts/gate-quality-check.sh");
  });
});

describe("two topologies in one project keep separate manifests", () => {
  it("does not treat another topology's files as its own", async () => {
    const { readManifest, writeManifest } = await import("../manifest.js");
    put("crontab.fragment", "0 * * * * other-topology\n");
    writeManifest(dir, "claude-code", {
      ...manifestOf({ "crontab.fragment": { hash: hashContent("0 * * * * other-topology\n"), category: "machine" } }),
      source: "youtube-flywheel.at",
    });

    const mine = readManifest(dir, "claude-code", "content-harness.at");
    expect(mine).toBeNull();
    const files: GeneratedFile[] = [{ path: "crontab.fragment", content: "0 6 * * * mine\n", category: "machine" }];
    const actions = computeIncrementalPlan(dir, "claude-code", files, mine);
    expect(actions[0]).toMatchObject({ type: "conflict", detail: "exists, not created by scaffold" });

    // Writing this topology's manifest leaves the other one in place.
    writeManifest(dir, "claude-code", { ...manifestOf({}), source: "content-harness.at" });
    expect(readManifest(dir, "claude-code", "youtube-flywheel.at")?.files["crontab.fragment"]).toBeDefined();
    expect(readManifest(dir, "claude-code", "content-harness.at")).not.toBeNull();
  });
});
