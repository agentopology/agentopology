/**
 * What `import` does with the .at it writes.
 *
 * S-67 (measured on 0.11.2): a second `import --output <dir>` silently replaced
 * the .at already there; a line the user had added to it was gone.
 * S-68 (measured on 0.11.2): import printed "2 error(s)" for the .at it wrote
 * and still exited 0, so a script could not tell.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
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
