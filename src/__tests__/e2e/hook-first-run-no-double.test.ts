/**
 * A first scaffold with no manifest never runs a hook twice.
 *
 * With no manifest, every entry already in the hooks file is the user's and
 * stays; 0.12.6's identity says which of them is the same hook as one the
 * .at generates, and that one is then not written beside it. Here the merge
 * differential's shapes where a user's hook and the .at's run one script in
 * two spellings (f2 1, 4, 10, 12; hk T15, T33, T36; rt 8) run again: after
 * every step, no event and matcher holds two entries running one script.
 */

import { describe, it, expect } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error plain JavaScript module, shared with freeze-merge.mjs
import { runSequence } from "./differential/merge-sequences.mjs";
// @ts-expect-error plain JavaScript module, shared with freeze-merge.mjs
import { ALL_SEQUENCES } from "./differential/fable-sequences.mjs";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../../../dist/cli/index.js");

interface Step { args: string; code: number | null; output: string; settings: string | null }

const SHAPES = [
  "f2 1 user sh, .at bash (same file)",
  "f2 4 user `x.sh` bare (PATH), .at ./x.sh project file",
  "f2 10 user quoted arg with space, .at two args",
  "f2 12 user sh tools/a.sh, .at tools/a.sh",
  "hk T15 user's own hook, same script other form, .at declares it, then removes it",
  "hk T33 hand-built hook, guard --target with a .at that declares it",
  "hk T36 user's project-path hook, scaffold twice, then .at drops it",
  "rt 8: .claude/hooks/x.sh",
];

/** The script a command runs: the path after `$CLAUDE_PROJECT_DIR/`, else the first path-like word. */
function scriptOf(command: string): string {
  const anchored = [...command.matchAll(/\$\{?CLAUDE_PROJECT_DIR\}?\/([^\s"'`;|&)]+)/g)].map((m) => m[1]);
  if (anchored.length > 0) return anchored[anchored.length - 1];
  const words = command.trim().split(/\s+/).map((w) => w.replace(/["']/g, "").replace(/^\.\//, ""));
  return words.find((w) => w.includes("/") || /\.\w+$/.test(w)) ?? words[0] ?? "";
}

/** `<event> <matcher> <script>` for every entry run twice. */
function doubles(settings: string | null): string[] {
  const hooks = ((settings ? JSON.parse(settings) : {}) as { hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>> }).hooks ?? {};
  const seen = new Set<string>();
  const out: string[] = [];
  for (const [event, groups] of Object.entries(hooks)) {
    for (const g of groups) {
      for (const h of g.hooks ?? []) {
        if (typeof h.command !== "string") continue;
        const k = `${event} ${g.matcher ?? "(no matcher)"} ${scriptOf(h.command)}`;
        if (seen.has(k)) out.push(k);
        seen.add(k);
      }
    }
  }
  return out;
}

const seqs = (ALL_SEQUENCES as Array<{ name: string }>).filter((s) => SHAPES.includes(s.name));

describe("a first scaffold with no manifest: one entry per hook, nothing runs twice", () => {
  it("finds every shape", () => {
    expect(seqs.map((s) => s.name).sort()).toEqual([...SHAPES].sort());
  });

  it.each(seqs.map((s) => [s.name, s] as const))("%s", async (_name, seq) => {
    await new Promise((r) => setImmediate(r));
    const steps = runSequence(CLI, seq) as Step[];
    const found = steps.flatMap((s, n) => doubles(s.settings).map((d) => `step ${n + 1} (${s.args}): ${d}`));
    expect(found, steps.map((s) => s.settings).join("\n---\n")).toEqual([]);
  }, 120_000);
});
