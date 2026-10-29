import { describe, it, expect } from "vitest";
import vm from "node:vm";
import { parse } from "../../parser/index.js";
import { generateVisualization } from "../index.js";

/** Two gates guarding the same a -> b path. */
const TWO_GATES = `topology tg : [pipeline] {
  meta {
    version: "1.0.0"
    description: "x"
  }
  agent a {
    model: sonnet
    description: "first"
    tools: [Read]
  }
  agent b {
    model: sonnet
    description: "second"
    tools: [Read]
  }
  flow { a -> b }
  gates {
    gate g1 {
      after: a
      before: b
      run: "scripts/g1.sh"
    }
    gate g2 {
      after: a
      before: b
      run: "scripts/g2.sh"
    }
  }
}`;

/**
 * The graph is drawn in the browser, so run the page's own scripts in a vm
 * against a permissive DOM stub and read back what renderGraph wrote.
 */
function drawInVm(html: string): { svg: string; positions: Record<string, { x: number; y: number; w: number; h: number }> } {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const elements: Record<string, any> = {};
  const makeEl = (): any =>
    new Proxy(
      { innerHTML: "", textContent: "", style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false } },
      {
        get(t: any, k) {
          if (k in t) return t[k];
          if (k === "getBoundingClientRect") return () => ({ width: 1200, height: 800, left: 0, top: 0 });
          if (k === "querySelectorAll") return () => [];
          if (k === "querySelector") return () => null;
          return () => makeEl();
        },
      },
    );
  const document = {
    getElementById: (id: string) => (elements[id] ??= makeEl()),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    createElement: () => makeEl(),
    body: makeEl(),
  };
  // The page's global object is `window` (dagre's bundle attaches itself there).
  const ctx: any = vm.createContext({ document, console, innerWidth: 1200, innerHeight: 800, addEventListener() {}, setTimeout: () => 0, requestAnimationFrame: () => 0, localStorage: { getItem: () => null, setItem() {} } });
  vm.runInContext("var window = globalThis;", ctx);
  for (const src of scripts) vm.runInContext(src, ctx);
  const positions = JSON.parse(vm.runInContext("JSON.stringify(nodePositions)", ctx));
  return { svg: elements["graph-svg"].innerHTML, positions };
}

describe("Topology visualizer — gates with both after and before", () => {
  const { svg, positions } = drawInVm(generateVisualization(parse(TWO_GATES)));

  it("draws each gate onto the path it guards: after -> gate and gate -> before", () => {
    for (const g of ["g1", "g2"]) {
      expect(svg).toContain(`data-from="a" data-to="${g}"`);
      expect(svg).toContain(`data-from="${g}" data-to="b"`);
    }
  });

  it("does not place two gates on the same pair at the same point", () => {
    expect(positions.g1).toBeDefined();
    expect(positions.g2).toBeDefined();
    const dx = Math.abs(positions.g1.x - positions.g2.x);
    const dy = Math.abs(positions.g1.y - positions.g2.y);
    // They must not overlap: separated by at least a full width or height.
    expect(dx >= positions.g1.w || dy >= positions.g1.h).toBe(true);
  });
});
