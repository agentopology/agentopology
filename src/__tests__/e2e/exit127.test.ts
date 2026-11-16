/**
 * Defence in depth for F1: validate and guard --check warn (CC-exit127) when
 * the command a hook or gate runs starts with something the shell cannot
 * find: a path missing from the project, or a name not on PATH. The shell
 * exits 127, and 127 does not block, so a guard written that way never holds.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../../../dist/cli/index.js");

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(join(os.tmpdir(), "at-127-"));
  fs.mkdirSync(join(root, ".claude"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const at = (hookRun: string, gateRun = "scripts/check.sh") => [
  "topology t : [pipeline] {",
  "  meta {", '    version: "1.0.0"', '    description: "t"', "  }",
  "  orchestrator {", "    model: sonnet", "  }",
  "  agent a {", "    model: sonnet", '    description: "a"', "  }",
  "  agent b {", "    model: sonnet", '    description: "b"', "  }",
  "  flow { a -> b }",
  "  gates {", "    gate g {", "      after: a", "      before: b", `      run: ${JSON.stringify(gateRun)}`, "    }", "  }",
  "  hooks {",
  "    hook h {", "      on: PreToolUse", '      matcher: "Bash"', `      run: ${JSON.stringify(hookRun)}`, "      type: command", "    }",
  "  }",
  "}",
].join("\n");
const cli = (...args: string[]) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  return { code: r.status, all: `${r.stdout}${r.stderr}` };
};
const write = (src: string) => fs.writeFileSync(join(root, "t.at"), src);

describe("CC-exit127: validate", () => {
  it("[127] a hook whose command starts with a project path that is missing warns, and naming the path", () => {
    write(at("./tools/guard.sh 2>/dev/null"));
    const r = cli("validate", "t.at");
    expect(r.all).toContain("CC-exit127");
    expect(r.all).toMatch(/Hook "h".*tools\/guard\.sh.*not found/);
    expect(r.code).toBe(0); // a warning, not an error
  });

  it("[127] the same hook, once the file exists, does not warn", () => {
    write(at("./tools/guard.sh 2>/dev/null"));
    fs.mkdirSync(join(root, "tools"));
    fs.writeFileSync(join(root, "tools/guard.sh"), "exit 0\n");
    expect(cli("validate", "t.at").all).not.toContain("CC-exit127");
  });

  it("[127] a name that is not on PATH warns", () => {
    write(at("no-such-tool-at127 --x | tee /dev/null"));
    const r = cli("validate", "t.at");
    expect(r.all).toContain("CC-exit127");
    expect(r.all).toContain("no-such-tool-at127");
    expect(r.all).toMatch(/not on PATH/);
  });

  it("[127] a PATH tool that exists does not warn, nor a topology script (scaffold writes it)", () => {
    write(at("sh -c 'exit 0' 2>/dev/null"));
    expect(cli("validate", "t.at").all).not.toContain("CC-exit127");
    write(at("scripts/guard.sh 2>/dev/null"));
    expect(cli("validate", "t.at").all).not.toContain("CC-exit127");
  });

  it("[127] a gate whose command starts with a missing path warns", () => {
    write(at("scripts/guard.sh", "./tools/check.sh > /dev/null"));
    const r = cli("validate", "t.at");
    expect(r.all).toMatch(/CC-exit127.*Gate "g".*tools\/check\.sh/);
  });
});

describe("CC-exit127: guard --check", () => {
  it("[127] names the hook whose command cannot be found, and not one that can", () => {
    write(at("./tools/guard.sh 2>/dev/null"));
    const bad = cli("guard", "t.at", "--check", "--dir", ".");
    expect(bad.all).toContain("CC-exit127");
    expect(bad.all).toContain("tools/guard.sh");
    write(at("sh -c 'exit 0'"));
    expect(cli("guard", "t.at", "--check", "--dir", ".").all).not.toContain("CC-exit127");
  });
});
