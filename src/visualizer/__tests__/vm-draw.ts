import vm from "node:vm";

/**
 * Run the page's own scripts in a vm against a permissive DOM stub (no
 * browser is ever opened). Returns the drawn svg plus a way to read page state.
 */
export function drawPage(html: string, opts: { width?: number; height?: number } = {}) {
  const W = opts.width ?? 1200, H = opts.height ?? 800;
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const elements: Record<string, any> = {};
  const makeEl = (): any =>
    new Proxy(
      { innerHTML: "", textContent: "", style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false } },
      {
        get(t: any, k) {
          if (k in t) return t[k];
          if (k === "getBoundingClientRect") return () => ({ width: W, height: H, left: 0, top: 0 });
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
  const ctx: any = vm.createContext({ document, console, innerWidth: W, innerHeight: H, addEventListener() {}, setTimeout: () => 0, requestAnimationFrame: () => 0, localStorage: { getItem: () => null, setItem() {} } });
  vm.runInContext("var window = globalThis;", ctx);
  for (const src of scripts) vm.runInContext(src, ctx);
  const read = <T = any>(expr: string): T => JSON.parse(vm.runInContext(`JSON.stringify(${expr})`, ctx));
  return {
    svg: elements["graph-svg"].innerHTML as string,
    positions: read<Record<string, { x: number; y: number; w: number; h: number }>>("nodePositions"),
    transform: read<{ x: number; y: number; scale: number }>("transform"),
    placeBoxes: read<Array<{ place: string; x: number; y: number; w: number; h: number; members: string[] }>>("window.__placeBoxes || []"),
    read,
    run: (code: string) => vm.runInContext(code, ctx),
  };
}
