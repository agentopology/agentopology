/**
 * A block written on one line with commas parses like the multi-line form.
 *
 * `checkpoint { backend: sqlite, strategy: every-node, ttl: 7d }` used to read
 * backend as "sqlite, strategy: every-node, ttl: 7d". A comma between fields
 * at the top level of a block now separates them, the same as a newline. A
 * comma inside [..], {..}, (..) or quotes stays part of the value.
 */
import { describe, it, expect } from "vitest";
import { parse } from "../index.js";
import { validate } from "../validator.js";

const HEAD = [
  "topology t : [pipeline] {",
  '  meta { version: "1.0.0"',
  '    description: "one line" }',
  "  orchestrator { model: sonnet }",
  "  agent a { model: sonnet",
  "    prompt { Do a. } }",
  "  agent b { model: sonnet",
  "    prompt { Do b. } }",
  "  flow { a -> b }",
].join("\n");

const topo = (block: string): string => `${HEAD}\n${block}\n}\n`;

/** [name, one-line form, multi-line form] */
const CASES: Array<[string, string, string]> = [
  [
    "checkpoint",
    "  checkpoint { backend: sqlite, strategy: every-node, ttl: 7d }",
    "  checkpoint {\n    backend: sqlite\n    strategy: every-node\n    ttl: 7d\n  }",
  ],
  [
    "checkpoint with replay",
    "  checkpoint { backend: sqlite, ttl: 7d\n    replay { enabled: true, max-history: 5, branch: true } }",
    "  checkpoint {\n    backend: sqlite\n    ttl: 7d\n    replay {\n      enabled: true\n      max-history: 5\n      branch: true\n    }\n  }",
  ],
  [
    "interface",
    "  interface { entry: a, exit: b }",
    "  interface {\n    entry: a\n    exit: b\n  }",
  ],
  [
    "defaults",
    "  defaults { temperature: 0.2, max-tokens: 4096 }",
    "  defaults {\n    temperature: 0.2\n    max-tokens: 4096\n  }",
  ],
  [
    "observability",
    "  observability { enabled: true, exporter: otlp, sample-rate: 0.5 }",
    "  observability {\n    enabled: true\n    exporter: otlp\n    sample-rate: 0.5\n  }",
  ],
  [
    "metering",
    '  metering { track: [tokens, cost], output: "m.json", format: json }',
    '  metering {\n    track: [tokens, cost]\n    output: "m.json"\n    format: json\n  }',
  ],
  [
    "batch",
    "  batch { size: 10, parallel: 2 }",
    "  batch {\n    size: 10\n    parallel: 2\n  }",
  ],
  [
    "settings",
    "  settings { autoCompact: true, theme: dark }",
    "  settings {\n    autoCompact: true\n    theme: dark\n  }",
  ],
  [
    "context",
    '  context { file: "CLAUDE.md", includes: [a.md, b.md] }',
    '  context {\n    file: "CLAUDE.md"\n    includes: [a.md, b.md]\n  }',
  ],
  [
    "depth",
    "  depth { factor: 2, max: 3 }",
    "  depth {\n    factor: 2\n    max: 3\n  }",
  ],
  [
    "list and quoted values keep their commas",
    '  metering { track: [tokens, cost], output: "a, b: c.json", format: json }',
    '  metering {\n    track: [tokens, cost]\n    output: "a, b: c.json"\n    format: json\n  }',
  ],
];

describe("one-line blocks match their multi-line form", () => {
  for (const [name, one, multi] of CASES) {
    it(name, () => {
      const a = parse(topo(one));
      const b = parse(topo(multi));
      expect(a).toEqual(b);
    });
  }

  it("checkpoint fields are read separately", () => {
    const ast = parse(topo("  checkpoint { backend: sqlite, strategy: every-node, ttl: 7d }"));
    expect(ast.checkpoint?.backend).toBe("sqlite");
    expect(ast.checkpoint?.strategy).toBe("every-node");
    expect(ast.checkpoint?.ttl).toBe("7d");
  });

  it("interface is not null on one line", () => {
    const ast = parse(topo("  interface { entry: a, exit: b }"));
    expect(ast.interfaceEndpoints).toEqual({ entry: "a", exit: "b" });
  });

  it("a comma in parentheses stays in the value", () => {
    const ast = parse(topo("  checkpoint { backend: sqlite, connection: secret(a, b: c), ttl: 7d }"));
    expect(ast.checkpoint?.ttl).toBe("7d");
    expect(ast.checkpoint?.connection).toContain("a, b: c");
  });
});

describe("a value that still holds `, <field>:` is refused", () => {
  it("names the block", () => {
    // An unclosed ( keeps the rest of the line in one value: never silent.
    const src = topo("  checkpoint { backend: sqlite, ttl: (7d, strategy: x }");
    const errs = validate(parse(src)).filter((r) => r.level === "error");
    const hit = errs.find((r) => r.rule === "V137");
    expect(hit).toBeDefined();
    expect(hit!.message).toMatch(/checkpoint/);
    expect(hit!.message).toMatch(/strategy/);
  });

  it("does not fire on a clean one-line block", () => {
    const src = topo("  checkpoint { backend: sqlite, strategy: every-node, ttl: 7d }");
    expect(validate(parse(src)).filter((r) => r.rule === "V137")).toEqual([]);
  });
});
