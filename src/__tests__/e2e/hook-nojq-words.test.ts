/**
 * Without jq, a guard hook reads the payload's words, not its letters.
 *
 * 0.11.4 measured (site topology: gated `git merge` and `git tag`): with no jq
 * on PATH, before-action.sh refused ordinary git commands that jq lets run,
 * because a step counted as present when its letters appeared in order in the
 * payload's letters (`git branch -d feat/merged` holds g-i-t ... m-e-r-g-e),
 * and any `{` not opening a JSON object counted as an expansion (`@{u}`).
 *
 * Here: those commands run (exit 0, one notice line); every form that could
 * still run a gated step keeps its refusal (exit 2, "jq is required"); and for
 * every input below, what no jq lets through, jq lets through too.
 *
 * Each case runs the generated hook the way the host does (hook-corpus.mjs
 * runHook): a shell, a subfolder as the current directory, the payload on
 * stdin, a PATH of symlinks with jq or without it.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { parse } from "../../parser/index.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import { codexBinding } from "../../bindings/codex.js";
// @ts-expect-error plain JavaScript module, shared with freeze-hooks.mjs
import { TOPOLOGIES, runHook, scaffoldOne, toolPaths } from "./differential/hook-corpus.mjs";

const hasJq = spawnSync("/bin/sh", ["-c", "command -v jq"]).status === 0;
const lib = { parse, bindings: { "claude-code": claudeCodeBinding, codex: codexBinding } };
type Binding = "claude-code" | "codex";

/** The site's shape: `git merge` behind two run: gates, `git tag` behind one. */
const SITE = `topology site : [pipeline] {
  meta { version: "1.0.0" description: "build, merge, release" }
  orchestrator { model: gpt-5.2 handles: [build, merge, release] }
  action build {
    kind: external
    commands: ["npm test"]
  }
  action merge {
    kind: external
    commands: ["git merge"]
  }
  action release {
    kind: external
    commands: ["git tag"]
  }
  gates {
    gate red-first {
      after: build
      before: merge
      run: "scripts/red-first.sh"
      on-fail: halt
    }
    gate no-weakened-tests {
      after: build
      before: merge
      run: "scripts/no-weakened.sh"
      on-fail: halt
    }
    gate merged {
      after: merge
      before: release
      run: "scripts/merged.sh"
      on-fail: halt
    }
  }
  flow { build -> merge -> release }
}
`;

const topoOf = (id: string) => (id === "site" ? { id, src: () => SITE } : TOPOLOGIES.find((t: { id: string }) => t.id === id));
const made = new Map<string, { root: string; hooks: Array<{ hook: string; script: string }> }>();
function hookOf(id: string, binding: Binding, hook: string) {
  const k = `${id}|${binding}`;
  if (!made.has(k)) made.set(k, scaffoldOne(lib, topoOf(id), binding));
  const s = made.get(k)!;
  const h = s.hooks.find((x) => x.hook === hook);
  if (!h) throw new Error(`${id} (${binding}) has no ${hook}`);
  return { root: s.root, script: h.script };
}

let PATHS: { jq: string; nojq: string };
beforeAll(() => { PATHS = toolPaths(); });

async function run(id: string, binding: Binding, hook: string, payload: string, jq: boolean) {
  const { root, script } = hookOf(id, binding, hook);
  return runHook(script, root, binding, payload, jq ? PATHS.jq : PATHS.nojq) as Promise<{ code: number | null; stderr: string }>;
}

const bash = (command: string, tool = "Bash") => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: { command } });
/** A payload written by hand: `c` goes in as raw JSON string text (its escapes are JSON's). */
const rawBash = (c: string) => `{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"${c}"}}`;
const launch = (binding: Binding, a: string, prompt = "go") => binding === "codex"
  ? JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "collaborationspawn_agent", tool_input: { task_name: "t", agent_type: a, message: prompt } })
  : JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: a, prompt } });

const lines = (s: string) => s.split("\n").filter((l) => l.trim() !== "");

interface Case { id: string; hook: string; name: string; payload: (b: Binding) => string; bindings?: Binding[] }
const act = (id: string, command: string): Case => ({ id, hook: "before-action.sh", name: command, payload: () => bash(command) });
const actRaw = (id: string, name: string, raw: string): Case => ({ id, hook: "before-action.sh", name, payload: () => rawBash(raw) });

/** Ordinary commands 0.11.4 refused only without jq. No jq: exit 0 with one notice line. */
const READ_ONLY_GIT = [
  "git log @{u}..", "git log @{u}..HEAD", "git diff @{u}", "git show HEAD^{commit}", "git diff HEAD@{1}",
  "git branch -d feat/merged", "git log --grep=merged", "git checkout -b emerge-fix",
];
const FREED: Case[] = [
  ...READ_ONLY_GIT.map((c) => act("site", c)),
  ...READ_ONLY_GIT.map((c) => act("factory", c)),
  act("factory", "git log --author=pushkin"),
  act("factory", "git log --grep=committed"),
  act("site", "git log --oneline --tags=merged"),
  // an agent's name inside another word of the prompt, not its name
  { id: "compile", hook: "before-agent.sh", name: "critic, prompt 'redrafter'", payload: (b) => launch(b, "critic", "the redrafter notes"), bindings: ["claude-code"] },
  { id: "cxgates", hook: "before-agent.sh", name: "someone-else, prompt 'creditor'", payload: (b) => launch(b, "someone-else", "ask the creditor"), bindings: ["codex"] },
];

/** Forms that run, or could run, a gated step. No jq: exit 2, "jq is required". */
const STILL_REFUSED: Case[] = [
  act("site", "git merge main"),
  act("site", "git me''rge main"),
  actRaw("site", "git m\\erge main", "git m\\\\erge main"),
  act("site", "\"git\" \"merge\""),
  act("site", "/usr/bin/git merge x"),
  act("site", "git\tmerge x"),
  act("site", "git\nmerge x"),
  act("site", "git {merge,x}"),
  act("site", "git mer*"),
  act("site", "git merg?"),
  act("site", "git [m]erge"),
  act("site", "g=git; $g merge"),
  act("site", "git $(echo merge)"),
  act("site", "git `echo merge`"),
  act("site", "git -c alias.x=merge x"),
  act("site", "git -c include.path=f x"),
  act("site", "git $'\\x6derge' main"),
  actRaw("site", "a \\u escape", "git \\u006derge"),
  { id: "site", hook: "before-action.sh", name: "an empty payload", payload: () => "" },
  // more ways bash reads `merge`, found while building the word reading
  actRaw("site", "a line continuation inside merge", "git mer\\\\\\nge main"),
  actRaw("site", "a line continuation between git and merge", "git \\\\\\nmerge main"),
  actRaw("site", "JSON's \\/ in the path", "\\/usr\\/bin\\/git merge x"),
  act("site", "git m\"e\"r'g'e main"),
  act("site", "GIT MERGE main"),
  act("site", "git -C /x --no-pager merge main"),
  act("site", "sh -c 'git merge main'"),
  act("site", "echo git merge | sh"),
  act("site", "x=merge; git $x main"),
  act("site", "git mer{,}ge main"),
  act("site", "{git,merge} main"),
  act("site", "git tag v1"),
  act("site", "git -c alias.t=tag t v1"),
  act("site", "V=merge git --config-env=alias.x=V x"),
  act("site", "git ~merge"),
  // a glob where a program runs: bash makes it the program's name from the files there
  act("site", "/usr/bin/g?t merge x"),
  act("site", "/usr/bin/g[i]t merge x"),
  act("site", "/usr/bin/gi* merge x"),
  act("rd", "python3 docs/d*.py J1"),
  act("rd", "python3 docs/*.py J1"),
  act("rd", "D=docs/d*.py; python3 $D J1"),
  // a PowerShell call: jq reads any mention of the tool it cannot account for as doubt
  { id: "site", hook: "before-action.sh", name: "PowerShell .\\git.exe merge", payload: () => bash(".\\git.exe merge main", "PowerShell"), bindings: ["claude-code"] },
  { id: "site", hook: "before-action.sh", name: "PowerShell & git.exe 'merge'", payload: () => bash("& git.exe 'merge'", "PowerShell"), bindings: ["claude-code"] },
  act("factory", "git commit -m x"),
  act("factory", "git push origin main"),
  act("factory", "git com''mit"),
  act("factory", "/usr/bin/g?t push"),
  // a gated agent, in every spelling jq reads as it
  ...["drafter", "Drafter", " drafter ", "agents/drafter", "drafter:", "drafter.", "drafter!", "Drafter?", "x:drafter", "dr​after", "​drafter", "drafter­"].map((a): Case => ({
    id: "compile", hook: "before-agent.sh", name: `agent ${JSON.stringify(a)}`, payload: (b) => launch(b, a), bindings: ["claude-code"],
  })),
  ...["editor", "Editor", "editor!", "edi​tor"].map((a): Case => ({
    id: "cxgates", hook: "before-agent.sh", name: `agent ${JSON.stringify(a)}`, payload: (b) => launch(b, a), bindings: ["codex"],
  })),
];

const bindingsOf = (c: Case): Binding[] => c.bindings ?? ["claude-code", "codex"];

describe("with no jq, the guard hooks read words: ordinary commands run", () => {
  for (const c of FREED) {
    for (const b of bindingsOf(c)) {
      it(`${c.id} ${b} ${c.hook}: ${c.name} exits 0 with one notice line`, async () => {
        const r = await run(c.id, b, c.hook, c.payload(b), false);
        expect(r.code, r.stderr).toBe(0);
        expect(lines(r.stderr)).toHaveLength(1);
        expect(r.stderr).toMatch(/jq is not installed/);
      });
    }
  }
});

describe("with no jq, every form that could run a gated step is still refused", () => {
  for (const c of STILL_REFUSED) {
    for (const b of bindingsOf(c)) {
      it(`${c.id} ${b} ${c.hook}: ${c.name} exits 2`, async () => {
        const r = await run(c.id, b, c.hook, c.payload(b), false);
        expect(r.code, r.stderr).toBe(2);
        expect(r.stderr).toMatch(/jq is required/);
      });
    }
  }
});

describe.skipIf(!hasJq)("for every input here, what no jq lets through, jq lets through", () => {
  for (const c of [...FREED, ...STILL_REFUSED]) {
    for (const b of bindingsOf(c)) {
      it(`${c.id} ${b} ${c.hook}: ${c.name}`, async () => {
        const nojq = await run(c.id, b, c.hook, c.payload(b), false);
        const jq = await run(c.id, b, c.hook, c.payload(b), true);
        if (nojq.code === 0) expect(jq.code, `jq refuses what no jq lets through: ${jq.stderr}`).toBe(0);
      });
    }
  }
});
