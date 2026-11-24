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
    "a field after a list with no comma",
    "  metering { track: [tokens, cost] format: json }",
    "  metering {\n    track: [tokens, cost]\n    format: json\n  }",
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
    const hit = errs.find((r) => r.rule === "V157");
    expect(hit).toBeDefined();
    expect(hit!.message).toMatch(/checkpoint/);
    expect(hit!.message).toMatch(/strategy/);
  });

  it("a secret with no comma before readers is refused", () => {
    const src = topo('  secrets { secret prod { path: "config/prod/**" readers: [a] } }');
    const hit = validate(parse(src)).find((r) => r.rule === "V157");
    expect(hit?.level).toBe("error");
    expect(hit!.message).toMatch(/secret/);
    expect(hit!.message).toMatch(/readers/);
  });

  it("a tool with no comma before description is refused; the fixed form is clean", () => {
    const broken = topo('  tools { tool run-tests { command: "npm test" description: "Run the suite" } }');
    const hit = validate(parse(broken)).find((r) => r.rule === "V157");
    expect(hit?.level).toBe("error");
    expect(hit!.message).toMatch(/run-tests/);
    expect(hit!.message).toMatch(/description/);
    const fixed = topo('  tools { tool run-tests { command: "npm test", description: "Run the suite" } }');
    const ast = parse(fixed);
    expect(validate(ast).filter((r) => r.rule === "V157")).toEqual([]);
    expect(ast.toolDefs?.[0]).toMatchObject({ command: "npm test", description: "Run the suite" });
  });

  it("a field after a closed list is read, not swallowed", () => {
    const ast = parse(topo("  checkpoint { backend: [sqlite] strategy: every-node }"));
    expect(ast.checkpoint?.strategy).toBe("every-node");
    expect(validate(ast).filter((r) => r.rule === "V157")).toEqual([]);
  });

  it("an unquoted value run into a known field is refused", () => {
    const src = topo("  checkpoint { backend: sqlite strategy: every-node }");
    const hit = validate(parse(src)).find((r) => r.rule === "V157");
    expect(hit?.level).toBe("error");
    expect(hit!.message).toMatch(/strategy/);
  });

  it("comma and multi-line secrets and tools are clean and parse the same", () => {
    const one = topo('  secrets { secret prod { path: "config/prod/**", readers: [a] } }\n  tools { tool run-tests { command: "npm test", description: "Run the suite" } }');
    const multi = topo('  secrets {\n    secret prod {\n      path: "config/prod/**"\n      readers: [a]\n    }\n  }\n  tools {\n    tool run-tests {\n      command: "npm test"\n      description: "Run the suite"\n    }\n  }');
    expect(parse(one)).toEqual(parse(multi));
    expect(parse(one).secrets?.[0]).toEqual({ id: "prod", path: "config/prod/**", readers: ["a"] });
    expect(validate(parse(one)).filter((r) => r.rule === "V157")).toEqual([]);
  });

  it("does not fire on a clean one-line block", () => {
    const src = topo("  checkpoint { backend: sqlite, strategy: every-node, ttl: 7d }");
    expect(validate(parse(src)).filter((r) => r.rule === "V157")).toEqual([]);
  });
});
