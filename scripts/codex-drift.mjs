#!/usr/bin/env node
/**
 * Has Codex's hook contract moved since we last checked?
 *
 *   node scripts/codex-drift.mjs                   fetch the hooks page, diff it with the snapshot, exit 1 on drift
 *   node scripts/codex-drift.mjs --from <file.md>  diff a saved copy instead of fetching
 *   node scripts/codex-drift.mjs --snapshot <file> diff against another snapshot file
 *   node scripts/codex-drift.mjs --features-from <file>
 *                                                  also diff `codex features list` output (saved) with spec/codex/features.json
 *   node scripts/codex-drift.mjs --write --codex <version>
 *                                                  accept the page as the new snapshot
 *
 * Needs `npm run build`. Suggested package.json line:
 *   "drift:codex": "node scripts/codex-drift.mjs"
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { extractCodexHookContract, diffCodexContracts, hasCodexDrift, renderCodexDiff, parseFeaturesList } from "../dist/conformance/extract-codex.js";

const SOURCE = "https://learn.chatgpt.com/docs/hooks.md";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };
const snapshotPath = opt("--snapshot") ?? path.join(root, "spec/codex/hooks-contract.json");
const featuresPath = path.join(root, "spec/codex/features.json");

const from = opt("--from");
let markdown;
try {
  markdown = from ? fs.readFileSync(from, "utf8") : await (await fetch(SOURCE)).text();
} catch (e) {
  console.error(`Could not read ${from ?? SOURCE}: ${e.message}`);
  process.exit(2);
}
const old = fs.existsSync(snapshotPath) ? JSON.parse(fs.readFileSync(snapshotPath, "utf8")) : null;
const codex = opt("--codex") ?? old?.codex ?? "unknown";
const now = extractCodexHookContract(markdown, { source: SOURCE, fetched: new Date().toISOString().slice(0, 10), codex });
if (now.events.length === 0) {
  console.error("No hook events found on the page: its layout changed or the fetch was refused. Re-check src/conformance/extract-codex.ts.");
  process.exit(2);
}
if (argv.includes("--write")) {
  fs.writeFileSync(snapshotPath, JSON.stringify(now, null, 2) + "\n");
  console.log(`wrote ${path.relative(root, snapshotPath)} (${now.events.length} events)`);
  process.exit(0);
}
if (!old) { console.error(`No snapshot at ${snapshotPath}; run with --write first.`); process.exit(2); }

const diff = diffCodexContracts(old, now);
console.log(`Codex hook contract: snapshot of ${old.fetched} (Codex ${old.codex}) vs ${from ?? SOURCE} today`);
for (const line of renderCodexDiff(diff)) console.log(`  ${line}`);
let drift = hasCodexDrift(diff);

const featuresFrom = opt("--features-from");
if (featuresFrom) {
  const snap = JSON.parse(fs.readFileSync(featuresPath, "utf8")).features;
  const live = parseFeaturesList(fs.readFileSync(featuresFrom, "utf8"));
  const key = (f) => `${f.name} ${f.stage} ${f.enabled}`;
  const changed = [
    ...live.filter((f) => !snap.some((s) => key(s) === key(f))).map((f) => `now: ${key(f)}`),
    ...snap.filter((s) => !live.some((f) => key(s) === key(f))).map((s) => `was: ${key(s)}`),
  ];
  console.log(`Codex features: ${changed.length ? "" : "no drift"}`);
  for (const c of changed) console.log(`  ${c}`);
  if (changed.length) drift = true;
}
process.exit(drift ? 1 : 0);
