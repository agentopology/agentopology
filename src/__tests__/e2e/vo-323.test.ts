/**
 * [VO-323] Claude Code 2.1.323 was measured live (2026-11-13): the talk and
 * spawn guards grade `refuse` on that version and `unverified` on any other.
 */
import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import { VERIFIED_ON, LIVE_CHECKS } from "../../conformance/claude-code.js";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, "../../../dist/cli/index.js");
const FIXTURE = resolve(here, "fixtures/session-ops.at");
// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

const project = fs.mkdtempSync(join(os.tmpdir(), "at-vo323-"));
for (const f of claudeCodeBinding.scaffold(parse(fs.readFileSync(FIXTURE, "utf8")))) {
  fs.mkdirSync(dirname(join(project, f.path)), { recursive: true });
  fs.writeFileSync(join(project, f.path), f.content);
}
afterAll(() => fs.rmSync(project, { recursive: true, force: true }));

function grades(version: string): Record<string, string> {
  const r = spawnSync(process.execPath, [CLI, "guard", FIXTURE, "--check", "--dir", project], {
    encoding: "utf8",
    env: { ...process.env, AGENTOPOLOGY_CLAUDE_VERSION: version, NO_COLOR: "1", HOME: project },
  });
  const out: Record<string, string> = {};
  for (const l of plain(r.stdout).split("\n")) {
    const m = /(talk guard|spawn guard).*?\b(refuse|detect|hope|none|unverified)\b/.exec(l);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

describe("[VO-323] verified on 2.1.323", () => {
  it("[VO-323] VERIFIED_ON is 2.1.323", () => {
    expect(VERIFIED_ON).toBe("2.1.323");
  });

  it("[VO-323] the live check records the three measured facts with date and version", () => {
    const c = LIVE_CHECKS.find((x) => x.version === "2.1.323")!;
    expect(c).toBeDefined();
    expect(c.date).toBe("2026-11-13");
    expect(c.facts).toHaveLength(3);
    const text = c.facts.join("\n");
    expect(text).toMatch(/PreToolUse.*SendMessage.*exit code 2/s);
    expect(text).toMatch(/--agent.*AGENT\.md/s);
    expect(text).toMatch(/`to`.*`recipient`/s);
  });

  it("[VO-323] with 2.1.323 the talk guard and the spawn guard grade refuse", () => {
    expect(grades("2.1.323")).toEqual({ "talk guard": "refuse", "spawn guard": "refuse" });
  });

  it("[VO-323] with 2.1.999 both read unverified", () => {
    expect(grades("2.1.999")).toEqual({ "talk guard": "unverified", "spawn guard": "unverified" });
  });
});
