/**
 * What `import` does with the .at it writes.
 *
 * S-67 (measured on 0.11.2): a second `import --output <dir>` silently replaced
 * the .at already there; a line the user had added to it was gone.
 * S-68 (measured on 0.11.2): import printed "2 error(s)" for the .at it wrote
 * and still exited 0, so a script could not tell.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../../../dist/cli/index.js");

let root: string;
const put = (rel: string, content: string) => {
  fs.mkdirSync(dirname(join(root, rel)), { recursive: true });
  fs.writeFileSync(join(root, rel), content);
};
const out = () => join(root, "o", "shop.at");
const run = (...extra: string[]) => {
  const r = spawnSync(process.execPath, [CLI, "import", "--target", "claude-code", "--dir", root, "--name", "shop", "--output", join(root, "o"), ...extra], { encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, all: `${r.stdout}${r.stderr}` };
};
const hooks = (list: object[]) => put(".claude/settings.json", JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: list }] } }));

beforeEach(() => {
  root = fs.mkdtempSync(join(os.tmpdir(), "at-import-out-"));
  put(".claude/agents/writer.md", "---\nname: writer\ndescription: w\n---\n\nWrite.\n");
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("S-67: import does not overwrite an existing .at unless told to", () => {
  it("[S-67] the first import writes the .at", () => {
    const r = run();
    expect(r.code).toBe(0);
    expect(fs.existsSync(out())).toBe(true);
  });

  it("[S-67] a second import refuses with one line, exits 1, and leaves the file as it was", () => {
    put("o/shop.at", "# my marker line\n");
    const r = run();
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`Error: ${out()} exists; pass --force to overwrite. Nothing was written.`);
    expect(fs.readFileSync(out(), "utf-8")).toBe("# my marker line\n");
    expect(r.stdout).not.toContain("Written:");
  });

  it("[S-67] a link at the output path counts as there, even when it points nowhere", () => {
    fs.mkdirSync(join(root, "o"));
    fs.symlinkSync(join(root, "nowhere.at"), out());
    const r = run();
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`Error: ${out()} exists; pass --force to overwrite.`);
    expect(fs.existsSync(join(root, "nowhere.at"))).toBe(false);
  });

  it("[S-67] with --force the existing .at is overwritten", () => {
    put("o/shop.at", "# my marker line\n");
    const r = run("--force");
    expect(r.code).toBe(0);
    const text = fs.readFileSync(out(), "utf-8");
    expect(text).not.toContain("# my marker line");
    expect(text).toContain("agent writer");
  });
});

describe("S-68: import exits non-zero when the .at it wrote has validation errors", () => {
  it("[S-68] errors: the file is written, a loud line names the count, exit 2", () => {
    hooks([{ type: "command" }]);
    const r = run();
    expect(r.code).toBe(2);
    expect(fs.existsSync(out())).toBe(true);
    // A bare command hook is two errors; the next test ties the count to validate's.
    expect(r.all).toContain(`import: the .at it wrote has 2 validation error(s); fix them, or run validate ${out()} for details`);
  });

  it("[S-68] the count is the one validate reports for the written file", () => {
    hooks([{ type: "command" }, { type: "http" }]);
    const r = run();
    expect(r.code).toBe(2);
    const v = spawnSync(process.execPath, [CLI, "validate", out()], { encoding: "utf8" });
    expect(v.status).toBe(1);
    const n = Number(/(\d+) error\(s\)/.exec(`${v.stdout}${v.stderr}`)?.[1]);
    expect(n).toBeGreaterThan(1);
    expect(r.all).toContain(`the .at it wrote has ${n} validation error(s)`);
  });

  it("[S-68] a written .at that does not parse counts as one error, as in validate", () => {
    const r = spawnSync(process.execPath, [CLI, "import", "--target", "claude-code", "--dir", root, "--name", "my shop", "--output", join(root, "o")], { encoding: "utf8" });
    const file = join(root, "o", "my shop.at");
    expect(r.status).toBe(2);
    expect(fs.existsSync(file)).toBe(true);
    expect(`${r.stdout}${r.stderr}`).toContain("Parse error in generated file:");
    expect(r.stderr).toContain(`import: the .at it wrote has 1 validation error(s); fix them, or run validate ${file} for details`);
    expect(spawnSync(process.execPath, [CLI, "validate", file], { encoding: "utf8" }).status).toBe(1);
  });

  it("[S-68] warnings only: exit 0", () => {
    hooks([{ type: "command", command: "exit 1" }]);
    const r = run();
    expect(r.all).toContain("0 error(s), 1 warning(s)");
    expect(r.code).toBe(0);
  });

  it("[S-68] no findings: exit 0", () => {
    const r = run();
    expect(r.all).toContain("Generated file passes all validation rules.");
    expect(r.code).toBe(0);
  });
});

describe("F3/F4: the output path, under concurrency and when it is not a file", () => {
  it("[F-4] the refusal prints before anything else: no \"Importing from\" line", () => {
    put("o/shop.at", "# mine\n");
    const r = run();
    expect(r.code).toBe(1);
    expect(r.stdout).not.toContain("Importing from");
  });

  it("[F-3] of 8 concurrent imports to one fresh path, exactly 1 writes and 7 refuse", async () => {
    const codes = await Promise.all(Array.from({ length: 8 }, () => new Promise<number | null>((done) => {
      const p = spawn(process.execPath, [CLI, "import", "--target", "claude-code", "--dir", root, "--name", "shop", "--output", join(root, "o")], { stdio: "ignore" });
      p.on("close", (code) => done(code));
    })));
    expect(codes.filter((c) => c === 0)).toHaveLength(1);
    expect(codes.filter((c) => c === 1)).toHaveLength(7);
    expect(fs.readFileSync(out(), "utf-8").trimEnd().endsWith("}")).toBe(true);
  });

  it("[F-4] a directory at <name>.at: a clear message, no --force hint, exit 1, the directory untouched", () => {
    put("o/shop.at/keep.txt", "x");
    const r = run();
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`Error: ${out()} is a directory, not a .at file. Nothing was written.`);
    expect(r.stderr).not.toContain("--force");
    expect(fs.readdirSync(out())).toEqual(["keep.txt"]);
  });

  it("[F-4] a directory at <name>.at with --force: the same clear message, no stack, exit 1", () => {
    put("o/shop.at/keep.txt", "x");
    const r = run("--force");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`Error: ${out()} is a directory, not a .at file. Nothing was written.`);
    expect(r.all).not.toMatch(/EISDIR|\n\s+at /);
    expect(fs.readdirSync(out())).toEqual(["keep.txt"]);
  });

  it("[F-4] --output naming a file: a clear message, exit 1, the file untouched", () => {
    put("o", "a file\n");
    const r = run();
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`Error: --output ${join(root, "o")} is not a directory. Nothing was written.`);
    expect(r.all).not.toMatch(/ENOTDIR|EEXIST|\n\s+at /);
    expect(fs.readFileSync(join(root, "o"), "utf-8")).toBe("a file\n");
  });
});
