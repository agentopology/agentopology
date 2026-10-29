/**
 * Build once before any test runs, so tests that execute `dist/cli/index.js`
 * always test the current source. They used to run whatever dist/ happened to
 * be on disk — a change could pass against stale output.
 */

import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export default function setup(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  execFileSync(process.execPath, [resolve(root, "node_modules/typescript/bin/tsc")], {
    cwd: root,
    stdio: "inherit",
  });
}
