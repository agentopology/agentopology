/**
 * The published tarball holds only what the current src/ compiles to.
 *
 * Measured on rc3: dist/ was never cleared, so the tarball still shipped
 * dist/guard/exit127.js after src/guard/exit127.ts was removed. The build now
 * clears dist/ first (package.json "build"), and the test build runs that same
 * script (global-setup.ts).
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Every .ts under src/ (not .d.ts), as the four files tsc emits for it. */
function expectedDist(): Set<string> {
  const out = new Set<string>();
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) {
        const stem = relative(join(root, "src"), p).replace(/\.ts$/, "");
        for (const ext of [".js", ".js.map", ".d.ts", ".d.ts.map"]) out.add(`dist/${stem}${ext}`);
      }
    }
  };
  walk(join(root, "src"));
  return out;
}

describe("[clean-pack] the tarball holds no dist file the current src does not produce", () => {
  it("npm pack lists no orphan under dist/", () => {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const json = execFileSync(npm, ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const files: string[] = JSON.parse(json)[0].files.map((f: { path: string }) => f.path);
    const expected = expectedDist();
    const orphans = files.filter((f) => f.startsWith("dist/") && !expected.has(f));
    expect(orphans).toEqual([]);
  }, 120_000);

  it("the build script clears dist/ before it compiles", () => {
    const pkg = JSON.parse(fs.readFileSync(join(root, "package.json"), "utf8"));
    expect(pkg.scripts.build).toMatch(/rmSync\('dist'/);
  });
});
