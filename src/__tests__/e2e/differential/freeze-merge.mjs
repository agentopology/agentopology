/**
 * Freeze what v0.11.2 writes to settings.json and prints, step by step, for
 * every scaffold → edit → re-scaffold sequence (merge-0112.json): this
 * branch's own sequences, the 0.11.3 attack's (hk T1-T36, f2 1-16) and its
 * import → validate → scaffold flow (rt, 58 harnesses).
 *
 *   node freeze-merge.mjs <v0.11.2 dist/cli/index.js> <out.json>
 */

import fs from "node:fs";
import { runSequence } from "./merge-sequences.mjs";
import { ALL_SEQUENCES } from "./fable-sequences.mjs";

const [cli, outFile] = process.argv.slice(2);
if (!cli || !outFile) {
  console.error("usage: node freeze-merge.mjs <v0.11.2 dist/cli/index.js> <out.json>");
  process.exit(1);
}
const sequences = ALL_SEQUENCES.map((s) => ({ name: s.name, steps: runSequence(cli, s) }));
const steps = sequences.reduce((n, s) => n + s.steps.length, 0);
fs.writeFileSync(outFile, JSON.stringify({ version: "0.11.2", sequences }, null, 1) + "\n");
console.log(`${sequences.length} sequences, ${steps} CLI steps`);
