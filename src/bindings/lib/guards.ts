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
    // A platform whose hooks let a failed hook through (Codex, probe P10) must not read bad input as "no agent".
    p.supportsAsk
      ? `AGENT=$(jq -r '${p.payload.subagentType} // ""')`
      // R-12: trimmed and lowercased like spawn-guard, so " Reviewer " is still reviewer.
      : `AGENT=$(jq -er '(${p.payload.subagentType} // "") | strings | ${JQ_NORM}') || { echo "agentopology: the hook input is not valid JSON, so the launch is blocked" >&2; exit 2; }`,
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
  if (guards.length === 0) return null;
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
    "# A Bash command is a list: `cd repo && ./tool publish ep1`, `a; b`, `a || b`, `a | b`, a",
    "# backgrounded `a &`, a subshell or command substitution `(a)`, `$(a)`, `` `a` ``, or several",
    "# lines. It is cut into segments at each of those, and each segment is checked on its own.",
    "# In a segment, quotes and backslashes are dropped and tabs and runs of spaces become one",
    "# space; the step is then seen ANYWHERE in it, as whole words, also when its program is",
    "# named by another path (`/abs/tool` for `./tool`). So a prefix (`if`, `while`, `!`, `sudo`,",
    "# `nice -n 5`, `env -i`, `xargs`, `FOO=1`, `bash -c '...'`, `eval ...`) does not hide it (R-4).",
    "# This over-blocks (an `echo \"./tool publish\"` is refused too while the gate is unmet) and",
    "# never under-blocks what is written out. A step reached through a variable, an alias, a",
    "# function or a script that calls it is not seen.",
    "SEGS=$CMD",
    "for sep in '&' '|' ';' '(' ')' '`'; do SEGS=${SEGS//\"$sep\"/$'\\n'}; done",
    "# norm TEXT: quotes and backslashes dropped, tabs and space runs made one space, padded with a space each side.",
    "norm() {",
    "  local t=$1",
    "  t=${t//\\\"/}; t=${t//\\'/}; t=${t//\\\\/}; t=${t//$'\\t'/ }; t=${t//$'\\r'/ }",
    "  while [[ \"$t\" == *'  '* ]]; do t=${t//'  '/' '}; done",
    "  printf ' %s ' \"${t# }\"",
    "}",
    "# has_step SEGMENT STEP: STEP's words appear in SEGMENT, its program by this path or by any path ending in its name.",
    "has_step() {",
    "  local seg=$1 step=$2 prog rest base",
    "  prog=${step%% *}; rest=${step#\"$prog\"}; base=${prog##*/}",
    "  [[ \"$seg\" == *\" $step \"* || \"$seg\" == *\"/$base$rest \"* || \"$seg\" == *\" $base$rest \"* ]]",
    "}",
    "UNIT=''",
    "",
    "# Segments come in on fd 3 and children get stdin from /dev/null: a check that reads stdin must not swallow the later segments.",
    "while IFS= read -r -u 3 C || [ -n \"$C\" ]; do",
    '  C=$(norm "$C")',
    '  [ "$C" != "  " ] || continue',
  ];
  for (const { action, gates } of guards) {
    // Each command is normalized the same way as the segment (one space between words), and cut before
    // its first placeholder (E-3): the real call fills EP.json, OUT.mp4 and the like in.
    const tests = [...new Set((action.commands ?? []).map((c) => stepMatchWords(c).words))].map((w) => `has_step "$C" ${shellQuote(w)}`);
    lines.push(`  # step ${action.id}`, `  if ${tests.join(" || ")}; then`, "    UNIT=''");
    if (action.unitFrom) {
      lines.push(
        `  UNIT=$(jq -nr --arg c "$C" --arg re ${shellQuote(action.unitFrom)} '$c | match($re) | .captures[0].string // empty') || deny ${shellQuote(gates[0].id)} "unit-from does not compile"`,
        '  if ! [[ "$UNIT" =~ ^[A-Za-z0-9_.@+-]*$ ]] || [[ "$UNIT" == *..* ]]; then',
        `    deny ${shellQuote(gates[0].id)} "the unit \\"$UNIT\\" read from the command is not a safe file name"`,
        "  fi",
      );
    }
    for (const gate of gates) {
      lines.push(`  # gate ${gate.id} (after: ${gateAnchors(gate, "after").join(", ") || "-"})`);
      const ledger = gateLedger(ast, gate);
      if (ledger) {
        for (const step of gateAnchors(gate, "after")) {
          lines.push(`  check_ledger ${shellQuote(gate.id)} ${shellQuote(step)} ${shellQuote(ledger.path.replace(/^\.\//, ""))} "$UNIT"`);
        }
      }
      if (scriptNameFromRun(gate.run)) {
        lines.push(`  bash "$DIR/gate-${gate.id}.sh" </dev/null >&2 || deny ${shellQuote(gate.id)} "its check script failed"`);
      }
    }
    lines.push("  fi", "");
  }
  lines.push('done 3<<< "$SEGS"', "", FAIL_CLOSED_DONE, "exit 0", "");
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

