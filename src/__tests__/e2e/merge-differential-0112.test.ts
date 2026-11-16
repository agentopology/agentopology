/**
 * 0.11.3 merges settings.json exactly as 0.11.2 did.
 *
 * rc3 changed the merge's hook identity (P-1) and a project-path hook whose
 * timeout or if: changed in the .at then ran twice: the old entry stayed, and
 * scaffold printed only "(config merged)". 0.11.3's rule: on every hook, gate
 * and settings path it behaves byte for byte like 0.11.2 (P-1 is 0.12).
 *
 * differential/merge-0112.json was frozen with a v0.11.2 build
 * (freeze-merge.mjs): scaffold → edit → re-scaffold sequences over project
 * paths, topology scripts and PATH tools; timeout, if, matcher, strength and
 * run changes; added and removed hooks; a user hook on the same script; user
 * edits between scaffolds; two hooks on one script with different if; prune
 * and dry-run. After every step, the exit code, the scaffold output and
 * settings.json must be byte-identical.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error plain JavaScript module, shared with freeze-merge.mjs
import { SEQUENCES, runSequence } from "./differential/merge-sequences.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, "../../../dist/cli/index.js");

interface Step { args: string; code: number | null; output: string; settings: string | null }
const frozen = JSON.parse(fs.readFileSync(join(here, "differential/merge-0112.json"), "utf-8")) as { sequences: Array<{ name: string; steps: Step[] }> };

describe("[D-merge-0112] every scaffold → edit → re-scaffold sequence matches 0.11.2", () => {
  it("the frozen sequences are the ones defined", () => {
    expect(frozen.sequences.map((s) => s.name)).toEqual((SEQUENCES as Array<{ name: string }>).map((s) => s.name));
  });

  it("exit code, output and settings.json are byte-identical after every step", () => {
    const diffs: string[] = [];
    for (const [i, seq] of (SEQUENCES as Array<{ name: string }>).entries()) {
      const now = runSequence(CLI, seq) as Step[];
      const was = frozen.sequences[i].steps;
      now.forEach((step, n) => {
        const w = was[n];
        const at = `${seq.name}, step ${n + 1} (${step.args})`;
        if (!w) return void diffs.push(`${at}: 0.11.2 has no such step`);
        if (w.code !== step.code) diffs.push(`${at}: exit ${w.code} -> ${step.code}`);
        if (w.settings !== step.settings) diffs.push(`${at}: settings.json differs\n--- 0.11.2\n${w.settings}\n--- now\n${step.settings}`);
        if (w.output !== step.output) diffs.push(`${at}: output differs\n--- 0.11.2\n${w.output}\n--- now\n${step.output}`);
      });
    }
    expect(diffs, `${diffs.length} differences from 0.11.2:\n${diffs.slice(0, 6).join("\n\n")}`).toEqual([]);
  }, 600_000);
});
