/**
 * A program word names a gated tool however it is spelled to run it.
 *
 * 0.11.4 measured (with jq; a gated `git commit` / `git push` step): a program
 * word whose basename carried a platform suffix (`.exe`, `.cmd`, `.bat`,
 * `.com`), in any letter case, or a brace list that bash expands into the
 * tool's name, was not read as the tool, so the step ran past its gate. A
 * Windows git under WSL (`/mnt/c/.../git.exe`) is a real program.
 *
 * Here, with jq and without it, on Claude Code and Codex (and behind the
 * Codex `if:` filter): those forms are refused; programs that only share
 * letters with the tool (`gitk`, `git-lfs`, `legit`) still run; and for every
 * input, what no jq lets through, jq lets through too.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import { codexBinding } from "../../bindings/codex.js";
// @ts-expect-error plain JavaScript module, shared with freeze-hooks.mjs
import { TOPOLOGIES, IF_TOPOLOGIES, PROGRAM_WORD_COMMANDS, runCorpus, pairKey, runHook, runCommand, scaffoldOne, scaffoldIf, toolPaths } from "./differential/hook-corpus.mjs";

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

/** A gated step, run through a program word spelled another way. Exit 2, with jq and without. */
const REFUSED = [
  "git.exe commit -m x", "git.exe push", "Git.exe commit -m x", "git.EXE push", "GIT.EXE push",
  "/mnt/c/Program\\ Files/Git/cmd/git.exe commit -m x", "\"/mnt/c/Program Files/Git/cmd/git.exe\" push",
  "git.cmd commit", "git.bat push", "git.com push", "sudo git.exe push", "cd x && git.exe commit -m y",
  "{g,x}it commit -m x", "{gi,x}t push", "g{i,x}t.exe commit", "/usr/bin/{git,x} commit", "{f..h}it push", "x{,}git push",
];
/** Programs that share letters with git, and ordinary commands. Exit 0, with jq and without. */
const RUNS = [
  "gitk", "gitk --all", "git-lfs pull", "git-lfs push origin main", "legit commit", "git-upload-pack .", "ls git.exe.bak",
  "cat Git.md", "echo {a,b}", "git status", "git log --oneline -5",
];
/** The push forms behind a strength: refuse `if: "Bash(git push*)"` (Codex at-if.sh, with jq). */
const IF_REFUSED = ["git.exe push", "Git.EXE push origin main", "\"/mnt/c/Program Files/Git/cmd/git.exe\" push", "git.cmd push", "{g,x}it push"];

for (const binding of ["claude-code", "codex"] as const) {
  for (const jq of [true, false]) {
    describe.skipIf(jq && !hasJq)(`${binding}, ${jq ? "with jq" : "no jq"}: before-action.sh reads the program word`, () => {
      for (const c of REFUSED) {
        it(`refuses ${c}`, async () => {
          const r = await action(binding, c, jq);
          expect(r.code, r.stderr).toBe(2);
        });
      }
      for (const c of RUNS) {
        it(`runs ${c}`, async () => {
          const r = await action(binding, c, jq);
          expect(r.code, r.stderr).toBe(0);
        });
      }
    });
  }
}

describe.skipIf(!hasJq)("codex: a strength: refuse if: hook on git push* runs for the push forms", () => {
  for (const c of IF_REFUSED) {
    it(`matches ${c}`, async () => {
      const r = await ifFilter(c, true);
      expect(r.code, r.stderr).toBe(2);
    });
  }
  for (const c of ["gitk", "git-lfs push", "ls git.exe.bak", "git status"]) {
    it(`does not match ${c}`, async () => {
      const r = await ifFilter(c, true);
      expect(r.code, r.stderr).toBe(0);
    });
  }
});

/**
 * The program-word corpus (hook-corpus.mjs PROGRAM_WORD_COMMANDS: every topology, before-action.sh and the
 * Codex if filter, with jq and without), frozen from a v0.11.4 build (hooks-0114-program.json). Against
 * it, only the declared changes (declare-flips-program.mjs, written apart from the hooks) may happen.
 */
describe.skipIf(!hasJq)("the program-word corpus moves from 0.11.4 only as declared", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  type Pair = { topology: string; binding: string; hook: string; input: string; jq: boolean; exit: number | null };
  const frozen = JSON.parse(fs.readFileSync(join(here, "differential/hooks-0114-program.json"), "utf8")) as { version: string; count: number; rows: Pair[] };
  const declared = JSON.parse(fs.readFileSync(join(here, "differential/hooks-0114-program-flips.json"), "utf8")) as { count: number; flips: Array<Omit<Pair, "exit"> & { from: number; to: number }> };
  let now: Pair[] = [];
  beforeAll(async () => {
    now = await runCorpus(lib, { commands: PROGRAM_WORD_COMMANDS });
  }, 300_000);

  it("the frozen run is 0.11.4's, on the same pairs", () => {
    expect(frozen.version).toBe("0.11.4");
    expect(frozen.rows.length).toBe(frozen.count);
    expect(declared.flips.length).toBe(declared.count);
    expect(now.map(pairKey).sort()).toEqual(frozen.rows.map(pairKey).sort());
  });

  it("every pair exits as 0.11.4's did, except the declared changes, exactly", () => {
    const was = new Map(frozen.rows.map((r) => [pairKey(r), r.exit]));
    const want = new Map(declared.flips.map((f) => [pairKey(f) as string, f.to]));
    const wrong: string[] = [];
    for (const r of now) {
      const k = pairKey(r);
      const expected = want.has(k) ? want.get(k) : was.get(k);
      if (r.exit !== expected) wrong.push(`${k}: 0.11.4 ${was.get(k)}, expected ${expected}, now ${r.exit}`);
    }
    expect(wrong, wrong.join("\n")).toEqual([]);
  });

  it("with jq, nothing goes from 2 to 0; the 2 -> 0 changes are the no-jq word reading's", () => {
    expect(declared.flips.filter((f) => f.jq && f.to === 0)).toEqual([]);
  });

  it("with no jq, a hook never lets through what it refuses with jq", () => {
    const withJq = new Map(now.filter((r) => r.jq).map((r) => [pairKey({ ...r, jq: true }), r.exit]));
    const looser = now.filter((r) => !r.jq && r.exit === 0 && withJq.get(pairKey({ ...r, jq: true })) !== 0).map(pairKey);
    expect(looser, looser.join("\n")).toEqual([]);
  });
});

describe.skipIf(!hasJq)("for every input here, what no jq lets through, jq lets through", () => {
  for (const binding of ["claude-code", "codex"] as const) {
    for (const c of [...REFUSED, ...RUNS]) {
      it(`${binding}: ${c}`, async () => {
        const nojq = await action(binding, c, false);
        const withJq = await action(binding, c, true);
        if (nojq.code === 0) expect(withJq.code, `jq refuses what no jq lets through: ${withJq.stderr}`).toBe(0);
      });
    }
  }
});
