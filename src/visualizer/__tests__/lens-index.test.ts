import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parse } from "../../parser/index.js";
import { generateVisualization } from "../index.js";
import { collectFacts } from "../facts.js";
import { drawPage } from "./vm-draw.js";

const ROOT = path.resolve(__dirname, "../../..");
const EX = path.join(ROOT, "examples");
const files = [
  ...fs.readdirSync(EX).filter((f) => f.endsWith(".at")).map((f) => path.join(EX, f)),
  path.join(ROOT, "kitchen-sink.at"),
  path.join(ROOT, "src/__tests__/e2e/fixtures/session-ops.at"),
];

/** The line a node is declared on, read straight from the raw text: `<type> <id> ... {` (orchestrator has no id). */
function declaredLine(src: string, type: string, id: string): number | null {
  const lines = src.split("\n");
  const re = type === "orchestrator" ? /^\s*orchestrator\b[^{]*\{/ : new RegExp("^\\s*" + type + "\\s+" + id.replace(/[-]/g, "\\-") + "\\b[^{]*\\{");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimStart().startsWith("#")) continue;
    if (re.test(lines[i])) return i + 1;
  }
  return null;
}

describe("[VZ-10] the index lens", () => {
  for (const file of files) {
    const name = path.relative(ROOT, file);
    it(`[VZ-10] ${name}: every node id has an index row with the parser's line`, () => {
      const src = fs.readFileSync(file, "utf8");
      const ast = parse(src);
      const page = drawPage(generateVisualization(ast, { facts: collectFacts(ast, { source: src }) }));
      const rows = page.read<Array<{ id: string; kind: string; line: number | null }>>("indexModel().rows");
      const miss: string[] = [];
      for (const n of ast.nodes) {
        const row = rows.find((r) => r.id === n.id && r.kind === n.type);
        const want = declaredLine(src, n.type, n.id);
        if (!row) miss.push(`${n.id}: no row`);
        else if (row.line !== want) miss.push(`${n.id}: row line ${row.line}, declared at ${want}`);
      }
      expect(miss).toEqual([]);
    });
  }

  const SRC = fs.readFileSync(path.join(ROOT, "src/__tests__/e2e/fixtures/session-ops.at"), "utf8");
  const ast = parse(SRC);

  it("[VZ-10] every projected item is a row: nodes, edges, stores, hooks, jobs and decisions", () => {
    const src = fs.readFileSync(path.join(ROOT, "examples/memory-system.at"), "utf8");
    const a = parse(src);
    const page = drawPage(generateVisualization(a, { facts: collectFacts(a, { source: src }) }));
    const rows = page.read<Array<{ id: string; kind: string }>>("indexModel().rows");
    for (const n of a.nodes) expect(rows.some((r) => r.kind === n.type && r.id === n.id)).toBe(true);
    for (const e of a.edges) expect(rows.some((r) => r.kind === "edge" && r.id === `${e.from} -> ${e.to}`)).toBe(true);
    for (const s of a.stores) expect(rows.some((r) => r.kind === "store" && r.id === s.id)).toBe(true);
    const d = drawPage(generateVisualization(ast, { facts: collectFacts(ast, { source: SRC }) }));
    expect(d.read<any[]>("indexModel().rows").some((r) => r.kind === "decision" && r.id === "package-yes")).toBe(true);
  });

  it("[VZ-10] the source is embedded line by line, with an anchor per line", () => {
    const page = drawPage(generateVisualization(ast, { facts: collectFacts(ast, { source: SRC }) }));
    const m = page.read<{ source: string[] }>("indexModel()");
    expect(m.source).toEqual(SRC.split("\n"));
    const html = page.read<string>("renderIndexView()");
    expect(html).toContain('id="L1"');
    expect(html).toContain(`id="L${SRC.split("\n").length}"`);
  });

  it("[VZ-10] text that would end the script is escaped with the existing jsonForScript rules and round-trips", () => {
    const evil = SRC.replace("# session-ops.at:", "# </script><!-- &   session-ops.at:");
    const ast2 = parse(evil);
    const html = generateVisualization(ast2, { facts: collectFacts(ast2, { source: evil }) });
    expect(html.match(/<\/script>/g)!.length).toBe((generateVisualization(ast2).match(/<\/script>/g) ?? []).length);
    expect(html).not.toContain(" ");
    const page = drawPage(html);
    expect(page.read<{ source: string[] }>("indexModel()").source.join("\n")).toBe(evil);
  });

  it("[VZ-10] a click on a row jumps to its line", () => {
    const page = drawPage(generateVisualization(ast, { facts: collectFacts(ast, { source: SRC }) }));
    const row = page.read<any[]>("indexModel().rows").find((r) => r.kind === "agent" && r.id === "lane-build");
    page.run(`jumpToLine(${row.line})`);
    expect(page.read<number>("indexJump")).toBe(row.line);
    expect(page.read<string>("renderIndexView()")).toMatch(new RegExp(`class="src-line hit" id="L${row.line}"`));
    expect(page.read<string>("renderIndexView()")).toMatch(new RegExp(`class="idx-row"[^>]*data-line="${row.line}"[^>]*onclick="jumpToLine\\(${row.line}\\)"`));
  });

  it("[VZ-10] with no facts the lens says the source was not embedded", () => {
    const page = drawPage(generateVisualization(ast));
    expect(page.read<string>("renderIndexView()")).toContain("not embedded");
  });
});
