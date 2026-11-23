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
 * settings.json must be byte-identical, except for the stub rulings
 * (differential/stub-rulings.mjs): the stub summary is compared out, and a
 * gate whose check script is a stub is graded none.
 *
 * One named exception, read as a path (differential/read-as-path.ts): an rt
 * harness whose hook command runs a script through `$CLAUDE_PROJECT_DIR` after
 * an interpreter, or with interpreter flags, which 0.11.2 did not compile
 * (import refused it, or scaffold did), now imports, validates and scaffolds
 * with exit 0, and settings.json keeps the harness's own entry after every
 * step: no second entry, nothing rewritten. The number of such sequences is
 * pinned (READ_AS_PATH).
 *
 * Another named exception, refuse-stub-regenerated (differential/refuse-stub.ts,
 * approved for 0.13.0): a refuse hook's stub now blocks its call, so adding
 * `strength: refuse` regenerates the stub, and that scaffold prints one
 * `(script regenerated)` line and moves one file from unchanged to updated.
 * A sequence whose only difference is that is held to the class; exit codes
 * and settings.json are still compared, and any other difference stays red.
 * The number of such sequences is pinned (REFUSE_STUB_REGENERATED).
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error plain JavaScript module, shared with freeze-merge.mjs
import { runSequence } from "./differential/merge-sequences.mjs";
// @ts-expect-error plain JavaScript module, shared with freeze-merge.mjs
import { ALL_SEQUENCES as SEQUENCES } from "./differential/fable-sequences.mjs";
// @ts-expect-error plain JavaScript module
import { ruledSides } from "./differential/stub-rulings.mjs";
import { readAsPath, type ReadAsPathKind } from "./differential/read-as-path.js";
import { refuseStubRegenerated } from "./differential/refuse-stub.js";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, "../../../dist/cli/index.js");

/** The rt sequences read as a path, per kind: 0.11.2 did not compile their command; now every step exits 0, as its twin's does. */
const READ_AS_PATH: Record<ReadAsPathKind, number> = { "project-dir": 8, flags: 0, both: 1 };

/**
 * The sequences whose scaffold regenerates a refuse hook's stub (approved exception,
 * differential/refuse-stub.ts): a refuse hook's stub now blocks its call, so adding
 * `strength: refuse` regenerates it. Five: "topology script: strength refuse added" and
 * "PATH tool: strength refuse added", each also with "(settings.json edited between)", and
 * "hk T6 upgrade, .at adds strength: refuse". In the last, the stub list (2 stubs, no
 * action-done.sh) is main's: since 0.12.5 a report action with no commands is no stub.
 */
const REFUSE_STUB_REGENERATED = 5;

interface Step { args: string; code: number | null; output: string; settings: string | null }
/**
 * guard --check prints the Claude Code version installed on the machine that runs it
 * ("installed 2.1.325: unverified"). That is the host's version, not agentopology's behavior,
 * so this one token is compared as "installed <X>: unverified" on both sides. Nothing else changes.
 */
const INSTALLED = /installed \d+\.\d+\.\d+: unverified/g;
const hostless = (s: string): string => s.replace(INSTALLED, "installed <X>: unverified");
const frozen = JSON.parse(fs.readFileSync(join(here, "differential/merge-0112.json"), "utf-8")) as { sequences: Array<{ name: string; steps: Step[] }> };
const rtImport = new Map(
  (JSON.parse(fs.readFileSync(join(here, "differential/rt-import-0113.json"), "utf-8")) as { rows: Array<{ name: string; import: { code: number | null; output: string } }> })
    .rows.map((r) => [r.name, r.import] as const),
);

describe("[D-merge-0112] every scaffold → edit → re-scaffold sequence matches 0.11.2", () => {
  it("the frozen sequences are the ones defined", () => {
    expect(frozen.sequences.map((s) => s.name)).toEqual((SEQUENCES as Array<{ name: string }>).map((s) => s.name));
  });

  // T1: one test per sequence, so a worker returns to its event loop every few
  // seconds (one 120-s loop tripped vitest's 60-s RPC timeout). The last test
  // counts the steps asserted.
  let asserted = 0;
  const readAsPathSeqs: Record<ReadAsPathKind, string[]> = { "project-dir": [], flags: [], both: [] };
  const refuseStubSeqs = new Set<string>();
  const indexed = (SEQUENCES as Array<{ name: string }>).map((seq, i) => [seq.name, i] as const);

  it.each(indexed)("exit code, output and settings.json are byte-identical after every step: %s", async (_name, i) => {
    // Yield a macrotask first: synchronous tests chained on promises never let the
    // worker read vitest's RPC replies, and its 60-s timer then fires (T1).
    await new Promise((r) => setImmediate(r));
    const diffs: string[] = [];
    {
      const seq = (SEQUENCES as Array<{ name: string }>)[i];
      const now = runSequence(CLI, seq) as Step[];
      asserted += now.length;
      const was = frozen.sequences[i].steps;
      const rt = seq.name.startsWith("rt ");
      // Read as a path: 0.11.2 did not compile this command (import refused it, or scaffold did).
      const command = rt ? seq.name.slice(seq.name.indexOf(": ") + 2) : "";
      const read = rt ? readAsPath(command) : null;
      if (read && (rtImport.get(seq.name)?.code === 2 || was[2]?.code !== 0)) {
        readAsPathSeqs[read.kind].push(seq.name);
        // its twin (the harness holding the written-out command) runs the same steps with the same exit codes
        const twinSeq = { ...seq, setup: { ...(seq as unknown as { setup: Record<string, string> }).setup, ".claude/settings.json": JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: read.twin }] }] } }, null, 2) } };
        const twinSteps = runSequence(CLI, twinSeq) as Step[];
        now.forEach((step, n) => {
          const at = `${seq.name}, step ${n + 1} (${step.args})`;
          if (step.code !== 0) diffs.push(`${at}: exit ${step.code}, read as a path it compiles`);
          if (step.code !== twinSteps[n]?.code) diffs.push(`${at}: exit ${step.code}, its twin ${JSON.stringify(read.twin)} exits ${twinSteps[n]?.code}`);
          if (step.settings !== now[0].settings) diffs.push(`${at}: settings.json changed\n--- the harness's\n${now[0].settings}\n--- now\n${step.settings}`);
        });
        const hooks = JSON.parse(now[0].settings ?? "{}").hooks?.PreToolUse ?? [];
        if (JSON.stringify(hooks.flatMap((g: { hooks: Array<{ command: string }> }) => g.hooks.map((h) => h.command))) !== JSON.stringify([command])) {
          diffs.push(`${seq.name}: settings.json does not hold the harness's one command`);
        }
        expect(diffs, `${diffs.length} differences:\n${diffs.slice(0, 6).join("\n\n")}`).toEqual([]);
        return;
      }
      now.forEach((step, n) => {
        const w = was[n];
        const at = `${seq.name}, step ${n + 1} (${step.args})`;
        if (!w) return void diffs.push(`${at}: 0.11.2 has no such step`);
        // C (ruled): rt's import step is held to 0.11.3's reviewed reference (rt-import-0113.json);
        // its validate and scaffold steps to 0.11.2 wherever 0.11.2's import wrote a .at that
        // validated. Elsewhere the import invariant applies (import-invariant.test.ts).
        if (rt && n === 0) {
          const ref = rtImport.get(seq.name);
          if (!ref || ref.code !== step.code || ref.output !== step.output) diffs.push(`${at}: differs from 0.11.3's reviewed import reference`);
          return;
        }
        if (rt && was[1].code !== 0) return;
        // F7 (approved): a run 0.11.2's scaffold refused ("not safe file names") is refused by
        // validate now, and import says so (exit 2); scaffold still refuses, with V96's text.
        if (rt && n > 0 && now[0].code === 2 && was[2].code === 1 && now[2].code === 1) {
          if (n === 2 && w.settings !== step.settings) diffs.push(`${at}: settings.json differs`);
          return;
        }
        if (w.code !== step.code) diffs.push(`${at}: exit ${w.code} -> ${step.code}`);
        if (w.settings !== step.settings) diffs.push(`${at}: settings.json differs\n--- 0.11.2\n${w.settings}\n--- now\n${step.settings}`);
        // The stub rulings (differential/stub-rulings.mjs): the stub summary and a stubbed gate's grade.
        const [wasOut, nowOut] = ruledSides(hostless(w.output), hostless(step.output));
        if (wasOut === nowOut) return;
        // refuse-stub-regenerated (differential/refuse-stub.ts): only the regenerated stub line and the counts it moves.
        if (!rt && refuseStubRegenerated(wasOut, nowOut, hostless(step.output))) return void refuseStubSeqs.add(seq.name);
        diffs.push(`${at}: output differs\n--- 0.11.2\n${w.output}\n--- now\n${step.output}`);
      });
    }
    expect(diffs, `${diffs.length} differences from 0.11.2:\n${diffs.slice(0, 6).join("\n\n")}`).toEqual([]);
  }, 120_000);

  it("asserted every frozen step", () => {
    expect(asserted).toBe(frozen.sequences.reduce((n, s) => n + s.steps.length, 0));
  });

  it("held only the sequences that regenerate a refuse hook's stub to refuse-stub-regenerated, counted", () => {
    expect(refuseStubSeqs.size).toBe(REFUSE_STUB_REGENERATED);
  });

  it("held only the rt sequences read as a path to the read-as-path rule, counted per kind", () => {
    expect({ "project-dir": readAsPathSeqs["project-dir"].length, flags: readAsPathSeqs.flags.length, both: readAsPathSeqs.both.length }).toEqual(READ_AS_PATH);
  });
});
