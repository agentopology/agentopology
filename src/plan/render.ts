/**
 * Renders an {@link ExecutionBrief} as the Markdown document a host coding
 * agent executes.
 *
 * The document is a program, not documentation. Section numbers and headings
 * are fixed, and every section is emitted even when empty — an empty section
 * is information ("no MCP servers declared") rather than an omission the host
 * has to interpret.
 *
 * @module
 */

import type { ExecutionBrief, GateTier, RoleCard } from "./brief.js";

const TIER_NOTE: Record<GateTier, string> = {
  preventive: "tool allowlist — needs a file, unavailable here",
  enforced: "hook exit 2 — needs a file, unavailable here",
  "fileless-verify": "Workflow script — Claude Code only",
  "evidence-orchestrator": "you run the command and read the exit code",
  "evidence-agent": "the agent runs it and reports the exit code",
  advisory: "declared advisory — record the result, never block",
};

function fence(body: string): string {
  return ["~~~", body, "~~~"].join("\n");
}

function rolePrompt(brief: ExecutionBrief, role: RoleCard): string {
  const lines: string[] = [];
  lines.push("TASK CONTEXT");
  lines.push(brief.task ?? "{{TASK}}");
  lines.push("");
  lines.push(`You are \`${role.id}\` in the topology \`${brief.topology}\`.`);
  lines.push("");
  lines.push("ROLE");
  lines.push(role.role);

  if (role.prompt) {
    lines.push("");
    lines.push("INSTRUCTIONS");
    lines.push(role.prompt);
  }

  if (role.readsAbs.length) {
    lines.push("");
    lines.push("INPUTS — read exactly these paths. They are absolute; use them as given.");
    for (const r of role.readsAbs) lines.push(`  ${r}`);
  }

  if (role.writesAbs.length) {
    lines.push("");
    lines.push("OUTPUTS — write exactly these paths. They are absolute; use them as given.");
    for (const w of role.writesAbs) lines.push(`  ${w}`);
  }

  if (role.blindTo.length) {
    lines.push("");
    lines.push("ISOLATION");
    lines.push(
      `${role.blindTo.join(" and ")} ${role.blindTo.length > 1 ? "are" : "is"} running right now on the same task. ` +
        "You must not read, ask for, or speculate about that work."
    );
  }

  if (role.mustNotReadAbs.length) {
    lines.push("");
    lines.push("WITHHELD — an upstream role wrote these and they are on disk. You must");
    lines.push("not read them, and must not ask for their contents:");
    for (const w of role.mustNotReadAbs) lines.push(`  ${w}`);
    lines.push("");
    lines.push("This is deliberate. If you find yourself wanting one, that is the signal");
    lines.push("the design is protecting — say so in your reply rather than reading it.");
  }

  if (role.declaredTools?.length) {
    lines.push("");
    lines.push("TOOL POLICY — DECLARED BUT NOT ENFORCED");
    lines.push(
      `This role declares tools: [${role.declaredTools.join(", ")}]. The host cannot ` +
        "restrict your tools at runtime. Confine yourself to them as a matter of contract."
    );
  }

  const keys = Object.keys(role.outputs);
  lines.push("");
  lines.push("RETURN PROTOCOL");
  lines.push("End your reply with exactly one fenced block, and nothing after it:");
  lines.push("");
  lines.push("```at-output");
  for (const k of keys) lines.push(`${k}: <${role.outputs[k].join("|")}>`);
  for (const w of role.writesAbs) lines.push(`wrote: ${w}`);
  if (!keys.length && !role.writesAbs.length) lines.push("done: yes");
  lines.push("```");

  return lines.join("\n");
}

/**
 * Render the brief.
 *
 * @param brief - A structure from `buildExecutionBrief`.
 * @returns The Markdown document, with no trailing newline.
 */
export function renderBriefMarkdown(brief: ExecutionBrief): string {
  const L: string[] = [];

  L.push("---");
  L.push("brief: agentopology/v1");
  L.push(`topology: ${brief.topology}@${brief.version}`);
  L.push(`source: ${brief.source}`);
  L.push(`root: ${brief.root}`);
  if (brief.revision) L.push(`revision: ${brief.revision}`);
  L.push(`autonomy: ${brief.autonomy}`);
  if (brief.ambiguityLog) L.push(`ambiguity-log: ${brief.ambiguityLog}`);
  L.push("---");
  L.push("");

  if (brief.errors.length) {
    L.push("# ⛔ DO NOT ENACT — the topology does not validate");
    L.push("");
    for (const e of brief.errors) {
      L.push(`- **[${e.rule}]** ${e.node ? `\`${e.node}\`: ` : ""}${e.message}`);
    }
    L.push("");
    L.push("Fix the source file and re-run `agentopology plan`.");
    return L.join("\n");
  }

  // §0 -----------------------------------------------------------------
  L.push("# §0 — Enactment loop");
  L.push("");
  L.push("You are the interpreter for this brief. It is a program, not documentation.");
  L.push("");
  L.push("1. Adopt the autonomy notch in §1. It governs every announcement below.");
  L.push("2. Verify §2's preconditions. If a run input is missing, stop and ask.");
  L.push("3. Walk §2's step table **strictly in order**. Before each step print one line:");
  L.push(`   \`[${brief.topology}] step N/${brief.steps.length} — <id> — <kind>\`.`);
  L.push("   Print it under **every** notch, `auto` included.");
  L.push("4. For a step with two or more roles, issue **all Agent calls in a single");
  L.push("   message** before reading any result. This is not an optimisation — it is");
  L.push("   how §4's isolation is enforced. If you have not yet seen a sibling's");
  L.push("   output when you compose its neighbour's prompt, you cannot leak it.");
  L.push("5. Spawn with the role card's parameters and its prompt verbatim. The task");
  L.push("   text is in §1b — it is already substituted into each prompt unless the");
  L.push("   prompt still shows a literal `{{TASK}}`, in which case put the user's");
  L.push("   request there. You may change nothing else in a prompt.");
  L.push("   `name` is a CONVENIENCE, not a requirement. Some hosts reject it (\"Teammates");
  L.push("   cannot spawn other teammates\"). If a spawn is rejected for `name`, drop it");
  L.push("   and re-dispatch — do not treat that as a failed step.");
  L.push("6. Extract each reply's ```at-output``` block. Resolve each declared output:");
  L.push("   **T1 contract** (key present, value in enum) → **T2 scan** (find enum tokens");
  L.push("   in the reply; exactly one distinct token wins) → **T3 infer** (you decide).");
  L.push("   Log T2 and T3. **If T3 fires on the FIRST subagent of the run, stop and ask**");
  L.push("   regardless of notch — that subagent is the canary for whether this host");
  L.push("   honours the protocol at all.");
  L.push("7. Run gates per §7. Route per §5. Decrement loop budgets per §6.");
  L.push("8. Close with: steps run · roles spawned · outputs resolved (by contract / by");
  L.push("   scan / by inference) · gate exit codes · loop traversals used · one line per");
  L.push("   ambiguity recorded, with its `fix:`.");
  L.push("");
  if (brief.revision) {
    L.push(
      `The source tree was at \`${brief.revision}\` when this brief was built. If it moved ` +
        "under you mid-run, say so — a role may have read a file that has since changed."
    );
    L.push("");
  }

  // §1 -----------------------------------------------------------------
  L.push("# §1 — Run contract");
  L.push("");
  L.push(`Notch for this run: **${brief.autonomy}**.`);
  L.push("");
  L.push("| notch | before the run | material rewrite | ambiguity |");
  L.push("|---|---|---|---|");
  L.push("| plan | show this brief, wait for a word | show diff, wait | ask |");
  L.push("| execute | run | announce, proceed | announce, proceed |");
  L.push("| auto | run | silent, report at end | record only |");
  L.push("");
  if (brief.orchestrator) {
    L.push(
      `The orchestrator \`${brief.orchestrator}\` is **you**. Do not spawn it as a subagent.`
    );
    L.push("");
  }

  // §1b ----------------------------------------------------------------
  L.push("# §1b — Run inputs");
  L.push("");
  L.push(`**Root.** Every path in this brief is absolute, resolved against \`${brief.root}\`.`);
  L.push("Use them exactly as written. Do not re-resolve them against your own working");
  L.push("directory — sibling roles that normalise the same relative path differently");
  L.push("break the handoff in §4 silently.");
  L.push("");
  if (brief.task) {
    L.push("**Task.** This is what the run is for. It is already substituted into every");
    L.push("role prompt below:");
    L.push("");
    L.push("> " + brief.task.split("\n").join("\n> "));
  } else {
    L.push("**Task.** None was given to `plan`, so role prompts carry a literal");
    L.push("`{{TASK}}`. Substitute the user's actual request there before spawning, and");
    L.push("use the same text for every role — they are working on one task, not several.");
    L.push("Pass `--task \"...\"` to have `plan` bake it in instead.");
  }
  L.push("");

  // §2 -----------------------------------------------------------------
  L.push("# §2 — Execution order");
  L.push("");
  if (brief.preconditions.length) {
    L.push("Preconditions — read by a role but produced by none, so they must exist first.");
    L.push("Checked on disk at plan time:");
    L.push("");
    for (const p of brief.preconditions) {
      L.push(`  ${p.exists ? "✅" : "⛔ MISSING"}  ${p.absolute}`);
    }
    const missing = brief.preconditions.filter((p) => !p.exists);
    if (missing.length) {
      L.push("");
      L.push(
        `**${missing.length} run input(s) do not exist.** Stop and ask before step 1 — ` +
          "the first role to need one will fail, and it will fail late."
      );
    }
    L.push("");
  } else {
    L.push("No preconditions — every declared input is produced inside the run.");
    L.push("");
  }
  L.push("| step | kind | id(s) | depth |");
  L.push("|---|---|---|---|");
  for (const s of brief.steps) {
    const note = s.ids.length > 1 ? " *(parallel, mutually blind)*" : "";
    L.push(
      `| ${s.index} | ${s.kind} | \`${s.ids.join("`, `")}\`${note} | ${s.depth ?? "spliced"} |`
    );
  }
  L.push("");

  // §3 -----------------------------------------------------------------
  L.push("# §3 — Role cards");
  L.push("");
  L.push(
    brief.task
      ? "Spawn parameters, then the prompt verbatim. The task is already substituted — change nothing."
      : "Spawn parameters, then the prompt verbatim. Substitute the task where the prompt shows a placeholder; change nothing else."
  );
  L.push("");
  for (const role of brief.roles) {
    L.push(`### \`${role.id}\``);
    L.push("");
    L.push("| param | value |");
    L.push("|---|---|");
    L.push("| `subagent_type` | `general-purpose` |");
    L.push(`| \`name\` | \`${role.id}\` — optional; drop it if the host rejects it |`);
    L.push(`| \`model\` | ${role.model ? `\`${role.model}\`` : "— (inherit)"} |`);
    L.push(`| \`isolation\` | ${role.isolation ? `\`${role.isolation}\`` : "—"} |`);
    L.push("");
    L.push(fence(rolePrompt(brief, role)));
    L.push("");
  }

  // §4 -----------------------------------------------------------------
  L.push("# §4 — Handoffs and isolation");
  L.push("");
  L.push("`passes` = writer's `writes` ∩ reader's `reads`. `withholds` = the rest of the");
  L.push("writer's `writes`. Both computed from one intersection, so they cannot drift.");
  L.push("");
  if (brief.handoffs.length) {
    L.push("| edge | passes | withholds |");
    L.push("|---|---|---|");
    for (const h of brief.handoffs) {
      const warn = h.passes.length === 0 ? " ⚠ **nothing declared crosses**" : "";
      L.push(
        `| \`${h.from} → ${h.to}\` | ${h.passes.map((p) => `\`${p}\``).join(", ") || "—"}${warn} | ${h.withholds.map((p) => `\`${p}\``).join(", ") || "—"} |`
      );
    }
  } else {
    L.push("No agent-to-agent edges.");
  }
  L.push("");
  if (brief.blindPairs.length) {
    L.push("Mutually blind — same step, no edge between them:");
    L.push("");
    for (const p of brief.blindPairs) L.push(`- step ${p.step}: \`${p.a}\` ⟂ \`${p.b}\``);
    L.push("");
  }

  // §5 -----------------------------------------------------------------
  L.push("# §5 — Routing");
  L.push("");
  if (brief.routes.length) {
    for (const r of brief.routes) {
      L.push(`**On \`${r.from}.${r.key}\`:**`);
      L.push("");
      L.push("| condition | go to | budget |");
      L.push("|---|---|---|");
      for (const e of r.edges) {
        L.push(
          `| \`${e.condition}\` | \`${e.to}\` | ${e.maxIterations ? `max ${e.maxIterations}` : "—"} |`
        );
      }
      L.push("");
    }
    L.push("If no condition matches at runtime, log `route-unmatched` and stop. Never guess.");
  } else {
    L.push("No conditional edges — the order in §2 is the whole control flow.");
  }
  L.push("");

  // §6 -----------------------------------------------------------------
  L.push("# §6 — Loops");
  L.push("");
  if (brief.loops.length) {
    L.push("| back-edge | condition | budget | note |");
    L.push("|---|---|---|---|");
    for (const l of brief.loops) {
      const note = l.budget
        ? `\`max ${l.budget}\` bounds TRAVERSALS, so \`${l.to}\` runs at most ${l.budget + 1} times`
        : "⚠ unbounded — V6 should have caught this";
      L.push(`| \`${l.from} → ${l.to}\` | \`${l.condition ?? "—"}\` | ${l.budget ?? "∞"} | ${note} |`);
    }
    L.push("");
    L.push("A re-spawned role is a **fresh context**. Tell it which attempt it is on and");
    L.push("where the previous verdict lives. On exhaustion, take the other outgoing edge");
    L.push("and log `loop-budget-exhausted`.");
  } else {
    L.push("No loops.");
  }
  L.push("");

  // §7 -----------------------------------------------------------------
  L.push("# §7 — Gates");
  L.push("");
  if (brief.gates.length) {
    L.push("| gate | after | tier | mechanism | blocking |");
    L.push("|---|---|---|---|---|");
    for (const g of brief.gates) {
      L.push(
        `| \`${g.id}\` | ${g.after ? `\`${g.after}\`` : "—"} | ${g.tier} | ${TIER_NOTE[g.tier]} | ${g.blocking ? `yes · on-fail: ${g.onFail}` : "no"} |`
      );
    }
    L.push("");
    for (const g of brief.gates) {
      if (g.run) L.push(`- \`${g.id}\`: run \`${g.run}\` and record the exit code.`);
    }
    L.push("");
    L.push("Tiers 1 and 2 (tool allowlist, hook exit 2) both need files and are unreachable");
    L.push("in interpreted mode. The evidence contract is the strongest portable tier: a");
    L.push("skipped check is **visible** as missing evidence rather than a silent pass.");
  } else {
    L.push("No gates declared.");
  }
  L.push("");

  // §8 -----------------------------------------------------------------
  L.push("# §8 — Declared but not enforceable");
  L.push("");
  L.push("The Agent tool accepts only `subagent_type`, `model`, `isolation`, `prompt`,");
  L.push("`name`. Everything below was declared and cannot be imposed at runtime. Each is");
  L.push("restated inside the relevant prompt as a contract.");
  L.push("");
  if (brief.unenforceable.length) {
    L.push("| role | declared | consequence |");
    L.push("|---|---|---|");
    for (const u of brief.unenforceable) {
      L.push(
        `| \`${u.node}\` | \`${u.field}: ${JSON.stringify(u.declared)}\` | runs unrestricted |`
      );
    }
  } else {
    L.push("Nothing — every role runs with the host's default capability.");
  }
  L.push("");

  // §9 -----------------------------------------------------------------
  L.push("# §9 — Present but needs `scaffold`");
  L.push("");
  L.push("Five features are platform **registrations**, not steps in a run. They cannot");
  L.push("work fileless on any vendor.");
  L.push("");
  L.push("| feature | declared |");
  L.push("|---|---|");
  const all = [
    "triggers / slash commands",
    "schedules / cron",
    "mcp-servers",
    "hooks",
    "per-agent tools / permissions",
  ];
  const found = new Map(brief.persistent.map((p) => [p.feature, p.count]));
  for (const f of all) L.push(`| ${f} | ${found.get(f) ?? "none"} |`);
  L.push("");
  if (brief.persistent.length) {
    L.push(
      `**${brief.persistent.length} of 5 present.** Run \`agentopology scaffold ${brief.source}\` if these must bind.`
    );
  } else {
    L.push("None present — this topology runs fully fileless.");
  }
  L.push("");

  // §10 ----------------------------------------------------------------
  L.push("# §10 — Ambiguity log");
  L.push("");
  if (brief.ambiguityLog) {
    L.push(`Append one JSON object per line to \`${brief.ambiguityLog}\`.`);
  } else {
    L.push("No log path was given. Hold records in context and print them in the closing report.");
  }
  L.push("");
  L.push(
    "Session scratchpad only. Never write it into the repo, never append to a shared or global log."
  );
  L.push("");
  L.push("Fields: `ts` · `run` · `kind` · `at` · `question` · `chose` · `alternatives` ·");
  L.push("`confidence` · **`fix`** — a concrete `.at` edit. `fix` is the payoff: with it the");
  L.push("log is a patch queue for the source topology; without it, a diary.");
  L.push("");
  if (brief.preflagged.length) {
    L.push("**Pre-identified — the planner already knows these need a guess. Record each at**");
    L.push("**the moment it occurs, filling in `chose`.**");
    L.push("");
    for (const p of brief.preflagged) {
      L.push(`- **\`${p.kind}\`** (§${p.at.section}${p.at.node ? `, \`${p.at.node}\`` : ""}${p.at.edge ? `, \`${p.at.edge}\`` : ""})`);
      L.push(`  - ${p.question}`);
      L.push(`  - alternatives: ${p.alternatives.map((a) => `_${a}_`).join(" · ")}`);
      L.push(`  - fix: \`${p.fix}\``);
    }
  } else {
    L.push("Nothing pre-identified. Log any guess you make during the run.");
  }

  if (brief.defaultsApplied.length) {
    L.push("");
    L.push("---");
    L.push("");
    L.push(
      `_${brief.defaultsApplied.length} field(s) were never authored and took their value from the spec's defaults table (\`spec/grammar.md\` §7)._`
    );
  }

  return L.join("\n");
}
