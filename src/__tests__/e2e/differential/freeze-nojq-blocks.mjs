/**
 * Write the no-jq block of the word reading as literal pieces (as0112-blocks-words.json), once, from a
 * build's generator, so compile-runs.mjs as0112 can cut it out exactly (as it cuts 0.11.4's block, from
 * as0112-blocks.json). Between the pieces stand only the lines that name the gated words. Also at_names
 * and at_brace_names as the step reader writes them (atNames), which as0112 puts back to 0.11.2's at_names.
 *
 *   node freeze-nojq-blocks.mjs <dist> <out.json>
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { TOPOLOGIES } from "./hook-corpus.mjs";

const [dist, outFile] = process.argv.slice(2);
if (!dist || !outFile) {
  console.error("usage: node freeze-nojq-blocks.mjs <dist> <out.json>");
  process.exit(1);
}
const imp = (p) => import(pathToFileURL(path.join(path.resolve(dist), p)).href);
const { parse } = await imp("parser/index.js");
const { claudeCodeBinding } = await imp("bindings/claude-code.js");
console.warn = () => {};

const block = (id, hook) => {
  const f = claudeCodeBinding.scaffold(parse(TOPOLOGIES.find((t) => t.id === id).src())).find((x) => x.path.endsWith(`/${hook}`));
  const lines = String(f.content).split("\n");
  const a = lines.findIndex((l) => l.startsWith("if ! command -v jq"));
  const e = lines.findIndex((l, i) => i > a && l === "fi");
  return lines.slice(a, e + 1);
};
const upTo = (lines, from, to) => {
  const a = lines.findIndex((l) => l.startsWith(from));
  const e = lines.findIndex((l, i) => i >= a && l.startsWith(to));
  if (a < 0 || e < 0) throw new Error(`no block from ${from} to ${to}`);
  return lines.slice(a, e + 1).join("\n");
};

const action = block("ship", "before-action.sh");
const agent = block("compile", "before-agent.sh");
const edit = block("ship", "before-edit.sh");
const head = (lines) => upTo(lines, "if ! command -v jq", "  at_raw_has() {");
const words = (lines) => upTo(lines, "  # The payload's words", "  at_words_has() {");

const glob = upTo(action, "  # A glob", "  done");
// the two lines that name the gated tools: `for k in 'git' ...; do`
const [globA, rest] = glob.split(/(?<=\n    for k in )'[^\n]*?(?=; do )/);
const [globB, globC] = rest.split(/(?<=for k in )'[^\n]*?(?=; do )/);
// at_names and at_brace_names as MATCH_FUNCTIONS writes them (column 0 in before-action.sh)
const full = String(claudeCodeBinding.scaffold(parse(TOPOLOGIES.find((t) => t.id === "ship").src())).find((x) => x.path.endsWith("/before-action.sh")).content).split("\n");
const atNames = upTo(full, "# at_names WORD KEY", "# at_runs_args").split("\n").slice(0, -1).join("\n");
const exp = action.find((l) => l.startsWith("  AT_RE="));
const expIf = action.find((l) => l.startsWith("  if [[ $AT_RAW =="));

const out = {
  head: { "before-action.sh": head(action), "before-agent.sh": head(agent), "before-edit.sh": head(edit) },
  words: { "before-action.sh": words(action), "before-agent.sh": words(agent) },
  powershell: "  if at_words_has powershell && { ",
  expansionHead: `${exp}\n${expIf.slice(0, expIf.indexOf("&& { ") + 5)}`,
  globA,
  globB,
  globC,
  atNames,
};
if (!globA.endsWith("for k in ") || !globB.startsWith("; do") || !globC.startsWith("; do")) throw new Error("the glob block did not split as expected");
fs.writeFileSync(outFile, JSON.stringify(out, null, 1) + "\n");
console.log(`wrote ${outFile}`);
