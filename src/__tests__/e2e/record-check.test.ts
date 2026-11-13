/**
 * SP-8, test B7: `agentopology record check FILE.at [id] [--unit U] [--dir D]`.
 * A head file per record (line count and the sha256 of those lines) under
 * `.agentopology/records/`. An appended line moves the head forward (exit 0);
 * an earlier line edited, or the file cut short, exits 1. `step check` runs
 * the same check before it reads a ledger, so a damaged ledger never opens a
 * gate.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import { checkStep } from "../../step/check.js";
import { RECORD_HEADS_DIR, headPath, checkRecords } from "../../records/head.js";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, "../../../dist/cli/index.js");

const SRC = `topology ship : [pipeline] {
  meta { version: "1.0.0" description: "Render, then publish (made-up content)" }
  orchestrator { model: sonnet handles: [render, publish, approve-step] }
  action render { kind: external commands: ["./tool render"] }
  action publish { kind: external commands: ["./tool publish"] }
  action approve-step { kind: external commands: ["./tool approve"] }
  action ship-unit { kind: external commands: ["./tool ship"] }
  records {
    record approvals {
      path: "records/approvals.jsonl"
      written-by: ["scripts/approve.py"]
      append-only: true
    }
    record trace {
      path: "work/{unit}/trace.jsonl"
      written-by: ["scripts/trace.py"]
      append-only: true
    }
    record notes {
      path: "records/notes.jsonl"
      written-by: ["scripts/approve.py"]
    }
  }
  gates {
    gate publish-ready {
      after: render
      before: publish
      ledger: approvals
    }
    gate ship-ready {
      after: render
      before: ship-unit
      ledger: trace
    }
  }
  flow { render -> publish -> approve-step -> ship-unit }
}
`;
const ast = parse(SRC);

let dir: string;
const at = (p: string) => join(dir, p);
const line = (step: string, ok: boolean, unit?: string) =>
  JSON.stringify({ step, ...(unit ? { unit } : {}), ok, at: "2026-01-01T00:00:00Z" }) + "\n";
const write = (rel: string, text: string) => {
  fs.mkdirSync(dirname(at(rel)), { recursive: true });
  fs.writeFileSync(at(rel), text);
};
const cli = (...args: string[]) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", cwd: dir });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};

beforeEach(() => {
  dir = fs.mkdtempSync(join(os.tmpdir(), "at-record-check-"));
  fs.writeFileSync(at("ship.at"), SRC);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("[SP-8][B7] record check: append ok, rewrite and truncation refused", () => {
  it("[SP-8][B7] the head files live under .agentopology/records/, one per record (and unit)", () => {
    expect(RECORD_HEADS_DIR).toBe(".agentopology/records");
    expect(headPath("approvals")).toBe(".agentopology/records/approvals.head");
    expect(headPath("trace", "ep1")).toBe(".agentopology/records/trace/ep1.head");
  });

  it("[SP-8][B7] first run writes the head; one appended line exits 0 and moves it forward", () => {
    write("records/approvals.jsonl", line("render", true));
    let r = cli("record", "check", "ship.at", "approvals");
    expect(r.code, r.out).toBe(0);
    const head = JSON.parse(fs.readFileSync(at(headPath("approvals")), "utf8"));
    expect(head.lines).toBe(1);
    expect(head.sha256).toMatch(/^[0-9a-f]{64}$/);

    fs.appendFileSync(at("records/approvals.jsonl"), line("render", false));
    r = cli("record", "check", "ship.at", "approvals");
    expect(r.code, r.out).toBe(0);
    expect(JSON.parse(fs.readFileSync(at(headPath("approvals")), "utf8")).lines).toBe(2);
  });

  it("[SP-8][B7] one earlier line edited exits 1, and the head stays where it was", () => {
    write("records/approvals.jsonl", line("render", false) + line("publish", true));
    expect(cli("record", "check", "ship.at", "approvals").code).toBe(0);
    const before = fs.readFileSync(at(headPath("approvals")), "utf8");
    write("records/approvals.jsonl", line("render", true) + line("publish", true) + line("render", true));
    const r = cli("record", "check", "ship.at", "approvals");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/approvals/);
    expect(r.out).toMatch(/rewritten/);
    expect(fs.readFileSync(at(headPath("approvals")), "utf8")).toBe(before);
  });

  it("[SP-8][B7] truncation exits 1 (lines removed, or the file deleted)", () => {
    write("records/approvals.jsonl", line("render", true) + line("publish", true));
    expect(cli("record", "check", "ship.at").code).toBe(0);
    write("records/approvals.jsonl", line("render", true));
    let r = cli("record", "check", "ship.at");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/truncated/);
    fs.rmSync(at("records/approvals.jsonl"));
    r = cli("record", "check", "ship.at", "approvals");
    expect(r.code).toBe(1);
  });

  it("[SP-8][B7] a {unit} record keeps one head per unit; with no --unit every unit file is checked", () => {
    write("work/ep1/trace.jsonl", line("render", true, "ep1"));
    write("work/ep2/trace.jsonl", line("render", true, "ep2"));
    expect(cli("record", "check", "ship.at", "trace").code).toBe(0);
    expect(fs.existsSync(at(headPath("trace", "ep1")))).toBe(true);
    expect(fs.existsSync(at(headPath("trace", "ep2")))).toBe(true);
    write("work/ep2/trace.jsonl", line("render", false, "ep2"));
    expect(cli("record", "check", "ship.at", "trace", "--unit", "ep1").code).toBe(0);
    expect(cli("record", "check", "ship.at", "trace", "--unit", "ep2").code).toBe(1);
    expect(cli("record", "check", "ship.at").code).toBe(1);
  });

  it("[SP-8][B7] an unknown record id exits 1; a record that is not append-only is not checked", () => {
    expect(cli("record", "check", "ship.at", "nope").code).toBe(1);
    write("records/notes.jsonl", line("a", true));
    const r = checkRecords(ast, { id: "notes", dir });
    expect(r.ok).toBe(true);
    expect(fs.existsSync(at(headPath("notes")))).toBe(false);
  });

  it("[SP-8][B7] step check on a gate that reads the ledger exits 1 after an edit and after truncation", () => {
    write("records/approvals.jsonl", line("render", false) + line("render", true));
    expect(checkStep(ast, "publish", { dir }).ok).toBe(true); // first read: head written, gate holds
    expect(fs.existsSync(at(headPath("approvals")))).toBe(true);

    // An earlier line edited: the last record still says ok, but the ledger was rewritten.
    write("records/approvals.jsonl", line("render", true) + line("render", true));
    let r = checkStep(ast, "publish", { dir });
    expect(r.ok).toBe(false);
    expect(r.gates[0].reasons.join(" ")).toMatch(/rewritten/);
    expect(cli("step", "check", "ship.at", "publish").code).toBe(1);

    // Truncation: cut back to one ok line.
    fs.rmSync(at(".agentopology"), { recursive: true });
    write("records/approvals.jsonl", line("render", false) + line("render", true));
    expect(checkStep(ast, "publish", { dir }).ok).toBe(true);
    write("records/approvals.jsonl", line("render", true));
    r = checkStep(ast, "publish", { dir });
    expect(r.ok).toBe(false);
    expect(r.gates[0].reasons.join(" ")).toMatch(/truncated/);
    expect(cli("step", "check", "ship.at", "publish").code).toBe(1);
  });

  it("[SP-8][B7] step check on a {unit} ledger checks that unit's head", () => {
    write("work/ep1/trace.jsonl", line("render", false, "ep1") + line("render", true, "ep1"));
    expect(checkStep(ast, "ship-unit", { unit: "ep1", dir }).ok).toBe(true);
    fs.appendFileSync(at("work/ep1/trace.jsonl"), line("render", true, "ep1"));
    expect(checkStep(ast, "ship-unit", { unit: "ep1", dir }).ok).toBe(true);
    write("work/ep1/trace.jsonl", line("render", true, "ep1"));
    expect(checkStep(ast, "ship-unit", { unit: "ep1", dir }).ok).toBe(false);
  });
});
