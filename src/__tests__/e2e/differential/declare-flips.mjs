/**
 * Declare, once and by rule, which frozen 0.11.2 hook pairs 0.11.4 turns
 * from exit 2 into exit 0 (hooks-0114-flips.json). The rule is written here
 * on its own, from the topologies' gated words, not from the hooks' code:
 *
 * - with jq: a must-not-block command (hook-corpus.mjs) against the factory
 *   topology's before-action.sh, where 0.11.2 refused it;
 * - with no jq: a payload that could not hold anything the hook guards, where
 *   0.11.2 refused it. It could hold it when it is empty, holds a \u escape,
 *   or its letters (after JSON's escapes are read) hold, in order, the letters
 *   of every word of a gated step, of a ledger's file name, or of a gated
 *   agent; or, for before-action.sh, when it holds an expansion or a glob
 *   ($ ` * ? [ or a { that is no JSON brace) and the letters of a gated tool.
 * - the Codex if filter (at-if.sh): see ifFlip below.
 *
 *   node declare-flips.mjs <hooks-0112.json> <out.json>
 */

import fs from "node:fs";
import { MUST_NOT_BLOCK, RAW_ACTION, RAW_EDIT, RAW_AGENT } from "./hook-corpus.mjs";

const [frozenFile, outFile] = process.argv.slice(2);
if (!frozenFile || !outFile) {
  console.error("usage: node declare-flips.mjs <hooks-0112.json> <out.json>");
  process.exit(1);
}

/** What each topology guards, by hand from its .at text: steps as words, ledger file names, agents. */
const GUARDED = {
  factory: { steps: [["git", "commit"], ["git", "push"]], ledgers: [], agents: [] },
  ship: { steps: [["tool", "publish"], ["tool", "republish"]], ledgers: ["trace.jsonl"], agents: [] },
  show: { steps: [["media", "episode", "render"]], ledgers: ["trace.jsonl"], agents: [] },
  post: { steps: [["post-ig.py", "upload"]], ledgers: ["trace.jsonl"], agents: [] },
  rd: { steps: [["deliver.py"], ["media", "kit"]], ledgers: ["trace.jsonl"], agents: [] },
  runstep: { steps: [["tool", "publish"]], ledgers: [], agents: [] },
  cxgates: { steps: [["tool", "publish"], ["tool", "republish"]], ledgers: ["trace.jsonl", "approvals.jsonl"], agents: ["editor"] },
  compile: { steps: [], ledgers: [], agents: ["drafter"] },
};

const letters = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
/** The letters of a raw JSON payload as decoded: \\ and the control escapes carry none. */
const payloadLetters = (raw) => letters(raw.replace(/\\\\/g, "").replace(/\\[ntrbf]/g, ""));
const inOrder = (text, words) => {
  let t = text;
  for (const w of words.map(letters).filter(Boolean)) {
    const at = t.indexOf(w);
    if (at < 0) return false;
    t = t.slice(at + w.length);
  }
  return true;
};

function couldHold(hook, topology, raw) {
  const g = GUARDED[topology];
  if (raw === "" || raw.includes("\\u")) return true;
  const L = payloadLetters(raw);
  if (g.ledgers.some((l) => L.includes(letters(l)))) return true;
  if (hook === "before-agent.sh") return g.agents.some((a) => L.includes(letters(a)));
  if (hook === "before-edit.sh") return false;
  if (g.steps.some((s) => inOrder(L, s))) return true;
  const expansion = /[$`*?[]|\{[^"}\s]/.test(raw);
  return expansion && g.steps.some((s) => L.includes(letters(s[0])));
}

/** The payload a pair was run with, rebuilt as hook-corpus.mjs builds it. */
function payloadOf(r) {
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
  if (r.hook === "before-action.sh") return JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: r.input } });
  if (r.hook === "before-edit.sh") {
    return codex
      ? JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { command: `*** Begin Patch\n*** Update File: ${r.input}\n@@\n-a\n+b\n*** End Patch\n` } })
      : JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: r.input, old_string: "a", new_string: "b" } });
  }
  return codex
    ? JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "collaborationspawn_agent", tool_input: { task_name: "t", agent_type: r.input, message: "go", fork_turns: "none" } })
    : JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: r.input, prompt: "go" } });
}

/**
 * The Codex `if:` filter (at-if.sh), by hand from each topology's hook: only a strength: refuse hook
 * treats doubt as a match, so only its pairs can flip; with no jq the filter is unchanged (it blocks).
 */
const IF_GUARDED = {
  ifpush: { refuse: true, words: ["git", "push"] },
  ifpushnote: { refuse: false, words: ["git", "push"] },
  ifrm: { refuse: false, words: ["rm", "-rf"] },
};
/** git subcommands that read or record (none of them is a push). */
const GIT_READING = ["status", "diff", "log", "show", "add", "commit", "blame", "ls-files", "restore", "rm", "mv", "branch", "tag"];
/**
 * at-if.sh, with jq, behind a refuse hook on a git glob: a must-not-block command, or one plain git
 * command (no ; & | ( ) and no command substitution) whose subcommand, written out, is a reading one other
 * than the glob's own (git commit -m "$MSG" is no push).
 */
function ifFlip(r) {
  const g = IF_GUARDED[r.topology];
  if (!r.jq || !g.refuse || g.words[0] !== "git") return null;
  if (mnb.has(r.input)) return "must-not-block";
  const m = /^git ([a-z-]+)( |$)/.exec(r.input);
  if (m && !/[;&|()`]|\$\(/.test(r.input) && GIT_READING.includes(m[1]) && m[1] !== g.words[1]) return "a reading git command, not the glob's";
  return null;
}

const frozen = JSON.parse(fs.readFileSync(frozenFile, "utf8"));
const mnb = new Set(MUST_NOT_BLOCK);
const flips = [];
for (const r of frozen.rows) {
  if (r.exit !== 2) continue;
  const why = r.hook === "at-if.sh"
    ? ifFlip(r)
    : r.jq
    ? (r.topology === "factory" && r.hook === "before-action.sh" && mnb.has(r.input) ? "must-not-block" : null)
    : (couldHold(r.hook, r.topology, payloadOf(r)) ? null : "no jq, no gated thing in the payload");
  if (why) flips.push({ topology: r.topology, binding: r.binding, hook: r.hook, input: r.input, jq: r.jq, why });
}
fs.writeFileSync(outFile, JSON.stringify({ count: flips.length, flips }, null, 0).replace(/\},\{/g, "},\n{") + "\n");
const by = {};
for (const f of flips) { const k = `${f.topology}|${f.binding}|${f.hook}|${f.jq ? "jq" : "nojq"}`; by[k] = (by[k] ?? 0) + 1; }
console.log(`${flips.length} declared flips`);
for (const [k, n] of Object.entries(by)) console.log(`  ${k}: ${n}`);
