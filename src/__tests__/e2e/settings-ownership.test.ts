/**
 * T6 (S-37, S-48): scaffold owns the permission rules it added to
 * .claude/settings.json, and removes an owned rule once the .at no longer
 * declares it. Scaffold never owns what it did not add, so a rule the user
 * (or another topology) put there first is never removed; the 0.11.2 notice
 * still names it.
 *
 * Runs the built CLI in temp dirs, like settings-undeclared.test.ts.
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
import { readManifest } from "../../scaffold/manifest.js";
import { computeIncrementalPlan } from "../../scaffold/incremental.js";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, "../../../dist/cli/index.js");
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
const list = (rules: string[]) => `[${rules.map((r) => JSON.stringify(r)).join(", ")}]`;
const withRules = (name: string, allow: string[], more = "") =>
  topo(name, `  settings {\n    allow: ${list(allow)}\n${more}  }`);

const A = "Bash(ls *)";
const R = "Read";
const U = "Bash(git status)";
const D = "Bash(rm -rf *)";
const X = "Grep";
const N = "Bash(npm test)";

function writeAt(file: string, text: string): void {
  fs.writeFileSync(at(file), text);
}
function cli(args: string[], cwd = root) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
const scaffold = (file: string, ...more: string[]) => cli(["scaffold", file, "--target", "claude-code", ...more]);
const guard = (file: string, ...more: string[]) => cli(["guard", file, "--target", "claude-code", ...more]);

const lines = (out: { stdout: string; stderr: string }) => (out.stdout + out.stderr).split("\n").map((l) => l.trim());
/** The 0.11.2 undeclared lines (list or summary). */
const named = (out: { stdout: string; stderr: string }) =>
  lines(out).filter((l) => l.includes("the .at does not declare it") || l.includes("declared in the .at:"));
/** The T6 removal lines. */
const removedLines = (out: { stdout: string; stderr: string }) =>
  lines(out).filter((l) => l.includes(": removed; the .at no longer declares it") || l.includes("; the .at changed it"));
const removed = (l: string, rule: string) => `${SETTINGS} ${l} ${JSON.stringify(rule)}: removed; the .at no longer declares it`;
const undeclared = (l: string, rule: string) =>
  `${SETTINGS} ${l} ${JSON.stringify(rule)}: still in effect; the .at does not declare it — remove it if you didn't add it by hand`;

const perms = () => JSON.parse(fs.readFileSync(at(SETTINGS), "utf8")).permissions ?? {};
const manifestOf = (file = MANIFEST) => JSON.parse(fs.readFileSync(at(file), "utf8"));
const ownedEntry = (file = MANIFEST) => manifestOf(file).files[SETTINGS];

function addByHand(allow: string[], deny: string[] = []): void {
  const s = JSON.parse(fs.readFileSync(at(SETTINGS), "utf8"));
  s.permissions = s.permissions ?? {};
  s.permissions.allow = [...(s.permissions.allow ?? []), ...allow];
  if (deny.length) s.permissions.deny = [...(s.permissions.deny ?? []), ...deny];
  fs.writeFileSync(at(SETTINGS), JSON.stringify(s, null, 2) + "\n");
}
function removeByHand(rule: string): void {
  const s = JSON.parse(fs.readFileSync(at(SETTINGS), "utf8"));
  s.permissions.allow = s.permissions.allow.filter((r: string) => r !== rule);
  fs.writeFileSync(at(SETTINGS), JSON.stringify(s, null, 2) + "\n");
}
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

beforeEach(() => {
  root = fs.mkdtempSync(join(os.tmpdir(), "at-owned-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("[OWN1] an owned rule the .at drops is removed; the user's rules stay", () => {
  it("[OWN1] drop A: A removed and named as removed; U (by hand) kept and named as undeclared", () => {
    writeAt("t.at", withRules("t", [A, R]));
    expect(scaffold("t.at").status).toBe(0);
    expect(ownedEntry().rulesOwned).toEqual({ allow: [A, R] });
    addByHand([U], [D]);
    writeAt("t.at", withRules("t", [R]));
    const out = scaffold("t.at");
    expect(out.status, out.stderr).toBe(0);
    expect(removedLines(out)).toEqual([removed("allow", A)]);
    expect(perms().allow).toEqual([R, U]);
    expect(perms().deny).toEqual([D]);
    expect(named(out)).toEqual([undeclared("allow", U), undeclared("deny", D)]);
    expect(ownedEntry().rulesOwned).toEqual({ allow: [R] });
    // The next run removes nothing more and prints no removal.
    const again = scaffold("t.at");
    expect(removedLines(again)).toEqual([]);
    expect(perms().allow).toEqual([R, U]);
  });

  it("[OWN1] the .at drops its whole settings block: owned rules removed, the file kept, the user's rule stays", () => {
    writeAt("t.at", withRules("t", [A, R]));
    scaffold("t.at");
    addByHand([U]);
    writeAt("t.at", topo("t", ""));
    const out = scaffold("t.at", "--prune");
    expect(out.status, out.stderr).toBe(0);
    expect(fs.existsSync(at(SETTINGS))).toBe(true);
    expect(removedLines(out)).toEqual([removed("allow", A), removed("allow", R)]);
    expect(perms().allow).toEqual([U]);
    expect(named(out)).toEqual([undeclared("allow", U)]);
    expect(ownedEntry().rulesOwned).toBeUndefined();
  });

  it("[OWN1] guard --target claude-code removes the same rule and prints the same line", () => {
    writeAt("t.at", withRules("t", [A, R]));
    guard("t.at");
    addByHand([U]);
    writeAt("t.at", withRules("t", [R]));
    const out = guard("t.at");
    expect(out.status, out.stderr).toBe(0);
    expect(removedLines(out)).toEqual([removed("allow", A)]);
    expect(perms().allow).toEqual([R, U]);
  });
});

describe("[OWN1] the manager's question: a hand-added rule with the text of one we owned", () => {
  it("(a) we owned X, removed it; the user then adds X by hand: KEPT, never owned again, named as undeclared", () => {
    writeAt("t.at", withRules("t", [X, R]));
    scaffold("t.at");
    writeAt("t.at", withRules("t", [R]));
    expect(removedLines(scaffold("t.at"))).toEqual([removed("allow", X)]);
    addByHand([X]);
    const out = scaffold("t.at");
    expect(removedLines(out)).toEqual([]);
    expect(perms().allow).toEqual([R, X]);
    expect(named(out)).toEqual([undeclared("allow", X)]);
    expect(ownedEntry().rulesOwned).toEqual({ allow: [R] });
    // Even when the .at declares X again and then drops it, X stays: it was there first.
    writeAt("t.at", withRules("t", [R, X]));
    scaffold("t.at");
    expect(ownedEntry().rulesOwned).toEqual({ allow: [R] });
    writeAt("t.at", withRules("t", [R]));
    const last = scaffold("t.at");
    expect(removedLines(last)).toEqual([]);
    expect(perms().allow).toEqual([R, X]);
  });

  it("(b) X was in the file before the first scaffold and the .at declares it: never owned; dropped -> KEPT and named", () => {
    fs.mkdirSync(at(".claude"), { recursive: true });
    fs.writeFileSync(at(SETTINGS), JSON.stringify({ permissions: { allow: [X] } }, null, 2) + "\n");
    writeAt("t.at", withRules("t", [X, R]));
    scaffold("t.at");
    expect(ownedEntry().rulesOwned).toEqual({ allow: [R] });
    writeAt("t.at", withRules("t", [R]));
    const out = scaffold("t.at");
    expect(removedLines(out)).toEqual([]);
    expect(perms().allow).toEqual([X, R]);
    expect(named(out)).toEqual([undeclared("allow", X)]);
  });

  it("(c) we own X and the user's edit leaves X in the file: dropped -> REMOVED, and printed (the one lost hand intent)", () => {
    writeAt("t.at", withRules("t", [X, R]));
    scaffold("t.at");
    // The user rewrites the file by hand, keeping X (indistinguishable from ours).
    const s = JSON.parse(fs.readFileSync(at(SETTINGS), "utf8"));
    s.permissions.allow = [U, X, R];
    fs.writeFileSync(at(SETTINGS), JSON.stringify(s, null, 4) + "\n");
    writeAt("t.at", withRules("t", [R]));
    const out = scaffold("t.at");
    expect(removedLines(out)).toEqual([removed("allow", X)]);
    expect(perms().allow).toEqual([U, R]);
  });
});

describe("[S-48] two topologies in one directory", () => {
  const par = () => withRules("par", [A, R, U], `    deny: ${list([D])}\n`);
  const two = () => withRules("two", [X]);

  it("neither names the other's owned rules as undeclared, and neither removes them", () => {
    writeAt("par.at", par());
    writeAt("two.at", two());
    expect(named(scaffold("par.at"))).toEqual([]);
    const t = scaffold("two.at");
    expect(named(t)).toEqual([]);
    expect(removedLines(t)).toEqual([]);
    const p = scaffold("par.at");
    expect(named(p)).toEqual([]);
    expect(removedLines(p)).toEqual([]);
    expect(perms().allow).toEqual([A, R, U, X]);
    expect(perms().deny).toEqual([D]);
    expect(ownedEntry().rulesOwned).toEqual({ allow: [A, R, U], deny: [D] });
    expect(ownedEntry(".claude/.scaffold-manifest.two.at.json").rulesOwned).toEqual({ allow: [X] });
  });

  it("each removes only its own dropped rule", () => {
    writeAt("par.at", par());
    writeAt("two.at", two());
    scaffold("par.at");
    scaffold("two.at");
    writeAt("two.at", withRules("two", []));
    const t = scaffold("two.at");
    expect(removedLines(t)).toEqual([removed("allow", X)]);
    expect(perms().allow).toEqual([A, R, U]);
    writeAt("par.at", withRules("par", [R, U], `    deny: ${list([D])}\n`));
    const p = scaffold("par.at");
    expect(removedLines(p)).toEqual([removed("allow", A)]);
    expect(perms().allow).toEqual([R, U]);
  });

  it("a rule nobody owns is still named, by each topology", () => {
    writeAt("par.at", par());
    writeAt("two.at", two());
    scaffold("par.at");
    scaffold("two.at");
    addByHand([N]);
    expect(named(scaffold("par.at"))).toEqual([undeclared("allow", N)]);
    expect(named(scaffold("two.at"))).toEqual([undeclared("allow", N)]);
  });
});

const kept = (l: string, rule: string, by: string) => `${SETTINGS} ${l} ${JSON.stringify(rule)}: kept; ${by} declares it`;
const keptLines = (out: { stdout: string; stderr: string }) =>
  lines(out).filter((l) => l.includes(": kept; ") || l.includes("rule ownership skipped") || l.includes("re-scaffold"));

describe("[OWN2] a rule another topology declares is never removed", () => {
  it("par owns X, two declares X; par drops X: kept and printed, still par's; two drops X too; par's next run removes it", () => {
    writeAt("par.at", withRules("par", [X, R]));
    writeAt("two.at", withRules("two", [X]));
    scaffold("par.at");
    scaffold("two.at");
    expect(ownedEntry().rulesOwned).toEqual({ allow: [X, R] });
    expect(ownedEntry(".claude/.scaffold-manifest.two.at.json").rulesOwned).toBeUndefined();
    writeAt("par.at", withRules("par", [R]));
    const p = scaffold("par.at");
    expect(removedLines(p)).toEqual([]);
    expect(keptLines(p)).toEqual([kept("allow", X, "two.at")]);
    expect(named(p)).toEqual([]);
    expect(perms().allow).toEqual([X, R]);
    expect(ownedEntry().rulesOwned).toEqual({ allow: [X, R] });
    writeAt("two.at", withRules("two", [U]));
    scaffold("two.at");
    expect(perms().allow).toContain(X);
    const again = scaffold("par.at");
    expect(removedLines(again)).toEqual([removed("allow", X)]);
    expect(perms().allow).not.toContain(X);
    expect(ownedEntry().rulesOwned).toEqual({ allow: [R] });
  });

  it("the same for defaultMode: another topology declaring the value keeps it", () => {
    const mode = (name: string, m: string | null) => topo(name, `  settings {\n    allow: [Read]\n${m ? `    default-mode: ${m}\n` : ""}  }`);
    writeAt("par.at", mode("par", "plan"));
    writeAt("two.at", mode("two", "plan"));
    scaffold("par.at");
    scaffold("two.at");
    writeAt("par.at", mode("par", null));
    const p = scaffold("par.at");
    expect(perms().defaultMode).toBe("plan");
    expect(keptLines(p)).toEqual([`${SETTINGS} defaultMode "plan": kept; two.at declares it`]);
    expect(ownedEntry().defaultModeOwned).toBe("plan");
  });

  it("a manifest from before this change (no rulesDeclared) holds every removal, named once, until it is re-scaffolded", () => {
    writeAt("par.at", withRules("par", [A, R]));
    writeAt("two.at", withRules("two", [X]));
    scaffold("par.at");
    scaffold("two.at");
    const twoPath = ".claude/.scaffold-manifest.two.at.json";
    const m = manifestOf(twoPath);
    delete m.files[SETTINGS].rulesDeclared;
    delete m.files[SETTINGS].defaultModeDeclared;
    fs.writeFileSync(at(twoPath), JSON.stringify(m, null, 2) + "\n");
    writeAt("par.at", withRules("par", [R]));
    const p = scaffold("par.at");
    expect(removedLines(p)).toEqual([]);
    expect(perms().allow).toContain(A);
    const held = keptLines(p);
    expect(held).toHaveLength(1);
    expect(held[0]).toContain(twoPath);
    expect(held[0]).toContain("re-scaffold two.at");
    expect(ownedEntry().rulesOwned).toEqual({ allow: [A, R] });
    scaffold("two.at");
    expect(removedLines(scaffold("par.at"))).toEqual([removed("allow", A)]);
  });

  it("records what each topology declares", () => {
    writeAt("t.at", withRules("t", [A, R], `    deny: ${list([D])}\n    default-mode: plan\n`));
    scaffold("t.at");
    expect(ownedEntry().rulesDeclared).toEqual({ allow: [A, R], deny: [D] });
    expect(ownedEntry().defaultModeDeclared).toBe("plan");
  });
});

describe("[OWN3] same-basename .at files sharing one manifest skip rule ownership", () => {
  const skipped = (other: string) => `${SETTINGS}: rule ownership skipped; the manifest also belongs to ${other}`;

  it("a/t.at then b/t.at: b owns nothing new, removes nothing, and says so; a carries on", () => {
    fs.mkdirSync(at("a"));
    fs.mkdirSync(at("b"));
    writeAt("a/t.at", withRules("t", [A, R]));
    writeAt("b/t.at", withRules("t", [X]));
    scaffold("a/t.at");
    expect(ownedEntry().sourcePath).toBe("a/t.at");
    const b = scaffold("b/t.at");
    expect(b.status, b.stderr).toBe(0);
    expect(removedLines(b)).toEqual([]);
    expect(keptLines(b)).toEqual([skipped("a/t.at")]);
    expect(perms().allow).toEqual([A, R, X]);
    // The entry is still a's: b took none of it.
    expect(ownedEntry().rulesOwned).toEqual({ allow: [A, R] });
    expect(ownedEntry().sourcePath).toBe("a/t.at");
    writeAt("a/t.at", withRules("t", [R]));
    const a = scaffold("a/t.at");
    expect(removedLines(a)).toEqual([removed("allow", A)]);
  });

  it("an entry that owns rules but records no sourcePath (written before it) skips too", () => {
    writeAt("t.at", withRules("t", [A, R]));
    scaffold("t.at");
    const m = manifestOf();
    delete m.files[SETTINGS].sourcePath;
    fs.writeFileSync(at(MANIFEST), JSON.stringify(m, null, 2) + "\n");
    writeAt("t.at", withRules("t", [R]));
    const out = scaffold("t.at");
    expect(removedLines(out)).toEqual([]);
    expect(perms().allow).toContain(A);
    expect(keptLines(out)).toEqual([skipped("an .at scaffolded before paths were recorded")]);
  });
});

describe("[OWN1] the 0.11.2 cadence still holds for rules nobody owns", () => {
  it("gain -> the list; nothing new -> the summary; none left -> silence", () => {
    writeAt("t.at", withRules("t", [R]));
    scaffold("t.at");
    addByHand([U]);
    expect(named(scaffold("t.at"))).toEqual([undeclared("allow", U)]);
    const sum = named(scaffold("t.at"));
    expect(sum).toHaveLength(1);
    expect(sum[0]).toContain("1 rule in .claude/settings.json isn't declared in the .at");
    removeByHand(U);
    expect(named(scaffold("t.at"))).toEqual([]);
  });
});

describe("[OWN1] prune and dry-run", () => {
  it("prune never deletes settings.json, even when every rule in it was owned and removed", () => {
    writeAt("t.at", withRules("t", [A]));
    scaffold("t.at");
    writeAt("t.at", topo("t", ""));
    const out = scaffold("t.at", "--prune");
    expect(out.status, out.stderr).toBe(0);
    expect(fs.existsSync(at(SETTINGS))).toBe(true);
    expect(removedLines(out)).toEqual([removed("allow", A)]);
    expect(perms().allow).toBeUndefined();
    expect(out.stdout).not.toContain(`- ${SETTINGS}`);
  });

  it("dry-run prints exactly the removal and notice lines the real run prints, and writes nothing", () => {
    writeAt("t.at", withRules("t", [A, R]));
    scaffold("t.at");
    addByHand([U]);
    writeAt("t.at", withRules("t", [R]));
    const hash = tree();
    const dry = scaffold("t.at", "--dry-run");
    expect(tree()).toBe(hash);
    const real = scaffold("t.at");
    expect(removedLines(dry)).toEqual([removed("allow", A)]);
    expect(removedLines(dry)).toEqual(removedLines(real));
    expect(named(dry)).toEqual(named(real));
  });

  it("the library plan carries the removal on the settings.json action", () => {
    writeAt("t.at", withRules("t", [A, R]));
    scaffold("t.at");
    const actions = computeIncrementalPlan(root, "claude-code", claudeCodeBinding.scaffold(parse(withRules("t", [R]))), readManifest(root, "claude-code", "t.at"));
    const s = actions.find((a) => a.path === SETTINGS) as { type: string; rules?: { removed: unknown[] } };
    expect(s.type).toBe("update");
    expect(s.rules?.removed).toEqual([{ kind: "removed", list: "allow", rule: A }]);
  });
});

describe("[OWN1] upgrade from a 0.11.2 manifest (no ownership recorded)", () => {
  it("owns nothing and removes nothing on the first run; owns only rules it adds from then on", () => {
    writeAt("t.at", withRules("t", [A, R]));
    scaffold("t.at");
    // What a 0.11.2 manifest looks like: no ownership fields.
    const m = manifestOf();
    delete m.files[SETTINGS].rulesOwned;
    delete m.files[SETTINGS].defaultModeOwned;
    fs.writeFileSync(at(MANIFEST), JSON.stringify(m, null, 2) + "\n");
    writeAt("t.at", withRules("t", [R, N]));
    const out = scaffold("t.at");
    expect(removedLines(out)).toEqual([]);
    expect(perms().allow).toEqual([A, R, N]);
    expect(named(out)).toEqual([undeclared("allow", A)]);
    expect(ownedEntry().rulesOwned).toEqual({ allow: [N] });
    writeAt("t.at", withRules("t", [R]));
    const next = scaffold("t.at");
    expect(removedLines(next)).toEqual([removed("allow", N)]);
    expect(perms().allow).toEqual([A, R]);
  });
});

describe("[OWN1] defaultMode: owned when scaffold wrote it, the user's when it was there first", () => {
  const withMode = (mode: string | null) => topo("t", `  settings {\n    allow: [Read]\n${mode ? `    default-mode: ${mode}\n` : ""}  }`);

  it("owned: changed in the .at -> replaced; dropped -> removed", () => {
    writeAt("t.at", withMode("plan"));
    scaffold("t.at");
    expect(perms().defaultMode).toBe("plan");
    expect(ownedEntry().defaultModeOwned).toBe("plan");
    writeAt("t.at", withMode("acceptEdits"));
    const changed = scaffold("t.at");
    expect(perms().defaultMode).toBe("acceptEdits");
    expect(removedLines(changed)).toEqual([`${SETTINGS} defaultMode "plan": replaced by "acceptEdits"; the .at changed it`]);
    writeAt("t.at", withMode(null));
    const dropped = scaffold("t.at");
    expect(perms().defaultMode).toBeUndefined();
    expect(removedLines(dropped)).toEqual([`${SETTINGS} defaultMode "acceptEdits": removed; the .at no longer declares it`]);
    expect(ownedEntry().defaultModeOwned).toBeUndefined();
  });

  it("pre-existing: the user's value is kept, never owned, never touched", () => {
    fs.mkdirSync(at(".claude"), { recursive: true });
    fs.writeFileSync(at(SETTINGS), JSON.stringify({ permissions: { defaultMode: "default" } }, null, 2) + "\n");
    writeAt("t.at", withMode("plan"));
    scaffold("t.at");
    expect(perms().defaultMode).toBe("default");
    expect(ownedEntry().defaultModeOwned).toBeUndefined();
    writeAt("t.at", withMode(null));
    const out = scaffold("t.at");
    expect(removedLines(out)).toEqual([]);
    expect(perms().defaultMode).toBe("default");
  });

  it("owned, then changed by the user: theirs from then on", () => {
    writeAt("t.at", withMode("plan"));
    scaffold("t.at");
    const s = JSON.parse(fs.readFileSync(at(SETTINGS), "utf8"));
    s.permissions.defaultMode = "default";
    fs.writeFileSync(at(SETTINGS), JSON.stringify(s, null, 2) + "\n");
    writeAt("t.at", withMode(null));
    const out = scaffold("t.at");
    expect(removedLines(out)).toEqual([]);
    expect(perms().defaultMode).toBe("default");
    expect(ownedEntry().defaultModeOwned).toBeUndefined();
  });
});
