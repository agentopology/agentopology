/**
 * import → scaffold keeps a hook's quoted arguments: the scaffolded command
 * passes the hook script the same argv the harness's command did.
 *
 * Measured on npm 0.12.4 and 0.12.5: `bash .claude/hooks/x.sh
 * "$CLAUDE_PROJECT_DIR" "a b"` imported with exit 0 ("passes all validation
 * rules"), and scaffold rewrote it to `bash "$CLAUDE_PROJECT_DIR/.claude/hooks/x.sh"
 * \"$CLAUDE_PROJECT_DIR\" \"a b\"`: the .at string keeps `\"`, and the
 * arguments' `\"` were read as `"` only when the script word itself was
 * quoted. The hook got 3 arguments (`"<ROOT>"`, `"a`, `b"`) instead of 2.
 *
 * Each row runs the harness's command and the scaffolded one with bash against
 * a script that prints its argv, and compares the two.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, "../../../dist/cli/index.js");
const ARGV = "#!/bin/sh\nfor a in \"$@\"; do printf '[%s]\\n' \"$a\"; done\n";
const FLAG = "can't be compiled faithfully";

describe("import → scaffold: a hook's quoted arguments reach its script as the harness passed them", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(join(os.tmpdir(), "at-qargs-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const cli = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8", timeout: 60_000 });

  /** The argv the script sees when bash runs `command` in `dir`, one argument per entry. */
  const argvOf = (command: string, dir: string): string[] => {
    const r = spawnSync("bash", ["-c", command], {
      cwd: dir, encoding: "utf8", timeout: 20_000, input: "{}",
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir, HOME: "/home/someone" },
    });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout.split("\n").filter(Boolean).map((l) => l.replace(/^\[|\]$/g, "").replaceAll(dir, "<ROOT>"));
  };

  /** A harness with one PreToolUse hook and the argv script; import it, scaffold the .at over a copy of it. */
  const roundTrip = (command: string, scriptRel: string) => {
    const harness = join(root, "harness");
    fs.mkdirSync(join(harness, dirname(scriptRel)), { recursive: true });
    fs.writeFileSync(join(harness, scriptRel), ARGV, { mode: 0o755 });
    fs.mkdirSync(join(harness, ".claude/agents"), { recursive: true });
    fs.writeFileSync(join(harness, ".claude/agents/a.md"), "---\nname: a\ndescription: An agent\n---\n\nBody.\n");
    fs.writeFileSync(join(harness, ".claude/settings.json"), JSON.stringify({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command }] }] },
    }, null, 2));
    const out = join(root, "out");
    fs.mkdirSync(out);
    const imp = cli(["import", "--target", "claude-code", "--dir", harness, "--name", "q", "--output", out]);
    const proj = join(root, "proj");
    fs.cpSync(harness, proj, { recursive: true });
    const scaf = cli(["scaffold", join(out, "q.at"), "--target", "claude-code", "--output", proj, "--force"]);
    const settings = JSON.parse(fs.readFileSync(join(proj, ".claude/settings.json"), "utf8"));
    const commands = (settings.hooks.PreToolUse as Array<{ hooks: Array<{ command: string }> }>).flatMap((g) => g.hooks.map((h) => h.command));
    return { imp, scaf, commands, proj };
  };

  it.each<[string, string, string[]]>([
    ["quoted variable and double-quoted space", 'bash .claude/hooks/x.sh "$CLAUDE_PROJECT_DIR" "a b"', ["<ROOT>", "a b"]],
    ["double-quoted with a space", 'bash .claude/hooks/x.sh "a b"', ["a b"]],
    ["a quoted variable alone", 'bash .claude/hooks/x.sh "$CLAUDE_PROJECT_DIR"', ["<ROOT>"]],
    ["single quotes, one holding a double quote", `bash .claude/hooks/x.sh 'c d' 'it"s'`, ["c d", 'it"s']],
    ["an escaped quote inside an argument", 'bash .claude/hooks/x.sh "e\\"f" g', ['e"f', "g"]],
    ["a $ that stays unexpanded", `bash .claude/hooks/x.sh '$HOME' "\\$HOME" "$HOME/x y"`, ["$HOME", "$HOME", "/home/someone/x y"]],
    ["sh, a flag after the quoted argument", 'sh .claude/hooks/x.sh "a b" --flag', ["a b", "--flag"]],
    ["a script outside .claude/hooks", 'bash tools/x.sh --re "a b"', ["--re", "a b"]],
  ])("[QA] %s: %s", (_shape, command, argv) => {
    const scriptRel = command.split(" ")[1];
    const r = roundTrip(command, scriptRel);
    expect(r.imp.status, r.imp.stdout + r.imp.stderr).toBe(0);
    expect(r.imp.stdout + r.imp.stderr).not.toContain(FLAG);
    expect(r.scaf.status, r.scaf.stdout + r.scaf.stderr).toBe(0);
    expect(r.commands).toHaveLength(1);
    expect(argvOf(command, r.proj)).toEqual(argv);
    expect(argvOf(r.commands[0], r.proj)).toEqual(argv);
  });
});
