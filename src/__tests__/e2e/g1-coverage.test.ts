/**
 * [T08] [L4] coverage of what a run really reads, and state outside the repo.
 * HOME is always pointed at a temp dir; the real home is never read.
 * The CLI is the built one (global setup builds it).
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { resolve, dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { VERIFIED_ON } from "../../conformance/claude-code.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../../..");
const CLI = resolve(ROOT, "dist/cli/index.js");
const PIN = resolve(here, "fixtures/inv-pin");
const emptyBin = fs.mkdtempSync(join(os.tmpdir(), "at-g1-bin-"));
const fakeHome = fs.mkdtempSync(join(os.tmpdir(), "at-g1-home-"));

function cli(cwd: string, args: string[], home = fakeHome) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd, encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home, PATH: emptyBin, NO_COLOR: "1", AGENTOPOLOGY_CLAUDE_VERSION: VERIFIED_ON },
  });
  return { out: r.stdout, err: r.stderr, status: r.status, all: `${r.stdout}${r.stderr ? "--- stderr\n" + r.stderr : ""}--- exit ${r.status}\n` };
}

function project(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "at-g1-proj-"));
  for (const [p, c] of Object.entries(files)) {
    fs.mkdirSync(dirname(join(dir, p)), { recursive: true });
    fs.writeFileSync(join(dir, p), c);
  }
  return dir;
}

const examples = fs.readdirSync(join(ROOT, "examples")).filter((f) => f.endsWith(".at")).map((f) => join("examples", f));
describe("[T08] one file keeps today's validate --inventory output", () => {
  const proj = resolve(here, "fixtures/handbuilt");
  for (const f of examples) {
    it(`[T08] validate --inventory ${f}`, async () => {
      const abs = join(ROOT, f);
      const out = cli(ROOT, ["validate", f, "--inventory", proj]).all.replaceAll(abs, f).replaceAll(proj, "<proj>").replace(/^checked against Claude Code .*$/m, "<version line>");
      await expect(out).toMatchFileSnapshot(join(PIN, `${basename(f, ".at")}.txt`));
    });
  }
});

import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { serializeAST } from "../../import/serializer.js";
import { collectInventory as collect, coverage, type CollectOptions } from "../../inventory/index.js";

/** In-process collection never touches the real machine: no LaunchAgents folder, no crontab, a temp home. */
const collectInventory = (dir: string, o: CollectOptions = {}) =>
  collect(dir, { launchAgentsDir: join(fakeHome, "none"), crontab: "", home: fakeHome, ...o });

const topo = (extra: string, body = "") => `topology t : [pipeline] {
  meta { version: "1.0.0"
    description: "g1" }
${extra}
  agent a {
    model: sonnet
    description: "a"
${body}
  }
  agent b {
    model: sonnet
    description: "b"
  }
  flow { a -> b }
}`;
const hookAt = (roots: string, run = "python3 harness/lock/hook.py") => topo(
  `  inventory { roots: ${roots} }
  hooks {
    hook lock { on: PreToolUse
      matcher: "Bash"
      run: "${run}" }
  }`);
const lockProject = () => project({ "harness/lock/hook.py": "print(1)\n", "harness/lock/yes.py": "print(2)\n" });
const rule = (src: string, id: string) => validate(parse(src)).filter((r) => r.rule === id);

describe("[T08] inventory roots: grammar", () => {
  it("[T08] parses roots and round-trips", () => {
    const ast = parse(hookAt('["harness/", "scripts/"]'));
    expect(ast.inventoryRoots).toEqual(["harness/", "scripts/"]);
    const again = parse(serializeAST(ast));
    expect(again.inventoryRoots).toEqual(["harness/", "scripts/"]);
  });
  it("[T08] an absolute root or one with .. is a validate error (V128)", () => {
    expect(rule(hookAt('["/etc/"]'), "V128")).toHaveLength(1);
    expect(rule(hookAt('["../x/"]'), "V128")).toHaveLength(1);
    expect(rule(hookAt('["a/../../x"]'), "V128")).toHaveLength(1);
    expect(rule(hookAt('["harness/", "scripts/"]'), "V128")).toHaveLength(0);
  });
});

describe("[T08] inventory roots: listing", () => {
  it("[T08] collectInventory lists every file under the roots, kind file", () => {
    const dir = lockProject();
    const items = collectInventory(dir, { roots: ["harness/"] });
    const files = items.filter((i) => i.kind === "file");
    expect(files.map((i) => i.path).sort()).toEqual(["harness/lock/hook.py", "harness/lock/yes.py"]);
    expect(files[0].fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(collectInventory(dir).filter((i) => i.kind === "file")).toEqual([]);
  });
  it("[T08] a root that does not exist is reported as missing", () => {
    const dir = lockProject();
    const ast = parse(hookAt('["harness/", "scripts/"]'));
    const r = coverage(ast, collectInventory(dir, { roots: ast.inventoryRoots }), dir);
    expect(r.missing.map((m) => m.path)).toContain("scripts/");
    expect(r.missing.map((m) => m.path)).not.toContain("harness/");
  });
  it("[T08] inventory --at lists the declared roots; plain inventory does not", () => {
    const dir = lockProject();
    fs.writeFileSync(join(dir, "a.at"), hookAt('["harness/"]'));
    const withAt = JSON.parse(cli(dir, ["inventory", dir, "--at", join(dir, "a.at")]).out);
    expect(withAt.items.filter((i: any) => i.kind === "file")).toHaveLength(2);
    const plain = JSON.parse(cli(dir, ["inventory", dir]).out);
    expect(plain.items.filter((i: any) => i.kind === "file")).toHaveLength(0);
  });
});

describe("[T08] planted: harness/lock", () => {
  it("[T08] one .at maps one of two files; a second .at makes the union 100%", () => {
    const dir = lockProject();
    const a = join(dir, "a.at"), b = join(dir, "b.at");
    fs.writeFileSync(a, hookAt('["harness/"]'));
    fs.writeFileSync(b, hookAt('["harness/"]', "python3 harness/lock/yes.py"));
    const one = cli(dir, ["validate", a, "--inventory", dir]).out;
    expect(one).toContain("harness/lock/yes.py");
    expect(one).toMatch(/file:harness\/lock\/yes\.py/);
    expect(one).not.toMatch(/unmapped[^\n]*\n(?:[^\n]*\n)*?\s+file:harness\/lock\/hook\.py/);
    expect(one).toMatch(/1 of 2 live things/);
    const both = cli(dir, ["validate", "--inventory", dir, a, b]);
    expect(both.out).toMatch(/a\.at[^\n]*1 of 2/);
    expect(both.out).toMatch(/b\.at[^\n]*1 of 2/);
    const lines = both.out.split("\n");
    const union = lines.findIndex((l) => /union/.test(l) && /2 of 2/.test(l) && /100%/.test(l));
    expect(union).toBeGreaterThan(-1);
    expect(lines.findIndex((l) => /a\.at[^\n]*1 of 2/.test(l))).toBeLessThan(union);
    expect(both.out).toMatch(/harness\/[^\n]*2 of 2/);
    expect(both.status).toBe(0);
  });
});

describe("[T08] --user", () => {
  it("[T08] lists the user-level tree, tagged and counted apart; never reads the real home", () => {
    const dir = lockProject();
    const home = fs.mkdtempSync(join(os.tmpdir(), "at-g1-uh-"));
    for (const [p, c] of Object.entries({
      ".claude/agents/helper.md": "x", ".claude/skills/sk/SKILL.md": "x", ".claude/commands/go.md": "x",
      ".claude/settings.json": JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo hi" }] }] } }),
      ".claude/projects/ignored.md": "x",
    })) { fs.mkdirSync(dirname(join(home, p)), { recursive: true }); fs.writeFileSync(join(home, p), c); }
    const items = collectInventory(dir, { user: true, home });
    const user = items.filter((i) => i.scope === "user");
    expect(user.map((i) => i.id).sort()).toEqual(["user:agent:helper", "user:command:go", "user:hook:Stop echo hi", "user:skill:sk"]);
    expect(items.filter((i) => i.scope !== "user").length).toBe(0);
    const ast = parse(hookAt('["harness/"]'));
    const r = coverage(ast, collectInventory(dir, { user: true, home, roots: ["harness/"] }), dir, { home });
    expect(r.total).toBe(2);
    expect(r.user?.total).toBe(4);
    fs.writeFileSync(join(dir, "a.at"), hookAt('["harness/"]'));
    const out = cli(dir, ["validate", join(dir, "a.at"), "--inventory", dir, "--user"], home).out;
    expect(out).toMatch(/user-level: 0 of 4/);
    expect(out).toMatch(/coverage: 1 of 2/);
    const noUser = cli(dir, ["validate", join(dir, "a.at"), "--inventory", dir], home).out;
    expect(noUser).not.toMatch(/user-level/);
    const inv = JSON.parse(cli(dir, ["inventory", dir, "--user"], home).out);
    expect(inv.items.filter((i: any) => i.scope === "user")).toHaveLength(4);
  });
});

const needsAt = (needs: string) => topo(`  needs {\n${needs}\n  }`);
const NEEDS = `    memory: "~/notes/mem"
    connectors: [gmail, calendar]
    user-skills: [writer, ghost]`;

describe("[L4] needs outside the repo: grammar", () => {
  it("[L4] parses memory, connectors and user-skills", () => {
    const ast = parse(needsAt(NEEDS));
    expect(ast.needs).toEqual({ memory: "~/notes/mem", connectors: ["gmail", "calendar"], userSkills: ["writer", "ghost"] });
  });
  it("[L4] parses the fields on one line", () => {
    const ast = parse(needsAt(`    memory: "~/m"  connectors: [gmail]  user-skills: [writer]`));
    expect(ast.needs).toEqual({ memory: "~/m", connectors: ["gmail"], userSkills: ["writer"] });
  });
  it("[L4] round-trips through the serializer", () => {
    const ast = parse(needsAt(NEEDS));
    const text = serializeAST(ast);
    expect(parse(text).needs).toEqual(ast.needs);
    expect(serializeAST(parse(text))).toBe(text);
  });
  it("[L4] an absolute or .. memory path, or a path as a skill name, is a validate error (V129)", () => {
    expect(rule(needsAt(`    memory: "/etc/passwd"`), "V129")).toHaveLength(1);
    expect(rule(needsAt(`    memory: "~/../x"`), "V129")).toHaveLength(1);
    expect(rule(needsAt(`    user-skills: ["a/b"]`), "V129")).toHaveLength(1);
    expect(rule(needsAt(NEEDS), "V129")).toHaveLength(0);
  });
});

describe("[L4] needs outside the repo: validate", () => {
  it("[L4] validate lists them as declared outside the repo", () => {
    const dir = project({ "n.at": needsAt(NEEDS) });
    const out = cli(dir, ["validate", join(dir, "n.at")]).out;
    expect(out).toContain("declared outside the repo");
    expect(out).toMatch(/memory ~\/notes\/mem/);
    expect(out).toMatch(/connector gmail/);
    expect(out).toMatch(/user-skill writer/);
  });
  it("[L4] --inventory --user: a user skill and memory path that exist are mapped, one that does not is missing, connectors are never checked", () => {
    const dir = project({ "n.at": needsAt(NEEDS) });
    const home = fs.mkdtempSync(join(os.tmpdir(), "at-g1-lh-"));
    fs.mkdirSync(join(home, ".claude/skills/writer"), { recursive: true });
    fs.writeFileSync(join(home, ".claude/skills/writer/SKILL.md"), "x");
    fs.mkdirSync(join(home, "notes/mem"), { recursive: true });
    const r = cli(dir, ["validate", join(dir, "n.at"), "--inventory", dir, "--user"], home);
    expect(r.out).toMatch(/memory ~\/notes\/mem\s+mapped/);
    expect(r.out).toMatch(/user-skill writer\s+mapped/);
    expect(r.out).toMatch(/user-skill ghost\s+missing/);
    expect(r.out).toMatch(/connector gmail\s+not checked \(account connector\)/);
    expect(r.out).toMatch(/connector calendar\s+not checked \(account connector\)/);
    expect(r.out).not.toMatch(/connector \w+\s+mapped/);
    expect(r.status).toBe(1); // ghost is missing
    // the declared skill is mapped in the user-level count, not unmapped
    expect(r.out).toMatch(/user-level: 1 of 1/);
  });
  it("[L4] a declared memory path that does not exist is missing", () => {
    const dir = project({ "n.at": needsAt(`    memory: "~/notes/mem"`) });
    const home = fs.mkdtempSync(join(os.tmpdir(), "at-g1-lh2-"));
    const r = cli(dir, ["validate", join(dir, "n.at"), "--inventory", dir, "--user"], home);
    expect(r.out).toMatch(/memory ~\/notes\/mem\s+missing/);
    expect(r.status).toBe(1);
  });
  it("[L4] without --user nothing is read from the home folder", () => {
    const dir = project({ "n.at": needsAt(NEEDS) });
    const home = fs.mkdtempSync(join(os.tmpdir(), "at-g1-lh3-"));
    const r = cli(dir, ["validate", join(dir, "n.at"), "--inventory", dir], home);
    expect(r.out).not.toMatch(/missing|mapped\n/);
    expect(r.out).toMatch(/user-skill ghost/);
    expect(r.status).toBe(0);
  });
});
