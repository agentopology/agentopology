/**
 * [F-4] The Guards lens says the ledger is agent-writable on the grade itself, as guard --check does.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "../../parser/index.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import { generateVisualization } from "../index.js";
import { collectFacts } from "../facts.js";
import { drawPage } from "./vm-draw.js";

const ROOT = path.resolve(__dirname, "../../..");
const SRC = fs.readFileSync(path.join(ROOT, "src/__tests__/e2e/fixtures/codex-gates.at"), "utf8");
const NOTE = "ledger agent-writable until the signed gate";

describe("[F-4] the Guards lens carries the ledger note on the grade", () => {
  it("[F-4] a ledger gate's row and its node panel read 'refuse, ledger agent-writable until the signed gate'", () => {
    const ast = parse(SRC);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "at-f4-vz-"));
    for (const f of claudeCodeBinding.scaffold(ast)) {
      fs.mkdirSync(path.dirname(path.join(dir, f.path)), { recursive: true });
      fs.writeFileSync(path.join(dir, f.path), f.content);
    }
    const page = drawPage(generateVisualization(ast, { facts: collectFacts(ast, { source: SRC, dir }) }));
    const rows = page.read<Array<{ id: string; word: string }>>("guardRowsAll()");
    const gate = rows.find((r) => r.id === "publish-ready");
    expect(gate, JSON.stringify(rows)).toBeDefined();
    expect(gate!.word).toContain(NOTE);
    expect(page.read<string>("guardWord('publish-ready')")).toContain(NOTE);
  });
});
