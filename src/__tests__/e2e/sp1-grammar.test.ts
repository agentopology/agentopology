/**
 * SP-1: the grammar base for compose, records and the signed human gate
 * (docs/plans/sp-compose-records-human.md).
 *
 * Measured on the base (db3b973) with these fixtures: B1 gave 2 V102 errors
 * (record `written-by`, `append-only`); C1 gave 6 V102 errors on the human
 * (`answered-by`, `instrument`, `record`, `covers`, `signed`, `key`) plus the
 * same 2 on its record; `pin-imports: true` gave 1 V102. SP-1 parses and keeps
 * every one of them. It adds no rule: the three rule modules are empty.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import { validate } from "../../parser/validator.js";
import { serializeAST } from "../../import/serializer.js";
import { jsonExporter } from "../../exporters/json.js";
import { projectNode, unclaimedFields, LIST_RULES, project } from "../../visualizer/project.js";
import { composeRules } from "../../compose/index.js";
import { recordRules } from "../../records/index.js";
import { humanRules } from "../../human/index.js";
import type { HumanNode } from "../../parser/ast.js";

const FIX = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures");
const B1 = resolve(FIX, "records/b1/topology.at");
const C1 = resolve(FIX, "human/c1/topology.at");

function load(file: string) {
  return parse(fs.readFileSync(file, "utf8"));
}

function exported(file: string): any {
  return JSON.parse(jsonExporter.export(load(file))[0].content);
}

function errorsOf(file: string, rule?: string) {
  return validate(load(file), { filePath: file }).filter((r) => r.level === "error" && (!rule || r.rule === rule));
}

/** Strip parse-time internals (`_` keys) so two ASTs compare by content. */
function clean(ast: object): unknown {
  return JSON.parse(JSON.stringify(ast, (k, v) => (k.startsWith("_") ? undefined : v)));
}

describe("[SP-1][B1] a record with written-by and append-only", () => {
  it("[SP-1][B1] validates with 0 V102 errors (2 on the base)", () => {
    expect(errorsOf(B1, "V102").map((e) => e.message)).toEqual([]);
    expect(errorsOf(B1)).toEqual([]);
  });

  it("[SP-1][B1] both fields are in the JSON export", () => {
    const rec = exported(B1).records.find((r: any) => r.id === "approvals");
    expect(rec).toEqual({
      id: "approvals",
      path: "records/approvals.jsonl",
      writtenBy: ["scripts/approve.py"],
      appendOnly: true,
    });
  });
});

describe("[SP-1][C1] a human with the signed-gate fields", () => {
  it("[SP-1][C1] validates with 0 V102 errors (8 on the base: 6 human, 2 record)", () => {
    expect(errorsOf(C1, "V102").map((e) => e.message)).toEqual([]);
    expect(errorsOf(C1)).toEqual([]);
  });

  it("[SP-1][C1] every new field is in the JSON export", () => {
    const human = exported(C1).nodes.find((n: any) => n.id === "approve");
    expect(human).toMatchObject({
      type: "human",
      answeredBy: "instrument",
      instrument: "scripts/approve.py",
      record: "approvals",
      covers: ["work/kits/{unit}/*", "!work/kits/{unit}/kit.json"],
      signed: "ed25519",
      key: "keys/approve.pub",
      timeout: "1d",
      onTimeout: "halt",
    });
  });
});

const RECORD_ALL = `topology rec-all : [pipeline] {
  meta {
    version: "1.0.0"
    description: "every record field"
  }

  agent maker {
    model: sonnet
    description: "Makes"
  }

  hooks {
    hook protect-records {
      on: PreToolUse
      matcher: "Write|Edit"
      run: "exit 2"
    }
    hook protect-bash {
      on: PreToolUse
      matcher: "Bash"
      run: "exit 2"
    }
  }

  records {
    record approvals {
      path: "records/approvals.jsonl"
      written-by: ["scripts/approve.py", "maker"]
      append-only: true
      guard: [protect-records, protect-bash]
      description: "The yes rows of the owner"
    }
    record trace {
      path: "work/{unit}/trace.jsonl"
      written-by: [
        "scripts/trace.py",
        "maker"
      ]
      append-only: false
    }
    record bare { path: "records/bare.jsonl" }
  }
}
`;

const PIN = `import making from "./making.at"

topology pinned : [pipeline] {
  pin-imports: true

  meta {
    version: "1.0.0"
    description: "pin-imports at the top level"
  }

  agent manager {
    model: sonnet
    description: "Manages"
  }
}
`;

describe("[SP-1] record fields: written-by, append-only, guard, description", () => {
  it("[SP-1] all four parse, inline and multi-line lists, with no V102", () => {
    const ast = parse(RECORD_ALL);
    expect(ast.records).toEqual([
      {
        id: "approvals",
        path: "records/approvals.jsonl",
        writtenBy: ["scripts/approve.py", "maker"],
        appendOnly: true,
        guard: ["protect-records", "protect-bash"],
        description: "The yes rows of the owner",
      },
      { id: "trace", path: "work/{unit}/trace.jsonl", writtenBy: ["scripts/trace.py", "maker"], appendOnly: false },
      { id: "bare", path: "records/bare.jsonl" },
    ]);
    expect(validate(ast).filter((r) => r.rule === "V102")).toEqual([]);
  });

  it("[SP-1] a field a record does not take is still V102", () => {
    const ast = parse(RECORD_ALL.replace("append-only: true", "append-only: true\n      writen-by: [x]"));
    expect(validate(ast).filter((r) => r.rule === "V102").map((r) => r.message).join("\n")).toMatch(/writen-by/);
  });
});

describe("[SP-1] top-level pin-imports", () => {
  it("[SP-1] parses to pinImports with no V102 (1 on the base)", () => {
    const ast = parse(PIN);
    expect(ast.pinImports).toBe(true);
    expect(validate(ast).filter((r) => r.rule === "V102")).toEqual([]);
    expect(parse(PIN.replace("pin-imports: true", "pin-imports: false")).pinImports).toBe(false);
    expect(parse(PIN.replace("  pin-imports: true\n", "")).pinImports).toBeUndefined();
  });

  it("[SP-1] is in the JSON export", () => {
    const json = JSON.parse(jsonExporter.export(parse(PIN))[0].content);
    expect(json.pinImports).toBe(true);
  });
});

describe("[SP-1] alias.node is a name in flow and in gate anchors", () => {
  const MASTER = `import making from "./making.at"

topology master : [pipeline] {
  meta {
    version: "1.0.0"
    description: "master"
  }

  agent manager {
    model: sonnet
    description: "Manages"
  }

  action daily-report {
    kind: inline
    description: "Reports"
  }

  flow {
    manager -> making.main
    making.approve -> manager [message: report]
    making.mark-published -> daily-report
  }

  gates {
    gate report-needs-publish {
      after: making.mark-published
      before: daily-report
      run: "scripts/check.sh"
    }
    gate many {
      after: [making.approve, manager]
      before: daily-report
      run: "scripts/check.sh"
    }
  }
}
`;

  it("[SP-1] the parser keeps alias.node whole in flow edges and gate anchors", () => {
    const ast = parse(MASTER);
    expect(ast.edges.map((e) => [e.from, e.to])).toEqual([
      ["manager", "making.main"],
      ["making.approve", "manager"],
      ["making.mark-published", "daily-report"],
    ]);
    const gates = ast.nodes.filter((n) => n.type === "gate") as any[];
    expect(gates.map((g) => [g.after, g.before])).toEqual([
      ["making.mark-published", "daily-report"],
      [["making.approve", "manager"], "daily-report"],
    ]);
  });

  it("[SP-1] it round-trips through the serializer", () => {
    const ast = parse(MASTER);
    expect(clean(parse(serializeAST(ast)))).toEqual(clean(ast));
  });
});

describe("[SP-1] the serializer round-trips every new field", () => {
  for (const [name, src] of [
    ["B1 fixture", () => fs.readFileSync(B1, "utf8")],
    ["C1 fixture", () => fs.readFileSync(C1, "utf8")],
    ["every record field", () => RECORD_ALL],
    ["pin-imports", () => PIN],
  ] as const) {
    it(`[SP-1] ${name}: parse, serialize, parse gives the same AST`, () => {
      const ast = parse(src());
      const again = parse(serializeAST(ast));
      expect(clean(again)).toEqual(clean(ast));
    });
  }

  it("[SP-1] the round trip keeps each new field (not just equal-because-both-empty)", () => {
    const again = parse(serializeAST(parse(fs.readFileSync(C1, "utf8"))));
    const h = again.nodes.find((n) => n.id === "approve") as HumanNode;
    expect([h.answeredBy, h.instrument, h.record, h.covers, h.signed, h.key]).toEqual([
      "instrument", "scripts/approve.py", "approvals",
      ["work/kits/{unit}/*", "!work/kits/{unit}/kit.json"], "ed25519", "keys/approve.pub",
    ]);
    const r = parse(serializeAST(parse(RECORD_ALL))).records!;
    expect(r[0].guard).toEqual(["protect-records", "protect-bash"]);
    expect(r[0].description).toBe("The yes rows of the owner");
    expect(parse(serializeAST(parse(PIN))).pinImports).toBe(true);
  });
});

describe("[SP-1] three empty rule modules, called by validate", () => {
  it("[SP-1] compose, records and human rules exist and find nothing yet", () => {
    for (const file of [B1, C1]) {
      const ast = load(file);
      expect(composeRules(ast, { filePath: file })).toEqual([]);
      expect(recordRules(ast)).toEqual([]);
      expect(humanRules(ast)).toEqual([]);
    }
  });

  it("[SP-1] validate calls each module (a call site per module)", () => {
    const src = fs.readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../parser/validator.ts"), "utf8");
    expect(src).toMatch(/\.\.\.composeRules\(ast, opts\)/);
    expect(src).toMatch(/\.\.\.recordRules\(ast\)/);
    expect(src).toMatch(/\.\.\.humanRules\(ast\)/);
  });
});

describe("[SP-1] the visualizer rules table has a row for each", () => {
  it("[SP-1] the human row carries the new human fields (none dropped)", () => {
    const human = load(C1).nodes.find((n) => n.id === "approve")!;
    const out = projectNode(human);
    expect(unclaimedFields(human as any, out)).toEqual([]);
    expect(out).toMatchObject({ answeredBy: "instrument", record: "approvals", signed: "ed25519" });
  });

  it("[SP-1] records and imports have rows and reach the page", () => {
    expect(LIST_RULES.record.carry).toEqual(["id", "path", "writtenBy", "appendOnly", "guard", "description"]);
    expect(LIST_RULES.import.carry).toContain("sha256");
    const page = project(parse(RECORD_ALL));
    expect(page.records[0]).toMatchObject({ id: "approvals", writtenBy: ["scripts/approve.py", "maker"], appendOnly: true });
    const pinned = project(parse(PIN));
    expect(pinned.imports).toEqual([expect.objectContaining({ alias: "making", source: "./making.at" })]);
    expect(pinned.topology.pinImports).toBe(true);
  });
});
