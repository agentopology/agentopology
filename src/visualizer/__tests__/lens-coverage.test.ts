import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "../../parser/index.js";
import { VERIFIED_ON } from "../../conformance/claude-code.js";
import { generateVisualization } from "../index.js";
import { collectFacts } from "../facts.js";
import { drawPage } from "./vm-draw.js";

const ROOT = path.resolve(__dirname, "../../..");
const CLI = path.join(ROOT, "dist/cli/index.js");

const SRC = `topology cov : [pipeline] {
  meta {
    version: "1.0.0"
    description: "coverage lens"
  }
  inventory { roots: ["harness/"] }
  hooks {
    hook lock {
      on: PreToolUse
      matcher: "Bash"
      run: "python3 harness/lock/hook.py"
    }
    hook gone {
      on: PostToolUse
      matcher: "Bash"
      run: "python3 harness/lock/absent.py"
    }
  }
  agent a {
    model: sonnet
    description: "a"
  }
  agent b {
    model: sonnet
    description: "b"
  }
  flow { a -> b }
}`;

let proj: string, fakeHome: string, emptyBin: string, atFile: string;
let prevEnv: string | undefined;
beforeAll(() => {
  prevEnv = process.env.AGENTOPOLOGY_CLAUDE_VERSION;
  process.env.AGENTOPOLOGY_CLAUDE_VERSION = VERIFIED_ON;
  proj = fs.mkdtempSync(path.join(os.tmpdir(), "viz-cov-"));
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "viz-cov-home-"));
  emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), "viz-cov-bin-"));
  for (const f of ["harness/lock/hook.py", "harness/lock/yes.py", ".claude/commands/loose.md"]) {
    fs.mkdirSync(path.dirname(path.join(proj, f)), { recursive: true });
    fs.writeFileSync(path.join(proj, f), "x\n");
  }
  fs.mkdirSync(path.join(fakeHome, ".claude/skills/mine"), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, ".claude/skills/mine/SKILL.md"), "x\n");
  atFile = path.join(proj, "cov.at");
  fs.writeFileSync(atFile, SRC);
});
afterAll(() => {
  if (prevEnv === undefined) delete process.env.AGENTOPOLOGY_CLAUDE_VERSION;
  else process.env.AGENTOPOLOGY_CLAUDE_VERSION = prevEnv;
  for (const d of [proj, fakeHome, emptyBin]) fs.rmSync(d, { recursive: true, force: true });
});

const ast = parse(SRC);
const inv = () => ({ launchAgentsDir: path.join(fakeHome, "none"), crontab: "", home: fakeHome });
const page = (dir?: string, extra: Record<string, unknown> = {}) =>
  drawPage(generateVisualization(ast, { facts: collectFacts(ast, { source: SRC, dir, inventory: inv(), ...extra } as any) }));

function printed(args: string[]) {
  const r = spawnSync(process.execPath, [CLI, "validate", atFile, "--inventory", proj, ...args], {
    cwd: proj, encoding: "utf8",
    env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, PATH: emptyBin, NO_COLOR: "1", AGENTOPOLOGY_CLAUDE_VERSION: VERIFIED_ON },
  });
  return r.stdout;
}

describe("[VZ-9] the coverage lens", () => {
  it("[VZ-9] the numbers on the page equal the numbers validate --inventory prints", () => {
    const out = printed([]);
    const m = out.match(/coverage: (\d+) of (\d+) live things/)!;
    const missingN = Number(out.match(/missing \((\d+)\)/)?.[1] ?? 0);
    const unmappedN = Number(out.match(/unmapped \((\d+)\)/)?.[1] ?? 0);
    const cov = page(proj).read<any>("coverageModel()");
    expect(cov.checked).toBe(true);
    expect([cov.mapped, cov.total, cov.unmapped, cov.missing]).toEqual([Number(m[1]), Number(m[2]), unmappedN, missingN]);
    const root = out.match(/root (\S+): (\d+) of (\d+) files/)!;
    const r = cov.roots.find((x: any) => x.root === root[1]);
    expect([r.mapped, r.total]).toEqual([Number(root[2]), Number(root[3])]);
    expect(r.total).toBe(2);
    expect(r.mapped).toBe(1);
  });

  it("[VZ-9] by kind: mapped, unmapped and missing add up, and a click lists the items", () => {
    const p = page(proj);
    const cov = p.read<any>("coverageModel()");
    const sum = (k: "mapped" | "unmapped") => cov.kinds.reduce((a: number, x: any) => a + x[k].length, 0);
    expect(sum("mapped")).toBe(cov.mapped);
    expect(sum("unmapped")).toBe(cov.unmapped);
    expect(cov.kinds.reduce((a: number, x: any) => a + x.missing.length, 0)).toBe(cov.missing);
    expect(cov.kinds.find((x: any) => x.kind === "file").unmapped).toEqual(["file:harness/lock/yes.py"]);
    p.run("setCoverageFilter('file','unmapped')");
    const html = p.read<string>("renderCoverageView()");
    expect(html).toContain("harness/lock/yes.py");
    expect(html).toMatch(/class="cov-num unmapped on"[^>]*data-kind="file"/);
  });

  it("[VZ-9] missing pointers are listed with what points at them", () => {
    const cov = page(proj).read<any>("coverageModel()");
    const all = cov.kinds.flatMap((k: any) => k.missing);
    expect(all.some((x: string) => x.includes("harness/lock/absent.py") && x.includes("hook gone"))).toBe(true);
  });

  it("[VZ-9] with no project dir the lens reads not checked", () => {
    const p = page();
    expect(p.read<any>("coverageModel()").checked).toBe(false);
    expect(p.read<string>("renderCoverageView()")).toContain("not checked");
    expect(p.read<string>("renderCoverageView()")).not.toContain("cov-card");
  });

  it("[VZ-9] the user tree and declared outside needs show when facts were read with --user", () => {
    const withUser = fs.readFileSync(atFile, "utf8").replace("  agent a {", '  needs { user-skills: [mine, ghost]\n    connectors: [slack] }\n  agent a {');
    const a2 = parse(withUser);
    const facts = collectFacts(a2, { source: withUser, dir: proj, user: true, home: fakeHome, inventory: inv() } as any);
    const cov = drawPage(generateVisualization(a2, { facts })).read<any>("coverageModel()");
    expect(cov.user.total).toBeGreaterThan(0);
    const byName = Object.fromEntries(cov.outside.map((o: any) => [o.name, o.status]));
    expect(byName.mine).toBe("mapped");
    expect(byName.ghost).toBe("missing");
    expect(byName.slack).toBe("not checked (account connector)");
  });
});
