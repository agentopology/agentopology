/**
 * `validate --inventory` reports where the .at and a file's frontmatter
 * disagree, key by key, and writes nothing.
 *
 * Coverage used to decide "mapped" by path only: an agent whose model, tools
 * and description all differed from the .at still counted as covered, with
 * no line about it. Exit codes: 0 in sync, 1 errors or missing files, 3 drift
 * (and nothing worse).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../../../dist/cli/index.js");

function cli(args: string[]): { out: string; stdout: string; code: number } {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { out, stdout: out, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { out: `${e.stdout ?? ""}${e.stderr ?? ""}`, stdout: e.stdout ?? "", code: e.status ?? 1 };
  }
}

let tmp: string;
let project: string;
let at: string;
const file = (rel: string) => join(project, rel);
const put = (rel: string, content: string) => {
  fs.mkdirSync(dirname(file(rel)), { recursive: true });
  fs.writeFileSync(file(rel), content);
};
const editAt = (from: string, to: string) => fs.writeFileSync(at, fs.readFileSync(at, "utf-8").replace(from, to));
const validate = (...extra: string[]) => cli(["validate", at, "--inventory", project, ...extra]);
const scaffold = () => cli(["scaffold", at, "--target", "claude-code", "--output", project]);

const AGENT = ".claude/agents/builder.md";
const AGENT_TEXT = ["---", "name: builder", "description: Builds the thing", "model: sonnet", "tools: Read, Grep", "---", "", "PROSE.", ""].join("\n");
const AT = `topology shop : [] {
  meta {
    version: "1.0.0"
  }

  agent builder {
    file: .claude/agents/builder.md
    model: sonnet
    description: "Builds the thing"
    tools: [Read, Grep]
    invocation: manual
  }
}
`;

beforeEach(() => {
  tmp = fs.mkdtempSync(join(os.tmpdir(), "at-drift-"));
  project = join(tmp, "project");
  at = join(tmp, "shop.at");
  put(AGENT, AGENT_TEXT);
  fs.writeFileSync(at, AT);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("validate --inventory: structure drift", () => {
  it("in sync: no drift section, exit 0", () => {
    const { code, out } = validate();
    expect(code, out).toBe(0);
    expect(out).not.toContain("Structure drift");
  });

  it("the .at changed two keys: one row each, exit 3, nothing written", () => {
    editAt("model: sonnet", "model: haiku");
    editAt("tools: [Read, Grep]", "tools: [Read, Grep, Bash]");
    const { code, out } = validate();
    expect(code, out).toBe(3);
    expect(out).toContain("Structure drift (2 of 3 owned keys)");
    expect(out).toMatch(/\.claude\/agents\/builder\.md\s+model\s+at-ahead\s+\.at haiku\s+file sonnet/);
    expect(out).toMatch(/\.claude\/agents\/builder\.md\s+tools\s+at-ahead\s+\.at \[Read, Grep, Bash\]\s+file \[Read, Grep\]/);
    expect(fs.readFileSync(file(AGENT), "utf-8")).toBe(AGENT_TEXT);
  });

  it("the file changed a key scaffold applied: file-ahead, with the last applied value", () => {
    editAt("model: sonnet", "model: haiku");
    scaffold();
    put(AGENT, fs.readFileSync(file(AGENT), "utf-8").replace("model: haiku", "model: opus"));
    const { code, out } = validate();
    expect(code, out).toBe(3);
    expect(out).toMatch(/model\s+file-ahead\s+\.at haiku\s+file opus\s+last applied haiku/);
  });

  it("--json prints the rows as JSON and nothing else", () => {
    editAt("model: sonnet", "model: haiku");
    const { code, stdout } = validate("--json");
    expect(code).toBe(3);
    const report = JSON.parse(stdout);
    expect(report.schema).toBe(1);
    expect(report.ownedKeys).toBe(3);
    expect(report.drift).toEqual([
      { path: AGENT, kind: "agent", id: "builder", key: "model", state: "at-ahead", at: "haiku", file: "sonnet", base: null },
    ]);
  });

  it("--json in sync: an empty drift list, exit 0", () => {
    const { code, stdout } = validate("--json");
    expect(code).toBe(0);
    expect(JSON.parse(stdout).drift).toEqual([]);
  });
});
