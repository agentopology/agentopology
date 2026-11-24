/**
 * Every block kind, written on one line with commas between its fields,
 * gives the same AST and the same validation findings as its multi-line form.
 *
 * Measured on the rc with the one-line reader merged: a one-line
 * `settings { autoCompact: true, theme: dark }` raised one V102 error
 * (autoCompact) where the multi-line form raised two: the unknown-name check
 * read only the first field of each line.
 */
import { describe, it, expect } from "vitest";
import { parse } from "../index.js";
import { validate } from "../validator.js";

const HEAD = `topology t : [pipeline] {
  meta {
    version: "1.0.0"
    description: "every block on one line"
  }
  agent a {
    model: sonnet
    description: "A"
    prompt {
      Do a.
    }
  }
  agent b {
    model: sonnet
    description: "B"
    prompt {
      Do b.
    }
  }
  human h {
    description: "Approves"
  }
  flow {
    a -> b
  }
`;

/** [block kind, the block's opening (with any wrapper), its fields, the closing]. */
const BLOCKS: Array<[string, string, string[], string]> = [
  ["orchestrator", "orchestrator {", ["model: sonnet", "handles: [a, b]"], "}"],
  ["agent", "agent c {", ["model: sonnet", 'description: "C"', "phase: 2", "tools: [Read, Grep]"], "}"],
  ["action", "action act {", ["kind: external", 'commands: ["./tool go"]', 'description: "Go"'], "}"],
  ["gate", "gates {\n    gate g {", ["after: a", "before: b", 'run: "scripts/g.sh"', "strength: refuse", 'bypass: "none"'], "}\n  }"],
  ["hook", "hooks {\n    hook k {", ["on: PreToolUse", 'matcher: "Bash"', 'run: "exit 2"', "type: command", "strength: refuse"], "}\n  }"],
  ["job", "schedule {\n    job j {", ['cron: "0 9 * * *"', "agent: a", "enabled: true"], "}\n  }"],
  ["artifact", "artifacts {\n    artifact r {", ["type: report", 'path: "out/r.md"'], "}\n  }"],
  ["record", "records {\n    record tr {", ['path: "logs/tr.jsonl"'], "}\n  }"],
  ["tool", "tools {\n    tool tl {", ['script: "tools/x.sh"', 'description: "X"', "lang: bash"], "}\n  }"],
  ["human", "human h2 {", ['description: "Second"', "timeout: 1h"], "}"],
  ["settings", "settings {", ['deny: ["Bash(rm *)"]', "sandbox: true"], "}"],
  ["settings, unknown keys", "settings {", ["autoCompact: true", "theme: dark"], "}"],
  ["metering", "metering {", ["track: [cost]", "per: [run]", 'output: "m.jsonl"', "format: jsonl", "pricing: none"], "}"],
  ["metering, unknown key", "metering {", ["track: [cost]", "cap: 5"], "}"],
  ["checkpoint", "checkpoint {", ["backend: sqlite", "strategy: every-node", "ttl: 7d"], "}"],
  ["interface", "interface {", ["entry: a", "exit: b"], "}"],
  ["defaults", "defaults {", ["temperature: 0.2", "max-tokens: 4096"], "}"],
  ["observability", "observability {", ["enabled: true", "exporter: otlp", 'endpoint: "http://127.0.0.1:4318"'], "}"],
  ["batch", "batch {", ["size: 10", "parallel: 2"], "}"],
  ["context", "context {", ['file: "CLAUDE.md"', "includes: [a.md, b.md]"], "}"],
  ["depth", "depth {", ["factor: 2", "max: 3"], "}"],
  ["env", "env {", ['FOO: "1"', 'BAR: "2"'], "}"],
  ["inventory", "inventory {", ["roots: [docs, tools]"], "}"],
  ["person", "person {", ["away: false"], "}"],
  ["an unknown field in an agent", "agent d {", ["model: sonnet", 'description: "D"', "modle: opus"], "}"],
];

const oneLine = (open: string, fields: string[], close: string) => `  ${open} ${fields.join(", ")} ${close}\n`;
const multiLine = (open: string, fields: string[], close: string) => {
  const inner = open.includes("\n") ? "      " : "    ";
  return `  ${open}\n${fields.map((f) => `${inner}${f}`).join("\n")}\n  ${close}\n`;
};

/** A finding without its line: a one-line block sits on other lines than its multi-line form. */
const findings = (src: string) =>
  validate(parse(src)).map(({ rule, level, message, node }) => ({ rule, level, message, node }));

describe("every block kind: one line equals multi-line", () => {
  for (const [name, open, fields, close] of BLOCKS) {
    const one = `${HEAD}${oneLine(open, fields, close)}}\n`;
    const multi = `${HEAD}${multiLine(open, fields, close)}}\n`;
    it(`${name}: the same AST`, () => {
      expect(parse(one)).toEqual(parse(multi));
    });
    it(`${name}: the same findings`, () => {
      expect(findings(one)).toEqual(findings(multi));
    });
  }

  it("the unknown settings keys are each an error, on one line as on many", () => {
    const one = `${HEAD}  settings { autoCompact: true, theme: dark }\n}\n`;
    const v102 = findings(one).filter((r) => r.rule === "V102" && r.level === "error").map((r) => r.message);
    expect(v102.some((m) => m.includes("autoCompact"))).toBe(true);
    expect(v102.some((m) => m.includes("theme"))).toBe(true);
  });
});
