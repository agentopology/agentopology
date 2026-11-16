/**
 * Scaffold → edit → re-scaffold sequences for the 0.11.2 merge differential.
 *
 * Each sequence runs steps against one fresh project with a given agentopology
 * CLI and records, after every step, the exit code, the scaffold output and
 * .claude/settings.json byte for byte. The same code runs against a v0.11.2
 * build (to freeze merge-0112.json, freeze-merge.mjs) and against this branch
 * (the test), so both are read the same way.
 *
 * Plain JavaScript: it runs either CLI by path.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** A hook in the .at: { id, on, matcher, run, timeout, if, strength }. */
function hookText(h) {
  return [
    `    hook ${h.id} {`,
    `      on: ${h.on ?? "PreToolUse"}`,
    ...(h.matcher === null ? [] : [`      matcher: ${JSON.stringify(h.matcher ?? "Bash")}`]),
    `      run: ${JSON.stringify(h.run)}`,
    "      type: command",
    ...(h.timeout !== undefined ? [`      timeout: ${h.timeout}`] : []),
    ...(h.if !== undefined ? [`      if: ${JSON.stringify(h.if)}`] : []),
    ...(h.strength ? [`      strength: ${h.strength}`] : []),
    "    }",
  ].join("\n");
}

/** The .at: two agents, an optional gate, the hooks. */
export function atWith(hooks, gateRun) {
  return [
    "topology t : [pipeline] {",
    "  meta {",
    '    version: "1.0.0"',
    '    description: "merge differential"',
    "  }",
    "  orchestrator {",
    "    model: sonnet",
    "  }",
    "  agent a {",
    "    model: sonnet",
    '    description: "a"',
    "  }",
    "  agent b {",
    "    model: sonnet",
    '    description: "b"',
    "  }",
    "  flow { a -> b }",
    ...(gateRun ? ["  gates {", "    gate g {", "      after: a", "      before: b", `      run: ${JSON.stringify(gateRun)}`, "    }", "  }"] : []),
    ...(hooks.length ? ["  hooks {", ...hooks.map(hookText), "  }"] : []),
    "}",
  ].join("\n") + "\n";
}

const H = (id, run, extra = {}) => ({ id, run, ...extra });
const scaffold = (...flags) => ({ run: ["scaffold", "t.at", "--target", "claude-code", ...flags] });
const at = (hooks, gate) => ({ at: atWith(hooks, gate) });
const addKey = { settings: (s) => ({ ...s, statusLine: { type: "command", command: "echo hi" } }) };
const addRule = { settings: (s) => ({ ...s, permissions: { ...(s.permissions ?? {}), allow: [...(s.permissions?.allow ?? []), "Bash(npm test)"] } }) };
const userHook = (command, extra = {}) => ({
  settings: (s) => ({ ...s, hooks: { ...(s.hooks ?? {}), PreToolUse: [...(s.hooks?.PreToolUse ?? []), { matcher: "Bash", hooks: [{ type: "command", command, ...extra }] }] } }),
});

const PROJ = ".claude/hooks/x.sh";
const TOPO = "scripts/guard.sh";
const TOOL = "prettier --write .";

/** Every sequence: a name and its steps. A step writes the .at, edits settings.json, or runs the CLI. */
export const SEQUENCES = [];
const seq = (name, ...steps) => SEQUENCES.push({ name, steps });

for (const [kind, run] of [["project path", PROJ], ["topology script", TOPO], ["PATH tool", TOOL]]) {
  for (const edit of [null, addKey]) {
    const e = edit ? " (settings.json edited between)" : "";
    const mid = edit ? [edit] : [];
    seq(`${kind}: timeout 5 -> 9${e}`, at([H("g", run, { timeout: 5 })]), scaffold(), ...mid, at([H("g", run, { timeout: 9 })]), scaffold());
    seq(`${kind}: if A -> B${e}`, at([H("g", run, { if: "Bash(rm *)" })]), scaffold(), ...mid, at([H("g", run, { if: "Bash(git push *)" })]), scaffold());
    seq(`${kind}: matcher Bash -> Edit${e}`, at([H("g", run)]), scaffold(), ...mid, at([H("g", run, { matcher: "Edit" })]), scaffold());
    seq(`${kind}: strength refuse added${e}`, at([H("g", run)]), scaffold(), ...mid, at([H("g", run, { strength: "refuse" })]), scaffold());
    seq(`${kind}: added, then removed${e}`, at([]), scaffold(), at([H("g", run)]), scaffold(), ...mid, at([]), scaffold());
    seq(`${kind}: removed with --prune${e}`, at([H("g", run)]), scaffold(), ...mid, at([]), scaffold("--prune"));
    seq(`${kind}: timeout change, --dry-run${e}`, at([H("g", run, { timeout: 5 })]), scaffold(), ...mid, at([H("g", run, { timeout: 9 })]), scaffold("--dry-run"));
  }
}
seq("run changed: scripts/a.sh -> scripts/b.sh", at([H("g", "scripts/a.sh")]), scaffold(), addKey, at([H("g", "scripts/b.sh")]), scaffold());
seq("run changed: .claude/hooks/a.sh -> .claude/hooks/b.sh", at([H("g", ".claude/hooks/a.sh")]), scaffold(), addKey, at([H("g", ".claude/hooks/b.sh")]), scaffold());
seq("gate run changed", at([], "scripts/check.sh"), scaffold(), addKey, at([], "scripts/check2.sh"), scaffold());
seq("gate run with a redirect", at([], "scripts/check.sh > /dev/null"), scaffold(), addKey, scaffold());
seq("user hook on the same project script before the first scaffold (if A vs the .at's if B)",
  userHook('bash "$CLAUDE_PROJECT_DIR/.claude/hooks/x.sh"', { if: "Bash(rm *)" }), at([H("g", PROJ, { if: "Bash(git push *)" })]), scaffold(), scaffold());
seq("user hook on the same project script, timeout 1 vs the .at's 600000",
  userHook('bash "$CLAUDE_PROJECT_DIR/.claude/hooks/x.sh"', { timeout: 1 }), at([H("g", PROJ, { timeout: 600000 })]), scaffold(), scaffold());
seq("user hook added after the first scaffold, on the topology script",
  at([H("g", TOPO)]), scaffold(), userHook('bash "$CLAUDE_PROJECT_DIR/.claude/skills/t/scripts/guard.sh"', { if: "Bash(rm *)" }), scaffold());
seq("user rule and a new key between scaffolds", at([H("g", TOPO)]), scaffold(), addRule, addKey, at([H("g", TOPO, { timeout: 3 })]), scaffold());
seq("two hooks, one topology script, different if (P-1)",
  at([H("g1", TOPO, { if: "Bash(rm *)" }), H("g2", TOPO, { if: "Bash(git push *)" })]), scaffold(), addKey, scaffold());
seq("two hooks, one project script, different if (P-1)",
  at([H("g1", PROJ, { if: "Bash(rm *)" }), H("g2", PROJ, { if: "Bash(git push *)" })]), scaffold(), addKey, scaffold());
seq("hook moved to another event", at([H("g", TOPO)]), scaffold(), addKey, at([H("g", TOPO, { on: "PostToolUse" })]), scaffold());

/** Output with the project path, colour and the machine's installed-version lines taken out. */
function normalize(text, root) {
  return text
    .split(root).join("<ROOT>")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split("\n")
    .filter((l) => !/^\s*(installed \S+:|checked against Claude Code)/.test(l))
    .join("\n");
}

/** Run one sequence with `cli`; one record per step that runs the CLI. */
export function runSequence(cliPath, sequence, tmpBase = os.tmpdir()) {
  const cli = path.resolve(cliPath);
  const root = fs.mkdtempSync(path.join(tmpBase, "at-merge-"));
  try {
    fs.mkdirSync(path.join(root, ".claude/hooks"), { recursive: true });
    for (const f of ["a.sh", "b.sh", "x.sh"]) fs.writeFileSync(path.join(root, ".claude/hooks", f), "#!/bin/bash\nexit 0\n");
    const settingsPath = path.join(root, ".claude/settings.json");
    const records = [];
    for (const step of sequence.steps) {
      if (step.at) fs.writeFileSync(path.join(root, "t.at"), step.at);
      if (step.settings) {
        const s = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, "utf8")) : {};
        fs.writeFileSync(settingsPath, JSON.stringify(step.settings(s), null, 2) + "\n");
      }
      if (step.run) {
        const r = spawnSync(process.execPath, [cli, ...step.run], { cwd: root, encoding: "utf8", env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" } });
        records.push({
          args: step.run.join(" "),
          code: r.status,
          output: normalize(`${r.stdout}${r.stderr}`, root),
          settings: fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, "utf8") : null,
        });
      }
    }
    return records;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
