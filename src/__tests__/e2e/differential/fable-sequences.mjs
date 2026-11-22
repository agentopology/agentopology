/**
 * The 0.11.3 attack's merge sequences, in the merge-differential's step form
 * (runSequence in merge-sequences.mjs):
 *
 *   - T1-T36: scaffold, guard --target, settings and manifest edits, --prune,
 *     dry-run, two topologies taking turns, user hooks on the topology's and
 *     on project scripts. The attack ran the first steps with 0.11.2 and the
 *     rest with a candidate; here every step runs with the one CLI under test,
 *     so a branch equal to 0.11.2 at every step is equal on every mix.
 *   - f2 1-16: a user's settings.json hook and the .at's on the same script in
 *     another form; scaffold, then guard --check.
 *   - rt: a hand-built harness with one hook (58 commands): import, validate,
 *     scaffold in place.
 *
 * The .at is examples/simple-pipeline.at as it was frozen (simple-pipeline.at
 * beside this file).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SEQUENCES } from "./merge-sequences.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const base = fs.readFileSync(path.join(here, "simple-pipeline.at"), "utf-8");
const SCRIPT = "#!/bin/bash\nexit 0\n";

const hk = (id, run, extra = "", ev = "PreToolUse", matcher = "Bash") =>
  `    hook ${id} {\n      on: ${ev}\n      matcher: "${matcher}"\n      run: ${JSON.stringify(run)}\n      type: command\n${extra}    }\n`;
const named = (name) => base.replace("topology simple-pipeline", "topology " + name);
const at = (name, ...hs) => {
  const src = named(name);
  return src.slice(0, src.lastIndexOf("}")) + (hs.length ? `  hooks {\n${hs.join("")}  }\n` : "") + "}\n";
};
const A = (...hs) => at("simple-pipeline", ...hs);
const nameOf = (src) => src.match(/topology (\S+)/)[1];
const sc = (src, ...flags) => ({ atFile: { name: nameOf(src), text: src }, run: ["scaffold", `${nameOf(src)}.at`, "--target", "claude-code", ...flags] });
const guard = (src, ...flags) => ({ atFile: { name: nameOf(src), text: src }, run: ["guard", `${nameOf(src)}.at`, "--target", "claude-code", "--dir", "<ROOT>", ...flags] });
const edit = (fn) => ({ settings: (j) => { fn(j); return j; } });
const setHooks = (fn) => (j) => { j.hooks = j.hooks ?? {}; fn(j.hooks); };
const userHook = (command, extra = {}, ev = "PreToolUse", matcher = "Bash") =>
  setHooks((h) => { (h[ev] = h[ev] ?? []).push({ matcher, hooks: [{ type: "command", command, ...extra }] }); });
const IF = (v) => `      if: ${JSON.stringify(v)}\n`;
const G = "scripts/guard.sh";

export const FABLE_SEQUENCES = [];
const T = (name, steps) => FABLE_SEQUENCES.push({ name: `hk ${name}`, setup: { "tools/mine.sh": SCRIPT }, steps });

T("T1 upgrade, .at adds an arg", [sc(A(hk("g", G))), sc(A(hk("g", `${G} --strict`)))]);
T("T2 upgrade, .at removes the hook", [sc(A(hk("g", G))), sc(A())]);
T("T3 upgrade, .at renames the script", [sc(A(hk("g", G))), sc(A(hk("g", "scripts/guard2.sh")))]);
T("T4 upgrade, .at changes if", [sc(A(hk("g", G, IF("Bash(rm *)")))), sc(A(hk("g", G, IF("Bash(git push *)"))))]);
T("T5 upgrade, .at changes timeout", [sc(A(hk("g", G, "      timeout: 5000\n"))), sc(A(hk("g", G, "      timeout: 9000\n")))]);
T("T6 upgrade, .at adds strength: refuse", [sc(A(hk("g", G))), sc(A(hk("g", G, "      strength: refuse\n")))]);
T("T7 upgrade unchanged, THEN .at removes the hook", [sc(A(hk("g", G))), sc(A(hk("g", G))), sc(A())]);
T("T8 upgrade unchanged, THEN .at changes if", [sc(A(hk("g", G, IF("Bash(rm *)")))), sc(A(hk("g", G, IF("Bash(rm *)")))), sc(A(hk("g", G, IF("Bash(git push *)"))))]);
T("T9 same version twice, .at removes the hook", [sc(A(hk("g", G))), sc(A())]);
T("T10 same version, .at changes if", [sc(A(hk("g", G, IF("Bash(rm *)")))), sc(A(hk("g", G, IF("Bash(git push *)"))))]);
T("T11 same version, .at changes timeout", [sc(A(hk("g", G, "      timeout: 5000\n"))), sc(A(hk("g", G, "      timeout: 9000\n")))]);
T("T12 user hand-edits the generated hook's timeout, rescaffold", [sc(A(hk("g", G))), edit(setHooks((h) => { h.PreToolUse.find((g) => /guard/.test(g.hooks[0].command)).hooks[0].timeout = 5; })), sc(A(hk("g", G)))]);
T("T13 user adds own hook on the topology's script (other if), then .at removes its hook", [sc(A(hk("g", G))), edit(userHook('bash "$CLAUDE_PROJECT_DIR/.claude/skills/simple-pipeline/scripts/guard.sh"', { if: "Bash(curl *)" })), sc(A())]);
T("T14 user's own hook equals the generated one (import shape), then .at removes it", [edit(userHook('bash "$CLAUDE_PROJECT_DIR/tools/mine.sh"')), sc(A(hk("g", "tools/mine.sh"))), sc(A())]);
T("T15 user's own hook, same script other form, .at declares it, then removes it", [edit(userHook("./tools/mine.sh")), sc(A(hk("g", "tools/mine.sh"))), sc(A())]);
T("T16 user hook unrelated, .at hook removed", [edit(userHook("echo mine")), sc(A(hk("g", G))), sc(A())]);
T("T17 two topologies take turns: A, B, A", [sc(at("topo-a", hk("ga", "scripts/a.sh"))), sc(at("topo-b", hk("gb", "scripts/b.sh"))), sc(at("topo-a", hk("ga", "scripts/a.sh")))]);
T("T18 two topologies: A, B, then A removes its hook", [sc(at("topo-a", hk("ga", "scripts/a.sh"))), sc(at("topo-b", hk("gb", "scripts/b.sh"))), sc(at("topo-a"))]);
T("T19 two topologies: A, then B", [sc(at("topo-a", hk("ga", "scripts/a.sh"))), sc(at("topo-b", hk("gb", "scripts/b.sh")))]);
T("T20 scaffold, then guard --target", [sc(A(hk("g", G), hk("p", "scripts/post.sh", "", "PostToolUse"))), guard(A(hk("g", G), hk("p", "scripts/post.sh", "", "PostToolUse")))]);
T("T21 guard, then scaffold, then .at removes hook via guard", [guard(A(hk("g", G))), sc(A(hk("g", G))), guard(A())]);
T("T22 scaffold, then guard with a changed if", [sc(A(hk("g", G, IF("Bash(rm *)")))), guard(A(hk("g", G, IF("Bash(git push *)"))))]);
T("T23 dry-run after a change writes nothing", [sc(A(hk("g", G))), sc(A(), "--dry-run")]);
T("T24 --prune, .at removes the hook", [sc(A(hk("g", G))), sc(A(), "--prune")]);
T("T25 a garbage field in the manifest's settings entry", [sc(A(hk("g", G))), { manifest: (m) => { m.files[".claude/settings.json"].hookKeys = "oops"; } }, sc(A(hk("g", `${G} --x`)))]);
T("T26 manifest deleted, .at removes the hook", [sc(A(hk("g", G))), { nomanifest: true }, sc(A())]);
T("T27 user deletes a generated hook by hand, rescaffold", [sc(A(hk("g", G))), edit(setHooks((h) => { h.PreToolUse = h.PreToolUse.filter((g) => !/guard/.test(g.hooks[0].command)); })), sc(A(hk("g", G)))]);
T("T28 two .at hooks same script different if, user edits settings, rescaffold (P-1)", [sc(A(hk("g1", G, IF("Bash(rm *)")), hk("g2", G, IF("Bash(git push *)")))), edit((j) => { j.model = "opus"; }), sc(A(hk("g1", G, IF("Bash(rm *)")), hk("g2", G, IF("Bash(git push *)"))))]);
T("T29 P-1 shape, settings edited between", [sc(A(hk("g1", G, IF("Bash(rm *)")), hk("g2", G, IF("Bash(git push *)")))), edit((j) => { j.model = "opus"; }), sc(A(hk("g1", G, IF("Bash(rm *)")), hk("g2", G, IF("Bash(git push *)"))))]);
T("T30 user hook on a gate wrapper path survives a gate removal?", [sc(A()), edit(userHook('bash "$CLAUDE_PROJECT_DIR/.claude/skills/simple-pipeline/scripts/gate-quality-check.sh"', { if: "Bash(deploy *)" })), sc(A())]);
T("T31 user adds a 2nd hook on the topology's script (other if), .at unchanged, rescaffold", [sc(A(hk("g", G))), edit(userHook('bash "$CLAUDE_PROJECT_DIR/.claude/skills/simple-pipeline/scripts/guard.sh"', { if: "Bash(curl *)" })), sc(A(hk("g", G)))]);
T("T32 user adds a 2nd hook on a project script the .at also runs (other if), rescaffold", [sc(A(hk("g", "tools/mine.sh"))), edit(userHook('bash "$CLAUDE_PROJECT_DIR/tools/mine.sh"', { if: "Bash(curl *)" })), sc(A(hk("g", "tools/mine.sh")))]);
T("T33 hand-built hook, guard --target with a .at that declares it", [edit(userHook("tools/mine.sh --x")), guard(A(hk("g", "tools/mine.sh --x")))]);
T("T34 same as T33 with scaffold, twice", [edit(userHook("tools/mine.sh --x")), sc(A(hk("g", "tools/mine.sh --x"))), sc(A(hk("g", "tools/mine.sh --x")))]);
T("T35 user changes the generated command by hand (adds an arg), rescaffold", [sc(A(hk("g", "tools/mine.sh"))), edit(setHooks((h) => { h.PreToolUse.find((g) => /mine/.test(g.hooks[0].command)).hooks[0].command += " --mine"; })), sc(A(hk("g", "tools/mine.sh")))]);
T("T36 user's project-path hook, scaffold twice, then .at drops it", [edit(userHook("./tools/mine.sh")), sc(A(hk("g", "tools/mine.sh"))), sc(A(hk("g", "tools/mine.sh"))), sc(A())]);

// f2: a user's hook and the .at's, scaffold, then guard --check.
const U = (command, extra = {}, matcher = "Bash") => ({ hooks: { PreToolUse: [{ matcher, hooks: [{ type: "command", command, ...extra }] }] } });
const f2at = (...hs) => base.slice(0, base.lastIndexOf("}")) + `  hooks {\n${hs.join("")}  }\n}\n`;
const F2 = [
  ["1 user sh, .at bash (same file)", U("sh .claude/hooks/x.sh"), f2at(hk("g", "bash .claude/hooks/x.sh"))],
  ["2 user `guard` (PATH), .at `command guard`", U("guard"), f2at(hk("g", "command guard"))],
  ["3 user single quotes, .at double quotes", U("echo '$HOME' | cat"), f2at(hk("g", 'echo "$HOME" | cat'))],
  ["4 user `x.sh` bare (PATH), .at ./x.sh project file", U("x.sh"), f2at(hk("g", "./x.sh"))],
  ["5 user doc form, .at adds strength: refuse", U('"$CLAUDE_PROJECT_DIR"/.claude/hooks/x.sh'), f2at(hk("g", '"$CLAUDE_PROJECT_DIR"/.claude/hooks/x.sh', "      strength: refuse\n"))],
  ["6 user doc form with if A, .at same script with if B", U('"$CLAUDE_PROJECT_DIR"/.claude/hooks/x.sh', { if: "Bash(rm *)" }), f2at(hk("g", ".claude/hooks/x.sh", IF("Bash(git push *)")))],
  ["7 .at alone: two hooks, same script, different if", null, f2at(hk("g1", G, IF("Bash(rm *)")), hk("g2", G, IF("Bash(git push *)")))],
  ["8 .at alone: command lint-a and bash lint-a.sh", null, f2at(hk("g1", "command lint-a"), hk("g2", "bash lint-a.sh"))],
  ["9 user `bash -c 'exit 2'`, .at `exit 2`", U("bash -c 'exit 2'"), f2at(hk("g", "exit 2"))],
  ["10 user quoted arg with space, .at two args", U('.claude/hooks/x.sh "a b"'), f2at(hk("g", ".claude/hooks/x.sh a b"))],
  ["11 user $CLAUDE_PROJECT_DIR as an arg, .at without", U('cd "$CLAUDE_PROJECT_DIR" && true'), f2at(hk("g", "cd && true"))],
  ["12 user sh tools/a.sh, .at tools/a.sh", U("sh tools/a.sh"), f2at(hk("g", "tools/a.sh"))],
  ["13 user `command echo hi`, .at `echo hi`", U("command echo hi"), f2at(hk("g", "echo hi"))],
  ["14 user doc form timeout 1, .at timeout 600000", U('"$CLAUDE_PROJECT_DIR"/.claude/hooks/x.sh', { timeout: 1 }), f2at(hk("g", ".claude/hooks/x.sh", "      timeout: 600000\n"))],
  ["15 different matcher (control)", U('"$CLAUDE_PROJECT_DIR"/.claude/hooks/x.sh', {}, "Edit"), f2at(hk("g", ".claude/hooks/x.sh"))],
  ["16 different args (control)", U('"$CLAUDE_PROJECT_DIR"/.claude/hooks/x.sh --a'), f2at(hk("g", ".claude/hooks/x.sh --b"))],
];
for (const [name, settings, src] of F2) {
  FABLE_SEQUENCES.push({
    name: `f2 ${name}`,
    setup: { ".claude/hooks/x.sh": SCRIPT, "x.sh": SCRIPT, "tools/a.sh": SCRIPT },
    steps: [
      ...(settings ? [{ settings: () => settings }] : []),
      { at: src, run: ["scaffold", "t.at", "--target", "claude-code"] },
      { run: ["guard", "t.at", "--check", "--dir", "."] },
    ],
  });
}

/** rt: one hook per hand-built harness; import, validate, scaffold in place. */
export const RT_COMMANDS = [
  'bash "$CLAUDE_PROJECT_DIR/x.sh"', 'bash "$CLAUDE_PROJECT_DIR/.claude/hooks/my guard.sh" --flag "a b"', '"$CLAUDE_PROJECT_DIR"/.claude/hooks/x.sh',
  '"$CLAUDE_PROJECT_DIR/.claude/hooks/x.sh"', "$CLAUDE_PROJECT_DIR/.claude/hooks/x.sh arg", "${CLAUDE_PROJECT_DIR}/.claude/hooks/x.sh",
  '"${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/x.sh" --a', ".claude/hooks/x.sh", './.claude/hooks/x.sh "$1"', 'node "$CLAUDE_PROJECT_DIR/tools/a.mjs" --x',
  "node $CLAUDE_PROJECT_DIR/tools/a.mjs", 'python3 "$CLAUDE_PROJECT_DIR/tools/guard.py" --re "a\\\\d+"', 'python3 -u "$CLAUDE_PROJECT_DIR/tools/guard.py"',
  "python3 -m mypkg.guard", 'uv run --project "$CLAUDE_PROJECT_DIR" tool', 'npx -y prettier@3 --write "$CLAUDE_FILE_PATHS"', "prettier --write .", "x.sh", "guard",
  "make lint", "git diff --quiet", "jq -r '.tool_input.command' | grep -q 'rm -rf' && exit 2 || true",
  'branch=$(git rev-parse --abbrev-ref HEAD); if [ "$branch" = "main" ]; then exit 2; fi', 'echo "#not a comment"', "echo done # trailing comment",
  "echo 'single { brace'", 'echo "}"', 'echo "ends with backslash \\\\"', "echo a\\ b", 'echo "$HOME"', '"$HOME"/bin/x.sh', "~/bin/x.sh",
  "/usr/local/bin/x.sh --flag", "bash -c 'echo \"{\\\"a\\\": 1}\"'", "sh .claude/hooks/x.sh", "bash .claude/hooks/x.sh 2>/dev/null || true",
  'cd "$CLAUDE_PROJECT_DIR/web" && npm test', "FOO=1 .claude/hooks/x.sh", "env FOO=1 .claude/hooks/x.sh", "exit 2", "true",
  "osascript -e 'display notification \"done\"'", "afplay /System/Library/Sounds/Glass.aiff", 'powershell -File "$CLAUDE_PROJECT_DIR/x.ps1"',
  'ruby "$CLAUDE_PROJECT_DIR/x.rb"', "php x.php", 'tsx "$CLAUDE_PROJECT_DIR/x.ts"', 'bun run "$CLAUDE_PROJECT_DIR/x.ts"', "docker run --rm img check",
  'echo "tab\there"', "echo é", 'echo "é ✓"', '  bash "$CLAUDE_PROJECT_DIR/x.sh"  ', 'bash  "$CLAUDE_PROJECT_DIR/x.sh"   --two  spaces',
  'echo "a: b, [c] | d"', "echo a:b", "printf '%s\\n' \"x\"", 'echo \\"x\\"',
];
/**
 * More round-trip commands: a hook script through `$CLAUDE_PROJECT_DIR` after
 * an interpreter, in each shape the run reader reads as a path. 0.11.2 had
 * no reading for them, so they are kept out of RT_SEQUENCES (frozen against
 * 0.11.2) and checked by the import invariant and by
 * scaffold/__tests__/project-dir-identity.test.ts (one settings.json entry
 * after import then scaffold).
 */
export const RT_PROJECT_DIR_FORMS = [
  'python3 "$CLAUDE_PROJECT_DIR"/tools/a.py hook', 'python3 -I -B "${CLAUDE_PROJECT_DIR}/tools/b.py" hook',
  'python3 "${CLAUDE_PROJECT_DIR:-.}/tools/c.py"', "python3 ${CLAUDE_PROJECT_DIR}/tools/d.py",
];
export const RT_SEQUENCES = RT_COMMANDS.map((cmd, i) => ({
  name: `rt ${i + 1}: ${cmd}`,
  setup: {
    ".claude/agents/a.md": "---\nname: a\ndescription: An agent\n---\n\nBody.\n",
    "x.sh": SCRIPT, ".claude/hooks/x.sh": SCRIPT, ".claude/hooks/my guard.sh": SCRIPT,
    ".claude/settings.json": JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: cmd }] }] } }, null, 2),
  },
  steps: [
    { run: ["import", "--target", "claude-code", "--dir", ".", "--name", "t", "--output", "."] },
    { run: ["validate", "t.at"] },
    { run: ["scaffold", "t.at", "--target", "claude-code"] },
  ],
}));

/** Every merge sequence the differential freezes and checks, in order. */
export const ALL_SEQUENCES = [...SEQUENCES, ...FABLE_SEQUENCES, ...RT_SEQUENCES];
