/**
 * CC-exit127: the command a hook or gate runs starts with something the shell
 * cannot find.
 *
 * A hook command whose first word is a missing file or a name not on PATH
 * exits 127, and Claude Code blocks only on exit 2, so the guard never holds
 * and nothing says so. F1 produced exactly that (`scripts/guard.sh 2>/dev/null`
 * emitted as written). validate and guard --check read the command the
 * binding writes (hookCommand) and name each one whose first word is not found.
 *
 * Only a run the binding emits as written (a shell line) is judged, and only
 * its first word: any other run is a script the binding runs through an
 * interpreter (`bash "$CLAUDE_PROJECT_DIR/..."`), which scaffold writes.
 *
 * @module
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentNode, GateNode, TopologyAST } from "../parser/ast.js";
import { hookCommand, topologyScripts } from "../bindings/claude-code.js";
import { isShellCommand } from "../parser/run.js";

export const EXIT127_RULE = "CC-exit127";

/** Words the shell runs itself: no file is looked up for them. */
const SHELL_WORD = /^(?:exit|true|false|echo|printf|test|\[|\[\[|:|for|if|case|while|until|cd|export|source|\.|eval|exec|command|builtin|set|unset|read|return|shift|trap|wait|type|time|!|\{|\(|local|declare|readonly|ulimit|umask|alias|pushd|popd|let|select|function)$/;

/** Whether an executable file named `name` is in a PATH folder. */
function onPath(name: string, envPath: string): boolean {
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    try {
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isFile()) {
        fs.accessSync(full, fs.constants.X_OK);
        return true;
      }
    } catch {
      // not here
    }
  }
  return false;
}

/** Why the command's first word is not found from `root`, or null when it is (or cannot be judged). */
export function notFoundReason(command: string, root: string, envPath = process.env.PATH ?? ""): { word: string; why: string } | null {
  const raw = command.trim().match(/^\S+/)?.[0];
  if (!raw) return null;
  if (SHELL_WORD.test(raw) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(raw)) return null;
  // The project-dir variable is the project root; any other variable cannot be judged here.
  let word = raw.replace(/^"?\$(?:CLAUDE_PROJECT_DIR\b|\{CLAUDE_PROJECT_DIR(?::-[^}"]*)?\})"?/, root.replace(/\$/g, "$$$$"));
  if (/[$`]/.test(word)) return null;
  word = word.replace(/["']/g, "");
  if (word.startsWith("~/")) word = path.join(process.env.HOME ?? "~", word.slice(2));
  if (word.includes("/")) {
    const full = path.isAbsolute(word) ? word : path.join(root, word);
    return fs.existsSync(full) ? null : { word, why: `${word} is not found from the project root` };
  }
  return onPath(word, envPath) ? null : { word, why: `${word} is not on PATH` };
}

/** One warning per hook or gate whose command would exit 127 from `root`. */
export function exit127Warnings(ast: TopologyAST, root: string, envPath?: string): Array<{ rule: string; level: "warning"; message: string; node?: string }> {
  const name = ast.topology.name;
  const declared = topologyScripts(ast);
  const out: Array<{ rule: string; level: "warning"; message: string; node?: string }> = [];
  const check = (owner: string, run: string | undefined, node?: string) => {
    // Only a run emitted as written is judged: any other runs through the
    // interpreter the binding names, on a script scaffold writes.
    if (!run || !isShellCommand(run, declared)) return;
    const command = hookCommand(run, name, declared);
    const r = notFoundReason(command, root, envPath);
    if (!r) return;
    out.push({
      rule: EXIT127_RULE,
      level: "warning",
      message: `${owner} runs ${JSON.stringify(command)}: ${r.why}, so the shell exits 127, which does not block. Fix the path, or name a script the topology scaffolds (run: "scripts/<name>").`,
      ...(node ? { node } : {}),
    });
  };
  const command = (h: { type?: string }) => (h.type ?? "command") === "command";
  for (const hook of (ast.hooks ?? []).filter(command)) check(`Hook "${hook.name}"`, hook.run);
  for (const n of ast.nodes) {
    if (n.type === "gate" && (n as GateNode).behavior !== "advisory") check(`Gate "${n.id}"`, (n as GateNode).run, n.id);
    if (n.type === "agent") for (const h of ((n as AgentNode).hooks ?? []).filter(command)) check(`Hook "${h.name}" on agent "${n.id}"`, h.run, n.id);
  }
  return out;
}

/**
 * The project root a .at file belongs to: the nearest folder at or above it
 * that holds `.claude` or `.git`, else the .at's own folder.
 */
export function projectRootOf(atFile: string): string {
  let dir = path.dirname(path.resolve(atFile));
  for (;;) {
    if (fs.existsSync(path.join(dir, ".claude")) || fs.existsSync(path.join(dir, ".git"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return path.dirname(path.resolve(atFile));
    dir = up;
  }
}
