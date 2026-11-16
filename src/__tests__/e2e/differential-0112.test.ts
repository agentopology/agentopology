/**
 * 0.11.3 resolves every hook and gate `run:` exactly as 0.11.2 did.
 *
 * S-11 (emit a run holding a shell operator as written) shipped on main and
 * broke working guards in three rounds of fixes (F1, then N1-N3): a run that
 * 0.11.2 resolved to the topology's script was emitted as a relative path
 * that exits 127. 0.11.3 drops S-11 and returns to 0.11.2's resolution; this
 * test holds it there.
 *
 * differential/runs-0112.json was frozen with a v0.11.2 build (freeze.mjs):
 * every run in examples/*.at, the shapes of the 0.11.3 attack, and a cross
 * product of first word × operator × interpreter, each as a hook and as a
 * gate, for Claude Code and Codex. Where 0.11.2 resolved a run, this branch
 * must give byte-identical commands and the same stubs; where it refused
 * (V96, an unsafe path, a .at that does not parse), this branch must refuse.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error plain JavaScript module, shared with freeze.mjs
import { baselinesFor, compileRun, loadLib } from "./differential/compile-runs.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(here, "../../../dist");

interface Emitted { refused: boolean; command: string | null; stubs: string[] }
interface Row { source: string; kind: "hook" | "gate"; run: string; refused: boolean; "claude-code"?: Emitted; codex?: Emitted }

const frozen = JSON.parse(fs.readFileSync(join(here, "differential/runs-0112.json"), "utf-8")) as { count: number; rows: Row[] };

describe("[D-0112] every hook and gate run resolves as 0.11.2 did", () => {
  it("the frozen corpus is the one committed", () => {
    expect(frozen.rows.length).toBe(frozen.count);
    expect(frozen.rows.length).toBeGreaterThan(1500);
  });

  it("byte-identical where 0.11.2 resolved, refused where it refused", async () => {
    const lib = await loadLib(DIST);
    const baselines = baselinesFor(lib);
    const diffs: string[] = [];
    for (const row of frozen.rows) {
      const now = compileRun(lib, row.kind, row.run, baselines) as Row;
      const label = `${row.kind} ${JSON.stringify(row.run)} (${row.source})`;
      if (row.refused) {
        if (!now.refused) diffs.push(`${label}: 0.11.2 refused it; now resolves to ${JSON.stringify(now["claude-code"]?.command)}`);
        continue;
      }
      if (now.refused) {
        diffs.push(`${label}: 0.11.2 resolved it; now refused`);
        continue;
      }
      for (const target of ["claude-code", "codex"] as const) {
        const was = row[target]!;
        const is = now[target]!;
        if (was.refused !== is.refused) diffs.push(`${label} [${target}]: refused ${was.refused} -> ${is.refused}`);
        // No exceptions: byte-identical. (S-01's decode of `\"` and `\\` moved to 0.12.)
        if (was.command !== is.command) diffs.push(`${label} [${target}]: ${JSON.stringify(was.command)} -> ${JSON.stringify(is.command)}`);
        if (JSON.stringify(was.stubs) !== JSON.stringify(is.stubs)) diffs.push(`${label} [${target}]: stubs ${JSON.stringify(was.stubs)} -> ${JSON.stringify(is.stubs)}`);
      }
    }
    expect(diffs, `${diffs.length} runs differ from 0.11.2:\n${diffs.slice(0, 40).join("\n")}`).toEqual([]);
  }, 300_000);
});
