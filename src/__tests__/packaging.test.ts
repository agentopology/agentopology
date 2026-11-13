import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
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
});
