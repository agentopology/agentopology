/**
 * claude-workflow binding.
 *
 * Compiles the DETERMINISTIC fan-out phases of an `.at` topology into a Claude
 * Workflow script (`<topology>.workflow.js`), plus the host-side seam glue
 * (a Blackboard seam contract doc) and a loud LOSSY report.
 *
 * This is the embedded-workflow half of the HYBRID model documented in
 * `docs/AT_VS_WORKFLOW_STRATEGY.md`. The claude-code binding emits the HOST
 * (roles, flow, hooks, Blackboard init, concurrent observability); THIS binding
 * emits the deterministic parallel phase(s) marked `execution: workflow`.
 *
 * The spec it implements: `docs/bindings/claude-workflow-mapping.md`.
 *
 * Hard rules from the spec:
 *   - The Workflow runtime forbids mid-run human input → a `human` node SPLITS
 *     the topology: the workflow.js ends BEFORE the human node and a README
 *     documents the handoff (regression is a separate downstream workflow).
 *   - The Workflow runtime is deterministic → no Date.now / Math.random; loops
 *     are bounded by literal counts and labeled by index.
 *   - UNREPRESENTABLE primitives are NEVER silently dropped: they surface as
 *     `// UNREPRESENTABLE:` comments in the script AND in a LOSSY-REPORT.md.
 *
 * @module
 */

import type {
  TopologyAST,
  AgentNode,
  GateNode,
  HumanNode,
  NodeDef,
  OutputsMap,
} from "../parser/ast.js";
import { deduplicateFiles } from "./types.js";
import type { BindingTarget, GeneratedFile } from "./types.js";
import { SEAM_NS, isWorkflowSeamAgent, seamFiles } from "./lib/seam.js";

// ---------------------------------------------------------------------------
// Lossy / unrepresentable bookkeeping
// ---------------------------------------------------------------------------

/** A single translation note for the LOSSY report. */
interface LossNote {
  /** "LOSSY" — representable with effort; "UNREPRESENTABLE" — runtime can't. */
  severity: "LOSSY" | "UNREPRESENTABLE";
  /** The `.at` primitive involved (e.g. "human", "hooks", "permissions"). */
  primitive: string;
  /** The specific node / scope this note applies to. */
  scope: string;
  /** Why it is lossy / unrepresentable + what the operator should know. */
  reason: string;
}

/** Mutable collector threaded through the generators. */
class LossLedger {
  readonly notes: LossNote[] = [];
  private readonly seen = new Set<string>();

  add(note: LossNote): void {
    const key = `${note.severity}|${note.primitive}|${note.scope}|${note.reason}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.notes.push(note);
  }

  has(severity: LossNote["severity"]): boolean {
    return this.notes.some((n) => n.severity === severity);
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Escape a string for embedding inside a single-quoted JS string literal. */
function sq(s: string): string {
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n")}'`;
}

/** Escape for a JS template literal (backtick). */
function tl(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

/** Collapse a multi-line prompt into a single normalized string. */
function flattenPrompt(prompt: string | undefined, fallback: string): string {
  if (!prompt) return fallback;
  return prompt
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ");
}

/** Indent every line of a block by `n` spaces. */
function indent(text: string, n: number): string {
  const pad = " ".repeat(n);
  return text
    .split("\n")
    .map((l) => (l.length ? pad + l : l))
    .join("\n");
}

/**
 * Build the prompt string for a workflow agent, embedding its Blackboard
 * reads/writes (the script has no filesystem, so the paths live in the prompt).
 */
function buildAgentPrompt(agent: AgentNode, roles: Record<string, string>): string {
  const base = flattenPrompt(
    agent.prompt,
    agent.description ?? roles[agent.role ?? ""] ?? roles[agent.id] ?? `Run the ${agent.id} step.`,
  );
  const parts = [base];
  if (agent.reads && agent.reads.length > 0) {
    parts.push(`Read: ${agent.reads.join(", ")}.`);
  }
  if (agent.writes && agent.writes.length > 0) {
    parts.push(`Write your result to: ${agent.writes.join(", ")}.`);
  }
  return parts.join(" ");
}

/**
 * Build the `schema` option object literal from an agent's `outputs` enum map.
 * `{ verdict: pass | fail }` → `{type:'object',properties:{verdict:{enum:['pass','fail']}},required:['verdict']}`.
 */
function buildSchemaLiteral(outputs: OutputsMap): string {
  const props: string[] = [];
  const required: string[] = [];
  for (const [field, values] of Object.entries(outputs)) {
    props.push(`${field}: { enum: [${values.map((v) => sq(v)).join(", ")}] }`);
    required.push(sq(field));
  }
  return `{ type: 'object', properties: { ${props.join(", ")} }, required: [${required.join(", ")}] }`;
}

/**
 * Build the options object for an `agent(prompt, opts)` call.
 * Returns the literal (without surrounding `{}`) or undefined when no opts.
 */
function buildAgentOpts(
  agent: AgentNode,
  extraLabel?: string,
): { opts: string | undefined; comments: string[] } {
  const fields: string[] = [];
  const comments: string[] = [];

  fields.push(`label: ${sq(extraLabel ?? agent.id)}`);
  if (agent.model) fields.push(`model: ${sq(agent.model)}`);
  if (agent.isolation) fields.push(`isolation: ${sq(agent.isolation)}`);
  if (agent.outputs && Object.keys(agent.outputs).length > 0) {
    fields.push(`schema: ${buildSchemaLiteral(agent.outputs)}`);
  }

  // §8: permissions are session-fixed, not per-agent in-script → comment only.
  if (agent.permissions) {
    comments.push(
      `// permissions: ${agent.permissions} — session-fixed (set the launch session's allowlist, not in-script)`,
    );
  }
  if (agent.maxTurns != null) {
    comments.push(`// max-turns: ${agent.maxTurns} — UNREPRESENTABLE in-script (prompt-soft only)`);
  }

  return { opts: fields.length ? `{ ${fields.join(", ")} }` : undefined, comments };
}

// ---------------------------------------------------------------------------
// Phase extraction
// ---------------------------------------------------------------------------

// Seam constants/helpers are the single source of truth shared with the
// claude-code (host) binding — see ./lib/seam.ts. Local alias kept for brevity.
const isWorkflowSeam = isWorkflowSeamAgent;

/** Resolve an agent's phase (defaults to a large value so unphased trails). */
function phaseOf(agent: AgentNode): number {
  return agent.phase ?? Number.MAX_SAFE_INTEGER;
}

/**
 * Determine which phases compile into the workflow.
 *
 * Per the spec: agents marked `execution: workflow` — AND every agent sharing
 * that phase — compile into the embedded workflow. We collect the set of
 * phases that contain at least one seam-marked agent.
 */
function workflowPhases(agents: AgentNode[]): Set<number> {
  const phases = new Set<number>();
  for (const a of agents) {
    if (isWorkflowSeam(a)) phases.add(phaseOf(a));
  }
  return phases;
}

// ---------------------------------------------------------------------------
// The workflow.js emitter
// ---------------------------------------------------------------------------

/** Generate one `phase()` block of agent calls (parallel when >1 agent). */
function emitPhaseBlock(
  phaseNum: number,
  agents: AgentNode[],
  roles: Record<string, string>,
  ledger: LossLedger,
): string {
  const lines: string[] = [];
  const title = `Phase ${phaseNum}`;
  lines.push(`  phase(${sq(title)});`);

  // Build each agent's call expression + collect comments.
  const calls: { thunk: string; comments: string[]; scaled?: boolean }[] = [];

  for (const agent of agents) {
    const prompt = buildAgentPrompt(agent, roles);

    // scale → deterministic parallel fan-out (literal n from scale.max).
    if (agent.scale) {
      const n = agent.scale.max;
      const { comments } = buildAgentOpts(agent);
      ledger.add({
        severity: "LOSSY",
        primitive: "agent.scale",
        scope: agent.id,
        reason: `scale {min:${agent.scale.min}, max:${agent.scale.max}, by:${agent.scale.by}} → deterministic parallel fan-out of ${n} (literal max). The script cannot count fs/source items at runtime, so it fans out to the static max; tune via args before launch.`,
      });
      const optsFields = [
        `label: \`${tl(agent.id)}-\${i}\``,
      ];
      if (agent.model) optsFields.push(`model: ${sq(agent.model)}`);
      if (agent.isolation) optsFields.push(`isolation: ${sq(agent.isolation)}`);
      if (agent.outputs && Object.keys(agent.outputs).length > 0) {
        optsFields.push(`schema: ${buildSchemaLiteral(agent.outputs)}`);
      }
      const promptExpr = `\`${tl(prompt)} (slice \${i + 1} of ${n})\``;
      const thunk = [
        `parallel(`,
        `  Array.from({ length: ${n} }, (_, i) => () =>`,
        `    agent(${promptExpr}, { ${optsFields.join(", ")} })`,
        `  )`,
        `)`,
      ].join("\n");
      calls.push({
        thunk,
        comments: [`// agent: ${agent.id} — scaled fan-out (deterministic, n=${n})`, ...comments],
        scaled: true,
      });
      continue;
    }

    const { opts, comments } = buildAgentOpts(agent);
    const callExpr = opts
      ? `agent(${sq(prompt)}, ${opts})`
      : `agent(${sq(prompt)})`;
    calls.push({ thunk: callExpr, comments });
  }

  if (calls.length === 1) {
    const c = calls[0];
    for (const cm of c.comments) lines.push(`  ${cm}`);
    if (c.scaled) {
      // already a parallel(...) expression
      lines.push(indent(`await ${c.thunk};`, 2));
    } else {
      lines.push(`  await ${c.thunk};`);
    }
  } else {
    // Same-phase agents → parallel([...]) (barrier).
    lines.push(`  await parallel([`);
    for (let i = 0; i < calls.length; i++) {
      const c = calls[i];
      for (const cm of c.comments) lines.push(`    ${cm}`);
      if (c.scaled) {
        lines.push(indent(`() => ${c.thunk},`, 4));
      } else {
        lines.push(`    () => ${c.thunk},`);
      }
    }
    lines.push(`  ]);`);
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Emit a gate as an imperative guard.
 *   bounce-back → bounded for-loop with per-iteration labels.
 *   halt        → throw.
 *   advisory    → log() (no throw).
 */
function emitGate(gate: GateNode, ledger: LossLedger): string {
  const lines: string[] = [];
  const checks = gate.checks ?? [];
  const onFail = gate.onFail ?? "halt";
  const behavior = gate.behavior ?? "blocking";
  const gatePrompt =
    `Run the ${gate.id} gate. Verify: ${checks.length ? checks.join(", ") : "the prior phase outputs"}. ` +
    (gate.run ? `(host script: ${gate.run}) ` : "") +
    `Return {pass:boolean, reason:string}.`;
  const schema = `{ type: 'object', properties: { pass: { type: 'boolean' }, reason: { type: 'string' } }, required: ['pass'] }`;

  ledger.add({
    severity: "LOSSY",
    primitive: "gate",
    scope: gate.id,
    reason: `gate run-script '${gate.run ?? "(none)"}' cannot execute in-script (NO_SHELL). Re-expressed as a verify agent() that returns {pass,reason}; on-fail=${onFail}, behavior=${behavior}.`,
  });

  if (behavior === "advisory") {
    lines.push(`  // gate: ${gate.id} (advisory — logs, never halts)`);
    lines.push(`  {`);
    lines.push(`    const g = await agent(${sq(gatePrompt)}, { label: ${sq("gate-" + gate.id)}, schema: ${schema} });`);
    lines.push(`    if (!g.pass) log(\`advisory gate ${tl(gate.id)} flagged: \${g.reason}\`);`);
    lines.push(`  }`);
    lines.push("");
    return lines.join("\n");
  }

  if (onFail === "bounce-back") {
    const max = gate.retry ?? 2;
    lines.push(`  // gate: ${gate.id} (bounce-back, bounded to ${max} retries)`);
    lines.push(`  let ${gate.id.replace(/[^a-zA-Z0-9_]/g, "_")}_pass = false;`);
    const v = `${gate.id.replace(/[^a-zA-Z0-9_]/g, "_")}_pass`;
    lines.push(`  for (let attempt = 0; attempt < ${max}; attempt++) {`);
    lines.push(`    const g = await agent(${sq(gatePrompt)}, { label: \`gate-${tl(gate.id)}-attempt-\${attempt}\`, schema: ${schema} });`);
    lines.push(`    if (g.pass) { ${v} = true; break; }`);
    lines.push(`    log(\`gate ${tl(gate.id)} failed (attempt \${attempt + 1}/${max}): \${g.reason} — bouncing back\`);`);
    lines.push(`    // bounce-back: re-run the producing phase here before the next attempt`);
    lines.push(`  }`);
    lines.push(`  if (!${v}) throw new Error(${sq(`gate ${gate.id} did not pass after ${max} attempts`)});`);
    lines.push("");
    return lines.join("\n");
  }

  // halt (default)
  lines.push(`  // gate: ${gate.id} (halt on fail)`);
  lines.push(`  {`);
  lines.push(`    const g = await agent(${sq(gatePrompt)}, { label: ${sq("gate-" + gate.id)}, schema: ${schema} });`);
  lines.push(`    if (!g.pass) throw new Error(\`gate ${tl(gate.id)} failed: \${g.reason}\`);`);
  lines.push(`  }`);
  lines.push("");
  return lines.join("\n");
}

/**
 * Generate the workflow.js file.
 *
 * Returns the file plus the human-split boundary info (if any) so the caller
 * can emit the handoff README.
 */
function generateWorkflowScript(
  ast: TopologyAST,
  ledger: LossLedger,
): { file: GeneratedFile | null; humanNode: HumanNode | null; phasesEmitted: number[] } {
  const name = ast.topology.name;
  const agents = ast.nodes.filter((n): n is AgentNode => n.type === "agent");
  const wfPhases = workflowPhases(agents);

  if (wfPhases.size === 0) {
    // No seam markers — nothing to compile. The whole topology stays on the host.
    ledger.add({
      severity: "LOSSY",
      primitive: "topology",
      scope: name,
      reason: `No phases marked execution:workflow; nothing to compile to the Workflow runtime. No workflow.js is emitted — the entire topology stays on the host (claude-code binding). Mark a deterministic fan-out phase with extensions.${SEAM_NS}.execution = "workflow" to emit an embedded workflow.`,
    });
    return { file: null, humanNode: null, phasesEmitted: [] };
  }

  // --- Human split (topology-level): the binding SPLITS at the human node. The
  // workflow.js is the autonomous deterministic rung; the human node is a HOST
  // concern far downstream of the workflow phase. We still report it loud +
  // emit the README, but the human node never appears in this script. ---
  const humanNode = ast.nodes.find((n): n is HumanNode => n.type === "human") ?? null;
  if (humanNode) {
    ledger.add({
      severity: "UNREPRESENTABLE",
      primitive: "human",
      scope: humanNode.id,
      reason: `The Workflow runtime prohibits mid-run human input (NO_HUMAN_INPUT). The topology is SPLIT: the workflow.js is only the deterministic workflow-marked rung; the human node '${humanNode.id}' is a HOST concern downstream of it. After the host runs verify + gate, the human promotes, which triggers the SEPARATE downstream workflow (e.g. regression). See ${name}-README.md.`,
    });
  }

  // --- STRICT SEAM: only phases that have ≥1 agent marked execution:workflow
  // (plus agents sharing those phases) compile into the script. Everything else
  // is a HOST concern and is NOT folded in. ---
  const byPhase = new Map<number, AgentNode[]>();
  for (const a of agents) {
    const p = phaseOf(a);
    if (!wfPhases.has(p)) continue; // host phase — not the workflow's concern
    if (!byPhase.has(p)) byPhase.set(p, []);
    byPhase.get(p)!.push(a);
  }
  const orderedPhases = [...byPhase.keys()].sort((x, y) => x - y);

  // --- Gates: include ONLY a gate that sits BETWEEN two workflow-marked phases
  // (both its `after` and `before` agents live in workflow phases). A gate whose
  // `after`/`before` touches a host phase stays HOST. ---
  const gates = ast.nodes.filter((n): n is GateNode => n.type === "gate");
  const gatesByAfterPhase = new Map<number, GateNode[]>();
  for (const g of gates) {
    const afterAgent = agents.find((a) => a.id === g.after);
    const beforeAgent = agents.find((a) => a.id === g.before);
    const afterInWf = afterAgent ? wfPhases.has(phaseOf(afterAgent)) : false;
    const beforeInWf = beforeAgent ? wfPhases.has(phaseOf(beforeAgent)) : false;
    // Require the gate to be wholly inside the workflow span: its after-agent must
    // be a workflow phase, and (if it has a before-agent) that must be too.
    if (!afterInWf || (beforeAgent && !beforeInWf)) {
      ledger.add({
        severity: "LOSSY",
        primitive: "gate",
        scope: g.id,
        reason: `gate '${g.id}' (after: ${g.after ?? "—"}, before: ${g.before ?? "—"}) is HOST-side — it does not sit between two workflow-marked phases, so it is NOT in the workflow.js. The host (claude-code binding) enforces it after the workflow returns.`,
      });
      continue;
    }
    const p = phaseOf(afterAgent!);
    if (!gatesByAfterPhase.has(p)) gatesByAfterPhase.set(p, []);
    gatesByAfterPhase.get(p)!.push(g);
  }

  // --- Build the meta literal (PURE — no computed values). ---
  const metaPhases = orderedPhases.map((p) => {
    const ids = byPhase.get(p)!.map((a) => a.id);
    return `    { phase: ${p}, agents: [${ids.map((id) => sq(id)).join(", ")}] }`;
  });

  const desc = ast.topology.description || `Embedded deterministic workflow for ${name}.`;

  // --- Per-spec UNREPRESENTABLE primitives present in the topology → comments. ---
  const topComments = collectTopologyLossComments(ast, ledger, humanNode);

  // --- Assemble. ---
  const out: string[] = [];
  out.push(`// ${name}.workflow.js — generated by agentopology (target: claude-workflow)`);
  out.push(`// The deterministic workflow-marked rung of the HYBRID host+workflow model.`);
  out.push(`// STRICT SEAM: this script contains ONLY the phases marked execution:workflow`);
  out.push(`// (${orderedPhases.map((p) => `phase ${p}`).join(", ")}). The host (claude-code binding) runs every other`);
  out.push(`// phase, seeds the Blackboard inputs, launches this workflow, then consumes its outputs.`);
  out.push(`// Host glue (Blackboard seam): see ${seamFiles.seamDoc(name)}. Translation losses: ${seamFiles.lossyDoc(name)}.`);
  if (humanNode) {
    out.push(`// HUMAN SPLIT: the human node '${humanNode.id}' is HOST-side, downstream of this rung. See ${name}-README.md.`);
  }
  out.push("");
  if (topComments.length) {
    out.push(...topComments);
    out.push("");
  }
  out.push(`export const meta = {`);
  out.push(`  name: ${sq(name)},`);
  out.push(`  description: ${sq(desc)},`);
  out.push(`  phases: [`);
  out.push(metaPhases.join(",\n"));
  out.push(`  ],`);
  out.push(`};`);
  out.push("");
  out.push(`export default async function ${toIdent(name)}(args = {}) {`);
  out.push("");

  for (const p of orderedPhases) {
    out.push(emitPhaseBlock(p, byPhase.get(p)!, ast.roles, ledger));
    // Gates between this workflow phase and the next (if any).
    for (const g of gatesByAfterPhase.get(p) ?? []) {
      out.push(emitGate(g, ledger));
    }
  }

  out.push(`  log(${sq(`workflow rung complete — results written to the Blackboard for the host to consume`)});`);
  out.push("");

  out.push(`  return { ok: true };`);
  out.push(`}`);
  out.push("");

  return {
    file: {
      path: seamFiles.workflowScript(name),
      content: out.join("\n"),
      category: "script",
    },
    humanNode,
    phasesEmitted: orderedPhases,
  };
}

/** Sanitize a topology name into a JS identifier for the default export. */
function toIdent(name: string): string {
  const camel = name.replace(/[-_]+(.)/g, (_, c) => c.toUpperCase()).replace(/[^a-zA-Z0-9_]/g, "");
  return /^[a-zA-Z_]/.test(camel) ? camel : `wf_${camel}`;
}

/**
 * Emit `// UNREPRESENTABLE:` / `// LOSSY:` comments for topology-level primitives
 * that the Workflow runtime cannot express, AND record them in the ledger.
 */
function collectTopologyLossComments(
  ast: TopologyAST,
  ledger: LossLedger,
  humanNode: HumanNode | null,
): string[] {
  const comments: string[] = [];

  if (humanNode) {
    comments.push(`// UNREPRESENTABLE: human '${humanNode.id}' — mid-run human input forbidden; topology split here (see README).`);
  }

  if (ast.hooks && ast.hooks.length > 0) {
    const evts = ast.hooks.map((h) => h.on).join(", ");
    comments.push(`// UNREPRESENTABLE: hooks (${evts}) — the Workflow runtime has no pre/post event bus. Host-layer concern (claude-code binding emits .claude/settings.json hooks).`);
    ledger.add({
      severity: "UNREPRESENTABLE",
      primitive: "hooks",
      scope: ast.hooks.map((h) => h.name || h.on).join(", "),
      reason: `Hooks are a host-session event bus (PostToolUse/PreToolUse/etc.). The Workflow script has no event hooks. These stay on the HOST (claude-code binding → .claude/settings.json). In the hybrid model, host hooks watch the Blackboard the workflow agents write — that IS the concurrent observability (see SEAM doc).`,
    });
  }

  // permissions / settings / sandbox / providers — session-fixed.
  const hasPerm = ast.nodes.some((n) => n.type === "agent" && (n as AgentNode).permissions);
  if (hasPerm) {
    comments.push(`// UNREPRESENTABLE: per-agent permissions — session-fixed; agents inherit the launch session allowlist (not settable per-agent in-script). Set via sidecar settings.json at launch.`);
    ledger.add({
      severity: "UNREPRESENTABLE",
      primitive: "permissions",
      scope: "agents",
      reason: `Workflow agents inherit the launching session's permission mode and allowlist (PERMISSION_INHERIT_NOT_CONFIGURABLE). Per-agent permissions/tools cannot be set in-script. Configure them in the session's settings.json (the claude-code host binding emits this).`,
    });
  }

  if (ast.providers && ast.providers.length > 0) {
    comments.push(`// UNREPRESENTABLE: providers — model routing/credentials are session/host config, not in-script.`);
    ledger.add({
      severity: "UNREPRESENTABLE",
      primitive: "providers",
      scope: ast.providers.map((p) => p.name).join(", "),
      reason: `Provider credentials and model routing are session/host configuration. The Workflow script can name a model per agent() (opts.model) but cannot configure providers. Keep providers on the host.`,
    });
  }

  if (ast.schedules && ast.schedules.length > 0) {
    comments.push(`// UNREPRESENTABLE: schedule — the Workflow runtime has no scheduler/timer. Use a sidecar cron to launch the workflow.`);
    ledger.add({
      severity: "UNREPRESENTABLE",
      primitive: "schedule",
      scope: ast.schedules.map((s) => s.id).join(", "),
      reason: `No runtime scheduler in the Workflow tool. Launch the workflow from a sidecar cron / external trigger.`,
    });
  }

  if (ast.interfaces && ast.interfaces.length > 0) {
    comments.push(`// UNREPRESENTABLE: interfaces — Workflows are launched by command/decision, not external ingress (webhook/http/sse).`);
    ledger.add({
      severity: "UNREPRESENTABLE",
      primitive: "interfaces",
      scope: ast.interfaces.map((i) => i.id).join(", "),
      reason: `Workflows are invoked by command or Claude decision, never by external events. External ingress stays on the host / an external launcher.`,
    });
  }

  if (ast.metering) {
    ledger.add({
      severity: "LOSSY",
      primitive: "metering",
      scope: "topology",
      reason: `phase()/label()/budget give partial native metering, but the script cannot emit a metrics.jsonl (${ast.metering.output}). Aggregate metering stays on the host.`,
    });
  }

  if (ast.observability && ast.observability.enabled) {
    ledger.add({
      severity: "LOSSY",
      primitive: "observability",
      scope: "topology",
      reason: `phase()/label()/log() give a native trace, but there is no OTLP export (exporter=${ast.observability.exporter}) and no concurrent listener. Live concurrent observability is a HOST-layer feature (hooks polling the Blackboard).`,
    });
  }

  // Blackboard / memory.workspace is LOSSY-but-honored via prompt paths.
  if (ast.memory && (ast.memory as Record<string, unknown>).workspace) {
    ledger.add({
      severity: "LOSSY",
      primitive: "memory.workspace",
      scope: "topology",
      reason: `The Blackboard (memory.workspace) is honored by embedding read/write paths in agent prompts (the script has no filesystem). It is NOT a live mutable substrate the script reads; agents read/write the files directly. The host hooks observe these files live — that is the seam (see SEAM doc).`,
    });
  }

  return comments;
}

// ---------------------------------------------------------------------------
// Companion docs
// ---------------------------------------------------------------------------

/** Emit the human-split handoff README. */
function generateHumanSplitReadme(ast: TopologyAST, human: HumanNode): GeneratedFile {
  const name = ast.topology.name;
  const downstream = ast.edges.filter((e) => e.from === human.id).map((e) => e.to);
  const lines: string[] = [];
  lines.push(`# ${name} — Workflow Split (human handoff)`);
  lines.push("");
  lines.push(`The Claude Workflow runtime **prohibits mid-run human input**. The \`${name}\` topology contains a \`human\` node (\`${human.id}\`), so the binding **split** it at that boundary.`);
  lines.push("");
  lines.push(`## What \`${name}.workflow.js\` does`);
  lines.push("");
  lines.push(`It runs **only** the deterministic phases marked \`execution: workflow\` (STRICT SEAM) and exits with its results written to the Blackboard. It does **not** contain \`${human.id}\` as an agent — a workflow cannot wait on a human, and the human node is a HOST concern downstream of this rung. The host runs every other phase (the contract research, the adversarial verify, the gate, the ship-report) in-session, then the human promotes.`);
  lines.push("");
  lines.push(`## The human boundary: \`${human.id}\``);
  lines.push("");
  if (human.description) {
    lines.push(`> ${flattenPrompt(human.description, "")}`);
    lines.push("");
  }
  if (human.timeout) lines.push(`- Timeout: ${human.timeout}`);
  if (human.onTimeout) lines.push(`- On timeout: ${human.onTimeout}`);
  lines.push("");
  lines.push(`The operator (host session) reads the Blackboard artifacts, presents them to the human, and the human acts (e.g. promotes).`);
  lines.push("");
  lines.push(`## Downstream is a SEPARATE workflow`);
  lines.push("");
  if (downstream.length > 0) {
    lines.push(`After the human acts, the downstream steps (${downstream.join(", ")}) run as a **separate** workflow/process — not part of this autonomous script. This mirrors the closed-loop rule: regression is a downstream workflow, launched after promotion.`);
  } else {
    lines.push(`After the human acts, any downstream work runs as a **separate** workflow/process — not part of this autonomous script.`);
  }
  lines.push("");
  lines.push(`## Hand-off mechanics (the seam)`);
  lines.push("");
  lines.push(`See \`${name}-SEAM.md\` for the exact Blackboard file paths both the host and the embedded workflow agree on.`);
  lines.push("");
  return { path: seamFiles.readmeDoc(name), content: lines.join("\n"), category: "machine" };
}

/** Emit the Blackboard seam contract doc (host glue agreement). */
function generateSeamDoc(ast: TopologyAST, phasesEmitted: number[]): GeneratedFile {
  const name = ast.topology.name;
  const agents = ast.nodes.filter((n): n is AgentNode => n.type === "agent");
  const human = ast.nodes.find((n): n is HumanNode => n.type === "human") ?? null;
  const workspace = (ast.memory as Record<string, unknown> | undefined)?.workspace as
    | { path?: string; structure?: string[] }
    | undefined;
  const wfPhases = workflowPhases(agents);
  const wfSet = new Set(phasesEmitted);

  // Group all agent phases into host vs workflow for the explicit run order.
  const allPhases = [...new Set(agents.map(phaseOf))].sort((x, y) => x - y);
  const phaseLabel = (p: number): string => {
    const ids = agents.filter((a) => phaseOf(a) === p).map((a) => a.id).join(", ");
    return `phase ${p} (${ids})`;
  };

  const lines: string[] = [];
  lines.push(`# ${name} — Blackboard Seam Contract`);
  lines.push("");
  lines.push(`This is the file-based hand-off contract between the **host** (claude-code binding → \`.claude/\`) and the **embedded workflow** (\`${name}.workflow.js\`). Both sides MUST agree on these paths. The topology already carries the seam via \`memory.workspace\` + each agent's \`reads\`/\`writes\`; this doc makes it explicit so the two bindings stay in sync.`);
  lines.push("");
  lines.push(`**STRICT SEAM.** The workflow.js is **only** the deterministic rung — the phases marked \`execution: workflow\` (${phasesEmitted.map((p) => `phase ${p}`).join(", ") || "none"}). Every other phase, the gates that don't sit between two workflow phases, and the \`human\` node are **HOST** concerns; the host emits and runs them. They are NOT in the workflow.js.`);
  lines.push("");

  lines.push(`## Workspace (Blackboard root)`);
  lines.push("");
  if (workspace?.path) {
    lines.push(`- Root: \`${workspace.path}\``);
  } else {
    lines.push(`- Root: (no \`memory.workspace.path\` declared — declare one so host + workflow share a root)`);
  }
  if (workspace?.structure && workspace.structure.length > 0) {
    lines.push(`- Files: ${workspace.structure.map((s) => `\`${s}\``).join(", ")}`);
  }
  lines.push("");

  lines.push(`## Run order (who runs what)`);
  lines.push("");
  let step = 1;
  for (const p of allPhases) {
    if (wfSet.has(p)) {
      lines.push(`${step}. **Host launches \`${name}.workflow.js\`** for ${phaseLabel(p)} — the workflow agents read their \`reads\` paths (seeded by the host), do the work, write results to their \`writes\` paths. Host hooks observe those writes LIVE (the concurrent observability the workflow itself cannot express).`);
    } else {
      lines.push(`${step}. **Host (in-session)** runs ${phaseLabel(p)} — writes its outputs to the Blackboard so the next rung can read them.`);
    }
    step++;
  }
  if (human) {
    lines.push(`${step}. **Host** presents the Blackboard artifacts to the human \`${human.id}\`, who acts (e.g. promotes). Promotion triggers the SEPARATE downstream workflow (e.g. regression).`);
  }
  lines.push("");
  lines.push(`So for this topology, the workflow.js is just the **build rung**: the host seeds the inputs, launches it, and consumes \`build-report.md\` (and the other declared \`writes\`) for the downstream host verify + gate + ship-report.`);
  lines.push("");

  lines.push(`## Per-agent reads/writes (the workflow contract)`);
  lines.push("");
  lines.push(`Only the agents in the workflow-compiled phases (${phasesEmitted.join(", ") || "none"}) are listed; their reads/writes ARE the seam the host must honor when seeding inputs and consuming outputs.`);
  lines.push("");
  for (const a of agents) {
    if (!wfPhases.has(phaseOf(a))) continue;
    const reads = a.reads && a.reads.length ? a.reads.join(", ") : "—";
    const writes = a.writes && a.writes.length ? a.writes.join(", ") : "—";
    lines.push(`- **${a.id}** (phase ${phaseOf(a)}): reads [${reads}] → writes [${writes}]`);
  }
  lines.push("");
  lines.push(`> The host (claude-code binding) is responsible for materializing \`.claude/\`, running the non-workflow phases, and the hook scripts that observe these paths. This binding does NOT emit the host files — it only emits the workflow rung + this contract so the two agree.`);
  lines.push("");
  return { path: seamFiles.seamDoc(name), content: lines.join("\n"), category: "machine" };
}

/** Emit the LOSSY report listing every translation note. */
function generateLossyReport(ast: TopologyAST, ledger: LossLedger): GeneratedFile {
  const name = ast.topology.name;
  const lines: string[] = [];
  lines.push(`# ${name} — claude-workflow LOSSY / UNREPRESENTABLE Report`);
  lines.push("");
  lines.push(`Generated when compiling \`${name}.at\` → \`${name}.workflow.js\` (target: claude-workflow).`);
  lines.push("");
  lines.push(`This report lists **exactly** what changed in translation. Nothing is dropped silently. See \`docs/bindings/claude-workflow-mapping.md\` for the per-primitive classification.`);
  lines.push("");

  const unrep = ledger.notes.filter((n) => n.severity === "UNREPRESENTABLE");
  const lossy = ledger.notes.filter((n) => n.severity === "LOSSY");

  lines.push(`## UNREPRESENTABLE (${unrep.length}) — the Workflow runtime genuinely cannot express these`);
  lines.push("");
  if (unrep.length === 0) {
    lines.push(`_None._`);
  } else {
    for (const n of unrep) {
      lines.push(`### ${n.primitive} — \`${n.scope}\``);
      lines.push(n.reason);
      lines.push("");
    }
  }
  lines.push("");

  lines.push(`## LOSSY (${lossy.length}) — representable, but a property is lost`);
  lines.push("");
  if (lossy.length === 0) {
    lines.push(`_None._`);
  } else {
    for (const n of lossy) {
      lines.push(`### ${n.primitive} — \`${n.scope}\``);
      lines.push(n.reason);
      lines.push("");
    }
  }
  lines.push("");

  lines.push(`## The seam`);
  lines.push("");
  lines.push(`For phases marked \`execution: workflow\`, the host hands work off via the Blackboard (file-based). The host writes the task manifest to the \`workspace/\` paths; the workflow agents write results back; host hooks observe them live. The host \`.claude/\` files are emitted by the **claude-code** binding, NOT this one. The path contract both bindings honor is in \`${name}-SEAM.md\`.`);
  lines.push("");
  return { path: seamFiles.lossyDoc(name), content: lines.join("\n"), category: "machine" };
}

// ---------------------------------------------------------------------------
// Binding
// ---------------------------------------------------------------------------

export const claudeWorkflowBinding: BindingTarget = {
  name: "claude-workflow",
  description:
    "Claude Workflow tool — compiles the deterministic fan-out phases (execution: workflow) into a <topology>.workflow.js, plus the Blackboard seam contract and a loud LOSSY report. The embedded half of the hybrid host+workflow model.",

  scaffold(ast: TopologyAST): GeneratedFile[] {
    const ledger = new LossLedger();
    const files: GeneratedFile[] = [];

    const { file, humanNode, phasesEmitted } = generateWorkflowScript(ast, ledger);
    if (file) files.push(file);

    // Human-split README (UNREPRESENTABLE human boundary).
    if (humanNode) {
      files.push(generateHumanSplitReadme(ast, humanNode));
    }

    // Blackboard seam contract — always emit when a workflow was produced.
    if (file) {
      files.push(generateSeamDoc(ast, phasesEmitted));
    }

    // LOSSY report — always emit (even if empty, it documents the clean translation).
    files.push(generateLossyReport(ast, ledger));

    return deduplicateFiles(files);
  },
};
