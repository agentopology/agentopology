/**
 * A doubled backslash in a regex field matches a literal backslash.
 *
 * Strings in a .at file keep their backslashes as written, so the docs'
 * example `unit-from: "./tool publish (\\S+)"` compiled to a regex that
 * needs a backslash in the command and read no unit from
 * `./tool publish ep42`. The docs now show one backslash, the form that
 * works, and validate warns (V111) on a doubled one.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import { topics } from "../../docs/content.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const hasJq = spawnSync("/bin/sh", ["-c", "command -v jq"]).status === 0;

/** The unit-from the gate docs topic shows, exactly as a user copies it into a .at file. */
const documented = (): string => {
  const m = /unit-from: ("[^"\n]*")/.exec(topics.gate.content());
  expect(m, "the gate topic shows a unit-from example").not.toBeNull();
  return m![1];
};

const topology = (unitFrom: string) => `topology ship : [pipeline] {
  meta {
    version: "1.0.0"
    description: "Render then publish"
  }
  orchestrator {
    model: sonnet
    handles: [render, publish]
  }
  action render {
    kind: external
    commands: ["./tool render"]
  }
  action publish {
    kind: external
    commands: ["./tool publish"]
    unit-from: ${unitFrom}
  }
  records {
    record trace { path: "logs/{unit}/trace.jsonl" }
  }
  gates {
    gate publish-ready {
      after: render
      before: publish
      ledger: trace
    }
  }
  flow { render -> publish }
}
`;

/** The gates part of the gate topic's example, as the docs show it. */
const documentedGates = (): string => {
  const block = /```at\n([\s\S]*?)```/.exec(topics.gate.content().slice(topics.gate.content().indexOf("## Gates before a script step")));
  expect(block).not.toBeNull();
  return block![1];
};

describe("the documented unit-from example works as written", () => {
  it("shows one backslash in the gate topic, the action topic and the grammar", () => {
    expect(documented()).toBe('"./tool publish (\\S+)"');
    expect(topics.action.content()).toContain('`"./tool publish (\\S+)"`');
    expect(topics.action.content()).not.toContain("(\\\\S+)");
    const grammar = fs.readFileSync(join(repo, "spec/grammar.md"), "utf-8");
    expect(grammar).toContain('`"./tool publish (\\S+)"`');
    expect(grammar).not.toContain("(\\\\S+)");
  });

  it("the example's blocks, in a topology, validate with no error", () => {
    const ex = documentedGates();
    const src = topology(documented())
      .replace(/  action publish \{[\s\S]*?\n  \}\n  records \{[\s\S]*?\n  \}\n  gates \{[\s\S]*?\n  \}\n/, ex.split("\n").map((l) => (l ? `  ${l}` : l)).join("\n"));
    expect(src).toContain("record trace");
    expect(validate(parse(src)).filter((r) => r.level === "error")).toEqual([]);
  });

  describe.skipIf(!hasJq)("scaffolded, the gate reads ep42 from ./tool publish ep42", () => {
    let root: string;
    beforeAll(() => {
      root = fs.mkdtempSync(join(os.tmpdir(), "at-unit-from-"));
      for (const f of claudeCodeBinding.scaffold(parse(topology(documented())))) {
        fs.mkdirSync(dirname(join(root, f.path)), { recursive: true });
        fs.writeFileSync(join(root, f.path), f.content);
      }
    });
    afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

    const run = (command: string) => spawnSync("bash", [join(root, ".claude/skills/ship/scripts/before-action.sh")], {
      input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
      encoding: "utf-8",
    });

    it("with no record it refuses, naming unit ep42 and its ledger", () => {
      const r = run("./tool publish ep42");
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("logs/ep42/trace.jsonl");
    });

    it("with an ok record for ep42 it lets the step run", () => {
      fs.mkdirSync(join(root, "logs/ep42"), { recursive: true });
      fs.writeFileSync(join(root, "logs/ep42/trace.jsonl"), JSON.stringify({ step: "render", unit: "ep42", ok: true, at: "2026-01-01T00:00:00Z" }) + "\n");
      expect(run("./tool publish ep42").status).toBe(0);
    });
  });
});

describe.skipIf(!hasJq)("the doubled form reads no unit (why V111 warns)", () => {
  it('unit-from "(\\\\S+)" names no ep42 for ./tool publish ep42', () => {
    const root = fs.mkdtempSync(join(os.tmpdir(), "at-unit-from-2-"));
    try {
      for (const f of claudeCodeBinding.scaffold(parse(topology('"./tool publish (\\\\S+)"')))) {
        fs.mkdirSync(dirname(join(root, f.path)), { recursive: true });
        fs.writeFileSync(join(root, f.path), f.content);
      }
      const r = spawnSync("bash", [join(root, ".claude/skills/ship/scripts/before-action.sh")], {
        input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "./tool publish ep42" } }),
        env: { ...process.env, CLAUDE_PROJECT_DIR: root },
        encoding: "utf-8",
      });
      expect(r.stderr).not.toContain("logs/ep42/trace.jsonl");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("V111 warns on a doubled backslash in unit-from", () => {
  const v111 = (unitFrom: string) => validate(parse(topology(unitFrom))).filter((r) => r.rule === "V111");

  it('"(\\\\S+)" warns: it matches a literal backslash; write one', () => {
    const hits = v111('"./tool publish (\\\\S+)"');
    expect(hits).toHaveLength(1);
    expect(hits[0].level).toBe("warning");
    expect(hits[0].message).toContain("literal backslash");
    expect(hits[0].message).toContain("one backslash");
    expect(hits[0].node).toBe("publish");
  });

  it('"(\\S+)" does not warn', () => {
    expect(v111('"./tool publish (\\S+)"')).toEqual([]);
  });
});
