/**
 * 0.11.2 (warn only): 0.11.x merges permission rules into .claude/settings.json
 * as a union, so a rule dropped from the .at stays in effect. Scaffold and
 * guard --target claude-code now name each rule the .at does not declare,
 * once per change, and never change what the file holds. An invalid
 * settings.json is a one-line error, not a stack trace.
 *
 * Runs the built CLI in temp dirs.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import { deepMergeSettingsJson } from "../../scaffold/merge.js";
import { readManifest, writeManifest, hashContent } from "../../scaffold/manifest.js";
import { computeIncrementalPlan, executeActions, nextManifestFiles } from "../../scaffold/incremental.js";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, "../../../dist/cli/index.js");
const EXAMPLES = resolve(here, "../../../examples");
const SETTINGS = ".claude/settings.json";
const MANIFEST = ".claude/.scaffold-manifest.json";

let root: string;
const at = (p: string) => join(root, p);

const topo = (name: string, settings: string) => `topology ${name} : [pipeline] {
  meta {
    version: "1.0.0"
    description: "${name}"
  }
  agent a {
    model: sonnet
    description: "a"
  }
  agent b {
    model: sonnet
    description: "b"
  }
${settings}
  flow { a -> b }
}
`;
const withAllow = (name: string, rules: string[]) =>
  topo(name, `  settings {\n    allow: [${rules.map((r) => JSON.stringify(r)).join(", ")}]\n  }`);

const A = "Bash(ls *)";
const R = "Read";
const U = "Bash(git status)";
const D = "Bash(rm -rf *)";
const X = "Grep";

function writeAt(file: string, text: string): void {
  fs.writeFileSync(at(file), text);
}

function cli(args: string[], cwd = root) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
const scaffold = (file: string, ...more: string[]) => cli(["scaffold", file, "--target", "claude-code", ...more]);
const guard = (file: string, ...more: string[]) => cli(["guard", file, "--target", "claude-code", ...more]);

/** The lines naming undeclared rules, trimmed, in print order. */
function named(out: { stdout: string; stderr: string }): string[] {
  return (out.stdout + out.stderr)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.includes("the .at does not declare it"));
}
const line = (list: string, rule: string) =>
  `${SETTINGS} ${list} ${rule}: still in effect; the .at does not declare it — remove it if you didn't add it by hand`;

/** User edits: add U to allow and D to deny, keeping every other byte's meaning. */
function addByHand(allow: string[], deny: string[] = []): void {
  const s = JSON.parse(fs.readFileSync(at(SETTINGS), "utf8"));
  s.permissions = s.permissions ?? {};
  s.permissions.allow = [...(s.permissions.allow ?? []), ...allow];
  if (deny.length) s.permissions.deny = [...(s.permissions.deny ?? []), ...deny];
  fs.writeFileSync(at(SETTINGS), JSON.stringify(s, null, 2) + "\n");
}

/** Every file under root (path and content hash), sorted. */
function tree(dir = root): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(`${relative(dir, p)} ${createHash("sha256").update(fs.readFileSync(p)).digest("hex")}`);
    }
  };
  walk(dir);
  return out.sort().join("\n");
}

const settingsOf = (name: string, rules: string[]) =>
  claudeCodeBinding.scaffold(parse(withAllow(name, rules))).find((f) => f.path === SETTINGS)!.content;

beforeEach(() => {
  root = fs.mkdtempSync(join(os.tmpdir(), "at-undeclared-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

/** Case a/b: allow [A, R] written, U and D added by hand, the .at drops A. */
function dropFlow(run: (file: string, ...more: string[]) => ReturnType<typeof cli>) {
  writeAt("t.at", withAllow("t", [A, R]));
  const first = run("t.at");
  expect(first.stderr).not.toMatch(/\n\s+at /);
  expect(named(first)).toEqual([]);
  addByHand([U], [D]);
  writeAt("t.at", withAllow("t", [R]));
  const before = fs.readFileSync(at(SETTINGS), "utf8");
  const second = run("t.at");
  const after = fs.readFileSync(at(SETTINGS), "utf8");
  const third = run("t.at");
  const afterThird = fs.readFileSync(at(SETTINGS), "utf8");
  addByHand([X]);
  const afterX = fs.readFileSync(at(SETTINGS), "utf8");
  const fourth = run("t.at");
  return { before, second, after, third, afterThird, afterX, fourth, final: fs.readFileSync(at(SETTINGS), "utf8") };
}

describe("[0.11.2] scaffold names the rules the .at does not declare", () => {
  it("[0.11.2-a] a rule dropped from the .at stays, and is named once with the user's rules", () => {
    const r = dropFlow(scaffold);
    // The file is what the unchanged 0.11.1 merge gives: A still there.
    expect(r.after).toBe(deepMergeSettingsJson(r.before, settingsOf("t", [R]), []));
    expect(JSON.parse(r.after).permissions.allow).toContain(A);
    expect(named(r.second)).toEqual([line("allow", A), line("allow", U), line("deny", D)]);
    // Nothing new: nothing printed, nothing changed.
    expect(named(r.third)).toEqual([]);
    expect(r.afterThird).toBe(r.after);
    // One more rule by hand: the whole current set is named again.
    expect(named(r.fourth)).toEqual([line("allow", A), line("allow", U), line("allow", X), line("deny", D)]);
    expect(r.final).toBe(r.afterX);
  });

  it("[0.11.2-a] the set last named is kept in the manifest entry of settings.json", () => {
    dropFlow(scaffold);
    const m = JSON.parse(fs.readFileSync(at(MANIFEST), "utf8"));
    expect(m.files[SETTINGS].undeclaredRulesNamed).toEqual([`allow ${A}`, `allow ${U}`, `allow ${X}`, `deny ${D}`]);
  });

  it("[0.11.2-a] once nothing is undeclared, nothing prints and the stored set is cleared", () => {
    dropFlow(scaffold);
    writeAt("t.at", withAllow("t", [A, R, U, X]).replace("  }\n  flow", `    deny: [${JSON.stringify(D)}]\n  }\n  flow`));
    const out = scaffold("t.at");
    expect(out.status).toBe(0);
    expect(named(out)).toEqual([]);
    const m = JSON.parse(fs.readFileSync(at(MANIFEST), "utf8"));
    expect(m.files[SETTINGS]).not.toHaveProperty("undeclaredRulesNamed");
  });

  it("[0.11.2-b] guard --target claude-code prints the same lines and leaves the same file", () => {
    const s = dropFlow(scaffold);
    const scaffoldRoot = root;
    root = fs.mkdtempSync(join(os.tmpdir(), "at-undeclared-g-"));
    try {
      const g = dropFlow(guard);
      expect(named(g.second)).toEqual(named(s.second));
      expect(named(g.third)).toEqual([]);
      expect(named(g.fourth)).toEqual(named(s.fourth));
      expect(g.after).toBe(s.after);
      expect(g.final).toBe(s.final);
      const m = JSON.parse(fs.readFileSync(at(MANIFEST), "utf8"));
      expect(m.files[SETTINGS].undeclaredRulesNamed).toEqual([`allow ${A}`, `allow ${U}`, `allow ${X}`, `deny ${D}`]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      root = scaffoldRoot;
    }
  });

  it("[0.11.2-c] --dry-run prints the same lines and writes nothing, the manifest included", () => {
    writeAt("t.at", withAllow("t", [A, R]));
    scaffold("t.at");
    addByHand([U], [D]);
    writeAt("t.at", withAllow("t", [R]));
    const hash = tree();
    const dryS = scaffold("t.at", "--dry-run");
    const dryG = guard("t.at", "--dry-run");
    expect(tree()).toBe(hash);
    const expected = [line("allow", A), line("allow", U), line("deny", D)];
    expect(named(dryS)).toEqual(expected);
    expect(named(dryG)).toEqual(expected);
    // Still not stored: the real run names them.
    expect(named(scaffold("t.at"))).toEqual(expected);
    const hash2 = tree();
    expect(named(scaffold("t.at", "--dry-run"))).toEqual([]);
    expect(tree()).toBe(hash2);
  });

  for (const [label, spoil] of [
    ["missing", () => fs.unlinkSync(at(MANIFEST))],
    ["unparsable", () => fs.writeFileSync(at(MANIFEST), "{ not json")],
    ["a field that is a string", () => setField("allow Bash(ls *)")],
    ["a field that holds numbers", () => setField([1, 2])],
  ] as const) {
    it(`[0.11.2-d] a manifest ${label}: named once, no crash, nothing deleted`, () => {
      writeAt("t.at", withAllow("t", [A, R]));
      scaffold("t.at");
      addByHand([U], [D]);
      writeAt("t.at", withAllow("t", [R]));
      spoil();
      const files = tree().split("\n").map((l) => l.split(" ")[0]).filter((p) => p !== MANIFEST);
      const before = fs.readFileSync(at(SETTINGS), "utf8");
      const out = scaffold("t.at");
      expect(out.status).toBe(0);
      expect(out.stderr).not.toMatch(/\n\s+at /);
      expect(named(out)).toEqual([line("allow", A), line("allow", U), line("deny", D)]);
      expect(fs.readFileSync(at(SETTINGS), "utf8")).toBe(before);
      for (const f of files) expect(fs.existsSync(at(f)), f).toBe(true);
      expect(named(scaffold("t.at"))).toEqual([]);
    });
  }

  it("[0.11.2-e] the .at drops its settings block: the file is kept across runs and its rules named once", () => {
    writeAt("t.at", withAllow("t", [A, R]));
    scaffold("t.at");
    addByHand([U], [D]);
    const before = fs.readFileSync(at(SETTINGS), "utf8");
    writeAt("t.at", topo("t", ""));
    const runs = [scaffold("t.at"), scaffold("t.at", "--prune"), scaffold("t.at")];
    for (const r of runs) expect(r.status).toBe(0);
    expect(fs.readFileSync(at(SETTINGS), "utf8")).toBe(before);
    expect(named(runs[0])).toEqual([line("allow", A), line("allow", R), line("allow", U), line("deny", D)]);
    expect(named(runs[1])).toEqual([]);
    expect(named(runs[2])).toEqual([]);
    // guard --target reads the same stored set: nothing new to name.
    expect(named(guard("t.at"))).toEqual([]);
    expect(fs.readFileSync(at(SETTINGS), "utf8")).toBe(before);
  });

  it("[0.11.2-f] two topologies in one directory: nothing removed, each names the other's rules", () => {
    writeAt("one.at", withAllow("one", [A, R]));
    writeAt("two.at", withAllow("two", [X]));
    expect(named(scaffold("one.at"))).toEqual([]);
    const two = scaffold("two.at");
    expect(named(two)).toEqual([line("allow", A), line("allow", R)]);
    const merged = fs.readFileSync(at(SETTINGS), "utf8");
    expect(JSON.parse(merged).permissions.allow).toEqual([A, R, X]);
    const one = scaffold("one.at");
    expect(named(one)).toEqual([line("allow", X)]);
    expect(named(scaffold("two.at"))).toEqual([]);
    expect(named(scaffold("one.at"))).toEqual([]);
    expect(fs.readFileSync(at(SETTINGS), "utf8")).toBe(merged);
  });

  for (const [label, run] of [["scaffold", scaffold], ["guard --target claude-code", guard]] as const) {
    it(`[0.11.2-g] ${label}: invalid JSON in settings.json is a one-line error and nothing is written`, () => {
      writeAt("t.at", withAllow("t", [A, R]));
      fs.mkdirSync(at(".claude"), { recursive: true });
      fs.writeFileSync(at(SETTINGS), '{ "permissions": { "allow": [ }');
      const hash = tree();
      const out = run("t.at");
      expect(out.status).not.toBe(0);
      const err = out.stderr.trim().split("\n");
      expect(err).toHaveLength(1);
      expect(err[0]).toMatch(/^Error: \.claude\/settings\.json is not valid JSON \(.+\)\. Nothing was written\.$/);
      expect(tree()).toBe(hash);
    });
  }
});

function setField(value: unknown): void {
  const m = JSON.parse(fs.readFileSync(at(MANIFEST), "utf8"));
  m.files[SETTINGS].undeclaredRulesNamed = value;
  fs.writeFileSync(at(MANIFEST), JSON.stringify(m, null, 2) + "\n");
}

describe("[0.11.2-h] every example scaffolds as before", () => {
  /** Two scaffolds through the library calls the CLI made in 0.11.1. */
  function libraryScaffold(dir: string, file: string): void {
    const src = fs.readFileSync(join(EXAMPLES, file), "utf8");
    for (let i = 0; i < 2; i++) {
      const files = claudeCodeBinding.scaffold(parse(src));
      const manifest = readManifest(dir, "claude-code", file);
      const actions = computeIncrementalPlan(dir, "claude-code", files, manifest);
      const result = executeActions(dir, actions, { prune: false, force: false });
      writeManifest(dir, "claude-code", {
        source: file,
        sourceHash: hashContent(src),
        target: "claude-code",
        generatedAt: "",
        files: nextManifestFiles(dir, actions, files, manifest, result),
      });
    }
  }
  const examples = fs.readdirSync(EXAMPLES).filter((f) => f.endsWith(".at"));

  for (const file of examples) {
    it(`[0.11.2-h] ${file}: identical files, and no new manifest field`, () => {
      const viaCli = join(root, "cli");
      const viaLib = join(root, "lib");
      fs.mkdirSync(viaCli);
      fs.mkdirSync(viaLib);
      for (let i = 0; i < 2; i++) {
        const out = cli(["scaffold", join(EXAMPLES, file), "--target", "claude-code"], viaCli);
        expect(out.status).toBe(0);
        expect(named(out)).toEqual([]);
      }
      libraryScaffold(viaLib, file);
      const strip = (t: string) => t.split("\n").filter((l) => !l.startsWith(MANIFEST + " ")).join("\n");
      expect(strip(tree(viaCli))).toBe(strip(tree(viaLib)));
      const m = (d: string) => {
        const j = JSON.parse(fs.readFileSync(join(d, MANIFEST), "utf8"));
        delete j.generatedAt;
        return j;
      };
      expect(m(viaCli)).toEqual(m(viaLib));
      expect(JSON.stringify(m(viaCli))).not.toContain("undeclaredRulesNamed");
    });
  }
});
