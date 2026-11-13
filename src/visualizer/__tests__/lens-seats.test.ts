import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parse } from "../../parser/index.js";
import { generateVisualization } from "../index.js";
import { collectFacts } from "../facts.js";
import { drawPage } from "./vm-draw.js";

const ROOT = path.resolve(__dirname, "../../..");
const FILES: Record<string, string> = {
  "session-ops.at": path.join(ROOT, "src/__tests__/e2e/fixtures/session-ops.at"),
  "kitchen-sink.at": path.join(ROOT, "kitchen-sink.at"),
};

describe("[VZ8] the seats lens", () => {
  for (const [name, file] of Object.entries(FILES)) {
    const src = fs.readFileSync(file, "utf8");
    const ast = parse(src);
    const humans = ast.nodes.filter((n) => n.type === "human").length;
    const declared = new Set<string>(ast.decisions ?? []);
    for (const n of ast.nodes) for (const d of (n as any).decides ?? []) declared.add(d);

    it(`[VZ-8] ${name}: one row per human node plus declared decision`, () => {
      const page = drawPage(generateVisualization(ast));
      const rows = page.read<any[]>("seatsModel().rows");
      expect(rows.length).toBe(humans + declared.size);
      expect(rows.length).toBeGreaterThan(0);
      const html = page.read<string>("renderSeatsView()");
      expect((html.match(/class="seat-row"/g) ?? []).length).toBe(rows.length);
    });
  }

  const ast = parse(fs.readFileSync(FILES["session-ops.at"], "utf8"));
  const src = fs.readFileSync(FILES["session-ops.at"], "utf8");

  it("[VZ-8] a human row says where it sits, what it releases, its timeout and on-timeout", () => {
    const k = parse(fs.readFileSync(FILES["kitchen-sink.at"], "utf8"));
    const page = drawPage(generateVisualization(k));
    const row = page.read<any[]>("seatsModel().rows").find((r) => r.id === "ops-approval");
    expect(row.kind).toBe("human");
    expect(row.where).toEqual({ after: ["fixer"], before: ["verifier"] });
    expect(row.releases).toEqual(["verifier"]);
    expect(row.timeout).toBeDefined();
    expect("onTimeout" in row).toBe(true);
  });

  it("[VZ-8] a decision row says which session holds it and what that session releases", () => {
    const page = drawPage(generateVisualization(ast));
    const row = page.read<any[]>("seatsModel().rows").find((r) => r.id === "package-yes");
    expect(row.kind).toBe("decision");
    expect(row.holder).toBe("lane-manager");
    expect(row.where).toEqual({ place: "ops", session: "lane-manager" });
    expect(row.releases.sort()).toEqual(["lane-build", "lane-text", "lane-video", "owner"].sort());
  });

  it("[VZ-8] grades come from the facts; with no project dir they read not checked", () => {
    const nc = drawPage(generateVisualization(ast));
    expect(nc.read<any[]>("seatsModel().rows").every((r) => r.grade === null)).toBe(true);
    expect(nc.read<string>("renderSeatsView()")).toContain("not checked");
    const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "viz-seat-"));
    try {
      const page = drawPage(generateVisualization(ast, { facts: collectFacts(ast, { source: src, dir }) }));
      const owner = page.read<any[]>("seatsModel().rows").find((r) => r.id === "owner");
      expect(owner.grade).toBe("hope");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
