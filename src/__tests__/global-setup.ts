/**
 * Build once before any test runs, so tests that execute `dist/cli/index.js`
 * always test the current source. They used to run whatever dist/ happened to
 * be on disk — a change could pass against stale output.
 *
 * It runs the package's own build script, which clears dist/ first, so a
 * file whose source was removed is gone here as it is from the tarball
 * (clean-pack.test.ts).
 */

import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export default function setup(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "--silent", "build"], {
    cwd: root,
    stdio: "inherit",
  });
}
