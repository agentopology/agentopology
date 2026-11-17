/**
 * The rules the declared hook flips are computed by (declare-flips-words.mjs, declare-flips-program.mjs),
 * written here on their own, from the topologies' gated words and the JSON-parsed payloads, not from the
 * hooks' code.
 *
 * namesTool: a program word names a gated tool when its basename, case-folded and with a trailing .exe,
 * .cmd, .bat or .com dropped, is the tool; or one word a brace list in it expands to does; or it is a glob
 * (two letters or more; a brace sequence or a nested list stands for any text) that matches the tool.
 *
 * couldHold (no jq): a payload could hold what a hook guards when:
 * - it is empty, or holds a \u escape;
 * - its letters (after JSON's escapes are read) hold a ledger's file name, or, next to a git step, the
 *   letters of git then alias, or git then include;
 * - a gated step's words (or a gated agent's name) appear among its words, whole and in order. Its words:
 *   every JSON string (keys and values, in order) read as bash gets it (a backslash then a newline joined
 *   away, quotes dropped, a backslash dropped, or in a second reading a word break), bytes outside ASCII
 *   dropped, lower case, cut at blanks and ; & | ( ) < > / = : , (an agent's name also at . ! ?), a
 *   leading ~ and a trailing .exe .cmd .bat or .com dropped;
 * - before-action.sh: it holds $ ` * ? [ or a brace list {a,b} or sequence {a..b}, and the letters of a
 *   gated tool; or a PowerShell call with a gated tool's letters;
 * - before-action.sh: a glob or brace word that names a gated tool (namesTool) stands where bash runs a
 *   program: a segment's program (after variable assignments and if/then/.../time), or any later word when
 *   that program is not one that only reads (cat, ls, git log, ...), or the value of a variable set at the
 *   segment's start; or a program word that starts with ~ holds a tool's letters. Segments: each JSON
 *   string, cut at ; & | ( ) ` and a newline.
 *
 * jqNames (with jq): a segment's program word, or a later word when the program does not only read, names
 * a gated tool, and either a step's words for that tool follow it in order, or the word is a brace
 * expansion (doubt). Words as jq reads them: quotes and backslashes dropped, cut at blanks.
 */

import { RAW_ACTION, RAW_EDIT, RAW_AGENT } from "./hook-corpus.mjs";

/** What each topology guards, by hand from its .at text (hook-corpus.mjs). */
export const GUARDED = {
  factory: { steps: [["git", "commit"], ["git", "push"]], tools: ["git"], git: true, ledgers: [], agents: [] },
  ship: { steps: [["tool", "publish"], ["tool", "republish"]], tools: ["tool"], ledgers: ["trace.jsonl"], agents: [] },
  show: { steps: [["media", "episode", "render"]], tools: ["media"], ledgers: ["trace.jsonl"], agents: [] },
  post: { steps: [["post-ig.py", "upload"]], tools: ["post-ig.py"], ledgers: ["trace.jsonl"], agents: [] },
  rd: { steps: [["deliver.py"], ["media", "kit"]], tools: ["deliver.py", "media"], ledgers: ["trace.jsonl"], agents: [] },
  runstep: { steps: [["tool", "publish"]], tools: ["tool"], ledgers: [], agents: [] },
  cxgates: { steps: [["tool", "publish"], ["tool", "republish"]], tools: ["tool"], ledgers: ["trace.jsonl", "approvals.jsonl"], agents: ["editor"] },
  compile: { steps: [], tools: [], ledgers: [], agents: ["drafter"] },
};

/** The Codex `if:` hooks: a strength: refuse hook also matches on doubt. */
export const IF_GUARDED = {
  ifpush: { refuse: true, steps: [["git", "push"]], tools: ["git"] },
  ifpushnote: { refuse: false, steps: [["git", "push"]], tools: ["git"] },
  ifrm: { refuse: false, steps: [["rm", "-rf"]], tools: ["rm"] },
};

export const letters = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
/** The letters of a raw JSON payload as decoded: \\ and the control escapes carry none (0.11.4, unchanged). */
const payloadLetters = (raw) => letters(raw.replace(/\\\\/g, "").replace(/\\[ntrbf]/g, ""));
const lettersInOrder = (text, words) => {
  let t = text;
  for (const w of words.map(letters).filter(Boolean)) {
    const at = t.indexOf(w);
    if (at < 0) return false;
    t = t.slice(at + w.length);
  }
  return true;
};

/** Every string of a JSON value, keys and values, in document order. */
function strings(v, out = []) {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.push(k); strings(x, out); }
  return out;
}

/** The two bash readings of one decoded string: a backslash dropped, or a word break. */
function readings(s) {
  const t = s.replace(/\\\n/g, "").replace(/["']/g, "");
  return [t.replace(/\\/g, ""), t.replace(/\\/g, " ")];
}
const SUFFIX = /\.(exe|cmd|bat|com)$/;
function wordsOf(t, extra) {
  const cut = new RegExp(`[\\s\\x08;&|()<>/=:,${extra}]+`);
  return t.replace(/[^\x00-\x7f]/g, "").toLowerCase().split(cut).map((w) => w.replace(/^~+/, "").replace(SUFFIX, "")).filter(Boolean);
}
function wordsInOrder(words, list) {
  let i = 0;
  for (const w of words) if (i < list.length && w === list[i]) i++;
  return i === list.length;
}

const LEAD = ["if", "then", "elif", "else", "while", "until", "do", "!", "{", "time"];
const READS = ["cat", "ls", "head", "tail", "wc", "echo", "printf", "grep", "egrep", "fgrep", "rg", "ag", "stat", "file", "diff", "cmp", "md5sum",
  "sha1sum", "sha256sum", "shasum", "du", "tree", "realpath", "basename", "dirname", "readlink", "test", "[", "true", "false", "bat", "jq",
  "get-content", "gc", "select-string", "sls"];
const GIT_READS = ["status", "diff", "log", "show", "add", "commit", "blame", "ls-files", "grep", "restore", "rm", "mv", "branch", "tag"];
const RUNS = (x) => /^(-c.*|-x|-e|--exec.*|--extcmd.*|--command.*|--eval.*|--pre|--pre=.*|--ext-diff|\+.*|.*alias.*|!.*)$/.test(x);
function readsOnly(base, args) {
  if (args.some(RUNS)) return false;
  if (base === "git") {
    if (args.some((x) => x === "run" || x === "exec" || x.startsWith("--exec"))) return false;
    return GIT_READS.includes(args.find((x) => !x.startsWith("-")) ?? "");
  }
  return READS.includes(base);
}
/** A bash glob as a RegExp. */
const globRe = (g) => new RegExp(`^${g.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".").replace(/\[!/g, "[^")}$`);
const BRACE = /\{[^{}]*(,|\.\.)[^{}]*\}/;
/** The words a brace list in WORD expands to; a sequence or a nested list as `*`. */
function expansions(word) {
  const m = /^([^{}]*)\{([^{}]*,[^{}]*)\}(.*)$/.exec(word);
  if (m) return m[2].split(",").flatMap((alt) => expansions(m[1] + alt + m[3]));
  if (!BRACE.test(word)) return [word];
  let w = word;
  while (/\{[^{}]*\}/.test(w)) w = w.replace(/\{[^{}]*\}/, "*");
  return [w];
}
/** The program word WORD names TOOL (the rule above). */
export function namesTool(word, tool) {
  for (const w of expansions(word.toLowerCase())) {
    const whole = w.replace(/^.*\//, "");
    const b = whole.replace(SUFFIX, "");
    if (b === tool || whole === tool) return true;
    if (/[*?[]/.test(b) && letters(b).length >= 2) {
      try { if (globRe(b).test(tool)) return true; } catch { /* not a glob */ }
    }
  }
  return false;
}
function globTool(word, tools) {
  return /[*?[{]/.test(word) && tools.some((t) => namesTool(word, t));
}
function globProgram(text, g) {
  for (const seg of text.toLowerCase().split(/[;&|()`\n]/)) {
    const ws = seg.split(/[ \t\r\f\v]+/).filter(Boolean);
    let p = 0;
    for (; p < ws.length; p++) {
      if (/^[a-z_][a-z0-9_]*=/.test(ws[p])) { if (globTool(ws[p].replace(/^[^=]*=/, ""), g.tools)) return true; }
      else if (!LEAD.includes(ws[p])) break;
    }
    if (p >= ws.length) continue;
    if (ws[p].startsWith("~") && g.tools.some((t) => letters(ws[p]).includes(letters(t)))) return true;
    if (readsOnly(ws[p].replace(/^.*\//, ""), ws.slice(p + 1))) continue;
    if (ws.slice(p).some((x) => globTool(x, g.tools) || globTool(x.replace(/^[^=]*=/, ""), g.tools))) return true;
  }
  return false;
}

/** No jq: the payload could hold what the hook guards (the rule above). */
export function couldHold(hook, topology, raw) {
  const g = GUARDED[topology];
  if (raw === "" || raw.includes("\\u")) return true;
  const L = payloadLetters(raw);
  if (g.ledgers.some((l) => L.includes(letters(l)))) return true;
  if (hook === "before-edit.sh") return false;
  const strs = strings(JSON.parse(raw));
  const extra = hook === "before-agent.sh" ? ".!?" : "";
  const read = [0, 1].map((k) => strs.flatMap((s) => wordsOf(readings(s)[k], extra)));
  const present = (list) => read.some((ws) => wordsInOrder(ws, list.flatMap((w) => wordsOf(w, extra))));
  if (hook === "before-agent.sh") return g.agents.some((a) => present([a]));
  if (g.steps.some(present)) return true;
  if (g.git && (lettersInOrder(L, ["git", "alias"]) || lettersInOrder(L, ["git", "include"]))) return true;
  const toolLetters = g.tools.some((t) => L.includes(letters(t)));
  const expansion = strs.some((s) => /[$`*?[]/.test(s) || /\{[^{}\s]*(,|\.\.)[^{}\s]*\}/.test(s));
  if (expansion && toolLetters) return true;
  if (read[0].includes("powershell") && toolLetters) return true;
  // the program check's two readings: a backslash dropped, or a path separator
  const globReadings = (s) => { const t = s.replace(/\\\n/g, "").replace(/["']/g, ""); return [t.replace(/\\/g, ""), t.replace(/\\/g, "/")]; };
  return strs.some((s) => globReadings(s).some((t) => globProgram(t, g)));
}

/** With jq: COMMAND runs one of g's steps through a program word that names its tool (the rule above). */
export function jqNames(command, g, { doubt = true } = {}) {
  for (const seg of command.replace(/\\\n/g, "").split(/[;&|()`\n]/)) {
    const ws = seg.replace(/["'\\]/g, "").toLowerCase().split(/\s+/).filter(Boolean);
    let p = 0;
    while (p < ws.length && (/^[a-z_][a-z0-9_]*=/.test(ws[p]) || LEAD.includes(ws[p]))) p++;
    if (p >= ws.length) continue;
    for (const step of g.steps) {
      const [tool, ...rest] = step;
      const cands = namesTool(ws[p], tool) ? [p]
        : readsOnly(ws[p].replace(/^.*\//, ""), ws.slice(p + 1)) ? []
        : ws.map((_, j) => j).filter((j) => j > p && namesTool(ws[j], tool));
      for (const i of cands) {
        if (doubt && BRACE.test(ws[i])) return true;
        if (wordsInOrder(ws.slice(i + 1), rest)) return true;
      }
    }
  }
  return false;
}

/** The payload a pair was run with, rebuilt as hook-corpus.mjs builds it. */
export function payloadOf(r) {
  const codex = r.binding === "codex";
  if (r.input.startsWith("raw: ")) {
    const name = r.input.slice(5);
    if (r.hook === "before-action.sh") return RAW_ACTION.find((x) => x.name === name).payload;
    if (r.hook === "before-edit.sh") {
      const x = RAW_EDIT.find((y) => y.name === name);
      return codex ? `{"hook_event_name":"PreToolUse","tool_name":"apply_patch","tool_input":{"command":"*** Begin Patch\\n*** Update File: ${x.codexPath}\\n*** End Patch\\n"}}` : x.payload;
    }
    const x = RAW_AGENT.find((y) => y.name === name);
    return codex
      ? `{"hook_event_name":"PreToolUse","tool_name":"collaborationspawn_agent","tool_input":{"task_name":"t","agent_type":"${x.agent}","message":"go"}}`
      : `{"hook_event_name":"PreToolUse","tool_name":"Agent","tool_input":{"subagent_type":"${x.agent}","prompt":"go"}}`;
  }
  if (r.hook === "before-action.sh" || r.hook === "at-if.sh") return JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: r.input } });
  if (r.hook === "before-edit.sh") {
    return codex
      ? JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { command: `*** Begin Patch\n*** Update File: ${r.input}\n@@\n-a\n+b\n*** End Patch\n` } })
      : JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: r.input, old_string: "a", new_string: "b" } });
  }
  return codex
    ? JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "collaborationspawn_agent", tool_input: { task_name: "t", agent_type: r.input, message: "go", fork_turns: "none" } })
    : JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: r.input, prompt: "go" } });
}
