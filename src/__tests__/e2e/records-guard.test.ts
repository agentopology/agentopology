/**
 * [SP-7] Generated record guards (Spec B, pieces 1 and 2).
 *
 * A record is a file only its `written-by` programs write. The 0.11.0 ledger
 * guards are extended so a declared record is protected the same way:
 * before-edit.sh refuses a file-writing tool on it (the tool list comes from
 * the conformance facts), before-action.sh refuses a shell command that names
 * it and does more than read it, unless the command runs one of its
 * `written-by` programs. Both fail closed.
 *
 * The scripts run the way each host runs a hook: a shell, the event's JSON on
 * stdin; CLAUDE_PROJECT_DIR set on Claude Code, no variable on Codex.
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
import { FILE_WRITE_TOOLS, fileWriteMatcher } from "../../conformance/claude-code.js";
import { extractFileWriteTools } from "../../conformance/extract.js";
import { RECORD_BYPASS_LINE, guardedRecords, recordWaysIn } from "../../records/guard.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "fixtures/records/guards/topology.at");
const SRC = fs.readFileSync(FIXTURE, "utf8");
const hasJq = spawnSync("/bin/sh", ["-c", "command -v jq"]).status === 0;

type Target = "claude-code" | "codex";
const DIR: Record<Target, string> = {
  "claude-code": ".claude/skills/records-guards/scripts",
  codex: ".codex/scripts/records-guards",
};

let root: string;
const at = (p: string) => join(root, p);

function scaffold(target: Target, src = SRC) {
  // Codex runs no Claude model: the same topology on a Codex model.
  const ast = parse(target === "codex" ? src.replace(/model: sonnet/g, "model: gpt-5.2") : src);
  const files = (target === "codex" ? codexBinding : claudeCodeBinding).scaffold(ast);
  for (const f of files) {
    fs.mkdirSync(dirname(at(f.path)), { recursive: true });
    fs.writeFileSync(at(f.path), f.content);
    if (f.executable) fs.chmodSync(at(f.path), 0o755);
  }
  return { ast, files };
}

/** Run a generated guard the way its host runs a hook, from `cwd` (project-relative). */
function hook(target: Target, file: string, stdin: string, cwd = ".") {
  const env = { ...process.env } as Record<string, string>;
  if (target === "claude-code") env.CLAUDE_PROJECT_DIR = root;
  else delete env.CLAUDE_PROJECT_DIR;
  fs.mkdirSync(at(cwd), { recursive: true });
  return spawnSync("/bin/sh", ["-c", `bash "${root}/${DIR[target]}/${file}"`], {
    cwd: at(cwd), input: stdin, env, encoding: "utf8", timeout: 20_000,
  });
}
const bash = (command: string) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
const tool = (tool_name: string, file_path: string) =>
  JSON.stringify({ hook_event_name: "PreToolUse", tool_name, tool_input: tool_name === "NotebookEdit" ? { notebook_path: file_path, new_source: "x" } : { file_path, old_string: "a", new_string: "b", content: "{}" } });
const patch = (body: string) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { command: `*** Begin Patch\n${body}\n*** End Patch\n` } });

beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "at-sp7-"))); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe.skipIf(!hasJq)("[SP-7][B4] before-edit.sh refuses a file-writing tool on a record", () => {
  it("[SP-7][B4] Edit on records/approvals.jsonl exits 2", () => {
    scaffold("claude-code");
    const r = hook("claude-code", "before-edit.sh", tool("Edit", "records/approvals.jsonl"));
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toContain("the edit touches the record approvals (records/approvals.jsonl); only its written-by programs write it (scripts/approve.py)");
  });

  it("[SP-7][B4] Edit on README.md exits 0", () => {
    scaffold("claude-code");
    const r = hook("claude-code", "before-edit.sh", tool("Edit", "README.md"));
    expect(r.status, r.stderr).toBe(0);
  });

  it("[SP-7][B4] Write on work/abc/trace.jsonl (the {unit} form) exits 2", () => {
    scaffold("claude-code");
    const r = hook("claude-code", "before-edit.sh", tool("Write", "work/abc/trace.jsonl"));
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toContain("the record trace");
  });

  it("[SP-7][B4] the path written as ./records/../records/approvals.jsonl exits 2", () => {
    scaffold("claude-code");
    const r = hook("claude-code", "before-edit.sh", tool("Edit", "./records/../records/approvals.jsonl"));
    expect(r.status, r.stderr).toBe(2);
  });

  it("[SP-7][B4] empty stdin exits 2", () => {
    scaffold("claude-code");
    const r = hook("claude-code", "before-edit.sh", "");
    expect(r.status, r.stderr).toBe(2);
  });

  it("[SP-7][B4] an absolute path (what Claude Code sends), MultiEdit, NotebookEdit and a capitalised path exit 2", () => {
    scaffold("claude-code");
    expect(hook("claude-code", "before-edit.sh", tool("Write", `${root}/records/approvals.jsonl`), "src").status).toBe(2);
    expect(hook("claude-code", "before-edit.sh", tool("MultiEdit", `${root}/records/approvals.jsonl`)).status).toBe(2);
    expect(hook("claude-code", "before-edit.sh", tool("NotebookEdit", `${root}/work/u1/trace.jsonl`)).status).toBe(2);
    expect(hook("claude-code", "before-edit.sh", tool("Edit", `${root}/Records/APPROVALS.jsonl`)).status).toBe(2);
  });

  it("[SP-7][B4] input that is not JSON, or has no path, exits 2", () => {
    scaffold("claude-code");
    expect(hook("claude-code", "before-edit.sh", "not json").status).toBe(2);
    expect(hook("claude-code", "before-edit.sh", JSON.stringify({ tool_name: "Edit", tool_input: {} })).status).toBe(2);
  });

  it("[SP-7][B4] the record head files under .agentopology/records/ are refused too (piece 3 rests on them)", () => {
    scaffold("claude-code");
    const r = hook("claude-code", "before-edit.sh", tool("Write", `${root}/.agentopology/records/approvals.head`));
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toContain(".agentopology/records");
  });

  it("[SP-7][B4] a record with no written-by gets no guard; a record with guard: cited gets none either (piece 5)", () => {
    scaffold("claude-code");
    expect(hook("claude-code", "before-edit.sh", tool("Edit", "records/notes.jsonl")).status).toBe(0);
    expect(hook("claude-code", "before-edit.sh", tool("Edit", "records/cited.jsonl")).status).toBe(0);
    expect(guardedRecords(parse(SRC)).map((r) => r.id)).toEqual(["approvals", "trace"]);
  });

  it("[SP-7][B4] settings.json wires before-edit.sh on the file-writing tools of the conformance facts, onFailure block", () => {
    scaffold("claude-code");
    const pre = JSON.parse(fs.readFileSync(at(".claude/settings.json"), "utf8")).hooks.PreToolUse as Array<{ matcher: string; hooks: Array<{ command: string; onFailure?: string }> }>;
    const e = pre.find((x) => x.hooks[0].command.includes("before-edit.sh"));
    expect(e).toBeTruthy();
    expect(e!.matcher).toBe(fileWriteMatcher());
    for (const t of FILE_WRITE_TOOLS) expect(e!.matcher.split("|")).toContain(t);
    expect(e!.hooks[0].onFailure).toBe("block");
  });

  it("[SP-7][B4] codex: an apply_patch that adds, updates or moves onto a record exits 2; another file exits 0", () => {
    scaffold("codex");
    expect(hook("codex", "before-edit.sh", patch("*** Update File: records/approvals.jsonl\n@@\n-a\n+b")).status).toBe(2);
    expect(hook("codex", "before-edit.sh", patch("*** Add File: work/u9/trace.jsonl\n+x")).status).toBe(2);
    expect(hook("codex", "before-edit.sh", patch("*** Update File: notes.md\n*** Move to: records/approvals.jsonl\n@@\n-a\n+b")).status).toBe(2);
    expect(hook("codex", "before-edit.sh", patch("*** Add File: README.md\n+x")).status).toBe(0);
  });
});

/** The 8 shell write shapes of B5, on the approvals record. */
const B5_REFUSED = [
  "echo '{\"ok\":true}' > records/approvals.jsonl",
  "echo '{\"ok\":true}' >> records/approvals.jsonl",
  "echo x | tee records/approvals.jsonl",
  "echo x | tee -a records/approvals.jsonl",
  "sed -i 's/false/true/' records/approvals.jsonl",
  "cp /tmp/forged records/approvals.jsonl",
  "mv /tmp/forged records/approvals.jsonl",
  "truncate -s 0 records/approvals.jsonl",
];
const B5_ALLOWED = [
  "python3 scripts/approve.py --record records/approvals.jsonl",
  "cat records/approvals.jsonl",
  "cat <<'EOF'\nthe approvals live in records/approvals.jsonl\nEOF",
];
/** Shapes around the three allowed ones that must still be refused. */
const EDGE_REFUSED = [
  "python3 scripts/approve.py; echo x >> records/approvals.jsonl",
  "python3 -c 'open(\"records/approvals.jsonl\",\"a\")' scripts/approve.py",
  "/tmp/x/scripts/approve.py records/approvals.jsonl",
  "scripts/approve.py records/approvals.jsonl > records/approvals.jsonl",
  "cat <<'EOF' > records/approvals.jsonl\n{\"ok\":true}\nEOF",
  "bash <<'EOF'\necho x >> records/approvals.jsonl\nEOF",
  "cat <<'EOF' | bash\necho x >> records/approvals.jsonl\nEOF",
  "f=approvals.jsonl; echo x >> records/$f",
  "echo x >> work/u1/trace.jsonl",
  "echo x >> records/APPROVALS.jsonl",
];
const EDGE_ALLOWED = [
  "./scripts/approve.py records/approvals.jsonl",
  "python3 -u scripts/trace.py work/u1/trace.jsonl",
  "cat <<'EOF' > notes.md\nsee records/approvals.jsonl\nEOF",
  "git commit -m 'records/approvals.jsonl grew' 2>&1",
  "echo hello > out.txt",
  "ls records",
];

describe.skipIf(!hasJq)("[SP-7][B5] before-action.sh refuses a shell write to a record", () => {
  for (const cmd of B5_REFUSED) {
    it(`[SP-7][B5] refuses ${cmd}`, () => {
      scaffold("claude-code");
      const r = hook("claude-code", "before-action.sh", bash(cmd));
      expect(r.status, r.stderr).toBe(2);
      expect(r.stderr).toContain("the command touches the record approvals (records/approvals.jsonl); only its written-by programs write it (scripts/approve.py)");
    });
  }
  for (const cmd of B5_ALLOWED) {
    it(`[SP-7][B5] allows ${cmd.replace(/\n/g, "\\n")}`, () => {
      scaffold("claude-code");
      const r = hook("claude-code", "before-action.sh", bash(cmd));
      expect(r.status, r.stderr).toBe(0);
    });
  }
  for (const cmd of EDGE_REFUSED) {
    it(`[SP-7][B5] still refuses ${cmd.replace(/\n/g, "\\n")}`, () => {
      scaffold("claude-code");
      const r = hook("claude-code", "before-action.sh", bash(cmd));
      expect(r.status, r.stderr).toBe(2);
    });
  }
  for (const cmd of EDGE_ALLOWED) {
    it(`[SP-7][B5] still allows ${cmd.replace(/\n/g, "\\n")}`, () => {
      scaffold("claude-code");
      const r = hook("claude-code", "before-action.sh", bash(cmd));
      expect(r.status, r.stderr).toBe(0);
    });
  }

  it("[SP-7][B5] the record with no written-by and the cited record are not checked by the generated shell guard", () => {
    scaffold("claude-code");
    expect(hook("claude-code", "before-action.sh", bash("echo x >> records/notes.jsonl")).status).toBe(0);
    expect(hook("claude-code", "before-action.sh", bash("echo x >> records/cited.jsonl")).status).toBe(0);
  });

  it("[SP-7][B5] settings.json wires before-action.sh on Bash with onFailure block, though no gate exists", () => {
    scaffold("claude-code");
    const pre = JSON.parse(fs.readFileSync(at(".claude/settings.json"), "utf8")).hooks.PreToolUse as Array<{ matcher: string; hooks: Array<{ command: string; onFailure?: string }> }>;
    const e = pre.find((x) => x.hooks[0].command.includes("before-action.sh"));
    expect(e?.matcher).toBe("Bash");
    expect(e?.hooks[0].onFailure).toBe("block");
  });

  it("[SP-7][B5] codex: the same 8 shapes are refused and the 3 allowed pass", () => {
    scaffold("codex");
    for (const cmd of B5_REFUSED) expect(hook("codex", "before-action.sh", bash(cmd)).status, cmd).toBe(2);
    for (const cmd of B5_ALLOWED) expect(hook("codex", "before-action.sh", bash(cmd)).status, cmd).toBe(0);
  });
});

describe.skipIf(!hasJq)("[SP-7][B6] the honesty test: what the shell guard cannot see is said", () => {
  const ONE_LINER = `python3 -c 'p="records/approvals"; open(p+".jsonl","a").write("x")'`;

  it("[SP-7][B6] an interpreter one-liner that builds the path from two strings passes the guard", () => {
    scaffold("claude-code");
    const r = hook("claude-code", "before-action.sh", bash(ONE_LINER));
    expect(r.status, r.stderr).toBe(0);
  });

  it("[SP-7][B6] the ways into each guarded record end with the bypass line, word for word", () => {
    expect(RECORD_BYPASS_LINE).toBe("a program running as the same OS user can still write this file; only a signature or another OS user closes that");
    for (const rec of guardedRecords(parse(SRC))) {
      const ways = recordWaysIn(rec);
      expect(ways.map((w) => w.way)).toEqual([
        "a file-writing tool",
        "a shell command that names the path",
        "a shell command that builds the path at run time, an interpreter one-liner, a script an agent wrote",
        "a process outside Claude Code (a scheduler, a terminal)",
        "a rewrite found later by record check",
      ]);
      expect(ways.find((w) => w.way.startsWith("a file-writing tool"))!.grade).toBe("refuse, by hook");
      expect(ways.find((w) => w.way === "a shell command that names the path")!.grade).toBe("detect");
      expect(ways.find((w) => w.way.startsWith("a rewrite"))!.grade).toBe("detect, by code");
      expect(ways.filter((w) => w.grade === "none").every((w) => w.note === RECORD_BYPASS_LINE)).toBe(true);
      expect(ways.map((w) => w.note).join("\n")).not.toMatch(/\bprotected\b/);
    }
  });
});

describe("[SP-7] the file-writing tools come from the conformance facts", () => {
  const PAGE = [
    "| Rule format | Applies to | Details |",
    "| :- | :- | :- |",
    "| `Bash(npm run *)` | Bash, Monitor | [Command pattern matching](x) |",
    "| `Read(~/secrets/**)` | Read, Grep, Glob, LSP | [Path pattern matching](x) |",
    "| `Edit(/src/**)` | Edit, Write, NotebookEdit | [Path pattern matching](x) |",
    "| `WebSearch` | WebSearch | No specifier |",
  ].join("\n");

  it("[SP-7] the tools reference's Edit(...) row is read as the file-writing tools", () => {
    expect(extractFileWriteTools(PAGE)).toEqual(["Edit", "Write", "NotebookEdit"]);
    expect(extractFileWriteTools("no table here")).toEqual([]);
  });

  it("[SP-7] the snapshot of the tools page is held by the facts: every tool it lists is in FILE_WRITE_TOOLS", () => {
    const snap = JSON.parse(fs.readFileSync(resolve(here, "../../../spec/claude-code/tools-contract.json"), "utf8"));
    expect(snap.fileWriteTools.length).toBeGreaterThan(0);
    for (const t of snap.fileWriteTools) expect(FILE_WRITE_TOOLS).toContain(t);
    expect(fileWriteMatcher().split("|").sort()).toEqual([...FILE_WRITE_TOOLS].sort());
  });
});
