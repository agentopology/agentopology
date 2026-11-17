/**
 * Write the stdin runner check (a helper that hands a gated tool its arguments from standard input) as
 * literal pieces (as0112-blocks-stdin.json), once, from a build's generator, so compile-runs.mjs as0112 can
 * cut it out exactly, as it cuts the earlier guard blocks:
 * - jqFunctions: at_stdin_runner and at_stdin_fed as the step reader writes them (column 0 in before-action.sh);
 * - jqCheck: the lines that replaced `[ "$k" -eq "${#r[@]}" ] || continue` in _seg_steps (jqCheckWas);
 * - noJq: the no-jq block, after the one line that sets AT_STDIN_TOOLS and AT_STDIN_GIT_STEPS.
 *
 *   node freeze-stdin-blocks.mjs <dist> <out.json>
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { TOPOLOGIES } from "./hook-corpus.mjs";

const [dist, outFile] = process.argv.slice(2);
if (!dist || !outFile) {
  console.error("usage: node freeze-stdin-blocks.mjs <dist> <out.json>");
  process.exit(1);
}
const imp = (p) => import(pathToFileURL(path.join(path.resolve(dist), p)).href);
const { parse } = await imp("parser/index.js");
const { claudeCodeBinding } = await imp("bindings/claude-code.js");
console.warn = () => {};

const lines = String(claudeCodeBinding.scaffold(parse(TOPOLOGIES.find((t) => t.id === "factory").src()))
  .find((x) => x.path.endsWith("/before-action.sh")).content).split("\n");
/** Lines from the one starting with FROM up to the first starting with TO at or after line UNTIL. */
const upTo = (from, to, until = 0) => {
  const a = lines.findIndex((l) => l.startsWith(from));
  const e = lines.findIndex((l, i) => i > a && i >= until && l.startsWith(to));
  if (a < 0 || e < 0) throw new Error(`no block from ${from} to ${to}`);
  return lines.slice(a, e + 1).join("\n");
};
const fed = lines.findIndex((l) => l.startsWith("at_stdin_fed() {"));
const jqFunctions = upTo("# at_stdin_runner WORD", "}", fed);
const jqCheck = upTo('    if [ "$k" -lt "${#r[@]}" ]; then', "    fi");
const head = lines.findIndex((l) => l.startsWith("  AT_STDIN_TOOLS=("));
const loop = lines.findIndex((l) => l.includes('if at_stdin_program "$AT_S"'));
const noJq = upTo("  # A gated tool run by a stdin runner", "  done", loop);
if (fed < 0 || loop < 0 || head < 0 || !lines[head + 1].startsWith("  # A gated tool run by a stdin runner")) throw new Error("the stdin blocks are not where expected");

const out = { jqFunctions, jqCheck, jqCheckWas: '    [ "$k" -eq "${#r[@]}" ] || continue', noJq };
fs.writeFileSync(outFile, JSON.stringify(out, null, 1) + "\n");
console.log(`wrote ${outFile}`);
