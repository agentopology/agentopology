/**
 * `agentopology step check <file.at> <step-id> [--unit U] [--dir D]` (N39).
 * A hook guards a Claude Code session only: a script run from a terminal or a
 * scheduler never sees it. The step calls step check at its start (by: code)
 * and stops on exit 1. It reads ledgers and runs check scripts; it never
 * writes.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import { checkStep, renderStepReport } from "../../step/check.js";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, "../../../dist/cli/index.js");

const SRC = `topology ship : [pipeline] {
  meta { version: "1.0.0" description: "Render, then publish" }
  orchestrator { model: sonnet handles: [render, publish, notify, tidy] }
  action render { kind: external commands: ["./tool render"] }
  action publish { kind: external commands: ["./tool publish"] unit-from: "./tool publish (\\S+)" }
  action notify { kind: external commands: ["./tool notify"] }
  action tidy { kind: external commands: ["./tool tidy"] }
  action archive { kind: external commands: ["./tool archive"] }
  records {
    record trace { path: "logs/{unit}/trace.jsonl" }
  }
  gates {
    gate publish-ready {
      after: render
      before: publish
      ledger: trace
    }
    gate notify-ready {
      before: notify
      run: "./check-notify.sh"
    }
    gate both {
      after: render
      before: archive
      ledger: trace
      run: "./check-notify.sh"
    }
    gate empty-gate {
      before: tidy
    }
  }
  flow { render -> publish -> notify -> tidy -> archive }
}
`;
const ast = parse(SRC);
// With one record declared, a gate with no ledger: reads it. Case (c) needs a topology with none.
const bare = parse(SRC.replace(/  records \{[\s\S]*?\n  \}\n/, "").replace(/ledger: trace\n/g, ""));

let dir: string;
const at = (p: string) => join(dir, p);
const rec = (step: string, ok: boolean, unit?: string) => ({ step, ...(unit ? { unit } : {}), ok, at: "2026-01-01T00:00:00Z" });
const ledger = (unit: string, lines: object[]) => {
  fs.mkdirSync(at(`logs/${unit}`), { recursive: true });
  fs.writeFileSync(at(`logs/${unit}/trace.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
};
const script = (code: number, name = "check-notify.sh") => fs.writeFileSync(at(name), `#!/bin/sh\necho "checked from $(pwd)" > ran.txt\necho "script said no" >&2\nexit ${code}\n`, { mode: 0o755 });

beforeEach(() => { dir = fs.mkdtempSync(join(os.tmpdir(), "at-step-check-")); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("[N39] step check: the three ways a gate is satisfied", () => {
  it("[N39] SC1 (a) a ledger whose last record for the after: step is ok satisfies the gate", () => {
    ledger("ep42", [rec("render", true, "ep42")]);
    const r = checkStep(ast, "publish", { unit: "ep42", dir });
    expect(r.ok).toBe(true);
    expect(r.gates).toEqual([expect.objectContaining({ gate: "publish-ready", ok: true })]);
  });

  it("[N39] SC2 (a) no record, a later ok:false, or no ledger file fails and says why", () => {
    let r = checkStep(ast, "publish", { unit: "ep42", dir });
    expect(r.ok).toBe(false);
    expect(r.gates[0].reasons.join(" ")).toContain("logs/ep42/trace.jsonl");
    ledger("ep42", [rec("render", true, "ep42"), rec("render", false, "ep42")]);
    r = checkStep(ast, "publish", { unit: "ep42", dir });
    expect(r.ok).toBe(false);
    expect(r.gates[0].reasons.join(" ")).toMatch(/not ok/);
  });

  it("[N39] SC3 (a) the unit filter: another unit's ok record does not count, and a path with {unit} needs --unit", () => {
    ledger("ep41", [rec("render", true, "ep41")]);
    ledger("ep42", [rec("render", true, "ep41")]);
    expect(checkStep(ast, "publish", { unit: "ep42", dir }).ok).toBe(false);
    const none = checkStep(ast, "publish", { dir });
    expect(none.ok).toBe(false);
    expect(none.gates[0].reasons.join(" ")).toMatch(/--unit/);
  });

  it("[N39] SC4 a unit that would climb out of the project fails instead of reading a path", () => {
    expect(checkStep(ast, "publish", { unit: "../../etc", dir }).ok).toBe(false);
  });

  it("[N39] SC5 (b) a run: that exits 0 from D satisfies the gate; non-zero fails, with its output", () => {
    script(0);
    let r = checkStep(ast, "notify", { dir });
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(at("ran.txt"), "utf8")).toContain(fs.realpathSync(dir));
    script(1);
    r = checkStep(ast, "notify", { dir });
    expect(r.ok).toBe(false);
    expect(r.gates[0].reasons.join(" ")).toContain("script said no");
  });

  it("[N39] SC6 (c) a gate with neither ledger nor run: is unsatisfiable: nothing to check", () => {
    const r = checkStep(bare, "tidy", { dir });
    expect(r.ok).toBe(false);
    expect(r.gates[0].reasons.join(" ")).toContain("nothing to check");
    // a ledger answers "did the after: step finish ok?": with no after: there is nothing to look up, even with one record declared
    expect(checkStep(ast, "tidy", { unit: "ep42", dir }).gates[0].reasons.join(" ")).toContain("nothing to check");
  });

  it("[N39] SC7 a gate with a ledger and a run: needs both", () => {
    script(0);
    expect(checkStep(ast, "archive", { unit: "ep42", dir }).ok).toBe(false);
    ledger("ep42", [rec("render", true, "ep42")]);
    expect(checkStep(ast, "archive", { unit: "ep42", dir }).ok).toBe(true);
    script(3);
    expect(checkStep(ast, "archive", { unit: "ep42", dir }).ok).toBe(false);
  });

  it("[N39] SC8 a step no gate guards passes with the line \"no gate guards <step>\"", () => {
    const r = checkStep(ast, "render", { dir });
    expect(r).toMatchObject({ ok: true, gates: [] });
    expect(renderStepReport(r)).toEqual(["no gate guards render"]);
  });

  it("[N39] SC9 it never writes: the ledger is left as it was", () => {
    ledger("ep42", [rec("render", true, "ep42")]);
    const before = fs.readFileSync(at("logs/ep42/trace.jsonl"), "utf8");
    checkStep(ast, "publish", { unit: "ep42", dir });
    expect(fs.readFileSync(at("logs/ep42/trace.jsonl"), "utf8")).toBe(before);
    expect(fs.readdirSync(dir).sort()).toEqual(["logs"]);
  });

  it("[N39] SC10 the rendering names each failing gate and why", () => {
    const text = renderStepReport(checkStep(ast, "publish", { unit: "ep42", dir })).join("\n");
    expect(text).toContain("publish-ready");
    expect(text).toMatch(/fail/i);
  });
});

describe("[N39] step check: the CLI", () => {
  const run = (...args: string[]) => spawnSync("node", [CLI, "step", "check", ...args], { encoding: "utf8" });
  let file: string;
  beforeEach(() => { file = at("ship.at"); fs.writeFileSync(file, SRC); });

  it("[N39] SC11 exits 0 when satisfied, 1 when not, naming the gate", () => {
    ledger("ep42", [rec("render", true, "ep42")]);
    const ok = run(file, "publish", "--unit", "ep42", "--dir", dir);
    expect(ok.status).toBe(0);
    const bad = run(file, "publish", "--unit", "ep43", "--dir", dir);
    expect(bad.status).toBe(1);
    expect(bad.stdout + bad.stderr).toContain("publish-ready");
  });

  it("[N39] SC12 an unguarded step exits 0 and says so; --dir defaults to .", () => {
    const r = spawnSync("node", [CLI, "step", "check", file, "render"], { encoding: "utf8", cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("no gate guards render");
  });

  it("[N39] SC13 a step that is no node, or missing arguments, exits 1", () => {
    expect(run(file, "nope", "--dir", dir).status).toBe(1);
    expect(run(file).status).toBe(1);
    expect(run().status).toBe(1);
  });
});
