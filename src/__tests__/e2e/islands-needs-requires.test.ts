/**
 * Islands, needs { plugins }, meta { requires } and inventory { strict }.
 * HOME is always a temp dir; the real home is never read. The CLI is the built one.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { VERIFIED_ON } from "../../conformance/claude-code.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../../..");
const CLI = resolve(ROOT, "dist/cli/index.js");
const emptyBin = fs.mkdtempSync(join(os.tmpdir(), "at-isl-bin-"));
const fakeHome = fs.mkdtempSync(join(os.tmpdir(), "at-isl-home-"));

function cli(cwd: string, args: string[], home = fakeHome) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd, encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home, PATH: emptyBin, NO_COLOR: "1", AGENTOPOLOGY_CLAUDE_VERSION: VERIFIED_ON },
  });
  return { out: r.stdout, err: r.stderr, status: r.status, all: `${r.stdout}${r.stderr}` };
}

function project(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "at-isl-proj-"));
  for (const [p, c] of Object.entries(files)) {
    fs.mkdirSync(dirname(join(dir, p)), { recursive: true });
    fs.writeFileSync(join(dir, p), c);
  }
  return dir;
}

function topo(extra = "", meta = ""): string {
  return `topology t : [pipeline] {
  meta {
    version: "1.0.0"
    description: "t"
    ${meta}
  }
  orchestrator {
    model: sonnet
    handles: [work]
  }
  action work {
    kind: inline
    description: "do it"
  }
  ${extra}
}
`;
}

const ISLANDS = `
  person ana { away: "2026-01-01..2026-01-02" }
  inventory { roots: ["harness/"] strict: true }
  islands {
    island core {
      path: "harness/core/**"
      owner: ana
      test: "npm run test:core"
    }
  }
  needs { plugins: [alpha, beta] }
`;

describe("parse", () => {
  it("reads islands, needs plugins, meta requires and inventory strict", () => {
    const ast = parse(topo(ISLANDS, `requires: ">=0.1.0"`));
    expect(ast.islands).toEqual([{ id: "core", path: "harness/core/**", owner: "ana", test: "npm run test:core" }]);
    expect(ast.needs?.plugins).toEqual(["alpha", "beta"]);
    expect(ast.topology.requires).toBe(">=0.1.0");
    expect(ast.inventoryStrict).toBe(true);
  });
});

describe("validation", () => {
  it("V137: an island owner that is not a declared person is an error", () => {
    const ast = parse(topo(ISLANDS.replace("owner: ana", "owner: bob")));
    const r = validate(ast).filter((x) => x.rule === "V137");
    expect(r).toHaveLength(1);
    expect(r[0].level).toBe("error");
    expect(r[0].message).toContain("bob");
    expect(validate(parse(topo(ISLANDS))).filter((x) => x.rule === "V137")).toEqual([]);
  });

  it("V138: a requires that is not a version range is an error", () => {
    const bad = validate(parse(topo("", `requires: "banana"`))).filter((x) => x.rule === "V138");
    expect(bad).toHaveLength(1);
    expect(bad[0].level).toBe("error");
    for (const ok of [">=0.13.0", "^0.13.0", "<1.0.0", "=0.13.0", ">0.1.0", "<=2.0.0"])
      expect(validate(parse(topo("", `requires: "${ok}"`))).filter((x) => x.rule === "V138"), ok).toEqual([]);
  });
});

describe("meta requires against the running version", () => {
  const pkg = JSON.parse(fs.readFileSync(join(ROOT, "package.json"), "utf8")).version as string;
  const mismatch = `>=${Number(pkg.split(".")[0]) + 1}.0.0`;
  const dir = project({ "a.at": topo("", `requires: "${mismatch}"`), "ok.at": topo("", `requires: ">=0.1.0"`) });
  it.each([
    ["validate", ["validate", "a.at"]],
    ["guard --check", ["guard", "a.at", "--check"]],
    ["scaffold --dry-run", ["scaffold", "a.at", "--target", "claude-code", "--dry-run"]],
    ["fix", ["fix", "a.at"]],
  ])("%s exits 1 and says what is required", (_n, args) => {
    const r = cli(dir, args);
    expect(r.status).toBe(1);
    expect(r.all).toContain("requires");
    expect(r.all).toContain(mismatch);
    expect(r.all).toContain(pkg);
  });
  it("a satisfied range runs as before", () => {
    expect(cli(dir, ["validate", "ok.at"]).all).not.toMatch(/requires/);
  });
});

describe("validate --inventory with islands", () => {
  const files = {
    "harness/core/a.txt": "a", "harness/core/sub/b.txt": "b", "harness/other/c.txt": "c",
    "t.at": topo(ISLANDS),
  };
  it("counts island files as accounted for, lists the island with its owner, and strict exits 1 on unmapped", () => {
    const dir = project(files);
    const r = cli(dir, ["validate", "t.at", "--inventory", dir]);
    expect(r.all).toMatch(/island core/);
    expect(r.all).toContain("ana");
    expect(r.all).not.toContain("file:harness/core/a.txt");
    expect(r.all).not.toContain("file:harness/core/sub/b.txt");
    expect(r.all).toContain("file:harness/other/c.txt");
    expect(r.status).toBe(1);
  });
  it("without strict the same unmapped file is listed and the exit is 0", () => {
    const dir = project({ ...files, "t.at": topo(ISLANDS.replace(" strict: true", "")) });
    const r = cli(dir, ["validate", "t.at", "--inventory", dir]);
    expect(r.all).toContain("file:harness/other/c.txt");
    expect(r.status).toBe(0);
  });
  it("strict exits 0 when every live file is mapped", () => {
    const dir = project({ ...files, "harness/other/c.txt": "c", "t.at": topo(ISLANDS.replace("harness/core/**", "harness/**")) });
    expect(cli(dir, ["validate", "t.at", "--inventory", dir]).status).toBe(0);
  });
});

describe("needs plugins with --user", () => {
  it("reports each plugin installed or missing from ~/.claude/plugins", () => {
    const home = fs.mkdtempSync(join(os.tmpdir(), "at-isl-home2-"));
    fs.mkdirSync(join(home, ".claude/plugins"), { recursive: true });
    fs.writeFileSync(join(home, ".claude/plugins/installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "alpha@market": [{ scope: "user" }] } }));
    const dir = project({ "t.at": topo(ISLANDS.replace(" strict: true", "")) });
    const r = cli(dir, ["validate", "t.at", "--inventory", dir, "--user"], home);
    expect(r.all).toMatch(/plugin alpha\s+installed/);
    expect(r.all).toMatch(/plugin beta\s+missing/);
  });
  it("without --user the plugins are only listed as declared", () => {
    const dir = project({ "t.at": topo(ISLANDS.replace(" strict: true", "")) });
    const r = cli(dir, ["validate", "t.at", "--inventory", dir]);
    expect(r.all).toMatch(/plugin alpha/);
    expect(r.all).not.toMatch(/plugin alpha\s+(installed|missing)/);
  });
});

describe("guard --check lists an island's test command", () => {
  it("prints it and does not run it", () => {
    const dir = project({ "t.at": topo(ISLANDS.replace("npm run test:core", "touch ran-marker")) });
    const r = cli(dir, ["guard", "t.at", "--check", "--dir", dir]);
    expect(r.all).toContain("island core");
    expect(r.all).toContain("touch ran-marker");
    expect(fs.existsSync(join(dir, "ran-marker"))).toBe(false);
  });
});
