import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const pkg = JSON.parse(fs.readFileSync(resolve(root, "package.json"), "utf8"));

describe("packaging", () => {
  it("[N47] package.json does not list its own name as a dependency", () => {
    const fields = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
    const found = fields.filter((f) => pkg[f] && Object.prototype.hasOwnProperty.call(pkg[f], pkg.name));
    expect(found, `${pkg.name} depends on itself in: ${found.join(", ")}`).toEqual([]);
  });

  // Reads the built dist: run after `npm run build`.
  it.skipIf(!fs.existsSync(resolve(root, "dist/cli/index.js")))("the package ships no tests, and ships the CLI and the library entry", () => {
    const r = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8", timeout: 120_000 });
    expect(r.status, r.stderr).toBe(0);
    const paths = (JSON.parse(r.stdout) as Array<{ files: Array<{ path: string }> }>)[0].files.map((f) => f.path);
    expect(paths.filter((p) => p.includes("__tests__"))).toEqual([]);
    expect(paths).toContain("dist/cli/index.js");
    expect(paths).toContain("dist/index.js");
  });
});
