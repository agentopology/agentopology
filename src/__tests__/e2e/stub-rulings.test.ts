/**
 * The stub rulings (differential/stub-rulings.mjs) are narrow: the frozen
 * 0.11.2 comparisons skip only scaffold's stub summary and validate's stub
 * lines, and regrade only a refuse gate whose check script was a stub. Any
 * other difference still fails.
 *
 * (a) crafted pairs that must still differ after ruledSides;
 * (b) the pairs the rulings describe, which must compare equal;
 * (c) every pinned output in the repo passes through unchanged, except
 *     exactly the stub lines.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error plain JavaScript module
import { ruledSides, stubless, regradeStubbedGates } from "./differential/stub-rulings.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const same = (was: string, now: string) => { const [a, b] = ruledSides(was, now); return a === b; };

const STUB_PATH = ".claude/skills/p/scripts/check-quality.sh";
const OLD_STUB = `⚠ its check script ${STUB_PATH} is still a stub, so it blocks every run until it is written`;
const NEW_STUB = `⚠ its check script ${STUB_PATH} is still a stub: it checks nothing and blocks every run until it is written`;
const STOP = "⚠ exit 2 keeps the agent working until the gate passes; a call it already made is not undone";
const NO_BLOCK = '⚠ the entry has no onFailure: "block", so the step goes through if the hook cannot start';
const GRADED = "1 gate(s) graded none because their check script is still a stub: it checks nothing and blocks every run; write it and remove its AGENTOPOLOGY_STUB line";
const IND = "                       ";

/** guard --check as 0.11.2 printed it: quality-check's script is a stub, copy-check's is written. */
const WAS_GUARD = [
  "guard --check p.at (project: <ROOT>)",
  "",
  "  gate quality-check   refuse, a stop event: it cannot block a call  by: hook      SubagentStop on writer → gate-quality-check.sh · installed <X>: unverified",
  `${IND}${STOP}`,
  `${IND}${OLD_STUB}`,
  "  gate copy-check      refuse, a stop event: it cannot block a call  by: hook      SubagentStop on editor → gate-copy-check.sh · installed <X>: unverified",
  `${IND}${STOP}`,
  "  deny Bash(rm -rf *)  refuse                                        by: settings  permissions.deny in .claude/settings.json · installed <X>: unverified",
  "",
  "enforcement: 2 of 2 steps refuse · checked against Claude Code 2.1.323 · installed <X>: unverified",
  "--- exit 0",
  "",
].join("\n");

/** The same project today: quality-check none, the count one lower, the graded-none line. */
const NOW_GUARD = [
  "guard --check p.at (project: <ROOT>)",
  "",
  "  gate quality-check   none                                          by: hook      SubagentStop on writer → gate-quality-check.sh",
  `${IND}${NEW_STUB}`,
  "  gate copy-check      refuse, a stop event: it cannot block a call  by: hook      SubagentStop on editor → gate-copy-check.sh · installed <X>: unverified",
  `${IND}${STOP}`,
  "  deny Bash(rm -rf *)  refuse                                        by: settings  permissions.deny in .claude/settings.json · installed <X>: unverified",
  "",
  "enforcement: 1 of 2 steps refuse · checked against Claude Code 2.1.323 · installed <X>: unverified",
  GRADED,
  "--- exit 0",
  "",
].join("\n");

/** The same report with the column width a shorter grade gives (today's padding). */
const NOW_GUARD_NARROW = NOW_GUARD
  .replace("  gate quality-check   none                                          by:", "  gate quality-check   none        by:")
  .replace("  deny Bash(rm -rf *)  refuse                                        by:", "  deny Bash(rm -rf *)  refuse      by:");

/** A guard report with no stubbed gate (nothing to regrade). */
const PLAIN_GUARD = [
  "  gate copy-check      refuse  by: hook      SubagentStop on editor → gate-copy-check.sh",
  `${IND}${STOP}`,
  "  deny Bash(rm -rf *)  refuse  by: settings  permissions.deny in .claude/settings.json",
  "",
  "enforcement: 1 of 1 steps refuse · checked against Claude Code 2.1.323",
  "--- exit 0",
  "",
].join("\n");

const SEARCH = '  Search for "# AGENTOPOLOGY_STUB — fill this in before relying on this script" — remove that line when each script is implemented.';
/** scaffold as 0.11.2 printed it (stderr's blank line, the summary, stdout's closing blank line): its stub summary listed the user's own hook script. */
const WAS_SCAFFOLD = [
  "  + .claude/settings.json",
  "  = .claude/hooks/x.sh (your script — kept, never overwritten)",
  "",
  "  1 created, 0 updated, 1 unchanged, 0 conflicts",
  "",
  "  2 stub(s) need implementation before this topology can run:",
  "    · .claude/skills/t/scripts/check.sh",
  "    · .claude/hooks/x.sh",
  SEARCH,
  "",
  "",
].join("\n");
/** Today: by kind, and the user's file not listed. */
const NOW_SCAFFOLD = [
  "  + .claude/settings.json",
  "  = .claude/hooks/x.sh (your script — kept, never overwritten)",
  "",
  "  1 created, 0 updated, 1 unchanged, 0 conflicts",
  "",
  "  1 stub(s) need implementation before this topology can run:",
  "    by kind: 1 gate check script",
  "    · .claude/skills/t/scripts/check.sh",
  SEARCH,
  "",
  "",
].join("\n");

const MUST_DIFFER: Array<[string, string, string]> = [
  ["a non-stub gate's grade changed (refuse -> hope)", WAS_GUARD,
    NOW_GUARD.replace("  gate copy-check      refuse, a stop event: it cannot block a call  by:", "  gate copy-check      hope                                          by:")],
  ["the enforcement count changed by a non-stub cause", WAS_GUARD, NOW_GUARD.replace("enforcement: 1 of 2", "enforcement: 0 of 2")],
  ["the enforcement total changed", WAS_GUARD, NOW_GUARD.replace("enforcement: 1 of 2", "enforcement: 1 of 3")],
  ["an extra item line", WAS_GUARD,
    NOW_GUARD.replace("\n\nenforcement", "\n  deny Edit            refuse                                        by: settings  permissions.deny in .claude/settings.json\n\nenforcement")],
  ["a removed item line", WAS_GUARD, NOW_GUARD.replace(/\n  deny Bash[^\n]*/, "")],
  ["a changed note on a non-stub gate", WAS_GUARD, NOW_GUARD.replace(`gate-copy-check.sh · installed <X>: unverified\n${IND}${STOP}`, `gate-copy-check.sh · installed <X>: unverified\n${IND}⚠ exit 2 keeps the agent working`)],
  ["a removed note on a non-stub gate", WAS_GUARD, NOW_GUARD.replace(`gate-copy-check.sh · installed <X>: unverified\n${IND}${STOP}`, "gate-copy-check.sh · installed <X>: unverified")],
  ["a changed exit line", WAS_GUARD, NOW_GUARD.replace("--- exit 0", "--- exit 1")],
  ["the graded-none line missing", WAS_GUARD, NOW_GUARD.replace(`${GRADED}\n`, "")],
  ["the graded-none line with another count", WAS_GUARD, NOW_GUARD.replace("1 gate(s) graded none", "2 gate(s) graded none")],
  ["the stub note's path changed", WAS_GUARD, NOW_GUARD.replace(`${IND}${NEW_STUB}`, `${IND}${NEW_STUB.replace("check-quality", "check-other")}`)],
  ["the stub note kept its old wording", WAS_GUARD, NOW_GUARD.replace(NEW_STUB, OLD_STUB)],
  ["a stubbed gate's by: changed", WAS_GUARD, NOW_GUARD.replace("none                                          by: hook ", "none                                          by: code ")],
  ["a stubbed gate's where changed", WAS_GUARD, NOW_GUARD.replace("SubagentStop on writer", "SubagentStop on editor")],
  ["a stubbed gate's name changed", WAS_GUARD, NOW_GUARD.replace("gate quality-check ", "gate quality-chex  ")],
  ["a stubbed gate graded something other than none", WAS_GUARD, NOW_GUARD.replace("  gate quality-check   none      ", "  gate quality-check   hope      ")],
  ["a stubbed gate that kept the stop-event note", WAS_GUARD, NOW_GUARD.replace(`${IND}${NEW_STUB}`, `${IND}${STOP}\n${IND}${NEW_STUB}`)],
  ["a stubbed gate's other note dropped", WAS_GUARD.replace(`${IND}${OLD_STUB}`, `${IND}${OLD_STUB}\n${IND}⚠ also something else`), NOW_GUARD],
  ["a stub note on a gate not graded refuse", WAS_GUARD.replace("gate quality-check   refuse, a stop event: it cannot block a call", "gate quality-check   hope                                        "), NOW_GUARD],
  ["a padding-only difference where no regrade happened", PLAIN_GUARD, PLAIN_GUARD.replace("refuse  by: hook", "refuse   by: hook")],
  ["a padding difference on a note line of a regraded report", WAS_GUARD, NOW_GUARD.replace(`${IND}${STOP}`, `${IND} ${STOP}`)],
  ["a padding difference on the enforcement line of a regraded report", WAS_GUARD, NOW_GUARD.replace("enforcement: 1 of 2 steps refuse ·", "enforcement: 1 of 2 steps refuse  ·")],
  ["the line before the stub summary changed", WAS_SCAFFOLD, NOW_SCAFFOLD.replace("1 created, 0 updated", "2 created, 0 updated")],
  ["a line after the Search for line changed", `${WAS_SCAFFOLD}  done\n`, `${NOW_SCAFFOLD}  done!\n`],
  ["a line added after the Search for line", WAS_SCAFFOLD, `${NOW_SCAFFOLD}  extra\n`],
  ["a summary with no Search for line keeps what follows it", WAS_SCAFFOLD.replace(`${SEARCH}\n`, "  1 created\n"), NOW_SCAFFOLD.replace(`${SEARCH}\n`, "  2 created\n")],
  ["a foreign line inside the summary block", WAS_SCAFFOLD.replace("    · .claude/hooks/x.sh\n", "    · .claude/hooks/x.sh\n  ! a note\n"), NOW_SCAFFOLD],
  ["a validate line that is not a stub line", "Validating t.at\n\n  All validation rules passed.\n", "Validating t.at\n\n  stubs: none here\n\n  All validation rules passed.\n"],
];

const MUST_MATCH: Array<[string, string, string]> = [
  ["the stub summary removed (0.11.2 listed the user's file; today's has by kind)", WAS_SCAFFOLD, NOW_SCAFFOLD],
  ["a summary 0.11.2 printed that today drops whole (only the user's file was listed)",
    WAS_SCAFFOLD.replace("2 stub(s)", "1 stub(s)").replace("    · .claude/skills/t/scripts/check.sh\n", ""),
    NOW_SCAFFOLD.replace(/\n  1 stub\(s\)[\s\S]*$/, "\n")],
  ["a stubbed SubagentStop gate regraded none, the count one lower, the graded-none line", WAS_GUARD, NOW_GUARD],
  ["the same with today's narrower columns", WAS_GUARD, NOW_GUARD_NARROW],
  ["a stubbed before-agent gate: its onFailure note goes with the refuse grade",
    "  gate brief-check  refuse  by: hook  PreToolUse on launching drafter → before-agent.sh\n" +
      `${IND}${NO_BLOCK}\n${IND}${OLD_STUB}\n\nenforcement: 1 of 1 steps refuse\n--- exit 0\n`,
    `  gate brief-check  none  by: hook  PreToolUse on launching drafter → before-agent.sh\n${IND}${NEW_STUB}\n\nenforcement: 0 of 1 steps refuse\n${GRADED}\n--- exit 0\n`],
  ["a stubbed before-action gate keeps its scope notes",
    "  gate ship-check  refuse (Bash)  by: hook  PreToolUse on Bash|Monitor|PowerShell running ship → before-action.sh\n" +
      `${IND}${OLD_STUB}\n${IND}⚠ refuses in Claude Code sessions only\n\nenforcement: 1 of 1 steps refuse\n--- exit 0\n`,
    `  gate ship-check  none  by: hook  PreToolUse on Bash|Monitor|PowerShell running ship → before-action.sh\n${IND}${NEW_STUB}\n${IND}⚠ refuses in Claude Code sessions only\n\nenforcement: 0 of 1 steps refuse\n${GRADED}\n--- exit 0\n`],
  ["validate's new stub lines removed",
    "Validating t.at (t v1.0.0)\n\n  All validation rules passed.\n",
    "Validating t.at (t v1.0.0)\n\n  stubs (claude-code): 1 of 4 generated files are stubs: 1 hook script\n  1 stub path already holds your own file: tools/x.sh\n\n  All validation rules passed.\n"],
];

describe("[stub rulings] any difference but the ruled ones still fails", () => {
  it.each(MUST_DIFFER)("still differs: %s", (_name, was, now) => {
    expect(was).not.toBe(now);
    expect(same(was, now)).toBe(false);
  });
});

describe("[stub rulings] the ruled differences compare equal", () => {
  it.each(MUST_MATCH)("equal: %s", (_name, was, now) => {
    expect(was).not.toBe(now);
    expect(same(was, now)).toBe(true);
  });
});

/** Every pinned output in the repo, and every output frozen from 0.11.2. */
function pinned(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const dir of ["fixtures/text-pin", "fixtures/inv-pin"]) {
    for (const f of fs.readdirSync(join(here, dir)).sort()) out.push([`${dir}/${f}`, fs.readFileSync(join(here, dir, f), "utf-8")]);
  }
  for (const f of fs.readdirSync(join(here, "differential")).filter((x) => x.endsWith(".json")).sort()) {
    const j = JSON.parse(fs.readFileSync(join(here, "differential", f), "utf-8"));
    for (const s of j.sequences ?? []) s.steps.forEach((st: { output?: string }, n: number) => { if (typeof st.output === "string") out.push([`${f}: ${s.name} #${n + 1}`, st.output]); });
  }
  return out;
}

const VALIDATE_STUB = /^  (stubs \([^)]+\): \d+ of \d+ generated files are stubs: |1 stub path already holds your own file: |\d+ stub paths already hold your own files: )/;
const SUMMARY = /stub\(s\) need implementation before this topology can run:/;
const OLD_NOTE = /is still a stub, so it blocks every run until it is written/;

describe("[stub rulings] pinned output passes through unchanged but for its stub lines", () => {
  const all = pinned();
  const plain = all.filter(([, t]) => !SUMMARY.test(t) && !OLD_NOTE.test(t) && !t.split("\n").some((l) => VALIDATE_STUB.test(l)));
  const validateOnly = all.filter(([, t]) => !SUMMARY.test(t) && !OLD_NOTE.test(t) && t.split("\n").some((l) => VALIDATE_STUB.test(l)));

  it("the corpus is the one expected", () => {
    expect(all.filter(([n]) => n.startsWith("fixtures/")).length).toBe(34);
    expect(plain.length).toBeGreaterThan(100);
    expect(validateOnly.length).toBe(18);
  });

  it("with no stub line, each side is byte-identical to its input", () => {
    const changed = plain.filter(([, t]) => { const [a, b] = ruledSides(t, t); return a !== t || b !== t; }).map(([n]) => n);
    expect(changed).toEqual([]);
    for (const [, t] of plain) expect(regradeStubbedGates(t)).toBe(t);
  });

  it("with validate's stub lines, exactly those lines and the blank line after them go", () => {
    for (const [name, t] of validateOnly) {
      const lines = t.split("\n");
      const i = lines.findIndex((l) => VALIDATE_STUB.test(l));
      let j = i;
      while (VALIDATE_STUB.test(lines[j + 1])) j++;
      expect(lines[j + 1], name).toBe("");
      const want = [...lines.slice(0, i), ...lines.slice(j + 2)].join("\n");
      expect(stubless(t), name).toBe(want);
      expect(ruledSides(t, t), name).toEqual([want, want]);
    }
  });
});
