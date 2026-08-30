/**
 * Google Antigravity binding.
 *
 * Generates a single `.agents/workflows/<topology>-autopilot.md` — Antigravity
 * reads one flat markdown file as its workflow config: a `## Core Directives`
 * list, numbered `### Phase N` sections, and role-assumption prose ("Assume
 * the `qa-engineer` role"). There is no runtime engine behind that file — no
 * hooks, no gate/event enforcement, no MCP, no compiled branching. An LLM
 * reads the markdown and interprets it at inference time.
 *
 * This binding is therefore a prose projector, closest in spirit to the
 * `codex` binding: no topological/graph-walk engine, no control-flow
 * compilation. Ordering comes from `agent.phase` (agents grouped into Phase
 * blocks by ascending phase number); conditional/loop edges and gates render
 * as plain-language steps, never as `if (...)` or shell scripts.
 *
 * @module
 */

import type {
  TopologyAST,
  AgentNode,
  ActionNode,
  GateNode,
  HumanNode,
  GroupNode,
  OrchestratorNode,
  EdgeDef,
} from "../parser/ast.js";
import { deduplicateFiles } from "./types.js";
import type { BindingTarget, GeneratedFile } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a kebab-case id to Title Case. */
function toTitle(id: string): string {
  return id
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Kebab-case slug safe for a filename (topology ids are already kebab-case). */
function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Read `extensions.antigravity`, checking both AST-level locations. */
function getTopologyExtensions(ast: TopologyAST): Record<string, unknown> | null {
  const settingsExt = ast.settings?.extensions as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (settingsExt?.antigravity) return settingsExt.antigravity;
  if (ast.extensions?.antigravity) return ast.extensions.antigravity as Record<string, unknown>;
  return null;
}

function isAgent(n: TopologyAST["nodes"][number]): n is AgentNode {
  return n.type === "agent";
}
function isAction(n: TopologyAST["nodes"][number]): n is ActionNode {
  return n.type === "action";
}
function isGate(n: TopologyAST["nodes"][number]): n is GateNode {
  return n.type === "gate";
}
function isHuman(n: TopologyAST["nodes"][number]): n is HumanNode {
  return n.type === "human";
}
function isGroup(n: TopologyAST["nodes"][number]): n is GroupNode {
  return n.type === "group";
}
function isOrchestrator(n: TopologyAST["nodes"][number]): n is OrchestratorNode {
  return n.type === "orchestrator";
}

// ---------------------------------------------------------------------------
// Frontmatter / title / intro
// ---------------------------------------------------------------------------

function buildFrontmatter(ast: TopologyAST): string {
  const description = ast.topology.description || `${toTitle(ast.topology.name)} autopilot workflow`;
  return `---\ndescription: ${description}\n---`;
}

function buildTitleAndIntro(ast: TopologyAST): string {
  const title = `${toTitle(ast.topology.name)} Workflow`;
  const intro = ast.topology.description
    ? `This workflow enforces a strict, sequential execution protocol for **${ast.topology.description}**.`
    : `This workflow enforces a strict, sequential execution protocol.`;
  return `# ${title}\n\n${intro}`;
}

// ---------------------------------------------------------------------------
// Core Directives
// ---------------------------------------------------------------------------

function maxGateRetry(gates: GateNode[]): number {
  const retries = gates.map((g) => g.retry).filter((r): r is number => typeof r === "number");
  return retries.length > 0 ? Math.max(...retries) : 3;
}

function buildCoreDirectives(ast: TopologyAST, gates: GateNode[]): string {
  const directives: string[] = [
    "**Never Skip Phases:** Proceed sequentially.",
    `**Fail Fast:** If compilation or tests fail and cannot be self-healed in ${maxGateRetry(
      gates
    )} loops, pause and ask the USER for help.`,
    "**No Direct Main Branch Commits:** Keep work isolated to feature branches.",
  ];

  const deny = (ast.settings?.deny as string[] | undefined) ?? [];
  const forceDeny = deny.find((d) => /push.*(-f\b|--force)/i.test(d));
  if (forceDeny) {
    directives[2] += ` (enforced topology-wide: \`${forceDeny}\` is denied)`;
  }
  const otherDeny = deny.filter((d) => d !== forceDeny);
  for (const d of otherDeny) {
    directives.push(`**Never run denied actions:** \`${d}\` is denied topology-wide.`);
  }

  const brainStore = ast.stores?.find((s) => s.type === "brain");
  if (brainStore) {
    const custodians = ast.nodes
      .filter(isAgent)
      .filter((a) => a.custodianOf && a.custodianOf.length > 0)
      .map((a) => a.id);
    if (custodians.length > 0) {
      directives.push(
        `**Preserve the Brain:** Route knowledge-graph writes only through the custodian agent(s): \`${custodians.join(
          "`, `"
        )}\`.`
      );
    }
  }

  return [
    "## Core Directives",
    ...directives.map((d, i) => `${i + 1}. ${d}`),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Fan-out / Swarm topology detection
// ---------------------------------------------------------------------------

function detectFanOut(edges: EdgeDef[]): { from: string; targets: string[] }[] {
  const byFrom = new Map<string, string[]>();
  for (const e of edges) {
    if (e.condition) continue; // conditional branching, not parallel fan-out
    const list = byFrom.get(e.from) ?? [];
    list.push(e.to);
    byFrom.set(e.from, list);
  }
  return Array.from(byFrom.entries())
    .filter(([, targets]) => targets.length > 1)
    .map(([from, targets]) => ({ from, targets }));
}

function renderSwarmTopologyChoice(ast: TopologyAST): string {
  const fanOuts = detectFanOut(ast.edges);
  const groups = ast.nodes.filter(isGroup);
  const lines: string[] = [
    "2. Choose the Swarm execution topology based on task complexity:",
    "   * **Leader→Workers**: Multi-part features (Design → Backend Code → Frontend Code).",
    "   * **Ensemble (Parallel Testing)**: Debugging a complex bug (formulate distinct hypotheses and test them).",
    "   * **Pipeline**: Sequential handoffs (Implement → QA tests → Polish).",
  ];
  for (const fo of fanOuts) {
    lines.push(`   * Parallel workers from \`${fo.from}\`: ${fo.targets.map((t) => `\`${t}\``).join(", ")}`);
  }
  for (const g of groups) {
    lines.push(
      `   * Ensemble group: \`${g.members.join("`, `")}\`, judged by ${
        g.speakerSelection ?? "majority"
      }.`
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Phase 1 / Phase 2 (fixed skeleton)
// ---------------------------------------------------------------------------

function buildExpandAnalyzePhase(ast: TopologyAST): string {
  const externalActions = ast.nodes.filter(isAction).filter((a) => a.kind === "external");
  const lines = ["### Phase 1: Expand & Analyze (Without modifying code)"];
  const steps: string[] = [];
  if (externalActions.length > 0) {
    for (const a of externalActions) {
      steps.push(
        `Fetch context: run \`${a.id}\` — ${a.description ?? "fetch external context"}${
          a.source ? ` (source: ${a.source})` : ""
        }.`
      );
    }
  } else {
    steps.push("Read the provided prompt thoroughly. Create a new git branch for this task.");
  }
  steps.push("Search and review the codebase.");
  steps.push(
    "Explicitly state assumptions if requirements are ambiguous. Do not ask the USER for clarification unless absolutely blocked."
  );
  lines.push(...steps.map((s, i) => `${i + 1}. ${s}`));
  return lines.join("\n");
}

function buildArchitectPlanPhase(ast: TopologyAST): string {
  const orchestrator = ast.nodes.find(isOrchestrator);
  const lines = ["### Phase 2: Architect & Plan (The Blueprint)"];
  const steps: string[] = [
    "Acting as an Architect, sketch the Data Model, Module boundaries, and Interface contracts.",
  ];
  lines.push(`1. ${steps[0]}`);
  lines.push(renderSwarmTopologyChoice(ast));
  lines.push("3. Size the work (Small/Medium/Large).");
  const signOffTier = orchestrator?.model ? ` (${orchestrator.model}-tier)` : "";
  lines.push(`4. Pause and request CTO-level sign-off${signOffTier} from the USER before moving to execution.`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Execute phases (dynamic core, grouped by agent.phase)
// ---------------------------------------------------------------------------

function groupAgentsByPhase(agents: AgentNode[]): Map<number, AgentNode[]> {
  const groups = new Map<number, AgentNode[]>();
  for (const a of agents) {
    const phase = a.phase ?? 1;
    const list = groups.get(phase) ?? [];
    list.push(a);
    groups.set(phase, list);
  }
  return new Map([...groups.entries()].sort(([a], [b]) => a - b));
}

/** Priority-ordered keyword → title map. "review" must precede "test" and
 * "security" — otherwise incidental substrings like "test coverage" inside a
 * *reviewer*'s description would mislabel a Review phase as Test. */
function matchPhaseKeyword(text: string): string | null {
  if (/\breview/.test(text)) return "Review";
  if (/\btest\b|\bqa\b/.test(text)) return "Test";
  if (/\bsecurity\b|\baudit/.test(text)) return "Security Verification";
  if (/\bbuild\b|\bimplement/.test(text)) return "Build & Integrate";
  if (/\bdeploy\b|\bship\b|\bdevops\b/.test(text)) return "Deploy";
  if (/\bplan\b/.test(text)) return "Planning";
  return null;
}

function derivePhaseTitle(agents: AgentNode[]): string {
  // Prefer an explicit "the <NAME> phase" marker (e.g. "— the BUILD phase"),
  // matched only against an ALL-CAPS phase word so a plain-English sentence
  // like "implements from the plan" can never be mistaken for a phase name.
  for (const a of agents) {
    const m = (a.description ?? "").match(/\bthe\s+([A-Z]{2,})\s+phase\b/);
    if (m) return toTitle(m[1].toLowerCase());
  }
  // Ids are intentional, short identifiers — check them first, since a full
  // description is far more likely to contain an incidental keyword collision
  // (e.g. "test coverage" inside a code-review agent's description).
  const idMatch = matchPhaseKeyword(agents.map((a) => a.id).join(" ").toLowerCase());
  if (idMatch) return idMatch;
  const text = agents
    .map((a) => `${a.role ?? ""} ${a.description ?? ""}`)
    .join(" ")
    .toLowerCase();
  return matchPhaseKeyword(text) ?? "Implementation";
}

function edgeProseFor(agentId: string, edges: EdgeDef[]): string[] {
  const lines: string[] = [];
  for (const e of edges) {
    if (e.to !== agentId) continue;
    if (e.condition) {
      let line = `Only proceed with this step if \`${e.condition}\`.`;
      if (e.maxIterations) {
        line = `Only proceed with this step if \`${e.condition}\` (max ${e.maxIterations} attempts before pausing for USER input).`;
      }
      lines.push(line);
    }
    if (e.isError) {
      lines.push(`On error${e.errorType ? ` (\`${e.errorType}\`)` : ""}, route back to \`${e.from}\` for correction.`);
    }
  }
  return lines;
}

function renderAgentBlock(agent: AgentNode, edges: EdgeDef[]): string {
  const lines: string[] = [];
  // `agent.role` is the RESOLVED prose from the `roles {}` block (not a short
  // id) — always assume the node's own `id` as the role name, and use
  // `description` (falling back to the resolved role prose) as the sentence.
  const description = agent.description ?? agent.role ?? "";
  lines.push(`Assume the \`${agent.id}\` role.${description ? ` ${description}` : ""}`);
  if (agent.model) lines.push(`   - Model: \`${agent.model}\``);
  if (agent.tools && agent.tools.length > 0) lines.push(`   - Allowed tools: ${agent.tools.join(", ")}`);
  if (agent.disallowedTools && agent.disallowedTools.length > 0)
    lines.push(`   - Disallowed tools: ${agent.disallowedTools.join(", ")}`);
  if (agent.permissions) lines.push(`   - Approval: \`${agent.permissions}\``);
  if (agent.reads && agent.reads.length > 0) lines.push(`   - Inputs: ${agent.reads.join(", ")}`);
  if (agent.writes && agent.writes.length > 0) lines.push(`   - Outputs (files): ${agent.writes.join(", ")}`);
  if (agent.outputs) {
    const entries = Object.entries(agent.outputs).map(
      ([k, v]) => `${k} = ${Array.isArray(v) ? v.join(" | ") : v}`
    );
    if (entries.length > 0) lines.push(`   - Reports: ${entries.join("; ")}`);
  }
  const proseEdges = edgeProseFor(agent.id, edges);
  for (const p of proseEdges) lines.push(`   - ${p}`);
  return lines.join("\n");
}

function isTurboPhase(agents: AgentNode[], ast: TopologyAST): boolean {
  const extAll = getTopologyExtensions(ast);
  if (extAll?.turboAll === true) return true;
  const allAutonomous = agents.every((a) =>
    ["autonomous", "unrestricted", "auto", "bypassPermissions"].includes(a.permissions ?? "")
  );
  const anyExplicitTurbo = agents.some((a) => a.extensions?.antigravity?.turbo === true);
  return anyExplicitTurbo || allAutonomous;
}

// ---------------------------------------------------------------------------
// Test & Verify / Validate & Self-Heal / Report & Ship (fixed tail)
// ---------------------------------------------------------------------------

function buildTestVerifyPhase(ast: TopologyAST, phaseNum: number, gates: GateNode[]): string {
  const agents = ast.nodes.filter(isAgent);
  const testAgent = agents.find((a) => /test|qa/i.test(`${a.role ?? ""} ${a.description ?? ""}`));
  const roleId = testAgent?.id ?? "qa-engineer";
  const testChecks = gates.flatMap((g) => g.checks ?? []).filter((c) => /test/i.test(c));
  const lines = [
    `### Phase ${phaseNum}: Test & Verify`,
    `1. Assume the \`${roleId}\` role.`,
    "2. Run project test suites. If new functionality was added, write unit tests aiming for high coverage. Check edge cases.",
  ];
  if (testChecks.length > 0) {
    lines.push(`3. Confirm these checks pass: ${testChecks.join(", ")}.`);
  }
  return lines.join("\n");
}

function buildValidateSelfHealPhase(phaseNum: number, gates: GateNode[]): string {
  const lines = [`### Phase ${phaseNum}: Validate (Quality Gates & Self-Healing)`];
  const steps: string[] = ["Run syntax/type checking locally."];
  const heal = maxGateRetry(gates);
  steps.push(`If checks fail, enter the **Self-Healing Loop**: attempt to fix automatically (max ${heal} cycles).`);
  for (const g of gates) {
    const parts: string[] = [
      `Gate \`${g.id}\` (after \`${g.after ?? "?"}\`${g.before ? `, before \`${g.before}\`` : ""})`,
    ];
    if (g.run) parts.push(`run \`${g.run}\``);
    if (g.checks && g.checks.length > 0) parts.push(`checks: [${g.checks.join(", ")}]`);
    let onFail: string;
    if (g.behavior === "advisory") {
      onFail = "Advisory — log and continue, do not block.";
    } else if (g.onFail === "bounce-back") {
      onFail = `If it fails, return to \`${g.after ?? "the previous step"}\` and retry (up to ${
        g.retry ?? heal
      } times).`;
    } else {
      onFail = `If unresolved after ${g.retry ?? heal} cycles, HALT and ask the USER.`;
    }
    steps.push(`${parts.join("; ")}. ${onFail}`);
  }
  steps.push("Assume the `security-auditor` role to ensure no hard-coded secrets or exposed unauthenticated routes exist.");
  lines.push(...steps.map((s, i) => `${i + 1}. ${s}`));
  return lines.join("\n");
}

function buildReportShipPhase(ast: TopologyAST, phaseNum: number): string {
  const brainStore = ast.stores?.find((s) => s.type === "brain");
  const custodians = brainStore
    ? ast.nodes.filter(isAgent).filter((a) => a.custodianOf && a.custodianOf.length > 0).map((a) => a.id)
    : [];
  const humans = ast.nodes.filter(isHuman);
  const lines = [
    `### Phase ${phaseNum}: Report & Ship`,
    "1. Generate a standardized shipping summary in your response:",
    "   * **Assumptions Made:**",
    "   * **What Was Built:** (Files changed)",
    "   * **Quality Gates Passed:** (Yes/No, with the commands that were run)",
    "   * **Time Spent Analysis:**",
  ];
  if (custodians.length > 0) {
    lines.push(`   * **Brain Updates:** routed through \`${custodians.join("`, `")}\``);
  }
  let step = 2;
  for (const h of humans) {
    const desc = (h.description ?? "obtain human approval").replace(/\.\s*$/, "");
    const timeout = h.timeout ? ` Wait up to ${h.timeout} for a response` : " Wait for approval before continuing";
    const onTimeout = h.onTimeout ? `; on timeout: ${h.onTimeout}` : "";
    lines.push(`${step}. Pause for human review: ${desc}.${timeout}${onTimeout}.`);
    step++;
  }
  lines.push(`${step}. Remind the USER how to rollback via \`git restore\` or \`git reset\` if necessary.`);
  return lines.join("\n");
}

function buildUnrepresentableNote(ast: TopologyAST): string | null {
  const dropped: string[] = [];
  if (ast.hooks && ast.hooks.length > 0) {
    dropped.push(`hooks (\`${ast.hooks.map((h) => h.name).join("`, `")}\`)`);
  }
  const mcpNames = Object.keys(ast.mcpServers ?? {});
  if (mcpNames.length > 0) {
    dropped.push(`MCP servers (\`${mcpNames.join("`, `")}\`)`);
  }
  const groups = ast.nodes.filter(isGroup);
  if (groups.length > 0) {
    // Groups are folded into Swarm-topology prose already — not dropped.
  }
  if (dropped.length === 0) return null;
  return `> Note: this topology also declares ${dropped.join(" and ")} that Antigravity's markdown-workflow format cannot express; configure them directly in the Antigravity IDE if needed.`;
}

// ---------------------------------------------------------------------------
// Top-level assembly
// ---------------------------------------------------------------------------

function buildAutopilotFile(ast: TopologyAST): GeneratedFile {
  const gates = ast.nodes.filter(isGate);
  const agents = ast.nodes.filter(isAgent);
  const phaseGroups = groupAgentsByPhase(agents);

  // Frontmatter's own closing `---` already divides it from the title/intro,
  // so those two are merged into one section — otherwise the section-join
  // separator below would print a second, redundant `---` right after it.
  const introBlock = [buildFrontmatter(ast), "", buildTitleAndIntro(ast)].join("\n");

  const sections: string[] = [
    introBlock,
    buildCoreDirectives(ast, gates),
    buildExpandAnalyzePhase(ast),
    buildArchitectPlanPhase(ast),
  ];

  // Dynamic Execute phases, inline (not via the placeholder helper above).
  let phaseNum = 3;
  for (const [, phaseAgents] of phaseGroups) {
    const title = derivePhaseTitle(phaseAgents);
    const header = `### Phase ${phaseNum}: Execute — ${title}`;
    const turbo = isTurboPhase(phaseAgents, ast);
    const lines = [header];
    if (turbo) lines.push("// turbo-all");
    const stepLines: string[] = [];
    phaseAgents.forEach((agent, idx) => {
      const block = renderAgentBlock(agent, ast.edges);
      if (idx === 0) {
        stepLines.push(block);
      } else {
        const [first, ...rest] = block.split("\n");
        const lowered = `In parallel, ${first.charAt(0).toLowerCase()}${first.slice(1)}`;
        stepLines.push([lowered, ...rest].join("\n"));
      }
    });
    const allFiles = Array.from(
      new Set(phaseAgents.flatMap((a) => [...(a.reads ?? []), ...(a.writes ?? [])]))
    );
    stepLines.push(
      `Track critical files before modifying them:${
        allFiles.length > 0 ? ` ${allFiles.join(", ")}` : " (none declared)"
      }`
    );
    stepLines.push(
      "Run necessary build scripts after every major module implementation to verify everything compiles."
    );
    lines.push(...stepLines.map((s, i) => `${i + 1}. ${s}`));
    sections.push(lines.join("\n"));
    phaseNum++;
  }

  sections.push(buildTestVerifyPhase(ast, phaseNum, gates));
  phaseNum++;
  sections.push(buildValidateSelfHealPhase(phaseNum, gates));
  phaseNum++;
  sections.push(buildReportShipPhase(ast, phaseNum));

  const note = buildUnrepresentableNote(ast);
  if (note) sections.push(note);

  const content = sections.join("\n\n---\n\n") + "\n";
  const path = `.agents/workflows/${slug(ast.topology.name)}-autopilot.md`;

  return { path, content, category: "agent" };
}

// ---------------------------------------------------------------------------
// Binding export
// ---------------------------------------------------------------------------

export const antigravityBinding: BindingTarget = {
  name: "antigravity",
  description:
    "Google Antigravity IDE — generates a single .agents/workflows/<name>-autopilot.md flat workflow file with numbered Phases and role-assumption prose.",
  scaffold(ast: TopologyAST): GeneratedFile[] {
    return deduplicateFiles([buildAutopilotFile(ast)]);
  },
};
