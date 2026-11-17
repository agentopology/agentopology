/**
 * 0.11.4's guard hooks exit as 0.11.2's did, on every frozen pair, except a
 * declared list that goes from 2 to 0.
 *
 * differential/hooks-0112.json was frozen with a v0.11.2 build
 * (freeze-hooks.mjs): every topology of hook-corpus.mjs, scaffolded for
 * Claude Code and Codex, every generated before-action.sh, before-edit.sh and
 * before-agent.sh, and the Codex if filter (at-if.sh) behind 3 `if:` hooks
 * of today's guard tests, run through hooks.json's command; every corpus
 * input (today's guard-test commands, the
 * must-not-block and must-block corpora, edits, launches, raw payloads with
 * escapes), each run with jq on PATH and without it. 0.11.2 and 0.11.3 agree
 * on every pair.
 *
 * differential/hooks-0114-flips.json is the declared list (declare-flips.mjs,
 * written from the topologies' gated words, not from the hooks): with jq, the
 * must-not-block commands 0.11.2 refused; with no jq, the payloads that could
 * not hold anything the hook guards. The flipped pairs must equal that list.
 * No other pair may change, in either direction.
 *
 * After 0.11.4 (the no-jq word reading): differential/hooks-0114.json is the same corpus frozen with a
 * v0.11.4 build, and differential/hooks-0114-words-flips.json the declared no-jq pairs it frees
 * (declare-flips-words.mjs). The same one run of this build is held to both.
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
import { runCorpus, pairKey, IF_TOPOLOGIES, ALIAS_CLOSED } from "./differential/hook-corpus.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const hasJq = spawnSync("/bin/sh", ["-c", "command -v jq"]).status === 0;

interface Pair { topology: string; binding: string; hook: string; input: string; jq: boolean; exit: number | null }
const frozen = JSON.parse(fs.readFileSync(join(here, "differential/hooks-0112.json"), "utf8")) as { version: string; count: number; rows: Pair[] };
const declared = JSON.parse(fs.readFileSync(join(here, "differential/hooks-0114-flips.json"), "utf8")) as { count: number; flips: Array<Omit<Pair, "exit"> & { why: string }> };
/**
 * After 0.11.4, the declared no-jq pairs the word reading frees (declare-flips-words.mjs, against the frozen
 * 0.11.4 run; the "against the frozen 0.11.4 run" tests below hold them exactly). 0.11.2 refused each,
 * as 0.11.4 did.
 */
const wordsDeclared = JSON.parse(fs.readFileSync(join(here, "differential/hooks-0114-words-flips.json"), "utf8")) as { count: number; flips: Array<Omit<Pair, "exit"> & { why: string }> };
/**
 * Frozen from a v0.11.4 build on the same corpus (freeze-hooks.mjs). Against it, the no-jq word reading:
 * with jq no pair changes; with no jq only the declared 2 -> 0 list above (wordsDeclared) changes.
 */
const frozen0114 = JSON.parse(fs.readFileSync(join(here, "differential/hooks-0114.json"), "utf8")) as { version: string; count: number; rows: Pair[] };
/** The declared 0->2 list, kept apart: an inline git alias that ran a gated step under another name. */
const closedDeclared = JSON.parse(fs.readFileSync(join(here, "differential/hooks-0114-closed.json"), "utf8")) as { count: number; closed: Array<Omit<Pair, "exit"> & { why: string }> };

describe.skipIf(!hasJq)("[0.11.4] the guard hooks exit as 0.11.2's did, but for the declared flips", () => {
  let now: Pair[] = [];
  beforeAll(async () => {
    now = await runCorpus({ parse, bindings: { "claude-code": claudeCodeBinding, codex: codexBinding } });
  }, 600_000);

  it("the frozen corpus is the one committed, from 0.11.2", () => {
    expect(frozen.version).toBe("0.11.2");
    expect(frozen.rows.length).toBe(frozen.count);
    expect(frozen.rows.length).toBeGreaterThan(6000);
    expect(declared.flips.length).toBe(declared.count);
  });

  it("this build runs the same pairs", () => {
    expect(now.map(pairKey).sort()).toEqual(frozen.rows.map(pairKey).sort());
    expect(now.filter((r) => r.exit !== 0 && r.exit !== 2)).toEqual([]);
  });

  it("every pair equals 0.11.2's exit, except the two declared lists: 2 -> 0, and the inline git alias 0 -> 2", () => {
    const was = new Map(frozen.rows.map((r) => [pairKey(r), r.exit]));
    const flipsDeclared = new Set<string>([...declared.flips, ...wordsDeclared.flips].map((f) => pairKey(f) as string));
    expect(flipsDeclared.size, "the two declared 2->0 lists share no pair").toBe(declared.count + wordsDeclared.count);
    const closedSet = new Set<string>(closedDeclared.closed.map((f) => pairKey(f) as string));
    const flipped: string[] = [];
    const closed: string[] = [];
    const wrong: string[] = [];
    for (const r of now) {
      const k = pairKey(r);
      const before = was.get(k);
      if (before === r.exit) continue;
      if (before === 2 && r.exit === 0 && flipsDeclared.has(k)) flipped.push(k);
      else if (before === 0 && r.exit === 2 && closedSet.has(k)) closed.push(k);
      else wrong.push(`${k}: ${before} -> ${r.exit}${flipsDeclared.has(k) || closedSet.has(k) ? "" : " (not declared)"}`);
    }
    const missing = [...flipsDeclared].filter((k) => !flipped.includes(k));
    const missingClosed = [...closedSet].filter((k) => !closed.includes(k));
    expect(wrong, `${wrong.length} pairs changed outside the declared lists:\n${wrong.slice(0, 60).join("\n")}`).toEqual([]);
    expect(missing, `${missing.length} declared 2->0 flips did not happen:\n${missing.slice(0, 60).join("\n")}`).toEqual([]);
    expect(missingClosed, `${missingClosed.length} declared 0->2 (inline alias) did not happen:\n${missingClosed.join("\n")}`).toEqual([]);
    expect(flipped.length).toBe(declared.count + wordsDeclared.count);
    expect(closed.length).toBe(closedDeclared.count);
  });

  it("the 0->2 list is exactly the inline git alias forms, with jq, on the git step's before-action.sh and behind the refuse if: hook on git push*", () => {
    expect(new Set(closedDeclared.closed.map((c) => `${c.topology}|${c.hook}|${c.jq}`))).toEqual(new Set(["factory|before-action.sh|true", "ifpush|at-if.sh|true"]));
    for (const where of [["factory", "before-action.sh"], ["ifpush", "at-if.sh"]]) {
      const inputs = closedDeclared.closed.filter((c) => c.topology === where[0] && c.hook === where[1]).map((c) => c.input);
      expect([...new Set(inputs)].sort(), where.join(" ")).toEqual([...ALIAS_CLOSED].sort());
    }
  });

  it("Claude Code has no if filter script: it writes `if:` into settings.json as declared, and no generated file carries the reader", () => {
    const warn = console.warn;
    console.warn = () => {};
    try {
      for (const t of IF_TOPOLOGIES as Array<{ id: string; src: () => string; glob: string }>) {
        const files = claudeCodeBinding.scaffold(parse(t.src().replace(/gpt-5\.2/g, "sonnet")));
        expect(files.filter((f) => /at-if/.test(f.path) || /at_special|at_git_read/.test(String(f.content))).map((f) => f.path), t.id).toEqual([]);
        const settings = JSON.parse(String(files.find((f) => f.path === ".claude/settings.json")!.content));
        expect(settings.hooks.PreToolUse[0].hooks[0].if, t.id).toBe(`Bash(${t.glob})`);
      }
    } finally {
      console.warn = warn;
    }
  });

  it("against the frozen 0.11.4 run: the same pairs, and the declared word flips are no-jq only", () => {
    expect(frozen0114.version).toBe("0.11.4");
    expect(frozen0114.rows.length).toBe(frozen0114.count);
    expect(frozen0114.rows.map(pairKey).sort()).toEqual(now.map(pairKey).sort());
    expect(wordsDeclared.flips.length).toBe(wordsDeclared.count);
    expect(wordsDeclared.flips.filter((f) => f.jq)).toEqual([]);
  });

  it("against the frozen 0.11.4 run: with jq, every pair exits as 0.11.4's did", () => {
    const was = new Map(frozen0114.rows.map((r) => [pairKey(r), r.exit]));
    const changed = now.filter((r) => r.jq && was.get(pairKey(r)) !== r.exit).map((r) => `${pairKey(r)}: ${was.get(pairKey(r))} -> ${r.exit}`);
    expect(changed, changed.join("\n")).toEqual([]);
  });

  it("against the frozen 0.11.4 run: with no jq, every pair exits as 0.11.4's did, except the declared word flips (2 -> 0), exactly", () => {
    const was = new Map(frozen0114.rows.map((r) => [pairKey(r), r.exit]));
    const flipsDeclared = new Set<string>(wordsDeclared.flips.map((f) => pairKey(f) as string));
    const flipped: string[] = [];
    const wrong: string[] = [];
    for (const r of now.filter((x) => !x.jq)) {
      const k = pairKey(r);
      const before = was.get(k);
      if (before === r.exit) continue;
      if (before === 2 && r.exit === 0 && flipsDeclared.has(k)) flipped.push(k);
      else wrong.push(`${k}: ${before} -> ${r.exit}${flipsDeclared.has(k) ? "" : " (not declared)"}`);
    }
    const missing = [...flipsDeclared].filter((k) => !flipped.includes(k));
    expect(wrong, `${wrong.length} pairs changed outside the declared list:\n${wrong.slice(0, 60).join("\n")}`).toEqual([]);
    expect(missing, `${missing.length} declared 2->0 flips did not happen:\n${missing.slice(0, 60).join("\n")}`).toEqual([]);
    expect(flipped.length).toBe(wordsDeclared.count);
  });

  it("with no jq, a hook never lets through what it refuses with jq", () => {
    const withJq = new Map(now.filter((r) => r.jq).map((r) => [pairKey({ ...r, jq: true }), r.exit]));
    const looser = now.filter((r) => !r.jq && r.exit === 0 && withJq.get(pairKey({ ...r, jq: true })) !== 0).map(pairKey);
    expect(looser, looser.join("\n")).toEqual([]);
  });
});
