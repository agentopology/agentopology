import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "../../parser/index.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import { checkGuards, renderGuardReport } from "../../guard/check.js";
import { VERIFIED_ON } from "../../conformance/claude-code.js";
import { generateVisualization } from "../index.js";
import { collectFacts } from "../facts.js";
import { NODE_RULES, GUARD_GRADES } from "../project.js";
import { drawPage } from "./vm-draw.js";

const ROOT = path.resolve(__dirname, "../../..");
const SRC = fs.readFileSync(path.join(ROOT, "src/__tests__/e2e/fixtures/session-ops.at"), "utf8");
const ast = parse(SRC);

function stripComments(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

let dir: string;
let prevEnv: string | undefined;
beforeAll(() => {
  prevEnv = process.env.AGENTOPOLOGY_CLAUDE_VERSION;
  // The installed-version read is cached per process. VERIFIED_ON is 2.1.323, where the
  // talk and spawn guards grade refuse; this file also needs the "unverified" grade, so it
  // stands in for a Claude Code version nobody has verified.
  process.env.AGENTOPOLOGY_CLAUDE_VERSION = "2.1.999";
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "viz-shell-"));
  for (const f of claudeCodeBinding.scaffold(ast)) {
    const p = path.join(dir, f.path);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, f.content);
    if (f.executable || f.path.endsWith(".sh")) fs.chmodSync(p, 0o755);
  }
});
afterAll(() => {
  if (prevEnv === undefined) delete process.env.AGENTOPOLOGY_CLAUDE_VERSION;
  else process.env.AGENTOPOLOGY_CLAUDE_VERSION = prevEnv;
  fs.rmSync(dir, { recursive: true, force: true });
});

const plain = () => generateVisualization(ast);
const checked = () => generateVisualization(ast, { facts: collectFacts(ast, { source: SRC, dir }) });

describe("[VZ-4] one file, no network", () => {
  it("[VZ-4] holds no http(s) URL outside comments", () => {
    for (const html of [plain(), checked()]) {
      const hits = stripComments(html).match(/https?:\/\/[^\s"'<>)]*/g) ?? [];
      expect(hits).toEqual([]);
    }
  });
  it("[VZ-4] has no <link> and no @import, and a system font stack", () => {
    const html = stripComments(plain());
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/@import/i);
    expect(html).not.toMatch(/Noto Sans|JetBrains Mono/);
    expect(html).toMatch(/--font-body:[^;]*system-ui/);
  });
  it("[VZ-4] light and dark themes come from CSS variables, with a toggle", () => {
    const html = plain();
    expect(html).toContain("prefers-color-scheme");
    expect(html).toMatch(/:root\[data-theme=["']?light["']?\]/);
    expect(html).toMatch(/:root\[data-theme=["']?dark["']?\]/);
    expect(html).toContain('id="theme-toggle"');
    expect(html).toContain("dataset.theme");
  });
  it("[VZ-4] has a lens bar with six lenses; only Flow and Guards are active", () => {
    const html = plain();
    for (const l of ["flow", "sessions", "guards", "seats", "coverage", "index"]) {
      expect(html).toContain(`data-lens="${l}"`);
    }
    const page = drawPage(plain());
    const lenses = page.read<Array<{ id: string; active: boolean }>>("LENSES");
    expect(lenses.map((l) => l.id)).toEqual(["flow", "sessions", "guards", "seats", "coverage", "index"]);
    expect(lenses.filter((l) => l.active).map((l) => l.id)).toEqual(["flow", "guards"]);
  });
  it("[VZ-4] the headline strip has 7 facts computed from the projection and the facts", () => {
    const page = drawPage(checked());
    const facts = page.read<Array<{ key: string; value: string }>>("headlineFacts()");
    expect(facts).toHaveLength(7);
    const by = Object.fromEntries(facts.map((f) => [f.key, f.value]));
    expect(by.agents).toBe(String(ast.nodes.filter((n) => n.type === "agent").length));
    expect(by.sessions).toBe(String(ast.nodes.filter((n: any) => n.runs === "session").length));
    expect(by.gates).toBe(String(ast.nodes.filter((n) => n.type === "gate").length));
    expect(by.version).toContain(VERIFIED_ON);
    expect(by.coverage).toMatch(/of/);
  });
  it("[VZ-4] coverage reads 'not checked' with no project dir", () => {
    const page = drawPage(plain());
    const by = Object.fromEntries(page.read<Array<{ key: string; value: string }>>("headlineFacts()").map((f) => [f.key, f.value]));
    expect(by.coverage).toBe("not checked");
  });
  it("[VZ-4] the legend is built from the rules table", () => {
    const page = drawPage(plain());
    const legend = page.read<Array<{ kind: string; label: string }>>("data.legend");
    expect(legend.map((l) => l.kind).sort()).toEqual(Object.keys(NODE_RULES).sort());
    expect(page.read<Array<{ id: string }>>("data.grades").map((g) => g.id)).toEqual(GUARD_GRADES.map((g) => g.id));
  });
  it("[VZ-4] #node and #lens deep links parse", () => {
    const page = drawPage(plain());
    expect(page.read("parseHash('#node=lane-build')")).toEqual({ node: "lane-build" });
    expect(page.read("parseHash('#lens=guards')")).toEqual({ lens: "guards" });
    expect(page.read("parseHash('#lens=guards&node=a%20b')")).toEqual({ lens: "guards", node: "a b" });
    expect(page.read("parseHash('#lens=nope')")).toEqual({});
    expect(page.read("parseHash('')")).toEqual({});
  });
  it("[VZ-4] search filters by id and label", () => {
    const page = drawPage(plain());
    expect(page.read<string[]>("matchNodes('lane-build')")).toEqual(["lane-build"]);
    const all = ast.nodes.map((n) => n.id);
    expect(page.read<string[]>("matchNodes('')").sort()).toEqual([...all].sort());
    expect(page.read<string[]>("matchNodes('zzzz-nothing')")).toEqual([]);
  });
});

describe("[VZ-7] the guards lens", () => {
  const printedCounts = () => {
    const lines = renderGuardReport(checkGuards(ast, dir));
    const counts: Record<string, number> = {};
    for (const l of lines) {
      const m = l.match(/^\s+\S.*?\s+(refuse|detect|hope|none|unverified)\s+by:/);
      if (m) counts[m[1]] = (counts[m[1]] ?? 0) + 1;
    }
    return counts;
  };

  it("[VZ-7] counts in the page equal the counts guard --check prints", () => {
    const page = drawPage(checked());
    const counts = page.read<Record<string, number>>("guardCounts()");
    const printed = printedCounts();
    expect(Object.keys(printed).length).toBeGreaterThan(0);
    for (const g of ["refuse", "detect", "hope", "none", "unverified"]) {
      expect(counts[g] ?? 0).toBe(printed[g] ?? 0);
    }
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(Object.values(printed).reduce((a, b) => a + b, 0));
    expect(counts.unverified ?? 0).toBeGreaterThan(0);
  });

  it("[VZ-7] each chip pairs a shape, a word and a color; unverified is the same shape with a ?", () => {
    const page = drawPage(checked());
    const g = Object.fromEntries(page.read<Array<any>>("data.grades").map((x) => [x.id, x]));
    expect(g.refuse.shape).toBe("square-solid");
    expect(g.hope.shape).toBe("circle-hollow");
    expect(g.none.shape).toBe("outline-dashed");
    expect(g.unverified.mark).toBe("?");
    expect(g.unverified.shape).toBe(g.refuse.shape);
    for (const x of Object.values<any>(g)) { expect(x.word).toBe(x.id); expect(x.color).toBeTruthy(); }
    const chip = page.read<string>("chipHtml('hope')");
    expect(chip).toContain("hope");
    expect(chip).toContain("chip-circle-hollow");
  });

  it("[VZ-7] the ledger is worst first and lists untied hooks", () => {
    const page = drawPage(checked());
    const rows = page.read<Array<{ id: string; grade: string }>>("guardLedger().rows");
    const order = ["none", "hope", "detect", "unverified", "refuse"];
    const ranks = rows.map((r) => order.indexOf(r.grade));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(rows.length).toBeGreaterThan(0);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain("talk guard");
    expect(ids).toContain("spawn guard");
    expect(page.read<string[]>("guardLedger().untied")).toEqual(checkGuards(ast, dir).unattributed);
  });

  it("[VZ-7] an untied hook shows under 'untied'", () => {
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "viz-untied-"));
    try {
      fs.cpSync(dir, d2, { recursive: true });
      const sp = path.join(d2, ".claude/settings.json");
      const s = JSON.parse(fs.readFileSync(sp, "utf8"));
      (s.hooks.PreToolUse ??= []).push({ matcher: "Bash", hooks: [{ type: "command", command: "/opt/hand-built/guard.sh" }] });
      fs.writeFileSync(sp, JSON.stringify(s));
      const html = generateVisualization(ast, { facts: collectFacts(ast, { source: SRC, dir: d2 }) });
      const untied = drawPage(html).read<string[]>("guardLedger().untied");
      expect(untied.some((u) => u.includes("hand-built/guard.sh"))).toBe(true);
    } finally { fs.rmSync(d2, { recursive: true, force: true }); }
  });

  it("[VZ-7] the headline numbers filter the lens", () => {
    const page = drawPage(checked());
    const total = page.read<any[]>("guardLedger().rows").length;
    const counts = page.read<Record<string, number>>("guardCounts()");
    const grade = Object.keys(counts).find((g) => counts[g] > 0 && counts[g] < total)!;
    expect(grade).toBeTruthy();
    page.read(`(setGuardFilter('${grade}'), 1)`);
    const rows = page.read<Array<{ grade: string }>>("guardLedger().rows");
    expect(rows).toHaveLength(counts[grade]);
    expect(rows.every((r) => r.grade === grade)).toBe(true);
    page.read("(setGuardFilter(null), 1)");
    expect(page.read<any[]>("guardLedger().rows")).toHaveLength(total);
  });

  it("[VZ-7] with no project dir every chip reads 'not checked'", () => {
    const page = drawPage(plain());
    const rows = page.read<Array<{ id: string; grade: string; word: string }>>("guardLedger().rows");
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) { expect(r.grade).toBe("not-checked"); expect(r.word).toBe("not checked"); }
    expect(page.read<Record<string, number>>("guardCounts()").refuse ?? 0).toBe(0);
  });

  it("[VZ-7] unverified reads the same shape with a ? when the installed version differs", () => {
    const prev = process.env.AGENTOPOLOGY_CLAUDE_VERSION;
    process.env.AGENTOPOLOGY_CLAUDE_VERSION = "2.1.999";
    try {
      const html = generateVisualization(ast, { facts: collectFacts(ast, { source: SRC, dir }) });
      const counts = drawPage(html).read<Record<string, number>>("guardCounts()");
      const printed = printedCounts();
      expect(counts.unverified ?? 0).toBe(printed.unverified ?? 0);
    } finally { process.env.AGENTOPOLOGY_CLAUDE_VERSION = prev; }
  });
});
