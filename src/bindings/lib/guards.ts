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

import type { ActionNode, AgentNode, GateNode, HumanNode, OrchestratorNode, RecordDef, TopologyAST } from "../../parser/ast.js";
import { gateAnchors } from "../../parser/ast.js";
import { gateLedger, goLedgers, guardedActions } from "../../parser/ledger.js";
import { parseWindow } from "../../parser/window.js";
import { threatModelActive } from "./threat.js";
import { scriptNameFromRun } from "../../parser/run.js";
import { sessionAgentsOf, talkEdgesOf } from "../../parser/session-graph.js";
import type { GeneratedFile } from "../types.js";
import { refusalEventsOn } from "../../plugins/runtime.js";
import { REFUSAL_EVENT_FILE } from "./refusal-event.js";
import { FAIL_CLOSED, FAIL_CLOSED_DONE } from "./stub.js";
import { sessionAgentId } from "./entry.js";
import { isWorkflowSeamAgent } from "./seam.js";
import { hasRoutes, routeActionCheckLines, routeActionTargets, routeCheckFunction, routeCheckLines, routeRecordPath, routeTargets } from "./route.js";

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
export function projectRootLines(p: GuardPlatform, topology: string, mode: "cd" | "strict" | "fallback", target?: string): string[] {
  const v = p.projectDirVar;
  const here = `$(cd "$(dirname "\${BASH_SOURCE[0]}")/${upToRoot(p, topology)}" && pwd)`;
  if (v === null) {
    return mode === "fallback" ? [`ROOT="${here}"`, 'cd "$ROOT"'] : [`cd "${here}"`];
  }
  // meta { target }: AT_PROJECT is the project (where the scripts are), then the work is done in the target.
  const intoTarget = target === undefined || mode === "fallback"
    ? []
    : [`cd ${shellQuote(target)} || { echo "agentopology: the target directory ${target.replace(/[^A-Za-z0-9_.@+/ -]/g, "")} does not exist, so this step cannot be checked and is blocked" >&2; exit 2; }`];
  if (mode === "cd") return target === undefined ? [`cd "$${v}"`] : [`AT_PROJECT="$${v}"`, 'cd "$AT_PROJECT"', ...intoTarget];
  if (mode === "strict") {
    return [
      `if [ -z "\${${v}:-}" ]; then echo "agentopology: ${v} is not set, so this step cannot be checked and is blocked" >&2; exit 2; fi`,
      ...(target === undefined ? [`cd "$${v}"`] : [`AT_PROJECT="$${v}"`, 'cd "$AT_PROJECT"', ...intoTarget]),
    ];
  }
  return [`ROOT="\${${v}:-}"`, `if [ -z "$ROOT" ]; then ROOT=${here}; fi`, 'cd "$ROOT"'];
}

/** The target directory a platform's guards work in: `meta { target }` where the host sets a project-dir variable (Claude Code). */
export function rootTarget(ast: TopologyAST, p: GuardPlatform): string | undefined {
  return p.projectDirVar === null ? undefined : targetOf(ast);
}

/** The `DIR=` line: the scripts folder, absolute from $AT_PROJECT when the script has moved into a target. */
function scriptsDirLine(p: GuardPlatform, topology: string, target: string | undefined): string {
  return target === undefined ? `DIR="${p.scriptsDir(topology)}"` : `DIR="$AT_PROJECT/${p.scriptsDir(topology)}"`;
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
  const hold = holdLines(ast, p, "agent");
  const add = (agent: string, lines: string[]) => steps.set(agent, [...(steps.get(agent) ?? []), ...lines]);

  // 0.13.0: an agent every way into which is a `when` route starts only on its route (lib/route.ts).
  for (const agent of routeTargets(ast, p).keys()) add(agent, routeCheckLines(ast, agent, p));
  for (const node of ast.nodes) {
    if (node.type !== "gate") continue;
    const gate = node as GateNode;
    if (!gate.run || gate.behavior === "advisory" || !scriptNameFromRun(gate.run)) continue;
    const held = hold !== null && (gate.mode === "shadow" || gate.letGo === "once");
    for (const agent of spawnHeldAgents(ast, gate, p)) {
      add(agent, [
        `    # gate ${gate.id} (after: ${gateAnchors(gate, "after").join(", ") || "-"})`,
        held
          ? `    bash "$DIR/gate-${gate.id}.sh" >&2 || at_hold ${shellQuote(gate.id)} "its check script failed" || exit 2`
          : `    bash "$DIR/gate-${gate.id}.sh" >&2 || exit 2`,
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
    ...projectRootLines(p, name, "cd", rootTarget(ast, p)),
    scriptsDirLine(p, name, rootTarget(ast, p)),
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
    ...(hold ?? []),
    ...(p.supportsAsk
      ? [
          // D-4: one decision per run. Each approval step adds its reason; one JSON object is printed at the end.
          "ASK=''",
          "ask() { ASK=\"${ASK:+$ASK; }$1\"; }",
          "",
        ]
      : []),
    ...routeCheckFunction(ast, p),
    ...(p.supportsAsk
      ? []
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

/**
 * What a before-action.sh on disk lacks for a gate before a script step (guard --check, both
 * platforms): the gate's line, the ledger read when the gate has a ledger, and the run of its
 * check when it has a `run:` script. A gate with both needs both; a script that has the line but
 * skips one (kept from an older scaffold, edited by hand) holds less than the .at says.
 */
export function beforeActionGateProblems(ast: TopologyAST, gate: GateNode, script: string): string[] {
  if (!script.includes(`# gate ${gate.id} (`)) return [`before-action.sh has no line for gate ${gate.id}`];
  const problems: string[] = [];
  const has = (call: string) => script.split("\n").some((l) => l.trimStart().startsWith(`${call} ${shellQuote(gate.id)} `));
  if (gateLedger(ast, gate) && !has("check_ledger")) problems.push(`before-action.sh does not read the ledger of gate ${gate.id}`);
  if (scriptNameFromRun(gate.run) && !has("at_gate")) problems.push(`before-action.sh does not run the run: check of gate ${gate.id}`);
  return problems;
}

/**
 * The generated checks that hold a gate: `action` when before-action.sh runs it
 * (a script step in `before:`), `agent` when before-agent.sh does (it holds the
 * launch of a subagent). Empty when no generated check runs it before something
 * (a SubagentStop-only gate, or none). `tests`, `mode` and `let-go` work on
 * these two only.
 */
export function gateChecks(ast: TopologyAST, gate: GateNode, p: GuardPlatform = CLAUDE_CODE_GUARDS): Array<"action" | "agent"> {
  const out: Array<"action" | "agent"> = [];
  if (checkableActionGate(ast, gate)) out.push("action");
  if (gate.run && gate.behavior !== "advisory" && scriptNameFromRun(gate.run) && spawnHeldAgents(ast, gate, p).length > 0) out.push("agent");
  return out;
}

/** The human whose ledger row lets a gate go: its `lift:`, else the human its `after:` names. */
export function letGoHuman(ast: TopologyAST, gate: GateNode): string | undefined {
  if (gate.lift) return gate.lift;
  return gateAnchors(gate, "after").find((id) => ast.nodes.some((n) => n.id === id && n.type === "human"));
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
  return [...new Set([...actionGuards(ast).flatMap(({ gates }) => gates), ...writeGates(ast)])].filter((g) => !!scriptNameFromRun(g.run));
}

/**
 * The gates with a `before: write "<glob>"` anchor that have something to check: a ledger or a `run:`
 * script, and not advisory. An edit (before-edit.sh) or a Bash write (before-action.sh) of a path
 * matching one of the globs is refused until the gate holds.
 */
export function writeGates(ast: TopologyAST): GateNode[] {
  return ast.nodes.filter((n): n is GateNode => n.type === "gate")
    .filter((g) => g.behavior !== "advisory" && (g.beforeWrite ?? []).some((x) => x.trim() !== "") && (!!gateLedger(ast, g) || !!scriptNameFromRun(g.run)));
}

/** The words of a glob's literal parts (`src/**` + `/gen` → src, gen), for the no-jq reading. */
function globWords(glob: string): string[] {
  return glob.split(/[*?/[\]\\]+/).filter((w) => lettersOf(w) !== "");
}

/** A gate's write globs that are not empty. */
function writeGlobs(gate: GateNode): string[] {
  return (gate.beforeWrite ?? []).filter((x) => x.trim() !== "");
}

/**
 * A path glob as lower-case `[[ == ]]` patterns, for a path relative to the project root. `*` and `**`
 * both match across folders (the guard errs toward refusing); `**` + `/` also matches no folder; a glob
 * with no wildcard names a path or a folder under it.
 */
export function writeGlobPatterns(glob: string): string[] {
  const g0 = glob.trim().replace(/^\.\//, "");
  const variants = g0.includes("**/") ? [g0.split("**/").join(""), g0.split("**/").join("*/")] : [g0];
  const out = new Set<string>();
  for (const v of variants) {
    const esc = v.toLowerCase().replace(/[[\]\\]/g, "\\$&").replace(/\*+/g, "*");
    out.add(esc);
    if (!esc.endsWith("*")) out.add(`${esc.replace(/\/$/, "")}/*`);
  }
  return [...out];
}

/** The `meta { target }` directory, or undefined when none is set (or it is empty: V152 reports that). */
export function targetOf(ast: TopologyAST): string | undefined {
  const t = ast.topology.target?.trim();
  return t ? t : undefined;
}

/**
 * The shell expression for the directory project paths resolve against: the project root (`$VAR`), or
 * with `meta { target }` the target, absolute as written or under the project root. The one place that
 * joins the target to the project-dir variable; every generated script and hook command takes it from here.
 */
export function projectRootRef(ast: TopologyAST, v: string = "CLAUDE_PROJECT_DIR"): string {
  const t = targetOf(ast);
  if (t === undefined) return `$${v}`;
  return t.startsWith("/") ? t.replace(/\/+$/, "") || "/" : `$${v}/${t.replace(/^\.\//, "").replace(/\/+$/, "")}`;
}

/**
 * The hook timeout for before-action.sh: each gate check runs at most once per command, for at most its
 * budget, so the sum of the budgets plus a margin bounds the script. Never below {@link BEFORE_ACTION_MIN_TIMEOUT}.
 */
export function beforeActionHookTimeout(ast: TopologyAST): number {
  return Math.max(BEFORE_ACTION_MIN_TIMEOUT, beforeActionBudgetSum(ast) + BEFORE_ACTION_MARGIN);
}

/**
 * The hook timeout for before-edit.sh: set only when a gate before a write runs a check script (its
 * budgets plus the margin), else 0 and the host's default stands.
 */
export function beforeEditHookTimeout(ast: TopologyAST): number {
  const runs = writeGates(ast).filter((g) => !!scriptNameFromRun(g.run));
  return runs.length === 0 ? 0 : Math.max(BEFORE_ACTION_MIN_TIMEOUT, runs.reduce((s, g) => s + inlineGateBudget(g), 0) + BEFORE_ACTION_MARGIN);
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
 * at_pkgname SPEC, at_pkg_seg SEGMENT (MATCH_FUNCTIONS): a package spec is read as its bare name. A trailing
 * `@version` or `@tag` is dropped, and an `npm:` alias is resolved (`alias@npm:name@1.2.3` is `name`), so
 * `agentopology@0.13.1` and `agentopology@latest` run the program `agentopology`. A leading scope is kept
 * (`@scope/name@1` is `@scope/name`), and at_names reads its basename, as it reads any path. at_pkg_seg
 * does this to the package a runner is told to fetch or run: npx, pnpx, bunx, `pnpm|yarn|npm|bun` then
 * dlx, exec or x (options may stand before the subcommand, with their values: `pnpm -C . dlx`, `npm
 * --prefix . exec`; after an option not known, one more word is read as its value), after `-p`/`--package`/`--package=`, and the
 * word after `--`. It takes the segment's words and sets AT_PW to them, one for each, with those words
 * rewritten; every other word, such as `git@github.com`, stays as written. at_pkgname never gives an empty
 * name: a spec that reads as none (`npm:`, `x@npm:`) stays as written, so no word is ever lost.
 * Mirrors pkgName in TypeScript.
 */
const AT_PKG_FUNCTIONS: string[] = [
  "# at_pkgname SPEC: AT_PKG, SPEC as a bare package name: @version or @tag dropped, an npm: alias resolved.",
  "# A tarball, git, URL or path spec is its last part (./name-1.2.3.tgz, git+https://host/o/name.git: name).",
  "# Never empty: a spec that reads as no name (npm:, x@npm:) stays as written.",
  "at_pkgname() {",
  "  local s=$1 pre r",
  "  AT_PKG=$1",
  "  case $s in */agentopology/dist/cli/index.js|agentopology/dist/cli/index.js) AT_PKG=agentopology; return 0 ;; esac",
  "  while :; do",
  "    while [[ $s == npm:* ]]; do s=${s#npm:}; done",
  "    pre=''",
  "    # a tarball, a git or URL spec, or a path: its last part, without .git, .tgz and a version before .tgz",
  "    case $s in",
  "      *://*|git+*|git:*|github:*|gitlab:*|bitbucket:*|file:*|.*|/*|'~'*|*.tgz|*.tgz#*|*.tar.gz|*.tar|*.git|*.git#*)",
  "        s=${s%%#*}; s=${s%/}; s=${s##*/}; s=${s##*:}; s=${s%.git}",
  "        case $s in *.tgz|*.tar.gz|*.tar) s=${s%.tgz}; s=${s%.tar.gz}; s=${s%.tar}; s=${s%%-[0-9]*} ;; esac",
  "        break ;;",
  "    esac",
  "    if [[ $s == @* ]]; then pre=@; s=${s#@}; fi",
  "    if [[ $s == *@* ]]; then",
  "      r=${s#*@}",
  "      if [[ $r == npm:* ]]; then s=${r#npm:}; continue; fi",
  "      s=${s%%@*}",
  "    fi",
  "    break",
  "  done",
  "  [ -z \"$s\" ] || AT_PKG=$pre$s",
  "}",
  "# at_pkg_seg WORD...: AT_PW, the words, one for each (never fewer), with the package a runner runs (npx, pnpx,",
  "# bunx, pnpm|yarn|npm|bun dlx|exec|x) as a bare name.",
  "at_pkg_seg() {",
  "  AT_PW=(\"$@\")",
  "  case \" $* \" in *@*|*.tgz*|*.tar*|*.git*|*://*|*git+*|*github:*|*gitlab:*|*bitbucket:*|*file:*|*/dist/cli/index.js*|*--call=*) ;; *) return 0 ;; esac",
  "  local j k n=$# x b o",
  "  for ((j=0; j<n; j++)); do",
  "    # the CLI's own file, run by node or any program, is the CLI",
  "    case ${AT_PW[j]} in */agentopology/dist/cli/index.js|agentopology/dist/cli/index.js) AT_PW[j]=agentopology; continue ;; esac",
  "    b=${AT_PW[j]##*/}",
  "    case $b in",
  "      npx|pnpx|bunx) k=$((j+1)) ;;",
  "      pnpm|yarn|npm|bun)",
  "        # the runner's own options before dlx, exec or x: a known one that takes a value skips that value;",
  "        # after any other option the next word may be its value, so one such word is skipped too",
  "        k=$((j+1)); o=0",
  "        while [ \"$k\" -lt \"$n\" ]; do",
  "          case ${AT_PW[k]} in",
  "            dlx|exec|x) break ;;",
  "            -C|--dir|--prefix|-w|--workspace|--filter|--cwd|--registry|--cache|--userconfig) k=$((k+2)); o=0 ;;",
  "            -*=*) k=$((k+1)); o=0 ;;",
  "            -*) k=$((k+1)); o=1 ;;",
  "            *) [ \"$o\" = 1 ] || break; k=$((k+1)); o=0 ;;",
  "          esac",
  "        done",
  "        case ${AT_PW[k]:-} in dlx|exec|x) k=$((k+1)) ;; *) continue ;; esac ;;",
  "      *) continue ;;",
  "    esac",
  "    while [ \"$k\" -lt \"$n\" ]; do",
  "      x=${AT_PW[k]}",
  "      case $x in",
  "        --) k=$((k+1)); if [ \"$k\" -lt \"$n\" ]; then at_pkgname \"${AT_PW[k]}\"; AT_PW[k]=$AT_PKG; fi; break ;;",
  "        -p|--package) k=$((k+1)); if [ \"$k\" -lt \"$n\" ]; then at_pkgname \"${AT_PW[k]}\"; AT_PW[k]=$AT_PKG; fi; k=$((k+1)) ;;",
  "        --package=*) at_pkgname \"${x#--package=}\"; AT_PW[k]=--package=$AT_PKG; k=$((k+1)) ;;",
  "        # --call runs its value as a shell's -c does: its first word is a program, read as one",
  "        --call=?*) AT_PW[k]=${x#--call=}; k=$((k+1)) ;;",
  "        -c|--call|--registry|--cache|--userconfig|--prefix|--node-arg|-w|--workspace|--filter|-C|--cwd) k=$((k+2)) ;;",
  "        -*) k=$((k+1)) ;;",
  "        *) at_pkgname \"$x\"; AT_PW[k]=$AT_PKG; break ;;",
  "      esac",
  "    done",
  "  done",
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
  ...AT_PKG_FUNCTIONS,
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
  "  local key=$2 kl n p i j k base x",
  "  local -a w pw r cand",
  "  # w: the segment's words as written (the stdin, git and expansion checks read these); pw: the same",
  "  # words with a runner's package as its bare name (at_pkg_seg), for the name matching",
  "  read -ra w <<< \"$1\"; read -ra r <<< \"$3\"",
  "  at_pkg_seg \"${w[@]}\"; pw=(\"${AT_PW[@]}\")",
  "  # one word for each word; were the two ever to differ, the segment cannot be read: doubt",
  "  [ \"${#pw[@]}\" -eq \"${#w[@]}\" ] || { SEG_DOUBT=1; pw=(\"${w[@]}\"); }",
  "  # the tool's letters, kept for the next call with the same tool (AT_KLS: \" KEY=LETTERS ...\"), since",
  "  # one command reads every segment for every tool",
  "  kl=${AT_KLS-}",
  "  if [[ $kl == *\" $key=\"* ]]; then kl=${kl#*\" $key=\"}; kl=${kl%% *}; else kl=$(letters \"$key\"); AT_KLS=\"${AT_KLS-} $key=$kl \"; fi",
  "  n=${#w[@]}; SEG_N=0; cand=()",
  "  p=0",
  "  while [ \"$p\" -lt \"$n\" ]; do",
  "    if [[ ${pw[p]} =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then",
  "      # a variable set to the tool: its later use cannot be read. A value with no / or : is read as a",
  "      # package spec too (f=name@1; npx $f), so a version or a tag does not hide the name",
  "      x=${pw[p]#*=}; [[ $x == *[/:]* ]] || { at_pkgname \"$x\"; x=$AT_PKG; }",
  "      at_names \"$x\" \"$key\" && SEG_DOUBT=1",
  "    elif [[ \"$AT_LEAD\" != *\" ${pw[p]} \"* ]]; then",
  "      break",
  "    fi",
  "    p=$((p+1))",
  "  done",
  "  [ \"$p\" -lt \"$n\" ] || return 0",
  "  base=${pw[p]##*/}",
  "  if at_names \"${pw[p]}\" \"$key\"; then",
  "    cand=(\"$p\")",
  "  elif at_special \"${pw[p]}\"; then",
  "    # the program itself is an expansion: it may be the tool",
  "    if [[ $(letters \"${pw[p]}\") == *\"$kl\"* ]] || { [[ ${pw[p]} == '$'* || ${pw[p]} == '`'* ]] && [[ $CMD_L == *\"$kl\"* ]]; }; then SEG_DOUBT=1; fi",
  "    return 0",
  "  elif at_reads_only \"$base\" \"${pw[@]:p+1}\"; then",
  "    return 0",
  "  elif [ \"$base\" = find ]; then",
  "    # find runs a command only after -exec/-execdir/-ok/-okdir: everything after the first one is scanned",
  "    k=0",
  "    for ((j=p+1; j<n; j++)); do",
  "      case ${pw[j]} in -exec|-execdir|-ok|-okdir) k=1; continue ;; esac",
  "      [ \"$k\" = 1 ] && at_names \"${pw[j]}\" \"$key\" && cand+=(\"$j\")",
  "    done",
  "  else",
  "    # an interpreter, a program that can run its arguments, or one not known: the tool anywhere after it",
  "    for ((j=p+1; j<n; j++)); do at_names \"${pw[j]}\" \"$key\" && cand+=(\"$j\"); done",
  "  fi",
  "  for i in \"${cand[@]}\"; do",
  "    [ \"$key\" = git ] && at_git_alias \"$i\" && SEG_DOUBT=1",
  "    at_git_read \"$i\" || for ((j=i; j<n; j++)); do at_special \"${w[j]}\" && SEG_DOUBT=1; done",
  "    j=$((i+1)); k=0",
  "    while [ \"$k\" -lt \"${#r[@]}\" ] && [ \"$j\" -lt \"$n\" ]; do",
  "      [ \"${pw[j]}\" = \"${r[k]}\" ] && k=$((k+1))",
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
export function noJqLines(o: {
  refuse: string;
  pass: string;
  words?: string[][];
  inOrder?: string[][];
  expansion?: string[];
  split?: string;
  powershell?: boolean;
  /** The first word of every git step the topology declares: refuse a tool run by a program that reads its arguments from stdin. */
  stdinGitSteps?: string[];
  /** Refuse every call when jq is missing: the guard checks a path it cannot read without jq. */
  refuseAll?: boolean;
}): string[] {
  const sq = shellQuote;
  if (o.refuseAll) {
    return ["if ! command -v jq >/dev/null 2>&1; then", `  echo ${sq(o.refuse)} >&2`, "  exit 2", "fi"];
  }
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
  // 0.13.1: the record an `output-into:` hook appends to is the hook's alone: not the agent's, not the session's.
  for (const { record } of outputIntoTargets(ast, p)) paths.push(record.path.replace(/^\.\//, ""));
  if (!p.supportsAsk && hasHuman(ast, p)) paths.push(`${p.stateDir}/approvals.jsonl`);
  // The threat model's session marks, and the ledger its lift person approves in (Claude Code only).
  if (p.id === "claude-code" && threatModelActive(ast)) {
    paths.push(`${p.stateDir}/taint/{unit}`);
    if (ast.threatModel?.lift) paths.push(`${p.stateDir}/approvals.jsonl`);
  }
  return [...new Set(paths)].map(protectedFile);
}

/** A project-relative path (`{unit}` allowed) as the patterns and letters the guards match it by. */
function protectedFile(path: string): ProtectedLedger {
  const base = path.replace(/^.*\//, "");
  const strip = (t: string) => t.replace(/\{unit\}/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  // A file name that holds the unit (`logs/{unit}.jsonl`) has no fixed name to match on its own: `*.jsonl`
  // would refuse every .jsonl edit. Then only the whole path's pattern and letters count.
  const unitInName = base.includes("{unit}");
  // A [[ == ]] pattern: the literal parts with their glob characters escaped, {unit} as *.
  const raw = (t: string) => t.split("{unit}").map((x) => x.replace(/[*?[\]\\]/g, "\\$&")).join("*");
  return { path, glob: raw(path), name: unitInName ? "" : raw(base), letters: unitInName ? strip(path) : strip(base) || strip(path) };
}

/**
 * The agents whose output a SubagentStop hook appends to a record (`output-into:`, 0.13.1), each with its
 * record: a subagent (the session agent never fires SubagentStop) with an output-schema, and a declared
 * record whose path has no `{unit}`. Claude Code only. Empty for a topology that uses no `output-into`.
 */
export function outputIntoTargets(ast: TopologyAST, p: GuardPlatform): Array<{ agent: AgentNode; record: RecordDef }> {
  if (p.id !== "claude-code") return [];
  const session = sessionAgentId(ast);
  return ast.nodes.flatMap((n) => {
    if (n.type !== "agent") return [];
    const agent = n as AgentNode;
    if (agent.outputInto === undefined || agent.id === session || !agent.outputSchema || agent.outputSchema.length === 0) return [];
    const record = (ast.records ?? []).find((r) => r.id === agent.outputInto);
    return record && record.path !== "" && !record.path.includes("{unit}") ? [{ agent, record }] : [];
  });
}

/** The script an `output-into:` agent's SubagentStop hook runs. */
export function outputIntoScript(agentId: string): string {
  return `output-into-${agentId}.sh`;
}

/** A record with a `max-per-day` cap, as a protected file with its cap (0.13.1). */
export interface RateRecord extends ProtectedLedger {
  max: number;
}

/**
 * The records with a `max-per-day` cap that the guards watch (0.13.1). Claude Code only; the other
 * targets are told by V140. A path with `{unit}` is left out (V158 reports it). Empty for a topology that
 * uses no cap, so nothing else about its guards changes.
 */
export function rateRecords(ast: TopologyAST, p: GuardPlatform): RateRecord[] {
  if (p.id !== "claude-code") return [];
  return (ast.records ?? [])
    .filter((r) => r.maxPerDay !== undefined && r.path !== "" && !r.path.includes("{unit}"))
    .map((r) => ({ ...protectedFile(r.path.replace(/^\.\//, "")), max: r.maxPerDay! }));
}

/**
 * before-action.sh: a command that writes a capped record's file (a redirect, tee, cp, mv, ...: the forms
 * ledger_guard reads) is refused once the file already holds `max` rows for today (UTC). A row counts for
 * the day its "ts" (or "at") starts with. A command that only reads the file is never refused. A text
 * check: it counts the rows already there and cannot know how many rows one command adds.
 */
function rateGuardLines(rates: RateRecord[]): string[] {
  if (rates.length === 0) return [];
  return [
    "# 0.13.1 max-per-day: a record's file takes no more than its cap of rows a UTC day. rate_guard 'PATTERN' LETTERS PATH LIT GLOB NAME MAX",
    "rate_guard() {",
    "  local hit=0 w n=0 today",
    "  for w in $(norm \"$CMD\"); do if [[ $w == $1 || $w == */$1 ]]; then hit=1; fi; done",
    "  [[ $CMD_L == *\"$2\"* ]] && hit=1",
    "  at_path_named \"$4\" \"$5\" \"$6\" && hit=1",
    "  [ \"$hit\" = 1 ] || return 0",
    "  at_reads_plain \"$4\" \"$5\" \"$6\" \"$2\" && return 0",
    "  today=$(date -u +%Y-%m-%d)",
    "  [ ! -f \"$3\" ] || n=$(grep -Ec \"\\\"(ts|at)\\\" *: *\\\"$today\" \"$3\" 2>/dev/null || true)",
    "  [ \"${n:-0}\" -ge \"$7\" ] || return 0",
    "  echo \"agentopology: max-per-day: $3 already holds $n rows for $today (UTC) and the record allows $7 a day; the command writes it ($CMD)\" >&2",
    "  exit 2",
    "}",
    ...rates.map((r) => `rate_guard ${shellQuote(r.glob)} ${shellQuote(r.letters)} ${shellQuote(r.path)} ${pathArgs(r.path)} ${r.max}`),
    "",
  ];
}

/** The route record as a protected file (0.13.0), or null when no launch reads one (lib/route.ts). */
function protectedRouteRecord(ast: TopologyAST, p: GuardPlatform): ProtectedLedger | null {
  return hasRoutes(ast, p) ? protectedFile(routeRecordPath(ast, p)) : null;
}

/**
 * The before-action.sh lines that refuse a command naming a ledger (F-4): its pattern among the words,
 * or its file name's letters anywhere in the command's letters. Reading stays allowed: every program in
 * the command only reads its arguments (AT_READS, a reading git subcommand) and the command holds no
 * `>` and no `tee`. Needs MATCH_FUNCTIONS, $CMD, $CMD_L and $SEGS, and runs under `set -f`.
 */
function ledgerGuardLines(
  ledgers: ProtectedLedger[],
  route: ProtectedLedger | null = null,
  /** The gates before a write of a path (writeGateGuardLines). */
  writeGateLines: string[] = [],
  /** Write the helpers (at_only_reads, PATH_FUNCTIONS) even with nothing else to guard: the guards' own files follow (0.13.0). */
  helpers = false,
  /** The records with a max-per-day cap (0.13.1). */
  rates: RateRecord[] = [],
): string[] {
  if (ledgers.length === 0 && !route && writeGateLines.length === 0 && !helpers && rates.length === 0) return [];
  const routeLines = route
    ? [
        "# 0.13.0: the route record is refused the same way: only route.sh writes it.",
        "# route_guard 'PATTERN' LETTERS PATH: refuse the command when it names the route record and does more than read it.",
        "route_guard() {",
        "  local hit=0 w",
        "  for w in $(norm \"$CMD\"); do if [[ $w == $1 || $w == */$1 ]]; then hit=1; fi; done",
        "  [[ $CMD_L == *\"$2\"* ]] && hit=1",
        "  at_path_named \"$4\" \"$5\" \"$6\" && hit=1",
        "  [ \"$hit\" = 1 ] || return 0",
        "  at_reads_plain \"$4\" \"$5\" \"$6\" \"$2\" && return 0",
        "  echo \"agentopology: the command touches the route record $3; only route.sh writes it ($CMD)\" >&2",
        "  exit 2",
        "}",
        `route_guard ${shellQuote(route.glob)} ${shellQuote(route.letters)} ${shellQuote(route.path)} ${pathArgs(route.path)}`,
        "",
      ]
    : [];
  // 0.13.0: every word read once, as the paths it may name (PATH_FUNCTIONS).
  const pathLines = ["", ...PATH_FUNCTIONS, "at_pw_init", ""];
  if (ledgers.length === 0 && writeGateLines.length === 0) return [...atOnlyReadsLines(), ...pathLines, ...routeLines, ...rateGuardLines(rates)];
  return [
    "# F-4: a gate's ledger is a file the agent could write. A command that names one is refused unless it",
    "# only reads it. Since 0.13.0 a word is matched as a glob, through the command's own variables and after a",
    "# cd. Not seen: a ledger reached through a variable set elsewhere, or another script.",
    ...atOnlyReadsLines(),
    ...pathLines,
    ...(ledgers.length === 0 ? [] : [
      "# ledger_guard 'PATTERN' LETTERS PATH LIT GLOB NAME: refuse the command when it names the ledger and does more than read it.",
      "ledger_guard() {",
      "  local hit=0 w",
      "  for w in $(norm \"$CMD\"); do if [[ $w == $1 || $w == */$1 ]]; then hit=1; fi; done",
      "  [[ $CMD_L == *\"$2\"* ]] && hit=1",
      "  at_path_named \"$4\" \"$5\" \"$6\" && hit=1",
      "  [ \"$hit\" = 1 ] || return 0",
      "  at_reads_plain \"$4\" \"$5\" \"$6\" \"$2\" && return 0",
      "  echo \"agentopology: the command touches the gate ledger $3; only the gate's own step writes it ($CMD)\" >&2",
      "  exit 2",
      "}",
      ...ledgers.map((l) => `ledger_guard ${shellQuote(l.glob)} ${shellQuote(l.letters)} ${shellQuote(l.path)} ${pathArgs(l.path)}`),
    ]),
    ...writeGateLines,
    "",
    ...routeLines,
    ...rateGuardLines(rates),
  ];
}

/**
 * The before-action.sh lines for the gates before a write of a path: a command that names a path matching
 * a gate's glob and does more than read it is held until the gate holds. Needs at_only_reads (ledgerGuardLines
 * writes it), deny, check_ledger, at_gate and $UNIT.
 */
function writeGateGuardLines(ast: TopologyAST, wgates: GateNode[]): string[] {
  if (wgates.length === 0) return [];
  return [
    "# A gate before a write of a path: a command that names a path matching its glob and does more than read",
    "# it is held until the gate holds. Not seen: a path reached through a variable set elsewhere, or another script.",
    "at_writes_to() {",
    "  local w",
    "  for w in $(norm \"$CMD\"); do",
    "    w=$(lower \"${w##*>}\")",
    "    [ -n \"$w\" ] || continue",
    "    if [[ $w == $1 || $w == */$1 ]]; then return 0; fi",
    "  done",
    "  return 1",
    "}",
    "at_not_only_reads() { local r=0; set +u; if at_only_reads; then r=1; fi; set -u; [ \"$r\" = 1 ] && return 1; return 0; }",
    "# 0.13.1: a command that runs agentopology's own read-only subcommands (at_pw_atread) reads the .at files it names;",
    "# a redirect into a path matching the glob is still a write. Args: the gate's globs.",
    "at_at_reads() {",
    "  local pat",
    "  [[ $CMD_L == *agentopology* ]] || return 1",
    "  for pat in \"$@\"; do at_reads_plain '' \"$pat\" '' || return 1; done",
    "  return 0",
    "}",
    ...wgates.flatMap((g) => {
      const pats = writeGlobs(g).flatMap(writeGlobPatterns);
      const hit = pats.map((pat) => `at_writes_to ${shellQuote(pat)}`).join(" || ");
      return [
        `if { ${hit}; } && at_not_only_reads && ! at_at_reads ${pats.map(shellQuote).join(" ")}; then`,
        `  UNIT=''`,
        // an agentopology read refused only for a missing --no-plugins: the refusal says so (printed as the guard exits)
        `  [ "\${AT_PW_NPHINT:-0}" = 0 ] || trap 'echo "agentopology: an agentopology call reads a .at file only with --no-plugins (a plugin is code that could write): add --no-plugins to run it before this gate clears" >&2' EXIT`,
        ...gateCheckLines(ast, g, "  "),
        `  trap - EXIT`,
        "fi",
      ];
    }),
  ];
}

/**
 * The paths a command may name, however it names them (0.13.0): before-action.sh reads every word once
 * (at_pw_init) into the lists the protected-file guards match on. Needs MATCH_FUNCTIONS and $CMD, and
 * runs under `set -f`.
 * - AT_CW: every word as a path, quotes dropped and lower case: the command's own literal assignments
 *   (NAME=VALUE anywhere in it, VALUE with no `$`; a name assigned twice is not read) read into $NAME and
 *   ${NAME}, every other expansion read as `*`, a `cd DIR` read into the relative words after it, `.`
 *   and `..` resolved, the project root dropped. A word that is only an expansion counts only as a
 *   redirect target or an argument of a program that writes or removes.
 * - AT_CB: the globs with no `/` (the folder they expand in is not known): matched on file names.
 * - AT_CD: the words of a segment that does more than read (any program but those that only read,
 *   mkdir, touch and cd): matched on the folders that hold a protected file.
 * A glob written in the command is also expanded in the project, the way the shell would.
 * A guard matches a word as a glob: `.claude/st*` names `.claude/state/taint/s1`.
 */
export const PATH_FUNCTIONS: string[] = [
  "# 0.13.0: the paths a command names, however it names them: a glob, a variable of its own, a cd first.",
  "AT_PW_WRITERS=\" rm rmdir mv cp ln tee truncate install rsync dd shred unlink chmod chown chgrp sed perl \"",
  "AT_PW_SAFE=\" mkdir touch cd pushd popd \"",
  "# the path reading's own lead words (a for or select list, a case pattern) and readers, beside AT_LEAD and AT_READS",
  "AT_PW_LEAD=\" for case select in \"",
  "AT_PW_READS=\" shellcheck \"",
  "# 0.13.1: agentopology's own read-only subcommands read the .at files they name (the path reading only, apart from AT_READS)",
  "AT_PW_AT_READS=\" validate inventory plan info \"",
  "# at_pw_atread PROGRAM WORD...: PROGRAM, the command's whole first word, is a bare agentopology or npx (found on PATH; a",
  "# program at a path is not it), npx running [agentopology|agentopology@VERSION], and its subcommand only reads:",
  "# validate, inventory, plan, info (not export: it writes next to the .at); guard with --check or --test; step check; visualize with --no-open; scaffold with --dry-run.",
  "# A flag that makes it write (--output, -o, --force, --prune, --fix, --write) makes it a write; --plugin runs code, so it is",
  "# never a read. npx runs only the agentopology package itself: `npx [-y|--yes] agentopology[@X.Y.Z[-pre]]`, no other npx option.",
  "# A read loads no plugin: it needs --no-plugins, as its own word, unquoted, before any `--` (at_pw_npword); --dir (the",
  "# folder whose package.json lists plugins) makes it a write. A read refused only for a missing --no-plugins sets",
  "# AT_PW_NPHINT, so the refusal says to add it.",
  "AT_PW_NPHINT=0",
  "# at_pw_npword: every segment of the command (cut at ; & | ( ) and newlines, outside quotes) that names agentopology",
  "# has --no-plugins as its own unquoted word, before that segment's `--`. Quoted text is blank here.",
  "at_pw_npword() {",
  "  local s=$CMD cur='' q='' c i n=${#CMD}",
  "  for ((i=0; i<=n; i++)); do",
  "    c=${s:i:1}",
  "    if [ -n \"$q\" ]; then [ \"$c\" = \"$q\" ] && q=''; cur+=' '; continue; fi",
  "    case $c in",
  "      \"'\"|'\"') q=$c; cur+=' ' ;;",
  "      ''|';'|'&'|'|'|'('|')'|$'\\n') at_pw_npseg \"$cur\" || return 1; cur='' ;;",
  "      *) cur+=$c ;;",
  "    esac",
  "  done",
  "  return 0",
  "}",
  "at_pw_npseg() {",
  "  local w a=0 np=0; local -a ws",
  "  read -ra ws <<< \"$1\"",
  "  [ \"${#ws[@]}\" -gt 0 ] || return 0",
  "  for w in \"${ws[@]}\"; do case ${w##*/} in agentopology|agentopology@*) a=1 ;; esac; done",
  "  [ \"$a\" = 1 ] || return 0",
  "  for w in \"${ws[@]}\"; do [ \"$w\" = -- ] && break; [ \"$w\" = --no-plugins ] && np=1; done",
  "  [ \"$np\" = 1 ]",
  "}",
  "at_pw_atread() {",
  "  local base=$1 w sub='' nx=0 ok=0 np=0 dd=0; shift",
  "  case $base in",
  "    agentopology) ;;",
  "    npx) while [[ ${1:-} == -y || ${1:-} == --yes ]]; do shift; done",
  "      [[ ${1:-} == agentopology || ${1:-} =~ ^agentopology@[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9a-z.-]+)?$ ]] || return 1; shift ;;",
  "    *) return 1 ;;",
  "  esac",
  "  for w in \"$@\"; do",
  "    case $w in --output|--output=*|-o|--force|--prune|--fix|--write|--plugin|--plugin=*|--dir|--dir=*) return 1 ;; esac",
  "    if [ \"$w\" = -- ]; then dd=1",
  "    elif [ \"$w\" = --no-plugins ]; then [ \"$dd\" = 1 ] || np=1",
  "    elif [[ $w == -* ]]; then",
  "      case $w in --check|--test) [ \"$sub\" = guard ] && ok=1 ;; --no-open) [ \"$sub\" = visualize ] && ok=1 ;; --dry-run) [ \"$sub\" = scaffold ] && ok=1 ;; esac",
  "    elif [ -z \"$sub\" ]; then sub=$w",
  "    elif [ \"$sub\" = step ] && [ \"$nx\" = 0 ]; then nx=1; [ \"$w\" = check ] && ok=1",
  "    fi",
  "  done",
  "  case $sub in",
  "    guard|visualize|scaffold|step) [ \"$ok\" = 1 ] || return 1 ;;",
  "    *) [[ $AT_PW_AT_READS == *\" $sub \"* ]] || return 1 ;;",
  "  esac",
  "  if [ \"$np\" = 1 ] && at_pw_npword; then return 0; fi",
  "  AT_PW_NPHINT=1; return 1",
  "}",
  "# at_lex PATH: AT_LX, PATH with . and .. resolved lexically and the project root dropped.",
  "at_lex() {",
  "  local v=$1 out='' part abs=''",
  "  [[ $v == /* ]] && abs=/",
  "  while [ -n \"$v\" ]; do",
  "    part=${v%%/*}",
  "    if [[ $v == */* ]]; then v=${v#*/}; else v=''; fi",
  "    case $part in",
  "      ''|.) ;;",
  "      ..) if [ -n \"$out\" ] && [[ $out != .. && $out != */.. ]]; then if [[ $out == */* ]]; then out=${out%/*}; else out=''; fi; elif [ -z \"$abs\" ]; then out=${out:+$out/}..; fi ;;",
  "      *) out=${out:+$out/}$part ;;",
  "    esac",
  "  done",
  "  AT_LX=$abs$out",
  "  [ -n \"$AT_LX\" ] || AT_LX=.",
  "  case $AT_LX in \"$AT_PW_ROOT\") AT_LX=. ;; \"$AT_PW_ROOT\"/*) AT_LX=${AT_LX#\"$AT_PW_ROOT\"/} ;; esac",
  "}",
  "# at_pw_sub WORD: AT_SX, WORD with the command's own literal assignments read in and any other expansion as *.",
  "at_pw_sub() {",
  "  local s=$1 out='' n r v",
  "  while [[ $s == *'$'* ]]; do",
  "    out+=${s%%\\$*}; s=${s#*\\$}; n=''",
  "    if [[ $s == '{'* ]]; then",
  "      r=${s#?}; n=${r%%[!a-z0-9_]*}",
  "      if [ -n \"$n\" ] && [ \"${r:${#n}:1}\" = '}' ]; then s=${r:${#n}+1}; else n=''; if [[ $r == *'}'* ]]; then s=${r#*\\}}; else s=''; fi; fi",
  "    else",
  "      n=${s%%[!a-z0-9_]*}; s=${s:${#n}}",
  "      # a special parameter ($? $$ $# $! $- $@ $*) is one expansion",
  "      if [ -z \"$n\" ]; then case ${s:0:1} in [?\\$#!@*-]) s=${s:1} ;; esac; fi",
  "    fi",
  "    # a value's quoted glob is live once the value is expanded unquoted",
  "    if [ -n \"$n\" ] && [[ $AT_PW_MAP == *\" $n=\"* && $AT_PW_DUP != *\" $n \"* ]]; then v=${AT_PW_MAP#*\" $n=\"}; v=${v%% *}; at_pw_glob \"$v\"; out+=$AT_GX; else out+='*'; fi",
  "  done",
  "  AT_SX=$out$s",
  "}",
  "# at_pw_glob TEXT: AT_GX, TEXT with the quoted glob characters (held as \\001 \\002 \\003) made live again.",
  "at_pw_glob() { AT_GX=${1//$'\\001'/*}; AT_GX=${AT_GX//$'\\002'/?}; AT_GX=${AT_GX//$'\\003'/[}; }",
  "# at_pw_add WORD IN-WRITE EXPANDED: one word into the lists. A glob written in the command counts only as the",
  "# files it expands to here, from the folder the command runs in; one that matches nothing names nothing.",
  "at_pw_add() {",
  "  local c e k=0; local -a ex",
  "  at_lex \"$1\"; c=$AT_LX",
  "  if [ \"$3\" = 0 ] && [[ $c == *[\\*\\?\\[]* ]]; then",
  "    shopt -s nocaseglob; set +f; ex=( $c ); set -f; shopt -u nocaseglob",
  "    for e in \"${ex[@]}\"; do",
  "      [ \"$e\" != \"$c\" ] || continue",
  "      k=$((k+1)); [ \"$k\" -le 256 ] || break",
  "      at_pw_put \"$e\" \"$2\"",
  "    done",
  "    return 0",
  "  fi",
  "  at_pw_put \"$c\" \"$2\"",
  "}",
  "# at_pw_put PATH IN-WRITE: AT_CW every path; AT_CX one in a write position (wpos); AT_CD one of a segment that",
  "# does more than read, a copy's source aside; AT_RT a redirect target.",
  "at_pw_put() {",
  "  at_lex \"$1\"",
  "  AT_CW+=(\"$AT_LX\")",
  "  [ \"$wpos\" = 0 ] || AT_CX+=(\"$AT_LX\")",
  "  [ \"$2\" = 0 ] || [ \"$issrc\" = 1 ] || AT_CD+=(\"$AT_LX\")",
  "  [ \"$tgt\" = 0 ] || AT_RT+=(\"$AT_LX\")",
  "  return 0",
  "}",
  "# at_pw_rel WORD: AT_RX, WORD read from the folder the command runs in (cdp: the session's, or a cd's).",
  "at_pw_rel() { if [ -n \"$cdp\" ] && [[ $1 != /* ]]; then AT_RX=$cdp/$1; else AT_RX=$1; fi; }",
  "# at_pw_unquote TEXT: AT_UQ, TEXT with a glob character or a separator inside quotes, or after a backslash, held",
  "# as text (\\001 * \\002 ? \\003 [ \\004 the separators): the shell neither expands nor cuts there.",
  "at_pw_unquote() {",
  "  local s=$1 out='' q='' c i n=${#1}",
  "  for ((i=0; i<n; i++)); do",
  "    c=${s:i:1}",
  "    if [ \"$c\" = '\\' ] && [ \"$q\" != \"'\" ]; then out+=$c; i=$((i+1)); c=${s:i:1}; at_pw_ph; out+=$c; continue; fi",
  "    if [ -z \"$q\" ]; then case $c in \"'\"|'\"') q=$c ;; esac",
  "    elif [ \"$c\" = \"$q\" ]; then q=''",
  "    else at_pw_ph",
  "    fi",
  "    out+=$c",
  "  done",
  "  AT_UQ=$out",
  "}",
  "at_pw_ph() { case $c in '*') c=$'\\001' ;; '?') c=$'\\002' ;; '[') c=$'\\003' ;; '|'|';'|'&'|'('|')'|'<'|'>'|$'\\n') c=$'\\004' ;; ' '|$'\\t') c=$'\\005' ;; esac; }",
  "# at_pw_text (in _at_pw_init, seg): a quoted argument with a space in it (held as \\005) is text, not a path: it is",
  "# dropped, unless it is a redirect target, or the segment runs a writer, or a shell, an interpreter or eval (inline",
  "# code): then its words are read, as before.",
  "AT_PW_INLINE=\" bash sh zsh dash ksh fish python python2 python3 node nodejs deno bun perl ruby php eval su xargs watch script \"",
  "at_pw_text() {",
  "  local w x='' ex=0; local -a out=()",
  "  [[ \"${seg[*]}\" == *$'\\005'* ]] || return 0",
  "  for w in \"${seg[@]}\"; do [[ \"$AT_PW_WRITERS$AT_PW_INLINE\" != *\" ${w##*/} \"* ]] || ex=1; done",
  "  for w in \"${seg[@]}\"; do",
  "    if [[ $w != *$'\\005'* ]]; then out+=(\"$w\")",
  "    elif [ \"$ex\" = 1 ] || [ \"$x\" = '>' ]; then out+=(${w//$'\\005'/ })",
  "    fi",
  "    x=$w",
  "  done",
  "  seg=(\"${out[@]}\")",
  "}",
  "# at_pw_once TEXT NAME: NAME appears once in TEXT as a word of its own (not as $NAME): it is set once.",
  "at_pw_once() {",
  "  local s=${1//'${'/'$'} w k=0",
  "  s=${s//[^a-z0-9_\\$]/ }",
  "  for w in $s; do [ \"$w\" != \"$2\" ] || k=$((k+1)); done",
  "  [ \"$k\" = 1 ]",
  "}",
  "# at_pw_tar (in at_pw_seg, a tar): a tar that creates an archive (c in its first word or an option, --create;",
  "# no x, --extract or --get) reads its sources and writes only its archive (tw: the word after -f or --file, or",
  "# a first word ending in f, or --file=...).",
  "at_pw_tar() {",
  "  local k x=${seg[p+1]:-} mk=0",
  "  [[ $x == -* || $x != *x* ]] || return 0",
  "  [[ $x == -* || $x != *c* ]] || mk=1",
  "  for ((k=p+1; k<n; k++)); do",
  "    case ${seg[k]} in --create) mk=1 ;; --extract|--get|-*x*) return 0 ;; --*) ;; -*c*) mk=1 ;; esac",
  "  done",
  "  [ \"$mk\" = 1 ] || return 0",
  "  for ((k=p+1; k<n; k++)); do",
  "    x=${seg[k]}",
  "    case $x in",
  "      --file=*) tw=$k; break ;;",
  "      --file|-f) tw=$((k+1)); break ;;",
  "      --*) ;;",
  "      *f) if [[ $x == -* ]] || [ \"$k\" = \"$((p+1))\" ]; then tw=$((k+1)); break; fi ;;",
  "    esac",
  "  done",
  "  [ \"$tw\" -ge 0 ] && cps=1",
  "  return 0",
  "}",
  "# at_pw_nohere TEXT: AT_NH, TEXT with every here-document body dropped (its << line kept): the body is text,",
  "# not words the shell runs. TEXT as written when a body has no end line, or an unquoted body holds $( or a backtick.",
  "at_pw_nohere() {",
  "  local s=$1 out='' q='' c i j w k l n=${#1} f sub=0; local -a pend=() pq=()",
  "  AT_NH=$1",
  "  [[ $s == *'<<'* ]] && [ \"$n\" -le 65536 ] || return 0",
  "  for ((i=0; i<n; i++)); do",
  "    c=${s:i:1}",
  "    if [ \"$c\" = '\\' ] && [ \"$q\" != \"'\" ]; then out+=${s:i:2}; i=$((i+1)); continue; fi",
  "    if [ \"$q\" = \"'\" ]; then [ \"$c\" != \"'\" ] || q=''; out+=$c; continue; fi",
  "    # inside double quotes only a $( ... ) holds a here-document",
  "    if [ \"$q\" = '\"' ]; then",
  "      case $c in '\"') q=''; sub=0 ;; ')') sub=0 ;; '$') [ \"${s:i+1:1}\" != '(' ] || sub=1 ;; esac",
  "      if [ \"$sub\" = 0 ] || [[ $c != '<' && $c != $'\\n' ]]; then out+=$c; continue; fi",
  "    fi",
  "    case $c in",
  "      \\'|\\\") [ -n \"$q\" ] || q=$c; out+=$c ;;",
  "      '<')",
  "        if [ \"${s:i:3}\" = '<<<' ]; then out+='<<<'; i=$((i+2)); continue; fi",
  "        if [ \"${s:i:2}\" != '<<' ]; then out+=$c; continue; fi",
  "        j=$((i+2)); [ \"${s:j:1}\" != - ] || j=$((j+1))",
  "        while [[ ${s:j:1} == [[:blank:]] ]]; do j=$((j+1)); done",
  "        w=${s:j}; w=${w%%[!A-Za-z0-9_\\'\\\"]*}; k=${w//[\\'\\\"]/}",
  "        if [ -n \"$k\" ]; then pend+=(\"$k\"); if [ \"$k\" = \"$w\" ]; then pq+=(0); else pq+=(1); fi; fi",
  "        out+=${s:i:j-i}$w; i=$((j+${#w}-1)) ;;",
  "      $'\\n')",
  "        out+=$c",
  "        while [ \"${#pend[@]}\" -gt 0 ]; do",
  "          f=0",
  "          while [ \"$i\" -lt \"$n\" ]; do",
  "            l=${s:i+1}; l=${l%%$'\\n'*}; i=$((i+1+${#l}))",
  "            while [[ $l == $'\\t'* ]]; do l=${l#?}; done",
  "            if [ \"$l\" = \"${pend[0]}\" ]; then f=1; break; fi",
  "            [ \"${pq[0]}\" = 1 ] || [[ $l != *'$('* && $l != *'`'* ]] || return 0",
  "          done",
  "          [ \"$f\" = 1 ] || return 0",
  "          pend=(\"${pend[@]:1}\"); pq=(\"${pq[@]:1}\")",
  "        done ;;",
  "      *) out+=$c ;;",
  "    esac",
  "  done",
  "  AT_NH=$out",
  "}",
  "# at_pw_noarith TEXT: AT_NA, TEXT with every $(( ... )) dropped (arithmetic names no path); one that holds a",
  "# command substitution, or is not closed, is kept.",
  "at_pw_noarith() {",
  "  local s=$1 out='' i n d x",
  "  AT_NA=$1",
  "  while [[ $s == *'$(('* ]]; do",
  "    out+=${s%%'$(('*}; s=${s#*'$(('}; d=2; n=${#s}",
  "    for ((i=0; i<n && d>0; i++)); do case ${s:i:1} in '(') d=$((d+1)) ;; ')') d=$((d-1)) ;; esac; done",
  "    [ \"$d\" = 0 ] || return 0",
  "    x=${s:0:i}",
  "    if [[ $x == *'$('* || $x == *'`'* ]]; then out+='$(('$x; fi",
  "    s=${s:i}",
  "  done",
  "  AT_NA=$out$s",
  "}",
  "# at_pw_seg: the words of one segment (seg) into the lists; a cd sets the folder later relative words are read from (cdp).",
  "at_pw_seg() {",
  "  local p=0 n=${#seg[@]} base='' des=0 wr=0 tgt=0 j w c e ri=-1 isrun=0 issrc=0 wpos=0 cps=0 last=-1 tt=0 lst=0 tw=-1",
  "  while [ \"$p\" -lt \"$n\" ]; do",
  "    w=${seg[p]}",
  "    # for, select and case open a list or a pattern: the words after them run nothing",
  "    case $w in for|select|case) lst=1 ;; esac",
  "    if [[ $w =~ ^[a-z_][a-z0-9_]*= || \"$AT_LEAD$AT_PW_LEAD\" == *\" $w \"* ]]; then p=$((p+1)); continue; fi",
  "    if [ \"$w\" = '>' ]; then p=$((p+2)); continue; fi",
  "    break",
  "  done",
  "  if [ \"$p\" -lt \"$n\" ]; then",
  "    base=${seg[p]##*/}",
  "    if [[ $AT_PW_SAFE$AT_PW_READS == *\" $base \"* ]] || at_reads_only \"$base\" \"${seg[@]:p+1}\" || at_pw_atread \"${seg[p]}\" \"${seg[@]:p+1}\"; then des=0; else des=1; fi",
  "    [[ $AT_PW_WRITERS == *\" $base \"* ]] && wr=1",
  "    # git rm, mv and restore change the files they name, though they count as reading git",
  "    if [ \"$base\" = git ]; then for w in \"${seg[@]:p+1}\"; do case $w in -*) ;; rm|mv|restore|checkout|clean|reset|stash|switch) AT_PW_GITW=1; des=1; wr=1; break ;; *) break ;; esac; done; fi",
  "    # find reads, unless it deletes or runs a program that does more than read",
  "    if [ \"$base\" = find ]; then des=0; for ((j=p+1; j<n; j++)); do case ${seg[j]} in -exec|-execdir|-ok|-okdir) at_find_execs \"$j\" && des=1 ;; -delete) des=1; wr=1 ;; esac; done; fi",
  "    [ \"$base\" != find ] || at_pw_find",
  "    [ \"$lst\" = 0 ] || { des=0; wr=0; }",
  "    ri=$p",
  "    case $base in bash|sh|zsh|dash|ksh) for ((j=p+1; j<n; j++)); do [[ ${seg[j]} == -* ]] || { ri=$j; break; }; done ;; esac",
  "    # a copy reads its sources: only its last word (the target) is written; so does scp (none of -o, -s, -f),",
  "    # zip (only -r -q -j -y -v and a level) with its archive first, and tar creating an archive (its -f word)",
  "    case $base in",
  "      cp|install|rsync) cps=1 ;;",
  "      scp) cps=1; for ((j=p+1; j<n; j++)); do [[ ${seg[j]} != -* || ${seg[j]} != *[osf]* ]] || cps=0; done ;;",
  "      zip) cps=1; for ((j=p+1; j<n; j++)); do w=${seg[j]}; if [[ $w == -* ]]; then [[ $w =~ ^-[rqjyv0-9]+$ ]] || cps=0; elif [ \"$tw\" -lt 0 ]; then tw=$j; fi; done ;;",
  "      tar) at_pw_tar ;;",
  "    esac",
  "    for ((j=p+1; j<n; j++)); do w=${seg[j]}; if [ \"$w\" = '>' ]; then tt=1; continue; fi; if [ \"$tt\" = 1 ]; then tt=0; continue; fi; [[ $w == -* ]] || last=$j; done",
  "    [ \"$tw\" -ge 0 ] || tw=$last",
  "  fi",
  "  for ((j=0; j<n; j++)); do",
  "    w=${seg[j]}",
  "    if [ \"$w\" = '>' ]; then tgt=1; continue; fi",
  "    [[ $w =~ ^[a-z_][a-z0-9_]*= ]] && w=${w#*=}",
  "    # a lone $ opens a command substitution $(...): it names no path",
  "    if [ -z \"$w\" ] || [ \"$w\" = '$' ]; then tgt=0; continue; fi",
  "    if [[ $w == *'$'* ]]; then e=1; at_pw_sub \"$w\"; c=$AT_SX; else e=0; c=$w; fi",
  "    # an expansion counts where the segment does more than read, or as a redirect target; one that is only",
  "    # an expansion (nothing of its own but * and /), as a redirect target only",
  "    if [ \"$e\" = 1 ] && [ \"$tgt\" = 0 ] && { [ \"$des\" = 0 ] || [ -z \"${c//[\\*\\/]/}\" ]; }; then continue; fi",
  "    # the script a segment runs (its program, or an interpreter's script), and a copy's source, are not written",
  "    isrun=0; [ \"$j\" = \"$ri\" ] && [ \"$tgt\" = 0 ] && isrun=1",
  "    issrc=0; [ \"$cps\" = 1 ] && [ \"$tgt\" = 0 ] && [ \"$j\" -gt \"$p\" ] && [ \"$j\" != \"$tw\" ] && [[ $w != -* ]] && issrc=1",
  "    wpos=0; if [ \"$tgt\" = 1 ] || { [ \"$des\" = 1 ] && [ \"$isrun\" = 0 ] && [ \"$issrc\" = 0 ]; }; then wpos=1; fi",
  "    at_pw_rel \"$c\"; at_pw_add \"$AT_RX\" \"$des\" \"$e\"",
  "    if [[ $c == *=* ]]; then at_pw_rel \"${c##*=}\"; at_pw_add \"$AT_RX\" \"$des\" \"$e\"; fi",
  "    tgt=0",
  "  done",
  "  if [ \"$base\" = cd ] || [ \"$base\" = pushd ]; then",
  "    for ((j=p+1; j<n; j++)); do",
  "      w=${seg[j]}; [[ $w == -* ]] && continue",
  "      at_pw_sub \"$w\"; if [[ $AT_SX == /* ]]; then cdp=$AT_SX; else cdp=${cdp:+$cdp/}$AT_SX; fi",
  "      break",
  "    done",
  "  fi",
  "  return 0",
  "}",
  "# at_pw_find (in at_pw_seg, a find): a find that deletes (-delete) or runs a program that does more than read",
  "# (-exec, -execdir, -ok, -okdir) adds one AT_FIND entry per starting folder, -name and -path pattern:",
  "# \"FOLDER<tab>NAME<tab>PATH\" (no -name or -path: *).",
  "# at_find_execs J (seg, n): find's -exec at word J hands the found paths ({}) to a program that does more than read.",
  "at_find_execs() {",
  "  local k x=${seg[$1+1]:-}",
  "  at_reads_only \"${x##*/}\" && return 1",
  "  # chmod that only adds permissions (+x, u+rw) takes nothing away from a guard",
  "  [[ ${x##*/} == chmod && ${seg[$1+2]:-} =~ ^[ugoa]*\\+[rwxX]+$ ]] && return 1",
  "  for ((k=$1+1; k<n; k++)); do [[ ${seg[k]} != *'{}'* ]] || return 0; done",
  "  return 1",
  "}",
  "at_pw_find() {",
  "  local j w x s d=0 k=0; local -a st nm pt",
  "  for ((j=p+1; j<n; j++)); do",
  "    w=${seg[j]}",
  "    case $w in",
  "      -delete) d=1 ;;",
  "      -exec|-execdir|-ok|-okdir) at_find_execs \"$j\" && d=1 ;;",
  "      # find matches its own patterns: a quoted glob there is live",
  "      -name|-iname) x=${seg[j+1]:-*}; [[ $x != *'$'* ]] || { at_pw_sub \"$x\"; x=$AT_SX; }; at_pw_glob \"$x\"; nm+=(\"$AT_GX\") ;;",
  "      -path|-ipath|-wholename|-iwholename) x=${seg[j+1]:-*}; [[ $x != *'$'* ]] || { at_pw_sub \"$x\"; x=$AT_SX; }; at_pw_glob \"$x\"; pt+=(\"$AT_GX\") ;;",
  "    esac",
  "    if [ \"$k\" = 0 ]; then case $w in -*|'!') k=1 ;; *) st+=(\"$w\") ;; esac; fi",
  "  done",
  "  [ \"$d\" = 1 ] || return 0",
  "  [ \"${#st[@]}\" -gt 0 ] || st=(.)",
  "  [ \"${#nm[@]}\" -gt 0 ] || nm=('*')",
  "  [ \"${#pt[@]}\" -gt 0 ] || pt=('*')",
  "  for s in \"${st[@]}\"; do",
  "    [[ $s != *'$'* ]] || { at_pw_sub \"$s\"; s=$AT_SX; }",
  "    [ -z \"$cdp\" ] || [[ $s == /* ]] || s=$cdp/$s",
  "    at_lex \"$s\"; s=$AT_LX",
  "    for w in \"${nm[@]}\"; do for x in \"${pt[@]}\"; do AT_FIND+=(\"$s\"$'\\t'\"$w\"$'\\t'\"$x\"); done; done",
  "  done",
  "  return 0",
  "}",
  "# at_find_named LIT...: a find that deletes or runs a writer reaches one of these paths: it starts in the",
  "# project root, in the path or in a folder that holds it, and its -name and -path can match it (AT_ANC).",
  "at_find_named() { local r=0; set +u; shopt -s nocasematch; _at_find_named \"$@\" || r=1; shopt -u nocasematch; set -u; return \"$r\"; }",
  "_at_find_named() {",
  "  local e s nm pt l",
  "  for e in \"${AT_FIND[@]}\"; do",
  "    s=${e%%$'\\t'*}; e=${e#*$'\\t'}; nm=${e%%$'\\t'*}; pt=${e#*$'\\t'}",
  "    for l in \"$@\"; do",
  "      if [[ $l == '?'* ]]; then l=${l#?}; [ -e \"${AT_PROJECT:-$PWD}/$l\" ] || continue; fi",
  "      if [ \"$s\" = . ] || [[ $l == $s || $l == $s/* || $AT_PW_ROOT/$l == $s/* ]]; then",
  "        if [[ ${l##*/} == $nm ]] && [[ $l == $pt || ./$l == $pt || $AT_PW_ROOT/$l == $pt ]]; then AT_ANC=$l; return 0; fi",
  "      fi",
  "    done",
  "  done",
  "  return 1",
  "}",
  "at_pw_init() { set +u; _at_pw_init; set -u; }",
  "_at_pw_init() {",
  "  local t x w n cdp='' re='^([a-z_][a-z0-9_]*)=([^$]*)$' cre='( in |;;)[[:space:]]*\\(?[^;()]*\\)' mre='(^|[[:space:];&|(])([a-z_][a-z0-9_]*)=\\$\\(mktemp( [^()]*)?\\)'",
  "  local -a ws seg",
  "  AT_CW=(); AT_CD=(); AT_CX=(); AT_RT=(); AT_FIND=(); AT_PW_MAP=' '; AT_PW_DUP=' '; AT_PW_GITW=0",
  "  AT_PW_ROOT=$(lower \"$PWD\")",
  "  # the folder the session is in (the hook input's cwd): a relative word is read from there",
  "  if [ -n \"${INPUT:-}\" ]; then",
  "    x=$(printf '%s' \"$INPUT\" | jq -r '.cwd // \"\" | strings' 2>/dev/null) || x=''",
  "    if [ -n \"$x\" ]; then at_lex \"$(lower \"$x\")\"; [ \"$AT_LX\" = . ] || cdp=$AT_LX; fi",
  "  fi",
  "  # find's own parentheses, \\( and '(', group its tests: they cut no segment",
  "  # a here-document's body and $(( ... )) are text and arithmetic, not words the shell runs",
  "  at_pw_nohere \"$CMD\"; at_pw_noarith \"$AT_NH\"",
  "  t=$AT_NA; for x in '\\(' '\\)' \"'('\" \"')'\" '\"(\"' '\")\"'; do t=${t//\"$x\"/ }; done",
  "  # what is quoted is text (with no command substitution in the command; with one, as before: quotes dropped)",
  "  if [[ $t != *'$('* && $t != *'`'* && $t == *[\\'\\\"\\\\]* ]] && [ \"${#t}\" -le 4096 ]; then at_pw_unquote \"$t\"; t=$AT_UQ; fi",
  "  t=$(lower \"$(norm \"$t\")\")",
  "  t=${t//$'\\n'/ ; }",
  "  # a name set once in the command, from $(mktemp ...), holds a temp file outside the project",
  "  x=$t; while [[ $x =~ $mre ]]; do n=${BASH_REMATCH[2]}; x=${x#*\"${BASH_REMATCH[0]}\"}; ! at_pw_once \"$t\" \"$n\" || AT_PW_MAP+=\"$n=/tmp/tmp.mktemp \"; done",
  "  # a case's patterns (after in, or ;;, up to their closing parenthesis) name no path",
  "  if [[ $t == *' case '* ]]; then while [[ $t =~ $cre ]]; do t=${t/\"${BASH_REMATCH[0]}\"/ ; }; done; fi",
  "  # &>FILE and >&FILE write FILE; 2>&1 and >&2 name a stream",
  "  t=${t//'&>'/' > '}; t=${t//'>&'/' > '}",
  "  for x in ';' '&' '|' '(' ')' '`'; do t=${t//\"$x\"/ ; }; done",
  "  t=${t//'>'/ > }; t=${t//'<'/ }",
  "  read -ra ws <<< \"$t\"",
  "  for w in \"${ws[@]}\"; do",
  "    if [[ $w =~ $re ]]; then",
  "      n=${BASH_REMATCH[1]}",
  "      if [[ $AT_PW_MAP == *\" $n=\"* ]]; then AT_PW_DUP+=\"$n \"; else AT_PW_MAP+=\"$n=${BASH_REMATCH[2]} \"; fi",
  "    fi",
  "  done",
  "  ws+=(';'); seg=()",
  "  for w in \"${ws[@]}\"; do",
  "    if [ \"$w\" != ';' ]; then seg+=(\"$w\"); continue; fi",
  "    [ \"${#seg[@]}\" = 0 ] || { at_pw_text; [ \"${#seg[@]}\" = 0 ] || at_pw_seg; }",
  "    seg=()",
  "  done",
  "  return 0",
  "}",
  "# at_path_named LIT GLOB NAME [ok|rt]: a word names the path: it is LIT, or a word with an expansion read as *",
  "# matches LIT, or the word matches GLOB. ok: only words in a write position (AT_CX); rt: only redirect",
  "# targets (AT_RT). A glob written in the command was read as the files it expands to. Case is not told apart.",
  "at_path_named() { local r=0; set +u; shopt -s nocasematch; _at_path_named \"$@\" || r=1; shopt -u nocasematch; set -u; return \"$r\"; }",
  "_at_path_named() {",
  "  local lit=$1 g=$2 c; local -a cw",
  "  case ${4:-} in ok) cw=(\"${AT_CX[@]}\") ;; rt) cw=(\"${AT_RT[@]}\") ;; *) cw=(\"${AT_CW[@]}\") ;; esac",
  "  for c in \"${cw[@]}\"; do",
  "    if [ -n \"$lit\" ] && [[ $lit == $c || $AT_PW_ROOT/$lit == $c ]]; then return 0; fi",
  "    if [[ $c == $g || $c == */$g ]]; then return 0; fi",
  "  done",
  "  return 1",
  "}",
  "# at_anc_named LIT GLOB ...: a word of a segment that does more than read names one of these folders (AT_ANC).",
  "at_anc_named() { local r=0; set +u; shopt -s nocasematch; _at_anc_named \"$@\" || r=1; shopt -u nocasematch; set -u; return \"$r\"; }",
  "_at_anc_named() {",
  "  local a g c",
  "  while [ \"$#\" -ge 2 ]; do",
  "    a=$1; g=$2; shift 2",
  "    for c in \"${AT_CD[@]}\"; do",
  "      if [[ $a == $c || $AT_PW_ROOT/$a == $c || $c == $g || $c == */$g ]]; then AT_ANC=$a; return 0; fi",
  "    done",
  "  done",
  "  return 1",
  "}",
  "# at_reads_plain [LIT GLOB NAME]: every program in the command only reads its arguments, nothing is tee'd, no git",
  "# rm, mv or restore is among it, and no redirect writes the path. A redirect elsewhere (2>/dev/null, 2>&1,",
  "# > build/out) does not make a read a write.",
  "at_reads_plain() {",
  "  local r=1; set +u; shopt -s nocasematch",
  "  if at_reads_segs && [ \"$AT_PW_GITW\" = 0 ] && { [ \"$#\" = 0 ] || ! { _at_path_named \"$1\" \"$2\" \"${3:-}\" rt || at_rt_letters \"${4:-}\"; }; }; then r=0; fi",
  "  shopt -u nocasematch; set -u; return \"$r\"",
  "}",
  "# at_rt_letters LETTERS: a redirect target holds the path's letters (the guard's letters fallback, as for its words).",
  "at_rt_letters() { local c; [ -n \"$1\" ] || return 1; for c in \"${AT_RT[@]}\"; do [[ ${c//[^a-z0-9]/} != *\"$1\"* ]] || return 0; done; return 1; }",
  "# at_reads_segs: at_only_reads, its redirections aside (SEGS holds the command without them).",
  "at_reads_segs() {",
  "  local seg x base; local -a ws",
  "  [[ $(lower \"$(norm \"$CMD\")\") != *tee* ]] || return 1",
  "  while IFS= read -r seg || [ -n \"$seg\" ]; do",
  "    read -ra ws <<< \"$(lower \"$(norm \"$seg\")\")\"",
  "    x=0",
  "    while [ \"$x\" -lt \"${#ws[@]}\" ] && [[ \"$AT_LEAD$AT_PW_LEAD\" == *\" ${ws[x]} \"* ]]; do x=$((x+1)); done",
  "    [ \"$x\" -lt \"${#ws[@]}\" ] || continue",
  "    [[ ${ws[x]} =~ ^[a-z_][a-z0-9_]*= ]] && return 1",
  "    at_special \"${ws[x]}\" && return 1",
  "    base=${ws[x]##*/}",
  "    [[ $AT_PW_READS == *\" $base \"* ]] || at_reads_only \"$base\" \"${ws[@]:x+1}\" || at_pw_atread \"${ws[x]}\" \"${ws[@]:x+1}\" || return 1",
  "  done <<< \"$SEGS\"",
  "  return 0",
  "}",
];

/** A protected path as the shell arguments at_path_named takes: LIT (its {unit} as `u`), GLOB, NAME. */
function pathArgs(path: string): string {
  const lower = path.toLowerCase();
  const base = lower.replace(/^.*\//, "");
  const glob = lower.split("{unit}").map((x) => x.replace(/[*?[\]\\]/g, "\\$&")).join("*");
  const name = base.includes("{unit}") ? "" : base.replace(/[*?[\]\\]/g, "\\$&");
  return [lower.replace(/\{unit\}/g, "u"), glob, name].map(shellQuote).join(" ");
}

/** The folders that hold `paths` (the project root not among them), as LIT GLOB pairs for at_anc_named. */
function ancestorArgs(paths: string[]): string {
  const seen = new Set<string>();
  for (const path of paths) {
    const parts = path.toLowerCase().replace(/^\.\//, "").split("/");
    for (let i = 1; i < parts.length; i++) seen.add(parts.slice(0, i).join("/"));
  }
  return [...seen].filter((a) => a && a !== ".").map((a) => `${shellQuote(a.replace(/\{unit\}/g, "u"))} ${shellQuote(a.split("{unit}").map((x) => x.replace(/[*?[\]\\]/g, "\\$&")).join("*"))}`).join(" ");
}

/** `paths` and the folders that hold them, lower case, {unit} as `u`: the LIT arguments of at_find_named. */
function findLits(paths: string[]): string {
  const out = new Set<string>();
  for (const path of paths) {
    const parts = path.toLowerCase().replace(/^\.\//, "").replace(/\{unit\}/g, "u").split("/");
    for (let i = 1; i <= parts.length; i++) out.add(parts.slice(0, i).join("/"));
  }
  return [...out].filter((x) => x && x !== ".").map(shellQuote).join(" ");
}

/** The generated guard scripts a topology may hold, by file name (0.13.0): an edit of one would switch a guard off. */
function guardScriptNames(ast: TopologyAST): string[] {
  const ids = (t: string) => ast.nodes.filter((n) => n.type === t).map((n) => n.id);
  return [
    "before-edit.sh", "before-action.sh", "before-agent.sh", "before-read.sh", "after-action.sh", "route.sh",
    "taint-mark.sh", "taint-guard.sh", "spawn-guard.sh",
    "talk-guard.sh", "caps-log.sh", "max-subagents.sh", "timeout.sh", "lead-timeout.sh",
    ...ids("gate").map((id) => `gate-${id}.sh`),
    ...(ast.records ?? []).map((r) => `record-${r.id}.sh`),
    ...ids("human").map(goHookScript),
    ...ids("agent").flatMap((id) => [promptLogScript(id), `output-schema-${id}.sh`]),
    ...outputIntoTargets(ast, CLAUDE_CODE_GUARDS).map(({ agent }) => outputIntoScript(agent.id)),
    // 0.13.1: the run controls' scripts, named only when the topology uses their field (other topologies are unchanged)
    ...(ast.nodes.some((n) => n.type === "human" && (n as HumanNode).stopWord !== undefined) ? ["go-halt.sh"] : []),
    ...(ast.nodes.some((n) => n.type === "agent" && n.id === ast.topology.entry && (n as AgentNode).wallTime !== undefined) ? ["wall-start.sh", "wall-time.sh"] : []),
    ...(ast.egress ? ["egress-guard.sh", "egress-observability.sh"] : []),
  ];
}

/**
 * The files the guards trust and scaffold writes (0.13.0): every generated guard script, the hooks file
 * (settings.json, and settings.local.json on Claude Code) and the scaffold manifest. An edit or a Bash
 * write of one is refused; scaffold, run outside a session, is not held by them.
 */
export function guardOwnFiles(ast: TopologyAST, p: GuardPlatform): string[] {
  const dir = p.hooksFile.replace(/\/[^/]*$/, "");
  return [
    ...guardScriptNames(ast).map((n) => `${p.scriptsDir(ast.topology.name)}/${n}`),
    // before-schedule.sh: written only on Claude Code, and only with a human who has a go word
    ...(p.id ===CLAUDE_CODE_GUARDS.id && goScriptPaths(ast, p).length > 0 ? [`${p.scriptsDir(ast.topology.name)}/before-schedule.sh`] : []),
    p.hooksFile,
    ...(p.id === CLAUDE_CODE_GUARDS.id ? [`${dir}/settings.local.json`] : []),
    `${dir}/.scaffold-manifest.json`,
    `${dir}/.scaffold-manifest.${ast.topology.name.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`,
  ];
}

/** The generated guard scripts among guardOwnFiles (0.13.0): the files whose text holds the guards. */
export function guardScriptPaths(ast: TopologyAST, p: GuardPlatform): string[] {
  const dir = `${p.scriptsDir(ast.topology.name)}/`;
  return guardOwnFiles(ast, p).filter((f) => f.startsWith(dir));
}

/**
 * The line scaffold prints, and the note guard --check gives, for a guard script at its generated path
 * that scaffold kept instead of regenerating (a file it did not write, or one edited since): the guards
 * this version writes are not in it. A kept file is never replaced, --force included.
 */
export function keptGuardScriptLine(path: string, version: string): string {
  return `kept your ${path}: the new ${version} guards are NOT in it; delete it and scaffold again to have it generated (--force does not replace it), or merge by hand`;
}

/**
 * Whether the guards protect their own files and the folders of the protected ones (0.13.0): only where
 * there is something a person's word stands on: a human with a go word, or a ledger, approvals or taint
 * state a guard reads. A plain topology's guards carry none of it.
 */
export function protectsOwnFiles(ast: TopologyAST, p: GuardPlatform): boolean {
  return goScriptPaths(ast, p).length > 0 || protectedLedgers(ast, p).length > 0;
}

/** The guards' own files as no-jq word lists (noJqLines inOrder): each file name's letters. */
function ownFileWords(ast: TopologyAST, p: GuardPlatform): string[][] {
  if (!protectsOwnFiles(ast, p)) return [];
  return [...new Set(guardOwnFiles(ast, p).map((f) => lettersOf(f.replace(/^.*\//, ""))))].filter(Boolean).map((l) => [l]);
}

/**
 * The before-action.sh lines that refuse a command naming a file the guards trust (guardOwnFiles), or
 * removing, moving or writing a folder that holds one or any other protected file. Needs PATH_FUNCTIONS
 * (at_pw_init run) and at_only_reads.
 */
function ownFilesGuardLines(own: string[], held: string[], scripts: Set<string>): string[] {
  // a generated script is guarded where the topology has it (a ? before its path: only when it exists)
  const lits = findLits([...own, ...held]).split(" ").filter(Boolean)
    .map((l) => (scripts.has(l.replace(/^'|'$/g, "")) ? `'?${l.slice(1)}` : l)).join(" ");
  return [
    "# 0.13.0: the guards' own files. A command that names one and does more than read it is refused, and so",
    "# is one that removes, moves or writes a folder holding a protected file. Running one (bash route.sh ...) is",
    "# not refused here: the go hooks, the one script whose run writes what a person must, are guarded above.",
    "# own_guard LIT GLOB NAME PATH [s]: refuse a command that writes PATH (a word of it in a write position:",
    "# a redirect target, or an argument of a program that does more than read, a copy's source aside).",
    "# s: a generated script, guarded only where the topology has it.",
    "own_guard() {",
    "  [ -z \"${5:-}\" ] || [ -e \"${AT_PROJECT:-$PWD}/$4\" ] || return 0",
    "  at_path_named \"$1\" \"$2\" \"$3\" ok || return 0",
    "  echo \"agentopology: the command changes $4, which agentopology scaffold writes and the guards trust; ask the person ($CMD)\" >&2",
    "  exit 2",
    "}",
    ...own.map((f) => `own_guard ${pathArgs(f)} ${shellQuote(f)}${scripts.has(f) ? " s" : ""}`),
    "# a find that deletes, or runs a writer, from a folder that holds a protected file, with a -name or -path that can match it",
    `if at_find_named ${lits}; then`,
    "  echo \"agentopology: the command runs find over $AT_ANC, which the guards protect; ask the person ($CMD)\" >&2",
    "  exit 2",
    "fi",
    `if at_anc_named ${ancestorArgs([...own, ...held])} && ! at_reads_plain; then`,
    "  echo \"agentopology: the command removes, moves or writes the folder $AT_ANC, which holds files the guards protect; ask the person ($CMD)\" >&2",
    "  exit 2",
    "fi",
    "",
  ];
}

/** at_only_reads (F-4): every program in the command only reads its arguments, and nothing is redirected or tee'd. */
function atOnlyReadsLines(): string[] {
  return [
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
  ];
}

/** The project paths of the topology's go hooks (claude-code only): the agent must not run or change them. */
function goScriptPaths(ast: TopologyAST, p: GuardPlatform): string[] {
  if (p.id !== CLAUDE_CODE_GUARDS.id) return [];
  return goHumans(ast, p).map((h) => `${p.scriptsDir(ast.topology.name)}/${goHookScript(h.id)}`);
}

/**
 * The before-action.sh lines that refuse a command naming a go hook unless it only reads it: run by the
 * agent with a payload it wrote, the hook would write the go row nobody typed. Needs ledgerGuardLines
 * (a go hook always has a ledger, so they are there).
 */
function goScriptGuardLines(paths: string[]): string[] {
  if (paths.length === 0) return [];
  return [
    "# The go: a human's go hook writes the go row from a typed prompt. A command that names it and does",
    "# more than read it (runs it with a payload of its own, or writes it) is refused.",
    "go_script_guard() {",
    "  local hit=0 w",
    "  for w in $(norm \"$CMD\"); do if [[ $w == \"$1\" || $w == */\"$1\" ]]; then hit=1; fi; done",
    "  [[ $CMD_L == *\"$2\"* ]] && hit=1",
    "  # 0.13.0: also a glob (go-*.sh), a cd first, a for loop's list, find's -exec, a variable of the command's own",
    "  at_path_named \"$4\" \"$5\" \"$6\" && hit=1",
    "  [ \"$hit\" = 1 ] || return 0",
    "  at_reads_plain \"$4\" \"$5\" \"$6\" \"$2\" && return 0",
    "  echo \"agentopology: the command runs or changes the go hook $3; only a prompt the person types runs it ($CMD)\" >&2",
    "  exit 2",
    "}",
    ...paths.map((path) => {
      const base = path.replace(/^.*\//, "");
      return `go_script_guard ${shellQuote(base)} ${shellQuote(lettersOf(base))} ${shellQuote(path)} ${pathArgs(path)}`;
    }),
    "",
  ];
}

/** A go word as the words a guard compares: lower case, every run of characters other than a-z 0-9 one space. */
export function goWordWords(word: string): string {
  return word.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * The runner steps a `claude` call from Bash may match (the words after `claude`, as stepKey reads them):
 * every declared action command whose program is `claude`, and every schedule job with an agent, whose
 * generated script runs `claude -p "..." --agent <agent>` (its fixed words: -p, then --agent <agent>).
 */
export function claudeRunners(ast: TopologyAST): string[] {
  const fromActions = ast.nodes.flatMap((n) => (n.type === "action" ? (n as ActionNode).commands ?? [] : []))
    .map(stepKey).filter((k) => k.key === "claude").map((k) => k.rest);
  const fromSchedules = (ast.schedules ?? []).filter((j) => j.agent).map((j) => `-p --agent ${j.agent!.toLowerCase()}`);
  return [...new Set([...fromActions, ...fromSchedules])];
}

/**
 * The before-action.sh lines that keep a `claude` run from Bash from giving the go (claude-code, a human
 * with `word:`): a new session's prompt fires UserPromptSubmit, and the go hook would read it as typed.
 * A segment runs `claude` when the step matcher reads `claude` as a program there (seg_steps: by any path,
 * after env/timeout/npx or any program that can run its arguments). The command is refused when it runs
 * `claude` and holds a go word anywhere (its words, cut at every character other than a-z 0-9, lower case:
 * a prompt argument, a pipe or a here-string into it); when a run of `claude` cannot be read (an expansion
 * among its words); and when a run matches no runner step (claudeRunners: the runner's words in order
 * after `claude`, as a script step is matched). A command that holds the word and runs no `claude` runs.
 * Needs MATCH_FUNCTIONS, $CMD, $CMD_L and $SEGS.
 */
function goEntryGuardLines(ast: TopologyAST, p: GuardPlatform): string[] {
  if (goScriptPaths(ast, p).length === 0) return [];
  const sq = shellQuote;
  const words = goHumans(ast, p).map((h) => h.word!.trim());
  const runners = claudeRunners(ast);
  const route = protectedRouteRecord(ast, p);
  const held = [...guardOwnFiles(ast, p), ...protectedLedgers(ast, p).map((l) => l.path), ...(route ? [route.path] : []), ...goScriptPaths(ast, p)];
  const typists =[...new Set([...KEYSTROKE_PROGRAMS, ...goHumans(ast, p).flatMap((h) => h.typedOnlyPrograms ?? []).map((t) => t.toLowerCase())])];
  const wordTests = words.map((w) => {
    const ws = goWordWords(w);
    // a word with no a-z 0-9 at all is looked for as written
    return ws ? `[[ $AT_GO_CMD == *${sq(` ${ws} `)}* ]]` : `[[ $CMD == *${sq(w)}* ]]`;
  });
  return [
    "# The go, through a new session: a `claude` run from Bash submits its prompt as a prompt, which the go",
    "# hook would read as typed. A command that runs claude is refused when it holds a go word anywhere, when",
    "# a run of claude cannot be read, and when a run matches no runner step the topology declares.",
    `# Runner steps: ${runners.length ? runners.map((r) => `claude ${r}`.trim()).join("; ") : "none"}.`,
    "# Not seen: claude run by another script, or a prompt it reads from a file or another program's output.",
    "AT_GO_CMD=\" $(printf '%s' \"$CMD\" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' ' ' | tr -s ' ') \"",
    "# 0.13.0: Claude Code's package name (npx, pnpm dlx, bunx, yarn dlx; any version, any file in it) runs claude.",
    "at_claude_pkg() { local w o=' '; for w in $1; do [[ $w != *anthropic-ai/claude-code* ]] || w=claude; o+=\"$w \"; done; printf '%s' \"$o\"; }",
    "AT_CLAUDE=0; AT_CLAUDE_DOUBT=0; AT_CLAUDE_OFF=0",
    "while IFS= read -r -u 3 C || [ -n \"$C\" ]; do",
    '  L=$(lower "$(norm "$C")")',
    "  [[ $L != *anthropic-ai/claude-code* ]] || L=$(at_claude_pkg \"$L\")",
    "  SEG_DOUBT=0; seg_steps \"$L\" claude ''",
    '  [ "$SEG_N" -gt 0 ] || [ "$SEG_DOUBT" = 1 ] || continue',
    "  AT_CLAUDE=1; AT_N=$SEG_N",
    '  [ "$SEG_DOUBT" = 1 ] && AT_CLAUDE_DOUBT=1',
    "  AT_M=0",
    ...runners.map((r) => `  SEG_DOUBT=0; seg_steps "$L" claude ${sq(r)}; [ "$SEG_N" -ge "$AT_N" ] && AT_M=1`),
    '  [ "$AT_M" = 1 ] || AT_CLAUDE_OFF=1',
    'done 3<<< "$SEGS"',
    'if [ "$AT_CLAUDE" = 1 ]; then',
    `  if ${wordTests.join(" || ")}; then`,
    '    echo "agentopology: the command runs claude and holds a go word; a claude run submits its prompt as a prompt, and only the person types the go ($CMD)" >&2',
    "    exit 2",
    "  fi",
    '  if [ "$AT_CLAUDE_DOUBT" = 1 ]; then',
    '    echo "agentopology: the command runs claude in a form this guard cannot read (an expansion among its words), so it cannot tell the prompt holds no go word; write the prompt out ($CMD)" >&2',
    "    exit 2",
    "  fi",
    '  if [ "$AT_CLAUDE_OFF" = 1 ]; then',
    runners.length
      ? `    echo ${sq(`agentopology: the command runs claude, and the run matches no runner step this topology declares (${runners.map((r) => `claude ${r}`.trim()).join("; ")}); a claude run submits its prompt as a prompt, which could give the go nobody typed `)}"($CMD)" >&2`
      : '    echo "agentopology: the command runs claude, and this topology declares no runner step for it (an action whose commands run claude, or a schedule job); a claude run submits its prompt as a prompt, which could give the go nobody typed ($CMD)" >&2',
    "    exit 2",
    "  fi",
    "fi",
    "# 0.13.0: a deferred run. at, batch and systemd-run run their input (stdin, a here-string, their arguments) later,",
    "# where no guard reads it. One run as a program (after wrappers such as sudo, nohup, timeout, or a shell's -c)",
    "# in a command that holds a claude call, a go word or a protected file's name is refused. nohup, setsid and",
    "# disown run it now, in this command, and the checks above and below already read it.",
    `AT_HELD_L=${sq(` ${[...new Set(held.map((f) => protectedFile(f).letters).filter(Boolean))].join(" ")} `)}`,
    "at_defer_holds() {",
    "  local l",
    `  [[ $AT_GO_CMD == *' claude '* || $CMD_L == *anthropicaiclaudecode* ]] && return 0`,
    `  if ${wordTests.join(" || ")}; then return 0; fi`,
    "  for l in $AT_HELD_L; do [[ $CMD_L != *\"$l\"* ]] || return 0; done",
    "  return 1",
    "}",
    "# at_prog_at WORD...: AT_PX, the offset of the program the words run, past assignments, if/then/..., and",
    "# wrappers (sudo, nohup, timeout, setsid, a shell's -c, ...) with their options; the word count when none.",
    "at_prog_at() {",
    "  local b; AT_PX=0",
    "  while [ \"$AT_PX\" -lt \"$#\" ]; do",
    "    b=${@:AT_PX+1:1}",
    "    if [[ $b =~ ^[a-z_][a-z0-9_]*= || \"$AT_LEAD\" == *\" $b \"* || $b == -* || $b =~ ^[0-9.]+[smhd]?$ ]]; then AT_PX=$((AT_PX+1)); continue; fi",
    "    case ${b##*/} in env|sudo|doas|nice|nohup|timeout|command|exec|stdbuf|ionice|chrt|taskset|setsid|time|unbuffer|sh|bash|zsh|dash|ksh) AT_PX=$((AT_PX+1)); continue ;; esac",
    "    return 0",
    "  done",
    "}",
    "at_defer_prog() {",
    "  local b; local -a ws",
    "  read -ra ws <<< \"$1\"",
    "  at_prog_at \"${ws[@]}\"",
    "  [ \"$AT_PX\" -lt \"${#ws[@]}\" ] || return 1",
    "  b=${ws[AT_PX]}",
    "  at_names \"$b\" at || at_names \"$b\" batch || at_names \"$b\" systemd-run",
    "}",
    "if at_defer_holds; then",
    "  while IFS= read -r -u 3 C || [ -n \"$C\" ]; do",
    '    if at_defer_prog "$(lower "$(norm "$C")")"; then',
    '      echo "agentopology: the command hands a claude call, a go word or a file the guards protect to a deferred run (at, batch, systemd-run), which runs it later where no guard reads it; only the person types the go ($CMD)" >&2',
    "      exit 2",
    "    fi",
    '  done 3<<< "$SEGS"',
    "fi",
    "# 0.13.0: a crontab is a deferred run too. crontab run as a program (as above) installs a crontab unless it",
    "# lists (-l) or removes (-r); its content is the command's (stdin through a pipe, a here-string, `-`) and,",
    "# with a file argument, that file's, read here. Both are held to the checks above (at_defer_holds), which",
    "# read words and letters only: a line's schedule (`* * * * *`) is no glob and is never matched as one.",
    "# A file this guard cannot read (missing, an expansion, a relative path after a cd) is refused.",
    "at_cron_seg() {",
    "  local i n w; local -a ws lw",
    "  read -ra ws <<< \"$(norm \"$1\")\"",
    "  read -ra lw <<< \"$(lower \"$(norm \"$1\")\")\"",
    "  at_prog_at \"${lw[@]}\"",
    "  [ \"$AT_PX\" -lt \"${#lw[@]}\" ] || return 1",
    "  at_names \"${lw[AT_PX]}\" crontab || return 1",
    "  AT_CRON_FILE=''; n=${#ws[@]}; i=$((AT_PX+1))",
    "  while [ \"$i\" -lt \"$n\" ]; do",
    "    w=${ws[i]}",
    "    case $w in",
    "      -u) i=$((i+1)) ;;",
    "      -) ;;",
    "      -*) [[ $w == *[lrLR]* ]] && return 1 ;;",
    "      *) AT_CRON_FILE=$w ;;",
    "    esac",
    "    i=$((i+1))",
    "  done",
    "  return 0",
    "}",
    "# at_text_holds TEXT: at_defer_holds on TEXT (a crontab file's content) in place of the command.",
    "at_text_holds() {",
    "  local CMD=$1 CMD_L AT_GO_CMD",
    "  CMD_L=$(letters \"$1\")",
    "  AT_GO_CMD=\" $(printf '%s' \"$1\" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' ' ' | tr -s ' ') \"",
    "  at_defer_holds",
    "}",
    "at_cron_file() {",
    "  local f=$1 d=''",
    "  at_special \"$f\" && return 1",
    "  if [[ $f != /* ]]; then",
    "    [[ \" $(lower \"$(norm \"$CMD\")\") \" == *[[:space:]\\;\\&\\|\\(]cd[[:space:]]* || $CMD == *pushd* ]] && return 1",
    "    [ -n \"${INPUT:-}\" ] && d=$(printf '%s' \"$INPUT\" | jq -r '.cwd // \"\" | strings' 2>/dev/null)",
    "    [ -n \"$d\" ] && f=$d/$f",
    "  fi",
    "  [ -f \"$f\" ] && [ -r \"$f\" ] || return 1",
    "  AT_CRON_TEXT=$(head -c 1048576 -- \"$f\" 2>/dev/null) || return 1",
    "}",
    "while IFS= read -r -u 3 C || [ -n \"$C\" ]; do",
    '  at_cron_seg "$C" || continue',
    '  if [ -n "$AT_CRON_FILE" ]; then',
    '    if ! at_cron_file "$AT_CRON_FILE"; then',
    '      echo "agentopology: the command installs a crontab from a file this guard cannot read ($AT_CRON_FILE), so it cannot tell the file holds no claude call, go word or protected file; a crontab runs it later where no guard reads it ($CMD)" >&2',
    "      exit 2",
    "    fi",
    '    if at_text_holds "$AT_CRON_TEXT"; then',
    '      echo "agentopology: the command installs a crontab whose file ($AT_CRON_FILE) holds a claude call, a go word or a file the guards protect; a crontab runs it later where no guard reads it, and only the person types the go ($CMD)" >&2',
    "      exit 2",
    "    fi",
    "  fi",
    "  if at_defer_holds; then",
    '    echo "agentopology: the command installs a crontab that holds a claude call, a go word or a file the guards protect; a crontab runs it later where no guard reads it, and only the person types the go ($CMD)" >&2',
    "    exit 2",
    "  fi",
    'done 3<<< "$SEGS"',
    "# 0.13.0: a terminal device. Text written to /dev/pts/*, /dev/tty* or /dev/console reaches the person's",
    "# terminal as if typed, and an agent has no reason to write there: a command that names one (also as a glob,",
    "# through $(tty), in dd's of=) is refused, unless it only reads it with <.",
    "at_tty_write() {",
    "  local t w d re='(^|[^<0-9&])[0-9]*<[[:space:]]*/dev/(tty|pts|console)[^[:space:];&|)]*'",
    "  t=$(lower \"$CMD\")",
    "  [[ $t == *dev* || $t == *tty* ]] || return 1",
    "  while [[ $t =~ $re ]]; do t=${t/\"${BASH_REMATCH[0]}\"/ }; done",
    "  [[ $t == *'$(tty)'* || $t == *'`tty`'* ]] && return 0",
    "  for w in $(norm \"$t\"); do",
    "    [[ $w == *dev/* ]] || continue",
    "    w=${w##*dev/}; w=${w%%/*}",
    "    [ -n \"$w\" ] || continue",
    "    for d in pts tty tty1 console; do [[ $d == $w* || $w == $d* ]] && return 0; done",
    "  done",
    "  return 1",
    "}",
    "if at_tty_write; then",
    '  echo "agentopology: the command writes to a terminal device (/dev/pts, /dev/tty, /dev/console), where the text reads as typed by the person; only the person types the go ($CMD)" >&2',
    "  exit 2",
    "fi",
    "# Keystrokes typed into the person's terminal are a prompt the person seems to type. A command that runs",
    "# a keystroke tool (the built-in ones, and the human's typed-only-programs) and holds a go word is refused.",
    "# Not seen: any other way to type into the person's terminal.",
    "while IFS= read -r -u 3 C || [ -n \"$C\" ]; do",
    '  L=$(lower "$(norm "$C")")',
    ...typists.map((t) => `  SEG_DOUBT=0; seg_steps "$L" ${sq(t)} ''; if [ "$SEG_N" -gt 0 ] && { ${wordTests.join(" || ")}; }; then echo ${sq(`agentopology: the command runs ${t}, which types into a terminal, and holds a go word; only the person types the go `)}"($CMD)" >&2; exit 2; fi`),
    'done 3<<< "$SEGS"',
    "# 0.13.0: keys typed one by one. Every key a keystroke tool types in the command (tmux send-keys and its chained",
    "# send-keys, screen's stuff, the other tools' arguments) is joined in order, a key name dropped (Enter, Space,",
    "# C-m; not under send-keys -l), and the go word's letters looked for in the joined letters.",
    `AT_TYPISTS=${sq(` ${typists.join(" ")} `)}`,
    "AT_KEYS=''",
    "at_keys_seg() {",
    "  local n m='' lit=0 w t; local -a ws",
    "  read -ra ws <<< \"$1\"; at_pkg_seg ${ws[@]+\"${ws[@]}\"}; ws=(${AT_PW[@]+\"${AT_PW[@]}\"}); n=${#ws[@]}",
    "  at_prog_at \"${ws[@]}\"",
    "  [ \"$AT_PX\" -lt \"$n\" ] || return 0",
    "  w=${ws[AT_PX]}",
    "  if at_names \"$w\" tmux; then m=tmux",
    "  elif at_names \"$w\" screen; then m=screen",
    "  elif [ \"$w\" = send-keys ] || [ \"$w\" = send ]; then m=keys",
    "  else for t in $AT_TYPISTS; do at_names \"$w\" \"$t\" && m=other; done",
    "  fi",
    "  [ -n \"$m\" ] || return 0",
    "  for ((AT_PX=AT_PX+1; AT_PX<n; AT_PX++)); do",
    "    w=${ws[AT_PX]}",
    "    case $m in",
    "      tmux) case $w in send-keys|send) m=keys; lit=0 ;; -l|-s|-f|-c|-t) AT_PX=$((AT_PX+1)) ;; esac ;;",
    "      screen) [ \"$w\" != stuff ] || m=stuff ;;",
    "      stuff) AT_KEYS+=$w ;;",
    "      keys)",
    "        case $w in",
    "          -t|-n|-c) AT_PX=$((AT_PX+1)); continue ;;",
    "          -l) lit=1; continue ;;",
    "          -*) continue ;;",
    "          send-keys|send) lit=0; continue ;;",
    "        esac",
    "        if [ \"$lit\" = 0 ]; then",
    "          case $w in",
    "            space) AT_KEYS+=' '; continue ;;",
    "            enter|tab|btab|bspace|escape|up|down|left|right|home|end|npage|ppage|pgup|pgdn|pageup|pagedown|ic|dc|kpenter|f[0-9]|f[0-9][0-9]|[cms]-*) continue ;;",
    "          esac",
    "        fi",
    "        AT_KEYS+=$w ;;",
    "      other) case $w in -*|type|key|keydown|keyup|keystroke|tell|application|system|events|to) ;; *) AT_KEYS+=$w ;; esac ;;",
    "    esac",
    "  done",
    "}",
    "while IFS= read -r -u 3 C || [ -n \"$C\" ]; do",
    '  set +u; at_keys_seg "$(lower "$(norm "$C")")"; set -u',
    'done 3<<< "$SEGS"',
    "if [ -n \"$AT_KEYS\" ]; then",
    "  AT_KEYS_L=$(letters \"$AT_KEYS\")",
    `  if ${words.map((w) => lettersOf(w)).filter(Boolean).map((l) => `[[ $AT_KEYS_L == *${sq(l)}* ]]`).join(" || ") || "false"}; then`,
    '    echo "agentopology: the command types keys into a terminal that spell a go word, one by one or across send-keys calls; only the person types the go ($CMD)" >&2',
    "    exit 2",
    "  fi",
    "fi",
    "",
  ];
}

/** Programs that type keystrokes into a terminal or pane; with a go word in the command, before-action.sh refuses them. */
export const KEYSTROKE_PROGRAMS = ["tmux", "screen", "xdotool", "osascript", "wtype", "ydotool"];

/**
 * before-schedule.sh (claude-code, a human with `word:`): a PreToolUse hook on CronCreate|ScheduleWakeup.
 * A scheduled or /loop prompt fires UserPromptSubmit as written, so one the model creates that starts with
 * a go word would give the go. Every string in tool_input is read (the prompt; the docs name a scheduled
 * task's `prompt` field in Stop input's session_crons), leading spaces and a leading `/loop` with an optional
 * interval dropped, and matched as the go hook matches: the word, trimmed, alone or followed by a space or
 * one of , . : ; ! ?. A match, input that is not JSON, or no jq: exit 2. Null with no go human.
 */
export function generateBeforeScheduleScript(ast: TopologyAST, p: GuardPlatform): GeneratedFile | null {
  if (goScriptPaths(ast, p).length === 0) return null;
  const name = ast.topology.name;
  const words = goHumans(ast, p).map((h) => h.word!.trim());
  const filter = [
    "def hit($w): (sub(\"\\\\s+\\\\z\"; \"\")) as $p | ($p == $w) or (($p | startswith($w)) and ($p | length) > ($w | length) and (\" ,.:;!?\" | contains($p[($w | length):(($w | length) + 1)])));",
    "[.tool_input // {} | .. | strings | sub(\"\\\\A\\\\s+\"; \"\") | ., sub(\"\\\\A/loop\\\\s+\"; \"\"), sub(\"\\\\A/loop\\\\s+\\\\S+\\\\s+\"; \"\")]",
    "| any(.[]; . as $s | $ws | any(.[]; . as $w | $s | hit($w)))",
  ].join(" ");
  const lines = [
    "#!/usr/bin/env bash",
    `# Before ${p.label} schedules a prompt in a project of topology "${name}".`,
    `# Auto-generated by agentopology scaffold. Wired in ${p.hooksFile} as a PreToolUse hook on CronCreate|ScheduleWakeup.`,
    "# A scheduled or /loop prompt fires UserPromptSubmit as written, so the go hook would count one that starts",
    "# with a go word. One the model schedules that starts with a go word is refused (exit 2, the reason on",
    `# stderr to ${p.modelName}). Input it cannot read blocks too.`,
    "set -uo pipefail",
    'command -v jq >/dev/null 2>&1 || { echo "agentopology: jq is required to check a scheduled prompt for the go word, so it is blocked" >&2; exit 2; }',
    "INPUT=$(cat)",
    `AT_GO_WORDS=${shellQuote(JSON.stringify(words))}`,
    `HIT=$(printf '%s' "$INPUT" | jq -r --argjson ws "$AT_GO_WORDS" ${shellQuote(filter)} 2>/dev/null) || { echo "agentopology: the hook input is not valid JSON, so the scheduled prompt is blocked" >&2; exit 2; }`,
    'if [ "$HIT" = true ]; then',
    '  echo "agentopology: the scheduled prompt starts with a go word; it would be submitted as a prompt and give the go nobody typed. Only the person types the go; schedule the prompt without it." >&2',
    "  exit 2",
    "fi",
    '[ "$HIT" = false ] || { echo "agentopology: the scheduled prompt could not be checked, so it is blocked" >&2; exit 2; }',
    "exit 0",
    "",
  ];
  return { path: `${p.scriptsDir(name)}/before-schedule.sh`, content: lines.join("\n"), category: "script", executable: true };
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
  const route = protectedRouteRecord(ast, p);
  const wgates = writeGates(ast);
  const rates = rateRecords(ast, p);
  // The refusal event file (EXPERIMENTAL) is the core's alone to write: with the opt-in, the edit tools may not touch it.
  const eventFile = p.id === "claude-code" && refusalEventsOn(ast);
  if (ledgers.length === 0 && !route && wgates.length === 0 && rates.length === 0 && !eventFile) return null;
  const goScripts = goScriptPaths(ast, p);
  const name = ast.topology.name;
  const v = p.projectDirVar;
  const target = rootTarget(ast, p);
  const lines = [
    "#!/usr/bin/env bash",
    `# Before ${p.label} edits a file in a project of topology "${name}" (F-4).`,
    `# Auto-generated by agentopology scaffold. Wired in ${p.hooksFile} as a PreToolUse hook on`,
    `# ${p.supportsAsk ? "Write|Edit|MultiEdit|NotebookEdit" : "apply_patch"}. A gate's ledger is a file the agent could write, so an edit`,
    `# of one is refused (exit 2, the reason on stderr to ${p.modelName}). Input it cannot read blocks too.`,
    ...(route ? [`# The route record ${route.path} is refused the same way: only route.sh writes it.`] : []),
    ...(rates.length ? [`# A record with max-per-day (${rates.map((r) => r.path).join(", ")}) is refused the same way: its rows go through record-<id>.sh, which counts them.`] : []),
    ...(wgates.length ? ["# A gate before a write of a path (before: write \"<glob>\") holds an edit of a matching path until it holds."] : []),
    "set -euo pipefail",
    ...FAIL_CLOSED,
    ...(v === null
      ? [`ROOT="$(cd "$(dirname "\${BASH_SOURCE[0]}")/${upToRoot(p, name)}" && pwd)"`]
      : [
          `if [ -z "\${${v}:-}" ]; then echo "agentopology: ${v} is not set, so this edit cannot be checked and is blocked" >&2; exit 2; fi`,
          ...(target === undefined
            ? [`ROOT="$(cd "$${v}" && pwd)"`]
            : [
                `AT_PROJECT="$(cd "$${v}" && pwd)"`,
                `ROOT="$(cd "$AT_PROJECT" && cd ${shellQuote(target)} 2>/dev/null && pwd)" || { echo "agentopology: the target directory does not exist, so this edit cannot be checked and is blocked" >&2; exit 2; }`,
              ]),
        ]),
    ...noJqLines({
      refuse: "agentopology: jq is required to check this edit, so it is blocked",
      pass: "agentopology: jq is not installed; this edit names no gate ledger, so it runs. Install jq to check edits.",
      inOrder: [...[...ledgers, ...(route ? [route] : []), ...rates].map(ledgerWords), ...goScripts.map((s) => [lettersOf(s.replace(/^.*\//, ""))]), ...ownFileWords(ast, p)],
      // a gate before a write reads the path and the ledger with jq: without it nothing can be told apart
      refuseAll: wgates.length > 0,
    }),
    ...(wgates.length
      ? [
          `DIR="${target === undefined ? "$ROOT" : "$AT_PROJECT"}/${p.scriptsDir(name)}"`,
          'cd "$ROOT"',
          "EDITED=''; UNIT=''",
          'deny() { echo "agentopology: gate $1 refuses the edit of $EDITED: $2" >&2; exit 2; }',
          ...(beforeActionGates(ast).some((g) => wgates.includes(g)) ? GATE_BUDGET_FUNCTIONS : []),
          ...CHECK_LEDGER_FUNCTION,
        ]
      : []),
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
    ...(route ? ["refuse_route() { echo \"agentopology: the edit touches the route record $1 ($2); only route.sh writes it\" >&2; exit 2; }"] : []),
    ...(rates.length ? ["refuse_rate() { echo \"agentopology: the edit touches $1 ($2), a record with max-per-day; its rows go through the record's script, which counts them\" >&2; exit 2; }"] : []),
    "while IFS= read -r P || [ -n \"$P\" ]; do",
    '  [ -n "$P" ] || continue',
    '  R="$(canon "$P")"',
    // D-7: a case-insensitive disk (macOS) opens logs/ep1/TRACE.JSONL as the ledger, so path and pattern are compared lower-cased.
    "  RL=$(printf '%s' \"$R\" | tr '[:upper:]' '[:lower:]')",
  ];
  if (eventFile) {
    lines.push(`  if [[ $RL == ${REFUSAL_EVENT_FILE} || $RL == */${REFUSAL_EVENT_FILE} ]]; then echo "agentopology: the edit touches the refusal event file $R; only the guards write it" >&2; exit 2; fi`);
  }
  for (const l of ledgers) {
    // The pattern is a quoted value; unquoted inside [[ ]] it is matched as a glob and never run.
    lines.push(`  PAT=${shellQuote(l.glob.toLowerCase())}; if [[ $RL == $PAT ]]; then refuse ${shellQuote(l.path)} "$R"; fi`);
    if (l.name) lines.push(`  PAT=${shellQuote(l.name.toLowerCase())}; if [[ \${RL##*/} == $PAT ]]; then refuse ${shellQuote(l.path)} "$R"; fi`);
  }
  // The go: an edit of a go hook would let the agent write the go row nobody typed.
  for (const s of goScripts) {
    lines.push(`  if [[ \${RL##*/} == ${shellQuote(s.replace(/^.*\//, "").toLowerCase())} ]]; then echo "agentopology: the edit changes the go hook ${s} ($R); only agentopology scaffold writes it" >&2; exit 2; fi`);
  }
  if (route) {
    lines.push(`  PAT=${shellQuote(route.glob.toLowerCase())}; if [[ $RL == $PAT ]]; then refuse_route ${shellQuote(route.path)} "$R"; fi`);
    lines.push(`  PAT=${shellQuote(route.name.toLowerCase())}; if [[ \${RL##*/} == $PAT ]]; then refuse_route ${shellQuote(route.path)} "$R"; fi`);
  }
  for (const r of rates) {
    lines.push(`  PAT=${shellQuote(r.glob.toLowerCase())}; if [[ $RL == $PAT ]]; then refuse_rate ${shellQuote(r.path)} "$R"; fi`);
    lines.push(`  PAT=${shellQuote(r.name.toLowerCase())}; if [[ \${RL##*/} == $PAT ]]; then refuse_rate ${shellQuote(r.path)} "$R"; fi`);
  }
  for (const g of wgates) {
    // the pattern goes through a variable: unquoted in [[ ]] it is matched as a glob
    lines.push(`  for PAT in ${writeGlobs(g).flatMap(writeGlobPatterns).map(shellQuote).join(" ")}; do`);
    lines.push("    if [[ $RL == $PAT ]]; then", '      EDITED=$R', ...gateCheckLines(ast, g, "      "), "      break", "    fi", "  done");
  }
  // 0.13.0: the guards' own files (the scripts, the hooks file, the scaffold manifest): only scaffold writes them.
  // Only where the topology protects them (protectsOwnFiles), and a generated script only where it has it.
  // The path is the project's own (frontend/.claude/settings.json is another file); with meta { target } the
  // project is outside the root, so any folder's copy counts.
  if (protectsOwnFiles(ast, p)) {
    const q = (f: string) => shellQuote(f.toLowerCase().replace(/[*?[\]\\]/g, "\\$&"));
    const scripts = new Set(guardScriptPaths(ast, p));
    const own = guardOwnFiles(ast, p);
    const hit = (pat: string) => `[[ $RL == ${pat}${target === undefined ? "" : ` || $RL == */${pat}`} ]]`;
    const msg = 'echo "agentopology: the edit changes $R, which agentopology scaffold writes and the guards trust; ask the person" >&2; exit 2';
    lines.push(
      `  for PAT in ${own.filter((f) => !scripts.has(f)).map(q).join(" ")}; do`,
      `    if ${hit("$PAT")}; then ${msg}; fi`,
      "  done",
      `  for PAT in ${own.filter((f) => scripts.has(f)).map(q).join(" ")}; do`,
      `    if ${hit("$PAT")} && [ -e "${target === undefined ? "$ROOT" : "$AT_PROJECT"}/$PAT" ]; then ${msg}; fi`,
      "  done",
    );
  }
  lines.push('done <<< "$PATHS"', FAIL_CLOSED_DONE, "exit 0", "");
  return { path: `${p.scriptsDir(name)}/before-edit.sh`, content: lines.join("\n"), category: "script", executable: true };
}

/**
 * Step programs that are package CLIs a runner can fetch (npx, pnpm dlx, bunx, ...), spelled in more ways than
 * a reader can list: their step gates also read each segment coarsely and fail closed (at_coarse). Path
 * programs and system programs keep the plain reading alone.
 */
export const COARSE_PROGRAMS: ReadonlySet<string> = new Set(["agentopology"]);

/** Programs that run a script: for these the step's tool is the script, not the program (F-21). */
const INTERPRETERS = /^(python[0-9.]*|pypy[0-9.]*|node|nodejs|bash|sh|zsh|dash|ksh|ruby|perl|php|deno|bun|tsx|ts-node|uv|poetry|pipx|npx|pnpx|bunx|pnpm|yarn)$/;

/**
 * A package spec as its bare name: a trailing `@version` or `@tag` dropped and an `npm:` alias resolved
 * (`alias@npm:name@1.2.3` is `name`). A leading scope is kept (`@scope/name@1` is `@scope/name`).
 * A tarball, git, URL or path spec is its last part, without `.git`, `.tgz` and a version before `.tgz`
 * (`./name-1.2.3.tgz` and `git+https://host/o/name.git` are `name`).
 * Never empty: a spec that reads as no name (`npm:`, `x@npm:`) is returned as written.
 * The shell functions at_pkgname and at_pkg_seg do the same to a command.
 */
export function pkgName(spec: string): string {
  // the CLI's own file is the CLI
  if (/(^|\/)agentopology\/dist\/cli\/index\.js$/.test(spec)) return "agentopology";
  let s = spec;
  let scope = "";
  for (;;) {
    while (s.startsWith("npm:")) s = s.slice(4);
    scope = "";
    if (/:\/\/|^(git\+|git:|github:|gitlab:|bitbucket:|file:|\.|\/|~)|\.(tgz|git)(#.*)?$|\.tar(\.gz)?$/.test(s)) {
      s = s.replace(/#.*$/, "").replace(/\/$/, "");
      s = s.slice(s.lastIndexOf("/") + 1);
      s = s.slice(s.lastIndexOf(":") + 1).replace(/\.git$/, "");
      if (/\.(tgz|tar\.gz|tar)$/.test(s)) s = s.replace(/\.(tgz|tar\.gz|tar)$/, "").replace(/-[0-9].*$/, "");
      break;
    }
    scope = s.startsWith("@") ? "@" : "";
    if (scope) s = s.slice(1);
    const at = s.indexOf("@");
    if (at >= 0) {
      const rest = s.slice(at + 1);
      if (rest.startsWith("npm:")) { s = rest.slice(4); continue; }
      s = s.slice(0, at);
    }
    break;
  }
  return s ? scope + s : spec;
}

/**
 * The tool a step runs and the words that must follow it (F-batch): the program's
 * name with its path dropped, or for an interpreter (`python3 -u x.py`, `uv run x.py`)
 * the script's name; for a package runner (`npx agentopology@1.2.3 scaffold`) the package's
 * bare name (pkgName). Lower case; the words are cut before the first placeholder (E-3).
 */
export function stepKey(command: string): { key: string; rest: string } {
  const words = stepMatchWords(command).words.split(" ").filter(Boolean);
  const base = (w: string) => w.replace(/^.*\//, "").toLowerCase();
  let i = 0;
  if (words.length > 1 && INTERPRETERS.test(base(words[0]))) {
    i = 1;
    while (i < words.length - 1 && (words[i].startsWith("-") || ["run", "exec", "x", "dlx"].includes(words[i]))) i++;
    return { key: base(pkgName(words[i] ?? "")), rest: words.slice(i + 1).join(" ").toLowerCase() };
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

/** at_sha FILE: the file's sha256 in hex (sha256sum, else shasum -a 256 on macOS). */
const SHA_FUNCTION = "at_sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum < \"$1\"; else shasum -a 256 < \"$1\"; fi | cut -d' ' -f1; }";

/**
 * What before-action.sh checks of a human's go row beyond ok: its `valid:` window (empty when none or
 * malformed) and its bound files. Null when `step` is no human, or one with neither.
 */
function goCheckOf(ast: TopologyAST, step: string): { start: string; end: string; binds: string[] } | null {
  const h = ast.nodes.find((n) => n.id === step && n.type === "human") as HumanNode | undefined;
  if (!h) return null;
  const w = parseWindow(h.valid);
  const binds = h.binds ?? [];
  if (!w && binds.length === 0) return null;
  return { start: w?.start ?? "", end: w?.end ?? "", binds };
}

/**
 * check_go (before-action.sh): the human's go row, read as check_ledger reads it, counts only inside the
 * human's `valid:` window (today not past its end, the step check rule, and the row's ts, or at, inside
 * it) and while each bound file's sha256 is the one in the row. Needs deny and jq.
 */
const GO_CHECK_FUNCTIONS: string[] = [
  "# check_go GATE HUMAN LEDGER-PATH UNIT START END [FILE...]: the human's go must lie in its valid window",
  "# START..END (empty: none), and each FILE it binds must still have the sha256 the go recorded.",
  SHA_FUNCTION,
  "check_go() {",
  "  local gate=$1 human=$2 path=$3 unit=$4 start=$5 end=$6 row now ts f want have",
  "  shift 6",
  "  row=$(jq -cs --arg step \"$human\" --arg unit \"$unit\" '[.[] | select(.step == $step and ($unit == \"\" or .unit == $unit))] | last' \"$path\") \\",
  '    || deny "$gate" "the go ledger $path could not be read"',
  '  if [ -n "$end" ]; then',
  "    # AT_TODAY moves today only in the package's own tests (AGENTOPOLOGY_TEST=1), never in a session",
  "    now=''; [ \"${AGENTOPOLOGY_TEST:-}\" != 1 ] || now=${AT_TODAY:-}",
  '    [[ $now =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || now=$(date +%Y-%m-%d)',
  '    if [[ $now > $end ]]; then deny "$gate" "human $human\'s approval is valid $start..$end, and today ($now) is after it"; fi',
  "    ts=$(printf '%s' \"$row\" | jq -r '(.ts // .at // \"\") | strings | .[0:10]') || ts=''",
  '    [[ $ts =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || deny "$gate" "human $human\'s go in $path has no time (ts), so it cannot be checked against its valid window $start..$end"',
  '    if [[ $ts < $start || $ts > $end ]]; then deny "$gate" "human $human\'s go was given $ts, outside its valid window $start..$end"; fi',
  "  fi",
  '  for f in "$@"; do',
  "    want=$(printf '%s' \"$row\" | jq -r --arg f \"$f\" '(.binds // {})[$f] // \"\" | strings') || want=''",
  '    [[ $want =~ ^[0-9a-f]{64}$ ]] || deny "$gate" "human $human\'s go in $path records no sha256 for $f, which it binds; type the go word again"',
  '    [ -f "$f" ] || deny "$gate" "$f, which human $human\'s go approved, is gone; type the go word again"',
  '    have=$(at_sha "$f") || deny "$gate" "$f, which human $human\'s go binds, could not be read"',
  '    [ "$have" = "$want" ] || deny "$gate" "$f changed after human $human\'s go (sha256 $want at the go, $have now); type the go word again"',
  "  done",
  "}",
  "",
];

/**
 * `mode: shadow` and `let-go: once` (0.13): the shell a check script needs to
 * honour them, or null when no gate it holds uses either (the script is then
 * written exactly as before).
 *
 * `at_hold GATE WHY` is called where the script would refuse. It returns 0, and
 * the step goes on, when
 * - the gate is `mode: shadow`: what it would refuse is appended to
 *   logs/shadow.jsonl ({gate, at, command, reason}); or
 * - the gate is `let-go: once` and the human's ledger row lets this one go: an
 *   ok row of the human's step, with `gate` naming this gate and `let-go: true`,
 *   newer than the gate's last refusal (logs/refused.jsonl) and newer than the
 *   row of the last use (logs/let-go.jsonl). The use is written there, so the
 *   row lifts one run.
 * Otherwise it returns 1, after writing the refusal to logs/refused.jsonl (a let-go gate only).
 * The ledger is the gate's own, which the ledger guard keeps the model from writing.
 */
function holdLines(ast: TopologyAST, p: GuardPlatform, kind: "action" | "agent"): string[] | null {
  const gates = ast.nodes.filter((n): n is GateNode => n.type === "gate").filter((g) => gateChecks(ast, g, p).includes(kind));
  const shadow = gates.filter((g) => g.mode === "shadow").map((g) => g.id);
  const letGo = gates.flatMap((g) => {
    const human = g.letGo === "once" ? letGoHuman(ast, g) : undefined;
    const ledger = human ? gateLedger(ast, g) : undefined;
    return human && ledger ? [{ id: g.id, human, path: ledger.path.replace(/^\.\//, "") }] : [];
  });
  if (shadow.length === 0 && letGo.length === 0) return null;
  const sq = shellQuote;
  return [
    "# at_hold GATE WHY: 0 when the step may go on although the gate would refuse it: the gate is mode: shadow (the",
    "# refusal is logged to logs/shadow.jsonl), or it is let-go: once and its human's row lets this one go (the use is",
    "# logged to logs/let-go.jsonl). Otherwise 1.",
    `AT_SHADOW=${sq(` ${shadow.join(" ")} `)}`,
    `AT_LETGO=${sq(` ${letGo.map((l) => l.id).join(" ")} `)}`,
    "at_letgo_cfg() {",
    '  case "$1" in',
    ...letGo.map((l) => `    ${sq(l.id)}) printf '%s|%s' ${sq(l.human)} ${sq(l.path)} ;;`),
    "  esac",
    "}",
    "at_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }",
    "# at_last FILE GATE KEY: KEY of the last line of FILE for GATE, or nothing.",
    'at_last() { [ -f "$1" ] || return 0; jq -rs --arg g "$2" --arg k "$3" \'[.[] | select(.gate == $g)] | last | (.[$k] // "")\' "$1" 2>/dev/null || true; }',
    "at_hold() {",
    "  local g=$1 why=$2 what=${CMD-${AGENT-}} unit=${UNIT-} cfg human path row refused used",
    '  if [[ $AT_SHADOW == *" $g "* ]]; then',
    "    mkdir -p logs",
    '    jq -nc --arg gate "$g" --arg at "$(at_now)" --arg command "$what" --arg unit "$unit" --arg reason "$why" \'{gate: $gate, at: $at, command: $command, reason: $reason} + (if $unit == "" then {} else {unit: $unit} end)\' >> logs/shadow.jsonl',
    '    echo "agentopology: gate $g would refuse ($why); it is mode: shadow, so this is logged to logs/shadow.jsonl and the step runs." >&2',
    "    return 0",
    "  fi",
    '  [[ $AT_LETGO == *" $g "* ]] || return 1',
    '  cfg=$(at_letgo_cfg "$g"); human=${cfg%%|*}; path=${cfg#*|}; path=${path//\\{unit\\}/$unit}',
    '  refused=$(at_last logs/refused.jsonl "$g" at); used=$(at_last logs/let-go.jsonl "$g" row-at); row=\'\'',
    '  if [ -n "$refused" ] && [ -f "$path" ]; then',
    "    row=$(jq -rs --arg h \"$human\" --arg g \"$g\" --arg u \"$unit\" '[.[] | select(.step == $h and .ok == true and .gate == $g and .[\"let-go\"] == true and ($u == \"\" or .unit == $u))] | last | (.at // \"\")' \"$path\" 2>/dev/null) || row=''",
    "  fi",
    '  if [ -n "$row" ] && [[ "$row" > "$refused" ]] && [[ "$row" > "$used" ]]; then',
    "    mkdir -p logs",
    '    jq -nc --arg gate "$g" --arg at "$(at_now)" --arg row "$row" --arg human "$human" --arg command "$what" \'{gate: $gate, at: $at, "row-at": $row, human: $human, command: $command}\' >> logs/let-go.jsonl',
    '    echo "agentopology: gate $g refused ($why), and $human let this one go (let-go: once); the step runs." >&2',
    "    return 0",
    "  fi",
    "  mkdir -p logs",
    '  jq -nc --arg gate "$g" --arg at "$(at_now)" --arg command "$what" --arg reason "$why" \'{gate: $gate, at: $at, command: $command, reason: $reason}\' >> logs/refused.jsonl',
    "  return 1",
    "}",
    "",
  ];
}

/** check_ledger (before-edit.sh): the last ledger line for a step (and unit) must be ok. Needs deny and jq. */
const CHECK_LEDGER_FUNCTION: string[] = [
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
];

/**
 * The shell lines that check one gate: its ledger (the last line for each `after:` step must be ok) and its
 * `run:` check script (at_gate), for the gates before a write (a script step's gates keep their own lines, with its route and go checks).
 * Needs deny, check_ledger, at_gate and $UNIT.
 */
function gateCheckLines(ast: TopologyAST, gate: GateNode, indent: string): string[] {
  const sq = shellQuote;
  const out: string[] = [`${indent}# gate ${gate.id} (after: ${gateAnchors(gate, "after").join(", ") || "-"})`];
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
  return out;
}

/** Every action a gate guards, with its gates, in declaration order. */
function actionGuards(ast: TopologyAST, p: GuardPlatform = CLAUDE_CODE_GUARDS): Array<{ action: ActionNode; gates: GateNode[] }> {
  const gates = ast.nodes.filter((n): n is GateNode => n.type === "gate").filter((g) => checkableActionGate(ast, g));
  // 0.13.0: a script step that only `when` routes reach is guarded too, by its route (lib/route.ts).
  const routed = routeActionTargets(ast, p);
  const out: Array<{ action: ActionNode; gates: GateNode[] }> = [];
  for (const node of ast.nodes) {
    if (node.type !== "action") continue;
    const mine = gates.filter((g) => guardedActions(ast, g).some((a) => a.id === node.id));
    if (mine.length > 0 || routed.has(node.id)) out.push({ action: node as ActionNode, gates: mine });
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
  const guards = actionGuards(ast, p);
  // F-4: a topology with a ledger (or, on Codex, an approval step) gets the ledger check even with no guarded step.
  const ledgers = protectedLedgers(ast, p);
  // 0.13.0: a topology whose launches read the route record gets the shell check for it too.
  const route = protectedRouteRecord(ast, p);
  const wgates = writeGates(ast);
  const rates = rateRecords(ast, p);
  if (guards.length === 0 && ledgers.length === 0 && !route && wgates.length === 0 && rates.length === 0) return null;
  const name = ast.topology.name;
  const resolve = GUARD_OPTIONS.resolveLeadingAssignments;
  // A gate after a human with a valid: window or binds: checks the go row beyond ok (check_go).
  const goNeeded = guards.some(({ gates }) => gates.some((g) => gateLedger(ast, g) && gateAnchors(g, "after").some((s) => goCheckOf(ast, s))));
  // mode: shadow and let-go: once (0.13): deny may return, and the check ends there.
  const hold = holdLines(ast, p, "action");
  const d = (call: string) => (hold ? `{ ${call}; return 0; }` : call);
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
    ...projectRootLines(p, name, "strict", rootTarget(ast, p)),
    ...noJqLines({
      refuse: "agentopology: jq is required to check this step, so it is blocked",
      pass: "agentopology: jq is not installed; this command names no gated step, so it runs. Install jq to check steps.",
      // a step: its tool and words, whole and in order (`git log --grep=merged` names no step `git merge`)
      words: stepWords.map((s) => [s.key, ...s.rest.split(" ")]),
      // as letters, the way the jq check reads them: a ledger's name (in any word: `trace.json[l]`), and an
      // inline git alias (`V=commit git -calias.x=V x`), which can name a git step in no words of its own
      inOrder: [
        ...ledgers.map(ledgerWords),
        ...(route ? [ledgerWords(route)] : []),
        ...rates.map(ledgerWords),
        ...wgates.flatMap((g) => writeGlobs(g).map(globWords).filter((w) => w.length > 0)),
        ...(stepWords.some((s) => s.key === "git") ? [["git", "alias"], ["git", "include"]] : []),
        // 0.13.0: the guards' own files, by their file names' letters
        ...ownFileWords(ast, p),
      ],
      expansion: stepWords.map((s) => s.key),
      powershell: !!p.powershellTool,
      stdinGitSteps: gitSteps,
      // a write glob with no letters (`**`) names every path: nothing can be told apart without jq
      refuseAll: wgates.some((g) => writeGlobs(g).some((x) => globWords(x).length === 0)),
    }),
    scriptsDirLine(p, name, rootTarget(ast, p)),
    ...(p.powershellTool
      ? [
        // One read of stdin: the command, and whether the tool is PowerShell. A call with no command (Monitor's ws input) reads as "" and runs nothing.
        "INPUT=$(cat)",
        `CMD=$(printf '%s' "$INPUT" | jq -er '${p.payload.command} // ""') || { echo "agentopology: the hook input is not valid JSON, so the command is blocked" >&2; exit 2; }`,
        `PWSH=0; [ "$(printf '%s' "$INPUT" | jq -r '.tool_name // ""')" = ${shellQuote(p.powershellTool)} ] && PWSH=1`,
      ]
      : [`CMD=$(jq -er '${p.payload.command} // ""') || { echo "agentopology: the hook input is not valid JSON, so the command is blocked" >&2; exit 2; }`]),
    "",
    ...(hold
      ? [...hold, 'deny() { at_hold "$1" "$2" && return 0; echo "agentopology: gate $1 refuses this command ($CMD): $2" >&2; exit 2; }']
      : ["deny() { echo \"agentopology: gate $1 refuses this command ($CMD): $2\" >&2; exit 2; }"]),
    "",
    ...routeCheckFunction(ast, p, "action"),
    // With mode: shadow or let-go, deny can return: the check ends there (return 0) instead of going on to read what is missing.
    ...(beforeActionGates(ast).length ? GATE_BUDGET_FUNCTIONS.map((l) => (hold ? l.replace(/\|\| (deny .*)$/, "|| { $1; return 0; }") : l)) : []),
    "# check_ledger GATE STEP LEDGER-PATH UNIT: the last line for STEP (and UNIT) must be ok.",
    "check_ledger() {",
    "  local gate=$1 step=$2 tmpl=$3 unit=$4 path ok",
    '  if [[ "$tmpl" == *"{unit}"* ]]; then',
    `    [ -n "$unit" ] || ${d('deny "$gate" "step \\"$step\\" must have finished ok, but no unit could be read from the command to find its ledger $tmpl"')}`,
    '    path="${tmpl//\\{unit\\}/$unit}"',
    "  else",
    '    path="$tmpl"',
    "  fi",
    `  [ -f "$path" ] || ${d('deny "$gate" "step \\"$step\\" has no ok record for unit \\"$unit\\": the ledger $path does not exist"')}`,
    "  ok=$(jq -rs --arg step \"$step\" --arg unit \"$unit\" '[.[] | select(.step == $step and ($unit == \"\" or .unit == $unit))] | last | (.ok == true)' \"$path\") \\",
    `    || ${d('deny "$gate" "step \\"$step\\" for unit \\"$unit\\": the ledger $path could not be read"')}`,
    `  [ "$ok" = true ] || ${d('deny "$gate" "step \\"$step\\" has no ok record for unit \\"$unit\\" in ledger $path (its last record must have ok: true)"')}`,
    "}",
    "",
    ...(goNeeded ? GO_CHECK_FUNCTIONS : []),
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
    ...ledgerGuardLines(ledgers, route, writeGateGuardLines(ast, wgates), protectsOwnFiles(ast, p), rates),
    ...goScriptGuardLines(goScriptPaths(ast, p)),
    ...goEntryGuardLines(ast, p),
    // 0.13.0: the guards' own files, and the folders that hold any protected file, last (the messages above stay first).
    ...(protectsOwnFiles(ast, p)
      ? ownFilesGuardLines(guardOwnFiles(ast, p), [...ledgers.map((l) => l.path), ...(route ? [route.path] : []), ...goScriptPaths(ast, p)], new Set(guardScriptPaths(ast, p).map((f) => f.toLowerCase())))
      : []),
  ];
  const sq = shellQuote;
  // A here-string's text, read by the step gates on its own lines, as a here-doc's body already is: a shell
  // fed `<<<'tool step'` runs it. Added after the checks above, which read the command as written.
  lines.push(
    "# at_herestr CMD: the text of each here-string (<<<) in CMD, one per line: the one shell word after it, its",
    "# quotes (any mix) and backslashes read as bash reads them, up to an unquoted blank or operator.",
    "at_herestr() {",
    "  local t=$1 x q c i n",
    "  while [[ $t == *'<<<'* ]]; do",
    "    t=${t#*'<<<'}; t=${t#\"${t%%[![:space:]]*}\"}",
    "    x=''; q=''; n=${#t}",
    "    for ((i=0; i<n; i++)); do",
    "      c=${t:i:1}",
    "      if [ -n \"$q\" ]; then if [ \"$c\" = \"$q\" ]; then q=''; else x+=$c; fi; continue; fi",
    "      case $c in",
    "        \"'\"|'\"') q=$c ;;",
    "        '\\') i=$((i+1)); x+=${t:i:1} ;;",
    "        ' '|$'\\t'|';'|'&'|'|'|'('|')'|'<'|'>') break ;;",
    "        *) x+=$c ;;",
    "      esac",
    "    done",
    "    printf '%s\\n' \"$x\"",
    "  done",
    "}",
    "if [[ $CMD == *'<<<'* ]]; then",
    "  AT_HS=$(at_herestr \"$CMD\")",
    "  for sep in '&' '|' ';' '(' ')' '`'; do AT_HS=${AT_HS//\"$sep\"/$'\\n'}; done",
    "  SEGS+=$'\\n'$AT_HS",
    "fi",
  );
  // The coarse reading, only for a step whose program is a package CLI a runner can fetch (COARSE_PROGRAMS).
  const coarseKeys = (action: ActionNode) => [...new Map((action.commands ?? []).map((c) => stepKey(c))
    .filter((k) => COARSE_PROGRAMS.has(k.key.toLowerCase())).map((k) => [`${k.key} ${k.rest}`, k])).values()];
  if (guards.some(({ action }) => coarseKeys(action).length > 0)) lines.push(
    "# at_coarse SEG KEY REST: the step gates fail closed. SEG (quotes and backslashes dropped, lower case) is",
    "# read as the step KEY REST, whatever the plain reading found, when every REST word stands in it (inside any",
    "# word) and KEY stands inside any word, or an expansion stands where a program is named: the segment's",
    "# program, or after a runner (npx pnpx bunx pnpm yarn npm bun node). Known to refuse text too, such as",
    "# `echo KEY REST` or `grep KEY docs/REST.md`, when the step's gate is not met.",
    "at_coarse() {",
    "  local s=$1 key=$2 x p=1 run=0; local -a ws rs",
    "  read -ra rs <<< \"$3\"",
    "  for x in ${rs[@]+\"${rs[@]}\"}; do [[ $s == *\"$x\"* ]] || return 1; done",
    "  # a read-only program in the program's place reads the words as its arguments (at_read_only)",
    "  if [ \"$AT_RO\" = 1 ] && at_read_only \"$s\"; then return 1; fi",
    "  [[ $s == *\"$key\"* ]] && return 0",
    "  read -ra ws <<< \"$s\"",
    "  for x in ${ws[@]+\"${ws[@]}\"}; do",
    "    if [ \"$p\" = 1 ] && [[ $x =~ ^[a-z_][a-z0-9_]*= ]]; then continue; fi",
    String.raw`    if [[ $x == *[\$\`]* ]] && { [ "$p" = 1 ] || [ "$run" = 1 ]; }; then return 0; fi`,
    "    case ${x##*/} in npx|pnpx|bunx|pnpm|yarn|npm|bun|node) run=1 ;; esac",
    "    [[ \"$AT_LEAD\" == *\" $x \"* ]] || p=0",
    "  done",
    "  return 1",
    "}",
    "# at_code_cmd CMD: AT_CODE=1 when the command may hand text to a program that runs text as code (a shell, an",
    "# interpreter, a remote or container run, a build tool, a wrapper, a git alias, -c, --call, --eval), AT_SA=1",
    "# when it runs sed or awk. Quoted text with a space is left out first, so the words of a message name no",
    "# program. A program not on this list that runs text it is given is not seen: its quoted text reads as text.",
    "at_code_cmd() {",
    "  local t=$1 x re; local -a ws",
    "  AT_CODE=0; AT_SA=0",
    String.raw`  re="\"[^\"]* [^\"]*\"|'[^']* [^']*'"`,
    "  while [[ $t =~ $re ]]; do t=${t/\"${BASH_REMATCH[0]}\"/ }; done",
    "  t=$(lower \"$(norm \"$t\")\")",
    "  for x in '&' '|' ';' '(' ')' '`' '<' '>' '{' '}' $'\\n'; do t=${t//\"$x\"/ }; done",
    "  read -ra ws <<< \"$t\"",
    "  for x in ${ws[@]+\"${ws[@]}\"}; do",
    "    case ${x##*/} in",
    "      bash|sh|zsh|dash|ksh|mksh|yash|fish|csh|tcsh|tclsh|wish|expect|eval|source|exec|perl|ruby|php|lua|luajit|deno|bun|node|nodejs|python*|pypy*|busybox|env|script|watch|ssh|docker|podman|kubectl|make|gmake|xargs|find|parallel|nohup|setsid|sudo|doas|su|timeout|osascript|pwsh|powershell|at|batch|crontab|tmux|screen|vi|vim|nvim|emacs|less|more|man) AT_CODE=1 ;;",
    "      awk|gawk|mawk|nawk|sed) AT_SA=1 ;;",
    "    esac",
    "    case $x in -c|--call*|--eval*|'!'*|*alias.*) AT_CODE=1 ;; esac",
    "  done",
    "}",
    "# at_text_seg RAW L: LT, the segment as the coarse reading reads it: L, or, when the command hands no text to",
    "# a program that runs it (AT_CODE and AT_SA both 0), L with each quoted text that holds a space left out.",
    "at_text_seg() {",
    "  LT=$2",
    "  [ \"$AT_CODE$AT_SA\" = 00 ] || return 0",
    String.raw`  [[ $1 == *[\"\']* ]] || return 0`,
    "  local t=$1 re",
    String.raw`  re="\"[^\"]* [^\"]*\"|'[^']* [^']*'"`,
    "  while [[ $t =~ $re ]]; do t=${t/\"${BASH_REMATCH[0]}\"/ }; done",
    "  LT=$(lower \"$(norm \"$t\")\")",
    "}",
    "at_code_cmd \"$CMD\"",
    "# at_read_only SEG: SEG's first word, its program, only reads, whatever its arguments: grep, egrep, fgrep,",
    "# cat, head, tail, wc; rg with no --pre; sed with -n, no other option than -E or -r, and a script that only",
    "# prints a line or a range (N, $, /re/, then p); awk with no -f, -e, -i, -l or -E, in a command holding no",
    "# system, getline, | or >. Not less or more (a shell escape), not a program after a wrapper. Used only when",
    "# AT_RO=1: no code runner (AT_CODE) and no command or process substitution or backtick in the command.",
    "at_read_only() {",
    "  local x i n q=0 sc='' re; local -a ws",
    "  read -ra ws <<< \"$1\"; n=${#ws[@]}",
    "  [ \"$n\" -gt 0 ] || return 1",
    "  case ${ws[0]} in",
    "    grep|egrep|fgrep|cat|head|tail|wc) return 0 ;;",
    "    rg) for x in \"${ws[@]}\"; do [[ $x != --pre* ]] || return 1; done; return 0 ;;",
    "    sed)",
    "      for ((i=1; i<n; i++)); do",
    "        case ${ws[i]} in -n|--quiet|--silent) q=1 ;; -E|-r) ;; -*) return 1 ;; *) sc=${ws[i]}; break ;; esac",
    "      done",
    "      [ \"$q\" = 1 ] || return 1",
    "      for ((i=i+1; i<n; i++)); do [[ ${ws[i]} != -* ]] || return 1; done",
    String.raw`      re='^([0-9]+|\$|/[^/]*/)(,([0-9]+|\$|/[^/]*/))?p$'`,
    "      [[ $sc =~ $re ]] ;;",
    "    awk|gawk|mawk|nawk)",
    "      [[ $CMD != *system* && $CMD != *getline* && $CMD != *'|'* && $CMD != *'>'* ]] || return 1",
    "      for ((i=1; i<n; i++)); do case ${ws[i]} in -f*|--file*|-e*|--source*|-i*|--include*|-l*|--load*|-E*|--exec*) return 1 ;; esac; done",
    "      return 0 ;;",
    "    *) return 1 ;;",
    "  esac",
    "}",
    "AT_RO=0",
    "if [ \"$AT_CODE\" = 0 ] && [[ $CMD != *'$('* && $CMD != *'<('* && $CMD != *'>('* && $CMD != *'`'* ]]; then AT_RO=1; fi",
    "# at_cli_help SEG KEY: SEG runs the CLI KEY with --help, -h, --version or -v as its first argument, which the CLI",
    "# answers and exits before it loads anything: KEY is the program (by any path), or the package of a runner",
    "# with nothing before it but dlx, exec, x, -y, --yes or --; KEY stands in one word only; no expansion, no",
    "# assignment, no other option.",
    "at_cli_help() {",
    "  local key=$2 j=1 n c=0 x; local -a w",
    "  read -ra w <<< \"$1\"; n=${#w[@]}",
    "  [ \"$n\" -ge 2 ] || return 1",
    "  for x in \"${w[@]}\"; do",
    "    [[ $x != *\"$key\"* ]] || c=$((c+1))",
    String.raw`    [[ $x != *[\$\`]* ]] || return 1`,
    "  done",
    "  [ \"$c\" = 1 ] || return 1",
    "  at_pkg_seg \"${w[@]}\"",
    "  if [ \"${AT_PW[0]##*/}\" = \"$key\" ]; then",
    "    j=0",
    "  else",
    "    case ${w[0]##*/} in npx|pnpx|bunx|pnpm|yarn|npm|bun|node) ;; *) return 1 ;; esac",
    "    while [ \"$j\" -lt \"$n\" ]; do case ${w[j]} in dlx|exec|x|-y|--yes|--) j=$((j+1)) ;; *) break ;; esac; done",
    "    [ \"$j\" -lt \"$n\" ] && [ \"${AT_PW[j]##*/}\" = \"$key\" ] || return 1",
    "  fi",
    "  case ${w[j+1]:-} in --help|-h|--version|-v) return 0 ;; esac",
    "  return 1",
    "}",
  );
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
      // 0.13.0: the step's route first, when only `when` routes reach it.
      const out: string[] = [...routeActionCheckLines(ast, action.id, p, indent)];
      for (const gate of gates) {
        out.push(`${indent}# gate ${gate.id} (after: ${gateAnchors(gate, "after").join(", ") || "-"})`);
        const ledger = gateLedger(ast, gate);
        if (ledger) {
          for (const step of gateAnchors(gate, "after")) {
            out.push(`${indent}check_ledger ${sq(gate.id)} ${sq(step)} ${sq(ledger.path.replace(/^\.\//, ""))} "$UNIT"`);
            const go = goCheckOf(ast, step);
            if (go) {
              out.push(`${indent}check_go ${sq(gate.id)} ${sq(step)} ${sq(ledger.path.replace(/^\.\//, ""))} "$UNIT" ${sq(go.start)} ${sq(go.end)}${go.binds.map((b) => ` ${sq(b)}`).join("")}`);
            }
          }
        }
        if (scriptNameFromRun(gate.run)) {
          const fix = gateWorstCase(gate) === null ? "declare a timeout: on the gate if it needs longer" : "raise the gate's timeout: if it needs longer";
          out.push(`${indent}at_gate ${sq(gate.id)} ${inlineGateBudget(gate)} ${sq(fix)}`);
        }
      }
      return out;
    };
    // A step held only by its route has no gate to name, and its route reads no unit.
    const byUnit = !!action.unitFrom && gates.length > 0;
    const unreadable = (why: string, indent: string) => byUnit
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
    // A step read coarsely (COARSE_PROGRAMS) reads LT: the segment with quoted text left out when nothing in the
    // command runs text as code (at_text_seg); both its plain and its coarse reading read LT.
    const ck = coarseKeys(action);
    const isCoarse = (k: { key: string; rest: string }) => ck.some((c) => c.key === k.key && c.rest === k.rest);
    lines.push("while IFS= read -r -u 3 C || [ -n \"$C\" ]; do", ...(ck.length ? ["  RC=$C"] : []), '  C=$(norm "$C")', '  [ "$C" != "  " ] || continue', '  L=$(lower "$C")');
    if (ck.length) lines.push('  at_text_seg "$RC" "$L"');
    lines.push(ck.length ? "  SEG_DOUBT=0; T=0; TC=0" : "  SEG_DOUBT=0; T=0");
    for (const k of keys) lines.push(`  seg_steps "${isCoarse(k) ? "$LT" : "$L"}" ${sq(k.key)} ${sq(k.rest)}; ${isCoarse(k) ? "TC=$((TC + SEG_N))" : "T=$((T + SEG_N))"}`);
    // The CLI given --help, -h, --version or -v first answers and exits: no run of its steps (at_cli_help).
    const helpKeys = [...new Set(ck.map((k) => k.key.toLowerCase()))];
    if (ck.length) lines.push(`  if ${helpKeys.map((k) => `at_cli_help "$LT" ${sq(k)}`).join(" || ")}; then TC=0; fi`, "  T=$((T + TC))");
    lines.push('  if [ "$SEG_DOUBT" = 1 ]; then', ...unreadable("an expansion or glob among the tool's words", "    "), "  fi");
    // Fail closed: a segment the plain reading found no step in, but which names the step's program (or an
    // expansion where a program stands) and holds the step's words, is the step too (at_coarse).
    const coarse = ck.map((k) => `at_coarse "$LT" ${sq(k.key.toLowerCase())} ${sq(k.rest)}`).join(" || ");
    if (ck.length) lines.push(`  if [ "$T" -eq 0 ] && [ "$SEG_DOUBT" = 0 ] && ! { ${helpKeys.map((k) => `at_cli_help "$LT" ${sq(k)}`).join(" || ")}; } && { ${coarse}; }; then`, ...unreadable("it names the step's program and words in a form this guard does not read as plain", "    "), "  fi");
    lines.push('  if [ "$T" -gt 0 ]; then');
    if (byUnit && action.unitFrom) {
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
      ...(p.projectDirVar === null ? projectRootLines(p, name, "cd") : rootTarget(ast, p) !== undefined ? projectRootLines(p, name, "strict", rootTarget(ast, p)) : []),
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
export const JQ_AGENT_NORM = String.raw`gsub("\\p{Cf}"; "") | gsub("\\A\\s+|\\s+\\z"; "") | ascii_downcase | sub("[\\s:;.,!?]+\\z"; "") | sub("\\A.*/"; "") | sub("\\A.*:"; "") | gsub("\\A\\s+|\\s+\\z"; "")`;

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

/**
 * The typed test (T-04): reads $PAYLOAD's prompt into $PROMPT (leading space dropped) and sets $KIND to
 * `arrived` when it opens with the `<cross-session-message` wrapper Claude Code puts around a message
 * from another session, or when it holds, anywhere, the `<task-notification` envelope a background task's
 * report arrives in; `typed` for any other non-empty prompt, `unknown` when none was read. One source
 * for a deciding session's prompt log and a human's go hook.
 */
const TYPED_TEST_LINES: string[] = [
  "KIND=unknown",
  String.raw`PROMPT=$(printf '%s' "$PAYLOAD" | jq -er '.prompt | strings | sub("\\A\\s+"; "") | select(length > 0)' 2>/dev/null) || PROMPT=`,
  'if [ -n "$PROMPT" ]; then',
  '  case "$PROMPT" in',
  '    "<cross-session-message"*) KIND=arrived ;;',
  '    *"<task-notification"*) KIND=arrived ;;',
  "    *) KIND=typed ;;",
  "  esac",
  "fi",
];

/** The file name of a human's go hook. */
export function goHookScript(id: string): string {
  return `go-${id}.sh`;
}

/**
 * A human's go hook (UserPromptSubmit): when a prompt the person typed is the human's `word:` (trimmed),
 * or opens with the word and a space or one of , . : ; ! ?, it appends `{step, ok: true, word, ts, binds}` to each ledger the
 * gates after the human read, `binds` holding the sha256 of each bound file (null for one missing). A
 * prompt the typed test reads as arrived, or as unknown, writes nothing. It never blocks (always exit 0).
 * Null when the human has no word or no ledger to write (V127 reports that).
 */
export function goHook(ast: TopologyAST, human: HumanNode, p: GuardPlatform): GeneratedFile | null {
  const ledgers = goLedgers(ast, human.id).map((r) => r.path.replace(/^\.\//, ""));
  if (human.word === undefined || human.word.trim() === "" || ledgers.length === 0 || ledgers.some((l) => l.includes("{unit}"))) return null;
  const topology = ast.topology.name;
  const sq = shellQuote;
  const binds = human.binds ?? [];
  const stop = human.stopWord !== undefined && human.stopWord.trim() !== "" ? human.stopWord.trim() : undefined;
  const goAppend = [
    "go_append() { # LEDGER: one JSON line on stdin; never writes through a symlink or a hard link",
    '  local d; d=$(dirname "$1")',
    '  if [ -L "$1" ] || [ -L "$d" ]; then echo "go: $1 or its folder is a symlink; the go is not written" >&2; return 1; fi',
    '  if [ -n "$(find "$1" -type f -links +1 2>/dev/null)" ]; then echo "go: $1 has more than one hard link; the go is not written" >&2; return 1; fi',
    '  mkdir -p "$d" && cat >> "$1"',
    "}",
  ];
  const lines = [
    "#!/usr/bin/env bash",
    `# The go for human "${human.id}" of topology "${topology}".`,
    "# Auto-generated by agentopology scaffold. UserPromptSubmit hook. When a prompt the person typed",
    `# is the go word (trimmed), or opens with it and a space or , . : ; ! ?, it appends {step, ok: true, word, ts${binds.length ? ", binds" : ""}}`,
    `# to ${ledgers.join(", ")}${binds.length ? `; binds holds the sha256 of ${binds.join(", ")}` : ""}.`,
    "# Claude Code runs this hook for prompts nobody typed too (a message from another session, a",
    "# scheduled task, a background subagent reporting back), and its input says nothing of where a prompt",
    `# came from. The typed test is the one ${promptLogScript("<id>")} uses: a prompt that opens with`,
    "# <cross-session-message, or holds a <task-notification envelope, writes nothing. A scheduled task or",
    "# /loop prompt is sent as written, so one that starts with the word counts; before-schedule.sh refuses",
    "# such a prompt when the model schedules it (CronCreate, ScheduleWakeup).",
    "# It never blocks (exit 0).",
    "PAYLOAD=$(cat 2>/dev/null || true)",
    ...TYPED_TEST_LINES,
    '[ "$KIND" = typed ] || exit 0',
    `W=${sq(human.word.trim())}`,
    'P="${PROMPT%"${PROMPT##*[![:space:]]}"}"',
    ...(stop === undefined
      ? [
        "# The word counts alone, or followed by a space or one of , . : ; ! ? (then anything): never a longer word.",
        'case "$P" in "$W"|"$W"[\\ ,.:\\;!?]*) ;; *) exit 0 ;; esac',
      ]
      : [
        `S=${sq(stop)}`,
        "# The stop word is read the way the go word is: alone, or followed by a space or one of , . : ; ! ? (then anything).",
        'STOP=0',
        'case "$P" in "$S"|"$S"[\\ ,.:\\;!?]*) STOP=1 ;; esac',
        'if [ "$STOP" = 0 ]; then',
        '  case "$P" in "$W"|"$W"[\\ ,.:\\;!?]*) ;; *) exit 0 ;; esac',
        "fi",
      ]),
    ...projectRootLines(p, topology, "fallback").map((l, i) => (i === 2 ? 'cd "$ROOT" 2>/dev/null || exit 0' : l)),
    ...(stop === undefined ? [] : [
      ...goAppend,
      "# The stop word: a halt row, {step, ok: false, halt: true, word, ts}, in each ledger. go-halt.sh refuses every",
      "# tool while the last row of this step is a halt; the go word, typed, writes the row that ends it.",
      'if [ "$STOP" = 1 ]; then',
      `  ROW=$(jq -nc --arg step ${sq(human.id)} --arg word "$S" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{step: $step, ok: false, halt: true, word: $word, ts: $ts}') || exit 0`,
      ...ledgers.map((l) => `  printf '%s\\n' "$ROW" | go_append ${sq(l)} || echo ${sq(`go: the halt for ${human.id} was not written to ${l}`)} >&2`),
      "  exit 0",
      "fi",
    ]),
    SHA_FUNCTION,
    "BINDS='{}'",
    ...binds.map((b) => [
      `F=${sq(b)}; H=''`,
      'if [ -f "$F" ]; then H=$(at_sha "$F" 2>/dev/null) || H=\'\'; fi',
      `BINDS=$(printf '%s' "$BINDS" | jq -c --arg p "$F" --arg h "$H" '. + {($p): (if $h == "" then null else $h end)}') || exit 0`,
    ].join("\n")),
    `ROW=$(jq -nc --arg step ${sq(human.id)} --arg word "$W" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson binds "$BINDS" '{step: $step, ok: true, word: $word, ts: $ts}${binds.length ? " + {binds: $binds}" : ""}') || exit 0`,
    ...(stop === undefined ? goAppend : []),
    ...ledgers.map((l) => `printf '%s\\n' "$ROW" | go_append ${sq(l)} || echo ${sq(`go: the go for ${human.id} was not written to ${l}`)} >&2`),
    "exit 0",
    "",
  ];
  return { path: `${p.scriptsDir(topology)}/${goHookScript(human.id)}`, content: lines.join("\n"), category: "script", executable: true };
}

/** Humans whose go hook is written: a `word:` and a ledger to write it to. */
export function goHumans(ast: TopologyAST, p: GuardPlatform): HumanNode[] {
  return ast.nodes.filter((n): n is HumanNode => n.type === "human").filter((h) => goHook(ast, h, p) !== null);
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
    ...TYPED_TEST_LINES,
    ...projectRootLines(p, topology, "fallback").map((l, i) => (i === 2 ? 'cd "$ROOT" 2>/dev/null || exit 0' : l)),
    ...appendLines(p),
    `jq -nc --arg kind "$KIND" --arg session "${agent.id}" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{ts: $ts, kind: $kind, session: $session}' 2>/dev/null | append 2>/dev/null || true`,
    "exit 0",
    "",
  ];
  return { path: `${p.scriptsDir(topology)}/${promptLogScript(agent.id)}`, content: lines.join("\n"), category: "script", executable: true };
}

