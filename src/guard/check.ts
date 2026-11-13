/**
 * `agentopology guard <file> --check`: what a project enforces today, read
 * from disk. It writes nothing.
 *
 * For each gate, approval step and permission rule the topology declares, it
 * works out what the claude-code binding compiles it to, then looks in the
 * project for that piece: the settings.json hook entry, the scripts it runs,
 * the permission rule. Each item gets a strength:
 *
 * - `refuse`: a hook or a settings rule stops the step, and it is on disk.
 * - `none`: the binding compiles it to a hook or rule, but the project is
 *   missing it (or names it by a relative path, which is skipped once Claude
 *   changes directory). Nothing stops the step.
 * - `hope`: the binding has no hook for it (an advisory gate, inline
 *   delegation, or a gate with no agent on either side); only the playbook's
 *   prose asks for it.
 *
 * @module
 */

import * as fs from "node:fs";
import { join } from "node:path";
import type { GateNode, HookDef, HumanNode, TopologyAST } from "../parser/ast.js";
import { gateAnchors } from "../parser/ast.js";
import { runParts, isProjectPath, scriptNameFromRun } from "../parser/run.js";
import { approvalTargets, checkableActionGate, claudeEvent, convertMcpToolName, gateWiring, settingsHooksOf } from "../bindings/claude-code.js";
import { isStubContent } from "../bindings/lib/stub.js";
import { installedMark, SESSION_HOOKS_PROVEN, unanchoredScript, VERIFIED_ON } from "../conformance/claude-code.js";
import { sessionAgentsOf, talkEdgesOf } from "../bindings/lib/session.js";

export type Strength = "refuse" | "detect" | "hope" | "none" | "unverified";

/** Every strength word, so the report can pad its column to the longest. */
const STRENGTH_WORDS: Strength[] = ["refuse", "detect", "hope", "none", "unverified"];
const STRENGTH_WIDTH = Math.max(...STRENGTH_WORDS.map((w) => w.length));

export interface GuardItem {
  kind: "gate" | "human" | "permission" | "edge" | "session";
  id: string;
  strength: Strength;
  by: "hook" | "settings" | "code" | "gate" | "prose";
  /** The file wrote this strength down itself (an edge's [strength: none]): reported, never a failure. */
  declared?: boolean;
  /** Where the enforcement lives (event, matcher, script), or why there is none. */
  where: string;
  notes: string[];
}

export interface GuardReport {
  items: GuardItem[];
  /** Gates and approval steps: how many refuse, of how many declared. */
  enforcement: { refuse: number; of: number };
  /** Items the binding compiles to a hook or rule that the project lacks, and broken citations. */
  missing: number;
  /**
   * Hooks in settings.json this check cannot tie to a step: hand-built
   * guards. They may refuse a step this report calls hope or none. Declare
   * them in hooks { } with a strength and cite them with [guard: name].
   */
  unattributed: string[];
  verifiedOn: string;
}

interface HookEntry { matcher?: string; hooks?: Array<{ type?: string; command?: string; onFailure?: string }> }

function readJson(path: string): Record<string, any> | null {
  try { return JSON.parse(fs.readFileSync(path, "utf8")); } catch { return null; }
}

/** True when a session guard still has a real `exit 2` line and a `jq -e` read (comments do not count). */
function holdsGeneratedLines(text: string): boolean {
  const code = text.split("\n").filter((l) => !/^\s*#/.test(l));
  return code.some((l) => /^\s*exit 2\s*$/.test(l)) && code.some((l) => /\bjq -er\b/.test(l));
}

function readText(path: string): string | null {
  try { return fs.readFileSync(path, "utf8"); } catch { return null; }
}

/** The command hooks on disk for an event whose command names `file`, under a matcher test. */
function findHooks(settings: Record<string, any> | null, event: string, file: string, matcher: (m?: string) => boolean) {
  const entries = (settings?.hooks?.[event] ?? []) as HookEntry[];
  return entries.filter((e) => matcher(e.matcher)).flatMap((e) => (e.hooks ?? []).filter((h) => h.type === "command" && h.command?.includes(file)));
}

/** Notes on the check script a gate's `run:` names: unwritten or missing scripts block every run. */
function checkScriptNotes(root: string, scriptsDir: string, run: string): string[] {
  const { script } = runParts(run);
  const path = script.startsWith("/") ? script : isProjectPath(script) ? join(root, script.replace(/^\.\//, "")) : join(root, scriptsDir, script.replace(/^.*\//, ""));
  const text = readText(path);
  const shown = path.startsWith(root) ? path.slice(root.length + 1) : path;
  if (text === null) return [`its check script ${shown} is missing, so it blocks every run`];
  if (isStubContent(text)) return [`its check script ${shown} is still a stub, so it blocks every run until it is written`];
  return [];
}

/** How many lines either side of a cited line the match text may sit. */
const MATCH_WINDOW = 5;

/**
 * Check an `at: "path[:line]"` citation on disk: the file exists, the line is
 * in it, and `match` appears within 5 lines of it (anywhere, with no line).
 * Null when it holds; otherwise why not.
 */
function citationProblem(root: string, at: string, match?: string): string | null {
  const m = /^(.*?)(?::(\d+))?$/.exec(at)!;
  const [file, lineText] = [m[1].replace(/^\.\//, ""), m[2]];
  const text = readText(join(root, file));
  if (text === null) return `the cited file ${file} is missing`;
  const all = text.split("\n");
  if (text.endsWith("\n")) all.pop();
  const line = lineText ? parseInt(lineText, 10) : undefined;
  if (line !== undefined && (line < 1 || line > all.length)) return `${file} has ${all.length} lines, so line ${line} is not in it`;
  if (match === undefined) return null;
  const window = line === undefined ? all : all.slice(Math.max(0, line - 1 - MATCH_WINDOW), line + MATCH_WINDOW);
  if (window.some((l) => l.includes(match))) return null;
  return line === undefined
    ? `"${match}" is not in ${file}`
    : `"${match}" is not within ${MATCH_WINDOW} lines of line ${line} in ${file}; the check may have moved or gone`;
}

/** Whether a declared hook is in settings.json: same event, same matcher, a command naming its script. */
function hookOnDisk(settings: Record<string, any> | null, hook: HookDef): boolean {
  const script = runParts(hook.run).script.replace(/^\.\//, "");
  if (!script) return false;
  return findHooks(settings, claudeEvent(hook.on), script, (m) => !hook.matcher || m === hook.matcher).length > 0;
}

/** Notes on a hook's command: a relative path is skipped off the project root. */
function commandProblem(command = ""): string | null {
  const loose = unanchoredScript(command);
  return loose ? `the hook names ${loose} by a relative path, so it is skipped once Claude changes directory` : null;
}

export function checkGuards(ast: TopologyAST, root: string): GuardReport {
  const name = ast.topology.name;
  const scriptsDir = `.claude/skills/${name}/scripts`;
  const settings = readJson(join(root, ".claude/settings.json"));
  const beforeAgent = readText(join(root, scriptsDir, "before-agent.sh"));
  const items: GuardItem[] = [];

  /** The before-agent PreToolUse entry: present and anchored, with onFailure noted. */
  const guardEntry = (): { ok: boolean; notes: string[] } => {
    const hooks = findHooks(settings, "PreToolUse", "before-agent.sh", (m) => !!m && /\b(Agent|Task)\b/.test(m));
    if (hooks.length === 0) return { ok: false, notes: ["no PreToolUse entry for before-agent.sh in .claude/settings.json"] };
    const bad = commandProblem(hooks[0].command);
    if (bad) return { ok: false, notes: [bad] };
    if (beforeAgent === null) return { ok: false, notes: [`${scriptsDir}/before-agent.sh is missing`] };
    const notes = hooks.some((h) => h.onFailure === "block") ? [] : ['the entry has no onFailure: "block", so the step goes through if the hook cannot start'];
    return { ok: true, notes };
  };

  for (const node of ast.nodes) {
    if (node.type !== "gate") continue;
    const gate = node as GateNode;
    const base = { kind: "gate" as const, id: gate.id };
    if (gate.behavior === "advisory") {
      items.push({ ...base, strength: "hope", by: "prose", where: "advisory: it reports and never blocks", notes: [] });
      continue;
    }
    // A gate before a script step: before-action.sh refuses its command. One
    // with nothing to check (V110) compiles to no line, and falls through to
    // the cases below (prose, or a citation).
    if (checkableActionGate(ast, gate)) {
      const where = `PreToolUse on Bash running ${gateAnchors(gate, "before").join(", ")} → before-action.sh`;
      const problems: string[] = [];
      const hooks = findHooks(settings, "PreToolUse", "before-action.sh", (m) => !!m && /\bBash\b/.test(m));
      if (hooks.length === 0) problems.push("no PreToolUse entry on Bash for before-action.sh in .claude/settings.json");
      else {
        const bad = commandProblem(hooks[0].command);
        if (bad) problems.push(bad);
      }
      const script = readText(join(root, scriptsDir, "before-action.sh"));
      if (script === null) problems.push(`${scriptsDir}/before-action.sh is missing`);
      else if (!script.includes(`# gate ${gate.id} (`)) problems.push(`before-action.sh has no line for gate ${gate.id}`);
      if (gate.run && scriptNameFromRun(gate.run) && readText(join(root, scriptsDir, `gate-${gate.id}.sh`)) === null) problems.push(`${scriptsDir}/gate-${gate.id}.sh is missing`);
      const scope = "refuses in Claude Code sessions only; a step run outside Claude is covered by step check (by: code)";
      const indirect = "a command that runs the step indirectly (bash -c, eval, a script that calls it) is not seen";
      if (problems.length) {
        items.push({ ...base, strength: "none", by: "hook", where, notes: [...problems, scope, indirect] });
      } else {
        const entryNotes = hooks.some((h) => h.onFailure === "block") ? [] : ['the entry has no onFailure: "block", so the step goes through if the hook cannot start'];
        items.push({ ...base, strength: "refuse", by: "hook", where, notes: [...entryNotes, ...(gate.run && scriptNameFromRun(gate.run) ? checkScriptNotes(root, scriptsDir, gate.run) : []), scope, indirect] });
      }
      continue;
    }
    if (!gate.run || !scriptNameFromRun(gate.run)) {
      items.push({ ...base, strength: "hope", by: "prose", where: "its run: names no script", notes: [] });
      continue;
    }
    const wiring = gateWiring(ast, gate);
    if (wiring.kind === "none") {
      const anchors = [...gateAnchors(gate, "after"), ...gateAnchors(gate, "before")].join(", ") || "nothing";
      items.push({ ...base, strength: "hope", by: "prose", where: `no Claude Code event marks its moment (between ${anchors}); the playbook runs it`, notes: [] });
      continue;
    }
    const scriptNotes = checkScriptNotes(root, scriptsDir, gate.run);
    if (wiring.kind === "subagent-stop") {
      const file = `gate-${gate.id}.sh`;
      const problems: string[] = [];
      for (const anchor of wiring.anchors) {
        const hooks = findHooks(settings, "SubagentStop", file, (m) => m === anchor);
        if (hooks.length === 0) problems.push(`no SubagentStop entry for ${anchor} running ${file} in .claude/settings.json`);
        else { const bad = commandProblem(hooks[0].command); if (bad) problems.push(bad); }
      }
      if (readText(join(root, scriptsDir, file)) === null) problems.push(`${scriptsDir}/${file} is missing`);
      const where = `SubagentStop on ${wiring.anchors.join(", ")} → ${file}`;
      items.push(problems.length
        ? { ...base, strength: "none", by: "hook", where, notes: problems }
        : { ...base, strength: "refuse", by: "hook", where, notes: scriptNotes });
      continue;
    }
    // before-agent
    const where = `PreToolUse on launching ${wiring.agents.join(", ")} → before-agent.sh`;
    const entry = guardEntry();
    const problems = entry.ok ? [] : entry.notes;
    if (entry.ok && !beforeAgent!.includes(`gate-${gate.id}.sh`)) problems.push(`before-agent.sh does not run gate-${gate.id}.sh`);
    if (readText(join(root, scriptsDir, `gate-${gate.id}.sh`)) === null) problems.push(`${scriptsDir}/gate-${gate.id}.sh is missing`);
    items.push(problems.length
      ? { ...base, strength: "none", by: "hook", where, notes: problems }
      : { ...base, strength: "refuse", by: "hook", where, notes: [...entry.notes, ...scriptNotes] });
  }

  for (const node of ast.nodes) {
    if (node.type !== "human") continue;
    const human = node as HumanNode;
    const base = { kind: "human" as const, id: human.id };
    const targets = approvalTargets(ast, human);
    if (targets.length === 0) {
      items.push({ ...base, strength: "hope", by: "prose", where: "no agent follows it, so no launch to ask before; the playbook asks", notes: [] });
      continue;
    }
    const where = `PreToolUse on launching ${targets.join(", ")} → ask`;
    const entry = guardEntry();
    const problems = entry.ok ? [] : entry.notes;
    if (entry.ok && !beforeAgent!.includes(`# approval step ${human.id}`)) problems.push(`before-agent.sh does not ask for ${human.id}`);
    items.push(problems.length
      ? { ...base, strength: "none", by: "hook", where, notes: problems }
      : { ...base, strength: "refuse", by: "hook", where, notes: [...entry.notes, "Claude Code asks the person in the session; in claude -p there is no one to ask, so it is denied"] });
  }

  // Session agents: the spawn guard and the talk guard. Both are PreToolUse
  // hooks; until the conformance facts mark them proven they grade
  // "unverified", never "refuse".
  if (sessionAgentsOf(ast).length > 0) {
    const sessionGuard = (id: string, file: string, matcher: string, event: string, proven: boolean, extra: string[]) => {
      const problems: string[] = [];
      const hooks = findHooks(settings, "PreToolUse", file, (m) => m === matcher);
      if (hooks.length === 0) problems.push(`no PreToolUse entry on ${matcher} for ${file} in .claude/settings.json`);
      else { const bad = commandProblem(hooks[0].command); if (bad) problems.push(bad); }
      const text = readText(join(root, scriptsDir, file));
      if (text === null) problems.push(`${scriptsDir}/${file} is missing`);
      else if (!holdsGeneratedLines(text)) problems.push(`${scriptsDir}/${file} no longer holds its generated lines (the exit 2 path and the jq read); regenerate it`);
      if (id === "talk guard" && readText(join(root, ".claude/sessions.md")) === null) problems.push("no .claude/sessions.md, so no session was started with AT_SESSION and every send is unguarded");
      const where = `PreToolUse on ${matcher} → ${file}`;
      const notes = [...extra];
      if (problems.length) return items.push({ kind: "session", id, strength: "none", by: "hook", where, notes: [...problems, ...notes] });
      if (!hooks.some((h) => h.onFailure === "block")) notes.unshift('the entry has no onFailure: "block", so the step goes through if the hook cannot start');
      if (!proven) notes.unshift(`${event} is not proven to stop a call in the installed Claude Code (conformance facts), so this is unverified`);
      items.push({ kind: "session", id, strength: proven ? "refuse" : "unverified", by: "hook", where, notes });
    };
    sessionGuard("spawn guard", "spawn-guard.sh", "Agent|Task", "PreToolUse on Agent", SESSION_HOOKS_PROVEN.agent, []);
    if (talkEdgesOf(ast).length > 0) {
      sessionGuard("talk guard", "talk-guard.sh", "SendMessage", "PreToolUse on SendMessage", SESSION_HOOKS_PROVEN.sendMessage, [
        "a send through a terminal command, a shared file or a session outside this repo is not seen",
        ".claude/state/talk.jsonl is a trail, not evidence: whoever can write files can edit it",
      ]);
    }
  }

  for (const key of ["deny", "ask"] as const) {
    for (const raw of (ast.settings?.[key] as string[] | undefined) ?? []) {
      const rule = convertMcpToolName(raw);
      const onDisk = ((settings?.permissions?.[key] ?? []) as string[]).includes(rule);
      items.push({
        kind: "permission",
        id: `${key} ${rule}`,
        strength: onDisk ? "refuse" : "none",
        by: "settings",
        where: `permissions.${key} in .claude/settings.json`,
        notes: onDisk ? [] : [`.claude/settings.json has no ${key} rule ${rule}`],
      });
    }
  }

  // A hook is the topology's own when it runs a script from the skill's
  // scripts folder, or when it is one the topology's hooks {} block compiles to.
  const ours = `.claude/skills/${name}/scripts/`;
  const declared = new Set<string>();
  for (const [event, entries] of Object.entries(settingsHooksOf(ast))) {
    for (const e of entries as HookEntry[]) for (const h of (e.hooks ?? []) as Array<Record<string, unknown>>) declared.add(`${event}|${h.command ?? h.prompt ?? h.url ?? ""}`);
  }
  const unattributed: string[] = [];
  for (const [event, entries] of Object.entries((settings?.hooks ?? {}) as Record<string, HookEntry[]>)) {
    for (const e of entries ?? []) for (const h of e.hooks ?? []) {
      const handler = h as Record<string, unknown>;
      if (h.command?.includes(ours) || declared.has(`${event}|${handler.command ?? handler.prompt ?? handler.url ?? ""}`)) continue;
      unattributed.push(`${event}${e.matcher ? ` ${e.matcher}` : ""}: ${h.type === "command" ? h.command : h.type}`);
    }
  }

  // Citations. A gate that cites the code refusing it (by: code, at:) is
  // checked on disk; a gate the binding gives no hook is credited by a guard
  // its edge cites. A cited hook counts only when it is in settings.json and
  // declares its strength: the file's own claim, cited, not proven.
  const hooksByName = new Map((ast.hooks ?? []).map((h) => [h.name, h]));
  const gateItem = (id: string) => items.find((i) => i.kind === "gate" && i.id === id);
  for (const node of ast.nodes) {
    if (node.type !== "gate") continue;
    const gate = node as GateNode;
    const item = gateItem(gate.id)!;
    if (gate.at) {
      const bad = citationProblem(root, gate.at, gate.match);
      const by = (gate.by ?? "code") as GuardItem["by"];
      const notes = bad ? [bad] : ["cited, not proven: the code is there, this check cannot run it", ...(gate.bypass ? [`bypass: ${gate.bypass}`] : [])];
      if (item.strength !== "refuse" || bad) {
        Object.assign(item, { strength: bad ? "none" : (gate.strength ?? "refuse"), by, where: `${by} at ${gate.at}`, notes });
      } else {
        item.notes.push(...notes.map((n) => `also ${n}`));
      }
    }
  }
  for (const node of ast.nodes) {
    if (node.type !== "gate") continue;
    const gate = node as GateNode;
    const item = gateItem(gate.id)!;
    if (item.strength === "refuse" || item.strength === "none") continue;
    const afters = gateAnchors(gate, "after");
    const befores = gateAnchors(gate, "before");
    const edges = ast.edges.filter((e) => e.guard?.length && afters.includes(e.from) && befores.includes(e.to));
    const why: string[] = [];
    const credited = () => (item.strength as Strength) === "refuse";
    for (const edge of edges) {
      for (const g of edge.guard!) {
        const hook = hooksByName.get(g);
        if (hook) {
          if (!hook.strength) { why.push(`its edge cites ${g}, but ${g} declares no strength`); continue; }
          if (!hookOnDisk(settings, hook)) { why.push(`its edge cites ${g}, but ${g} is not in .claude/settings.json`); continue; }
          if (hook.strength === "refuse" || hook.strength === "detect") {
            Object.assign(item, { strength: hook.strength, by: "hook", where: `${hook.on}${hook.matcher ? ` ${hook.matcher}` : ""} hook ${g}, cited on ${edge.from} -> ${edge.to}`, notes: ["cited, not proven", ...(hook.bypass ? [`bypass: ${hook.bypass}`] : [])] });
          }
        } else {
          const other = gateItem(g);
          if (other?.strength === "refuse") Object.assign(item, { strength: "refuse", by: "gate", where: `gate ${g}, cited on ${edge.from} -> ${edge.to}`, notes: [`as strong as gate ${g}`] });
        }
        if (credited()) break;
      }
      if (credited()) break;
    }
    if (!credited() && why.length) item.notes.push(...why);
  }
  for (const edge of ast.edges) {
    if (!edge.strength) continue;
    items.push({
      kind: "edge", id: `${edge.from} -> ${edge.to}`, strength: edge.strength as Strength, by: "prose", declared: true,
      where: edge.at ? `as written, at ${edge.at}` : "as written in the flow",
      notes: [`declared in the file${edge.strength === "none" ? ": nothing stops this step, and the file says so" : ""}`],
    });
  }
  // A declared hook's settings entry is the topology's own, however its interpreter is spelled.
  for (let i = unattributed.length - 1; i >= 0; i--) {
    const u = unattributed[i];
    if ((ast.hooks ?? []).some((h) => { const sc = runParts(h.run).script.replace(/^\.\//, ""); return !!sc && u.startsWith(claudeEvent(h.on)) && u.includes(sc); })) unattributed.splice(i, 1);
  }

  const steps = items.filter((i) => i.kind === "gate" || i.kind === "human");
  return {
    items,
    enforcement: { refuse: steps.filter((i) => i.strength === "refuse").length, of: steps.length },
    missing: items.filter((i) => i.strength === "none" && !i.declared).length,
    unattributed,
    verifiedOn: VERIFIED_ON,
  };
}

/** The report as terminal lines. */
export function renderGuardReport(report: GuardReport): string[] {
  const label = (i: GuardItem) => `${i.kind === "permission" ? "" : i.kind + " "}${i.id}`;
  const width = Math.max(10, ...report.items.map((i) => label(i).length));
  const lines: string[] = [];
  // No line may read "refuse" unless the installed Claude Code is the one the contract was checked on.
  const mark = installedMark();
  for (const i of report.items) {
    lines.push(`  ${label(i).padEnd(width)}  ${i.strength.padEnd(STRENGTH_WIDTH)}  by: ${i.by.padEnd(8)}  ${i.where}`);
    for (const n of i.notes) lines.push(`  ${"".padEnd(width)}  ${i.strength === "none" && !i.declared ? "✗" : "⚠"} ${n}`);
  }
  lines.push("");
  lines.push(`enforcement: ${report.enforcement.refuse} of ${report.enforcement.of} steps refuse · checked against Claude Code ${report.verifiedOn}`);
  if (report.unattributed.length) {
    lines.push(`${report.unattributed.length} hook(s) in .claude/settings.json are not tied to any step here (hand-built guards?). They may refuse steps shown as hope or none. Declare them in hooks { } with a strength and cite them on the edge with [guard: name]:`);
    for (const u of report.unattributed) lines.push(`  ${u.length > 110 ? u.slice(0, 107) + "..." : u}`);
  }
  if (report.missing) lines.push(`${report.missing} item(s) are missing or their citation no longer holds: rerun scaffold, fix the citation, or fix the project by hand`);
  return mark ? lines.map((l) => (/refus/i.test(l) ? `${l} · ${mark}` : l)) : lines;
}

/** One item of a guard report as page data. */
export interface GuardFact {
  kind: GuardItem["kind"];
  strength: Strength;
  by: GuardItem["by"];
  where: string;
  notes: string[];
  declared?: boolean;
}

/**
 * The report as data keyed by item id (a gate or human id, a permission rule,
 * `a -> b` for an edge, `spawn guard` / `talk guard`). The text render and
 * this read the same report.
 */
export function guardFacts(report: GuardReport): Record<string, GuardFact> {
  const out: Record<string, GuardFact> = {};
  for (const i of report.items) {
    out[i.id] = { kind: i.kind, strength: i.strength, by: i.by, where: i.where, notes: [...i.notes], ...(i.declared ? { declared: true } : {}) };
  }
  return out;
}
