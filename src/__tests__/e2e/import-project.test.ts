/**
 * Import on a real repo root: it reads only what it needs, and it recovers the
 * flow where the project records one and says where it does not.
 *
 * Measured on a client repo with 31 agents: over two minutes in the walk, most
 * of it `.claude/worktrees` (dozens of full checkouts), and `edges: []` although
 * two .at files in the repo held 52 edges.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { importClaudeCodeWithReport, readClaudeProject, readProject } from "../../import/index.js";
import { MAX_FILE_BYTES, MAX_TOTAL_BYTES } from "../../import/walk.js";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../../../dist/cli/index.js");

let root: string;
const put = (rel: string, content = "x\n") => {
  fs.mkdirSync(dirname(join(root, rel)), { recursive: true });
  fs.writeFileSync(join(root, rel), content);
};
const agent = (id: string) => put(`.claude/agents/${id}.md`, `---\nname: ${id}\ndescription: "${id}"\n---\n\nDo the ${id} work.\n`);
const paths = () => readClaudeProject(root)!.files.map((f) => f.path).sort();
const imported = () => {
  const { source, report } = importClaudeCodeWithReport(readClaudeProject(root)!.files, "shop");
  return { source, report, ast: parse(source) };
};

const SHOP_AT = `topology shop : [pipeline, human-gate] {
  meta {
    version: "2.1.0"
    description: "The shop pipeline"
  }
  orchestrator {
    model: sonnet
    handles: [intake]
  }
  action intake {
    kind: inline
    description: "Take the order"
  }
  agent writer {
    model: sonnet
    description: "Writes"
    writes: ["out/draft.md"]
  }
  human approve {
    description: "An editor approves"
  }
  agent reviewer {
    model: sonnet
    description: "Reviews"
    reads: ["out/draft.md"]
    outputs: {
      verdict: pass | fail
    }
  }
  agent ghost {
    model: sonnet
    description: "Declared, never written to disk"
  }
  gates {
    gate lint {
      after: writer
      before: approve
      run: "scripts/lint.sh"
    }
  }
  flow {
    intake -> writer
    writer -> approve
    approve -> reviewer
    reviewer -> ghost [when reviewer.verdict == pass]
    reviewer -> writer [when reviewer.verdict == fail, max 2]
  }
}
`;

beforeEach(() => {
  root = fs.mkdtempSync(join(os.tmpdir(), "at-import-"));
  agent("writer");
  agent("reviewer");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("import reads only what it needs", () => {
  it("[I1] worktrees, build output and the rest of the tree are never read", () => {
    for (const noise of [".worktrees/w1", ".claude/worktrees/agent-1", "dist", "build", "coverage", "node_modules/p"]) {
      put(`${noise}/.claude/agents/stale.md`, "---\nname: stale\n---\n");
      put(`${noise}/old.at`, "not a topology");
    }
    put("src/app.ts", "code");
    const files = paths();
    expect(files.filter((p) => /stale|old\.at|app\.ts/.test(p))).toEqual([]);
    expect(files).toEqual([".claude/agents/reviewer.md", ".claude/agents/writer.md"]);
  });

  it("[I1] a skill or agent the author named build or dist is kept", () => {
    put(".claude/skills/build/SKILL.md", "---\nname: build\ndescription: b\n---\n");
    put(".claude/agents/dist/AGENT.md", "---\nname: dist\ndescription: d\n---\n");
    expect(paths()).toEqual(expect.arrayContaining([".claude/skills/build/SKILL.md", ".claude/agents/dist/AGENT.md"]));
    expect(imported().ast.nodes.map((n) => n.id)).toContain("dist");
    // the generic walk used by sync and openclaw keeps them too
    expect(readProject(root).files.map((f) => f.path)).toContain(".claude/skills/build/SKILL.md");
  });

  it("[I1] an agents/x.md in the source tree is not an agent, and a nested .claude is named, not read", () => {
    put("docs/agents/guide.md", "# not an agent");
    put("packages/app/.claude/agents/inner.md", "---\nname: inner\n---\n");
    const project = readClaudeProject(root)!;
    expect(imported().ast.nodes.map((n) => n.id).sort()).toEqual(["reviewer", "writer"]);
    expect(project.nestedConfigs).toEqual([join("packages", "app", ".claude")]);
  });

  it("[I1] a symlink cycle ends, and a large or binary file in .claude is not read", () => {
    fs.symlinkSync(root, join(root, ".claude/loop"));
    put(".claude/skills/video/clip.mp4", "binary");
    expect(paths().filter((p) => p.includes("loop") || p.endsWith(".mp4"))).toEqual([]);
  });

  it("[I1] a folder with no .claude is read as a config folder given directly", () => {
    const direct = join(root, ".claude");
    expect(readClaudeProject(direct)!.files.map((f) => f.path).sort()).toEqual([".claude/agents/reviewer.md", ".claude/agents/writer.md"]);
    const bare = fs.mkdtempSync(join(os.tmpdir(), "at-bare-"));
    expect(readClaudeProject(bare)).toBeNull();
    fs.rmSync(bare, { recursive: true });
  });
});

describe("import always ends, and says why", () => {
  const run = (...extra: string[]) => {
    const r = spawnSync(process.execPath, [CLI, "import", "--target", "claude-code", "--dir", root, "--name", "shop", "--output", join(root, "o"), ...extra], { encoding: "utf8" });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };

  it("[I5] an unreadable file, an unreadable folder, a broken link and an oversized file do not stop the import, and each is named", () => {
    put(".claude/agents/locked.md", "secret");
    fs.chmodSync(join(root, ".claude/agents/locked.md"), 0o000);
    put(".claude/locked/a.md");
    fs.chmodSync(join(root, ".claude/locked"), 0o000);
    fs.symlinkSync(join(root, "nowhere"), join(root, ".claude/agents/broken.md"));
    put(".claude/skills/logs/run.md");
    fs.truncateSync(join(root, ".claude/skills/logs/run.md"), MAX_FILE_BYTES + 1);
    const { code, out } = run();
    fs.chmodSync(join(root, ".claude/agents/locked.md"), 0o644);
    fs.chmodSync(join(root, ".claude/locked"), 0o755);
    expect(code).toBe(0);
    expect(fs.existsSync(join(root, "o/shop.at"))).toBe(true);
    expect(out).toContain("Not read: .claude/agents/locked.md (EACCES");
    expect(out).toContain("Not read: .claude/locked (EACCES");
    expect(out).toContain("Not read: .claude/skills/logs/run.md (5 MB, over the 5 MB limit)");
  });

  it("[I5] a link at the root is not followed out of the project; a linked skill inside .claude still is", () => {
    const outside = fs.mkdtempSync(join(os.tmpdir(), "at-outside-"));
    fs.writeFileSync(join(outside, "elsewhere.at"), "not read");
    fs.mkdirSync(join(outside, "linked"));
    fs.writeFileSync(join(outside, "linked/SKILL.md"), "---\nname: linked\ndescription: l\n---\n");
    fs.symlinkSync(outside, join(root, "shots"));
    fs.mkdirSync(join(root, ".claude/skills"), { recursive: true });
    fs.symlinkSync(join(outside, "linked"), join(root, ".claude/skills/linked"));
    const files = paths();
    fs.rmSync(outside, { recursive: true });
    expect(files.filter((p) => p.includes("elsewhere"))).toEqual([]);
    expect(files).toContain(".claude/skills/linked/SKILL.md");
  });

  it("[I5] past the total budget the read stops with a message, exit 1, and no partial .at", () => {
    for (let i = 0; i * MAX_FILE_BYTES <= MAX_TOTAL_BYTES; i++) {
      put(`.claude/skills/s/f${i}.md`);
      fs.truncateSync(join(root, `.claude/skills/s/f${i}.md`), MAX_FILE_BYTES);
    }
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("Importing from claude-code files");
    expect(out).toMatch(/Import error: Stopped reading after 256 MB/);
    expect(fs.existsSync(join(root, "o/shop.at"))).toBe(false);
  });

  it("[I5] what import holds does not grow with the source tree", () => {
    for (let d = 0; d < 20; d++) put(`src/d${d}/f.ts`, "x".repeat(1024));
    const project = readClaudeProject(root)!;
    expect(project.files.reduce((n, f) => n + f.content.length, 0)).toBeLessThan(1024);
  });
});

describe("import recovers the flow a .at records", () => {
  beforeEach(() => put(".claude/topologies/shop.at", SHOP_AT));

  it("[I2] every edge comes back with its conditions, plus the actions, humans and gates on the way", () => {
    const { ast } = imported();
    expect(ast.edges.map((e) => `${e.from}>${e.to}`)).toEqual([
      "intake>writer", "writer>approve", "approve>reviewer", "reviewer>ghost", "reviewer>writer",
    ]);
    expect(ast.edges.find((e) => e.to === "ghost")?.condition).toBe("reviewer.verdict == pass");
    expect(ast.edges.find((e) => e.from === "reviewer" && e.to === "writer")?.maxIterations).toBe(2);
    expect(ast.nodes.map((n) => `${n.type}:${n.id}`)).toEqual(expect.arrayContaining(["action:intake", "human:approve", "gate:lint", "orchestrator:orchestrator"]));
    expect(ast.topology.version).toBe("2.1.0");
    expect(ast.topology.patterns).toEqual(["pipeline", "human-gate"]);
  });

  it("[I2] the agent's file wins; the .at fills only what a file cannot say", () => {
    put(".claude/agents/writer.md", '---\nname: writer\ndescription: "From the file"\nmodel: haiku\n---\n\nBody.\n');
    const writer = imported().ast.nodes.find((n) => n.id === "writer") as { description?: string; model?: string; writes?: string[]; file?: string };
    expect(writer).toMatchObject({ description: "From the file", model: "haiku", writes: ["out/draft.md"], file: ".claude/agents/writer.md" });
  });

  it("[I2] the import validates, and the JSON export carries the edges", () => {
    const { source, ast } = imported();
    expect(validate(ast).filter((r) => r.level === "error")).toEqual([]);
    fs.writeFileSync(join(root, "out.at"), source);
    const dir = join(root, "export");
    execFileSync(process.execPath, [CLI, "export", join(root, "out.at"), "--format", "json", "--output", dir], { stdio: "ignore" });
    const json = JSON.parse(fs.readFileSync(join(dir, fs.readdirSync(dir)[0]), "utf-8"));
    expect(json.edges).toHaveLength(5);
  });

  it("[I2] a gate a skill only describes gives way to the .at's, and a noted heading gives a clean id", () => {
    put(".claude/skills/shop/SKILL.md", "---\nname: shop\ntopology: shop\n---\n\n## Gates\n\n### lint (after writer, before approve)\nRun: lint — every draft\n");
    const gates = imported().ast.nodes.filter((n) => n.type === "gate") as Array<{ id: string; run?: string }>;
    expect(gates).toEqual([expect.objectContaining({ id: "lint", run: "scripts/lint.sh" })]);
  });

  it("[I3] an agent the .at declares without a file stays in the flow and is reported", () => {
    const { report, ast } = imported();
    expect(ast.nodes.map((n) => n.id)).toContain("ghost");
    expect(report.noFile).toEqual([{ id: "ghost", source: ".claude/topologies/shop.at", workflow: false }]);
    expect(report.dropped).toEqual([]);
  });

  it("[I3] another system's .at, a broken .at and a second copy give no flow, and each is named", () => {
    put("examples/other.at", SHOP_AT.replaceAll("writer", "painter").replaceAll("reviewer", "framer").replace("topology shop", "topology other"));
    put("broken.at", "topology {");
    put("docs/backup/shop.at", SHOP_AT);
    const { report, ast } = imported();
    expect(ast.edges).toHaveLength(5);
    expect(report.sources.map((s) => s.path)).toEqual([".claude/topologies/shop.at"]);
    const reason = (p: string) => report.skipped.find((s) => s.path === p)?.reason;
    expect(reason("examples/other.at")).toBe("0 of its 3 agents are here");
    expect(reason("broken.at")).toMatch(/^does not parse/);
    expect(reason("docs/backup/shop.at")).toBe('another copy of topology "shop"');
  });

  it("[I3] names that match only by suffix are said, not mapped", () => {
    fs.rmSync(join(root, ".claude/agents"), { recursive: true });
    agent("shop-writer");
    agent("shop-reviewer");
    const { report, ast } = imported();
    expect(ast.edges).toEqual([]);
    expect(report.skipped[0].reason).toContain("2 more match only by suffix");
  });
});

describe("import says what it does not know", () => {
  it("[I3] with no flow source: no edge is invented, every agent is on-demand and named, and the .at says so", () => {
    const { report, source, ast } = imported();
    expect(ast.edges).toEqual([]);
    expect(report.unwired.sort()).toEqual(["reviewer", "writer"]);
    expect(source).toContain("# Flow: none found. Nothing on disk records one, so none was invented.");
    expect(source).toContain("# Flow: 0 of 2 agents wired");
  });

  it("[I3] an exact shared path is offered as a possible handoff, outside the flow; a shared folder is not", () => {
    put(".claude/agents/writer.md", "---\nname: writer\ndescription: w\n---\n\n## Writes\n- out/draft.md\n- workspace/\n");
    put(".claude/agents/reviewer.md", "---\nname: reviewer\ndescription: r\n---\n\n## Reads\n- out/draft.md\n- workspace/\n");
    const { report, ast } = imported();
    expect(ast.edges).toEqual([]);
    expect(report.suggested).toEqual([{ from: "writer", to: "reviewer", via: "out/draft.md" }]);
  });

  it("[I3] the CLI prints the report and writes the same lines at the top of the .at", () => {
    put(".claude/topologies/shop.at", SHOP_AT);
    const out = execFileSync(process.execPath, [CLI, "import", "--target", "claude-code", "--dir", root, "--name", "shop", "--output", join(root, "o")], { encoding: "utf8" });
    expect(out).toContain("Flow: 5 edges from .claude/topologies/shop.at (2 agents match)");
    expect(out).toContain("Flow: 3 of 3 agents wired");
    expect(fs.readFileSync(join(root, "o/shop.at"), "utf-8")).toMatch(/^# Flow: 5 edges from/);
  });
});
