/**
 * The guard-hook corpus for 0.11.4: the topologies, the inputs, and a runner
 * that scaffolds each topology with a given build and runs every generated
 * guard hook (before-action.sh, before-edit.sh, before-agent.sh) on every
 * input, with jq on PATH and without it. It records only the exit code.
 *
 * Plain JavaScript on purpose: freeze-hooks.mjs runs it against a v0.11.2
 * dist, and hook-differential-0112.test.ts against this branch's source.
 *
 * The state is fixed: no ledger record exists and every gate check script is
 * the scaffold's stub (which fails), so a command the hook reads as a gated
 * step, or cannot read, exits 2 and anything else exits 0.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Topologies
// ---------------------------------------------------------------------------

/** The probe's topology: a git commit/push step behind a run: gate (no unit, no ledger). */
export const FACTORY = `topology factory : [pipeline] {
  meta { version: "1.0.0" description: "build then commit" }
  orchestrator { model: gpt-5.2 handles: [build, commit] }
  action build {
    kind: external
    commands: ["npm test"]
  }
  action commit {
    kind: external
    commands: ["git commit", "git push"]
  }
  gates {
    gate red-first {
      after: build
      before: commit
      run: "scripts/red-first.sh"
      on-fail: halt
    }
  }
  flow { build -> commit }
}
`;

/** action-guard.test.ts: a ledger gate with a unit. */
const SHIP = `topology ship : [pipeline] {
  meta { version: "1.0.0" description: "Render then publish" }
  orchestrator { model: gpt-5.2 handles: [render, publish] }
  action render {
    kind: external
    commands: ["./tool render"]
  }
  action publish {
    kind: external
    commands: ["./tool publish", "./tool republish"]
    unit-from: "./tool (?:re)?publish (\\\\S+)"
  }
  records {
    record trace { path: "logs/{unit}/trace.jsonl" }
  }
  gates {
    gate publish-ready {
      after: render
      before: publish
      ledger: trace
      on-fail: halt
    }
  }
  flow { render -> publish }
}
`;

/** cx-review-fixes.test.ts MEDIA: placeholders, a ledger with no unit. */
const SHOW = `topology show : [pipeline] {
  meta { version: "1.0.0" description: "Render after review" }
  orchestrator { model: gpt-5.2 handles: [review, render] }
  action review {
    kind: external
    commands: ["./media episode review EP.json"]
  }
  action render {
    kind: external
    commands: ["./media episode render EP.json OUT.mp4"]
  }
  records {
    record trace { path: "logs/trace.jsonl" }
  }
  gates {
    gate reviewed {
      after: review
      before: render
      ledger: trace
      on-fail: halt
    }
  }
  flow { review -> render }
}
`;

/** cx-review-fixes.test.ts INTERP_AT: an interpreter's script is the tool. */
const POST = `topology post : [pipeline] {
  meta { version: "1.0.0" description: "post" }
  orchestrator { model: gpt-5.2 handles: [check, post] }
  action check {
    kind: external
    commands: ["python3 harness/bin/check.py"]
  }
  action post {
    kind: external
    commands: ["python3 harness/bin/post-ig.py upload"]
    unit-from: "post-ig.py upload (\\\\S+)"
  }
  records {
    record trace { path: "logs/{unit}/trace.jsonl" }
  }
  gates {
    gate post-ready {
      after: check
      before: post
      ledger: trace
      on-fail: halt
    }
  }
  flow { check -> post }
}
`;

/** cx-review-fixes.test.ts READS_AT: two gated steps, an interpreter and a tool. */
const RD = `topology rd : [pipeline] {
  meta { version: "1.0.0" description: "rd" }
  orchestrator { model: gpt-5.2 handles: [check, register, kit] }
  action check {
    kind: external
    commands: ["python3 docs/check.py"]
  }
  action register {
    kind: external
    commands: ["python3 docs/deliver.py JOB"]
    unit-from: "deliver.py (\\\\S+)"
  }
  action kit {
    kind: external
    commands: ["./media kit SLUG"]
    unit-from: "media kit (\\\\S+)"
  }
  records {
    record trace { path: "logs/{unit}/trace.jsonl" }
  }
  gates {
    gate reg-ready {
      after: check
      before: register
      ledger: trace
      on-fail: halt
    }
    gate kit-ready {
      after: check
      before: kit
      ledger: trace
      on-fail: halt
    }
  }
  flow { check -> register -> kit }
}
`;

/** f-batch-b.test.ts RUN_GATE_BEFORE_STEP: a run: gate before a tool step, plus an agent. */
const RUNSTEP = `topology runstep : [pipeline] {
  meta { version: "1.0.0" description: "A run: gate before a script step" }
  orchestrator { model: gpt-5.2 handles: [render, publish] }
  action render {
    kind: external
    commands: ["./tool render"]
  }
  action publish {
    kind: external
    commands: ["./tool publish"]
  }
  agent editor {
    model: gpt-5.2
    description: "Edits"
  }
  gates {
    gate checked {
      after: render
      before: publish
      run: "scripts/checked.sh"
      on-fail: halt
    }
  }
  flow { render -> publish }
}
`;

/** Read a fixture of the e2e tests. */
const fixture = (name) => fs.readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");

/**
 * Codex `if:` hooks on Bash, as today's guard tests write them (f-batch-b, cx-review-fixes): the hook runs
 * through .codex/scripts/at-if.sh, which shares before-action.sh's reader. The hook's own script refuses
 * (exit 2), so the exit tells whether the filter let the hook run.
 */
const ifHooked = (hook) => `topology t : [pipeline] {
  meta { version: "1.0.0" description: "t" }
  agent worker {
    description: "Does work"
    model: gpt-5.2
    permissions: autonomous
    tools: [Read]
  }
  action intake {
    kind: inline
    description: "entry"
  }
  flow { intake -> worker }
  hooks {
${hook}
  }
}
`;
const IF_PUSH_REFUSE = ifHooked(`    hook no-push {
      on: PreToolUse
      matcher: "Bash"
      run: "scripts/no-push.sh"
      type: command
      strength: refuse
      if: "Bash(git push*)"
    }`);
const IF_PUSH_NOTE = ifHooked(`    hook note-push {
      on: PreToolUse
      matcher: "Bash"
      run: "scripts/note-push.sh"
      type: command
      if: "Bash(git push*)"
    }`);
const IF_RM = ifHooked(`    hook g {
      on: PreToolUse
      matcher: "Bash"
      if: "Bash(rm -rf *)"
      run: "exit 2"
      type: command
    }`);

/** The `if:` topologies (Codex only), each with the script its hook runs written to refuse. */
export const IF_TOPOLOGIES = [
  { id: "ifpush", src: () => IF_PUSH_REFUSE, script: ".codex/scripts/no-push.sh", glob: "git push*", refuse: true },
  { id: "ifpushnote", src: () => IF_PUSH_NOTE, script: ".codex/scripts/note-push.sh", glob: "git push*", refuse: false },
  { id: "ifrm", src: () => IF_RM, script: null, glob: "rm -rf *", refuse: false },
];

/** Every topology, and the bindings it is scaffolded with. */
export const TOPOLOGIES = [
  { id: "factory", src: () => FACTORY, bindings: ["claude-code", "codex"] },
  { id: "ship", src: () => SHIP, bindings: ["claude-code", "codex"] },
  { id: "show", src: () => SHOW, bindings: ["claude-code", "codex"] },
  { id: "post", src: () => POST, bindings: ["claude-code"] },
  { id: "rd", src: () => RD, bindings: ["claude-code"] },
  { id: "runstep", src: () => RUNSTEP, bindings: ["claude-code"] },
  // codex-gates.at: a ledger step, a gate before an agent, a human step before an agent
  { id: "cxgates", src: () => fixture("codex-gates.at"), bindings: ["codex"] },
  // compile.at: a gate and an approval before drafter; critic, tidy and auditor ungated
  { id: "compile", src: () => fixture("compile.at"), bindings: ["claude-code"] },
];

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** The probe's 40 ordinary commands (p0hook-probe.mjs). */
const PROBE_ORDINARY = [
  "git status", "git diff", "git diff HEAD~1", "git diff HEAD~3..HEAD", "git log HEAD~1", "git log --oneline -5",
  "git show HEAD~1", "git show HEAD^", "git show HEAD^{commit}", "git diff @{u}", "git log @{u}..HEAD", "git log main..feature",
  "git diff origin/main...HEAD", "git rev-parse HEAD~2", "git log -1 --format=%H", "git branch -a", "git stash list",
  "git blame src/a.ts", "git ls-files", "git fetch origin", "git diff --stat HEAD~1 HEAD", "git log --since=2.days",
  "git reflog -5", "git show HEAD~1:src/a.ts", "git diff HEAD@{1}", "git checkout -b fix/x", "git switch main",
  "ls -la", "cat README.md", "npm test", "npx vitest run", "node scripts/x.mjs", "grep -rn foo src", "ls ~/Projects",
  "cd ~ && ls", "echo $HOME", "find . -name \"*.ts\"", "rg TODO", "cat ~/.gitconfig", "wc -l src/*.ts",
];

/**
 * MUST NOT BLOCK against the factory topology (git commit / git push behind a refusing gate):
 * ordinary commands bash reads literally, and reading git commands whose expansion cannot make
 * them a commit or a push. Each must exit 0 with jq on PATH.
 */
export const MUST_NOT_BLOCK = [
  ...PROBE_ORDINARY,
  "git diff HEAD~2", "git log HEAD~5..HEAD", "git show HEAD~2:package.json", "git diff @{upstream}",
  "git log @{u}..", "git log ..@{u}", "git rev-parse @{u}", "git log -g HEAD@{2}", "git rev-parse HEAD^{tree}",
  "git show HEAD^{commit}:src/a.ts", "git stash show stash@{0}", "git diff HEAD~1 -- src/", "git log --oneline HEAD~10..HEAD~2",
  "git reset --soft HEAD~1", "git checkout HEAD~1 -- src/a.ts", "git log \"$BR\"", "git log --oneline \"$BR\" -5",
  "git show \"$SHA\"", "git diff \"$BASE\"...HEAD", "git log --author=\"$USER\"", "git diff --stat $BASE",
  "git log $BR..HEAD", "git add \"$FILE\"", "git status && git diff HEAD~1", "git log HEAD~1 | head -5",
  "ls ~/x", "cat ~/.bashrc", "ls -la ~", "echo a=b",
];

/** MUST BLOCK against the factory topology: a commit or a push, plain or in a form the guard cannot read. Exit 2. */
export const MUST_BLOCK = [
  "git commit", "git commit -m x", "git commit -am \"fix\"", "git push", "git push origin main",
  "git -C d commit", "g=git; $g commit", "git $(echo commit)", "git {commit,x}", "~/bin/git commit",
  "sh -c 'git commit'", "xargs git commit", "git commit -m \"$MSG\"", "git push origin \"$BR\"", "git push origin HEAD~1:main",
  "git --git-dir status commit", "git status && git commit -m x", "git c${x}ommit", "git co?mit", "git push ~/remote",
  "cd ~ && git commit", "git --no-pager commit", "git -c x=y log; git push", "git log $(git commit)", "GIT_DIR=x git commit",
];

/** Forms that 0.11.2 lets through, kept out of MUST_BLOCK until ruled on (see the 0.11.4 report). */
export const OPEN_FORMS = ["git -c alias.x=commit x", "git -c alias.x=push x"];

/** A Bash payload as Claude Code and Codex send it. */
const bashPayload = (tool, command) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: { command } });

/** Raw payloads holding a \u escape: jq reads them as the step (or an ordinary command); the raw letters do not. */
export const RAW_ACTION = [
  { name: "\\u git commit", payload: '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git \\u0063ommit"}}' },
  { name: "\\u ./tool publish", payload: '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"./tool \\u0070ublish ep1"}}' },
  { name: "\\u ls -la", payload: '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ls \\u002dla"}}' },
  { name: "continuation git commit", payload: '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git com\\\\\\nmit"}}' },
  { name: "backslash ./tool publish", payload: '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"./tool publis\\\\h ep1"}}' },
];

/**
 * Commands of today's guard tests (action-guard, shell-tools, f-batch-b, f-batch-fixes, cx-review-fixes,
 * codex-gates), pulled from their string literals once and kept here, so the corpus does not move when a
 * test is edited.
 */
export const GUARD_TEST_COMMANDS = [
  "./tool render", "./tool publish", "./tool republish", "./tool publish ep42", "ls -la", "./tool render ep42",
  "./tool publishing ep42", "DEBUG=1 TOKEN='a b' ./tool publish ep42", "./tool publish ../../etc", "ls",
  "cd sub && ./tool publish ep1", "true; ./tool publish ep1", "make x || ./tool publish ep1", "./tool lint | ./tool publish ep1",
  "echo hi\n./tool publish ep1", "(cd sub && ./tool publish ep1)", "cd sub && DEBUG=1 time ./tool publish ep1",
  "{ ./tool publish ep1; }", "./tool lint & ./tool publish ep1", "cd sub && ./tool publish ep2", "echo ./tool publish ep1",
  "cd sub && echo ./tool publish ep1", "sudo ./tool publish ep1", "bash -c './tool publish ep1'",
  "./tool publish ep1 && ./tool archive ep1", "./tool render && ./tool publish ep1",
  "& ./tool publish ep1", "& \"./tool\" publish ep1", "./tool publish ep1; echo x", "./tool publish ep1 | Out-Null",
  "./to`ol publish ep1", ".\\tool publish ep1", "& .\\tool publish ep1", "cmd /c \".\\tool publish ep1\"",
  "& ./tool @(\"publish\",\"ep1\")", "Start-Process ./tool -ArgumentList \"publish\",\"ep1\"", ".\\tool.exe publish ep1",
  "./tool.ps1 publish ep1", ".\\tool render ep1", "./tool @(\"publish\",\"ep1\")", "Get-Content logs/ep1/trace.jsonl",
  "Get-Content logs\\ep1\\trace.jsonl", "Select-String ok logs/ep1/trace.jsonl",
  "Add-Content logs/ep1/trace.jsonl '{\"step\":\"render\",\"unit\":\"ep1\",\"ok\":true}'",
  "Set-Content -Path logs/ep1/trace.jsonl -Value x", "Set-Content logs\\ep1\\trace.jsonl x", "echo x > logs/ep1/trace.jsonl",
  "Get-Content x | Out-File logs/ep1/trace.jsonl", "./tool publish ep1", "git push origin main",
  "$(git rev-parse --show-toplevel 2>/dev/null || pwd)", "command -v timeout || command -v gtimeout || echo none",
  "git status", "./tool  publish ep1", "./tool\tpublish ep1", "if ./tool publish ep1; then :; fi",
  "while ./tool publish ep1; do break; done", "until ./tool publish ep1; do :; done", "! ./tool publish ep1",
  "echo $(./tool publish ep1)", "echo `./tool publish ep1`", "command ./tool publish ep1", "nice ./tool publish ep1",
  "nice -n 5 ./tool publish ep1", "sudo -u bot ./tool publish ep1", "env -i ./tool publish ep1", "echo ep1 | xargs ./tool publish",
  "\"./tool\" publish ep1", "./tool 'publish' ep1", "/opt/project/tool publish ep1", "cd x && ./tool publish ep1",
  "(./tool publish ep1)", "FOO=1 ./tool publish ep1", "ls\n./tool publish ep1", "eval ./tool publish ep1", "./tool render ep1",
  "./tool publisher ep1", "echo done", "./media episode review EP.json", "./media episode render EP.json OUT.mp4",
  "./media episode render show/ep7/ep.json out.mp4", "./media episode list", "./media episode review show/ep7/ep.json",
  "\"./media episode render\"", "python3 harness/bin/check.py", "python3 harness/bin/post-ig.py upload",
  "./tool \\\npublish ep1", "./tool pub\\\nlish ep1", "./tool publish>/dev/null ep1", "./tool >/dev/null publish ep1",
  "./tool 2>&1 publish ep1", "./tool publish<<<x ep1", "./tool < /dev/null publish ep1", "./tool publish ep1 2>&1 | tee out.log",
  "./tool pu$()blish ep1", "./tool ${IFS}publish ep1", "./tool publish${X} ep1", "./tool publish$X ep1", "./tool $'publish' ep1",
  "./tool $'\\x70ublish' ep1", "./tool {publish,x} ep1", "./tool {publish,} ep1", "./tool p{ublish,} ep1", "./tool pub*lish ep1",
  "./tool pub?ish ep1", "./tool pub[l]ish ep1", "./to?l publish ep1", "./tool `echo publish` ep1", "./tool $(echo publish) ep1",
  "{./tool,publish,ep1}", "./TOOL publish ep1", "./tool -v publish ep1", "./tool --verbose=1 publish ep1", "ls *.txt",
  "cat src/*.ts | wc -l", "echo $HOME", "./tool publish --help", "./tool --version", "./tool publish ok1",
  "env A=\"./tool publish ok1\" ./tool publish ep2", "sudo ./tool publish ok1 ./tool publish ep2",
  "true ./tool publish ok1 ./tool publish ep2", "./tool  publish  ep1 > out.log 2>&1", "python3 harness/bin/post-ig.py upload ep7",
  "python3 ./harness/bin/post-ig.py upload ep7", "python3 /abs/elsewhere/harness/bin/post-ig.py upload ep7",
  "python harness/bin/post-ig.py upload ep7", "python post-ig.py upload ep7", "env python3 harness/bin/post-ig.py upload ep7",
  "/usr/bin/python3 -u harness/bin/post-ig.py upload ep7", "cd harness/bin && python3 post-ig.py upload ep7", "python3 -m pytest",
  "python3 harness/bin/post-ig.py --help", " git push", "cd . && git push", "git  push", "git -C . push", "command git push",
  "true; git push", "GIT_TRACE=1 git push", "sudo git push origin main", "/usr/bin/git push", "git \\\npush", "git push>/dev/null",
  "git pull", "echo push", "git log --oneline", "python3 docs/check.py", "python3 docs/deliver.py JOB", "./media kit SLUG",
  "git diff docs/deliver.py", "git log docs/deliver.py", "git add docs/deliver.py", "git commit -m \"deliver.py fix\"",
  "git commit -m \"media kit flag\"", "ls docs/deliver.py", "cat docs/deliver.py", "head docs/deliver.py",
  "grep -n x docs/deliver.py", "wc -l docs/deliver.py", "ls docs/*/*.py", "ls docs/media-engine/*.py", "echo media kit",
  "echo $HOME immediately", "cat tool media", "echo \"run ./media kit s1 later\"", "rg \"media kit\" docs", "echo ${PWD}/media",
  "ls media*", "python3 docs/deliver.py J1", "python docs/deliver.py J1", "./media kit s1", "sudo ./media kit s1",
  "echo s1 | xargs ./media kit", "timeout 5 ./media kit s1", "git -c alias.k='!./media kit s1' k", "rg --pre ./media kit docs",
  "env FOO=1 python3 docs/deliver.py J1", "`echo ./media` kit s1", "./media kit $S", "python3 -m runpy docs/deliver.py J1",
  "watch -n1 ./media kit s1", "nohup ./media kit s1 &", "find . -maxdepth 0 -exec nohup ./media kit s1 \\;",
  "find . -exec env -i PATH=/bin ./media kit s1 \\;", "find . -maxdepth 0 -exec timeout 5 ./media kit s1 \\;",
  "find . -ok stdbuf -o0 ./media kit s1 \\;", "./tool publish --help ep1", "./tool publish ok1; `echo ./tool` publish ep2",
  "./tool publish ..", "git -c core.pager='./media kit s1' log", "if cat ./media kit; then :; fi", "! cat ./media kit",
  "FOO=1 cat ./media kit", "while cat ./media kit; do break; done", "git rev-parse --show-toplevel", "cd repo && ./tool publish ep1",
  "cat", "echo x >> .codex/state/approvals.jsonl", "cat logs/ep1/trace.jsonl", "echo x > logs/trace.jsonl", "cat logs/trace.jsonl",
];

/** Every Bash command of the corpus, once. */
export const ACTION_COMMANDS = [...new Set([...MUST_NOT_BLOCK, ...MUST_BLOCK, ...OPEN_FORMS, ...GUARD_TEST_COMMANDS])];

/** Paths an edit names: ledgers in several spellings, the Codex approvals file, and ordinary files. */
export const EDIT_PATHS = [
  "src/a.ts", "README.md", "docs/notes.md", "logs/ep1/notes.md", "logs/ep1/trace.jsonl", "logs/ep1/TRACE.JSONL",
  "other/trace.jsonl", "logs/trace.jsonl", "./logs/../logs/ep1/trace.jsonl", ".codex/state/approvals.jsonl", "approvals.jsonl",
  "trace.jsonl.bak", "logs/ep1/trace.json",
];

/** Raw edit payloads with a \u escape. */
export const RAW_EDIT = [
  { name: "\\u ledger", payload: '{"hook_event_name":"PreToolUse","tool_name":"Edit","tool_input":{"file_path":"logs/ep1/trace\\u002ejsonl"}}', codexPath: "logs/ep1/trace\\u002ejsonl" },
  { name: "\\u ordinary", payload: '{"hook_event_name":"PreToolUse","tool_name":"Edit","tool_input":{"file_path":"src/\\u0061.ts"}}', codexPath: "src/\\u0061.ts" },
];

/** Agent names a launch carries. */
export const AGENT_NAMES = [
  "drafter", "Drafter", " drafter ", "agents/drafter", "drafter:", "critic", "tidy", "auditor", "editor", "Editor",
  "someone-else", "general-purpose", "",
];

/** Raw agent payloads with a \u escape. */
export const RAW_AGENT = [
  { name: "\\u drafter", agent: "dr\\u0061fter" },
  { name: "\\u editor", agent: "edit\\u006fr" },
  { name: "\\u critic", agent: "cr\\u0069tic" },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/** The tools a hook may call. The no-jq PATH holds these; the jq PATH holds these and jq. */
const TOOLS = ["bash", "sh", "env", "cat", "tr", "sed", "grep", "date", "dirname", "basename", "head", "tail", "mkdir",
  "find", "awk", "realpath", "readlink", "git", "python3", "ls", "wc", "sort", "timeout",
  // the Codex hook launcher (at-if.sh runs behind it)
  "mktemp", "rm", "kill", "sleep", "pgrep"];

/** Two PATH folders of symlinks, made in a fresh temp dir: one with jq and one without. */
export function toolPaths() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "at-hookpaths-"));
  const nojq = path.join(base, "nojq");
  const withjq = path.join(base, "jq");
  fs.mkdirSync(nojq);
  fs.mkdirSync(withjq);
  for (const t of [...TOOLS, "jq"]) {
    const w = spawnSync("/bin/sh", ["-c", `command -v ${t}`], { encoding: "utf8" }).stdout.trim();
    if (!w.startsWith("/")) continue;
    if (t !== "jq") fs.symlinkSync(w, path.join(nojq, t));
    fs.symlinkSync(w, path.join(withjq, t));
  }
  return { jq: withjq, nojq, hasJq: fs.existsSync(path.join(withjq, "jq")) };
}

const HOOKS = ["before-action.sh", "before-edit.sh", "before-agent.sh"];

/** The inputs one hook of one binding gets: [{ input, payload }]. */
function inputsFor(hook, binding) {
  const codex = binding === "codex";
  if (hook === "before-action.sh") {
    return [
      ...ACTION_COMMANDS.map((c) => ({ input: c, payload: bashPayload("Bash", c) })),
      ...RAW_ACTION.map((r) => ({ input: `raw: ${r.name}`, payload: r.payload })),
    ];
  }
  if (hook === "before-edit.sh") {
    const one = (p) => codex
      ? JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { command: `*** Begin Patch\n*** Update File: ${p}\n@@\n-a\n+b\n*** End Patch\n` } })
      : JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: p, old_string: "a", new_string: "b" } });
    return [
      ...EDIT_PATHS.map((p) => ({ input: p, payload: one(p) })),
      ...RAW_EDIT.map((r) => ({
        input: `raw: ${r.name}`,
        payload: codex
          ? `{"hook_event_name":"PreToolUse","tool_name":"apply_patch","tool_input":{"command":"*** Begin Patch\\n*** Update File: ${r.codexPath}\\n*** End Patch\\n"}}`
          : r.payload,
      })),
    ];
  }
  const launch = (a) => codex
    ? JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "collaborationspawn_agent", tool_input: { task_name: "t", agent_type: a, message: "go", fork_turns: "none" } })
    : JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: a, prompt: "go" } });
  return [
    ...AGENT_NAMES.map((a) => ({ input: a, payload: launch(a) })),
    ...RAW_AGENT.map((r) => ({
      input: `raw: ${r.name}`,
      payload: codex
        ? `{"hook_event_name":"PreToolUse","tool_name":"collaborationspawn_agent","tool_input":{"task_name":"t","agent_type":"${r.agent}","message":"go"}}`
        : `{"hook_event_name":"PreToolUse","tool_name":"Agent","tool_input":{"subagent_type":"${r.agent}","prompt":"go"}}`,
    })),
  ];
}

/** Scaffold one topology with one binding into a fresh temp dir; return the root and the hooks it wrote. */
export function scaffoldOne(lib, topo, binding) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `at-hooks-${topo.id}-${binding}-`));
  const files = lib.bindings[binding].scaffold(lib.parse(topo.src()));
  for (const f of files) {
    const p = path.join(root, f.path);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, f.content);
    if (f.executable) fs.chmodSync(p, 0o755);
  }
  fs.mkdirSync(path.join(root, "src/deep"), { recursive: true });
  const dir = binding === "codex" ? `.codex/scripts/${topo.id === "cxgates" ? "ship" : topo.id}` : `.claude/skills/${topo.id}/scripts`;
  const hooks = HOOKS.filter((h) => fs.existsSync(path.join(root, dir, h))).map((h) => ({ hook: h, script: path.join(root, dir, h) }));
  return { root, hooks };
}

/**
 * Run one hook on one payload the way the host does (a shell, a subfolder as the current directory, the
 * payload on stdin; CLAUDE_PROJECT_DIR set for Claude Code only). Resolves to { code, stderr }; code is
 * null on a timeout or a signal.
 */
export function runHook(script, root, binding, payload, PATH) {
  return new Promise((resolve) => {
    const env = { PATH, HOME: os.tmpdir(), LANG: "C.UTF-8" };
    if (binding === "claude-code") env.CLAUDE_PROJECT_DIR = root;
    const child = spawn("bash", [script], { cwd: path.join(root, "src/deep"), env: { ...env }, stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.on("error", () => { clearTimeout(timer); resolve({ code: null, stderr }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stderr }); });
    child.stdin.on("error", () => {});
    child.stdin.end(payload);
  });
}

/**
 * Scaffold an `if:` topology for Codex into a fresh git repository, its hook's script made to refuse;
 * return the root and the hooks.json command of its one PreToolUse hook (which runs at-if.sh).
 */
export function scaffoldIf(lib, topo) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `at-hooks-${topo.id}-`));
  spawnSync("git", ["init", "-q", root]);
  for (const f of lib.bindings.codex.scaffold(lib.parse(topo.src()))) {
    const p = path.join(root, f.path);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, f.content);
    if (f.executable) fs.chmodSync(p, 0o755);
  }
  if (topo.script) fs.writeFileSync(path.join(root, topo.script), "#!/usr/bin/env bash\necho 'refused by hook' >&2\nexit 2\n", { mode: 0o755 });
  const command = JSON.parse(fs.readFileSync(path.join(root, ".codex/hooks.json"), "utf8")).hooks.PreToolUse[0].hooks[0].command;
  if (!command.includes("at-if.sh")) throw new Error(`${topo.id}: the hook does not run through at-if.sh`);
  return { root, command };
}

/** Run a hooks.json command the way Codex does: sh -c from the project root, the payload on stdin. */
export function runCommand(command, root, payload, PATH) {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], { cwd: root, env: { PATH, HOME: os.tmpdir(), LANG: "C.UTF-8" }, stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("error", () => { clearTimeout(timer); resolve({ code: null, stderr }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stderr }); });
    child.stdin.on("error", () => {});
    child.stdin.end(payload);
  });
}

/**
 * Every pair: { topology, binding, hook, input, jq, exit }. at-if.sh pairs (the `if:` topologies) have
 * hook "at-if.sh" and the same Bash inputs as before-action.sh. `lib` is { parse, bindings: { "claude-code", codex } }.
 * `only` keeps the pairs a filter accepts (for a quick partial run).
 */
export async function runCorpus(lib, { concurrency = Math.max(4, os.cpus().length), only } = {}) {
  const paths = toolPaths();
  if (!paths.hasJq) throw new Error("jq is not installed: the hook corpus needs it");
  const jobs = [];
  for (const topo of TOPOLOGIES) {
    for (const binding of topo.bindings) {
      const { root, hooks } = scaffoldOne(lib, topo, binding);
      for (const { hook, script } of hooks) {
        for (const { input, payload } of inputsFor(hook, binding)) {
          for (const jq of [true, false]) {
            const row = { topology: topo.id, binding, hook, input, jq };
            if (only && !only(row)) continue;
            jobs.push({ row, script, root, payload, PATH: jq ? paths.jq : paths.nojq });
          }
        }
      }
    }
  }
  for (const topo of IF_TOPOLOGIES) {
    const { root, command } = scaffoldIf(lib, topo);
    for (const { input, payload } of inputsFor("before-action.sh", "codex")) {
      for (const jq of [true, false]) {
        const row = { topology: topo.id, binding: "codex", hook: "at-if.sh", input, jq };
        if (only && !only(row)) continue;
        jobs.push({ row, command, root, payload, PATH: jq ? paths.jq : paths.nojq });
      }
    }
  }
  const out = new Array(jobs.length);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++;
      const j = jobs[i];
      const r = j.command ? await runCommand(j.command, j.root, j.payload, j.PATH) : await runHook(j.script, j.root, j.row.binding, j.payload, j.PATH);
      out[i] = { ...j.row, exit: r.code };
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return out;
}

/** The key of a pair, for maps and messages. */
export const pairKey = (r) => `${r.topology}|${r.binding}|${r.hook}|${r.jq ? "jq" : "nojq"}|${r.input}`;
