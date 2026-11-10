#!/usr/bin/env node
/**
 * Has Claude Code's hook contract moved since we last checked?
 *
 *   node scripts/claude-code-drift.mjs                  fetch the hooks page, diff it with the snapshot, exit 1 on drift
 *   node scripts/claude-code-drift.mjs --from <file.md> diff a saved copy instead of fetching
 *   node scripts/claude-code-drift.mjs --write --claude-code <version>
 *                                                       accept the page as the new snapshot and re-derive the minimum
 *
 * The snapshot is spec/claude-code/hooks-contract.json; the minimum version's
 * contract (spec/claude-code/hooks-contract.<MINIMUM_VERSION>.json) is derived
 * from it by dropping what requires a newer version. Needs `npm run build`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { extractHookContract, contractAt, diffContracts, hasDrift, renderDiff } from "../dist/conformance/extract.js";
import { MINIMUM_VERSION } from "../dist/conformance/claude-code.js";

const SOURCE = "https://code.claude.com/docs/en/hooks.md";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const snapshotPath = path.join(root, "spec/claude-code/hooks-contract.json");
const minimumPath = path.join(root, `spec/claude-code/hooks-contract.${MINIMUM_VERSION}.json`);

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };
const write = argv.includes("--write");

const from = opt("--from");
const markdown = from ? fs.readFileSync(from, "utf8") : await (await fetch(SOURCE)).text();
const fetched = new Date().toISOString().slice(0, 10);

const old = fs.existsSync(snapshotPath) ? JSON.parse(fs.readFileSync(snapshotPath, "utf8")) : null;
const claudeCode = opt("--claude-code") ?? old?.claudeCode ?? "unknown";
const now = extractHookContract(markdown, { source: SOURCE, fetched, claudeCode });
if (now.events.length === 0) {
  console.error("No hook events found on the page: its layout changed. Re-check the extractor in src/conformance/extract.ts.");
  process.exit(2);
}

if (write) {
  fs.writeFileSync(snapshotPath, JSON.stringify(now, null, 2) + "\n");
  fs.writeFileSync(minimumPath, JSON.stringify(contractAt(now, MINIMUM_VERSION), null, 2) + "\n");
  console.log(`wrote ${path.relative(root, snapshotPath)} (${now.events.length} events) and ${path.relative(root, minimumPath)}`);
  process.exit(0);
}

if (!old) { console.error(`No snapshot at ${snapshotPath}; run with --write first.`); process.exit(2); }
const diff = diffContracts(old, now);
console.log(`Claude Code hook contract: snapshot of ${old.fetched} (Claude Code ${old.claudeCode}) vs ${from ?? SOURCE} today`);
for (const line of renderDiff(diff)) console.log(`  ${line}`);
process.exit(hasDrift(diff) ? 1 : 0);
