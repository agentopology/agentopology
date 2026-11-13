#!/usr/bin/env node
// The tick: one GET per platform to the npm registry, then every stable version
// published since the last one seen. Exit 0 on no change, 10 on new versions,
// 2 when the registry answer cannot be read (the watch itself is broken).
//
//   node scripts/release-watch/tick.mjs --platform claude-code --since 2.1.319
//   node scripts/release-watch/tick.mjs --platform codex --state-file state.json
//   add --registry-file doc.json to read a saved registry document (tests do)
//
// Needs `npm run build` first: it reads dist/watch/versions.js.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const { newVersions, tickExitCode, BlindTick } = await import(path.join(here, "../../dist/watch/versions.js"));

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i < 0 ? undefined : args[i + 1]; };
const PACKAGES = { "claude-code": "@anthropic-ai/claude-code", codex: "@openai/codex" };

const platform = opt("platform");
if (!PACKAGES[platform]) { console.error("tick: --platform must be claude-code or codex"); process.exit(2); }

let since = opt("since");
const stateFile = opt("state-file");
if (!since && stateFile && fs.existsSync(stateFile)) since = JSON.parse(fs.readFileSync(stateFile, "utf8"))[platform];
if (!since) { console.error("tick: give --since <version> or a --state-file that holds the platform"); process.exit(2); }

try {
  let doc;
  const file = opt("registry-file");
  if (file) doc = JSON.parse(fs.readFileSync(file, "utf8"));
  else {
    const res = await fetch(`https://registry.npmjs.org/${PACKAGES[platform]}`, { headers: { accept: "application/json", "user-agent": "release-watch" } });
    if (!res.ok) throw new Error(`registry answered ${res.status}`);
    doc = await res.json();
  }
  const result = newVersions(platform, doc, since);
  console.log(JSON.stringify(result));
  process.exit(tickExitCode(result.versions));
} catch (e) {
  console.error(`tick: ${e instanceof BlindTick ? "blind: " : ""}${e.message}`);
  process.exit(2);
}
