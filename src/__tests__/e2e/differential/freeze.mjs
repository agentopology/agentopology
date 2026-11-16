/**
 * Freeze what v0.11.2 resolves each hook and gate `run:` to (runs-0112.json).
 *
 *   node freeze.mjs <v0.11.2 dist> <examples dir> <out.json> [extra-corpus.json]
 *
 * The corpus: every run in examples/*.at, the shapes of the 0.11.3 attack
 * (extra-corpus.json: [{ source, kind, run }]), and a cross product of first
 * word × operator × interpreter. Each is compiled as a hook and as a gate.
 * Run it once against a v0.11.2 build; the differential test then holds this
 * branch to the frozen output.
 */

import fs from "node:fs";
import path from "node:path";
import { baselinesFor, compileRun, loadLib } from "./compile-runs.mjs";

const [dist, examples, outFile, extra] = process.argv.slice(2);
if (!dist || !examples || !outFile) {
  console.error("usage: node freeze.mjs <v0.11.2 dist> <examples dir> <out.json> [extra-corpus.json]");
  process.exit(1);
}

const FIRST = [
  "scripts/x.sh", "x.sh", "sub/x.sh", "./x.sh", ".claude/hooks/x.sh", '"$CLAUDE_PROJECT_DIR"/x.sh',
  "check-review", "lint-tool", "git status", "jq .", "prettier --write .", "command x", "FOO=1 x",
];
const OPERATOR = ["", " 2>/dev/null", " > /dev/null", " || exit 2", " || true", " | cat", " && y", " ; z"];
const INTERPRETER = ["", "bash ", "sh ", "node ", "python3 ", "bun ", "deno run "];

const lib = await loadLib(path.resolve(dist));
const corpus = new Map();
const add = (source, kind, run) => {
  const key = `${kind}\u0000${run}`;
  if (!corpus.has(key)) corpus.set(key, { source, kind, run });
};

for (const f of fs.readdirSync(examples).filter((n) => n.endsWith(".at")).sort()) {
  const ast = lib.parse(fs.readFileSync(path.join(examples, f), "utf-8"));
  const runs = [
    ...(ast.hooks ?? []).filter((h) => (h.type ?? "command") === "command").map((h) => h.run),
    ...ast.nodes.flatMap((n) => (n.type === "agent" ? (n.hooks ?? []).filter((h) => (h.type ?? "command") === "command").map((h) => h.run) : [])),
    ...ast.nodes.filter((n) => n.type === "gate").map((g) => g.run),
  ].filter((r) => typeof r === "string" && r.length > 0);
  for (const r of runs) {
    add(`examples/${f}`, "hook", r);
    add(`examples/${f}`, "gate", r);
  }
}
if (extra) for (const e of JSON.parse(fs.readFileSync(extra, "utf-8"))) add(e.source, e.kind, e.run);
for (const i of INTERPRETER) for (const w of FIRST) for (const o of OPERATOR) {
  add("cross", "hook", `${i}${w}${o}`);
  add("cross", "gate", `${i}${w}${o}`);
}

const baselines = baselinesFor(lib);
const rows = [...corpus.values()].map((c) => ({ ...c, ...compileRun(lib, c.kind, c.run, baselines) }));
fs.writeFileSync(outFile, JSON.stringify({ version: "0.11.2", count: rows.length, rows }, null, 1) + "\n");
const refused = rows.filter((r) => r.refused).length;
console.log(`${rows.length} runs: ${rows.length - refused} resolved, ${refused} refused`);
