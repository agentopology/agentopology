/**
 * No gate that looks wired but is not, and nothing accepted in silence.
 *
 * Each case was measured on 0.12.6:
 *  - a Stop / SubagentStop hook declared `strength: refuse` whose bash script
 *    was unwritten got a logger that appended to metrics.jsonl and exited 0,
 *    with no stub marker: no stub count saw it and the refusal did nothing;
 *  - unknown keys in `settings { }` and `metering { }` were dropped with no
 *    message (V102 did not look inside those blocks);
 *  - a gate's `bypass:` validated and landed nowhere in the claude-code output.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { bindings } from "../../bindings/index.js";
import { STUB_MARKER } from "../../bindings/lib/stub.js";
import { stubsOf } from "../../scaffold/stubs.js";
import { parseSkillMd } from "../../import/claude-code.js";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = fs.readFileSync(resolve(here, "fixtures/silent-accepts.at"), "utf-8");

const files = () => bindings["claude-code"].scaffold(parse(SOURCE));
const script = (name: string) => {
  const f = files().find((x) => x.path.endsWith(`/${name}`));
  expect(f, name).toBeDefined();
  return f!;
};

describe("a refuse hook on Stop / SubagentStop with an unwritten script is a stub", () => {
  for (const name of ["lift-gate.sh", "sub-gate.sh"]) {
    it(`${name} carries the stub marker, exits 1 and writes no metrics line`, () => {
      const f = script(name);
      expect(f.content).toContain(STUB_MARKER);
      expect(f.content).toMatch(/^exit 1$/m);
      expect(f.content).not.toContain("metrics.jsonl");
      expect(f.stub).toBe("hook");
    });
  }

  it("is counted as a hook stub", () => {
    const { stubs } = stubsOf(files());
    const hookStubs = stubs.filter((s) => s.kind === "hook").map((s) => s.path.replace(/^.*\//, ""));
    expect(hookStubs).toContain("lift-gate.sh");
    expect(hookStubs).toContain("sub-gate.sh");
  });

  for (const name of ["stop-log.sh", "stop-plain.sh"]) {
    it(`${name} (detect or no strength) keeps the logger, which does real work`, () => {
      const f = script(name);
      expect(f.content).toContain("metrics.jsonl");
      expect(f.content).not.toContain(STUB_MARKER);
      expect(stubsOf(files()).stubs.map((s) => s.path)).not.toContain(f.path);
    });
  }
});

describe("unknown keys in settings { } and metering { } are V102 errors", () => {
  const v102 = () => validate(parse(SOURCE)).filter((r) => r.rule === "V102");

  for (const [key, block] of [["scope", "settings"], ["pin-models", "settings"], ["limit", "metering"]] as const) {
    it(`${block} ${key}: is named, as an error`, () => {
      const hit = v102().find((r) => r.message.includes(`\`${key}`) && r.message.includes(block));
      expect(hit, `${block} ${key}`).toBeDefined();
      expect(hit!.level).toBe("error");
      expect(hit!.message).toContain("is not a");
      expect(hit!.message).toContain("so it is ignored");
    });
  }

  it("the keys the parser reads raise nothing", () => {
    const known = v102().map((r) => r.message).filter((m) =>
      ["allow", "deny", "ask", "sandbox", "fallback-chain", "track", "per", "output", "format", "pricing"].some((k) => m.includes(`\`${k}:\``)),
    );
    expect(known).toEqual([]);
    expect(v102()).toHaveLength(3);
  });

  it("an env block inside settings still warns, not errors", () => {
    const src = SOURCE.replace("    scope: local\n", "    env {\n      FOO: \"1\"\n    }\n");
    const env = validate(parse(src)).filter((r) => r.rule === "V102" && r.message.includes("`env`"));
    expect(env).toHaveLength(1);
    expect(env[0].level).toBe("warning");
  });
});

describe("a gate's bypass: lands in the generated skill", () => {
  it("the skill's gate section names it", () => {
    const skill = files().find((f) => f.path.endsWith("SKILL.md") && f.content.includes("## Gates"));
    expect(skill).toBeDefined();
    const section = skill!.content.slice(skill!.content.indexOf("### Tests Green"));
    expect(section.split("\n\n")[0]).toContain("Bypass: none");
  });

  it("import reads it back", () => {
    const skill = files().find((f) => f.path.endsWith("SKILL.md") && f.content.includes("## Gates"))!;
    const gate = parseSkillMd(skill.content).gates.find((g) => g.id === "tests-green");
    expect(gate?.bypass).toBe("none");
  });
});
