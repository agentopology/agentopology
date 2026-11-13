/**
 * Guard-script library shared by the bindings (CX-10).
 *
 * The hook scripts that hold a gate, a human approval or a session rule used
 * to be built inline in the Claude Code binding. They are built here, from a
 * {@link GuardPlatform}: the record of what differs between hosts (the
 * project-dir variable, the folders, the hook payload field names, whether a
 * hook can ask). The Claude Code platform reproduces the scripts byte for
 * byte; any other platform gets scripts that name none of Claude Code's
 * variables or folders.
 *
 * A block is signalled by exit 2 on every platform so far, and the scripts
 * write the reason to stderr.
 *
 * @module
 */

import type { ActionNode, AgentNode, GateNode, HumanNode, OrchestratorNode, TopologyAST } from "../../parser/ast.js";
import { gateAnchors } from "../../parser/ast.js";
import { gateLedger, guardedActions } from "../../parser/ledger.js";
import { scriptNameFromRun } from "../../parser/run.js";
import { sessionAgentsOf, talkEdgesOf } from "../../parser/session-graph.js";
import type { GeneratedFile } from "../types.js";
import { FAIL_CLOSED, FAIL_CLOSED_DONE } from "./stub.js";

/** What differs between hosts when a guard script is written. */
export interface GuardPlatform {
  /** Short id, for messages. */
  id: string;
  /** The host's name in comments: "Claude Code". */
  label: string;
  /** What the host's model is called in a comment: "Claude". */
  modelName: string;
  /** What a step run outside the host is said to be outside of: "Claude". */
  outsideName: string;
  /** Env var the host sets to the project root, or null when it sets none (the scripts then find it from their own place). */
  projectDirVar: string | null;
  /** The file the hooks are registered in, as a comment names it. */
  hooksFile: string;
  /** Folder of the topology's scripts, relative to the project root, no trailing slash. */
  scriptsDir(topology: string): string;
  /** Folder the guards keep their trail in, relative to the project root. */
  stateDir: string;
  /** The file that lists the session start lines, relative to the project root. */
  sessionsFile: string;
  /** jq paths into the hook payload. */
  payload: { command: string; subagentType: string };
  /** True when a PreToolUse hook can answer "ask". */
  supportsAsk: boolean;
  /**
   * True when exit 2 from a SubagentStop hook keeps the agent working. On Codex
   * it does not (only PreToolUse and UserPromptSubmit block), so a gate between
   * two agents is held at the second agent's spawn instead (R-1).
   */
  stopCanBlock: boolean;
  /** True when a live run has proven the host's guards hold; false grades them "unverified" (Codex release 1). */
  liveProven: boolean;
}

export const CLAUDE_CODE_GUARDS: GuardPlatform = {
  id: "claude-code",
  label: "Claude Code",
  modelName: "Claude",
  outsideName: "Claude",
  projectDirVar: "CLAUDE_PROJECT_DIR",
  hooksFile: ".claude/settings.json",
  scriptsDir: (topology) => `.claude/skills/${topology}/scripts`,
  stateDir: ".claude/state",
  sessionsFile: ".claude/sessions.md",
  payload: { command: ".tool_input.command", subagentType: ".tool_input.subagent_type" },
  supportsAsk: true,
  stopCanBlock: true,
  liveProven: true,
};

/**
 * The Codex platform. Codex sets no project-dir variable, so the scripts find
 * the project root from where they sit. Codex's PreToolUse cannot ask (an
 * "ask" makes the hook run fail), so approval steps write nothing here. The
 * folder layout is this library's choice until the Codex binding wires it in.
 */
export const CODEX_GUARDS: GuardPlatform = {
  id: "codex",
  label: "Codex",
  modelName: "the model",
  outsideName: "Codex",
  projectDirVar: null,
  hooksFile: ".codex/hooks.json",
  scriptsDir: (topology) => `.codex/scripts/${topology}`,
  stateDir: ".codex/state",
  sessionsFile: ".codex/sessions.md",
  // Probe P3/P4: the spawn tool is collaborationspawn_agent and its agent_type is the agent file's name.
  payload: { command: ".tool_input.command", subagentType: ".tool_input.agent_type" },
  supportsAsk: false,
  stopCanBlock: false,
  liveProven: false,
};

/** Single-quote a string for bash. */
export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** A flow target id that is safe to put in a shell `case` pattern. */
const SAFE_TARGET = /^[A-Za-z0-9_-]{1,64}$/;

/** `../` repeated once per folder level of the scripts dir, to climb from a script to the project root. */
function upToRoot(p: GuardPlatform, topology: string): string {
  return p.scriptsDir(topology).split("/").map(() => "..").join("/");
}

/**
 * The lines that put a script in the project root.
 *
 * - `cd`: just change directory (before-agent).
 * - `strict`: the variable must be set or the step is blocked (before-action).
 * - `fallback`: the variable, else the script's own place (session scripts).
 *
 * With no project-dir variable every mode finds the root from the script's place.
 */
export function projectRootLines(p: GuardPlatform, topology: string, mode: "cd" | "strict" | "fallback"): string[] {
  const v = p.projectDirVar;
  const here = `$(cd "$(dirname "\${BASH_SOURCE[0]}")/${upToRoot(p, topology)}" && pwd)`;
  if (v === null) {
    return mode === "fallback" ? [`ROOT="${here}"`, 'cd "$ROOT"'] : [`cd "${here}"`];
  }
  if (mode === "cd") return [`cd "$${v}"`];
  if (mode === "strict") {
    return [
      `if [ -z "\${${v}:-}" ]; then echo "agentopology: ${v} is not set, so this step cannot be checked and is blocked" >&2; exit 2; fi`,
      `cd "$${v}"`,
    ];
  }
  return [`ROOT="\${${v}:-}"`, `if [ -z "$ROOT" ]; then ROOT=${here}; fi`, 'cd "$ROOT"'];
}

// ---------------------------------------------------------------------------
// Which agents a gate or approval stands before
// ---------------------------------------------------------------------------

/**
 * Check whether `name` refers to a node registered as a Claude Code subagent_type.
 *
 * Both `agent` and `group` nodes scaffold a `.claude/agents/<name>/AGENT.md`
 * file, which is what Claude Code registers as a subagent_type. Action, gate,
 * human, and orchestrator nodes are NOT registered and therefore CANNOT be
 * used as SubagentStop matchers.
 */
/** An agent with runs: inline or fork compiles to a skill, not a subagent. */
export function runsAsSkill(agent: AgentNode): boolean {
  return agent.runs === "inline" || agent.runs === "fork";
}

export function isRegisteredSubagentType(ast: TopologyAST, name: string | undefined): boolean {
  if (!name) return false;
  return ast.nodes.some(
    (n) => (n.type === "group" || (n.type === "agent" && !runsAsSkill(n as AgentNode))) && n.id === name,
  );
}

/**
 * Resolve the topology's orchestration delegation mode.
 *
 * Returns `"inline"` if the orchestrator block declares `delegation: inline`.
 * Otherwise returns `"subagent"` (the default). Inline-orchestrator topologies
 * drive every agent in the main session's context; no Task-tool subagent is
 * ever spawned, so any `SubagentStop` hook would silently never fire.
 */
export function getDelegationMode(ast: TopologyAST): "subagent" | "inline" {
  const orch = ast.nodes.find((n) => n.type === "orchestrator") as
    | OrchestratorNode
    | undefined;
  return orch?.delegation === "inline" ? "inline" : "subagent";
}

/**
 * How a gate is enforced in Claude Code.
 *
 * - `subagent-stop`: every `after:` is an agent; a SubagentStop hook on each
 *   runs the gate when it finishes (exit 2 keeps it working).
 * - `before-agent`: an `after:` is an action or a human, but `before:` names
 *   agents; a PreToolUse hook on the Agent tool runs the gate before Claude
 *   Code launches one of them (exit 2 blocks the launch). Such gates used to
 *   compile to no hook at all.
 * - `none`: nothing in Claude Code marks the moment (inline delegation, or no
 *   agent on either side); the playbook runs the gate script.
 */
export type GateWiring =
  | { kind: "subagent-stop"; anchors: string[] }
  | { kind: "before-agent"; agents: string[] }
  | { kind: "none" };

export function gateWiring(ast: TopologyAST, gate: GateNode): GateWiring {
  if (getDelegationMode(ast) === "inline") return { kind: "none" };
  const afters = gateAnchors(gate, "after");
  if (afters.length > 0 && afters.every((a) => isRegisteredSubagentType(ast, a))) {
    return { kind: "subagent-stop", anchors: afters };
  }
  const agents = gateAnchors(gate, "before").filter((b) => isRegisteredSubagentType(ast, b));
  return agents.length > 0 ? { kind: "before-agent", agents } : { kind: "none" };
}

/**
 * The agents whose launch a gate holds on platform `p`: the before-agent
 * wiring's agents, and, where a SubagentStop hook cannot block (Codex), the
 * registered agents in a subagent-stop gate's `before:` (R-1).
 */
export function spawnHeldAgents(ast: TopologyAST, gate: GateNode, p: GuardPlatform): string[] {
  const wiring = gateWiring(ast, gate);
  if (wiring.kind === "before-agent") return wiring.agents;
  if (wiring.kind === "subagent-stop" && !p.stopCanBlock) {
    return gateAnchors(gate, "before").filter((b) => isRegisteredSubagentType(ast, b));
  }
  return [];
}

function hasHuman(ast: TopologyAST): boolean {
  return ast.nodes.some((n) => n.type === "human" && approvalTargets(ast, n as HumanNode).length > 0);
}

/** Agents a human approval step stands before: its direct flow successors. */
export function approvalTargets(ast: TopologyAST, human: HumanNode): string[] {
  if (getDelegationMode(ast) === "inline") return [];
  const out = ast.edges.filter((e) => e.from === human.id && !e.isError).map((e) => e.to);
  return [...new Set(out)].filter((id) => isRegisteredSubagentType(ast, id));
}

/**
 * One PreToolUse hook on the Agent tool for the whole topology: before Claude
 * Code launches a subagent it runs that agent's gates (from actions or
 * humans), then asks the user to approve when a human step stands before it.
 * Null when nothing needs it.
 */
export function generateBeforeAgentScript(ast: TopologyAST, p: GuardPlatform): GeneratedFile | null {
  const name = ast.topology.name;
  const steps = new Map<string, string[]>();
  const add = (agent: string, lines: string[]) => steps.set(agent, [...(steps.get(agent) ?? []), ...lines]);

  for (const node of ast.nodes) {
    if (node.type !== "gate") continue;
    const gate = node as GateNode;
    if (!gate.run || gate.behavior === "advisory" || !scriptNameFromRun(gate.run)) continue;
    for (const agent of spawnHeldAgents(ast, gate, p)) {
      add(agent, [
        `    # gate ${gate.id} (after: ${gateAnchors(gate, "after").join(", ") || "-"})`,
        `    bash "$DIR/gate-${gate.id}.sh" >&2 || exit 2`,
      ]);
    }
  }
  for (const node of ast.nodes) {
    if (node.type !== "human") continue;
    const human = node as HumanNode;
    const reason = `Approval step "${human.id}"${human.description ? `: ${human.description}` : ""}`;
    for (const agent of approvalTargets(ast, human)) {
      // A platform with no "ask" decision holds with exit 2 until an approval record exists (CX-11).
      add(agent, p.supportsAsk
        ? [`    # approval step ${human.id}`, `    ask ${shellQuote(reason)}`]
        : [`    # approval step ${human.id}`, `    approved ${shellQuote(human.id)} || need_approval ${shellQuote(human.id)} ${shellQuote(reason)}`]);
    }
  }
  if (steps.size === 0) return null;

  const lines = [
    "#!/usr/bin/env bash",
    `# Before ${p.label} launches a subagent of topology "${name}".`,
    `# Auto-generated by agentopology scaffold. Wired in ${p.hooksFile} as a`,
    p.supportsAsk ? "# PreToolUse hook on the Agent tool. Exit 2 blocks the launch and shows the" : "# PreToolUse hook on the subagent spawn tool. Exit 2 blocks the launch and shows the",
    p.supportsAsk
      ? `# reason to ${p.modelName}; an "ask" decision makes ${p.label} ask the user first.`
      : `# reason to ${p.modelName}. ${p.label} cannot ask, so an approval step holds until a record exists.`,
    "set -euo pipefail",
    ...FAIL_CLOSED,
    ...projectRootLines(p, name, "cd"),
    `DIR="${p.scriptsDir(name)}"`,
    // Bad input must not read as "no agent": a failed hook lets the call through (Codex, probe P10).
    // R-12, F-15, F-14 (every platform): normalized (format characters, case, space, a leading path,
    // trailing punctuation), so " Reviewer ", "re\u200bviewer" and "agents/reviewer:" are still reviewer.
    `AGENT=$(jq -er '(${p.payload.subagentType} // "") | strings | ${JQ_AGENT_NORM}') || { echo "agentopology: the hook input is not valid JSON, so the launch is blocked" >&2; exit 2; }`,
    "",
    ...(p.supportsAsk
      ? [
          "ask() {",
          "  jq -n --arg r \"$1\" '{hookSpecificOutput: {hookEventName: \"PreToolUse\", permissionDecision: \"ask\", permissionDecisionReason: $r}}'",
          "}",
          "",
        ]
      : hasHuman(ast)
        ? [
            `APPROVALS="${p.stateDir}/approvals.jsonl"`,
            "# approved STEP: the last record for STEP in the approvals file must have ok: true. Any error reads as not approved.",
            `approved() { [ -f "$APPROVALS" ] && [ "$(jq -rs --arg s "$1" '[.[] | select(.step == $s)] | last | (.ok == true)' "$APPROVALS" 2>/dev/null)" = true ]; }`,
            "need_approval() {",
            '  echo "agentopology: $2 has no approval yet, so this agent is not started." >&2',
            // R-11: stderr goes to the model; it is told who approves and where, never handed the command (AGENTS.md has the format).
            `  echo "agentopology: a person must approve step $1 by adding a record to ${p.stateDir}/approvals.jsonl, as AGENTS.md (Human Checkpoints) describes. The model must not write that record; ask the person." >&2`,
            "  exit 2",
            "}",
            "",
          ]
        : []),
    'case "$AGENT" in',
  ];
  for (const [agent, body] of steps) {
    lines.push(`  ${agent})`, ...body, "    ;;");
  }
  lines.push("esac", FAIL_CLOSED_DONE, "exit 0", "");
  return {
    path: `${p.scriptsDir(name)}/before-agent.sh`,
    content: lines.join("\n"),
    category: "script",
    executable: true,
  };
}

/**
 * A gate before a script step that the generated guard can check: it has a
 * ledger to read, or a `run:` script to run. A gate with neither has nothing
 * to check (V110) and gets no line.
 */
export function checkableActionGate(ast: TopologyAST, gate: GateNode): boolean {
  if (gate.behavior === "advisory") return false;
  if (guardedActions(ast, gate).length === 0) return false;
  return !!gateLedger(ast, gate) || !!scriptNameFromRun(gate.run);
}

/** A placeholder word in a step's command: ALL-CAPS (`EP`, `PID`, `OUT.mp4`), or holding < > { } [ ] (E-3). */
export function isPlaceholderWord(word: string): boolean {
  return /^[A-Z0-9_]*[A-Z][A-Z0-9_]*(\.[A-Za-z0-9]+)*$/.test(word) || /[<>{}[\]]/.test(word);
}

/**
 * The words a guard matches a step's command on (E-3): the command with quotes
 * dropped and spaces made single, cut before its first placeholder word, since
 * the real call fills those in (`./media episode render EP.json OUT.mp4` is
 * matched as `./media episode render`). `cut` is true when a placeholder was
 * dropped. A command whose program itself is a placeholder is kept whole.
 */
export function stepMatchWords(command: string): { words: string; cut: boolean } {
  const all = command.trim().replace(/["'\\]/g, "").split(/\s+/).filter(Boolean);
  const at = all.findIndex(isPlaceholderWord);
  if (at <= 0) return { words: all.join(" "), cut: false };
  return { words: all.slice(0, at).join(" "), cut: true };
}

/**
 * The shell functions the step matcher is built from (F-batch): one source for before-action.sh
 * and the Codex `if:` filter, so the two never read a command differently. bash 3.2 safe.
 */
export const MATCH_FUNCTIONS: string[] = [
  "lower() { printf '%s' \"$1\" | tr '[:upper:]' '[:lower:]'; }",
  "letters() { printf '%s' \"$1\" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9'; }",
  "strip_redir() {",
  "  local t=$1 re='(&>>|&>|>>|>\\||>&|<&|<<<|<<-|<<|<>|>|<)[[:space:]]*[^[:space:];&|()<>]*'",
  "  while [[ $t =~ $re ]]; do t=${t/\"${BASH_REMATCH[0]}\"/ }; done",
  "  printf '%s' \"$t\"",
  "}",
  "norm() {",
  "  local t=$1",
  "  t=${t//\\\"/}; t=${t//\\'/}; t=${t//\\\\/}; t=${t//$'\\t'/ }; t=${t//$'\\r'/ }",
  "  while [[ \"$t\" == *'  '* ]]; do t=${t//'  '/' '}; done",
  "  printf ' %s ' \"${t# }\"",
  "}",
  "# Where bash runs a program in a segment: after variable assignments and these words.",
  "AT_LEAD=\" if then elif else while until do ! { time \"",
  "# Programs that only read or print their arguments, never run them (unless a flag below says so).",
  "AT_READS=\" cat ls head tail wc echo printf grep egrep fgrep rg ag stat file diff cmp md5sum sha1sum sha256sum shasum du tree realpath basename dirname readlink test [ true false bat jq \"",
  "# git subcommands that read or record, run with none of the flags that make git run a command.",
  "AT_GIT_READS=\" status diff log show add commit blame ls-files grep restore rm mv branch tag \"",
  "at_special() { [[ $1 == *[\\$\\`\\*\\?\\[\\{\\~]* ]]; }",
  "# at_names WORD KEY: WORD runs the tool KEY: its name at any path, or a glob or brace list that could be it.",
  "at_names() {",
  "  local w=$1 key=$2 b=${1##*/} part lit",
  "  [ \"$b\" = \"$key\" ] && return 0",
  "  if [[ $w == *'{'*','* ]]; then",
  "    for part in ${w//[\\{\\},]/ }; do [ \"${part##*/}\" = \"$key\" ] && return 0; done",
  "  fi",
  "  if [[ $b == *[\\*\\?\\[]* ]]; then",
  "    lit=$(letters \"$b\")",
  "    if [ \"${#lit}\" -ge 2 ] && [[ $key == $b ]]; then return 0; fi",
  "  fi",
  "  return 1",
  "}",
  "# at_runs_args BASE: the program reads its arguments only (no word of the segment makes it run one).",
  "at_reads_only() {",
  "  local base=$1 x sub=\"\"; shift",
  "  for x in \"$@\"; do",
  "    case $x in -c|-c*|-x|-e|--exec*|--extcmd*|--command*|--eval*|--pre|--pre=*|--ext-diff|+*|*alias*|'!'*) return 1 ;; esac",
  "  done",
  "  if [ \"$base\" = git ]; then",
  "    for x in \"$@\"; do case $x in run|exec|--exec*) return 1 ;; esac; done",
  "    for x in \"$@\"; do case $x in -*) ;; *) sub=$x; break ;; esac; done",
  "    [[ \"$AT_GIT_READS\" == *\" $sub \"* ]]",
  "    return",
  "  fi",
  "  [[ \"$AT_READS\" == *\" $base \"* ]]",
  "}",
  "# seg_steps SEG KEY REST: sets SEG_N to how often SEG runs the step (tool KEY, then the REST words in",
  "# order), and SEG_DOUBT=1 when a run of the tool cannot be read (an expansion or glob among its words).",
  "seg_steps() { set +u; _seg_steps \"$@\"; set -u; }",
  "_seg_steps() {",
  "  local key=$2 kl n p i j k base",
  "  local -a w r cand",
  "  read -ra w <<< \"$1\"; read -ra r <<< \"$3\"",
  "  n=${#w[@]}; SEG_N=0; kl=$(letters \"$key\"); cand=()",
  "  p=0",
  "  while [ \"$p\" -lt \"$n\" ]; do",
  "    if [[ ${w[p]} =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then",
  "      # a variable set to the tool: its later use cannot be read",
  "      at_names \"${w[p]#*=}\" \"$key\" && SEG_DOUBT=1",
  "    elif [[ \"$AT_LEAD\" != *\" ${w[p]} \"* ]]; then",
  "      break",
  "    fi",
  "    p=$((p+1))",
  "  done",
  "  [ \"$p\" -lt \"$n\" ] || return 0",
  "  base=${w[p]##*/}",
  "  if at_names \"${w[p]}\" \"$key\"; then",
  "    cand=(\"$p\")",
  "  elif at_special \"${w[p]}\"; then",
  "    # the program itself is an expansion: it may be the tool",
  "    if [[ $(letters \"${w[p]}\") == *\"$kl\"* ]] || { [[ ${w[p]} == '$'* || ${w[p]} == '`'* ]] && [[ $CMD_L == *\"$kl\"* ]]; }; then SEG_DOUBT=1; fi",
  "    return 0",
  "  elif at_reads_only \"$base\" \"${w[@]:p+1}\"; then",
  "    return 0",
  "  elif [ \"$base\" = find ]; then",
  "    # find runs a command only after -exec/-execdir/-ok/-okdir: everything after the first one is scanned",
  "    k=0",
  "    for ((j=p+1; j<n; j++)); do",
  "      case ${w[j]} in -exec|-execdir|-ok|-okdir) k=1; continue ;; esac",
  "      [ \"$k\" = 1 ] && at_names \"${w[j]}\" \"$key\" && cand+=(\"$j\")",
  "    done",
  "  else",
  "    # an interpreter, a program that can run its arguments, or one not known: the tool anywhere after it",
  "    for ((j=p+1; j<n; j++)); do at_names \"${w[j]}\" \"$key\" && cand+=(\"$j\"); done",
  "  fi",
  "  for i in \"${cand[@]}\"; do",
  "    for ((j=i; j<n; j++)); do at_special \"${w[j]}\" && SEG_DOUBT=1; done",
  "    j=$((i+1)); k=0",
  "    while [ \"$k\" -lt \"${#r[@]}\" ] && [ \"$j\" -lt \"$n\" ]; do",
  "      [ \"${w[j]}\" = \"${r[k]}\" ] && k=$((k+1))",
  "      j=$((j+1))",
  "    done",
  "    [ \"$k\" -eq \"${#r[@]}\" ] || continue",
  "    if [ \"$j\" -eq $((n-1)) ] && [[ \" --help -h --version \" == *\" ${w[j]} \"* ]]; then continue; fi",
  "    SEG_N=$((SEG_N+1))",
  "  done",
  "  return 0",
  "}",
];

/**
 * canon PATH (F-12): one source for the Codex `if:` filter and before-edit.sh. It needs $ROOT, the
 * project root, and sets $CROOT.
 */
export const CANON_FUNCTION: string[] = [
  "# canon PATH (F-12): the path made absolute (from $PWD; /proc/self/cwd is the root), with `.`, `..` and",
  "# `//` resolved lexically, then relative to the project root when it is inside it.",
  "canon() {",
  '  local v=$1 part out=""',
  '  case "$v" in /proc/self/cwd) v=$ROOT ;; /proc/self/cwd/*) v="$ROOT/${v#/proc/self/cwd/}" ;; /*) ;; *) v="$PWD/$v" ;; esac',
  "  local IFS=/; set -f # always called in $(...): neither leaks out",
  "  for part in $v; do",
  '    case "$part" in ""|.) ;; ..) out="${out%/*}" ;; *) out="$out/$part" ;; esac',
  "  done",
  '  [ -n "$out" ] || out=/',
  '  case "$out" in "$CROOT") out=. ;; "$CROOT"/*) out="${out#"$CROOT"/}" ;; esac',
  "  printf '%s' \"$out\"",
  "}",
  'CROOT=/; CROOT="$(ROOT=/ PWD=/ canon "$ROOT")"',
];

/** What a grade says, on the grade itself, for a step whose check reads a ledger the agent can write (F-4). */
export const LEDGER_WRITABLE_NOTE = "ledger agent-writable until the signed gate";

/** A file a guard trusts that the agent could write (F-4): a gate's ledger, or the Codex approval record. */
export interface ProtectedLedger {
  /** The project-relative path as declared (`logs/{unit}/trace.jsonl`), for messages. */
  path: string;
  /** The path as a shell pattern, `{unit}` made `*` and the rest quoted. */
  glob: string;
  /** The file name as a shell pattern. */
  name: string;
  /** The letters of the file name (`tracejsonl`): the fallback a quoted or split name cannot hide from. */
  letters: string;
}

/** A path with `{unit}` as a shell `case` pattern: `*` for the unit, every other part quoted. */
function unitPattern(path: string): string {
  return path.split("{unit}").map((part) => (part ? shellQuote(part) : "")).join("*");
}

/**
 * Every ledger a gate of this topology reads, and, on a platform that cannot ask, the approvals file a
 * human step reads (F-4). The guards refuse a command or an edit that names one; until the signed gate
 * these files are the gap. Empty when the topology has neither.
 */
export function protectedLedgers(ast: TopologyAST, p: GuardPlatform): ProtectedLedger[] {
  const paths: string[] = [];
  for (const node of ast.nodes) {
    if (node.type !== "gate") continue;
    const rec = gateLedger(ast, node as GateNode);
    if (rec) paths.push(rec.path.replace(/^\.\//, ""));
  }
  if (!p.supportsAsk && hasHuman(ast)) paths.push(`${p.stateDir}/approvals.jsonl`);
  return [...new Set(paths)].map((path) => {
    const base = path.replace(/^.*\//, "");
    const strip = (t: string) => t.replace(/\{unit\}/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
    return { path, glob: unitPattern(path), name: unitPattern(base), letters: strip(base) || strip(path) };
  });
}

/**
 * The before-action.sh lines that refuse a command naming a ledger (F-4): its pattern among the words,
 * or its file name's letters anywhere in the command's letters. Reading stays allowed: every program in
 * the command only reads its arguments (AT_READS, a reading git subcommand) and the command holds no
 * `>` and no `tee`. Needs MATCH_FUNCTIONS, $CMD, $CMD_L and $SEGS, and runs under `set -f`.
 */
function ledgerGuardLines(ledgers: ProtectedLedger[]): string[] {
  if (ledgers.length === 0) return [];
  return [
    "# F-4: a gate's ledger is a file the agent could write. A command that names one is refused unless it",
    "# only reads it. Not seen: a ledger reached through a variable set elsewhere, or another script.",
    "at_only_reads() {",
    "  local seg x base; local -a ws",
    "  [[ $CMD != *'>'* && $(lower \"$(norm \"$CMD\")\") != *tee* ]] || return 1",
    "  while IFS= read -r seg || [ -n \"$seg\" ]; do",
    "    read -ra ws <<< \"$(lower \"$(norm \"$seg\")\")\"",
    "    x=0",
    "    while [ \"$x\" -lt \"${#ws[@]}\" ] && [[ \"$AT_LEAD\" == *\" ${ws[x]} \"* ]]; do x=$((x+1)); done",
    "    [ \"$x\" -lt \"${#ws[@]}\" ] || continue",
    "    [[ ${ws[x]} =~ ^[a-z_][a-z0-9_]*= ]] && return 1",
    "    at_special \"${ws[x]}\" && return 1",
    "    base=${ws[x]##*/}",
    "    at_reads_only \"$base\" \"${ws[@]:x+1}\" || return 1",
    "  done <<< \"$SEGS\"",
    "  return 0",
    "}",
    "# ledger_guard 'PATTERN' LETTERS PATH: refuse the command when it names the ledger and does more than read it.",
    "ledger_guard() {",
    "  local hit=0 w",
    "  for w in $(norm \"$CMD\"); do eval \"case \\$w in $1|*/$1) hit=1 ;; esac\"; done",
    "  [[ $CMD_L == *\"$2\"* ]] && hit=1",
    "  [ \"$hit\" = 1 ] || return 0",
    "  set +u; if at_only_reads; then set -u; return 0; fi; set -u",
    "  echo \"agentopology: the command touches the gate ledger $3; only the gate's own step writes it ($CMD)\" >&2",
    "  exit 2",
    "}",
    ...ledgers.map((l) => `ledger_guard ${shellQuote(l.glob)} ${shellQuote(l.letters)} ${shellQuote(l.path)}`),
    "",
  ];
}

/**
 * One PreToolUse hook on the file-edit tools (F-4): an edit whose path, made project-relative, matches
 * a ledger's pattern, or whose file name is a ledger's, is refused (exit 2). Claude Code sends the path
 * in `tool_input.file_path` (`notebook_path` for NotebookEdit); Codex sends apply_patch with the patch
 * text in `tool_input.command`, and every file it adds, updates, deletes or moves to is read, the way
 * the `if:` filter reads them. Input it cannot read blocks. Null when the topology has no ledger.
 */
export function generateBeforeEditScript(ast: TopologyAST, p: GuardPlatform): GeneratedFile | null {
  const ledgers = protectedLedgers(ast, p);
  if (ledgers.length === 0) return null;
  const name = ast.topology.name;
  const v = p.projectDirVar;
  const lines = [
    "#!/usr/bin/env bash",
    `# Before ${p.label} edits a file in a project of topology "${name}" (F-4).`,
    `# Auto-generated by agentopology scaffold. Wired in ${p.hooksFile} as a PreToolUse hook on`,
    `# ${p.supportsAsk ? "Write|Edit|MultiEdit|NotebookEdit" : "apply_patch"}. A gate's ledger is a file the agent could write, so an edit`,
    `# of one is refused (exit 2, the reason on stderr to ${p.modelName}). Input it cannot read blocks too.`,
    "set -euo pipefail",
    ...FAIL_CLOSED,
    'command -v jq >/dev/null 2>&1 || { echo "agentopology: jq is required to check this edit, so it is blocked" >&2; exit 2; }',
    ...(v === null
      ? [`ROOT="$(cd "$(dirname "\${BASH_SOURCE[0]}")/${upToRoot(p, name)}" && pwd)"`]
      : [
          `if [ -z "\${${v}:-}" ]; then echo "agentopology: ${v} is not set, so this edit cannot be checked and is blocked" >&2; exit 2; fi`,
          `ROOT="$(cd "$${v}" && pwd)"`,
        ]),
    "INPUT=$(cat)",
    '[ -n "$INPUT" ] || { echo "agentopology: the hook input is empty, so the edit is blocked" >&2; exit 2; }',
    "TOOL=$(printf '%s' \"$INPUT\" | jq -er '.tool_name | strings') || { echo \"agentopology: the hook input is not valid JSON, so the edit is blocked\" >&2; exit 2; }",
    'if [ "$TOOL" = apply_patch ]; then',
    "  PATCH=$(printf '%s' \"$INPUT\" | jq -er '.tool_input | objects | (.command // .input // .patch) | strings') || { echo \"agentopology: no patch text could be read, so the edit is blocked\" >&2; exit 2; }",
    "  PATHS=$(printf '%s\\n' \"$PATCH\" | sed -nE 's/^\\*\\*\\* (Add File|Update File|Delete File|Move to): (.*[^[:space:]])[[:space:]]*$/\\2/p')",
    "else",
    "  PATHS=$(printf '%s' \"$INPUT\" | jq -er '.tool_input | objects | (.file_path // .notebook_path // .path) | strings') || PATHS=''",
    "fi",
    '[ -n "$PATHS" ] || { echo "agentopology: no file path could be read from the edit, so it is blocked" >&2; exit 2; }',
    ...CANON_FUNCTION,
    "refuse() { echo \"agentopology: the edit touches the gate ledger $1 ($2); only the gate's own step writes it\" >&2; exit 2; }",
    "while IFS= read -r P || [ -n \"$P\" ]; do",
    '  [ -n "$P" ] || continue',
    '  R="$(canon "$P")"',
  ];
  for (const l of ledgers) {
    lines.push(`  case "$R" in ${l.glob}) refuse ${shellQuote(l.path)} "$R" ;; esac`);
    lines.push(`  case "\${R##*/}" in ${l.name}) refuse ${shellQuote(l.path)} "$R" ;; esac`);
  }
  lines.push('done <<< "$PATHS"', FAIL_CLOSED_DONE, "exit 0", "");
  return { path: `${p.scriptsDir(name)}/before-edit.sh`, content: lines.join("\n"), category: "script", executable: true };
}

/** Programs that run a script: for these the step's tool is the script, not the program (F-21). */
const INTERPRETERS = /^(python[0-9.]*|pypy[0-9.]*|node|nodejs|bash|sh|zsh|dash|ksh|ruby|perl|php|deno|bun|tsx|ts-node|uv|poetry|pipx|npx|pnpm|yarn)$/;

/**
 * The tool a step runs and the words that must follow it (F-batch): the program's
 * name with its path dropped, or for an interpreter (`python3 -u x.py`, `uv run x.py`)
 * the script's name. Lower case; the words are cut before the first placeholder (E-3).
 */
export function stepKey(command: string): { key: string; rest: string } {
  const words = stepMatchWords(command).words.split(" ").filter(Boolean);
  const base = (w: string) => w.replace(/^.*\//, "").toLowerCase();
  let i = 0;
  if (words.length > 1 && INTERPRETERS.test(base(words[0]))) {
    i = 1;
    while (i < words.length - 1 && (words[i].startsWith("-") || ["run", "exec", "x"].includes(words[i]))) i++;
  }
  return { key: base(words[i] ?? ""), rest: words.slice(i + 1).join(" ").toLowerCase() };
}

/** Every action a gate guards, with its gates, in declaration order. */
function actionGuards(ast: TopologyAST): Array<{ action: ActionNode; gates: GateNode[] }> {
  const gates = ast.nodes.filter((n): n is GateNode => n.type === "gate").filter((g) => checkableActionGate(ast, g));
  const out: Array<{ action: ActionNode; gates: GateNode[] }> = [];
  for (const node of ast.nodes) {
    if (node.type !== "action") continue;
    const mine = gates.filter((g) => guardedActions(ast, g).some((a) => a.id === node.id));
    if (mine.length > 0) out.push({ action: node as ActionNode, gates: mine });
  }
  return out;
}

/**
 * One PreToolUse hook on Bash for the whole topology: before Claude Code runs
 * a script step's command, the gates that stand before that step are checked.
 * A gate with a ledger lets the command through only when the LAST ledger line
 * for its `after:` step (and the command's unit) is ok; a gate with `run:` also
 * runs its wrapper. Null when no gate guards a script step.
 *
 * Why a hook and not a note in the playbook: V25 used to say "invoke the gate
 * from your playbook", and a session that skipped it ran the step anyway. A
 * hook only covers Claude Code sessions; a script run from a terminal checks
 * itself with `agentopology step check`.
 */
export function generateBeforeActionScript(ast: TopologyAST, p: GuardPlatform): GeneratedFile | null {
  const guards = actionGuards(ast);
  // F-4: a topology with a ledger (or, on Codex, an approval step) gets the ledger check even with no guarded step.
  const ledgers = protectedLedgers(ast, p);
  if (guards.length === 0 && ledgers.length === 0) return null;
  const name = ast.topology.name;

  const lines = [
    "#!/usr/bin/env bash",
    `# Before ${p.label} runs a script step of topology "${name}".`,
    `# Auto-generated by agentopology scaffold. Wired in ${p.hooksFile} as a`,
    `# PreToolUse hook on Bash. Exit 2 blocks the command and shows stderr to ${p.modelName}.`,
    "# A ledger is JSON Lines: {\"step\": \"<id>\", \"unit\": \"<unit>\", \"ok\": true, \"at\": \"<ISO time>\"}.",
    `# Covers ${p.label} sessions only; a step run outside ${p.outsideName} calls`,
    "# `agentopology step check` itself.",
    "set -euo pipefail",
    ...FAIL_CLOSED,
    'command -v jq >/dev/null 2>&1 || { echo "agentopology: jq is required to check this step, so it is blocked" >&2; exit 2; }',
    ...projectRootLines(p, name, "strict"),
    `DIR="${p.scriptsDir(name)}"`,
    `CMD=$(jq -er '${p.payload.command} // ""') || { echo "agentopology: the hook input is not valid JSON, so the command is blocked" >&2; exit 2; }`,
    "",
    "deny() { echo \"agentopology: gate $1 refuses this command ($CMD): $2\" >&2; exit 2; }",
    "",
    "# check_ledger GATE STEP LEDGER-PATH UNIT: the last line for STEP (and UNIT) must be ok.",
    "check_ledger() {",
    "  local gate=$1 step=$2 tmpl=$3 unit=$4 path ok",
    '  if [[ "$tmpl" == *"{unit}"* ]]; then',
    '    [ -n "$unit" ] || deny "$gate" "step \\"$step\\" must have finished ok, but no unit could be read from the command to find its ledger $tmpl"',
    '    path="${tmpl//\\{unit\\}/$unit}"',
    "  else",
    '    path="$tmpl"',
    "  fi",
    '  [ -f "$path" ] || deny "$gate" "step \\"$step\\" has no ok record for unit \\"$unit\\": the ledger $path does not exist"',
    "  ok=$(jq -rs --arg step \"$step\" --arg unit \"$unit\" '[.[] | select(.step == $step and ($unit == \"\" or .unit == $unit))] | last | (.ok == true)' \"$path\") \\",
    '    || deny "$gate" "step \\"$step\\" for unit \\"$unit\\": the ledger $path could not be read"',
    '  [ "$ok" = true ] || deny "$gate" "step \\"$step\\" has no ok record for unit \\"$unit\\" in ledger $path (its last record must have ok: true)"',
    "}",
    "",
    "# The command is read as bash reads it, as far as a guard can, and what it cannot read is refused (F-batch):",
    "# - a backslash at a line end joins the next line;",
    "# - redirections (`>out`, `2>&1`, `<<<x`, `< f`) are dropped before the command is cut, so they neither",
    "#   split a step's words nor cut the command at the `&` of `2>&1`;",
    "# - the command is cut into segments at `&` `|` `;` `(` `)` backticks and newlines; in each, quotes and",
    "#   backslashes are dropped, spaces made single, letters made lower case;",
    "# - a step is the tool's name (its program, or for an interpreter such as python3 or node, its script),",
    "#   by any path, followed later in the segment by the step's words in order (`./tool -v publish` counts);",
    "#   `<step> --help` (or -h, --version) as the whole tail only asks for usage and is no step;",
    "# - the tool is looked for where bash runs a program: after variable assignments and if/then/while/do/!/{/time,",
    "#   or as an interpreter's script. A program that only reads its arguments (cat, ls, grep, echo, a reading git",
    "#   subcommand, ...) runs no step; one that can run its arguments (sudo, xargs, env, timeout, find -exec, an",
    "#   unknown program) is scanned for the tool;",
    "# - DENY ON DOUBT: an expansion or glob among the tool's own words, a program that is itself an expansion",
    "#   naming the tool, a variable set to the tool, or a command substitution hiding a mention of the tool:",
    "#   the step is treated as unreadable: refused when it has a unit, checked as a step otherwise.",
    "# Not seen: a step reached through a variable set elsewhere, an alias, a function, or another script.",
    "CMD=${CMD//$'\\\\\\n'/}",
    ...MATCH_FUNCTIONS,
    "# key_count LETTERS: how often the tool's letters appear in the whole command's letters.",
    "CMD_L=$(letters \"$CMD\")",
    "key_count() { local t=$CMD_L n=0; while [[ $t == *\"$1\"* ]]; do t=${t#*\"$1\"}; n=$((n+1)); done; echo \"$n\"; }",
    "CMD_SUBST=0",
    "[[ $CMD == *'$('* || $CMD == *'`'* ]] && CMD_SUBST=1",
    "set -f",
    "SEGS=$(strip_redir \"$CMD\")",
    "for sep in '&' '|' ';' '(' ')' '`'; do SEGS=${SEGS//\"$sep\"/$'\\n'}; done",
    "UNIT=''",
    "",
    ...ledgerGuardLines(ledgers),
  ];
  const sq = shellQuote;
  // Pass 1: how often each step is read plainly, so the doubt rule can tell a mention it could not read.
  guards.forEach(({ action }, a) => {
    const keys = [...new Map((action.commands ?? []).map((c) => { const k = stepKey(c); return [`${k.key} ${k.rest}`, k]; })).values()];
    lines.push(`N${a}=0`);
    lines.push("while IFS= read -r -u 3 C || [ -n \"$C\" ]; do");
    lines.push('  L=$(lower "$(norm "$C")")');
    for (const k of keys) lines.push(`  seg_steps "$L" ${sq(k.key)} ${sq(k.rest)}; N${a}=$((N${a} + SEG_N))`);
    lines.push('done 3<<< "$SEGS"');
  });
  lines.push("");
  for (const [a, { action, gates }] of guards.entries()) {
    const keys = [...new Map((action.commands ?? []).map((c) => { const k = stepKey(c); return [`${k.key} ${k.rest}`, k]; })).values()];
    const names = [...new Set(keys.map((k) => k.key))];
    const gateChecks = (indent: string) => {
      const out: string[] = [];
      for (const gate of gates) {
        out.push(`${indent}# gate ${gate.id} (after: ${gateAnchors(gate, "after").join(", ") || "-"})`);
        const ledger = gateLedger(ast, gate);
        if (ledger) {
          for (const step of gateAnchors(gate, "after")) {
            out.push(`${indent}check_ledger ${sq(gate.id)} ${sq(step)} ${sq(ledger.path.replace(/^\.\//, ""))} "$UNIT"`);
          }
        }
        if (scriptNameFromRun(gate.run)) {
          out.push(`${indent}bash "$DIR/gate-${gate.id}.sh" </dev/null >&2 || deny ${sq(gate.id)} "its check script failed"`);
        }
      }
      return out;
    };
    const unreadable = (why: string, indent: string) => action.unitFrom
      ? [`${indent}deny ${sq(gates[0].id)} "it names ${names.join("/")} in a form this guard cannot read (${why}); write the step as a plain command"`]
      : [`${indent}UNIT=''`, ...gateChecks(indent)];
    lines.push(`# step ${action.id}`);
    // The whole command: a mention of the tool that no plain read accounts for.
    const doubt = names.map((n) => `[ "$(key_count ${sq(n.replace(/[^a-z0-9]/g, ""))})" -gt "$N${a}" ]`).join(" || ");
    lines.push(`if [ "$CMD_SUBST" = 1 ] && { ${doubt}; }; then`, ...unreadable("a command substitution", "  "), "fi");
    lines.push("while IFS= read -r -u 3 C || [ -n \"$C\" ]; do", '  C=$(norm "$C")', '  [ "$C" != "  " ] || continue', '  L=$(lower "$C")');
    lines.push("  SEG_DOUBT=0; T=0");
    for (const k of keys) lines.push(`  seg_steps "$L" ${sq(k.key)} ${sq(k.rest)}; T=$((T + SEG_N))`);
    lines.push('  if [ "$SEG_DOUBT" = 1 ]; then', ...unreadable("an expansion or glob among the tool's words", "    "), "  fi");
    lines.push('  if [ "$T" -gt 0 ]; then');
    if (action.unitFrom) {
      // Every unit the segment names needs its own ok record (F-5): a second step must not ride the first's.
      lines.push(
        `    UNITS=$(jq -nr --arg c "$C" --arg re ${sq(action.unitFrom)} '[$c | match($re; "g") | .captures[0].string // empty] | if length == 0 then [""] else . end | .[]') || deny ${sq(gates[0].id)} "unit-from does not compile"`,
        "    while IFS= read -r UNIT <&4 || [ -n \"$UNIT\" ]; do",
        '      if ! [[ "$UNIT" =~ ^[A-Za-z0-9_.@+-]*$ ]] || [[ "$UNIT" == *..* ]]; then',
        `        deny ${sq(gates[0].id)} "the unit \\"$UNIT\\" read from the command is not a safe file name"`,
        "      fi",
        ...gateChecks("      "),
        '    done 4<<< "$UNITS"',
      );
    } else {
      lines.push("    UNIT=''", ...gateChecks("    "));
    }
    lines.push("  fi", 'done 3<<< "$SEGS"', "");
  }
  lines.push("", FAIL_CLOSED_DONE, "exit 0", "");
  return {
    path: `${p.scriptsDir(name)}/before-action.sh`,
    content: lines.join("\n"),
    category: "script",
    executable: true,
  };
}


/** Generate gate wrapper scripts that run validation when agents complete. */
export function generateGateWrapperScripts(
  ast: TopologyAST,
  p: GuardPlatform,
  /** The shell command that runs a gate's `run:` (the binding knows its script layout). */
  gateCommandOf: (run: string, topology: string) => string,
): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const name = ast.topology.name;

  for (const node of ast.nodes) {
    if (node.type !== "gate") continue;
    const gate = node as GateNode;
    if (!gate.run) continue;
    if (gate.behavior === "advisory") continue;

    if (!scriptNameFromRun(gate.run)) continue; // V96: prose in run names no script
    const gateCommand = gateCommandOf(gate.run, name);
    const onFailExit = gate.onFail === "halt"
      ? `echo "Gate '${gate.id}' validation failed. Fix issues before proceeding." >&2\n  exit 2`
      : `echo "Gate '${gate.id}' failed — bounce back and fix the issues." >&2\n  exit 2`;

    const inlineMode = getDelegationMode(ast) === "inline";
    const wiring = gateWiring(ast, gate);
    const wiredAsHook = wiring.kind === "subagent-stop";
    const held = spawnHeldAgents(ast, gate, p);
    let enforcementNote: string;
    let enforcementNote2: string;
    if (checkableActionGate(ast, gate)) {
      enforcementNote = `# Enforcement: PreToolUse hook on Bash (before-action.sh) before ${p.label} runs a command of "${gateAnchors(gate, "before").join('", "')}".`;
      enforcementNote2 = `#              Exit 2 blocks the command and surfaces stderr to ${p.modelName}.`;
    } else if (wiring.kind === "before-agent") {
      enforcementNote = `# Enforcement: PreToolUse hook (before-agent.sh) before ${p.label} launches "${wiring.agents.join('", "')}".`;
      enforcementNote2 = `#              Exit 2 blocks the launch and surfaces stderr to ${p.modelName}.`;
    } else if (inlineMode) {
      enforcementNote = `# Enforcement: NOT wired as a SubagentStop hook (orchestrator.delegation is "inline").`;
      enforcementNote2 = `#              Invoke this script from your /${ast.topology.name} playbook at the right step.`;
    } else if (wiredAsHook && !p.stopCanBlock) {
      // R-1: a SubagentStop hook on this platform reports and cannot block.
      enforcementNote = held.length > 0
        ? `# Enforcement: PreToolUse hook (before-agent.sh) before ${p.label} launches "${held.join('", "')}"; exit 2 blocks the launch.`
        : `# Enforcement: NONE that blocks. ${p.label} runs this when "${gateAnchors(gate, "after").join('", "')}" stops, but a SubagentStop hook cannot block there.`;
      enforcementNote2 = held.length > 0
        ? `#              The SubagentStop hook on "${gateAnchors(gate, "after").join('", "')}" only reports: ${p.label} cannot block a stop.`
        : `#              Invoke this script from your orchestrator playbook before the next step.`;
    } else if (wiredAsHook) {
      enforcementNote = `# Enforcement: SubagentStop hook on agent "${gateAnchors(gate, "after").join('", "')}". Exit 2 blocks the subagent`;
      enforcementNote2 = `#              from stopping (${p.label} prevents stop and surfaces stderr to ${p.modelName}).`;
    } else {
      enforcementNote = `# Enforcement: NOT wired as a SubagentStop hook (after: ${gateAnchors(gate, "after").join(", ") || "<unset>"} is not an agent).`;
      enforcementNote2 = `#              Invoke this script from your orchestrator playbook or a /command at the right step.`;
    }

    // R-1: a platform whose guards no live run has proven says so where it describes the hold.
    if (!p.liveProven && !/NONE|NOT wired/.test(enforcementNote)) enforcementNote = enforcementNote.replace("# Enforcement: ", `# Enforcement (unverified on ${p.label}): `);
    const contentLines = [
      "#!/usr/bin/env bash",
      `# Gate wrapper: ${gate.id}`,
      `# Auto-generated by agentopology scaffold — edit as needed.`,
      enforcementNote,
      enforcementNote2,
      "set -euo pipefail",
      ...FAIL_CLOSED,
      // A platform with no project-dir variable runs the hook in the session's folder; the check path is root-relative.
      ...(p.projectDirVar === null ? projectRootLines(p, name, "cd") : []),
      "",
      "# Gate runs after: " + (gateAnchors(gate, "after").join(", ") || "any"),
      "# Gate runs before: " + (gateAnchors(gate, "before").join(", ") || "any"),
      `# On failure: ${gate.onFail || "halt"}`,
    ];

    if (gate.timeout) {
      contentLines.push(`# Timeout: ${gate.timeout}`);
    }

    if (gate.retry != null && gate.retry > 0) {
      contentLines.push("");
      contentLines.push(`MAX_RETRIES=${gate.retry}`);
      contentLines.push("ATTEMPT=0");
      contentLines.push("GATE_RESULT=1");
      contentLines.push("");
      contentLines.push("while [ $ATTEMPT -le $MAX_RETRIES ] && [ $GATE_RESULT -ne 0 ]; do");
      contentLines.push("  ATTEMPT=$((ATTEMPT + 1))");
      if (gate.timeout) {
        contentLines.push(`  timeout ${gate.timeout} ${gateCommand} && GATE_RESULT=0 || GATE_RESULT=$?`);
      } else {
        contentLines.push(`  ${gateCommand} && GATE_RESULT=0 || GATE_RESULT=$?`);
      }
      contentLines.push('  if [ $GATE_RESULT -ne 0 ] && [ $ATTEMPT -le $MAX_RETRIES ]; then');
      contentLines.push(`    echo "Gate '${gate.id}' attempt $ATTEMPT failed, retrying..."`);
      contentLines.push("    sleep 1");
      contentLines.push("  fi");
      contentLines.push("done");
    } else {
      contentLines.push("");
      contentLines.push("# Run the gate check script");
      contentLines.push(`GATE_RESULT=0`);
      if (gate.timeout) {
        contentLines.push(`timeout ${gate.timeout} ${gateCommand} || GATE_RESULT=$?`);
      } else {
        contentLines.push(`${gateCommand} || GATE_RESULT=$?`);
      }
    }

    contentLines.push("");
    contentLines.push(`if [ "$GATE_RESULT" -ne 0 ]; then`);
    contentLines.push(`  echo "Gate '${gate.id}' FAILED (exit code $GATE_RESULT)"`);
    contentLines.push(`  ${onFailExit}`);
    contentLines.push("fi");
    contentLines.push(FAIL_CLOSED_DONE);
    contentLines.push("");

    const content = contentLines.join("\n");

    files.push({
      path: `${p.scriptsDir(name)}/gate-${gate.id}.sh`,
      content,
      category: "script",
    });
  }

  return files;
}

// ---------------------------------------------------------------------------
// Session guards
// ---------------------------------------------------------------------------

/** jq: trim, lowercase, drop a "<prefix>:" namespace. */
const JQ_NORM = String.raw`gsub("\\A\\s+|\\s+\\z"; "") | ascii_downcase | sub("\\A.*:"; "") | gsub("\\A\\s+|\\s+\\z"; "")`;

/**
 * The agent name a spawn's payload carries, made comparable with an agent id
 * (F-15): zero-width and other format characters dropped (\p{Cf}: U+200B,
 * U+FEFF, U+00AD, bidi marks), surrounding space trimmed, lowercased, trailing
 * punctuation (`reviewer:`) dropped, a leading path (`./`, `agents/`) and a
 * `plugin:` prefix dropped. An empty result (no agent_type, or null) is a
 * default spawn, which no case matches.
 */
const JQ_AGENT_NORM = String.raw`gsub("\\p{Cf}"; "") | gsub("\\A\\s+|\\s+\\z"; "") | ascii_downcase | sub("[\\s:;.,!?]+\\z"; "") | sub("\\A.*/"; "") | sub("\\A.*:"; "") | gsub("\\A\\s+|\\s+\\z"; "")`;

function appendLines(p: GuardPlatform): string[] {
  return [
  "append() { # one JSON line on stdin; never writes through a symlink",
  `  if [ -L ${p.stateDir} ] || [ -L ${p.stateDir}/talk.jsonl ]; then`,
  `    echo "guard: ${p.stateDir}/talk.jsonl or its folder is a symlink; not writing the log" >&2`,
  "    return 1",
  "  fi",
  `  if [ -n \"$(find ${p.stateDir}/talk.jsonl -type f -links +1 2>/dev/null)\" ]; then`,
  `    echo "guard: ${p.stateDir}/talk.jsonl has more than one hard link; not writing the log" >&2`,
  "    return 1",
  "  fi",
  `  mkdir -p ${p.stateDir} && cat >> ${p.stateDir}/talk.jsonl`,
  "}",
  ];
}

export function spawnGuard(topology: string, agents: AgentNode[], p: GuardPlatform): GeneratedFile {
  const ids = agents.map((a) => a.id).join("|");
  const lines = [
    "#!/usr/bin/env bash",
    `# Spawn guard for topology "${topology}": a session agent is started from`,
    `# ${p.sessionsFile}, never launched as a subagent.`,
    "# Auto-generated by agentopology scaffold. PreToolUse hook on Agent|Task;",
    `# exit 2 blocks the launch and shows the reason to ${p.modelName}. A missing or`,
    "# non-object tool_input, or a non-string subagent_type or name, also blocks.",
    "set -euo pipefail",
    ...FAIL_CLOSED,
    "INPUT=$(cat)",
    `AGENT=$(printf '%s' "$INPUT" | jq -er '.tool_input | objects | (if .subagent_type == null then "" else .subagent_type end) | strings | ${JQ_NORM}')`,
    `NAME=$(printf '%s' "$INPUT" | jq -er '.tool_input | objects | (if .name == null then "" else .name end) | strings | ${JQ_NORM}')`,
    'for CAND in "$AGENT" "$NAME"; do',
    '  case "$CAND" in',
    `    ${ids})`,
    `      echo "spawn guard: $CAND runs as its own session; start it from ${p.sessionsFile} and message it, do not launch it as a subagent" >&2`,
    "      exit 2",
    "      ;;",
    "  esac",
    "done",
    FAIL_CLOSED_DONE,
    "exit 0",
    "",
  ];
  return { path: `${p.scriptsDir(topology)}/spawn-guard.sh`, content: lines.join("\n"), category: "script", executable: true };
}

export function talkGuard(topology: string, ast: TopologyAST, p: GuardPlatform): GeneratedFile {
  const sessions = sessionAgentsOf(ast);
  const sessionIds = new Set(sessions.map((a) => a.id));
  const known = new Set(ast.nodes.map((n) => n.id));
  const allowed = new Map<string, string[]>();
  for (const a of sessions) allowed.set(a.id, []);
  for (const e of ast.edges) {
    if (e.isError || !sessionIds.has(e.from) || !known.has(e.to)) continue;
    if (e.from === e.to) continue;
    allowed.set(e.from, [...new Set([...(allowed.get(e.from) ?? []), e.to])]);
  }
  const lines = [
    "#!/usr/bin/env bash",
    `# Talk guard for topology "${topology}": a session may message only the`,
    "# sessions its talk edges name, its own flow targets (such as its subagents)",
    "# and main.",
    "# Auto-generated by agentopology scaffold. PreToolUse hook on SendMessage;",
    "# exit 2 refuses the send. The current session is $AT_SESSION, exported by the",
    `# start line in ${p.sessionsFile}. Every send is appended to`,
    `# ${p.stateDir}/talk.jsonl, a trail and not evidence: whoever can write files can edit it.`,
    "set -euo pipefail",
    ...FAIL_CLOSED,
    ...projectRootLines(p, topology, "fallback"),
    "PAYLOAD=$(cat)",
    "",
    ...appendLines(p),
    "log() { # from to result",
    '  jq -nc --arg from "$1" --arg to "$2" --arg result "$3" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \'{ts: $ts, kind: "send", from: $from, to: $to, result: $result}\' | append',
    "}",
    "",
    'if [ -z "${AT_SESSION:-}" ]; then',
    "  # Not started from sessions.md: allow, and say so.",
    `  TO=$(printf '%s' "$PAYLOAD" | jq -r '((.tool_input | objects | .to | strings | .[0:64]) // "")' 2>/dev/null || true)`,
    '  echo "talk guard: session not started from sessions.md, unguarded" >&2',
    '  log "" "$TO" unguarded || echo "talk log not written" >&2',
    `  ${FAIL_CLOSED_DONE}`,
    "  exit 0",
    "fi",
    "",
    "# From here the guard is fail-closed: a payload it cannot read blocks the send,",
    "# and the refusal is logged. A trailing ' [ref]' (ListAgents' mark for a",
    "# duplicate name) is stripped; anything but A-Z, a-z, 0-9, _ and - is refused.",
    "# Session ids are kebab-case (V113) and, like other flow targets such as subagents, match exactly as declared.",
    'FROM="$AT_SESSION"',
    `# ${p.label} delivers the target twice, as \`to\` and \`recipient\`; which one it`,
    "# routes by is not documented. Use `to`, else `recipient`; if both are present",
    "# and differ after ref strip, trim and lowercase, refuse.",
    String.raw`DISAGREE=$(printf '%s' "$PAYLOAD" | jq -r 'def norm: sub(" \\[[A-Za-z0-9_-]+\\]\\z"; "") | gsub("^\\s+|\\s+$"; "") | ascii_downcase; (.tool_input | objects) as $i | if ($i.to != null and $i.recipient != null) then (if (($i.to | type) == "string") and (($i.recipient | type) == "string") then (($i.to | norm) != ($i.recipient | norm)) else true end) else false end' 2>/dev/null || echo true)`,
    String.raw`TO=$(printf '%s' "$PAYLOAD" | jq -er '.tool_input | objects | (.to // .recipient) | strings | sub(" \\[[A-Za-z0-9_-]+\\]\\z"; "") | if test("\\A[A-Za-z0-9_-]{1,64}\\z") then . else "?" + (.[0:64] | @json) end') || TO="?unreadable"`,
    'if [ "$DISAGREE" != "false" ]; then',
    '  log "$FROM" "$TO" refused || echo "talk log not written" >&2',
    '  echo "talk guard: to and recipient disagree" >&2',
    "  exit 2",
    "fi",
    "OK=0",
    "ALLOWED=",
    'case "$FROM" in',
  ];
  for (const [from, tos] of allowed) {
    const safe = tos.filter((t) => SAFE_TARGET.test(t));
    const sess = [...safe.filter((t) => sessionIds.has(t)), "main"];
    const other = safe.filter((t) => !sessionIds.has(t));
    lines.push(`  ${from})`, `    ALLOWED="${[...safe, "main"].join(" ")}"`, `    case "$TO" in ${sess.join("|")}) OK=1 ;; esac`);
    if (other.length > 0) lines.push(`    case "$TO" in ${other.join("|")}) OK=1 ;; esac`);
    lines.push("    ;;");
  }
  lines.push(
    "esac",
    'if [ "$OK" = 1 ]; then',
    '  log "$FROM" "$TO" allowed || echo "talk log not written" >&2',
    `  ${FAIL_CLOSED_DONE}`,
    "  exit 0",
    "fi",
    'log "$FROM" "$TO" refused || echo "talk log not written" >&2',
    'echo "talk guard: $FROM may not message $TO; its talk edges allow: ${ALLOWED:-none}" >&2',
    "exit 2",
    "",
  );
  return { path: `${p.scriptsDir(topology)}/talk-guard.sh`, content: lines.join("\n"), category: "script", executable: true };
}

/** The file name of the prompt-log script for a deciding session. */
export function promptLogScript(id: string): string {
  return `session-prompt-${id}.sh`;
}

export function promptLog(topology: string, agent: AgentNode, p: GuardPlatform): GeneratedFile {
  const lines = [
    "#!/usr/bin/env bash",
    `# Prompt log for session "${agent.id}", which holds ${agent.decides!.join(", ")}.`,
    "# Auto-generated by agentopology scaffold. UserPromptSubmit hook. A decision",
    "# can arrive here as a message from another session; this records, for each",
    `# prompt, whether it was typed or arrived, in ${p.stateDir}/talk.jsonl (a trail,`,
    "# not evidence), so a human-gate script can tell the two apart. kind is unknown",
    "# unless a non-empty prompt was read. It never blocks (always exit 0).",
    `[ "\${AT_SESSION:-}" = "${agent.id}" ] || exit 0`,
    "PAYLOAD=$(cat 2>/dev/null || true)",
    "KIND=unknown",
    String.raw`PROMPT=$(printf '%s' "$PAYLOAD" | jq -er '.prompt | strings | sub("\\A\\s+"; "") | select(length > 0)' 2>/dev/null) || PROMPT=`,
    'if [ -n "$PROMPT" ]; then',
    '  case "$PROMPT" in',
    '    "<cross-session-message"*) KIND=arrived ;;',
    "    *) KIND=typed ;;",
    "  esac",
    "fi",
    ...projectRootLines(p, topology, "fallback").map((l, i) => (i === 2 ? 'cd "$ROOT" 2>/dev/null || exit 0' : l)),
    ...appendLines(p),
    `jq -nc --arg kind "$KIND" --arg session "${agent.id}" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{ts: $ts, kind: $kind, session: $session}' 2>/dev/null | append 2>/dev/null || true`,
    "exit 0",
    "",
  ];
  return { path: `${p.scriptsDir(topology)}/${promptLogScript(agent.id)}`, content: lines.join("\n"), category: "script", executable: true };
}

