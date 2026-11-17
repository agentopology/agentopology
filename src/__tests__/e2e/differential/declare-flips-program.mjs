/**
 * Declare, once and by rule, how the program-word corpus (PROGRAM_WORD_COMMANDS, frozen from a v0.11.4
 * build in hooks-0114-program.json) moves (hooks-0114-program-flips.json). The rules are in
 * hook-rules.mjs, written from the topologies' gated words, not from the hooks' code:
 *
 * - with jq, before-action.sh: a pair 0.11.4 let through goes 0 -> 2 when a program word names a gated
 *   tool and the step's words follow, or the word is a brace expansion that names it (jqNames);
 * - with jq, the Codex if filter (at-if.sh): the same, for the hook's glob (git push*); a hook that is not
 *   strength: refuse matches only a step, not a brace doubt;
 * - with no jq, before-action.sh: the pair exits 2 when its payload could hold a gated step (couldHold)
 *   and 0 otherwise; every pair where that differs from 0.11.4 is declared, either way;
 * - with no jq, at-if.sh: no change (it blocks).
 *
 *   node declare-flips-program.mjs <hooks-0114-program.json> <flips.json>
 */

import fs from "node:fs";
import { GUARDED, IF_GUARDED, couldHold, jqNames, payloadOf } from "./hook-rules.mjs";

const [frozenFile, outFile] = process.argv.slice(2);
if (!frozenFile || !outFile) {
  console.error("usage: node declare-flips-program.mjs <hooks-0114-program.json> <flips.json>");
  process.exit(1);
}

const frozen = JSON.parse(fs.readFileSync(frozenFile, "utf8"));
if (frozen.version !== "0.11.4") throw new Error(`expected a 0.11.4 freeze, got ${frozen.version}`);
const flips = [];
for (const r of frozen.rows) {
  let now = r.exit;
  let why = "";
  if (r.hook === "at-if.sh") {
    const g = IF_GUARDED[r.topology];
    if (r.jq && r.exit === 0 && jqNames(r.input, g, { doubt: g.refuse })) { now = 2; why = "the program word names the hook's tool"; }
  } else if (r.jq) {
    if (r.exit === 0 && jqNames(r.input, GUARDED[r.topology])) { now = 2; why = "the program word names a gated tool"; }
  } else {
    now = couldHold(r.hook, r.topology, payloadOf(r)) ? 2 : 0;
    why = now === 2 ? "no jq, the payload names a gated step" : "no jq, no gated word in the payload";
  }
  if (now !== r.exit) flips.push({ topology: r.topology, binding: r.binding, hook: r.hook, input: r.input, jq: r.jq, from: r.exit, to: now, why });
}
fs.writeFileSync(outFile, JSON.stringify({ count: flips.length, flips }, null, 0).replace(/\},\{/g, "},\n{") + "\n");
const by = {};
for (const f of flips) { const k = `${f.from}->${f.to} ${f.jq ? "jq" : "nojq"} ${f.topology}|${f.binding}|${f.hook}`; by[k] = (by[k] ?? 0) + 1; }
console.log(`${flips.length} declared changes`);
for (const [k, n] of Object.entries(by).sort()) console.log(`  ${k}: ${n}`);
