/**
 * Freeze the exit code of every generated guard hook on every corpus input
 * (hook-corpus.mjs), with jq on PATH and without it, as a build makes them.
 *
 *   node freeze-hooks.mjs <dist> <out.json>
 *
 * Run once against a v0.11.2 build (hooks-0112.json); the differential test
 * then holds this branch to it.
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runCorpus } from "./hook-corpus.mjs";

const [dist, outFile] = process.argv.slice(2);
if (!dist || !outFile) {
  console.error("usage: node freeze-hooks.mjs <dist> <out.json>");
  process.exit(1);
}
const imp = (p) => import(pathToFileURL(path.join(path.resolve(dist), p)).href);
const { parse } = await imp("parser/index.js");
const { claudeCodeBinding } = await imp("bindings/claude-code.js");
const { codexBinding } = await imp("bindings/codex.js");
const lib = { parse, bindings: { "claude-code": claudeCodeBinding, codex: codexBinding } };

const t0 = Date.now();
const rows = await runCorpus(lib);
const bad = rows.filter((r) => r.exit !== 0 && r.exit !== 2);
const version = JSON.parse(fs.readFileSync(path.join(path.resolve(dist), "..", "package.json"), "utf8")).version;
fs.writeFileSync(outFile, JSON.stringify({ version, count: rows.length, rows }, null, 0).replace(/\},\{/g, "},\n{") + "\n");
console.log(`${rows.length} pairs in ${((Date.now() - t0) / 1000).toFixed(1)} s; exit other than 0 or 2: ${bad.length}`);
for (const r of bad.slice(0, 20)) console.log("  ", JSON.stringify(r));
