/**
 * Declare, once and by rule, which frozen 0.11.4 hook pairs the no-jq word
 * reading turns from exit 2 into exit 0 (hooks-0114-words-flips.json). The
 * rule (couldHold, hook-rules.mjs) is written from the topologies' gated
 * words and the corpus payloads (parsed with JSON.parse), not from the
 * hooks' code.
 *
 * Only no-jq pairs of before-action.sh and before-agent.sh can flip. With
 * jq nothing changes here, before-edit.sh is unchanged, and the Codex if
 * filter (at-if.sh) still blocks with no jq. A pair 0.11.4 refused flips
 * when its payload could not hold what the hook guards.
 *
 *   node declare-flips-words.mjs <hooks-0114.json> <flips.json>
 */

import fs from "node:fs";
import { couldHold, payloadOf } from "./hook-rules.mjs";

const [frozenFile, outFile] = process.argv.slice(2);
if (!frozenFile || !outFile) {
  console.error("usage: node declare-flips-words.mjs <hooks-0114.json> <flips.json>");
  process.exit(1);
}

const frozen = JSON.parse(fs.readFileSync(frozenFile, "utf8"));
if (frozen.version !== "0.11.4") throw new Error(`expected a 0.11.4 freeze, got ${frozen.version}`);
const flips = [];
for (const r of frozen.rows) {
  if (r.jq || r.exit !== 2 || r.hook === "at-if.sh" || r.hook === "before-edit.sh") continue;
  if (!couldHold(r.hook, r.topology, payloadOf(r))) {
    flips.push({ topology: r.topology, binding: r.binding, hook: r.hook, input: r.input, jq: r.jq, why: "no jq, no gated word in the payload" });
  }
}
fs.writeFileSync(outFile, JSON.stringify({ count: flips.length, flips }, null, 0).replace(/\},\{/g, "},\n{") + "\n");
const by = {};
for (const f of flips) { const k = `${f.topology}|${f.binding}|${f.hook}`; by[k] = (by[k] ?? 0) + 1; }
console.log(`${flips.length} declared 2->0 flips (no jq)`);
for (const [k, n] of Object.entries(by)) console.log(`  ${k}: ${n}`);
