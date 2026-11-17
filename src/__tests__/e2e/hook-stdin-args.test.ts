/**
 * A helper that hands a gated tool its arguments from standard input is refused.
 *
 * A program that runs another program with arguments it reads from standard
 * input (the guard's at_stdin_runner list) can complete a gated step out of
 * the guard's sight: the step's words arrive on stdin, not in the command. When
 * such a helper is given a gated tool as the program to run, and the step's own
 * words do not follow it in the command, the guard treats the call as doubt (a
 * possible gated step), with jq and without it, whatever options sit between the
 * helper and the tool, whatever path or suffix the tool is spelled with, and
 * after env or wrapper prefixes.
 *
 * Still allowed: the helper running a program that is not gated, and a reading
 * use of the gated tool that the existing rules already allow (its subcommand
 * written out, so the stdin words can only follow it).
 *
 * Gated step here: `git commit` and `git push` behind a gate whose check always fails (hook-corpus.mjs, factory).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { parse } from "../../parser/index.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import { codexBinding } from "../../bindings/codex.js";
// @ts-expect-error plain JavaScript module, shared with freeze-hooks.mjs
import { TOPOLOGIES, IF_TOPOLOGIES, runHook, runCommand, scaffoldOne, scaffoldIf, toolPaths } from "./differential/hook-corpus.mjs";

const hasJq = spawnSync("/bin/sh", ["-c", "command -v jq"]).status === 0;
const lib = { parse, bindings: { "claude-code": claudeCodeBinding, codex: codexBinding } };
type Binding = "claude-code" | "codex";

const made = new Map<string, { root: string; hooks: Array<{ hook: string; script: string }> }>();
function actionHook(binding: Binding) {
  if (!made.has(binding)) made.set(binding, scaffoldOne(lib, TOPOLOGIES.find((t: { id: string }) => t.id === "factory"), binding));
  const s = made.get(binding)!;
  return { root: s.root, script: s.hooks.find((h) => h.hook === "before-action.sh")!.script };
}
let ifPush: { root: string; command: string } | null = null;

let PATHS: { jq: string; nojq: string };
beforeAll(() => { PATHS = toolPaths(); });

const bash = (command: string) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
async function action(binding: Binding, command: string, jq: boolean) {
  const { root, script } = actionHook(binding);
  return runHook(script, root, binding, bash(command), jq ? PATHS.jq : PATHS.nojq) as Promise<{ code: number | null; stderr: string }>;
}
async function ifFilter(command: string, jq: boolean) {
  ifPush ??= scaffoldIf(lib, IF_TOPOLOGIES.find((t: { id: string }) => t.id === "ifpush"));
  return runCommand(ifPush!.command, ifPush!.root, bash(command), jq ? PATHS.jq : PATHS.nojq) as Promise<{ code: number | null; stderr: string }>;
}

/** The gated tool as the program the helper runs, the step's words left to stdin. Exit 2, with jq and without. */
const REFUSED = [
  "echo commit | xargs git",
  "printf 'commit\\0' | xargs -0 git",
  "xargs -n1 git < words.txt",
  "echo push | xargs -r -- git",
  "echo commit | xargs -I{} git {} -m x",
  "echo commit | xargs /usr/bin/git",
  "echo commit | xargs git.exe",
  "echo commit | XARGS GIT",
  "echo commit | /usr/bin/xargs git",
  "echo commit | env xargs git",
  "echo commit | FOO=1 nice -n 5 xargs -0 -n1 git --no-pager",
  "echo commit | sudo -u bot xargs git -C .",
  "echo push | parallel git",
  "echo push | parallel -j1 git",
  "echo push | xe git",
  "echo push | rush git",
  "echo push | xjobs git",
];
/** The helper running a program that is not gated, or a reading use of the gated tool. Exit 0, with jq and without. */
const RUNS = [
  "ls | xargs wc -l",
  "echo a | xargs echo",
  "git ls-files | xargs grep TODO",
  "echo HEAD | xargs git log --oneline",
  "echo README.md | xargs git diff --stat",
  "echo a | parallel echo",
  "echo a | xargs gitk",
];
/**
 * The gated tool's name only as an argument of the program the helper runs (that program is not gated and
 * does not run its arguments): exit 0, with jq and without.
 */
const ARGUMENT_RUNS = [
  "git ls-files | xargs grep -l git",
  "find . -name '*.md' | xargs grep -n \"git\"",
  "ls | xargs -n1 echo git",
  "cat tools.txt | xargs which git",
  "find . -print0 | xargs -0 grep -l git",
];
/**
 * Of ARGUMENT_RUNS, the one the no-jq reading refuses by its earlier rule (a glob in the command next to a
 * gated tool's word; it refuses `find . -name '*.md'; echo git` alike, as 0.12.0 did), not by this check.
 */
const GLOB_WORD_NOJQ = ["find . -name '*.md' | xargs grep -n \"git\""];
/**
 * The gated tool still the program the helper runs: after an option that takes the next word as its value,
 * or after a program that runs its own arguments. Exit 2, with jq and without.
 */
const PROGRAM_REFUSED = [
  "echo commit | xargs -n 1 git",
  "echo commit | xargs -P 4 git",
  "echo commit | xargs -I {} git {} -m x",
  "echo commit | xargs --max-args 1 git",
  "echo commit | xargs -0n 1 git",
  "echo commit | xargs env git",
  "echo commit | xargs sudo -u bot git",
  "echo commit | xargs -0 sh -c git",
  "echo push | parallel -k git",
];
/**
 * An option that takes no separate value (none at all, or one only attached: xargs -i[str] -l[n] -e[str])
 * right before the program the helper runs, the tool only that program's argument. Each helper's own option
 * list says which options take one. Exit 0, with jq and without.
 */
const NO_VALUE_FLAGS = ["xargs -r", "xargs -0r", "xargs -tr", "xargs -p", "xargs -e", "xargs -l", "xargs -i", "xargs --replace", "xargs -n1 -r", "parallel -k", "parallel --will-cite", "parallel --bar"];
const NO_VALUE_RUNS = NO_VALUE_FLAGS.flatMap((f) => ["grep -l git", "echo git", "which git", "ls git"].map((p) => `ls | ${f} ${p}`));
/** The same for the other helpers, by their own option lists. Exit 0, with jq and without. */
const OTHER_HELPER_RUNS = ["ls | rush -k echo git", "ls | xe -v echo git", "ls | xjobs -n echo git", "ls | parallel --WILL-CITE echo git"];
/**
 * An option that takes the next word as its value, by the helper's own list: the word after it is the
 * value and the tool the program run. Exit 2, with jq and without.
 */
const VALUE_REFUSED = [
  "echo commit | xargs -I echo git",
  "echo commit | xargs -rI echo git",
  "echo commit | xargs -E echo git",
  "echo commit | xargs --arg-file list git",
  "echo commit | xargs --max-a 1 git",
  "echo push | parallel -i echo git",
  "echo push | parallel --replace echo git",
  "echo push | parallel -kI echo git",
  "echo push | parallel +I echo git",
  "echo push | rush -v echo git",
  "echo push | xe -I echo git",
  "echo push | xjobs -s echo git",
];

for (const binding of ["claude-code", "codex"] as const) {
  for (const jq of [true, false]) {
    describe.skipIf(jq && !hasJq)(`${binding}, ${jq ? "with jq" : "no jq"}: a helper that hands a gated tool its arguments from standard input is refused`, () => {
      REFUSED.forEach((c, i) => {
        it(`refuses form ${i + 1} of REFUSED`, async () => {
          const r = await action(binding, c, jq);
          expect(r.code, r.stderr).toBe(2);
        });
      });
      RUNS.forEach((c, i) => {
        it(`runs form ${i + 1} of RUNS`, async () => {
          const r = await action(binding, c, jq);
          expect(r.code, r.stderr).toBe(0);
        });
      });
      ARGUMENT_RUNS.forEach((c, i) => {
        it(`runs form ${i + 1} of ARGUMENT_RUNS (the tool only another program's argument)`, async () => {
          const r = await action(binding, c, jq);
          expect(r.code, r.stderr).toBe(!jq && GLOB_WORD_NOJQ.includes(c) ? 2 : 0);
        });
      });
      PROGRAM_REFUSED.forEach((c, i) => {
        it(`refuses form ${i + 1} of PROGRAM_REFUSED (the tool still the program run)`, async () => {
          const r = await action(binding, c, jq);
          expect(r.code, r.stderr).toBe(2);
        });
      });
      [...NO_VALUE_RUNS, ...OTHER_HELPER_RUNS].forEach((c, i) => {
        it(`runs form ${i + 1} of NO_VALUE_RUNS then OTHER_HELPER_RUNS (an option that takes no next word)`, async () => {
          const r = await action(binding, c, jq);
          expect(r.code, r.stderr).toBe(0);
        });
      });
      VALUE_REFUSED.forEach((c, i) => {
        it(`refuses form ${i + 1} of VALUE_REFUSED (an option that takes the next word)`, async () => {
          const r = await action(binding, c, jq);
          expect(r.code, r.stderr).toBe(2);
        });
      });
    });
  }
}

describe.skipIf(!hasJq)("codex: a strength: refuse if: hook on git push* matches a helper that hands git its arguments from standard input", () => {
  ["echo push | xargs git", "echo push | parallel -j1 /usr/bin/git"].forEach((c, i) => {
    it(`matches form ${i + 1}`, async () => {
      const r = await ifFilter(c, true);
      expect(r.code, r.stderr).toBe(2);
    });
  });
  ["ls | xargs wc -l", "echo HEAD | xargs git log"].forEach((c, i) => {
    it(`does not match the helper running a program that is not gated, or a read (form ${i + 1})`, async () => {
      const r = await ifFilter(c, true);
      expect(r.code, r.stderr).toBe(0);
    });
  });
});

describe.skipIf(!hasJq)("a helper that hands a gated tool its arguments from standard input: what no jq lets through, jq lets through", () => {
  for (const binding of ["claude-code", "codex"] as const) {
    for (const [i, c] of [...REFUSED, ...RUNS, ...ARGUMENT_RUNS, ...PROGRAM_REFUSED, ...NO_VALUE_RUNS, ...OTHER_HELPER_RUNS, ...VALUE_REFUSED].entries()) {
      it(`${binding}: form ${i + 1} of REFUSED, RUNS, ARGUMENT_RUNS, PROGRAM_REFUSED, NO_VALUE_RUNS, OTHER_HELPER_RUNS then VALUE_REFUSED`, async () => {
        const nojq = await action(binding, c, false);
        const withJq = await action(binding, c, true);
        if (nojq.code === 0) expect(withJq.code, `jq refuses what no jq lets through: ${withJq.stderr}`).toBe(0);
      });
    }
  }
});
