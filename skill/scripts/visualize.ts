#!/usr/bin/env npx tsx
/**
 * visualize.ts -- Parse an .at file and generate an interactive HTML visualization.
 *
 * Usage:  npx tsx visualize.ts path/to/file.at [output-dir]
 *
 * Writes <basename>-topology.html alongside the .at file (or into output-dir)
 * and opens it in the default browser.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname, basename, join } from "node:path";
import { execSync } from "node:child_process";

import { parse } from "../../../../src/index.js";
import { generateVisualization } from "../../../../src/visualizer/index.js";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const atPath = process.argv[2];
if (!atPath) {
  console.error("Usage: npx tsx visualize.ts <file.at> [output-dir]");
  process.exit(1);
}

const resolvedAt = resolve(atPath);
const outputDir = process.argv[3] ? resolve(process.argv[3]) : dirname(resolvedAt);

// ---------------------------------------------------------------------------
// 1. Read the .at file
// ---------------------------------------------------------------------------

let source: string;
try {
  source = readFileSync(resolvedAt, "utf-8");
} catch (err: any) {
  console.error(`Error: Cannot read file "${resolvedAt}"`);
  console.error(err.message);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. Parse
// ---------------------------------------------------------------------------

let ast: ReturnType<typeof parse>;
try {
  ast = parse(source);
} catch (err: any) {
  console.error(`Parse error in "${resolvedAt}":`);
  console.error(err.message);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 3. Generate HTML
// ---------------------------------------------------------------------------

const html = generateVisualization(ast);

// ---------------------------------------------------------------------------
// 4. Write output
// ---------------------------------------------------------------------------

const stem = basename(resolvedAt, ".at");
const outFile = join(outputDir, `${stem}-topology.html`);

try {
  writeFileSync(outFile, html, "utf-8");
} catch (err: any) {
  console.error(`Error: Cannot write "${outFile}"`);
  console.error(err.message);
  process.exit(1);
}

console.log(outFile);

// ---------------------------------------------------------------------------
// 5. Open in browser
// ---------------------------------------------------------------------------

const openCmd = process.platform === "darwin" ? "open" : "xdg-open";
try {
  execSync(`${openCmd} "${outFile}"`, { stdio: "ignore" });
} catch {
  // Non-fatal -- the file was written successfully regardless.
}
