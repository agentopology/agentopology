/**
 * 0.11.4's guard hooks exit as 0.11.2's did, on every frozen pair, except a
 * declared list that goes from 2 to 0.
 *
 * differential/hooks-0112.json was frozen with a v0.11.2 build
 * (freeze-hooks.mjs): every topology of hook-corpus.mjs, scaffolded for
 * Claude Code and Codex, every generated before-action.sh, before-edit.sh and
 * before-agent.sh, every corpus input (today's guard-test commands, the
 * must-not-block and must-block corpora, edits, launches, raw payloads with
 * escapes), each run with jq on PATH and without it. 0.11.2 and 0.11.3 agree
 * on every pair.
 *
 * differential/hooks-0114-flips.json is the declared list (declare-flips.mjs,
 * written from the topologies' gated words, not from the hooks): with jq, the
 * must-not-block commands 0.11.2 refused; with no jq, the payloads that could
 * not hold anything the hook guards. The flipped pairs must equal that list.
 * No other pair may change, in either direction.
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
import { runCorpus, pairKey } from "./differential/hook-corpus.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const hasJq = spawnSync("/bin/sh", ["-c", "command -v jq"]).status === 0;

interface Pair { topology: string; binding: string; hook: string; input: string; jq: boolean; exit: number | null }
const frozen = JSON.parse(fs.readFileSync(join(here, "differential/hooks-0112.json"), "utf8")) as { version: string; count: number; rows: Pair[] };
const declared = JSON.parse(fs.readFileSync(join(here, "differential/hooks-0114-flips.json"), "utf8")) as { count: number; flips: Array<Omit<Pair, "exit"> & { why: string }> };

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

  it("every pair equals 0.11.2's exit, except the declared list, which goes from 2 to 0", () => {
    const was = new Map(frozen.rows.map((r) => [pairKey(r), r.exit]));
    const flipsDeclared = new Set<string>(declared.flips.map((f) => pairKey(f) as string));
    const flipped: string[] = [];
    const wrong: string[] = [];
    for (const r of now) {
      const k = pairKey(r);
      const before = was.get(k);
      if (before === r.exit) continue;
      if (before === 2 && r.exit === 0 && flipsDeclared.has(k)) flipped.push(k);
      else wrong.push(`${k}: ${before} -> ${r.exit}${flipsDeclared.has(k) ? "" : " (not declared)"}`);
    }
    const missing = [...flipsDeclared].filter((k) => !flipped.includes(k));
    expect(wrong, `${wrong.length} pairs changed outside the declared list:\n${wrong.slice(0, 60).join("\n")}`).toEqual([]);
    expect(missing, `${missing.length} declared flips did not happen:\n${missing.slice(0, 60).join("\n")}`).toEqual([]);
    expect(flipped.length).toBe(declared.count);
  });

  it("with no jq, a hook never lets through what it refuses with jq", () => {
    const withJq = new Map(now.filter((r) => r.jq).map((r) => [pairKey({ ...r, jq: true }), r.exit]));
    const looser = now.filter((r) => !r.jq && r.exit === 0 && withJq.get(pairKey({ ...r, jq: true })) !== 0).map(pairKey);
    expect(looser, looser.join("\n")).toEqual([]);
  });
});
