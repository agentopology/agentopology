/**
 * A manifest with no hook record (one 0.12.x wrote) is merged exactly as
 * 0.12.6 merged it.
 *
 * The frozen merge differential (merge-0112.json) holds, for every
 * scaffold → edit → re-scaffold sequence, the exit code, the output and
 * settings.json after each step, as 0.11.2 wrote them; 0.12.6 passes it
 * (merge-differential-0112.test.ts). Here each sequence runs again with the
 * hook record taken out of the manifest before every step, so every
 * re-scaffold reads a manifest as 0.12.x left it: each step must still match
 * the frozen one, byte for byte, settings.json entry for entry.
 *
 * Left out: a sequence whose first scaffold meets a settings.json that is
 * already there with no manifest (a hand-built harness, a user hook written
 * before the first scaffold, a manifest deleted, a second topology's first
 * run). With no manifest nothing is the topology's, so those runs are merged
 * by the (empty) record, not by the fallback; hook-ownership-record.test.ts
 * holds them.
 */

import { describe, it, expect } from "vitest";
import { resolve, dirname, join } from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
// @ts-expect-error plain JavaScript module, shared with freeze-merge.mjs
import { runSequence } from "./differential/merge-sequences.mjs";
// @ts-expect-error plain JavaScript module, shared with freeze-merge.mjs
import { ALL_SEQUENCES as SEQUENCES } from "./differential/fable-sequences.mjs";
// @ts-expect-error plain JavaScript module
import { ruledSides } from "./differential/stub-rulings.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, "../../../dist/cli/index.js");

interface Step { args: string; code: number | null; output: string; settings: string | null }
interface SeqStep { run?: string[]; settings?: unknown; nomanifest?: boolean; atFile?: { name: string }; manifest?: (m: Record<string, unknown>) => void }
interface Seq { name: string; setup?: Record<string, string>; steps: SeqStep[] }

const INSTALLED = /installed \d+\.\d+\.\d+: unverified/g;
const hostless = (s: string): string => s.replace(INSTALLED, "installed <X>: unverified");
const frozen = JSON.parse(fs.readFileSync(join(here, "differential/merge-0112.json"), "utf-8")) as { sequences: Array<{ name: string; steps: Step[] }> };

/** Whether a run of the sequence meets a settings.json with no manifest of its topology. */
function startsUnmanaged(seq: Seq): boolean {
  if (seq.setup?.[".claude/settings.json"] !== undefined) return true;
  const firstRun = seq.steps.findIndex((s) => s.run);
  if (seq.steps.slice(0, firstRun + 1).some((s) => s.settings)) return true;
  if (seq.steps.some((s) => s.nomanifest)) return true;
  return new Set(seq.steps.filter((s) => s.atFile).map((s) => s.atFile!.name)).size > 1;
}

/** The sequence with the hook record taken out of the manifest before every step that runs the CLI. */
function withoutRecord(seq: Seq): Seq {
  return {
    ...seq,
    steps: seq.steps.map((s) => {
      if (!s.run) return s;
      const earlier = s.manifest;
      return {
        ...s,
        manifest: (m: Record<string, unknown>) => {
          earlier?.(m);
          delete m.hooks;
        },
      };
    }),
  };
}

const ALL = SEQUENCES as Seq[];
const COVERED = ALL.map((seq, i) => [seq.name, i] as const).filter(([, i]) => !startsUnmanaged(ALL[i]));

describe("a manifest with no hook record merges as 0.12.6 did", () => {
  it("covers the sequences whose every re-scaffold reads a manifest", () => {
    expect(frozen.sequences.map((s) => s.name)).toEqual(ALL.map((s) => s.name));
    // Pinned, so the set cannot shrink unseen.
    expect(COVERED.length).toBe(COVERED_COUNT);
  });

  it.each(COVERED)("every step matches the frozen one with the record taken out: %s", async (_name, i) => {
    await new Promise((r) => setImmediate(r));
    const now = runSequence(CLI, withoutRecord(ALL[i])) as Step[];
    const was = frozen.sequences[i].steps;
    const diffs: string[] = [];
    now.forEach((step, n) => {
      const w = was[n];
      const at = `${ALL[i].name}, step ${n + 1} (${step.args})`;
      if (!w) return void diffs.push(`${at}: no frozen step`);
      if (w.code !== step.code) diffs.push(`${at}: exit ${w.code} -> ${step.code}`);
      if (w.settings !== step.settings) diffs.push(`${at}: settings.json differs\n--- frozen\n${w.settings}\n--- now\n${step.settings}`);
      const [wasOut, nowOut] = ruledSides(hostless(w.output), hostless(step.output));
      if (wasOut !== nowOut) diffs.push(`${at}: output differs\n--- frozen\n${w.output}\n--- now\n${step.output}`);
    });
    expect(now.length).toBe(was.length);
    expect(diffs, `${diffs.length} differences:\n${diffs.slice(0, 6).join("\n\n")}`).toEqual([]);
  }, 120_000);
});

const COVERED_COUNT = 79;
