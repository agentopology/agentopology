/**
 * [CX-10] The guard-script library move must not change the Claude Code
 * scaffold. Every example and every e2e fixture is scaffolded with the
 * claude-code target; a hash of every output file is compared with the hashes
 * recorded before the move (guards-golden.json).
 * Regenerate with: UPDATE_GOLDEN=1 npx vitest run src/bindings/lib/__tests__/guards-golden.test.ts
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../../parser/index.js";
import { claudeCodeBinding } from "../../claude-code.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");
const GOLDEN = join(here, "guards-golden.json");

function sources(): string[] {
  const out: string[] = [];
  for (const dir of ["examples", "src/__tests__/e2e/fixtures"]) {
    for (const f of fs.readdirSync(join(repo, dir)).sort()) {
      if (f.endsWith(".at")) out.push(`${dir}/${f}`);
    }
  }
  return out;
}

/** Inline topologies for guards no example reaches: a gated script step with a ledger and a run: gate. */
const INLINE: Record<string, string> = {
  "inline:action-gate": `topology ship : [pipeline] {
  meta { version: "1.0.0" description: "Render then publish" }
  orchestrator { model: sonnet handles: [render, publish] }
  action render {
    kind: external
    commands: ["./tool render"]
  }
  action publish {
    kind: external
    commands: ["./tool publish", "./tool republish"]
    unit-from: "./tool (?:re)?publish (\\S+)"
  }
  records {
    record trace { path: "logs/{unit}/trace.jsonl" }
  }
  gates {
    gate publish-ready {
      after: render
      before: publish
      ledger: trace
      on-fail: halt
    }
  }
  flow { render -> publish }
}
`,
};

const hash = (s: string) => createHash("sha256").update(s).digest("hex");

function snapshot(): Record<string, Record<string, string>> {
  const snap: Record<string, Record<string, string>> = {};
  const warn = console.warn;
  console.warn = () => {};
  try {
    const all: Array<[string, string]> = [
      ...sources().map((rel): [string, string] => [rel, fs.readFileSync(join(repo, rel), "utf8")]),
      ...Object.entries(INLINE),
    ];
    for (const [rel, text] of all) {
      const ast = parse(text);
      const files: Record<string, string> = {};
      for (const f of claudeCodeBinding.scaffold(ast)) {
        files[f.path] = hash(`${f.executable ? "x" : "-"}\n${f.content}`);
      }
      snap[rel] = files;
    }
  } finally {
    console.warn = warn;
  }
  return snap;
}

describe("[CX-10] claude-code scaffold is byte-identical", () => {
  it("[CX-10] hashes of every example and fixture output match the recorded golden", () => {
    const snap = snapshot();
    if (process.env.UPDATE_GOLDEN === "1") {
      fs.writeFileSync(GOLDEN, JSON.stringify(snap, null, 1) + "\n");
    }
    const golden = JSON.parse(fs.readFileSync(GOLDEN, "utf8"));
    expect(Object.keys(snap).length).toBeGreaterThanOrEqual(14);
    const bad = Object.keys(snap).flatMap((k) => Object.keys({ ...snap[k], ...golden[k] }).filter((f) => snap[k]?.[f] !== golden[k]?.[f]).map((f) => `${k}:${f}`));
    expect(bad).toEqual([]);
    expect(snap).toEqual(golden);
  });
});
