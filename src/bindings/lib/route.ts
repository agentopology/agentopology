/**
 * A router's `when` edges, compiled (0.13.0).
 *
 * A flow edge `router -> builder [when router.class == change]`, where
 * `class` is an enum the agent (or orchestrator) `router` declares in
 * `outputs:`, is a route. On Claude Code a topology with routes gets:
 *
 * - `route.sh <agent> <field> <value>`: the router records its choice. A value
 *   the .at does not declare exits 2 and writes nothing. A record is one JSON
 *   line, `{"agent", "field", "value", "ts"}`, appended to the route record.
 * - a route check in before-agent.sh: an agent every way into which is a route
 *   starts only when the last record for that agent and field holds a value
 *   whose edge leads to it.
 * - before-edit.sh refuses an Edit or Write of the route record, and
 *   before-action.sh a shell command that writes it (as for gate ledgers).
 *
 * Every other `when` edge keeps its line in the playbook. validate warns where
 * a `when` promises a refusal that is not made ({@link routeWarnings}): a
 * condition of another form, an edge to an action (no launch to refuse), a
 * route whose router cannot run route.sh (no Bash in its tools), and inline
 * delegation. A route into an agent that a plain edge also reaches is not
 * checked (its launch cannot be told apart) and does not warn.
 *
 * @module
 */

import type { EdgeDef, OutputsMap, TopologyAST } from "../../parser/ast.js";
import type { GeneratedFile } from "../types.js";
import { CLAUDE_CODE_GUARDS, getDelegationMode, isRegisteredSubagentType, projectRootLines, shellQuote, type GuardPlatform } from "./guards.js";

/** A node id that is safe in a shell `case` pattern and a JSON string. */
const ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
/** An enum value that is safe in a shell word and a JSON string. */
const VALUE = /^[A-Za-z0-9_-]{1,64}$/;
/** `<agent>.<field> == <value>`, the only condition form that compiles. */
const ROUTE_FORM = /^([A-Za-z][A-Za-z0-9_-]*)\.([A-Za-z][A-Za-z0-9_-]*)\s*==\s*([A-Za-z0-9_-]+)$/;

/** A condition as written, without the `] [max N` the parser may leave on it. */
export function cleanCondition(condition: string): string {
  return condition.replace(/\]\s*\[max\s+\d+\s*$/i, "").replace(/\]\s*$/, "").trim();
}

/** One route: the output (agent and field) and the value an edge needs. */
export interface Route {
  agent: string;
  field: string;
  value: string;
}

/** A route with the edge's source, for messages. */
export interface RouteNeed extends Route {
  from: string;
}

function outputsOf(ast: TopologyAST, id: string): OutputsMap | undefined {
  const node = ast.nodes.find((n) => n.id === id);
  return node && (node.type === "agent" || node.type === "orchestrator") ? node.outputs : undefined;
}

/** The route an edge's condition names, or null when it is not `<agent>.<field> == <value>` on a declared enum value. */
export function routeOf(ast: TopologyAST, edge: EdgeDef): Route | null {
  if (!edge.condition || edge.isError) return null;
  const m = ROUTE_FORM.exec(cleanCondition(edge.condition));
  if (!m || !ID.test(m[1]) || !ID.test(m[2])) return null;
  const values = outputsOf(ast, m[1])?.[m[2]];
  if (!values || !values.includes(m[3]) || !values.every((v) => VALUE.test(v))) return null;
  return { agent: m[1], field: m[2], value: m[3] };
}

/**
 * True when the owner of a routed output can run route.sh: an orchestrator, or
 * an agent whose tools are not listed (it inherits them) or list Bash, and
 * whose disallowed tools do not name Bash. A router that cannot record must not
 * have its routes checked: every launch it routes would be refused.
 */
export function canRecordRoute(ast: TopologyAST, owner: string): boolean {
  const node = ast.nodes.find((n) => n.id === owner);
  if (!node) return false;
  if (node.type === "orchestrator") return true;
  if (node.type !== "agent") return false;
  const bash = (t: string) => /^Bash(\(|$)/.test(t.trim());
  if ((node.disallowedTools ?? []).some(bash)) return false;
  return !node.tools || node.tools.length === 0 || node.tools.some(bash);
}

/**
 * The agents whose launch is checked against the route record, each with the
 * routes that lead to it. An agent is checked when it is a subagent, every
 * edge into it is a route, and each route's owner can run route.sh
 * ({@link canRecordRoute}). Empty off Claude Code and under inline delegation.
 */
export function routeTargets(ast: TopologyAST, p: GuardPlatform = CLAUDE_CODE_GUARDS): Map<string, RouteNeed[]> {
  const out = new Map<string, RouteNeed[]>();
  if (p.id !== "claude-code" || getDelegationMode(ast) === "inline") return out;
  const routed = new Set(ast.edges.filter((e) => routeOf(ast, e)).map((e) => e.to));
  for (const target of routed) {
    if (!ID.test(target) || !isRegisteredSubagentType(ast, target, p)) continue;
    const needs: RouteNeed[] = [];
    let all = true;
    for (const e of ast.edges.filter((x) => x.to === target)) {
      const r = routeOf(ast, e);
      if (!r || !canRecordRoute(ast, r.agent)) { all = false; break; }
      needs.push({ ...r, from: e.from });
    }
    if (all && needs.length > 0) out.set(target, needs);
  }
  return out;
}

/** A routed output (`router.class`): its declared values and, per value, the nodes its edges lead to. */
export interface RouteKey {
  agent: string;
  field: string;
  values: string[];
  starts: Map<string, string[]>;
}

/** The outputs route.sh records: those a checked launch reads. Empty when nothing is checked. */
export function routeKeys(ast: TopologyAST, p: GuardPlatform = CLAUDE_CODE_GUARDS): RouteKey[] {
  const checked = new Set<string>();
  for (const needs of routeTargets(ast, p).values()) for (const n of needs) checked.add(`${n.agent}.${n.field}`);
  const keys: RouteKey[] = [];
  for (const key of checked) {
    const [agent, field] = key.split(".");
    const values = outputsOf(ast, agent)?.[field] ?? [];
    const starts = new Map<string, string[]>(values.map((v) => [v, []]));
    for (const e of ast.edges) {
      const r = routeOf(ast, e);
      if (r && r.agent === agent && r.field === field && !starts.get(r.value)!.includes(e.to)) starts.get(r.value)!.push(e.to);
    }
    keys.push({ agent, field, values, starts });
  }
  return keys;
}

/** The route record, relative to the project root. */
export function routeRecordPath(ast: TopologyAST, p: GuardPlatform = CLAUDE_CODE_GUARDS): string {
  return `${p.stateDir}/routes-${ast.topology.name}.jsonl`;
}

/** The command a router runs to record its choice, `<value>` left for it to fill. */
export function routeCommand(ast: TopologyAST, key: { agent: string; field: string }, p: GuardPlatform = CLAUDE_CODE_GUARDS): string {
  return `bash ${p.scriptsDir(ast.topology.name)}/route.sh ${key.agent} ${key.field} <value>`;
}

/** route.sh, or null when no launch reads a route. */
export function generateRouteScript(ast: TopologyAST, p: GuardPlatform = CLAUDE_CODE_GUARDS): GeneratedFile | null {
  const keys = routeKeys(ast, p);
  if (keys.length === 0) return null;
  const name = ast.topology.name;
  const rec = routeRecordPath(ast, p);
  const routed = keys.map((k) => `${k.agent}.${k.field}`).join(", ");
  const lines = [
    "#!/usr/bin/env bash",
    `# The route record of topology "${name}".`,
    "# Auto-generated by agentopology scaffold. A router records its choice with",
    `#   bash ${p.scriptsDir(name)}/route.sh <agent> <field> <value>`,
    `# which appends {"agent", "field", "value", "ts"} to ${rec}. before-agent.sh reads the`,
    "# last record for an agent and field before it launches an agent that a",
    "# `when <agent>.<field> == <value>` edge leads to. A value the .at does not declare",
    "# exits 2 and writes nothing.",
    "set -euo pipefail",
    ...projectRootLines(p, name, "fallback"),
    `REC=${shellQuote(rec)}`,
    'if [ "$#" -ne 3 ]; then echo "agentopology: route.sh takes three words, <agent> <field> <value>, so nothing is recorded" >&2; exit 2; fi',
    'case "$1.$2" in',
  ];
  for (const k of keys) {
    const starts = k.values.map((v) => `${v}: ${(k.starts.get(v) ?? []).join(", ") || "nothing"}`).join("; ");
    lines.push(`  ${shellQuote(`${k.agent}.${k.field}`)}) VALUES=${shellQuote(k.values.join(" "))}; STARTS=${shellQuote(starts)} ;;`);
  }
  lines.push(
    `  *) echo "agentopology: \\"$1.$2\\" is not a routed output of topology ${name} (routed: ${routed}), so nothing is recorded" >&2; exit 2 ;;`,
    "esac",
    'if ! [[ $3 =~ ^[A-Za-z0-9_-]+$ ]] || [[ " $VALUES " != *" $3 "* ]]; then',
    '  echo "agentopology: \\"$3\\" is not a value of $1.$2 (one of: ${VALUES// /, }), so nothing is recorded" >&2',
    "  exit 2",
    "fi",
    'mkdir -p "$(dirname "$REC")"',
    `printf '{"agent":"%s","field":"%s","value":"%s","ts":"%s"}\\n' "$1" "$2" "$3" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$REC"`,
    'echo "agentopology: recorded $1.$2 = $3 (routes: $STARTS)"',
    "",
  );
  return { path: `${p.scriptsDir(name)}/route.sh`, content: lines.join("\n"), category: "script", executable: true };
}

/** The before-agent.sh function that reads the route record; empty when nothing is checked. */
export function routeCheckFunction(ast: TopologyAST, p: GuardPlatform): string[] {
  if (routeTargets(ast, p).size === 0) return [];
  const name = ast.topology.name;
  return [
    `ROUTES=${shellQuote(routeRecordPath(ast, p))}`,
    "# route_check AGENT KEY=VALUE FROM ...: AGENT starts only when the last route record for one KEY",
    "# (<agent>.<field>) holds its VALUE, the edge FROM -> AGENT. A record that cannot be read blocks.",
    "route_check() {",
    "  local target=$1 kv key val from last needs='' seen='' recs=''",
    "  shift",
    '  while [ "$#" -ge 2 ]; do',
    '    kv=$1; from=$2; shift 2',
    '    key=${kv%%=*}; val=${kv#*=}; last=""',
    '    if [ -f "$ROUTES" ]; then',
    `      last=$(jq -rs --arg a "\${key%%.*}" --arg f "\${key#*.}" '[.[] | objects | select(.agent == $a and .field == $f)] | last | (.value // "") | strings' "$ROUTES" 2>/dev/null) \\`,
    '        || { echo "agentopology: the route record $ROUTES could not be read, so \\"$target\\" is not started" >&2; exit 2; }',
    "    fi",
    '    [ -n "$last" ] && [ "$last" = "$val" ] && return 0',
    '    needs="${needs:+$needs or }$key == $val (edge $from -> $target)"',
    '    case " $seen " in *" $key "*) ;; *)',
    '      seen="$seen $key"',
    '      if [ -n "$last" ]; then recs="${recs:+$recs; }the last route record for $key holds \\"$last\\""; else recs="${recs:+$recs; }there is no route record for $key"; fi ;;',
    "    esac",
    "  done",
    `  echo "agentopology: \\"$target\\" starts only on the route $needs, but $recs. The router records its choice first: bash ${p.scriptsDir(name)}/route.sh <agent> <field> <value>" >&2`,
    "  exit 2",
    "}",
    "",
  ];
}

/** The before-agent.sh lines for one checked agent, or empty. */
export function routeCheckLines(ast: TopologyAST, agent: string, p: GuardPlatform): string[] {
  const needs = routeTargets(ast, p).get(agent);
  if (!needs) return [];
  const args = needs.map((n) => `${shellQuote(`${n.agent}.${n.field}=${n.value}`)} ${shellQuote(n.from)}`).join(" ");
  return [
    `    # route: ${needs.map((n) => `${n.from} -> ${agent} [when ${n.agent}.${n.field} == ${n.value}]`).join(", ")}`,
    `    route_check ${shellQuote(agent)} ${args}`,
  ];
}

/** The section of a router's agent file (or the playbook) that tells it to record its choice. */
export function routeInstructions(ast: TopologyAST, key: RouteKey, p: GuardPlatform = CLAUDE_CODE_GUARDS): string[] {
  const checked = [...routeTargets(ast, p).entries()]
    .filter(([, needs]) => needs.some((n) => n.agent === key.agent && n.field === key.field))
    .map(([t]) => t);
  return [
    `Record the choice of \`${key.agent}.${key.field}\` before the next step starts, with exactly one declared value:`,
    "",
    `    ${routeCommand(ast, key, p)}`,
    "",
    "| value | starts |",
    "|---|---|",
    ...key.values.map((v) => `| ${v} | ${(key.starts.get(v) ?? []).join(", ") || "(nothing)"} |`),
    "",
    `A launch of ${checked.join(" or ")} is refused unless the last record names its route. An undeclared value is refused and writes nothing.`,
  ];
}

/** A validate warning: a `when` edge that does not compile to a refusal on Claude Code. */
export interface RouteWarning {
  rule: string;
  level: "warning";
  node: string;
  message: string;
}

/**
 * One warning per `when` edge that Claude Code does not enforce, naming the
 * edge and why: another condition form, an action or a non-subagent target,
 * or a router that cannot run route.sh. Edges into a checked agent, and
 * routes into an agent a plain edge also reaches, do not warn.
 */
export function routeWarnings(ast: TopologyAST, p: GuardPlatform = CLAUDE_CODE_GUARDS): RouteWarning[] {
  const out: RouteWarning[] = [];
  const targets = routeTargets(ast, p);
  const inline = getDelegationMode(ast) === "inline";
  const warn = (e: EdgeDef, why: string) => out.push({
    rule: "CC-route",
    level: "warning",
    node: e.from,
    message: `Flow edge "${e.from} -> ${e.to}" [when ${cleanCondition(e.condition!)}] is not enforced on ${p.label}: ${why}; it stays a line in the playbook.`,
  });
  for (const e of ast.edges) {
    if (!e.condition || e.isError) continue;
    if (!routeOf(ast, e)) {
      warn(e, 'only "<agent>.<field> == <value>" on a declared enum output compiles to a launch guard');
      continue;
    }
    if (targets.has(e.to)) continue;
    const node = ast.nodes.find((n) => n.id === e.to);
    const into = ast.edges.filter((x) => x.to === e.to);
    const other = [...new Set(into.filter((x) => !routeOf(ast, x)).map((x) => `${x.from} -> ${x.to}`))];
    const mute = [...new Set(into.map((x) => routeOf(ast, x)?.agent).filter((a): a is string => !!a && !canRecordRoute(ast, a)))];
    if (inline) warn(e, "orchestrator.delegation is inline, so no agent is launched to refuse");
    else if (node?.type === "action") warn(e, `"${e.to}" is an action, and only an agent's launch is guarded`);
    else if (!isRegisteredSubagentType(ast, e.to, p)) warn(e, `"${e.to}" is not launched as a subagent, so no launch is guarded`);
    // A plain edge also leads into the agent: the route is one way in among others, and promises no refusal.
    else if (other.length > 0) continue;
    else if (mute.length > 0) {
      const who = mute.map((a) => `"${a}"`).join(" and ");
      warn(e, `${who} ${mute.length === 1 ? "has" : "have"} no Bash in ${mute.length === 1 ? "its" : "their"} tools, so route.sh cannot record the route`);
    } else {
      warn(e, `"${e.to}" is not a name the launch guard can match`);
    }
  }
  return out;
}
