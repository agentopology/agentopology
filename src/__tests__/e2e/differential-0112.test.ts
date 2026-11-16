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
 * every run in examples/*.at, the shapes of the 0.11.3 attacks, a cross
 * product of first word × operator × interpreter, and parser shapes (escaped
 * quotes, backslashes, braces, `#`, CRLF), each as a topology hook, a gate and
 * an agent's own hook. For Claude Code and Codex the command and stubs; for
 * Claude Code, Codex, Cursor and claude-workflow a digest of every generated
 * file that changes (gate wrapper bodies, agent files, cursor hooks); for a
 * gate, what `step check` reports. Byte-identical where 0.11.2 resolved,
 * refused where it refused, with no exception.
 */

import { beforeAll, describe, it, expect } from "vitest";
import * as fs from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error plain JavaScript module, shared with freeze.mjs
import { TARGETS, baselinesFor, compileRun, loadLib } from "./differential/compile-runs.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(here, "../../../dist");

interface Emitted { refused: boolean; command: string | null; stubs: string[] }
interface Row {
  source: string; kind: "hook" | "gate" | "agent-hook"; run: string | null; lit?: string; crlf?: boolean;
  refused: boolean; parseError?: boolean; "claude-code"?: Emitted; codex?: Emitted; files?: Record<string, string>; step?: string;
}

const frozen = JSON.parse(fs.readFileSync(join(here, "differential/runs-0112.json"), "utf-8")) as { count: number; rows: Row[] };

describe("[D-0112] every hook and gate run resolves as 0.11.2 did", () => {
  it("the frozen corpus is the one committed", () => {
    expect(frozen.rows.length).toBe(frozen.count);
    expect(frozen.rows.length).toBeGreaterThan(2500);
  });

  // T1: the rows run in chunks of CHUNK, one test each, so a worker returns to
  // its event loop every few seconds (one 70-s loop tripped vitest's 60-s RPC
  // timeout). Every row is still asserted; the last test counts them.
  const CHUNK = 100;
  const chunks = Array.from({ length: Math.ceil(frozen.rows.length / CHUNK) }, (_, i) => i);
  let lib: unknown;
  let baselines: unknown;
  let asserted = 0;
  beforeAll(async () => {
    lib = await loadLib(DIST);
    baselines = baselinesFor(lib);
  });

  it.each(chunks)("byte-identical where 0.11.2 resolved, refused where it refused: rows %i00+", async (chunk) => {
    // Yield a macrotask first, so the worker reads vitest's RPC replies between chunks (T1).
    await new Promise((r) => setImmediate(r));
    const diffs: string[] = [];
    for (const row of frozen.rows.slice(chunk * CHUNK, (chunk + 1) * CHUNK)) {
      asserted++;
      const now = compileRun(lib, row.kind, row.run, baselines, { lit: row.lit, crlf: row.crlf }) as Row;
      const label = `${row.kind} ${row.lit ?? JSON.stringify(row.run)}${row.crlf ? " (CRLF)" : ""} (${row.source})`;
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
        if (was.command !== is.command) diffs.push(`${label} [${target}]: ${JSON.stringify(was.command)} -> ${JSON.stringify(is.command)}`);
        if (JSON.stringify(was.stubs) !== JSON.stringify(is.stubs)) diffs.push(`${label} [${target}]: stubs ${JSON.stringify(was.stubs)} -> ${JSON.stringify(is.stubs)}`);
      }
      for (const target of TARGETS as string[]) {
        if (row.files?.[target] !== now.files?.[target]) diffs.push(`${label} [${target}]: generated files differ`);
      }
      if (row.step !== now.step) diffs.push(`${label}: step check ${JSON.stringify(row.step)} -> ${JSON.stringify(now.step)}`);
    }
    expect(diffs, `${diffs.length} differences from 0.11.2:\n${diffs.slice(0, 40).join("\n")}`).toEqual([]);
  }, 120_000);

  it("asserted every frozen row", () => {
    expect(asserted).toBe(frozen.rows.length);
  });
});
