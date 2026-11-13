import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { collectInventory } from "../inventory/index.js";

describe("[I011b] inventory roots cannot be walked around", () => {
  it("[I011b] a root that is a symlink pointing outside the project lists nothing", () => {
    const outside = fs.mkdtempSync(join(os.tmpdir(), "i011b-out-"));
    fs.writeFileSync(join(outside, "secret.txt"), "x");
    const proj = fs.mkdtempSync(join(os.tmpdir(), "i011b-proj-"));
    fs.symlinkSync(outside, join(proj, "harness"));
    const items = collectInventory(proj, { roots: ["harness/"] });
    expect(items.filter((i) => i.kind === "file")).toEqual([]);
  });
  it("[I011b] a folder inside a root that is a symlink out is not followed", () => {
    const outside = fs.mkdtempSync(join(os.tmpdir(), "i011b-out-"));
    fs.writeFileSync(join(outside, "secret.txt"), "x");
    const proj = fs.mkdtempSync(join(os.tmpdir(), "i011b-proj-"));
    fs.mkdirSync(join(proj, "harness"));
    fs.writeFileSync(join(proj, "harness", "ok.py"), "x");
    fs.symlinkSync(outside, join(proj, "harness", "link"));
    const files = collectInventory(proj, { roots: ["harness/"] }).filter((i) => i.kind === "file").map((i) => i.path);
    expect(files).toEqual(["harness/ok.py"]);
  });
});
