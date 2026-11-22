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
import { sessionAgentId } from "./entry.js";
import { isWorkflowSeamAgent } from "./seam.js";

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
  /** The tools that run shell commands, as before-action.sh's header names them (0.11.1). */
  shellTools: string;
  /**
   * The tool_name of a PowerShell tool whose payload before-action.sh also reads, or null. Its command
   * is read the bash way, a backslash as a path separator; a mention of the tool not read as a declared step
   * (`./tool @(...)`, `Start-Process ./tool -ArgumentList a,b`) is doubt, refused like a command substitution (0.11.1).
   */
  powershellTool: string | null;
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
  shellTools: "Bash, Monitor and PowerShell",
  powershellTool: "PowerShell",
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
  shellTools: "Bash",
  powershellTool: null,
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

export function isRegisteredSubagentType(ast: TopologyAST, name: string | undefined, p: GuardPlatform = CLAUDE_CODE_GUARDS): boolean {
  if (!name) return false;
  // In Claude Code the entry agent (settings.json `agent`) is the session
  // itself, not a subagent: SubagentStop never fires for it and it is never
  // launched with the Agent tool. MEASURED 19 Nov with `claude --agent
  // manager`: Stop fired with agent_type "manager", SubagentStop did not. The
  // settings key is the same mechanism as --agent (the sub-agents doc: the
  // flag overrides the setting): INFERRED. Codex has no entry agent.
  if (p.id === "claude-code" && name === sessionAgentId(ast)) return false;
  // An `execution: workflow` agent runs inside the workflow script: the
  // claude-code binding writes no agent file for it, so it is no subagent_type
  // there. Codex writes it as an agent.
  return ast.nodes.some(
    (n) => (n.type === "group" || (n.type === "agent" && !runsAsSkill(n as AgentNode) && !(p.id === "claude-code" && isWorkflowSeamAgent(n as AgentNode)))) && n.id === name,
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
  /** `skipped`: `after:` anchors left out because they are the entry agent (the session). */
  | { kind: "subagent-stop"; anchors: string[]; skipped?: string[] }
  | { kind: "before-agent"; agents: string[] }
  | { kind: "none" };

export function gateWiring(ast: TopologyAST, gate: GateNode, p: GuardPlatform = CLAUDE_CODE_GUARDS): GateWiring {
  if (getDelegationMode(ast) === "inline") return { kind: "none" };
  const afters = gateAnchors(gate, "after");
  // The entry agent (Claude Code) is the session: it is left out of the
  // anchors, and the others that are subagents are still wired.
  const session = p.id === "claude-code" ? sessionAgentId(ast) : undefined;
  const live = afters.filter((a) => a !== session);
  const skipped = afters.filter((a) => a === session);
  if (live.length > 0 && live.every((a) => isRegisteredSubagentType(ast, a, p))) {
    return { kind: "subagent-stop", anchors: live, ...(skipped.length > 0 ? { skipped } : {}) };
  }
  const agents = gateAnchors(gate, "before").filter((b) => isRegisteredSubagentType(ast, b, p));
  return agents.length > 0 ? { kind: "before-agent", agents } : { kind: "none" };
}

/** A node id with what it is, for a message: `"finish" (an action with no commands:)`. */
function anchorKind(ast: TopologyAST, id: string, p: GuardPlatform): string {
  const node = ast.nodes.find((n) => n.id === id);
  const kind = !node
    ? "not a declared node"
    : node.type === "agent" && p.id === "claude-code" && id === sessionAgentId(ast)
      ? "the entry agent: it is the session, so SubagentStop never fires for it"
    : node.type === "agent" && p.id === "claude-code" && isWorkflowSeamAgent(node as AgentNode)
      ? "an execution: workflow agent: it runs in the workflow script, not as a subagent"
    : node.type === "agent"
      ? `an agent with runs: ${(node as AgentNode).runs}, so not a subagent`
      : node.type === "action"
        ? (node as ActionNode).commands?.length ? "an action" : "an action with no commands:"
        : `${/^[aeiou]/.test(node.type) ? "an" : "a"} ${node.type}`;
  return `"${id}" (${kind})`;
}

/**
 * Why no generated hook runs a gate on Claude Code (and Codex, which wires
 * gates the same way), or null when one does or the gate is not one a hook
 * runs. A hook runs a gate that is not advisory and whose `run:` names a
 * script when a script step (an action with `commands:`) is in its `before:`
 * (before-action.sh), or {@link gateWiring} is not `none`. Every other such
 * gate gets its wrapper script and nothing that calls it: inline delegation,
 * or no subagent in `after:` (each must be one) and none in `before:`. V135
 * and the binding's scaffold warning share this text. `p` matters for the
 * entry agent: on Claude Code it is the session, not a subagent; Codex has
 * no entry agent, so there it is wired like any other.
 */
export function hooklessGateReason(ast: TopologyAST, gate: GateNode, p: GuardPlatform = CLAUDE_CODE_GUARDS): string | null {
  if (gate.behavior === "advisory" || !scriptNameFromRun(gate.run)) return null;
  if (checkableActionGate(ast, gate)) return null;
  if (gateWiring(ast, gate, p).kind !== "none") return null;
  if (getDelegationMode(ast) === "inline") return 'orchestrator.delegation "inline" (no subagent ever runs)';
  const afters = gateAnchors(gate, "after");
  const befores = gateAnchors(gate, "before");
  const badAfters = afters.filter((a) => !isRegisteredSubagentType(ast, a, p));
  const afterPart = afters.length === 0
    ? "no after: target"
    : `after: ${badAfters.map((a) => anchorKind(ast, a, p)).join(", ")}, not a subagent`;
  const beforePart = befores.length === 0
    ? "no before: target"
    : `before: ${befores.map((b) => anchorKind(ast, b, p)).join(", ")}, not a subagent or a script step`;
  return `${afterPart} and ${beforePart}`;
}

/**
 * The agents whose launch a gate holds on platform `p`: the before-agent
 * wiring's agents, and, where a SubagentStop hook cannot block (Codex), the
 * registered agents in a subagent-stop gate's `before:` (R-1).
 */
export function spawnHeldAgents(ast: TopologyAST, gate: GateNode, p: GuardPlatform): string[] {
  const wiring = gateWiring(ast, gate, p);
  if (wiring.kind === "before-agent") return wiring.agents;
  if (wiring.kind === "subagent-stop" && !p.stopCanBlock) {
    return gateAnchors(gate, "before").filter((b) => isRegisteredSubagentType(ast, b, p));
  }
  return [];
}

function hasHuman(ast: TopologyAST, p: GuardPlatform): boolean {
  return ast.nodes.some((n) => n.type === "human" && approvalTargets(ast, n as HumanNode, p).length > 0);
}

/** Agents a human approval step stands before: its direct flow successors. */
export function approvalTargets(ast: TopologyAST, human: HumanNode, p: GuardPlatform = CLAUDE_CODE_GUARDS): string[] {
  if (getDelegationMode(ast) === "inline") return [];
  const out = ast.edges.filter((e) => e.from === human.id && !e.isError).map((e) => e.to);
  return [...new Set(out)].filter((id) => isRegisteredSubagentType(ast, id, p));
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
    for (const agent of approvalTargets(ast, human, p)) {
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
    ...noJqLines({
      refuse: "agentopology: jq is required to check this launch, so it is blocked",
      pass: "agentopology: jq is not installed; this launch names no gated agent, so it runs. Install jq to check launches.",
      // an agent's name as a word; jq's reading also drops trailing . ! ? (JQ_AGENT_NORM)
      words: [...steps.keys()].map((a) => [a]),
      split: ".!?",
    }),
    // Bad input must not read as "no agent": a failed hook lets the call through (Codex, probe P10).
    // R-12, F-15, F-14 (every platform): normalized (format characters, case, space, a leading path,
    // trailing punctuation), so " Reviewer ", "re\u200bviewer" and "agents/reviewer:" are still reviewer.
    `AGENT=$(jq -er '(${p.payload.subagentType} // "") | strings | ${JQ_AGENT_NORM}') || { echo "agentopology: the hook input is not valid JSON, so the launch is blocked" >&2; exit 2; }`,
    "",
    ...(p.supportsAsk
      ? [
          // D-4: one decision per run. Each approval step adds its reason; one JSON object is printed at the end.
          "ASK=''",
          "ask() { ASK=\"${ASK:+$ASK; }$1\"; }",
          "",
        ]
      : hasHuman(ast, p)
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
  lines.push("esac");
  if (p.supportsAsk) {
    lines.push(
      "if [ -n \"$ASK\" ]; then",
      "  jq -n --arg r \"$ASK\" '{hookSpecificOutput: {hookEventName: \"PreToolUse\", permissionDecision: \"ask\", permissionDecisionReason: $r}}'",
      "fi",
    );
  }
  lines.push(FAIL_CLOSED_DONE, "exit 0", "");
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

/** A gate duration (`30s`, `5m`, `2h`, `1d`) in seconds, or null. */
export function durationSeconds(d: string | undefined): number | null {
  const m = /^(\d+)([smhd])$/.exec(d ?? "");
  return m ? Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2] as "s" | "m" | "h" | "d"] : null;
}

/**
 * The longest a gate's check can run: its timeout once per attempt, plus a
 * one-second pause between attempts. Null when the gate has no timeout (the
 * guard's deadline is then the only bound).
 */
export function gateWorstCase(gate: GateNode): number | null {
  const t = durationSeconds(gate.timeout);
  if (t === null) return null;
  const retry = gate.retry != null && gate.retry > 0 ? gate.retry : 0;
  return t * (retry + 1) + retry;
}

/** Seconds before-action.sh gives a gate check that declares no timeout. */
export const GATE_BUDGET_DEFAULT = 60;
/** Seconds past a declared timeout before before-action.sh stops a check: the wrapper's own `timeout` reports first. */
export const GATE_BUDGET_SLACK = 2;
/** Seconds a before-action hook timeout leaves above the gate budgets: jq, the ledger reads, start-up. */
export const BEFORE_ACTION_MARGIN = 30;
/** The least hook timeout a before-action hook gets, in seconds. */
export const BEFORE_ACTION_MIN_TIMEOUT = 120;

/** How long before-action.sh lets a gate's check run: its worst case plus the slack, or the default. */
export function inlineGateBudget(gate: GateNode): number {
  const worst = gateWorstCase(gate);
  return worst === null ? GATE_BUDGET_DEFAULT : worst + GATE_BUDGET_SLACK;
}

/** The gates whose check script before-action.sh runs, each once. */
export function beforeActionGates(ast: TopologyAST): GateNode[] {
  return [...new Set(actionGuards(ast).flatMap(({ gates }) => gates))].filter((g) => !!scriptNameFromRun(g.run));
}

/**
 * The hook timeout for before-action.sh: each gate check runs at most once per command, for at most its
 * budget, so the sum of the budgets plus a margin bounds the script. Never below {@link BEFORE_ACTION_MIN_TIMEOUT}.
 */
export function beforeActionHookTimeout(ast: TopologyAST): number {
  return Math.max(BEFORE_ACTION_MIN_TIMEOUT, beforeActionBudgetSum(ast) + BEFORE_ACTION_MARGIN);
}

/** The sum of the budgets of the gate checks before-action.sh may run in one command. */
export function beforeActionBudgetSum(ast: TopologyAST): number {
  return beforeActionGates(ast).reduce((s, g) => s + inlineGateBudget(g), 0);
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

/** Where bash runs a program, and the programs and git subcommands that only read (MATCH_FUNCTIONS, the no-jq glob check). */
const PROGRAM_WORDS: string[] = [
  "# Where bash runs a program in a segment: after variable assignments and these words.",
  "AT_LEAD=\" if then elif else while until do ! { time \"",
  "# Programs that only read or print their arguments, never run them (unless a flag below says so).",
  "AT_READS=\" cat ls head tail wc echo printf grep egrep fgrep rg ag stat file diff cmp md5sum sha1sum sha256sum shasum du tree realpath basename dirname readlink test [ true false bat jq get-content gc select-string sls \"",
  "# git subcommands that read or record, run with none of the flags that make git run a command.",
  "AT_GIT_READS=\" status diff log show add commit blame ls-files grep restore rm mv branch tag \"",
];

/**
 * at_stdin_runner WORD (MATCH_FUNCTIONS, the no-jq stdin check): the program word WORD (at_names) runs another
 * program with arguments it reads from standard input or a file, so a step's words can reach that program
 * without being written in the command.
 */
const STDIN_RUNNER_FUNCTION: string[] = [
  "# at_stdin_runner WORD: WORD (at_names) runs another program with arguments it reads from standard input.",
  "at_stdin_runner() {",
  "  local x",
  "  for x in xargs parallel rush xe xjobs; do at_names \"$1\" \"$x\" && return 0; done",
  "  return 1",
  "}",
  "# at_stdin_optarg R X: the option word X, given to the stdin runner R, may take the next word as its value.",
  "# Each runner's own options, letters case-sensitive: so, letters that take no value; sa, letters whose value",
  "# is optional and only attached (xargs -i[str] -l[n] -e[str]); sv, letters that take one, attached or the",
  "# next word; sl, long names that take no value (xargs' --eof and --replace take one only after =; parallel's",
  "# long names in any letter case). In a letter group, a letter that takes a value takes the rest of the word,",
  "# or the next word when it is last. A long option with =VALUE takes no next word. Any other option (an",
  "# abbreviation, a letter not listed, a runner named by a glob, parallel's +X) may take it.",
  "at_stdin_optarg() {",
  "  local x=$2 r i c so= sa= sv= sl=",
  "  r=$(lower \"${1##*/}\"); case $r in *.exe|*.cmd|*.bat|*.com) r=${r%.*} ;; esac",
  "  case $r in",
  "    xargs) so=0oprtx; sa=eil; sv=adEIJLnPRsS",
  "      sl=' null no-run-if-empty verbose interactive exit open-tty show-limits help version eof replace ' ;;",
  "    parallel) so=0MTVXYghkmopqrtuvx; sv=BCDEHIJLNPSUWadjns",
  "      sl=' bar bg bibtex cat cf citation cleanup color color-fail color-failed colorfail colorfailed colour'",
  "      sl+=' colour-fail colour-failed colourfail colourfailed compress controlmaster csv ctag ctrl-c ctrlc dr'",
  "      sl+=' dry-run dryrun embed eta exit fg fifo files files0 filter-host filter-hosts filterhosts gnu group'",
  "      sl+=' hashbang help hgrp hostgroup hostgroups hostgrp interactive keep-order keeporder latest-line'",
  "      sl+=' latestline lb line-buffer line-buffered linebuffer linebuffered link ll max-line-length-allowed'",
  "      sl+=' maxlinelengthallowed nn no-ctrl-c no-ctrlc no-k no-keep-order no-notice no-run-if-empty noctrlc'",
  "      sl+=' nok nokeeporder nonall nonotice norunifempty noswap null number-of-cores number-of-cpus'",
  "      sl+=' number-of-sockets number-of-threads numberofcores numberofcpus numberofsockets numberofthreads'",
  "      sl+=' onall open-tty output-as-files output-as-files0 outputasfiles outputasfiles0 pipe pipe-part'",
  "      sl+=' pipepart plain plus progress quote record-env recordenv regex regexp remove-rec-sep removerecsep'",
  "      sl+=' resume resume-failed resumefailed retry-failed retryfailed round round-robin roundrobin rrs'",
  "      sl+=' semaphore session shebang shell-quote shell_quote shellquote show-limits showlimits shuf silent'",
  "      sl+=' skip-first-line skipfirstline spreadstdin tag tee tmux tmux-pane tmuxpane tollef transfer tty'",
  "      sl+=' ungroup use-cores-instead-of-threads use-cpus-instead-of-cores use-sockets-instead-of-threads'",
  "      sl+=' usecoresinsteadofthreads usecpusinsteadofcores usesocketsinsteadofthreads verbose version wait'",
  "      sl+=' will-cite willcite xapply xargs ' ;;",
  "    rush) so=IRVcehkq; sv=CDJQTWdijnortvw",
  "      sl=' continue dry-run escape eta help immediate-output keep-order pipe print-retry-output'",
  "      sl+=' propagate-exit-status stop-on-error verbose version wait-for-process-regexp ' ;;",
  "    xe) so=0FLRanpqv; sv=AINfjs ;;",
  "    xjobs) so=01NVdehnprt; sv=jlqsv ;;",
  "  esac",
  "  [[ $x == +* ]] && return 0",
  "  if [[ $x == --* ]]; then",
  "    [[ $x == *=* ]] && return 1",
  "    x=${x#--}; [ \"$r\" = parallel ] && x=$(lower \"$x\")",
  "    [[ $sl == *\" $x \"* ]] && return 1",
  "    return 0",
  "  fi",
  "  for ((i=1; i<${#x}; i++)); do",
  "    c=${x:i:1}",
  "    [[ $so == *\"$c\"* ]] && continue",
  "    [[ $sa == *\"$c\"* ]] && return 1",
  "    if [[ $sv == *\"$c\"* ]]; then [ \"$((i+1))\" -eq \"${#x}\" ]; return; fi",
  "    return 0",
  "  done",
  "  return 1",
  "}",
  "# at_stdin_wraps X: the program X runs its own arguments as a command (a wrapper, a shell, find, a stdin runner).",
  "at_stdin_wraps() {",
  "  local x",
  "  for x in env sudo doas nice nohup timeout command exec stdbuf ionice chrt taskset setsid time unbuffer sh bash zsh dash ksh fish busybox find; do",
  "    at_names \"$1\" \"$x\" && return 0",
  "  done",
  "  at_stdin_runner \"$1\"",
  "}",
  "# at_stdin_prog R W...: the words W after the stdin runner R that may be the program R runs: past R's options",
  "# (a word starting with -, or with + for parallel, which reads +X as an option),",
  "# the first word that is no option's value (a word an option may take as its value may be the program too).",
  "# Sets AT_STDIN_CAND to their offsets in W, and AT_STDIN_WRAP to 1 + the offset of the first of them that runs",
  "# its own arguments (at_stdin_wraps), every word after it a possible program as well, or to 0.",
  "at_stdin_prog() {",
  "  local r=$1 j x m=0",
  "  local -a v",
  "  shift; v=(\"$@\"); AT_STDIN_CAND=(); AT_STDIN_WRAP=0",
  "  for ((j=0; j<${#v[@]}; j++)); do",
  "    x=${v[j]}",
  "    if [ \"$m\" = 0 ] && { [[ $x == -?* ]] || { [[ $x == +?* ]] && at_names \"$r\" parallel; }; }; then",
  "      if [ \"$x\" = -- ]; then m=1; elif at_stdin_optarg \"$r\" \"$x\"; then m=2; fi",
  "      continue",
  "    fi",
  "    AT_STDIN_CAND+=(\"$j\")",
  "    [ \"$AT_STDIN_WRAP\" = 0 ] && at_stdin_wraps \"$x\" && AT_STDIN_WRAP=$((j+1))",
  "    [ \"$m\" = 2 ] || return 0",
  "    m=0",
  "  done",
  "  return 0",
  "}",
];

/** The stdin runner check of the step reader (MATCH_FUNCTIONS): its functions, one block of fixed text. */
export const STDIN_JQ_FUNCTIONS: string[] = [
  ...STDIN_RUNNER_FUNCTION,
  "# at_stdin_fed I (in _seg_steps): word I is the program a stdin runner (at_stdin_runner) from the segment's",
  "# program on runs (at_stdin_prog), or comes after one such program that runs its own arguments: the step's",
  "# words may arrive on its standard input, unseen. The tool as another program's argument is not. The runner's",
  "# options are read from the words as written (the caller's segment C; xargs -P takes a value, -p none); when",
  "# those are not the segment's words, it is doubt.",
  "at_stdin_fed() {",
  "  local q o s",
  "  local -a u",
  "  read -ra u <<< \"$(norm \"${C:-}\")\"",
  "  [ \"$(lower \"${u[*]}\")\" = \"${w[*]}\" ] || return 0",
  "  for ((q=p; q<$1; q++)); do",
  "    at_stdin_runner \"${u[q]}\" || continue",
  "    at_stdin_prog \"${u[q]}\" \"${u[@]:q+1}\"",
  "    o=$(($1-q-1))",
  "    [ \"$AT_STDIN_WRAP\" -gt 0 ] && [ \"$o\" -ge \"$AT_STDIN_WRAP\" ] && return 0",
  "    for s in \"${AT_STDIN_CAND[@]}\"; do [ \"$s\" = \"$o\" ] && return 0; done",
  "  done",
  "  return 1",
  "}",
];

/**
 * In _seg_steps, where the step's words do not all follow the tool (fixed text; it replaced the line
 * `[ "$k" -eq "${#r[@]}" ] || continue`): a tool run by a stdin runner is doubt, unless git's own words
 * make it a read.
 */
export const STDIN_JQ_CHECK: string[] = [
  "    if [ \"$k\" -lt \"${#r[@]}\" ]; then",
  "      # the tool is run by a program that reads more arguments from standard input: the step's words may",
  "      # come from there, so it is doubt, unless the tool's own words make it a read (at_git_read)",
  "      if at_stdin_fed \"$i\" && ! at_git_read \"$i\"; then SEG_DOUBT=1; fi",
  "      continue",
  "    fi",
];

/**
 * The no-jq stdin runner check (before-action.sh), fixed text after one line that sets AT_STDIN_TOOLS (the
 * gated tools) and AT_STDIN_GIT_STEPS (the first word of every git step). Needs the no-jq glob check's
 * functions (at_names, at_reads_only, AT_LEAD, AT_GIT_READS) and its readings AT_TS and AT_BS.
 */
export const STDIN_NOJQ_BLOCK: string[] = [
  "# A gated tool run by a stdin runner (a word from the segment's program on): the step's words may come",
  "# from its standard input. Not refused: git with a reading subcommand written out (as the jq check's",
  "# at_git_read reads it), since those words can only follow it. The words keep their letter case, as the",
  "# jq check reads them: a runner's option letters differ by case (xargs -P takes a value, -p none).",
  ...STDIN_RUNNER_FUNCTION,
  "at_stdin_git_read() {",
  "  while [ \"$#\" -gt 0 ]; do case $1 in --no-pager|--no-optional-locks|--no-replace-objects|--literal-pathspecs) shift ;; *) break ;; esac; done",
  "  [ \"$#\" -gt 0 ] || return 1",
  "  [[ $1 != -* && $1 != grep && \"$AT_GIT_READS\" == *\" $1 \"* && \"$AT_STDIN_GIT_STEPS\" != *\" $1 \"* ]] || return 1",
  "  at_reads_only git \"$@\"",
  "}",
  "at_stdin_tool() {",
  "  local k",
  "  for k in \"${AT_STDIN_TOOLS[@]}\"; do",
  "    at_names \"${ws[$1]}\" \"$k\" || continue",
  "    [ \"$k\" = git ] && at_stdin_git_read \"${ws[@]:$1+1}\" && continue",
  "    return 0",
  "  done",
  "  return 1",
  "}",
  "at_stdin_program() {",
  "  local seg x p i j s; local -a ws",
  "  while IFS= read -r seg || [ -n \"$seg\" ]; do",
  "    read -ra ws <<< \"$seg\"",
  "    p=0",
  "    while [ \"$p\" -lt \"${#ws[@]}\" ]; do",
  "      x=${ws[p]}",
  "      [[ $x =~ ^[A-Za-z_][A-Za-z0-9_]*= || \"$AT_LEAD\" == *\" $x \"* ]] || break",
  "      p=$((p+1))",
  "    done",
  "    [ \"$p\" -lt \"${#ws[@]}\" ] || continue",
  "    at_reads_only \"${ws[p]##*/}\" \"${ws[@]:p+1}\" && continue",
  "    for ((i=p; i<${#ws[@]}; i++)); do",
  "      at_stdin_runner \"${ws[i]}\" || continue",
  "      at_stdin_prog \"${ws[i]}\" \"${ws[@]:i+1}\"",
  "      for s in \"${AT_STDIN_CAND[@]}\"; do at_stdin_tool $((i+1+s)) && return 0; done",
  "      if [ \"$AT_STDIN_WRAP\" -gt 0 ]; then",
  "        for ((j=i+1+AT_STDIN_WRAP; j<${#ws[@]}; j++)); do at_stdin_tool \"$j\" && return 0; done",
  "      fi",
  "    done",
  "  done <<< \"$1\"",
  "  return 1",
  "}",
  "for AT_S in \"${AT_TS//$AT_BS/}\" \"${AT_TS//$AT_BS//}\"; do",
  "  AT_S=$(printf '%s' \"$AT_S\" | LC_ALL=C tr ';&|()`' '[\\n*]')",
  "  set +u; if at_stdin_program \"$AT_S\"; then set -u; at_nojq_refuse; fi; set -u",
  "done",
];

/**
 * at_names WORD KEY (MATCH_FUNCTIONS, the no-jq glob check): the program word WORD runs the tool KEY. Its
 * basename, case-folded and with a trailing .exe .cmd .bat or .com dropped (Windows runs git.exe as git),
 * is KEY; or a glob or a brace expansion in it could make KEY. `gitk`, `git-lfs` and `legit` are not git.
 * Needs `lower` and `letters`.
 */
const AT_NAMES_FUNCTIONS: string[] = [
  "# at_names WORD KEY: WORD runs the tool KEY: its name at any path, in any letter case, with a trailing",
  "# .exe .cmd .bat or .com dropped; or a glob or brace expansion that could be it.",
  "at_names() {",
  "  local w=$1 key=$2 b part lit re='\\{[^{}]*(,|\\.\\.)[^{}]*\\}'",
  "  [[ $w != *[A-Z]* ]] || w=$(lower \"$w\")",
  "  b=${w##*/}",
  "  case $b in *.exe|*.cmd|*.bat|*.com) b=${b%.*} ;; esac",
  "  [ \"$b\" = \"$key\" ] || [ \"${w##*/}\" = \"$key\" ] && return 0",
  "  if [[ $w == *'{'*','* ]]; then",
  "    for part in ${w//[\\{\\},]/ }; do [ \"${part##*/}\" = \"$key\" ] && return 0; done",
  "  fi",
  "  [[ $w =~ $re ]] && at_brace_names \"$w\" \"$key\" && return 0",
  "  if [[ $b == *[\\*\\?\\[]* ]]; then",
  "    lit=$(letters \"$b\")",
  "    if [ \"${#lit}\" -ge 2 ] && [[ $key == $b ]]; then return 0; fi",
  "  fi",
  "  return 1",
  "}",
  "# at_brace_names WORD KEY: one word bash makes from WORD's first brace list {a,b} names KEY (at_names); a",
  "# sequence {a..b} or a nested list stands for any text (a glob).",
  "at_brace_names() {",
  "  local w=$1 pre post rest alt re='^([^{}]*)\\{([^{}]*,[^{}]*)\\}(.*)$' in='\\{[^{}]*\\}'",
  "  if [[ $w =~ $re ]]; then",
  "    pre=${BASH_REMATCH[1]}; rest=\"${BASH_REMATCH[2]},\"; post=${BASH_REMATCH[3]}",
  "    while [[ $rest == *,* ]]; do",
  "      alt=${rest%%,*}; rest=${rest#*,}",
  "      at_names \"$pre$alt$post\" \"$2\" && return 0",
  "    done",
  "    return 1",
  "  fi",
  "  while [[ $w =~ $in ]]; do w=${w/\"${BASH_REMATCH[0]}\"/*}; done",
  "  at_names \"$w\" \"$2\"",
  "}",
];

/**
 * The variables bash sets or reads itself (bash(1), Shell Variables), and `_`: never read as the literal a
 * command assigns, since bash may change them between the assignment and the use ($_ is the last word of
 * the command before, REPLY is select's answer, PWD changes with cd). at_resolve reads lower-case names
 * only, which already leaves all of these out; the list holds anyway. Any BASH_* or COMP_* name is left out too.
 */
export const BASH_SET_NAMES: string[] = [
  "_", "BASH", "BASHOPTS", "BASHPID", "CDPATH", "CHILD_MAX", "COLUMNS", "COMPREPLY", "COPROC", "DIRSTACK", "EMACS",
  "ENV", "EPOCHREALTIME", "EPOCHSECONDS", "EUID", "EXECIGNORE", "FCEDIT", "FIGNORE", "FUNCNAME", "FUNCNEST", "GLOBIGNORE",
  "GLOBSORT", "GROUPS", "HISTCMD", "HISTCONTROL", "HISTFILE", "HISTFILESIZE", "HISTIGNORE", "HISTSIZE", "HISTTIMEFORMAT",
  "HOME", "HOSTFILE", "HOSTNAME", "HOSTTYPE", "IFS", "IGNOREEOF", "INPUTRC", "INSIDE_EMACS", "LANG", "LC_ALL",
  "LC_COLLATE", "LC_CTYPE", "LC_MESSAGES", "LC_NUMERIC", "LC_TIME", "LINENO", "LINES", "MACHTYPE", "MAIL", "MAILCHECK",
  "MAILPATH", "MAPFILE", "OLDPWD", "OPTARG", "OPTERR", "OPTIND", "OSTYPE", "PATH", "PIPESTATUS", "POSIXLY_CORRECT",
  "PPID", "PROMPT_COMMAND", "PROMPT_DIRTRIM", "PS0", "PS1", "PS2", "PS3", "PS4", "PWD", "RANDOM", "READLINE_ARGUMENT",
  "READLINE_LINE", "READLINE_MARK", "READLINE_POINT", "REPLY", "SECONDS", "SHELL", "SHELLOPTS", "SHLVL", "SRANDOM",
  "TIMEFORMAT", "TMOUT", "TMPDIR", "UID",
];

/**
 * The longest command at_resolve reads, in characters, and the most assignments at its start. Past either the
 * command is left as written (doubt), so the reading's cost has a bound: at the limit at_resolve itself takes
 * under 40 ms on its costliest shapes, and the whole hook about 0.12 s (measured, action-guard-assign.test.ts).
 */
/**
 * Programs that can start a child with a changed environment, or a shell that expands text the parent left
 * alone (`env a""b=x bash -c '... $ab'`): a command that runs one, by any path, keeps its expansions doubted.
 * An interpreter given code on its command line (python -c, node -e, perl -e) is caught apart, in at_resolve.
 */
export const CHILD_PROGRAMS: string[] = [
  "env", "sudo", "doas", "su", "runuser", "pkexec", "docker", "podman", "nerdctl", "kubectl", "ssh", "xargs", "nohup",
  "time", "command", "exec", "nice", "ionice", "chrt", "taskset", "setsid", "stdbuf", "unbuffer", "timeout", "chroot",
  "unshare", "nsenter", "flock", "watch", "script", "parallel", "rush", "xe", "xjobs", "make", "npx", "npm", "pnpm",
  "yarn", "just", "bash", "sh", "zsh", "dash", "ksh", "mksh", "ash", "fish", "tcsh", "csh", "busybox", "pwsh", "powershell",
];

/**
 * Words that can set a variable or change the folder, or run another builtin that can (jobs -x, builtin,
 * command): a command with one anywhere, as any of its words, is not read by at_resolve.
 */
export const SETTER_WORDS: string[] = [
  "eval", "source", ".", "read", "declare", "typeset", "local", "export", "readonly", "mapfile", "readarray", "getopts",
  "let", "printf", "unset", "trap", "alias", "command", "builtin", "exec", "enable", "coproc", "wait", "function", "[[",
  "select", "test", "[", "compgen", "cd", "pushd", "popd", "dirs", "shopt", "fc", "history", "bind", "jobs", "caller",
];

/** An ERE that finds one of `words` as a whole word of a text, by any path and with or without .exe; `extra` adds alternatives. */
function wordAlternation(words: string[], extra = ""): string {
  const alt = words.map((w) => w.replace(/[.[\]\\^$*+?(){}|]/g, "\\$&")).join("|") + extra;
  return `(^|[[:space:]]|/)(${alt})(\\.[Ee][Xx][Ee])?([[:space:]]|$)`;
}

export const RESOLVE_MAX_LENGTH = 1024;
export const RESOLVE_MAX_NAMES = 16;

/**
 * Switches for the generated step guard. `resolveLeadingAssignments` (off by default): read the literal
 * assignments that open a command into their uses (RESOLVE_FUNCTIONS) before the command is cut into
 * steps. Off, any expansion among a gated tool's words is doubt and the step's gate checks run; the
 * generated scripts then carry none of the RESOLVE_FUNCTIONS. The reading stays off until it is proven
 * for every shell the command may run in. Tests turn it on to keep the code covered.
 */
export const GUARD_OPTIONS: { resolveLeadingAssignments: boolean } = { resolveLeadingAssignments: false };

/**
 * at_resolve CMD (only when GUARD_OPTIONS.resolveLeadingAssignments is on): the literal assignments that
 * open a command, read into their uses (`t=/x; tool open $t` is read as `tool open /x`). Needs
 * MATCH_FUNCTIONS before it (strip_redir, norm and AT_LEAD).
 */
export const RESOLVE_FUNCTIONS: string[] = [
  "# at_resolve CMD: CMD with the literal assignments at its start read into their uses. NAME=VALUE opens the",
  "# command, alone, followed by ; && or a newline (one after another, before any other command), and VALUE",
  "# is one plain word (letters, digits and _ . / : @ % + , -). Its uses $NAME and ${NAME} then read as VALUE",
  "# when NAME is lower case (bash's own names are upper case or _, and none of AT_BASH_VARS is read either),",
  "# NAME appears nowhere else in the command, every $ in it is such a use, no word in it can set a variable",
  "# or the folder (AT_SETS) or start a child (AT_CHILD), no program in it is an expansion, and IFS is not",
  "# named. A command with arithmetic, an array subscript, a ${...} with more than a name, a $'...' string, a",
  "# backtick, a here-doc, a function definition, a word with $ and =, a glob or a brace list, longer than",
  "# AT_RESOLVE_MAX characters, or with more than AT_RESOLVE_NAMES assignments at its start, is not read this",
  "# way; nor is one that fails any of these once read. Anything else is left as written: its expansions stay doubt.",
  `AT_SETS=" ${SETTER_WORDS.join(" ")} "`,
  `AT_BASH_VARS=" ${BASH_SET_NAMES.join(" ")} "`,
  `AT_RESOLVE_MAX=${RESOLVE_MAX_LENGTH}; AT_RESOLVE_NAMES=${RESOLVE_MAX_NAMES}`,
  "# Programs that can start a child with a changed environment, or a shell that expands its own text: a",
  "# command that runs one is not read this way (the child may see another value under the same name).",
  `AT_CHILD=" ${CHILD_PROGRAMS.join(" ")} "`,
  "# The words of AT_SETS and AT_CHILD (and a shell with a version in its name), as one word of a text: by any",
  "# path, with or without .exe. One regex over the whole command instead of one test per word.",
  `AT_SETS_RE=${shellQuote(wordAlternation(SETTER_WORDS))}`,
  `AT_CHILD_RE=${shellQuote(wordAlternation(CHILD_PROGRAMS, "|(bash|sh|zsh|dash|ksh|mksh|ash|yash|posh|fish|tcsh|csh|busybox)[0-9.-]+"))}`,
  "# at_subst TEXT MAP: TEXT with each $NAME and ${NAME} the shell itself expands, whose NAME is in MAP",
  "# (\" NAME=VALUE ...\"), written as VALUE. A use inside single quotes or after a backslash (also inside",
  "# double quotes) is kept as written; $NAMEX is another name, and is kept. One pass, from one quote, backslash",
  "# or $ to the next.",
  "at_subst() {",
  "  local s=$1 map=$2 out='' q=0 c pre r n v k i nl=$'\\n' LC_ALL=C",
  "  local -a parts",
  "  if [[ $s != *[\\'\\\\]* ]]; then",
  "    # no single quote and no backslash: every $ is the shell's own; one pass over the words after each $",
  "    parts=()",
  "    IFS='$' read -r -d '' -a parts <<< \"$s\" || true",
  "    out=${parts[0]-}",
  "    for ((i=1; i<${#parts[@]}; i++)); do",
  "      r=${parts[i]}; k=0",
  "      if [[ $r == '{'* ]]; then r=${r#?}; k=1; fi",
  "      n=${r%%[!A-Za-z0-9_]*}",
  "      if [ -n \"$n\" ] && [[ $map == *\" $n=\"* ]] && { [ \"$k\" = 0 ] || [ \"${r:${#n}:1}\" = '}' ]; }; then",
  "        v=${map#*\" $n=\"}; out+=\"${v%% *}${r:${#n}+k}\"",
  "      else",
  "        out+=\"\\$${parts[i]}\"",
  "      fi",
  "    done",
  "    # the here-string added one newline at the end",
  "    printf '%s' \"${out%$nl}\"",
  "    return 0",
  "  fi",
  "  while [ -n \"$s\" ]; do",
  "    if [ \"$q\" = 1 ]; then",
  "      # inside '...': nothing is expanded up to the closing quote",
  "      if [[ $s == *\"'\"* ]]; then out+=\"${s%%\"'\"*}'\"; s=${s#*\"'\"}; q=0; else out+=$s; s=''; fi",
  "      continue",
  "    fi",
  "    pre=${s%%[\\'\\\"\\\\\\$]*}; out+=$pre; s=${s:${#pre}}",
  "    [ -n \"$s\" ] || break",
  "    c=${s:0:1}; s=${s:1}",
  "    case $c in",
  "      \"'\") out+=$c; [ \"$q\" = 2 ] || q=1 ;;",
  "      '\"') out+=$c; if [ \"$q\" = 2 ]; then q=0; else q=2; fi ;;",
  "      '\\') out+=$c${s:0:1}; s=${s:1} ;;",
  "      *)",
  "        # $ outside single quotes: a use of a name in MAP; ${NAME} must close right after the name",
  "        r=$s; k=0",
  "        if [[ $r == '{'* ]]; then r=${r#?}; k=1; fi",
  "        n=${r%%[!A-Za-z0-9_]*}",
  "        if [ -n \"$n\" ] && [[ $map == *\" $n=\"* ]] && { [ \"$k\" = 0 ] || [ \"${r:${#n}:1}\" = '}' ]; }; then",
  "          v=${map#*\" $n=\"}; out+=${v%% *}; s=${r:${#n}+k}",
  "        else",
  "          out+=$c",
  "        fi ;;",
  "    esac",
  "  done",
  "  printf '%s' \"$out\"",
  "}",
  "# at_resolve_map CMD: when CMD may be read this way, prints the length of its leading assignments, a space,",
  "# and the names it reads with their values (\" NAME=VALUE ...\"); returns 1 otherwise.",
  "at_resolve_map() {",
  "  # LC_ALL=C: [a-z] is the 26 letters, in any locale",
  "  local t=$1 rest=$1 head='' segs seg x n i j k dq others empty='' map='' nl=$'\\n' re rb br LC_ALL=C",
  "  local -a ws names vals parts",
  "  names=(); vals=(); parts=()",
  "  # a long command is not read this way",
  "  [ \"${#t}\" -le \"$AT_RESOLVE_MAX\" ] || return 1",
  String.raw`  re="^([[:space:]]*([A-Za-z_][A-Za-z0-9_]*)=([A-Za-z0-9_./:@%+,-]+)[[:space:]]*(;|&&|$nl))(.*)\$"`,
  "  while [ \"${#names[@]}\" -le \"$AT_RESOLVE_NAMES\" ] && [[ $rest =~ $re ]]; do",
  "    names+=(\"${BASH_REMATCH[2]}\"); vals+=(\"${BASH_REMATCH[3]}\"); head+=${BASH_REMATCH[1]}; rest=${BASH_REMATCH[5]}",
  "  done",
  "  { [ \"${#names[@]}\" -gt 0 ] && [ \"${#names[@]}\" -le \"$AT_RESOLVE_NAMES\" ]; } || return 1",
  String.raw`  rb='(^|[^A-Za-z0-9_])IFS([^A-Za-z0-9_]|$)'`,
  "  [[ ! $t =~ $rb ]] || return 1",
  "  # arithmetic ((...)) $((...)) $[...], an array subscript, a ${...} that is more than a name (an offset is",
  "  # arithmetic too), a $'...' or $\"...\" string, a function definition, a backtick (a word made at run time)",
  "  if [[ $t == *'(('* || $t == *'$['* || $t == *\"\\$'\"* || $t == *'$\"'* || $t == *'`'* ]]; then return 1; fi",
  String.raw`  rb='\$\{([^A-Za-z_]|[A-Za-z_][A-Za-z0-9_]*([^A-Za-z0-9_}]|$))|[A-Za-z0-9_]\[|\([[:space:]]*\)'`,
  "  [[ ! $t =~ $rb ]] || return 1",
  "  # a here-doc (<< or <<-, not the here-string <<<): its body may be fed to a program that expands it",
  "  rb='(^|[^<])<<([^<]|$)'",
  "  [[ ! $t =~ $rb ]] || return 1",
  "  # lower case only, and never a name bash sets itself",
  "  for ((i=0; i<${#names[@]}; i++)); do",
  "    [[ ${names[i]} =~ ^[a-z][a-z0-9_]*$ ]] || continue",
  "    [[ \"$AT_BASH_VARS\" != *\" ${names[i]} \"* && ${names[i]} != BASH_* && ${names[i]} != COMP_* ]] || continue",
  "    empty+=\" ${names[i]}= \"",
  "  done",
  "  [ -n \"$empty\" ] || return 1",
  "  # every $ in the command starts a use $name or ${name} of one of these names: any other $ ($HOME, $1, $?,",
  "  # $$, $@, $(...), an upper-case name) is not read this way",
  "  IFS='$' read -r -d '' -a parts <<< \"$t\" || true",
  "  for ((i=1; i<${#parts[@]}; i++)); do",
  "    x=${parts[i]}; k=0",
  "    if [[ $x == '{'* ]]; then x=${x#?}; k=1; fi",
  "    n=${x%%[!A-Za-z0-9_]*}",
  "    [ -n \"$n\" ] && [[ $empty == *\" $n= \"* ]] && { [ \"$k\" = 0 ] || [ \"${x:${#n}:1}\" = '}' ]; } || return 1",
  "  done",
  "  # every word of every segment, quotes and backslashes dropped (as norm does, without a process per segment)",
  "  segs=$(strip_redir \"$t\")",
  "  for x in '&' '|' ';' '(' ')'; do segs=${segs//\"$x\"/$'\\n'}; done",
  "  segs=${segs//\\\"/}; segs=${segs//\\'/}; segs=${segs//\\\\/}",
  "  # any word that can set a variable or the folder (AT_SETS), wherever it stands (jobs -x, builtin and command",
  "  # run the next word as a builtin), or start a child with another environment or a shell (AT_CHILD)",
  "  [[ ! $segs =~ $AT_SETS_RE && ! $segs =~ $AT_CHILD_RE ]] || return 1",
  "  # an interpreter given code in the same segment (-c, -e, -, --eval)",
  "  rb=\"(^|[[:space:]]|/)(python[0-9.]*|pypy[0-9.]*|node|nodejs|perl|ruby|php|deno|bun)[[:space:]]([^$nl]*[[:space:]])?(-|-[A-Za-z]*[ceEpr][^[:space:]]*|--eval[^[:space:]]*|--print[^[:space:]]*)([[:space:]]|\\$)\"",
  "  [[ ! $segs =~ $rb ]] || return 1",
  "  # a $ in a word with = (a name built at run time: a$q=x), a glob, a brace list, or a ~ at a word's start:",
  "  # the word bash runs may be another (ev?l, {e,}val)",
  "  rb='[^[:space:]]*(\\$[^[:space:]]*=|=[^[:space:]]*\\$)|[*?[]|(^|[[:space:]])~|\\{[^{}]*(,|\\.\\.)[^{}]*\\}'",
  "  [[ ! $segs =~ $rb ]] || return 1",
  "  # each program: no expansion",
  "  while IFS= read -r seg || [ -n \"$seg\" ]; do",
  "    read -ra ws <<< \"$seg\"",
  "    i=0",
  "    while [ \"$i\" -lt \"${#ws[@]}\" ] && [[ ${ws[i]} =~ ^[A-Za-z_][A-Za-z0-9_]*= || \"$AT_LEAD\" == *\" ${ws[i]} \"* ]]; do i=$((i+1)); done",
  "    if [ \"$i\" -lt \"${#ws[@]}\" ] && [[ ${ws[i]} == *'$'* ]]; then return 1; fi",
  "  done <<< \"$segs\"",
  "  # the rest with quotes and backslashes dropped as well: a\"\"b=x and a\\b=x name ab for a program",
  "  dq=${rest//[\\\"\\'\\\\]/}",
  "  for ((i=0; i<${#names[@]}; i++)); do",
  "    [[ $empty == *\" ${names[i]}= \"* ]] || continue",
  "    others=''",
  "    for ((j=0; j<${#names[@]}; j++)); do [ \"$j\" = \"$i\" ] || others+=\" ${names[j]}=${vals[j]}\"; done",
  "    # the name anywhere but its uses $name and ${name} (a second assignment, read t, t+=x, {t}>f) is doubt",
  "    rb=\"(^|^[{]|[^A-Za-z0-9_\\${]|[^\\$][{])${names[i]}([^A-Za-z0-9_]|\\$)\"",
  "    x=\"$others $rest\"",
  "    [[ $x =~ $rb || $dq =~ $rb ]] && continue",
  "    map+=\" ${names[i]}=${vals[i]} \"",
  "  done",
  "  [ -n \"$map\" ] || return 1",
  "  printf '%s %s' \"${#head}\" \"$map\"",
  "}",
  "at_resolve() {",
  "  local t=$1 m m2 n s LC_ALL=C",
  "  m=$(at_resolve_map \"$t\") || { printf '%s' \"$t\"; return 0; }",
  "  n=${m%% *}; m=${m#* }",
  "  s=${t:0:n}$(at_subst \"${t:n}\" \"$m\")",
  "  # the command as read must pass every check again, with the same names and values: a name or a setter",
  "  # made from a read part (a$q= with q=b) is seen there",
  "  m2=$(at_resolve_map \"$s\") || { printf '%s' \"$t\"; return 0; }",
  "  [ \"${m2#* }\" = \"$m\" ] || { printf '%s' \"$t\"; return 0; }",
  "  printf '%s' \"$s\"",
  "}",
];

/** at_reads_only BASE WORD...: the program reads its arguments only (MATCH_FUNCTIONS, the no-jq glob check). */
const READS_ONLY_FUNCTION: string[] = [
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
];

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
  ...PROGRAM_WORDS,
  // 0.11.4: a word is read the way bash expands it. HEAD~1, @{u}, HEAD@{1}, HEAD^{commit} and a..b are literal.
  "# at_special WORD: bash would expand WORD: $ or a backtick, a glob (* ? [), a ~ at its start or after = or :,",
  "# or a brace list {a,b} or sequence {a..b}. A ~ inside a word and braces with neither are read literally.",
  "at_special() {",
  String.raw`  [[ $1 == *[\$\`\*\?\[]* || $1 == '~'* || $1 == *'=~'* || $1 == *':~'* ]] && return 0`,
  String.raw`  local re='\{[^{}]*(,|\.\.)[^{}]*\}'`,
  "  [[ $1 =~ $re ]]",
  "}",
  ...AT_NAMES_FUNCTIONS,
  ...READS_ONLY_FUNCTION,
  ...STDIN_JQ_FUNCTIONS,
  // 0.11.4: `git log "$BR"` is no commit and no push, whatever $BR holds.
  "# at_git_read I (in _seg_steps, step tool git): word I is git by a literal name, and its subcommand, the next",
  "# word (after --no-pager, --no-optional-locks, --no-replace-objects or --literal-pathspecs only), is literal, a",
  "# reading one (AT_GIT_READS, not grep), neither this step's first word nor any git step's (AT_GIT_STEPS), and no",
  "# word makes git run a command. Its expansions raise no doubt; the step's words written out still count.",
  "at_git_read() {",
  "  local i=$1 j x",
  "  [ \"$key\" = git ] && [ \"${#r[@]}\" -gt 0 ] && ! at_special \"${w[i]}\" || return 1",
  "  for ((j=i+1; j<n; j++)); do",
  "    case ${w[j]} in --no-pager|--no-optional-locks|--no-replace-objects|--literal-pathspecs) ;; *) break ;; esac",
  "  done",
  "  [ \"$j\" -lt \"$n\" ] || return 1",
  "  x=${w[j]}",
  "  ! at_special \"$x\" || return 1",
  "  [[ $x != -* && $x != grep && $x != \"${r[0]}\" && \"$AT_GIT_READS\" == *\" $x \"* && \" ${AT_GIT_STEPS:-} \" != *\" $x \"* ]] || return 1",
  "  at_reads_only git \"${w[@]:i+1}\"",
  "}",
  // 0.11.4: `git -c alias.x=commit x` runs a commit under another name.
  "# at_git_alias I (in _seg_steps, step tool git): a word after git sets, inline, a config key that can",
  "# define an alias: alias.*, or a file to include (include.path, includeif.<condition>.path), through",
  "# -c KEY=V, -cKEY=V, --config-env KEY=VAR or --config-env=KEY=VAR (keys compared lower case). The",
  "# subcommand it names could then run any step. Every word of the segment is looked at: a value-taking",
  "# global option (--attr-source HEAD) may stand between git and it, and one after the subcommand only",
  "# costs an over-refusal.",
  "at_git_alias() {",
  "  local j v",
  "  for ((j=$1+1; j<n; j++)); do",
  "    case ${w[j]} in",
  "      -c|--config-env) v=${w[j+1]:-} ;;",
  "      --config-env=*) v=${w[j]#--config-env=} ;;",
  "      -c?*) v=${w[j]#-c} ;;",
  "      *) continue ;;",
  "    esac",
  "    v=${v%%=*}",
  "    [[ $v == alias.* || $v == include.path || $v == includeif.*.path ]] && return 0",
  "  done",
  "  return 1",
  "}",
  "# seg_steps SEG KEY REST: sets SEG_N to how often SEG runs the step (tool KEY, then the REST words in",
  "# order), and SEG_DOUBT=1 when a run of the tool cannot be read (an expansion or glob among its words).",
  "seg_steps() { set +u; _seg_steps \"$@\"; set -u; }",
  "_seg_steps() {",
  "  local key=$2 kl n p i j k base",
  "  local -a w r cand",
  "  read -ra w <<< \"$1\"; read -ra r <<< \"$3\"",
  "  # the tool's letters, kept for the next call with the same tool (AT_KLS: \" KEY=LETTERS ...\"), since",
  "  # one command reads every segment for every tool",
  "  kl=${AT_KLS-}",
  "  if [[ $kl == *\" $key=\"* ]]; then kl=${kl#*\" $key=\"}; kl=${kl%% *}; else kl=$(letters \"$key\"); AT_KLS=\"${AT_KLS-} $key=$kl \"; fi",
  "  n=${#w[@]}; SEG_N=0; cand=()",
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
  "    [ \"$key\" = git ] && at_git_alias \"$i\" && SEG_DOUBT=1",
  "    at_git_read \"$i\" || for ((j=i; j<n; j++)); do at_special \"${w[j]}\" && SEG_DOUBT=1; done",
  "    j=$((i+1)); k=0",
  "    while [ \"$k\" -lt \"${#r[@]}\" ] && [ \"$j\" -lt \"$n\" ]; do",
  "      [ \"${w[j]}\" = \"${r[k]}\" ] && k=$((k+1))",
  "      j=$((j+1))",
  "    done",
  ...STDIN_JQ_CHECK,
  "    # D-1: an action script's own check (AT_NO_USAGE=1) gets no usage exemption",
  "    if [ \"${AT_NO_USAGE:-}\" != 1 ] && [ \"$j\" -eq $((n-1)) ] && [[ \" --help -h --version \" == *\" ${w[j]} \"* ]]; then continue; fi",
  "    SEG_N=$((SEG_N+1))",
  "  done",
  "  return 0",
  "}",
];

/** The letters a guard matches on: lower case, a-z and 0-9 only (the `letters` shell function). */
const lettersOf = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Where the no-jq word reading cuts words: blanks and ; & | ( ) < > / = : , (a `tr` set). */
const NOJQ_SPLIT = "[:space:];&|()<>/=:,";

/**
 * The words the no-jq reading finds in a text (the `at_words` shell function, for a step's own words):
 * bytes outside ASCII, quotes and backslashes dropped, lower case, cut at {@link NOJQ_SPLIT} and at
 * `extra`, a `~` at a word's start dropped.
 */
export function noJqWords(t: string, extra = ""): string[] {
  const cut = new RegExp(`[\\s;&|()<>/=:,${extra.replace(/[\]\\^-]/g, "\\$&")}]+`);
  return t.replace(/[^\x00-\x7f]/g, "").replace(/["'\\]/g, "").toLowerCase().split(cut)
    .map((w) => w.replace(/^~+/, "").replace(/\.(exe|cmd|bat|com)$/, "")).filter(Boolean);
}

/**
 * What a guard does when jq is not installed. 0.11.3 refused every call; since 0.11.4 the guard reads its
 * stdin raw and refuses (exit 2, the message it always gave) only when the payload could hold what it
 * guards:
 * - an empty payload, or a `\u` escape (jq would decode it, the raw reading does not);
 * - `words`: one list's words, whole and in order (not next to each other), among the payload's words.
 *   The payload is read as bash gets the command: JSON's escapes decoded (a backslash at a line end joins
 *   the lines; \n \t \r \f \b are blanks), quotes and backslashes dropped (a second reading takes a
 *   backslash as a word break, as PowerShell's path separator), a JSON string's own quotes a word break,
 *   bytes outside ASCII dropped, lower case, cut at {@link NOJQ_SPLIT} and `split`. `git branch -d
 *   feat/merged` holds no word `merge`; `git -C d merge` holds `git` then `merge`;
 * - `inOrder`: one list's letters in order in the payload's letters (a ledger's name, an inline git alias):
 *   the jq check reads these as letters too;
 * - `expansion`: an expansion or glob (`$` a backtick `*` `?` `[`, or a brace list or sequence, `{a,b}`
 *   `{a..b}`) beside the letters of one of these tools; with `powershell`, a PowerShell call naming a
 *   tool's letters at all (jq reads any mention it cannot account for as doubt).
 * Anything else runs, with one line on stderr. Needs the FAIL_CLOSED trap; tr and cat only.
 */
function noJqLines(o: {
  refuse: string;
  pass: string;
  words?: string[][];
  inOrder?: string[][];
  expansion?: string[];
  split?: string;
  powershell?: boolean;
  /** The first word of every git step the topology declares: refuse a tool run by a program that reads its arguments from stdin. */
  stdinGitSteps?: string[];
}): string[] {
  const sq = shellQuote;
  const lists = (o.inOrder ?? []).map((ws) => ws.map(lettersOf).filter(Boolean)).filter((ws) => ws.length > 0);
  const wordLists = (o.words ?? []).map((ws) => ws.flatMap((w) => noJqWords(w, o.split ?? ""))).filter((ws) => ws.length > 0);
  const tools = [...new Set((o.expansion ?? []).map(lettersOf).filter(Boolean))];
  const rawTools = [...new Set((o.expansion ?? []).map((t) => t.toLowerCase()).filter(Boolean))];
  const has = (ws: string[]) => `at_raw_has ${ws.map(sq).join(" ")}`;
  const hasWords = (ws: string[]) => `at_words_has ${ws.map(sq).join(" ")}`;
  const anyTool = tools.map((t) => has([t])).join(" || ");
  return [
    "if ! command -v jq >/dev/null 2>&1; then",
    "  # No jq: the payload is read raw, and refused only when it could hold what this guard checks.",
    `  ${MATCH_FUNCTIONS[1]}`,
    `  at_nojq_refuse() { echo ${sq(o.refuse)} >&2; exit 2; }`,
    "  command -v tr >/dev/null 2>&1 && command -v cat >/dev/null 2>&1 || at_nojq_refuse",
    "  AT_RAW=$(cat)",
    '  [ -n "$AT_RAW" ] || at_nojq_refuse',
    "  [[ $AT_RAW != *'\\u'* ]] || at_nojq_refuse",
    "  # JSON's \\\\ and its control escapes carry no letter of the decoded text",
    "  AT_RAW_D=${AT_RAW//\\\\\\\\/}; AT_RAW_D=${AT_RAW_D//\\\\[ntrbf]/}",
    '  AT_RAW_L=$(letters "$AT_RAW_D")',
    '  at_raw_has() { local t=$AT_RAW_L w; for w in "$@"; do [[ $t == *"$w"* ]] || return 1; t=${t#*"$w"}; done; }',
    ...(lists.length ? [`  if ${lists.map(has).join(" || ")}; then at_nojq_refuse; fi`] : []),
    ...(wordLists.length || o.powershell || tools.length
      ? [
          "  # The payload's words, as bash gets the command: JSON's escapes decoded (\\\\ held as \\001 until the",
          "  # end), a backslash at a line end joining the lines, quotes dropped, a JSON string's own quotes a break.",
          "  AT_BS=$'\\001'; AT_NL=$'\\n'",
          "  AT_T=${AT_RAW//'\\\\\\n'/}; AT_T=${AT_T//'\\\\'/$AT_BS}; AT_T=${AT_T//'\\\"'/}; AT_T=${AT_T//'\\n'/$AT_NL}",
          "  AT_T=${AT_T//\\\\[trfb]/ }; AT_T=${AT_T//'\\/'//}; AT_T=${AT_T//\\\\/$AT_BS}; AT_T=${AT_T//\\'/}",
          "  # AT_TS: each JSON string on lines of its own (for the program check); AT_T: a JSON string's quotes a blank",
          "  AT_TS=${AT_T//'\"'/$AT_NL}; AT_T=${AT_T//'\"'/ }",
          "  # at_words TEXT: its words between single spaces: bytes outside ASCII dropped, lower case, cut at the",
          `  # blanks and ; & | ( ) < > / = : ,${(o.split ?? "").split("").map((c) => ` ${c}`).join("")}, a ~ at a word's start and a .exe .cmd .bat or .com at its end dropped.`,
          "  at_words() {",
          `    local t; t=" $(printf '%s' "$1" | LC_ALL=C tr -d '\\200-\\377' | LC_ALL=C tr 'A-Z' 'a-z' | LC_ALL=C tr ${sq(NOJQ_SPLIT + (o.split ?? ""))} '[ *]') "`,
          "    while [[ $t == *' ~'* ]]; do t=${t//' ~'/' '}; done",
          "    t=${t//'.exe '/' '}; t=${t//'.cmd '/' '}; t=${t//'.bat '/' '}; t=${t//'.com '/' '}",
          "    printf '%s' \"$t\"",
          "  }",
          "  # two readings: a backslash dropped (bash), and a backslash as a word break (a PowerShell path)",
          '  AT_W1=$(at_words "${AT_T//$AT_BS/}"); AT_W2=$(at_words "${AT_T//$AT_BS/ }")',
          "  # at_words_has WORD...: the words appear whole, in this order, in either reading.",
          '  at_in_order() { local t=$1 w; shift; for w in "$@"; do [[ $t == *" $w "* ]] || return 1; t=" ${t#*" $w "}"; done; }',
          '  at_words_has() { at_in_order "$AT_W1" "$@" || at_in_order "$AT_W2" "$@"; }',
        ]
      : []),
    ...(wordLists.length ? [`  if ${wordLists.map(hasWords).join(" || ")}; then at_nojq_refuse; fi`] : []),
    ...(o.powershell && tools.length ? [`  if at_words_has powershell && { ${anyTool}; }; then at_nojq_refuse; fi`] : []),
    ...(tools.length
      ? [
          // a brace expansion as bash reads one (at_special): a list {a,b} or a sequence {a..b}. A JSON
          // object's brace is followed by a quote or a space; @{u}, HEAD@{1} and ^{commit} expand nothing.
          String.raw`  AT_RE='\{([^"{}[:space:]\\]|\\.)*(,|\.\.)([^"{}[:space:]\\]|\\.)*\}'`,
          String.raw`  if [[ $AT_RAW == *[\$\`\*\?\[]* || $AT_RAW =~ $AT_RE ]] && { ` + anyTool + "; }; then at_nojq_refuse; fi",
          "  # A glob or a brace list where bash runs a program is a name made from the files there, or from the",
          "  # list: it could be a gated tool (at_names, as the jq check reads it). Segments are cut at ; & | ( ) a",
          "  # backtick and a newline, and between JSON strings. A segment whose program only reads (ls, cat, git",
          "  # log) is skipped, but not its variable assignments; a program word that starts with ~ and holds a",
          "  # tool's letters is doubt, as the jq check reads it.",
          `  ${MATCH_FUNCTIONS[0]}`,
          ...[...PROGRAM_WORDS, ...READS_ONLY_FUNCTION, ...AT_NAMES_FUNCTIONS].map((l) => `  ${l}`),
          "  at_glob_tool() {",
          "    local k",
          String.raw`    [[ $1 == *[\*\?\[\{]* ]] || return 1`,
          `    for k in ${rawTools.map(sq).join(" ")}; do at_names "$1" "$k" && return 0; done`,
          "    return 1",
          "  }",
          "  at_glob_program() {",
          "    local seg x p l k; local -a ws",
          '    while IFS= read -r seg || [ -n "$seg" ]; do',
          '      read -ra ws <<< "$seg"',
          "      p=0",
          '      while [ "$p" -lt "${#ws[@]}" ]; do',
          "        x=${ws[p]}",
          '        if [[ $x =~ ^[a-z_][a-z0-9_]*= ]]; then at_glob_tool "${x#*=}" && return 0',
          '        elif [[ "$AT_LEAD" != *" $x "* ]]; then break; fi',
          "        p=$((p+1))",
          "      done",
          '      [ "$p" -lt "${#ws[@]}" ] || continue',
          "      if [[ ${ws[p]} == '~'* ]]; then",
          `        l=$(letters "\${ws[p]}"); for k in ${tools.map(sq).join(" ")}; do [[ $l == *"$k"* ]] && return 0; done`,
          "      fi",
          '      at_reads_only "${ws[p]##*/}" "${ws[@]:p+1}" && continue',
          '      for x in "${ws[@]:p}"; do { at_glob_tool "$x" || at_glob_tool "${x#*=}"; } && return 0; done',
          "    done <<< \"$1\"",
          "    return 1",
          "  }",
          "  # two readings again: a backslash dropped, and a backslash as a path separator",
          "  for AT_S in \"${AT_TS//$AT_BS/}\" \"${AT_TS//$AT_BS//}\"; do",
          "    AT_S=$(printf '%s' \"$AT_S\" | LC_ALL=C tr 'A-Z' 'a-z' | LC_ALL=C tr ';&|()`' '[\\n*]')",
          '    set +u; if at_glob_program "$AT_S"; then set -u; at_nojq_refuse; fi; set -u',
          "  done",
          ...(o.stdinGitSteps
            ? [
                `  AT_STDIN_TOOLS=(${rawTools.map(sq).join(" ")}); AT_STDIN_GIT_STEPS=${sq(` ${o.stdinGitSteps.join(" ")} `)}`,
                ...STDIN_NOJQ_BLOCK.map((l) => `  ${l}`),
              ]
            : []),
        ]
      : []),
    `  echo ${sq(o.pass)} >&2`,
    `  ${FAIL_CLOSED_DONE}`,
    "  exit 0",
    "fi",
  ];
}

/** The word lists a ledger is named by, for {@link noJqLines}: its file name, or with the unit in the name, its path's parts. */
function ledgerWords(l: ProtectedLedger): string[] {
  return l.name ? [l.letters] : l.path.split("{unit}").map(lettersOf).filter(Boolean);
}

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
  if (!p.supportsAsk && hasHuman(ast, p)) paths.push(`${p.stateDir}/approvals.jsonl`);
  return [...new Set(paths)].map((path) => {
    const base = path.replace(/^.*\//, "");
    const strip = (t: string) => t.replace(/\{unit\}/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
    // A file name that holds the unit (`logs/{unit}.jsonl`) has no fixed name to match on its own: `*.jsonl`
    // would refuse every .jsonl edit. Then only the whole path's pattern and letters count.
    const unitInName = base.includes("{unit}");
    // A [[ == ]] pattern: the literal parts with their glob characters escaped, {unit} as *.
    const raw = (t: string) => t.split("{unit}").map((x) => x.replace(/[*?[\]\\]/g, "\\$&")).join("*");
    return { path, glob: raw(path), name: unitInName ? "" : raw(base), letters: unitInName ? strip(path) : strip(base) || strip(path) };
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
    "  for w in $(norm \"$CMD\"); do if [[ $w == $1 || $w == */$1 ]]; then hit=1; fi; done",
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
    ...(v === null
      ? [`ROOT="$(cd "$(dirname "\${BASH_SOURCE[0]}")/${upToRoot(p, name)}" && pwd)"`]
      : [
          `if [ -z "\${${v}:-}" ]; then echo "agentopology: ${v} is not set, so this edit cannot be checked and is blocked" >&2; exit 2; fi`,
          `ROOT="$(cd "$${v}" && pwd)"`,
        ]),
    ...noJqLines({
      refuse: "agentopology: jq is required to check this edit, so it is blocked",
      pass: "agentopology: jq is not installed; this edit names no gate ledger, so it runs. Install jq to check edits.",
      inOrder: ledgers.map(ledgerWords),
    }),
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
    // D-7: a case-insensitive disk (macOS) opens logs/ep1/TRACE.JSONL as the ledger, so path and pattern are compared lower-cased.
    "  RL=$(printf '%s' \"$R\" | tr '[:upper:]' '[:lower:]')",
  ];
  for (const l of ledgers) {
    // The pattern is a quoted value; unquoted inside [[ ]] it is matched as a glob and never run.
    lines.push(`  PAT=${shellQuote(l.glob.toLowerCase())}; if [[ $RL == $PAT ]]; then refuse ${shellQuote(l.path)} "$R"; fi`);
    if (l.name) lines.push(`  PAT=${shellQuote(l.name.toLowerCase())}; if [[ \${RL##*/} == $PAT ]]; then refuse ${shellQuote(l.path)} "$R"; fi`);
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

/**
 * at_gate (before-action.sh): a gate's check script, run once per command and for at most its budget
 * ({@link inlineGateBudget}). A watchdog in bash, not the `timeout` program, which stock macOS lacks; it
 * stops the check and every process it started (pgrep -P). The check writes to a temp file, so a process
 * left behind cannot hold the hook's output open. bash 3.2 safe. Needs deny and $DIR.
 */
const GATE_BUDGET_FUNCTIONS: string[] = [
  "# at_gate ID SECONDS FIX: run gate ID's check script once per command, for at most SECONDS. Past that, the",
  "# check and every process it started are stopped and the step is blocked (a hook that runs past its own",
  "# timeout could let the call through). FIX says what to change.",
  "AT_GATES_OK=' '",
  "at_kill() { local c; for c in $(pgrep -P \"$1\" 2>/dev/null); do at_kill \"$c\"; done; kill -KILL \"$1\" 2>/dev/null || true; }",
  "at_gate() {",
  "  local id=$1 s=$2 rc=0 late=0 p w o",
  "  [[ $AT_GATES_OK != *\" $id \"* ]] || return 0",
  "  o=$(mktemp) || deny \"$id\" \"no temp file could be made for its check\"",
  "  bash \"$DIR/gate-$id.sh\" </dev/null >\"$o\" 2>&1 & p=$!",
  "  # the watchdog: past SECONDS it stops the check (exit 3); stopped first, it ends with its sleep (exit 0)",
  "  ( z=''; trap '[ -z \"$z\" ] || kill \"$z\" 2>/dev/null; exit 0' TERM; sleep \"$s\" & z=$!; wait \"$z\" || true; trap '' TERM",
  "    kill -0 \"$p\" 2>/dev/null || exit 0; at_kill \"$p\"; exit 3 ) </dev/null >/dev/null 2>&1 & w=$!",
  "  wait \"$p\" || rc=$?",
  "  kill \"$w\" 2>/dev/null || true",
  "  if wait \"$w\"; then :; else [ \"$?\" != 3 ] || late=1; fi",
  "  cat \"$o\" >&2; rm -f \"$o\"",
  "  [ \"$late\" = 0 ] || deny \"$id\" \"its check took over $s s, so the step is blocked; $3\"",
  "  [ \"$rc\" = 0 ] || deny \"$id\" \"its check script failed\"",
  "  AT_GATES_OK=\"$AT_GATES_OK$id \"",
  "}",
  "",
];

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
 * One PreToolUse hook on the shell tools (Bash, Monitor, PowerShell on Claude Code) for the whole topology: before Claude Code runs
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
  const resolve = GUARD_OPTIONS.resolveLeadingAssignments;
  // Every gated step's tool and words (no jq), and the first word of every git step the topology declares (git reads).
  const stepWords = guards.flatMap(({ action }) => (action.commands ?? []).map(stepKey));
  const gitSteps = [...new Set(ast.nodes.flatMap((n) => (n.type === "action" ? (n as ActionNode).commands ?? [] : []))
    .map(stepKey).filter((k) => k.key === "git").map((k) => k.rest.split(" ")[0]).filter(Boolean))];

  const lines = [
    "#!/usr/bin/env bash",
    `# Before ${p.label} runs a script step of topology "${name}".`,
    `# Auto-generated by agentopology scaffold. Wired in ${p.hooksFile} as a`,
    `# PreToolUse hook on ${p.shellTools}. Exit 2 blocks the command and shows stderr to ${p.modelName}.`,
    "# A ledger is JSON Lines: {\"step\": \"<id>\", \"unit\": \"<unit>\", \"ok\": true, \"at\": \"<ISO time>\"}.",
    `# Covers ${p.label} sessions only; a step run outside ${p.outsideName} calls`,
    "# `agentopology step check` itself.",
    "set -euo pipefail",
    ...FAIL_CLOSED,
    ...projectRootLines(p, name, "strict"),
    ...noJqLines({
      refuse: "agentopology: jq is required to check this step, so it is blocked",
      pass: "agentopology: jq is not installed; this command names no gated step, so it runs. Install jq to check steps.",
      // a step: its tool and words, whole and in order (`git log --grep=merged` names no step `git merge`)
      words: stepWords.map((s) => [s.key, ...s.rest.split(" ")]),
      // as letters, the way the jq check reads them: a ledger's name (in any word: `trace.json[l]`), and an
      // inline git alias (`V=commit git -calias.x=V x`), which can name a git step in no words of its own
      inOrder: [
        ...ledgers.map(ledgerWords),
        ...(stepWords.some((s) => s.key === "git") ? [["git", "alias"], ["git", "include"]] : []),
      ],
      expansion: stepWords.map((s) => s.key),
      powershell: !!p.powershellTool,
      stdinGitSteps: gitSteps,
    }),
    `DIR="${p.scriptsDir(name)}"`,
    ...(p.powershellTool
      ? [
        // One read of stdin: the command, and whether the tool is PowerShell. A call with no command (Monitor's ws input) reads as "" and runs nothing.
        "INPUT=$(cat)",
        `CMD=$(printf '%s' "$INPUT" | jq -er '${p.payload.command} // ""') || { echo "agentopology: the hook input is not valid JSON, so the command is blocked" >&2; exit 2; }`,
        `PWSH=0; [ "$(printf '%s' "$INPUT" | jq -r '.tool_name // ""')" = ${shellQuote(p.powershellTool)} ] && PWSH=1`,
      ]
      : [`CMD=$(jq -er '${p.payload.command} // ""') || { echo "agentopology: the hook input is not valid JSON, so the command is blocked" >&2; exit 2; }`]),
    "",
    "deny() { echo \"agentopology: gate $1 refuses this command ($CMD): $2\" >&2; exit 2; }",
    "",
    ...(beforeActionGates(ast).length ? GATE_BUDGET_FUNCTIONS : []),
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
    "#   `<step> --help` (or -h, --version) as the whole tail only asks for usage and is no step, except when",
    "#   AT_NO_USAGE=1 (a step's own action script checking itself, D-1);",
    "# - the tool is looked for where bash runs a program: after variable assignments and if/then/while/do/!/{/time,",
    "#   or as an interpreter's script. A program that only reads its arguments (cat, ls, grep, echo, a reading git",
    "#   subcommand, ...) runs no step; one that can run its arguments (sudo, xargs, env, timeout, find -exec, an",
    "#   unknown program) is scanned for the tool;",
    "# - DENY ON DOUBT: an expansion or glob among the tool's own words, a program that is itself an expansion",
    "#   naming the tool, a variable set to the tool, or a command substitution hiding a mention of the tool:",
    "#   the step is treated as unreadable: refused when it has a unit, checked as a step otherwise.",
    ...(p.powershellTool ? [`# - a ${p.powershellTool} command is read the same way, with a backslash read as a path separator; any`, "#   mention of the tool not read as a step the topology declares (`./tool @(...)`, `-ArgumentList a,b`) is doubt too."] : []),
    "# Not seen: a step reached through a variable set elsewhere, an alias, a function, or another script.",
    "CMD=${CMD//$'\\\\\\n'/}",
    // PowerShell: a backslash is a path separator, not an escape (its escape is the backtick, a separator here).
    ...(p.powershellTool ? ['[ "$PWSH" = 0 ] || CMD=${CMD//\\\\//}'] : []),
    ...MATCH_FUNCTIONS,
    ...(resolve ? RESOLVE_FUNCTIONS : []),
    `AT_GIT_STEPS=${shellQuote(gitSteps.join(" "))}`,
    "# key_count LETTERS: how often the tool's letters appear in the whole command's letters.",
    "CMD_L=$(letters \"$CMD\")",
    "key_count() { local t=$CMD_L n=0; while [[ $t == *\"$1\"* ]]; do t=${t#*\"$1\"}; n=$((n+1)); done; echo \"$n\"; }",
    "CMD_SUBST=0",
    "[[ $CMD == *'$('* || $CMD == *'`'* ]] && CMD_SUBST=1",
    "set -f",
    ...(!resolve
      ? ['SEGS=$(strip_redir "$CMD")']
      : [
        "# A literal assignment that opens the command (T=/x; tool open $T) is read into its uses (at_resolve).",
        ...(p.powershellTool
          ? ['if [ "$PWSH" = 1 ]; then SEGS=$(strip_redir "$CMD"); else SEGS=$(strip_redir "$(at_resolve "$CMD")"); fi']
          : ['SEGS=$(strip_redir "$(at_resolve "$CMD")")']),
      ]),
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
  // PowerShell (0.11.1): how often each guarded tool is read running ANY step the topology declares.
  // A mention of the tool beyond that (`.\tool.exe`, `./tool @(...)`, `-ArgumentList "publish","ep1"`) is doubt.
  const pwshKeys = p.powershellTool ? [...new Set(guards.flatMap(({ action }) => (action.commands ?? []).map((c) => stepKey(c).key)))] : [];
  if (pwshKeys.length) {
    const declared = [...new Map(ast.nodes.flatMap((n) => (n.type === "action" ? (n as ActionNode).commands ?? [] : [])).map((c) => { const k = stepKey(c); return [`${k.key} ${k.rest}`, k]; })).values()];
    lines.push('if [ "$PWSH" = 1 ]; then');
    pwshKeys.forEach((key, i) => lines.push(`  K${i}=0`));
    lines.push("  while IFS= read -r -u 3 C || [ -n \"$C\" ]; do", '    L=$(lower "$(norm "$C")")');
    pwshKeys.forEach((key, i) => {
      for (const k of declared.filter((d) => d.key === key)) lines.push(`    seg_steps "$L" ${sq(k.key)} ${sq(k.rest)}; K${i}=$((K${i} + SEG_N))`);
    });
    lines.push('  done 3<<< "$SEGS"', "fi");
  }
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
          const fix = gateWorstCase(gate) === null ? "declare a timeout: on the gate if it needs longer" : "raise the gate's timeout: if it needs longer";
          out.push(`${indent}at_gate ${sq(gate.id)} ${inlineGateBudget(gate)} ${sq(fix)}`);
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
    if (pwshKeys.length) {
      const pwshDoubt = names.map((n) => `[ "$(key_count ${sq(n.replace(/[^a-z0-9]/g, ""))})" -gt "$K${pwshKeys.indexOf(n)}" ]`).join(" || ");
      lines.push(`if [ "$PWSH" = 1 ] && { ${pwshDoubt}; }; then`, ...unreadable("a PowerShell form", "  "), "fi");
    }
    lines.push("while IFS= read -r -u 3 C || [ -n \"$C\" ]; do", '  C=$(norm "$C")', '  [ "$C" != "  " ] || continue', '  L=$(lower "$C")');
    lines.push("  SEG_DOUBT=0; T=0");
    for (const k of keys) lines.push(`  seg_steps "$L" ${sq(k.key)} ${sq(k.rest)}; T=$((T + SEG_N))`);
    lines.push('  if [ "$SEG_DOUBT" = 1 ]; then', ...unreadable("an expansion or glob among the tool's words", "    "), "  fi");
    lines.push('  if [ "$T" -gt 0 ]; then');
    if (action.unitFrom) {
      // Every unit the segment names needs its own ok record (F-5): a second step must not ride the first's.
      lines.push(
        `    UNITS=$(jq -nr --arg c "$C" --arg re ${sq(action.unitFrom)} '[$c | match($re; "g") | .captures[0].string // ""] | if length == 0 then [""] else . end | .[]') || deny ${sq(gates[0].id)} "unit-from does not compile"`,
        "    while IFS= read -r UNIT <&4 || [ -n \"$UNIT\" ]; do",
        // D-2: the step has a unit, so none read (or an empty capture) is refused, whatever the ledger path.
        `      [ -n "$UNIT" ] || deny ${sq(gates[0].id)} "no unit could be read from the command by the step's unit-from; write the step as a plain command naming its unit"`,
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
    const wiring = gateWiring(ast, gate, p);
    const wiredAsHook = wiring.kind === "subagent-stop";
    const held = spawnHeldAgents(ast, gate, p);
    let enforcementNote: string;
    let enforcementNote2: string;
    if (checkableActionGate(ast, gate)) {
      enforcementNote = `# Enforcement: PreToolUse hook on ${p.shellTools} (before-action.sh) before ${p.label} runs a command of "${gateAnchors(gate, "before").join('", "')}".`;
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
      enforcementNote = `# Enforcement: SubagentStop hook on agent "${wiring.anchors.join('", "')}". Exit 2 blocks the subagent`;
      enforcementNote2 = `#              from stopping (${p.label} prevents stop and surfaces stderr to ${p.modelName}).`;
      if (wiring.skipped) {
        enforcementNote2 += `\n#              Not after ${wiring.skipped.join(", ")}: ${wiring.skipped.join(", ")} is the entry agent, the session itself, so SubagentStop never fires for it.`;
      }
    } else if (p.id === "claude-code" && sessionAgentId(ast) !== undefined && gateAnchors(gate, "after").includes(sessionAgentId(ast)!)) {
      const session = sessionAgentId(ast)!;
      enforcementNote = `# Enforcement: NOT wired as a SubagentStop hook (after: ${session} is the entry agent, the session itself, so SubagentStop never fires for it).`;
      enforcementNote2 = `#              Invoke this script from your orchestrator playbook or a /command at the right step.`;
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

