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
 *
 * A further named exception, hook ownership by record (differential/hook-record.ts,
 * approved for 0.13.0): scaffold removes a recorded entry the .at no longer
 * generates, with a line, and keeps every entry it did not write. A sequence
 * that differs from 0.11.2 only that way is held to one of three classes
 * (removed-line, generated-removed, user-kept); any other difference stays red.
 * The number per class is pinned (HOOK_RECORD).
 *
 * A fifth named exception, unescaped-quote-warning (differential/unescaped-quote.ts,
 * approved for 0.13.0): an rt harness whose imported run: keeps a `\"` the run
 * reader does not decode gets a new V96 warning; validate's output and import's
 * verdict line differ by that warning only. Pinned (UNESCAPED_QUOTE_WARNING).
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
import { hookRecordKind, laterKeptLine, type HookRecordKind } from "./differential/hook-record.js";
import { unescapedQuoteImport, unescapedQuoteValidate } from "./differential/unescaped-quote.js";

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

/**
 * The sequences hook ownership by record changes (approved exception), per
 * class (differential/hook-record.ts has each class's rule):
 *   removed-line: settings.json as 0.11.2's; only `- removed generated hook` lines added.
 *   generated-removed: an entry scaffold wrote and the .at no longer generates is gone, with its line.
 *   user-kept: an entry the user wrote, which 0.11.2 removed or replaced, is kept and named.
 */
/**
 * generated-removed: 15 (was 16). "hk T14 user's own hook equals the generated one (import
 * shape), then .at removes it" left it when a first scaffold with no manifest stopped
 * recording entries already in the file: the user's entry is no longer removed when the
 * .at drops its hook, so the sequence is byte-identical to 0.11.2 again.
 */
const GENERATED_REMOVED = 15;
const HOOK_RECORD: Record<HookRecordKind, number> = { "removed-line": 19, "generated-removed": GENERATED_REMOVED, "user-kept": 6 };

/**
 * later-kept-line (approved, differential/hook-record.ts): a first scaffold with no
 * manifest records no entry that was in the file before it, so a later scaffold says
 * the user's entry equal to a generated one is the user's. Two: "user hook on the same
 * project script before the first scaffold (if A vs the .at's if B)" and "user hook on
 * the same project script, timeout 1 vs the .at's 600000"; settings.json and exit codes
 * byte-identical.
 */
const LATER_KEPT_LINE = 2;

/**
 * The rt sequences whose imported run: keeps a `\"` the run reader does not decode
 * (approved exception, differential/unescaped-quote.ts): validate now warns on it (V96),
 * and that warning, in validate's output and in import's verdict line, is the only
 * difference. Fifteen: the inline echo and printf forms, `./.claude/hooks/x.sh "$1"`,
 * uv, npx, bun run, bash -c, osascript and powershell. The warning is a warning on
 * every hook and gate, so no exit code moves; a run V96 already refuses gets no
 * second message.
 */
const UNESCAPED_QUOTE_WARNING = 15;

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
  const quoteSeqs = new Set<string>();
  const hookRecordSeqs: Record<HookRecordKind, string[]> = { "removed-line": [], "generated-removed": [], "user-kept": [] };
  const laterKeptSeqs: string[] = [];
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
      const outputs: Array<[string, string]> = [];
      now.forEach((step, n) => {
        const w = was[n];
        const at = `${seq.name}, step ${n + 1} (${step.args})`;
        if (w) outputs.push(ruledSides(hostless(w.output), hostless(step.output)));
        if (!w) return void diffs.push(`${at}: 0.11.2 has no such step`);
        // C (ruled): rt's import step is held to 0.11.3's reviewed reference (rt-import-0113.json);
        // its validate and scaffold steps to 0.11.2 wherever 0.11.2's import wrote a .at that
        // validated. Elsewhere the import invariant applies (import-invariant.test.ts).
        if (rt && n === 0) {
          const ref = rtImport.get(seq.name);
          if (ref && ref.code === step.code && ref.output === step.output) return;
          // unescaped-quote-warning (differential/unescaped-quote.ts): only import's verdict line, for the new warning.
          const back = ref && ref.code === step.code && now[1] ? unescapedQuoteImport(step.output, hostless(now[1].output)) : null;
          if (back !== null && back === ref!.output) return void quoteSeqs.add(seq.name);
          diffs.push(`${at}: differs from 0.11.3's reviewed import reference`);
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
        // unescaped-quote-warning (differential/unescaped-quote.ts): only the new V96 warning on rt's validate step.
        const unwarned = rt && n === 1 ? unescapedQuoteValidate(hostless(step.output)) : null;
        if (unwarned !== null) {
          const [wasBack, nowBack] = ruledSides(hostless(w.output), unwarned);
          if (wasBack === nowBack) return void quoteSeqs.add(seq.name);
        }
        diffs.push(`${at}: output differs\n--- 0.11.2\n${w.output}\n--- now\n${step.output}`);
      });
      // Hook ownership by record (differential/hook-record.ts): a sequence that
      // differs only as the record says is held to its class; any other
      // difference stays red.
      if (diffs.length > 0 && !rt) {
        const kind = hookRecordKind(was, now, outputs);
        if (kind) {
          hookRecordSeqs[kind].push(seq.name);
          return;
        }
        if (laterKeptLine(was, now, outputs)) {
          laterKeptSeqs.push(seq.name);
          return;
        }
      }
    }
    expect(diffs, `${diffs.length} differences from 0.11.2:\n${diffs.slice(0, 6).join("\n\n")}`).toEqual([]);
  }, 120_000);

  it("asserted every frozen step", () => {
    expect(asserted).toBe(frozen.sequences.reduce((n, s) => n + s.steps.length, 0));
  });

  it("held only the sequences that regenerate a refuse hook's stub to refuse-stub-regenerated, counted", () => {
    expect(refuseStubSeqs.size).toBe(REFUSE_STUB_REGENERATED);
  });

  it("held only the sequences hook ownership by record changes to its classes, counted per class", () => {
    expect({
      "removed-line": hookRecordSeqs["removed-line"].length,
      "generated-removed": hookRecordSeqs["generated-removed"].length,
      "user-kept": hookRecordSeqs["user-kept"].length,
    }).toEqual(HOOK_RECORD);
  });

  it("held only the sequences whose later scaffold says the user's same hook to later-kept-line, counted", () => {
    expect(laterKeptSeqs.length).toBe(LATER_KEPT_LINE);
    // Planted: a pin one lower fails, for this class and for generated-removed.
    expect(() => expect(laterKeptSeqs.length).toBe(LATER_KEPT_LINE - 1)).toThrow();
    expect(() => expect(hookRecordSeqs["generated-removed"].length).toBe(GENERATED_REMOVED - 1)).toThrow();
  });

  it("held only the rt sequences whose run: keeps a \\\" to unescaped-quote-warning, counted", () => {
    expect(quoteSeqs.size).toBe(UNESCAPED_QUOTE_WARNING);
  });

  it("held only the rt sequences read as a path to the read-as-path rule, counted per kind", () => {
    expect({ "project-dir": readAsPathSeqs["project-dir"].length, flags: readAsPathSeqs.flags.length, both: readAsPathSeqs.both.length }).toEqual(READ_AS_PATH);
  });
});

/**
 * Planted: the edited-copy allowance of hook-record.ts excuses an original
 * that is gone only for a copy that runs the same script. A different hook
 * under the same event and matcher, with the same kept line, is not excused.
 */
describe("[D-merge-0112] the edited-copy allowance compares the hook's script", () => {
  const settings = (command: string) =>
    JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command }] }] } }, null, 2);
  const original = 'bash "$CLAUDE_PROJECT_DIR/tools/lint.sh"';
  const head = "Scaffolding t for Anthropic Claude Code CLI.\n\n  0 created, 1 updated, 3 unchanged, 0 conflicts\n";
  const kept =
    "  ! .claude/settings.json hooks.PreToolUse: kept your edited copy of PreToolUse Bash; the generated hook is not added again; delete your copy to get it back\n";
  const run = (copy: string) => {
    const was = [{ code: 0, output: head, settings: settings(original) }];
    const now = [{ code: 0, output: kept + head, settings: settings(copy) }];
    return hookRecordKind(was, now, [[head, kept + head]]);
  };

  it("a copy of the same script (an argument added) is user-kept", () => {
    expect(run(`${original} --fast`)).toBe("user-kept");
  });

  it("another script under the same event and matcher is not excused", () => {
    expect(run('bash "$CLAUDE_PROJECT_DIR/tools/other.sh" --fast')).toBeNull();
  });
});

/** Planted: later-kept-line holds only its line, at a later step, with settings.json and exit codes unchanged. */
describe("[D-merge-0112] the later-kept-line class is strict", () => {
  const settings = JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "bash x.sh" }] }] } }, null, 2);
  const head = "Scaffolding t.\n\n  0 created, 0 updated, 6 unchanged, 0 conflicts\n";
  const kept =
    '  ! .claude/settings.json hooks.PreToolUse: kept your hook Bash bash "$CLAUDE_PROJECT_DIR/x.sh": scaffold did not write it, and the .at generates the same entry, so it stays yours and is not written twice\n';
  const step = (output: string, s = settings, code = 0) => ({ code, output, settings: s });
  const outs = (pairs: Array<[string, string]>) => pairs;

  it("the line at a later step, nothing else changed: held", () => {
    expect(laterKeptLine([step(head), step(head)], [step(head), step(kept + head)], outs([[head, head], [head, kept + head]]))).toBe(true);
  });

  it("the line at the first step: not held", () => {
    expect(laterKeptLine([step(head), step(head)], [step(kept + head), step(head)], outs([[head, kept + head], [head, head]]))).toBe(false);
  });

  it("the line with settings.json changed: not held", () => {
    const other = settings.replace("bash x.sh", "bash y.sh");
    expect(laterKeptLine([step(head), step(head)], [step(head), step(kept + head, other)], outs([[head, head], [head, kept + head]]))).toBe(false);
  });

  it("another added line beside it: not held", () => {
    const more = kept + "  ! .claude/settings.json hooks.PreToolUse: kept a command the .at does not generate: bash y.sh\n";
    expect(laterKeptLine([step(head), step(head)], [step(head), step(more + head)], outs([[head, head], [head, more + head]]))).toBe(false);
  });

  it("an exit code changed: not held", () => {
    expect(laterKeptLine([step(head), step(head)], [step(head), step(kept + head, settings, 1)], outs([[head, head], [head, kept + head]]))).toBe(false);
  });
});
