/**
 * `agentopology guard <file> --check --target codex` (E-5): what a Codex
 * project enforces today, read from `.codex/hooks.json` and `.codex/scripts/`.
 * It writes nothing.
 *
 * Release 1 grades every Codex guard that is on disk "unverified", never
 * "refuse": no live Codex run has proven a guard holds, and Codex skips the
 * hooks of a project nobody has trusted with no message (probe P7). A gate
 * with no blocking event (it can run only on SubagentStop, which Codex cannot
 * block) is "none" whatever is on disk; that is the topology's shape, not a
 * missing file, so it does not fail the check.
 *
 * @module
 */

import * as fs from "node:fs";
import { join } from "node:path";
import type { GateNode, HumanNode, TopologyAST } from "../parser/ast.js";
import { gateAnchors } from "../parser/ast.js";
import { scriptNameFromRun } from "../parser/run.js";
import { approvalTargets, CODEX_GUARDS, LEDGER_WRITABLE_NOTE } from "../bindings/lib/guards.js";
import { gateLedger } from "../parser/ledger.js";
import { buildCodexHooks, codexGateHold } from "../bindings/lib/codex-hooks.js";
import { humanGateForgeable } from "../bindings/lib/codex-policy.js";
import { VERIFIED_ON, installedMark as codexInstalledMark, verifiedOnLine as codexVerifiedOnLine } from "../conformance/codex.js";
import type { GuardItem, GuardReport } from "./check.js";
import { citationProblem } from "./check.js";

interface Handler { type?: string; command?: string }
interface Entry { matcher?: string; hooks?: Handler[] }

const UNVERIFIED = "unverified: no live Codex run has proven this guard holds, and Codex skips the hooks of an untrusted project silently; trust .codex/hooks.json in /hooks";

function readText(path: string): string | null {
  try { return fs.readFileSync(path, "utf8"); } catch { return null; }
}

export function checkCodexGuards(ast: TopologyAST, root: string): GuardReport {
  const name = ast.topology.name;
  const dir = CODEX_GUARDS.scriptsDir(name);
  const hooksText = readText(join(root, ".codex/hooks.json"));
  let hooks: Record<string, Entry[]> = {};
  try { hooks = hooksText ? (JSON.parse(hooksText).hooks ?? {}) : {}; } catch { hooks = {}; }
  const items: GuardItem[] = [];

  /** Problems with one guard: its entry (event, matcher, script) and its script on disk. */
  const guardProblems = (event: string, matcher: string, file: string): string[] => {
    const out: string[] = [];
    if (hooksText === null) out.push(".codex/hooks.json is missing");
    else if (!(hooks[event] ?? []).some((e) => e.matcher === matcher && (e.hooks ?? []).some((h) => h.type === "command" && h.command?.includes(`${dir}/${file}`)))) {
      out.push(`no ${event} entry on ${matcher} for ${file} in .codex/hooks.json`);
    }
    if (readText(join(root, dir, file)) === null) out.push(`${dir}/${file} is missing`);
    return out;
  };

  for (const node of ast.nodes) {
    if (node.type !== "gate") continue;
    const gate = node as GateNode;
    const base = { kind: "gate" as const, id: gate.id };
    const hold = codexGateHold(ast, gate);
    const wrapper = `gate-${gate.id}.sh`;
    switch (hold.kind) {
      case "advisory":
        items.push({ ...base, strength: "hope", by: "prose", where: "advisory: it reports and never blocks", notes: [] });
        break;
      case "prose":
        items.push({ ...base, strength: "hope", by: "prose", where: "its run: names no script", notes: [] });
        break;
      case "script":
        items.push({ ...base, strength: "hope", by: "prose", where: `no Codex event marks its moment; run ${dir}/${wrapper} by hand`, notes: [] });
        break;
      case "none":
        items.push({
          ...base, strength: "none", by: "hook", structural: true,
          where: `SubagentStop on ${hold.anchors.join(", ")} → ${wrapper} (reports only)`,
          notes: ["Codex cannot block a SubagentStop, and no agent spawn or script step follows this gate, so nothing stops the next step"],
        });
        break;
      case "action": {
        const problems = guardProblems("PreToolUse", "Bash", "before-action.sh");
        const script = readText(join(root, dir, "before-action.sh"));
        if (script !== null && !script.includes(`# gate ${gate.id} (`)) problems.push(`before-action.sh has no line for gate ${gate.id}`);
        if (scriptNameFromRun(gate.run) && readText(join(root, dir, wrapper)) === null) problems.push(`${dir}/${wrapper} is missing`);
        const where = `PreToolUse on Bash running ${gateAnchors(gate, "before").join(", ")} → before-action.sh`;
        // F-4: its check reads a ledger the agent can write; the grade says so.
        const note = gateLedger(ast, gate) ? { gradeNote: LEDGER_WRITABLE_NOTE } : {};
        items.push(problems.length ? { ...base, strength: "none", by: "hook", where, notes: problems } : { ...base, strength: "unverified", by: "hook", where, notes: [UNVERIFIED], ...note });
        break;
      }
      case "spawn": {
        const problems = guardProblems("PreToolUse", "collaborationspawn_agent", "before-agent.sh");
        const script = readText(join(root, dir, "before-agent.sh"));
        if (script !== null && !script.includes(wrapper)) problems.push(`before-agent.sh does not run ${wrapper}`);
        if (readText(join(root, dir, wrapper)) === null) problems.push(`${dir}/${wrapper} is missing`);
        const where = `PreToolUse on collaborationspawn_agent launching ${hold.agents.join(", ")} → before-agent.sh`;
        items.push(problems.length ? { ...base, strength: "none", by: "hook", where, notes: problems } : { ...base, strength: "unverified", by: "hook", where, notes: [UNVERIFIED] });
        break;
      }
    }
  }

  // F-23: a gate that cites the code refusing it (at:, match:, bypass:) is checked on disk, as on
  // Claude Code: the cited file and line must be there and still hold the match text.
  for (const node of ast.nodes) {
    if (node.type !== "gate") continue;
    const gate = node as GateNode;
    if (!gate.at) continue;
    const item = items.find((i) => i.kind === "gate" && i.id === gate.id)!;
    const bad = citationProblem(root, gate.at, gate.match);
    const by = (gate.by ?? "code") as GuardItem["by"];
    const notes = bad ? [bad] : ["cited, not proven: the code is there, this check cannot run it", ...(gate.bypass ? [`bypass: ${gate.bypass}`] : [])];
    if (bad || item.strength === "hope" || item.strength === "none") {
      // D-9: release 1 grades every Codex guard unverified or none; a cited refusal is unverified too.
      const declared = gate.strength ?? "refuse";
      const strength = bad ? "none" : declared === "refuse" ? "unverified" : declared;
      Object.assign(item, { strength, by, where: `${by} at ${gate.at}`, notes: strength === "unverified" ? [UNVERIFIED, ...notes] : notes, structural: false, gradeNote: undefined });
    } else {
      item.notes.push(...notes.map((n) => `also ${n}`));
    }
  }

  const forged = humanGateForgeable(ast);
  for (const node of ast.nodes) {
    if (node.type !== "human") continue;
    const human = node as HumanNode;
    const base = { kind: "human" as const, id: human.id };
    const targets = approvalTargets(ast, human);
    if (targets.length === 0) {
      items.push({ ...base, strength: "hope", by: "prose", where: "no agent follows it, so no spawn to hold; the playbook asks", notes: [] });
      continue;
    }
    const problems = guardProblems("PreToolUse", "collaborationspawn_agent", "before-agent.sh");
    const script = readText(join(root, dir, "before-agent.sh"));
    if (script !== null && !script.includes(`# approval step ${human.id}`)) problems.push(`before-agent.sh does not hold for ${human.id}`);
    const where = `PreToolUse on collaborationspawn_agent launching ${targets.join(", ")} → an approval record in ${CODEX_GUARDS.stateDir}/approvals.jsonl`;
    const notes = [UNVERIFIED, ...(forged ? [`${forged}, so the model can write the approval itself`] : [])];
    // F-4: the approval record is a file the agent can write; the grade says so.
    items.push(problems.length ? { ...base, strength: "none", by: "hook", where, notes: problems } : { ...base, strength: "unverified", by: "hook", where, notes, gradeNote: LEDGER_WRITABLE_NOTE });
  }

  // Hooks on disk this check cannot tie to the topology.
  const generated = new Set<string>();
  const gen = buildCodexHooks(ast).hooksJson;
  if (gen) for (const entries of Object.values((JSON.parse(gen.content).hooks ?? {}) as Record<string, Entry[]>)) for (const e of entries) for (const h of e.hooks ?? []) if (h.command) generated.add(h.command);
  const unattributed: string[] = [];
  for (const [event, entries] of Object.entries(hooks)) {
    for (const e of entries ?? []) for (const h of e.hooks ?? []) {
      if (h.command?.includes(`${dir}/`) || (h.command && generated.has(h.command))) continue;
      unattributed.push(`${event}${e.matcher ? ` ${e.matcher}` : ""}: ${h.type === "command" ? h.command : h.type}`);
    }
  }

  const steps = items.filter((i) => i.kind === "gate" || i.kind === "human");
  return {
    items,
    enforcement: { refuse: steps.filter((i) => i.strength === "refuse").length, of: steps.length },
    missing: items.filter((i) => i.strength === "none" && !i.declared && !i.structural).length,
    unattributed,
    verifiedOn: VERIFIED_ON,
    platform: { label: "Codex CLI", line: codexVerifiedOnLine(), mark: codexInstalledMark(), config: ".codex/hooks.json" },
  };
}
