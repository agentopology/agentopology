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

/** The lines about undeclared rules (the full list or the summary), trimmed, in print order. */
function named(out: { stdout: string; stderr: string }): string[] {
  return (out.stdout + out.stderr)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.includes("the .at does not declare it") || l.includes("declared in the .at:"));
}
/** Each rule is printed as a JSON string, so its text can never forge or erase a line. */
const line = (list: string, rule: string) =>
  `${SETTINGS} ${list} ${JSON.stringify(rule)}: still in effect; the .at does not declare it — remove it if you didn't add it by hand`;
/** `"<list> <rule>"` as the summary prints it. */
const shownItem = (item: string) => {
  const space = item.indexOf(" ");
  return `${item.slice(0, space)} ${JSON.stringify(item.slice(space + 1))}`;
};
/** The one line printed on every other run while the set is not empty. */
const summary = (...rules: string[]) => {
  const shown = rules.slice(0, 5).map(shownItem).join(", ") + (rules.length > 5 ? ` and ${rules.length - 5} more` : "");
  const n = rules.length;
  return n === 1
    ? `1 rule in ${SETTINGS} isn't declared in the .at: ${shown}; declare it in the .at to keep it, or remove it`
    : `${n} rules in ${SETTINGS} aren't declared in the .at: ${shown}; declare them in the .at to keep them, or remove them`;
};

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
    // Nothing new: one summary line, nothing changed.
    expect(named(r.third)).toEqual([summary(`allow ${A}`, `allow ${U}`, `deny ${D}`)]);
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
      expect(named(g.third)).toEqual(named(s.third));
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
    const sum = [summary(`allow ${A}`, `allow ${U}`, `deny ${D}`)];
    expect(named(scaffold("t.at", "--dry-run"))).toEqual(sum);
    expect(named(guard("t.at", "--dry-run"))).toEqual(sum);
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
      expect(named(scaffold("t.at"))).toEqual([summary(`allow ${A}`, `allow ${U}`, `deny ${D}`)]);
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
    const sum = [summary(`allow ${A}`, `allow ${R}`, `allow ${U}`, `deny ${D}`)];
    expect(named(runs[1])).toEqual(sum);
    expect(named(runs[2])).toEqual(sum);
    // guard --target reads the same stored set: nothing new, the summary again.
    expect(named(guard("t.at"))).toEqual(sum);
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
    expect(named(scaffold("two.at"))).toEqual([summary(`allow ${A}`, `allow ${R}`)]);
    expect(named(scaffold("one.at"))).toEqual([summary(`allow ${X}`)]);
    expect(fs.readFileSync(at(SETTINGS), "utf8")).toBe(merged);
  });

  it("[0.11.2-i] a set that only shrinks prints the summary, not the list", () => {
    dropFlow(scaffold);
    const s = JSON.parse(fs.readFileSync(at(SETTINGS), "utf8"));
    s.permissions.allow = s.permissions.allow.filter((r: string) => r !== U);
    fs.writeFileSync(at(SETTINGS), JSON.stringify(s, null, 2) + "\n");
    const out = scaffold("t.at");
    expect(named(out)).toEqual([summary(`allow ${A}`, `allow ${X}`, `deny ${D}`)]);
    const m = JSON.parse(fs.readFileSync(at(MANIFEST), "utf8"));
    expect(m.files[SETTINGS].undeclaredRulesNamed).toEqual([`allow ${A}`, `allow ${X}`, `deny ${D}`]);
  });

  it("[0.11.2-j] more than 5 rules: the list names all, the summary the first 5 and the count of the rest", () => {
    writeAt("t.at", withAllow("t", [R]));
    scaffold("t.at");
    const extra = ["Bash(a)", "Bash(b)", "Bash(c)", "Bash(d)", "Bash(e)", "Bash(f)", "Bash(g)"];
    addByHand(extra);
    const first = scaffold("t.at");
    expect(named(first)).toEqual(extra.map((r) => line("allow", r)));
    const again = scaffold("t.at");
    expect(named(again)).toEqual([summary(...extra.map((r) => `allow ${r}`))]);
    expect(named(again)[0]).toContain('allow "Bash(e)" and 2 more;');
    expect(named(again)[0]).not.toContain("Bash(f)");
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

/** What prune and --dry-run print for settings.json instead of deleting it. */
const KEPT = `= ${SETTINGS} (kept: holds settings; delete it by hand if you want)`;
const lines = (out: { stdout: string; stderr: string }) => (out.stdout + out.stderr).split("\n").map((l) => l.trim());
/** Every file under root, by path. */
const paths = () => tree().split("\n").map((l) => l.split(" ")[0]);
/** Add a third agent c to a topology. */
const withC = (text: string) =>
  text.replace("  flow { a -> b }", '  agent c {\n    model: sonnet\n    description: "c"\n  }\n  flow { a -> b -> c }');

describe("[0.11.2-l] scaffold --prune never deletes .claude/settings.json", () => {
  it("[0.11.2-l] the topology this test drops to generates no settings.json (so 0.11.1 would plan a delete)", () => {
    expect(claudeCodeBinding.scaffold(parse(topo("t", ""))).map((f) => f.path)).not.toContain(SETTINGS);
  });

  it("[0.11.2-l] (a) --prune keeps settings.json, says so, and still deletes the other leftovers", () => {
    writeAt("t.at", withC(withAllow("t", [A, R])));
    expect(scaffold("t.at").status).toBe(0);
    const before = fs.readFileSync(at(SETTINGS), "utf8");
    const files = paths();
    writeAt("t.at", topo("t", ""));
    const out = scaffold("t.at", "--prune");
    expect(out.status, out.stderr).toBe(0);
    expect(fs.readFileSync(at(SETTINGS), "utf8")).toBe(before);
    expect(lines(out)).toContain(KEPT);
    expect(out.stdout).not.toContain(`- ${SETTINGS}`);
    // Prune still removes the files of the dropped agent, and only those.
    const gone = files.filter((f) => !fs.existsSync(at(f)));
    expect(gone.length).toBeGreaterThan(0);
    for (const f of gone) expect(f).toMatch(/(^|\/)c(\.md|\/)/);
    expect(out.stdout).toContain(`, ${gone.length} deleted`);
    // The file is still there, so its rules are named.
    expect(named(out)).toEqual([line("allow", A), line("allow", R)]);
    // A second prune keeps it too.
    const again = scaffold("t.at", "--prune");
    expect(lines(again)).toContain(KEPT);
    expect(fs.readFileSync(at(SETTINGS), "utf8")).toBe(before);
  });

  it("[0.11.2-l] (b) a settings.json that existed before the first scaffold is kept by --prune", () => {
    fs.mkdirSync(at(".claude"), { recursive: true });
    fs.writeFileSync(at(SETTINGS), JSON.stringify({ permissions: { allow: [U] }, env: { MINE: "1" } }, null, 2) + "\n");
    writeAt("t.at", withAllow("t", [A]));
    expect(scaffold("t.at").status).toBe(0);
    const before = fs.readFileSync(at(SETTINGS), "utf8");
    expect(JSON.parse(before).permissions.allow).toEqual(expect.arrayContaining([A, U]));
    writeAt("t.at", topo("t", ""));
    const out = scaffold("t.at", "--prune");
    expect(out.status, out.stderr).toBe(0);
    expect(lines(out)).toContain(KEPT);
    expect(fs.readFileSync(at(SETTINGS), "utf8")).toBe(before);
    expect(JSON.parse(before).env.MINE).toBe("1");
  });

  it("[0.11.2-l] (c) two topologies in one directory: each --prune keeps the shared settings.json", () => {
    writeAt("one.at", withAllow("one", [A, R]));
    writeAt("two.at", withAllow("two", [X]));
    expect(scaffold("one.at").status).toBe(0);
    expect(scaffold("two.at").status).toBe(0);
    const merged = fs.readFileSync(at(SETTINGS), "utf8");
    expect(JSON.parse(merged).permissions.allow).toEqual([A, R, X]);
    writeAt("two.at", topo("two", ""));
    const two = scaffold("two.at", "--prune");
    expect(two.status, two.stderr).toBe(0);
    expect(lines(two)).toContain(KEPT);
    expect(fs.readFileSync(at(SETTINGS), "utf8")).toBe(merged);
    writeAt("one.at", topo("one", ""));
    const one = scaffold("one.at", "--prune");
    expect(one.status, one.stderr).toBe(0);
    // two changed the file after one wrote it, so one sees an edited leftover
    // (kept, as in 0.11.1); either way it is never deleted.
    expect(lines(one)).toContain(`⊘ ${SETTINGS} (no longer generated, but edited — kept)`);
    expect(fs.readFileSync(at(SETTINGS), "utf8")).toBe(merged);
  });

  it("[0.11.2-l] (d) --dry-run, with and without --prune, says the same and writes nothing", () => {
    writeAt("t.at", withAllow("t", [A, R]));
    expect(scaffold("t.at").status).toBe(0);
    writeAt("t.at", topo("t", ""));
    const hash = tree();
    for (const more of [["--dry-run"], ["--dry-run", "--prune"]]) {
      const out = scaffold("t.at", ...more);
      expect(out.status, out.stderr).toBe(0);
      expect(lines(out)).toContain(KEPT);
      expect(out.stdout).not.toContain(`- ${SETTINGS}`);
    }
    expect(tree()).toBe(hash);
  });

  it("[0.11.2-l] the library plan never deletes settings.json, and executeActions refuses to", () => {
    writeAt("t.at", withAllow("t", [A, R]));
    expect(scaffold("t.at").status).toBe(0);
    const before = fs.readFileSync(at(SETTINGS), "utf8");
    const manifest = readManifest(root, "claude-code", "t.at");
    const actions = computeIncrementalPlan(root, "claude-code", claudeCodeBinding.scaffold(parse(topo("t", ""))), manifest);
    expect(actions.find((a) => a.path === SETTINGS)?.type).toBe("kept");
    const result = executeActions(root, [{ type: "delete", path: SETTINGS }], { prune: true, force: true });
    expect(result.removed).toEqual([]);
    expect(fs.readFileSync(at(SETTINGS), "utf8")).toBe(before);
  });
});

describe("[0.11.2-m] rule text cannot forge or erase output lines", () => {
  const FORGED = `${SETTINGS} allow "Read": forged`;
  const NL = `Bash(x)\n${FORGED}`;
  const ESC = "Bash(\u001b[2K\u001b[1Aerase)";

  for (const [label, run] of [["scaffold", scaffold], ["guard --target claude-code", guard]] as const) {
    it(`[0.11.2-m] ${label}: a rule with a newline or an escape sequence prints as one JSON string`, () => {
      writeAt("t.at", withAllow("t", [R]));
      expect(run("t.at").status).toBe(0);
      addByHand([NL, ESC]);
      const first = run("t.at");
      const second = run("t.at");
      for (const out of [first, second]) {
        expect(out.status, out.stderr).toBe(0);
        expect(out.stdout + out.stderr).not.toContain("\u001b");
        expect(lines(out)).not.toContain(FORGED);
      }
      expect(named(first)).toEqual([
        `${SETTINGS} allow "Bash(x)\\n${SETTINGS} allow \\"Read\\": forged": still in effect; the .at does not declare it — remove it if you didn't add it by hand`,
        `${SETTINGS} allow "Bash(\\u001b[2K\\u001b[1Aerase)": still in effect; the .at does not declare it — remove it if you didn't add it by hand`,
      ]);
      expect(named(second)).toEqual([
        `2 rules in ${SETTINGS} aren't declared in the .at: allow ${JSON.stringify(NL)}, allow ${JSON.stringify(ESC)}; declare them in the .at to keep them, or remove them`,
      ]);
    });
  }
});

describe("[0.11.2-n] exactly one undeclared rule reads in the singular", () => {
  it("[0.11.2-n] the summary says 1 rule … isn't … declare it … keep it, or remove it", () => {
    writeAt("t.at", withAllow("t", [R]));
    scaffold("t.at");
    addByHand([U]);
    expect(named(scaffold("t.at"))).toEqual([line("allow", U)]);
    expect(named(scaffold("t.at"))).toEqual([
      `1 rule in ${SETTINGS} isn't declared in the .at: allow "Bash(git status)"; declare it in the .at to keep it, or remove it`,
    ]);
  });
});

describe("[0.11.2-o] a settings.json whose root is not an object is a one-line error", () => {
  for (const [raw, kind] of [["[]", "an array"], ['"x"', "a string"], ["3", "a number"], ["null", "null"]] as const) {
    for (const [label, run] of [["scaffold", scaffold], ["guard --target claude-code", guard]] as const) {
      it(`[0.11.2-o] ${label}: root ${raw} exits 1 and writes nothing`, () => {
        writeAt("t.at", withAllow("t", [A, R]));
        fs.mkdirSync(at(".claude"), { recursive: true });
        fs.writeFileSync(at(SETTINGS), raw);
        const hash = tree();
        const out = run("t.at");
        expect(out.status).toBe(1);
        const err = out.stderr.trim().split("\n");
        expect(err).toEqual([`Error: ${SETTINGS} is not a JSON object (its root is ${kind}). Nothing was written.`]);
        expect(tree()).toBe(hash);
      });
    }
  }
});

describe("[0.11.2] the CHANGELOG cites the Codex docs by their public URL only", () => {
  it("[0.11.2-k] the Unreleased section names the URL, and no file name or line number", () => {
    const log = fs.readFileSync(resolve(here, "../../../CHANGELOG.md"), "utf8");
    const unreleased = log.slice(log.indexOf("## [Unreleased]"), log.indexOf("## [0.11.1]"));
    expect(unreleased).toContain("https://learn.chatgpt.com/docs/agent-configuration/rules.md");
    expect(unreleased).not.toMatch(/codex-rules\.md|line 65|rules\.md:\d/);
  });
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
