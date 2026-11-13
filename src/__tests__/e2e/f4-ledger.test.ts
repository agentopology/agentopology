/**
 * [F-4] Known gap, narrowed: the agent can write a gate's ledger.
 *
 * A gate's ledger (`records { record trace { path: "logs/{unit}/trace.jsonl" } }`)
 * and Codex's approval record (`.codex/state/approvals.jsonl`) are files in the
 * workspace. The guards trust an ok line in them, and the agent could write one.
 * Until the signed gate, the generated guards refuse a Bash command or a file
 * edit that names one of those files (reading it stays allowed), on both
 * targets, and guard --check says so on the grade line itself.
 *
 * The scripts run the way each host runs a hook: a shell, a subfolder as the
 * current directory, the event's JSON on stdin; CLAUDE_PROJECT_DIR set on
 * Claude Code, no variable on Codex.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../parser/index.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";
import { codexBinding } from "../../bindings/codex.js";
import { checkGuards, renderGuardReport } from "../../guard/check.js";
import { checkCodexGuards } from "../../guard/check-codex.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "fixtures/codex-gates.at");
const SRC = fs.readFileSync(FIXTURE, "utf8");
const hasJq = spawnSync("/bin/sh", ["-c", "command -v jq"]).status === 0;
const NOTE = "ledger agent-writable until the signed gate";

type Target = "claude-code" | "codex";
const TARGETS: Target[] = ["claude-code", "codex"];
const DIR: Record<Target, string> = { "claude-code": ".claude/skills/ship/scripts", codex: ".codex/scripts/ship" };

let root: string;
const at = (p: string) => join(root, p);

function scaffold(target: Target, src = SRC) {
  const ast = parse(src);
  const files = (target === "codex" ? codexBinding : claudeCodeBinding).scaffold(ast);
  for (const f of files) {
    fs.mkdirSync(dirname(at(f.path)), { recursive: true });
    fs.writeFileSync(at(f.path), f.content);
    if (f.executable) fs.chmodSync(at(f.path), 0o755);
  }
  fs.mkdirSync(at("src/deep"), { recursive: true });
  return { ast, files };
}

/** Run a generated guard the way its host runs a hook. */
function hook(target: Target, file: string, stdin: string) {
  const env = { ...process.env } as Record<string, string>;
  if (target === "claude-code") env.CLAUDE_PROJECT_DIR = root;
  else delete env.CLAUDE_PROJECT_DIR;
  return spawnSync("/bin/sh", ["-c", `bash "${root}/${DIR[target]}/${file}"`], {
    cwd: at("src/deep"), input: stdin, env, encoding: "utf8", timeout: 20_000,
  });
}
const bash = (command: string) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
const write = (file_path: string) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path, content: "{}" } });
const patch = (body: string) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { command: `*** Begin Patch\n${body}\n*** End Patch\n` } });

beforeEach(() => { root = fs.mkdtempSync(join(os.tmpdir(), "at-f4-")); spawnSync("git", ["init", "-q", root]); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const REFUSED = [
  "echo '{\"step\":\"render\",\"unit\":\"ep1\",\"ok\":true}' >> logs/ep1/trace.jsonl",
  "echo x | tee -a logs/ep1/trace.jsonl",
  "cp /tmp/forged logs/ep1/trace.jsonl",
  "python3 -c 'open(\"logs/ep1/trace.jsonl\",\"a\").write(\"x\")'",
  "sed -i 's/false/true/' logs/ep1/trace.jsonl",
  "printf '%s\\n' x > logs/ep1/tr\"\"ace.jsonl",
  "f=trace.jsonl; echo x >> logs/ep1/$f",
];
const ALLOWED = ["cat logs/ep1/trace.jsonl", "jq . logs/ep1/trace.jsonl", "ls src", "echo hello > out.txt"];

describe.skipIf(!hasJq)("[F-4] before-action.sh refuses a command that writes a gate ledger", () => {
  for (const target of TARGETS) {
    for (const cmd of REFUSED) {
      it(`[F-4] ${target}: refuses ${cmd}`, () => {
        scaffold(target);
        const r = hook(target, "before-action.sh", bash(cmd));
        expect(r.status, r.stderr).toBe(2);
        expect(r.stderr).toContain("the command touches the gate ledger logs/{unit}/trace.jsonl; only the gate's own step writes it");
      });
    }
    for (const cmd of ALLOWED) {
      it(`[F-4] ${target}: lets ${cmd} run`, () => {
        scaffold(target);
        const r = hook(target, "before-action.sh", bash(cmd));
        expect(r.status, r.stderr).toBe(0);
      });
    }
  }

  it("[F-4] codex: refuses a command that writes the approvals file, lets one that reads it run", () => {
    scaffold("codex");
    const w = hook("codex", "before-action.sh", bash(`echo '{"step":"approve","ok":true}' >> .codex/state/approvals.jsonl`));
    expect(w.status, w.stderr).toBe(2);
    expect(w.stderr).toContain("the gate ledger .codex/state/approvals.jsonl");
    expect(hook("codex", "before-action.sh", bash("cat .codex/state/approvals.jsonl")).status).toBe(0);
  });

  it("[F-4] a topology with a ledger but no guarded step still gets the check (codex: a human step alone too)", () => {
    // render-check's ledger, before an agent: no script step is guarded.
    const ledgerOnly = SRC.replace("before: publish\n      ledger: trace", "before: editor\n      ledger: trace");
    for (const target of TARGETS) {
      const { files } = scaffold(target, ledgerOnly);
      expect(files.some((f) => f.path === `${DIR[target]}/before-action.sh`), target).toBe(true);
      expect(hook(target, "before-action.sh", bash("echo x >> logs/ep1/trace.jsonl")).status, target).toBe(2);
      expect(hook(target, "before-action.sh", bash("ls")).status, target).toBe(0);
    }
    const humanOnly = `topology solo : [pipeline] {
  meta { version: "1.0.0" description: "Approve, then edit" }
  orchestrator { model: gpt-5.2 handles: [editor] }
  human approve { description: "A person approves" }
  agent editor { model: gpt-5.2 description: "Edits" }
  flow { approve -> editor }
}
`;
    const files = codexBinding.scaffold(parse(humanOnly));
    const ba = files.find((f) => f.path === ".codex/scripts/solo/before-action.sh");
    expect(ba).toBeTruthy();
    expect(ba!.content).toContain(".codex/state/approvals.jsonl");
    const hooks = JSON.parse(files.find((f) => f.path === ".codex/hooks.json")!.content).hooks;
    expect(hooks.PreToolUse.some((e: { matcher: string; hooks: Array<{ command: string }> }) => e.matcher === "Bash" && e.hooks[0].command.includes("before-action.sh"))).toBe(true);
  });
});

describe.skipIf(!hasJq)("[F-4] before-edit.sh refuses a file edit of a gate ledger", () => {
  it("[F-4] claude-code: registered on the edit tools with onFailure block", () => {
    scaffold("claude-code");
    const pre = JSON.parse(fs.readFileSync(at(".claude/settings.json"), "utf8")).hooks.PreToolUse as Array<{ matcher: string; hooks: Array<{ command: string; onFailure?: string }> }>;
    const e = pre.find((x) => x.hooks[0].command.includes("before-edit.sh"));
    expect(e).toBeTruthy();
    expect(e!.matcher).toBe("Write|Edit|MultiEdit|NotebookEdit");
    expect(e!.hooks[0].onFailure).toBe("block");
  });

  it("[F-4] claude-code: Write to logs/ep1/trace.jsonl is refused, Write to src/x.ts runs", () => {
    scaffold("claude-code");
    const r = hook("claude-code", "before-edit.sh", write(at("logs/ep1/trace.jsonl")));
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toContain("logs/{unit}/trace.jsonl");
    expect(hook("claude-code", "before-edit.sh", write(at("logs/ep1/../ep2/trace.jsonl"))).status).toBe(2);
    expect(hook("claude-code", "before-edit.sh", write("logs/ep3/trace.jsonl")).status).toBe(2);
    expect(hook("claude-code", "before-edit.sh", JSON.stringify({ tool_name: "NotebookEdit", tool_input: { notebook_path: at("x/trace.jsonl") } })).status).toBe(2);
    const ok = hook("claude-code", "before-edit.sh", write(at("src/x.ts")));
    expect(ok.status, ok.stderr).toBe(0);
  });

  it("[F-4] codex: registered on apply_patch", () => {
    scaffold("codex");
    const pre = JSON.parse(fs.readFileSync(at(".codex/hooks.json"), "utf8")).hooks.PreToolUse as Array<{ matcher: string; hooks: Array<{ command: string }> }>;
    const e = pre.find((x) => x.hooks[0].command.includes("before-edit.sh"));
    expect(e).toBeTruthy();
    expect(e!.matcher).toBe("apply_patch");
  });

  it("[F-4] codex: a patch adding logs/ep9/trace.jsonl is refused, a patch to README.md runs, a Move to the ledger is refused", () => {
    scaffold("codex");
    const add = hook("codex", "before-edit.sh", patch(`*** Add File: ${at("logs/ep9/trace.jsonl")}\n+{"step":"render","ok":true}`));
    expect(add.status, add.stderr).toBe(2);
    expect(add.stderr).toContain("logs/{unit}/trace.jsonl");
    const readme = hook("codex", "before-edit.sh", patch(`*** Update File: ${at("README.md")}\n@@\n-a\n+b`));
    expect(readme.status, readme.stderr).toBe(0);
    const move = hook("codex", "before-edit.sh", patch(`*** Update File: ${at("notes.txt")}\n*** Move to: logs/ep1/trace.jsonl\n@@\n-a\n+b`));
    expect(move.status, move.stderr).toBe(2);
    const appr = hook("codex", "before-edit.sh", patch(`*** Add File: ${at(".codex/state/approvals.jsonl")}\n+{"step":"approve","ok":true}`));
    expect(appr.status, appr.stderr).toBe(2);
  });

  for (const target of TARGETS) {
    it(`[F-4] ${target}: empty or bad stdin blocks (exit 2)`, () => {
      scaffold(target);
      expect(hook(target, "before-edit.sh", "").status).toBe(2);
      expect(hook(target, "before-edit.sh", "not json").status).toBe(2);
    });
  }
});

describe("[F-4] guard --check says the ledger is agent-writable on the grade line", () => {
  it("[F-4] claude-code: the ledger gate reads `refuse (Bash), unverified (PowerShell: not measured), ledger agent-writable until the signed gate`", () => {
    const { ast } = scaffold("claude-code");
    const lines = renderGuardReport(checkGuards(ast, root));
    const line = lines.find((l) => /^\s+gate publish-ready\s/.test(l))!;
    expect(line).toContain(`refuse (Bash), unverified (PowerShell: not measured)`);
    expect(line).toContain(`, ${NOTE}`);
    // A gate with no ledger keeps its plain grade.
    expect(lines.find((l) => /^\s+gate render-check\s/.test(l))!).not.toContain(NOTE);
  });

  it("[F-4] codex: the ledger gate and the human step read `unverified, ledger agent-writable until the signed gate`", () => {
    const { ast } = scaffold("codex");
    const lines = renderGuardReport(checkCodexGuards(ast, root));
    expect(lines.find((l) => /^\s+gate publish-ready\s/.test(l))!).toContain(`unverified, ${NOTE}`);
    expect(lines.find((l) => /^\s+human approve\s/.test(l))!).toContain(`unverified, ${NOTE}`);
    expect(lines.find((l) => /^\s+gate render-check\s/.test(l))!).not.toContain(NOTE);
  });

  it("[F-4] the generated docs carry the note on the Enforcement line", () => {
    const cx = scaffold("codex").files.find((f) => f.path === "AGENTS.md")!.content;
    expect(cx).toMatch(new RegExp(`Enforcement:\\*\\* unverified, ${NOTE}`));
    // The gate and the human step each carry it.
    expect(cx.split(`**Enforcement:** unverified, ${NOTE}`).length - 1).toBe(2);
    expect(cx).not.toMatch(/Enforcement:\*\* unverified, ledger[^\n]*render-check\.sh/);
    const cc = scaffold("claude-code").files.map((f) => f.content).join("\n");
    expect(cc).toContain(`refuse (Bash), unverified (PowerShell: not measured), ${NOTE}`);
  });
});

describe.skipIf(!hasJq)("[F-4] the ledger guard never runs the ledger path as code", () => {
  const unitFile = SRC.replace('record trace { path: "logs/{unit}/trace.jsonl" }', 'record trace { path: "logs/{unit}.jsonl" }');
  it.each(TARGETS)("[F-4] %s: a {unit} file name refuses that ledger only, not every .jsonl edit or command", (target) => {
    scaffold(target, unitFile);
    expect(hook(target, "before-edit.sh", write(at("logs/ep1.jsonl"))).status).toBe(2);
    expect(hook(target, "before-edit.sh", write(at("data/other.jsonl"))).status).toBe(0);
    expect(hook(target, "before-action.sh", bash("echo x >> data/other.jsonl")).status).toBe(0);
    expect(hook(target, "before-action.sh", bash("echo x >> logs/ep1.jsonl")).status).toBe(2);
  });
  it.each(TARGETS)("[F-4] %s: the generated guards hold no eval and paste no ledger pattern into a case", (target) => {
    scaffold(target);
    for (const f of ["before-action.sh", "before-edit.sh"]) {
      const body = fs.readFileSync(at(`${DIR[target]}/${f}`), "utf8");
      expect(body, f).not.toMatch(/(^|[;&|{(]\s*|\bthen\s+|\bdo\s+)eval\s/m);
      expect(body, f).not.toMatch(/case "[^"]*" in logs\//);
    }
  });
});
