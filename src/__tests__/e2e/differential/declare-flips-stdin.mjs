/**
 * Declare, once and by rule, which frozen 0.11.4 hook pairs go from exit 0 to exit 2 when a helper that
 * hands a gated tool its arguments from standard input is refused (hooks-0114-stdin-closed.json). The rule
 * is written here from the topologies' gated words (hook-rules.mjs GUARDED, IF_GUARDED), not from the
 * hooks' code:
 *
 * stdinFed: in a segment (the command cut at ; & | ( ) ` and a newline; a redirection and its target
 * dropped; quotes and backslashes dropped, lower case, cut at blanks), past variable assignments and
 * if/then/.../time, the program does not only read (readsOnly), and some word from the program on names a
 * helper (HELPERS below; namesTool), and a later word names a gated tool (namesTool)
 * whose step's words do not all follow it in order. Not counted: git whose next word (after --no-pager,
 * --no-optional-locks, --no-replace-objects, --literal-pathspecs) is a reading subcommand (GIT_READS, not
 * grep, not the first word of any git step the topology gates) and no word makes git run a command.
 *
 * - before-action.sh, with jq and without: a pair 0.11.4 let through goes 0 -> 2 when stdinFed holds;
 * - at-if.sh (Codex if filter), with jq: the same, only for a strength: refuse hook (it matches on doubt);
 *   with no jq, no change (it blocks).
 *
 *   node declare-flips-stdin.mjs <out.json> <frozen.json>...
 */

import fs from "node:fs";
import { GUARDED, IF_GUARDED, GIT_READS, LEAD, namesTool, readsOnly } from "./hook-rules.mjs";

const HELPERS = ["xargs", "parallel", "rush", "xe", "xjobs"];
const GIT_QUIET = ["--no-pager", "--no-optional-locks", "--no-replace-objects", "--literal-pathspecs"];

function inOrder(words, list) {
  let i = 0;
  for (const w of words) if (i < list.length && w === list[i]) i++;
  return i === list.length;
}

function gitReads(after, gitSteps) {
  let j = 0;
  while (j < after.length && GIT_QUIET.includes(after[j])) j++;
  const x = after[j];
  if (x === undefined || x.startsWith("-") || x === "grep" || !GIT_READS.includes(x) || gitSteps.includes(x)) return false;
  return readsOnly("git", after);
}

function stdinFed(command, steps) {
  const gitSteps = steps.filter((s) => s[0] === "git").map((s) => s[1]).filter(Boolean);
  const text = command.replace(/\\\n/g, "").replace(/(&>>|&>|>>|>\||>&|<&|<<<|<<-|<<|<>|>|<)\s*[^\s;&|()<>]*/g, " ");
  for (const seg of text.split(/[;&|()`\n]/)) {
    const ws = seg.replace(/["'\\]/g, "").toLowerCase().split(/\s+/).filter(Boolean);
    let p = 0;
    while (p < ws.length && (/^[a-z_][a-z0-9_]*=/.test(ws[p]) || LEAD.includes(ws[p]))) p++;
    if (p >= ws.length || readsOnly(ws[p].replace(/^.*\//, ""), ws.slice(p + 1))) continue;
    const helper = ws.findIndex((x, q) => q >= p && HELPERS.some((h) => namesTool(x, h)));
    if (helper < 0) continue;
    for (const [tool, ...rest] of steps) {
      for (let i = helper + 1; i < ws.length; i++) {
        if (!namesTool(ws[i], tool)) continue;
        if (inOrder(ws.slice(i + 1), rest)) continue;
        if (tool === "git" && gitReads(ws.slice(i + 1), gitSteps)) continue;
        return true;
      }
    }
  }
  return false;
}

const [outFile, ...frozenFiles] = process.argv.slice(2);
if (!outFile || frozenFiles.length === 0) {
  console.error("usage: node declare-flips-stdin.mjs <out.json> <frozen.json>...");
  process.exit(1);
}
const closed = [];
for (const file of frozenFiles) {
  const frozen = JSON.parse(fs.readFileSync(file, "utf8"));
  if (frozen.version !== "0.11.4") throw new Error(`expected a 0.11.4 freeze, got ${frozen.version}`);
  for (const r of frozen.rows) {
    if (r.exit !== 0 || r.input.startsWith("raw: ")) continue;
    let g = null;
    if (r.hook === "before-action.sh") g = GUARDED[r.topology];
    else if (r.hook === "at-if.sh" && r.jq && IF_GUARDED[r.topology].refuse) g = IF_GUARDED[r.topology];
    if (!g || !stdinFed(r.input, g.steps)) continue;
    closed.push({ topology: r.topology, binding: r.binding, hook: r.hook, input: r.input, jq: r.jq, why: "a helper hands the gated tool its arguments from standard input" });
  }
}
fs.writeFileSync(outFile, JSON.stringify({ count: closed.length, closed }, null, 0).replace(/\},\{/g, "},\n{") + "\n");
console.log(`${closed.length} declared 0->2 changes`);
