# antigravity Binding — Primitive Mapping (.at → Google Antigravity)

**Status:** implemented, `src/bindings/antigravity.ts`. Antigravity's config is a
single flat `.agents/workflows/<name>-autopilot.md` file — a `## Core
Directives` list, numbered `### Phase N` sections, `// turbo-all` auto-run
markers, and role-assumption prose ("Assume the `qa-engineer` role"). There is
no runtime behind that file: no hooks, no gate/event enforcement, no MCP, no
compiled branching. An LLM reads the markdown and interprets it at inference
time — so this binding is a **prose projector**, not a compiler.

---

## TL;DR — the three classes

- **CLEAN** (maps 1:1, as prose): `agent.phase` (drives Phase grouping),
  `agent.role`/`description` (phase title + prose), `agent.model`,
  `agent.tools`/`disallowedTools`, `agent.permissions` (printed verbatim, no
  enum mapping needed), `agent.reads`/`writes` (Inputs/Outputs bullets),
  `agent.outputs` (status-enum bullet), `roles` block, `topology.description`,
  `orchestrator.model`/`handles`/`generates`, `action` nodes (Phase-1
  sub-steps), `settings.deny` (feeds Core Directives).
- **LOSSY** (representable, but the enforcement is gone): `edge.condition` /
  `edge.maxIterations` / `edge.isError` → prose ("Only proceed with this step
  if …", "max N attempts") — no actual branching, an LLM decides at read time;
  fan-out (multiple edges sharing a `from`) → "Choose the Swarm topology"
  prose (Leader→Workers / Ensemble / Pipeline), not a real scheduler;
  `GateNode` (`checks`/`retry`/`onFail`/`behavior`) → a Self-Healing Loop
  checklist, no automated re-invocation; `GroupNode` → Ensemble prose, no live
  turn-taking; `stores` of `type: brain` + `custodianOf` → one Core Directive
  line, no write-routing enforcement; `HumanNode` → a "pause for review" step
  with best-effort timeout/onTimeout prose, no actual wait/interrupt.
- **UNREPRESENTABLE** (dropped to a terse note, at best): `HookDef`/`hooks`
  (no pre/post event bus in a markdown consumer), `mcpServers` (no MCP runtime
  reachable from a prose file), `inputSchema`/`outputSchema` (no schema
  validation layer), `circuitBreaker`, `scale`, most session-level knobs
  (`retry` beyond gate retry, `fallbackChain`, `sandbox`, `maxTurns`,
  `temperature`/`topP`/`topK`/`seed`/`thinking*`), `schedules`/`triggers`/
  `interfaces` (no cron/ingress runtime), `memory.retrievals`, `providers`/
  `env` (session-fixed, not expressible per-agent in a shared instruction
  file).

## The load-bearing runtime constraints (why things are lossy)

- **`NO_COMPILED_CONTROL_FLOW`** — the output is prose, not code. An LLM
  reading `.agents/workflows/<name>-autopilot.md` interprets "If X, proceed…"
  at inference time; there is no `if (...)`, no scheduler, no branch table.
  Conditionals, loops, and fan-out all degrade to natural-language steps.
- **`NO_RUNTIME_ENFORCEMENT`** — gates and hooks are advisory. A gate's
  `checks`/`onFail` become a checklist the agent reading the file is *trusted*
  to actually run and honor (mirroring the "Self-Healing Loop, max N cycles"
  phrasing of the real Antigravity workflow format); nothing blocks a tool
  call the way a `PreToolUse` hook would in an event-driven host.
- **`SINGLE_FILE_NO_SIDECARS`** — the binding emits exactly one file, no
  `scripts/`, no sidecar `settings.json`/`.mcp.json`. Anything that would
  normally live in a sidecar config (permissions, MCP servers, env) has no
  home here and is either folded into prose (permissions) or dropped to the
  trailing note (MCP servers, hooks).

## Forward mapping (every primitive this binding touches)

`topology.name`/`description` → frontmatter `description:` + `# <Title>
Workflow` + intro sentence (CLEAN). `orchestrator` → folded into Phase 2
("Architect & Plan") as the planning voice + CTO-sign-off tier, from
`model`/`handles`/`generates` (LOSSY — no `delegation` mode distinction).
`agent.phase` → groups agents into `### Phase N: Execute — <title>` blocks,
ascending, missing `phase` defaults to `1` (CLEAN, the core ordering
primitive — no graph-walk, exactly like `codex.ts`). `agent.role`/
`description` → role-assumption sentence, always keyed by `agent.id` (the
`role` field holds *resolved* prose from the `roles {}` block, not a short
name, so id is used for "Assume the `<id>` role" while role/description
supply the sentence). `agent.model`/`tools`/`disallowedTools`/`permissions`/
`reads`/`writes`/`outputs` → prose bullets under the agent's step (CLEAN).
`agent.custodianOf` + a `brain` store → one Core Directive line naming the
custodian(s) (LOSSY — no write-routing enforcement). `edge.condition` /
`maxIterations` / `isError` → "Only proceed with this step if `<condition>`
(max N attempts …)" / "On error (`<type>`), route back to `<from>`" (LOSSY).
Fan-out (`ast.edges` grouped by `.from`, >1 target, no `condition`) → the
"Choose the Swarm execution topology" bullet list, with concrete "Parallel
workers: X, Y, Z" lines (LOSSY). `GroupNode` → an "Ensemble" bullet naming
`members` + `speakerSelection` (LOSSY). `GateNode` → a Validate-phase
checklist line: `after`/`before`/`run`/`checks`, then a sentence keyed on
`onFail`/`behavior` (`advisory` → "log and continue"; `bounce-back` → "return
to `<after>` and retry"; default → "HALT and ask the USER") (LOSSY — no
runtime halt). `HumanNode` → a "Pause for human review: `<description>`. Wait
[up to `<timeout>`|for approval]…[; on timeout: `<onTimeout>`]." step in
Report & Ship (LOSSY). `settings.deny` → reinforces the "No Direct Main
Branch Commits" directive when a force-push pattern is present, plus one
"Never run denied actions" bullet per remaining entry (CLEAN, best-effort
text match). `hooks` / `mcpServers` → named in a single trailing `> Note:`
blockquote if present, otherwise omitted entirely (UNREPRESENTABLE).
`extensions.antigravity.turbo` (per-agent) / `.turboAll` (topology-level) →
the `// turbo-all` marker under a Phase header, else derived from whether
every agent in the phase is `autonomous`/`unrestricted`/`auto`/
`bypassPermissions` (LOSSY heuristic, overridable).

## Binding design — what `scaffold(ast)` emits

Exactly **one** `GeneratedFile`: `.agents/workflows/<slug(topology.name)>-
autopilot.md`, `category: "agent"`. The file is a fixed rhetorical skeleton
(Core Directives → Phase 1 Expand & Analyze → Phase 2 Architect & Plan →
[N dynamic Execute phases, one per distinct `agent.phase`] → Test & Verify →
Validate & Self-Heal → Report & Ship), with the Execute middle sized to
however many phase buckets the topology actually declares — never dropping an
agent, never inventing phases that don't exist in the AST. No companion
scripts are emitted; gate/tool `run` paths are referenced in prose only, one
step past `codex.ts`'s honest "Enforcement: script-level — run manually"
degradation. A topology with no hooks/MCP/schemas/circuit-breakers gets no
trailing note at all — the note only appears when there is something genuine
to disclose as dropped.
