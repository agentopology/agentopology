import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parse } from "../../parser/index.js";
import { generateVisualization } from "../index.js";
import { project, unclaimedFields, unclaimedEdgeFields } from "../project.js";
import { drawPage } from "./vm-draw.js";

const ROOT = path.resolve(__dirname, "../../..");
const FIXTURE = fs.readFileSync(path.join(ROOT, "src/__tests__/e2e/fixtures/session-ops.at"), "utf8");

const FOUR_MANUAL = `topology manual-flow : [pipeline] {
  meta {
    version: "1.0.0"
    description: "x"
  }
  agent start {
    model: sonnet
    description: "first"
    tools: [Read]
  }
  agent m1 {
    model: sonnet
    description: "one"
    invocation: manual
    tools: [Read]
  }
  agent m2 {
    model: sonnet
    description: "two"
    invocation: manual
    tools: [Read]
  }
  agent m3 {
    model: sonnet
    description: "three"
    invocation: manual
    tools: [Read]
  }
  agent m4 {
    model: sonnet
    description: "four"
    invocation: manual
    tools: [Read]
  }
  flow { start -> m1 -> m2 -> m3 -> m4 }
}`;

describe("[VZ-1c] every parsed field reaches the page", () => {
  const ast = parse(FIXTURE);
  const data = project(ast);

  it("[VZ-1c] session-ops.at: no node or edge field is lost", () => {
    const lost: string[] = [];
    ast.nodes.forEach((n, i) => {
      for (const k of unclaimedFields(n as any, data.nodes[i])) lost.push(`${n.id}.${k}`);
    });
    ast.edges.forEach((e, i) => {
      for (const k of unclaimedEdgeFields(e as any, data.edges[i])) lost.push(`${e.from}->${e.to}.${k}`);
    });
    expect(lost).toEqual([]);
  });

  it("[VZ-1c] runs, place and decides are on the node, message is on the edge", () => {
    const mgr = data.nodes.find((n: any) => n.id === "lane-manager");
    expect(mgr.runs).toBe("session");
    expect(mgr.place).toBe("ops");
    expect(mgr.decides).toEqual(["package-yes"]);
    expect(data.edges.some((e: any) => e.message === "ticket")).toBe(true);
  });

  it("[VZ-1c] topology-level decisions reach the page", () => {
    expect(data.decisions).toEqual(["package-yes"]);
  });
});

describe("[VZ-1a] manual agents stay in the flow layout", () => {
  const out = drawPage(generateVisualization(parse(FOUR_MANUAL)));

  it("[VZ-1a] 4 of 4 manual agents are ranked below their parent, in flow order", () => {
    const ys = ["start", "m1", "m2", "m3", "m4"].map((id) => out.positions[id]?.y);
    ys.forEach((y) => expect(y).toBeDefined());
    for (let i = 1; i < ys.length; i++) expect(ys[i]).toBeGreaterThan(ys[i - 1]);
  });

  it("[VZ-1a] 4 of 4 sit inside the flow's x-range (no side column)", () => {
    const startX = out.positions.start.x;
    for (const id of ["m1", "m2", "m3", "m4"]) expect(Math.abs(out.positions[id].x - startX)).toBeLessThan(60);
  });

  it("[VZ-1a] edges touching manual nodes are drawn", () => {
    expect(out.svg).toContain('data-from="start" data-to="m1"');
    expect(out.svg).toContain('data-from="m3" data-to="m4"');
  });

  it("[VZ-1a] the MANUAL AGENTS side-column label is gone when all manual nodes have flow edges", () => {
    expect(out.svg).not.toContain("MANUAL AGENTS");
  });

  it("[VZ-1a] a manual node with no flow edges still goes to the side", () => {
    const lone = FOUR_MANUAL.replace("flow { start -> m1 -> m2 -> m3 -> m4 }", "flow { start -> m1 -> m2 -> m3 }");
    const o = drawPage(generateVisualization(parse(lone)));
    expect(o.positions.m4).toBeDefined();
    expect(o.positions.m4.x).toBeGreaterThan(o.positions.m3.x + 100);
    expect(o.svg).toContain("MANUAL AGENTS");
  });
});

describe("[VZ-1b] places and the session mark", () => {
  const out = drawPage(generateVisualization(parse(FIXTURE)));

  it("[VZ-1b] each place is a titled box around exactly its sessions", () => {
    const byPlace = Object.fromEntries(out.placeBoxes.map((b) => [b.place, b]));
    expect(Object.keys(byPlace).sort()).toEqual(["makers", "ops"]);
    expect(byPlace.ops.members.sort()).toEqual(["lane-build", "lane-manager"]);
    expect(byPlace.makers.members.sort()).toEqual(["lane-text", "lane-video"]);
    for (const b of out.placeBoxes) {
      for (const m of b.members) {
        const p = out.positions[m];
        expect(p.x - p.w / 2).toBeGreaterThanOrEqual(b.x);
        expect(p.x + p.w / 2).toBeLessThanOrEqual(b.x + b.w);
        expect(p.y).toBeGreaterThanOrEqual(b.y);
        expect(p.y + p.h).toBeLessThanOrEqual(b.y + b.h);
      }
    }
    expect(out.svg).toContain('class="place-box"');
    expect(out.svg).toContain(">ops<");
    expect(out.svg).toContain(">makers<");
  });

  it("[VZ-1b] a box does not swallow a node that is not in the place", () => {
    for (const b of out.placeBoxes) {
      for (const [id, p] of Object.entries(out.positions)) {
        if (b.members.includes(id)) continue;
        const inside = p.x > b.x && p.x < b.x + b.w && p.y + p.h / 2 > b.y && p.y + p.h / 2 < b.y + b.h;
        expect(inside, `${id} inside ${b.place}`).toBe(false);
      }
    }
  });

  it("[VZ-1b] each of the 4 session agents wears a session mark, the subagent does not", () => {
    const marks = [...out.svg.matchAll(/class="session-mark" data-for="([^"]+)"/g)].map((m) => m[1]).sort();
    expect(marks).toEqual(["lane-build", "lane-manager", "lane-text", "lane-video"]);
  });
});

describe("[VZ-1d] fit to screen on load", () => {
  const fits = (w: number, h: number) => {
    const out = drawPage(generateVisualization(parse(FIXTURE)), { width: w, height: h });
    const { x, y, scale } = out.transform;
    const rects = [...Object.entries(out.positions).map(([, p]) => ({ x: p.x - p.w / 2, y: p.y, w: p.w, h: p.h })), ...out.placeBoxes];
    for (const r of rects) {
      expect(r.x * scale + x).toBeGreaterThanOrEqual(-0.5);
      expect(r.y * scale + y).toBeGreaterThanOrEqual(-0.5);
      expect((r.x + r.w) * scale + x).toBeLessThanOrEqual(w + 0.5);
      expect((r.y + r.h) * scale + y).toBeLessThanOrEqual(h + 0.5);
    }
    return out;
  };

  it("[VZ-1d] the fixture's 4 sessions and both places are inside the initial fit", () => {
    const out = fits(1200, 800);
    expect(out.placeBoxes.length).toBe(2);
    for (const id of ["lane-manager", "lane-build", "lane-video", "lane-text"]) expect(out.positions[id]).toBeDefined();
  });

  it("[VZ-1d] a small window still fits everything", () => {
    fits(600, 500);
  });

  it("[VZ-1d] fit leaves room for the open panel when it overlays the graph", () => {
    const out = drawPage(generateVisualization(parse(FIXTURE)), { width: 700, height: 800 });
    // Open the panel (overlay on narrow windows), then fit again.
    out.run("document.getElementById('side-panel').classList.contains = function(c){ return false; }; zoomFit();");
    const { x, y, scale } = out.read("transform");
    const free = 700 - Math.min(380, 0.85 * 700);
    for (const [, p] of Object.entries(out.positions) as any) {
      expect((p.x + p.w / 2) * scale + x).toBeLessThanOrEqual(free + 0.5);
      void y;
    }
  });
});

describe("[VZ-1e] stores in their own band, memory edges faint", () => {
  const ast = parse(fs.readFileSync(path.join(ROOT, "examples/company-brain.at"), "utf8"));
  it("[VZ-1e] every store sits below every flow node", () => {
    expect(ast.stores.length).toBeGreaterThan(0);
    const out = drawPage(generateVisualization(ast));
    const storeIds = new Set(ast.stores.map((st: any) => st.id));
    const flowBottom = Math.max(...Object.entries(out.positions).filter(([id]) => !storeIds.has(id)).map(([, p]) => p.y + p.h));
    for (const id of storeIds) {
      expect(out.positions[id], id).toBeDefined();
      expect(out.positions[id].y).toBeGreaterThan(flowBottom);
    }
  });
  it("[VZ-1e] memory edges are drawn faint by default", () => {
    const html = generateVisualization(ast);
    expect(html).toMatch(/\.edge-path\.memory\{[^}]*opacity:\s*0?\.[0-4]/);
  });
});
