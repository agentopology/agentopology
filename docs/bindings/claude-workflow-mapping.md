# claude-workflow Binding — Bidirectional Mapping (.at ↔ Claude Workflow)

**Status:** research synthesis, 2026-05-30. The spec for the `claude-workflow`
BindingTarget. Produced by parallel research over `spec/grammar.md` (all ~29
primitives) + the Claude Workflow tool capability surface (via claude-code-guide).

> The pattern/round-trip-fidelity layer (Blackboard, map-reduce,
> observability-as-listener, the concurrent-listener test case) is a SEPARATE
> research pass folded in below once complete. This doc is the PRIMITIVE mapping.

---

## TL;DR — the three classes

- **CLEAN** (maps 1:1): `agent` core, `outputs`/`schemas` → `schema` option (the strongest fit), `isolation:worktree`, `roles` (prompt injection), `context`→CLAUDE.md, `extensions` (own namespace).
- **LOSSY** (representable with effort): `topology`, `orchestrator`, `flow` (the heart — DAG reconstructed imperatively), `gate`, `agent.scale`, `batch` (best advanced fit → two-wave), `memory.workspace`, `metering`, `observability`, `params`, `triggers`, `env`, `group` (debate→rounds of parallel), `behavior:advisory`, `retry`, `skip`, `background`, `join`, `depth`, `skill`, `mcp-servers`, `tools` (static).
- **UNREPRESENTABLE** (runtime can't): `human` (→ FORCES workflow split), `hooks` (no pre/post event bus), `permissions`/`settings`/`sandbox`/`fallback-chain` (session-fixed, not per-agent in-script), `schedule`/`triggers`/`interfaces` (no runtime scheduler/ingress), `memory.store`/`retrieval` (script can't query stores — MCP+agent only), `providers`, `max-turns`, `invocation:manual`, `delegation:inline`, `tools` (dynamic).

## The load-bearing runtime constraints (why things are lossy)
- `NO_HUMAN_INPUT` — zero mid-run human input → human nodes split the topology into 2 scripts.
- `NO_FILESYSTEM` / `NO_SHELL` — the script can't touch fs/git/shell; only `agent()`s can. So `action` (external/git/report), gate `run` scripts, workspace materialization → all become `agent()` calls.
- `PERMISSION_INHERIT_NOT_CONFIGURABLE` + `ACCEPTED_EDITS_MODE_AUTO` — agents inherit the session allowlist; per-agent permissions/tools can't be set in-script → sidecar `settings.json` at session launch.
- `MCP_REACHES_AGENTS_NOT_SCRIPT` — the script can't call MCP; stores/servers are exposed to agents via session MCP config.
- `DETERMINISM` (no time/random) + journaling — bounds loops to literal counts, label-by-index, no `wait`/timers.
- Concurrency cap (~16) + 1000-agent total cap — bounds `scale`/`batch` fan-out.

## Forward mapping (every primitive)

CORE: topology→one .js script (LOSSY: loses the output-dir + pattern-list). orchestrator→the script body itself is the orchestrator (LOSSY; `delegation:inline` UNREPRESENTABLE). agent→`agent(prompt,{label,model,schema,phase,agentType,isolation})` (CLEAN core). agent fields: permissions/tools→UNREPRESENTABLE (session-fixed); reads/writes→LOSSY (paths in prompt + result-passing for the dependency; script can't see fs); outputs→CLEAN (schema); skip→`if` guard; retry→bounded `for` loop w/ per-i labels; isolation:worktree→CLEAN; invocation:manual→UNREPRESENTABLE (args-gate); behavior:advisory→try/catch swallow; background→un-awaited thunk (LOSSY); max-turns→UNREPRESENTABLE (prompt-soft); sandbox→UNREPRESENTABLE; fallback-chain→UNREPRESENTABLE; join→parallel variants (all=barrier clean; any/all-done/none-failed lossy via try/catch since parallel is null-on-throw). agent.scale→deterministic thunk loop `parallel(Array.from({length:n},...))` (LOSSY; can't count fs). action→`agent()` per kind (external/git/report MUST be agents). roles→prompt injection (CLEAN). flow→**imperatively reconstructed in JS** (the heart of scaffold): `a->b` sequence, `a->[b,c]` parallel(), `[when]` if-branch on schema, `[max N]` for-loop, `[per]` pipeline/batch; race/wait/weight/tolerance→UNREPRESENTABLE. gate→explicit check `agent({schema:{pass}})` + `if(!pass) throw` (halt) or loop (bounce-back). depth→`level` from args + guards. human→**workflow split** (2 scripts + README handoff). group→rounds of parallel() w/ prior-round transcript + judge agent (LOSSY: no live shared chat).

ADVANCED: memory.workspace→implicit (prompt paths + result-passing; LOSSY). memory.store→UNREPRESENTABLE in-script (MCP+agent). memory.retrieval→UNREPRESENTABLE (mostly drop). batch→**best fit**: `pipeline()`/`parallel()` + two-wave sequential-rebase merge for conflicts. environments→args + baked lookup object. triggers→the `/wf-name <ARG>` launch surface → args. hooks→UNREPRESENTABLE: observers→inlined statements after the agent(); enforcing pre-tool→sidecar session `settings.json` hooks. settings→sidecar settings.json. mcp-servers→sidecar .mcp.json. metering→partial native (phase()+budget+label); no metrics.jsonl from script. tools→MCP or agent-Bash. skill→prompt-context + MCP + sidecar (context:fork→separate agent(), clean). context→CLAUDE.md (CLEAN). env→sidecar; only args visible in-script. extensions→own `claude-workflow{}` namespace (CLEAN). providers→UNREPRESENTABLE. schedule→sidecar cron + comment. interfaces→external launch + agent w/ MCP egress. schemas/outputs→`schema` option (CLEAN, strongest fit). params→args w/ parse + guards. observability→phase()/label/log() native trace; no OTLP export.

## Reverse gaps — Workflow powers .at lacks (ADD to the grammar)
1. **budget-driven dynamic loops** — `.at` has `[max N]` (count) + `metering` (passive); add a `budget { target, on-exhaust }` + flow guard `[while budget.remaining > N]` + readable `orchestrator.budget`. Turns metering into a control input.
2. **worktree isolation as a richer field** — has per-agent `isolation:worktree` but lacks batch/scale-level worktrees + cleanup lifecycle. Add `worktree { per: instance|run, cleanup: always|on-success|never, branch }` usable on `scale`/`batch`.
3. **adversarial-verify fan-out** — has `group` (cooperative debate) + reflection loops, but no N-independent-refuters-over-a-claim-set. Add a `verify { over, agents:N, stance:adversarial, merge:confirm-if-none-refute }` node.
4. **pipeline no-barrier staging** — flow is barriered-sequential; add `a ~> b` (stream / no-barrier) mapping to `pipeline()`.
- Bonus: `resumable`/`journal-key` (journaling), and marking primitives `deterministic:false` so bindings know what to reject.

## Binding design — what scaffold(ast) emits
- `<topology>.js` — the workflow script: schema consts (from schemas/outputs) → args preamble (from params/triggers) → flow transcribed into `agent()`/`parallel()`/`pipeline()` grouped by `phase()`.
- `CLAUDE.md` (from context), sidecar `settings.json` (permissions/env/hooks/sandbox), sidecar `.mcp.json` (mcp-servers), sidecar cron/launcher + `README.md` listing every UNREPRESENTABLE primitive as a `// LOSSY:`/`// DROPPED:` comment with rationale.
- **Multiple .js files** when the topology has a `human` node (split at the boundary) or multiple `triggers`.
- **phases → parallel/pipeline:** same-phase agents → `parallel([...])` (barrier). Default to `pipeline()` for streaming/per-item; emit `parallel()` only when a phase needs every prior result at once. Strict `a->b` → plain `await`.
- **gates → halt:** `const g = await agent(gatePrompt,{schema:{pass:bool,reason}}); if(!g.pass){ onFail==='halt' ? throw : loop }`. advisory → `log()` not throw.
- **human → split:** part-A.js runs to the boundary + exits w/ artifacts; operator launches part-B.js passing part-A output via args. scaffold emits both + handoff README. (This is the rule the POC already enforced.)

---

# PATTERN ROUND-TRIP FIDELITY (folded in 2026-05-30, workflow wh0vb4ov7)

Tested whether the .at DESIGN PATTERNS survive .at → Claude Workflow. Verdicts:

## CLEAN (survive the round-trip 1:1)
- **Fan-Out (parallel spawn)** → `parallel([...])`
- **Map-Reduce / Scatter-Gather** → `parallel()` then a reduce `agent()`
- **Sequential Pipeline (DAG)** → `pipeline()` / awaited sequence
- **Message-Passing (coordinator-mediated)** → the script IS the coordinator; agents return to it

## LOSSY (representable, but a property is lost)
- **Blackboard / Shared State** → script variables (return values), NOT a live mutable shared substrate agents read/write concurrently.
- **Stigmergy** → substrate is writable but not *actively sensed*; no reactive change-detection.
- **Channels & Synchronization** → barriers exist, but no typed/schema-validated channel contracts.
- **Gate-and-Halt / Hotfix-Loop / Self-Repair** → imperative `if`/`for`, not declarative gate+auto-reroute+bounded-retry.
- **Debate / Adversarial Panel** → rounds of `parallel()` w/ prior-round snapshots; no live turn-taking chat.
- **Supervisor / Orchestrator-Worker / Recursive-Decomposition** → nesting works; restart/routing policies must be hand-coded.
- **All MEMORY-architecture patterns** (3-layer memory, shared/private scoping, consolidation, working-memory, memoization, progressive summarization, retrieval strategies) → LOSSY: these are *session/hook-level* features; a Workflow can code a meta phase but it isn't hook-triggered.
- **All GATE-ROLE patterns** (Critic, Security Scanner, Design Reviewer, Governance, Tool-Router, Load-Balancer, Meta-Agent, Archivist) → LOSSY: codeable as phases, but the declarative hook-routing + auto-trigger is lost.
- **Direct Messaging (SendMessage)**, **MCP-as-capability**, **Hooks & Events**, **Background execution**, **Manual invocation** → LOSSY (session/team features, not script primitives).

## UNREPRESENTABLE (the runtime genuinely cannot)
- **Gossip Protocol** → needs continuously-concurrent swarm + periodic in-flight listener hooks. Workflow spawns are sequential or barrier-parallel, never continuously concurrent.
- **External Interfaces** (webhook/http/sse/email ingress-egress) → Workflows are invoked by command/Claude-decision, not external events.
- **Domain Eviction** → needs long-running multi-turn agents; Workflow agents are single-pass spawn→return.
- **The Autonomy Dial** (mid-run human approval) → Workflows prohibit mid-run human input.
- **Composition Blocks (library/import/use)** → JS code reuse, not topology composition.
- **★ THE CANONICAL HARD CASE** (fan-out-N + concurrent observers + dual-stream reduce + hotfix gate) → **UNREPRESENTABLE.** The crux is the concurrent observability listener tapping a shared metrics substrate written by workers *while they run*. The Workflow tool has NO concurrent-listener primitive, NO shared metrics substrate, NO pub-sub/append-log subscriber. Agent teams have SendMessage peer-to-peer, but Workflows don't integrate with agent-team SendMessage. Parts 1/3/4 (fan-out, dual-stream reduce, hotfix gate) are CLEAN/LOSSY; part 2 (concurrent observation) sinks the whole pattern.

## The headline conclusion (validates the thesis)
The Workflow tool is excellent at **phase-structured orchestration** (fan-out, map-reduce, pipeline, gates-as-imperative-checks) — which is ~80% of real ship pipelines, and exactly what MatchMat's ship-harness needs.

But it is **phase-based (sequential | parallel-with-barrier), NOT event-driven**. So an entire CLASS of .at patterns — anything needing **concurrent listeners on a live shared substrate** (Blackboard, Stigmergy, Gossip, concurrent Observability, the autonomy dial) — is LOSSY-to-UNREPRESENTABLE.

THIS IS WHERE .at LEADS THE RUNTIME. .at is strictly more expressive than one Workflow runtime. That is the argument for keeping .at as the runtime-agnostic standard:
- The Workflow binding is faithful for the phase-structured majority.
- The concurrent/event-driven patterns are .at's frontier — and a concrete feature request for the Workflow tool (a `listener`/`subscribe` primitive on a shared append-log).

## Implication for the binding
The `claude-workflow` binding should:
1. Compile the CLEAN + LOSSY patterns (emit `parallel`/`pipeline`/`phase`/schema/gates-as-checks).
2. On any UNREPRESENTABLE primitive/pattern, FAIL LOUD at scaffold time with a precise message (like the POC already does for `human` nodes) — never silently drop. e.g. "Topology uses concurrent observability (Blackboard listener); the claude-workflow target cannot express live concurrent listeners. Options: (a) move observability to a post-barrier phase (lossy), (b) target a different runtime, (c) split."
3. Emit a `// LOSSY:` / `// UNREPRESENTABLE:` report alongside the generated workflow so the operator sees exactly what changed in translation.
