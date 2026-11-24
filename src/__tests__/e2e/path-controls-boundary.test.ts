/**
 * S-203: `boundary <id> { path, in, out, outbound }`. The generated before-boundary.sh is run the way
 * Claude Code runs a hook: a shell, the event's JSON on stdin, CLAUDE_PROJECT_DIR set. It is a text check
 * (weaker than the Edit permission rule written beside it); these rows say what it refuses and, as
 * important, what ordinary work it lets through.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { parse } from "../../parser/index.js";
import { claudeCodeBinding } from "../../bindings/claude-code.js";

const hasJq = spawnSync("/bin/sh", ["-c", "command -v jq"]).status === 0;
const SCRIPT = ".claude/skills/bt/scripts/before-boundary.sh";

let root: string;
let home: string;
const at = (p: string) => join(root, p);

const head = `topology bt : [pipeline] {
  orchestrator {
    model: opus
    handles: [a]
  }
  action a { kind: inline }
  agent worker { model: opus }
  flow { a -> worker }
`;

function setup(boundaries: string, branch?: string) {
  const files = claudeCodeBinding.scaffold(parse(`${head}  ${boundaries}\n}`));
  for (const f of files) {
    fs.mkdirSync(dirname(at(f.path)), { recursive: true });
    fs.writeFileSync(at(f.path), f.content);
    if (f.executable) fs.chmodSync(at(f.path), 0o755);
  }
  fs.mkdirSync(at("src/deep"), { recursive: true });
  spawnSync("git", ["-C", root, "checkout", "-q", "-b", branch ?? "feature-x"]);
}

function hook(input: object, cwd = root) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: root, HOME: home } as Record<string, string>;
  return spawnSync("/bin/sh", ["-c", `bash "${at(SCRIPT)}"`], {
    cwd, input: JSON.stringify({ hook_event_name: "PreToolUse", ...input }), env, encoding: "utf8", timeout: 20_000,
  });
}
const tool = (tool_name: string, file_path: string) => hook({ tool_name, tool_input: { file_path } });
const bash = (command: string, cwd = root) => hook({ tool_name: "Bash", tool_input: { command } }, cwd);

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "at-bd-")));
  home = join(root, "fakehome");
  fs.mkdirSync(home, { recursive: true });
  spawnSync("git", ["init", "-q", root]);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe.skipIf(!hasJq)("S-203 in: read-only", () => {
  beforeEach(() => setup(`boundary v { path: "vendor/**", in: read-only }
  boundary h { path: "~/shared/**", in: read-only }`));

  it("refuses Edit, Write, MultiEdit and NotebookEdit of the path, relative or absolute", () => {
    for (const t of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) {
      expect(tool(t, at("vendor/lib/a.js")).status, t).toBe(2);
    }
    expect(tool("Write", "vendor/x.txt").status).toBe(2);
    expect(hook({ tool_name: "Write", tool_input: { file_path: "../../vendor/x.txt" } }, at("src/deep")).status).toBe(2);
    expect(tool("Edit", join(home, "shared/notes.md")).status).toBe(2);
  });
  it("names the boundary and the path on stderr", () => {
    const r = tool("Write", "vendor/x.txt");
    expect(r.stderr).toContain("v");
    expect(r.stderr).toContain("vendor/**");
  });
  it("refuses a Bash command that writes it", () => {
    for (const c of [
      "echo x > vendor/a.js", "echo x >> vendor/a.js", "echo x>vendor/a.js", "tee vendor/a.js", "cp src/a.js vendor/a.js",
      "mv vendor/a.js /tmp/z", "rm -rf vendor", "rm vendor/a.js", "touch vendor/new", "sed -i s/a/b/ vendor/a.js",
      "echo x > ~/shared/a.txt", "rm $HOME/shared/a.txt", "git status; rm vendor/a.js",
    ]) {
      expect(bash(c).status, c).toBe(2);
    }
  });
  it("lets ordinary commands and reads through (must-pass)", () => {
    for (const c of [
      "git status", "git commit -m 'update vendor'", "npm test", "ls", "ls vendor", "grep x src", "grep -r x vendor", "cat vendor/a.js",
      "cp vendor/a.js src/copy.js", "head vendor/a.js | wc -l", "diff vendor/a.js src/a.js", "echo x > src/a.txt", "rm src/a.js",
      "sed -i s/a/b/ src/a.js", "sed -n 1p vendor/a.js", 'claude -p --agent x "summarize the logs"', 'gh pr create --body "touch vendor/a.js"',
      "for f in a b; do echo $f; done", "git push origin feature-x", "ls ~/shared", "cat ~/shared/a.txt", "echo x > vendored/a.txt",
    ]) {
      expect(bash(c).status, c).toBe(0);
    }
  });
  it("lets edits of other files through", () => {
    for (const t of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) expect(tool(t, at("src/a.ts")).status, t).toBe(0);
    expect(tool("Write", at("vendored/a.txt")).status).toBe(0);
    expect(tool("Write", join(home, "other/a.txt")).status).toBe(0);
    expect(hook({ tool_name: "Read", tool_input: { file_path: at("vendor/a.js") } }).status).toBe(0);
  });
  it("blocks input it cannot read", () => {
    const r = spawnSync("/bin/sh", ["-c", `bash "${at(SCRIPT)}"`], { cwd: root, input: "not json", env: { ...process.env, CLAUDE_PROJECT_DIR: root }, encoding: "utf8" });
    expect(r.status).toBe(2);
  });
});

describe.skipIf(!hasJq)("S-203 out: pr", () => {
  beforeEach(() => setup(`boundary r { path: ".", out: pr }`));

  it("refuses a push to main or master, by any spelling of the refspec", () => {
    for (const c of [
      "git push origin main", "git push origin master", "git push -u origin main", "git push origin HEAD:main", "git push origin HEAD:refs/heads/main",
      "git push origin feature-x:main", "git push origin +main", "git push --force origin main", "git push origin :main", "git push --delete origin main",
      "git -C . push origin main", "git -c user.name=x push origin main", "git push origin main feature-x", "git push --all origin", "git push --mirror",
      "git status && git push origin main", "git push origin refs/heads/master", "git push upstream main",
    ]) {
      expect(bash(c).status, c).toBe(2);
    }
  });
  it("refuses a bare git push while on main, and names gh pr create", () => {
    spawnSync("git", ["-C", root, "checkout", "-q", "-B", "main"]);
    const r = bash("git push");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("gh pr create");
    expect(bash("git push origin").status).toBe(2);
    expect(bash("git push -u origin HEAD").status).toBe(2);
  });
  it("lets git commit, a push to a feature branch, and gh pr create through (must-pass)", () => {
    for (const c of [
      "git commit -m 'x'", "git commit -am 'x'", "git push origin feature-x", "git push -u origin feature-x", "git push", "git push origin HEAD",
      "git push --force-with-lease origin feature-x", "git push origin feature-x:feature-y", "git push origin mainline", "git push origin main-fix",
      "git push origin feature/main", "git push origin HEAD:refs/heads/feature-x", "git push --tags origin",
      'gh pr create --title "x" --body "never push to main"', "gh pr create --fill", "gh pr create --base main --head feature-x", "gh pr merge 12",
      "git checkout -b feature-y", "git status", "git log main", "git diff main", "git pull origin main", "git fetch origin main", "git merge main",
      "npm test", "ls", "grep x src", 'claude -p --agent x "summarize the logs"', "for f in a b; do echo $f; done",
    ]) {
      expect(bash(c).status, c).toBe(0);
    }
  });
  it("names the refusal on stderr", () => {
    const r = bash("git push origin main");
    expect(r.stderr).toContain("main");
    expect(r.stderr).toContain("gh pr create");
  });
  it("does not touch edits", () => {
    expect(tool("Write", at("src/a.ts")).status).toBe(0);
  });
});

describe.skipIf(!hasJq)("S-203 out: pr with a named branch", () => {
  beforeEach(() => setup(`boundary r { path: ".", out: pr, branch: release }`));
  it("refuses the named branch as well as main and master", () => {
    expect(bash("git push origin release").status).toBe(2);
    expect(bash("git push origin HEAD:release").status).toBe(2);
    expect(bash("git push origin main").status).toBe(2);
  });
  it("lets other branches through", () => {
    expect(bash("git push origin feature-x").status).toBe(0);
    expect(bash("git push origin release-notes").status).toBe(0);
  });
});

describe.skipIf(!hasJq)("S-203 out: none", () => {
  beforeEach(() => setup(`boundary r { path: ".", out: none }`));
  it("refuses every git push", () => {
    for (const c of ["git push", "git push origin feature-x", "git push -u origin HEAD", "git -C . push", "git status && git push origin x"]) {
      expect(bash(c).status, c).toBe(2);
    }
  });
  it("lets everything else through (must-pass)", () => {
    for (const c of [
      "git commit -m 'x'", "git status", "git pull", "git fetch", "git log", "git diff", "npm test", "ls", "grep push src", "cat push.txt",
      'gh pr create --body "x"', "git stash list", "echo git push", 'claude -p --agent x "summarize the logs"', "for f in a b; do echo $f; done",
    ]) {
      expect(bash(c).status, c).toBe(0);
    }
  });
});

describe.skipIf(!hasJq)("S-203 out: direct", () => {
  it("restricts nothing: no guard is written", () => {
    const files = claudeCodeBinding.scaffold(parse(`${head}  boundary r { path: ".", out: direct }\n}`));
    expect(files.some((f) => f.path.endsWith("before-boundary.sh"))).toBe(false);
  });
});
