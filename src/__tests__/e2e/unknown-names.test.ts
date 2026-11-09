/**
 * Nothing written in a .at file vanishes in silence (N23, N24).
 *
 * Measured on 0.8.0 (harness-venture, lane B, 2026-11-08): in 15 of 17 probe
 * cases an unknown field or block was gone from the AST while validate printed
 * "All validation rules passed" and exited 0; scaffold dropped it too. Only an
 * unknown `on-timeout` value was caught (V59). Each case below is the same
 * small topology with one thing added. V102 now names every name the parser
 * does not read; V103 checks `behavior`.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { topics } from "../../docs/content.js";
import { serializeAST } from "../../import/serializer.js";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../../../dist/cli/index.js");

const BASELINE = `topology probe : [pipeline] {
  meta {
    version: "1.0.0"
    description: "Probe baseline"
  }

  orchestrator {
    model: sonnet
    handles: [b]
  }

  agent a {
    model: sonnet
    description: "Writes the draft"
    produces: [r]
    prompt {
      Write the draft.
    }
  }

  action b {
    kind: inline
    description: "Collect the draft"
  }

  human h {
    description: "Approves the draft"
  }

  gates {
    gate g {
      after: a
      before: b
      run: "scripts/check.sh"
      on-fail: halt
    }
  }

  hooks {
    hook k {
      on: Stop
      run: "scripts/stop.sh"
    }
  }

  schedule {
    job j {
      every: 1h
      agent: a
    }
  }

  artifacts {
    artifact r {
      type: markdown
      path: "out/r.md"
    }
  }

  flow {
    a -> b -> h
  }
}
`;

/** Where each kind of addition goes: the line it is written after. */
const ANCHOR = {
  agent: `    description: "Writes the draft"\n`,
  action: `    description: "Collect the draft"\n`,
  human: `    description: "Approves the draft"\n`,
  gate: `      on-fail: halt\n`,
  hook: `      run: "scripts/stop.sh"\n`,
  job: `      agent: a\n`,
  artifact: `      path: "out/r.md"\n`,
  meta: `    description: "Probe baseline"\n`,
  top: `  flow {\n`,
} as const;

function withLine(where: keyof typeof ANCHOR, text: string): string {
  const anchor = ANCHOR[where];
  if (!BASELINE.includes(anchor)) throw new Error(`anchor missing: ${where}`);
  if (where === "top") return BASELINE.replace(anchor, `${text}\n\n${anchor}`);
  const indent = anchor.match(/^ */)![0];
  return BASELINE.replace(anchor, anchor + text.split("\n").map((l) => indent + l).join("\n") + "\n");
}

interface Case {
  id: string;
  what: string;
  source: string;
  /** The name that must be reported or kept. */
  name: string;
  /** A unique value that must survive into the AST if the name is kept. */
  marker: string;
  /** The block the message must name. */
  block?: string;
}

const CASES: Case[] = [
  { id: "C01", what: "unknown field on an agent", source: withLine("agent", "zzmarker: zzAAA101"), name: "zzmarker", marker: "zzAAA101", block: `agent "a"` },
  { id: "C02", what: "misspelled field on an agent", source: withLine("agent", "modle: opus"), name: "modle", marker: "zzNONE", block: `agent "a"` },
  { id: "C03", what: "unknown field on an action", source: withLine("action", "zzfield: zzAAA103"), name: "zzfield", marker: "zzAAA103", block: `action "b"` },
  { id: "C04", what: "unknown field on a human", source: withLine("human", "zzfield: zzAAA104"), name: "zzfield", marker: "zzAAA104", block: `human "h"` },
  { id: "C05", what: "unknown field on a gate", source: withLine("gate", "zzfield: zzAAA105"), name: "zzfield", marker: "zzAAA105", block: `gate "g"` },
  { id: "C06", what: "unknown field on a hook", source: withLine("hook", "zzfield: zzAAA106"), name: "zzfield", marker: "zzAAA106", block: `hook "k"` },
  { id: "C07", what: "unknown field on a schedule job", source: withLine("job", "zzfield: zzAAA107"), name: "zzfield", marker: "zzAAA107", block: `job "j"` },
  { id: "C08", what: "unknown field on an artifact", source: withLine("artifact", "zzfield: zzAAA108"), name: "zzfield", marker: "zzAAA108", block: `artifact "r"` },
  { id: "C09", what: "unknown field in meta", source: withLine("meta", "zzfield: zzAAA109"), name: "zzfield", marker: "zzAAA109", block: `"meta"` },
  { id: "C10", what: "unknown top-level block", source: withLine("top", "  zzblock {\n    x: zzAAA110\n  }"), name: "zzblock", marker: "zzAAA110", block: "the topology" },
  { id: "C11", what: "unknown named top-level block", source: withLine("top", "  contract c1 {\n    clause q1 {\n      text: \"zzAAA111\"\n    }\n  }"), name: "contract", marker: "zzAAA111", block: "the topology" },
  { id: "C12", what: "unknown block nested in an agent", source: withLine("agent", "zzblock {\n  x: zzAAA112\n}"), name: "zzblock", marker: "zzAAA112", block: `agent "a"` },
  { id: "C13", what: "agent field written on an action", source: withLine("action", "produces: [zzAAA113]"), name: "produces", marker: "zzAAA113", block: `action "b"` },
  { id: "C16a", what: "v8 field serves: on an action", source: withLine("action", "serves: zzAAA116"), name: "serves", marker: "zzAAA116", block: `action "b"` },
  { id: "C16b", what: "v8 field strength: on an action", source: withLine("action", "strength: zzAAA117"), name: "strength", marker: "zzAAA117", block: `action "b"` },
  { id: "C17", what: "v8 field state: at the top level", source: withLine("top", "  state: zzAAA118"), name: "state", marker: "zzAAA118", block: "" },
  { id: "C17b", what: "v8 state block at the top level", source: withLine("top", "  state draft {\n    x: zzAAA119\n  }"), name: "state", marker: "zzAAA119", block: "the topology" },
];

const run = (source: string) => {
  const ast = parse(source);
  return { ast, results: validate(ast) };
};

const named = (results: ReturnType<typeof validate>, ...words: string[]) =>
  results.filter((r) => words.every((w) => r.message.includes(w)));

function cli(source: string, ...args: string[]) {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "at-unknown-"));
  const file = join(dir, "probe.at");
  fs.writeFileSync(file, source);
  try {
    const r = spawnSync(process.execPath, [CLI, ...args.map((a) => (a === "FILE" ? file : a.replace("DIR", dir)))], { encoding: "utf8" });
    return { code: r.status, out: r.stdout + r.stderr, dir };
  } finally {
    // dir is removed by the caller when it reads output files
  }
}

describe("a name the parser does not read is reported, never dropped", () => {
  it("[N23] the baseline still passes", () => {
    expect(run(BASELINE).results).toEqual([]);
  });

  it("[N23] an unknown field on an agent is reported, not dropped", () => {
    const { results } = run(CASES[0].source);
    const hit = named(results, "zzmarker", `agent "a"`);
    expect(hit.length).toBeGreaterThan(0);
    expect(hit[0]).toMatchObject({ rule: "V102", level: "error" });
  });

  it("[N23] a misspelled field is reported with the field it resembles", () => {
    const hit = named(run(CASES[1].source).results, "modle");
    expect(hit.length).toBeGreaterThan(0);
    expect(hit[0].message).toContain("Did you mean `model`?");
  });

  for (const c of CASES.slice(2, 8)) {
    it(`[N23] an unknown field is reported on every block that holds fields: ${c.what}`, () => {
      expect(named(run(c.source).results, c.name, c.block!).length).toBeGreaterThan(0);
    });
  }

  it("[N23] an unknown field in meta is reported", () => {
    expect(named(run(CASES[8].source).results, "zzfield", `"meta"`).length).toBeGreaterThan(0);
  });

  it("[N23] an unknown top-level block is reported, not dropped", () => {
    expect(named(run(CASES[9].source).results, "zzblock", "not a topology section").length).toBeGreaterThan(0);
    expect(named(run(CASES[10].source).results, "contract c1", "not a topology section").length).toBeGreaterThan(0);
  });

  it("[N23] an unknown block nested in a node is reported", () => {
    expect(named(run(CASES[11].source).results, "zzblock", `agent "a"`).length).toBeGreaterThan(0);
  });

  it("[N23] a field valid on another node type is reported on the wrong one", () => {
    const hit = named(run(CASES[12].source).results, "`produces` is not an action field", "agent");
    expect(hit.length).toBeGreaterThan(0);
  });

  it("[N23] the v8 words serves, strength and state are reported until the language has them", () => {
    for (const c of CASES.slice(13)) {
      expect(named(run(c.source).results, c.name).length, c.id).toBeGreaterThan(0);
    }
  });

  it("[N23] nothing written in the file vanishes between parse and validate", () => {
    for (const c of CASES) {
      const { ast, results } = run(c.source);
      const kept = JSON.stringify(ast).includes(c.marker);
      const reported = named(results, c.name).length > 0;
      expect(kept || reported, `${c.id} ${c.what}`).toBe(true);
    }
  });

  it("[N23] validate does not print \"All validation rules passed\" when anything was dropped, and exits 1", () => {
    for (const c of [CASES[0], CASES[10], CASES[13]]) {
      const r = cli(c.source, "validate", "FILE");
      fs.rmSync(r.dir, { recursive: true, force: true });
      expect(r.out, c.id).not.toContain("All validation rules passed");
      expect(r.out, c.id).toContain("V102");
      expect(r.code, c.id).toBe(1);
    }
  });

  it("[N23] scaffold refuses a file with an unknown field instead of dropping it", () => {
    const r = cli(CASES[0].source, "scaffold", "FILE", "--target", "claude-code", "--output", "DIR/out");
    const wrote = fs.existsSync(join(r.dir, "out", ".claude"));
    fs.rmSync(r.dir, { recursive: true, force: true });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("zzmarker");
    expect(wrote).toBe(false);
  });

  it("[N23] a gate's description is kept, since V96 sends a gate's prose there", () => {
    const source = withLine("gate", 'description: "zzAAA130 checks the draft"');
    const { ast, results } = run(source);
    expect(results).toEqual([]);
    const gate = ast.nodes.find((n) => n.id === "g") as { description?: string };
    expect(gate.description).toBe("zzAAA130 checks the draft");
    const again = parse(serializeAST(ast)).nodes.find((n) => n.id === "g") as { description?: string };
    expect(again.description).toBe("zzAAA130 checks the draft");
  });

  it("[N23] the on-timeout value is still caught by V59 (the case that already worked)", () => {
    const { ast, results } = run(withLine("human", "on-timeout: zzAAA114"));
    expect(JSON.stringify(ast)).toContain("zzAAA114");
    expect(results.some((r) => r.rule === "V59")).toBe(true);
  });
});

describe("an enum field rejects a value outside its documented set", () => {
  it("[N24] an agent's behavior must be advisory or blocking", () => {
    const hit = run(withLine("agent", "behavior: zzAAA125")).results.filter((r) => r.rule === "V103");
    expect(hit).toHaveLength(1);
    expect(hit[0].message).toContain("zzAAA125");
    expect(hit[0].message).toContain("advisory or blocking");
  });

  it("[N24] a gate's behavior must be advisory or blocking", () => {
    expect(run(withLine("gate", "behavior: loud")).results.some((r) => r.rule === "V103")).toBe(true);
  });

  it("[N24] advisory and blocking pass", () => {
    for (const v of ["advisory", "blocking"]) {
      expect(run(withLine("agent", `behavior: ${v}`)).results).toEqual([]);
    }
  });
});

/**
 * Guard: every field the docs list passes without a V102. A rule that flags a
 * documented field is worse than the bug it fixes. The docs used to list
 * agent fields by their AST names (`maxTurns`), which the parser drops.
 */
describe("every field in the docs is a name the parser reads", () => {
  const PAGES: Array<{ topic: string; section: string; template: (field: string) => string }> = [
    { topic: "topology", section: "## Meta Block Fields", template: (f) => withLine("meta", f) },
    { topic: "agent", section: "## All Fields", template: (f) => withLine("agent", f) },
    { topic: "action", section: "## Fields", template: (f) => withLine("action", f) },
    { topic: "human", section: "## Fields", template: (f) => withLine("human", f) },
    { topic: "gate", section: "## Fields", template: (f) => withLine("gate", f) },
    { topic: "hooks", section: "## Fields", template: (f) => withLine("hook", f) },
    { topic: "schedule", section: "## Fields", template: (f) => withLine("job", f) },
    { topic: "artifacts", section: "## Fields", template: (f) => withLine("artifact", f) },
    { topic: "orchestrator", section: "## Fields", template: (f) => BASELINE.replace("    handles: [b]\n", `    handles: [b]\n    ${f}\n`) },
    { topic: "group", section: "## Fields", template: (f) => withLine("top", `  group gc {\n    ${f}\n  }`) },
    { topic: "tools", section: "## Fields", template: (f) => withLine("top", `  tools {\n    tool t {\n      ${f}\n    }\n  }`) },
    { topic: "skills", section: "## Fields", template: (f) => withLine("top", `  skill s {\n    ${f}\n  }`) },
  ];

  /** First-column names of the tables under `section`, until the next `## `. */
  function documented(topic: string, section: string): string[] {
    const page = topics[topic].content();
    const start = page.indexOf(section);
    expect(start, `${topic}: "${section}" not found`).toBeGreaterThan(-1);
    const end = page.indexOf("\n## ", start + section.length);
    const body = page.slice(start, end === -1 ? undefined : end);
    return [...body.matchAll(/^\|\s*`?([a-zA-Z][\w-]*)`?\s*\|/gm)]
      .map((m) => m[1])
      .filter((n) => !["Field", "id", "name", "NAME"].includes(n));
  }

  for (const p of PAGES) {
    it(`[N23] every field in docs ${p.topic} passes without a V102`, () => {
      const fields = documented(p.topic, p.section);
      expect(fields.length).toBeGreaterThan(0);
      const flagged = fields.filter((f) =>
        run(p.template(`${f}: x`)).results.some((r) => r.rule === "V102"),
      );
      expect(flagged, `${p.topic}: documented but reported as unknown`).toEqual([]);
    });
  }
});
