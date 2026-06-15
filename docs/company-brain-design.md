# Design Exploration: The Company Brain

**Status:** Exploration / proposal — not built. For Nadav's review.
**Date:** 2026-06-15
**Author:** Claude (Opus 4.8) + Nadav

> "He asked me if I have a plug-and-play tool to create a company brain… like the Obsidian graph where all the markdowns are connected using edges, and the edges come from tagging inside markdowns that connect files together."

This document studies how Obsidian works, then proposes the **brain as a pattern** — not a new pile of keywords. It is built from primitives `.at` already has, plus exactly **one** new primitive (custody). No code yet — this is the design conversation.

---

## 0. The thesis (what we converged on)

**Brain as code, harness as code.** AgentTopology lets you describe a company brain the way you describe a harness — declaratively, wired like a programming language. It compiles to a folder of markdown that:

- is **Obsidian-portable both ways** — agents build it, a human opens it in Obsidian and gets the graph view for free; a human's existing vault becomes an agent-readable brain with zero migration. *"Connect your Obsidian to AgentTopology, connect your AgentTopology to Obsidian."*
- is **pure markdown by default** — no vector DB, no embeddings, no MCP server required. Coding agents retrieve with `grep`/`glob`/`read`/`write`. The brain is a folder you can `git clone`, diff, and read by hand.
- is **agent-maintained, not hand-driven** — humans drop a file and say "wire it in"; custodian agents do the linking. Better than Obsidian (which a human curates manually), presented in Obsidian, maintained by our harness.

The key design realization: **a brain is a *pattern*, not a primitive** — exactly like `blackboard`.

---

## 1. How Obsidian works (the mechanics that matter)

Obsidian is not a database. It is a **folder of plain markdown**, and the graph is a *projection* computed from text inside the files.

| Mechanic | Syntax (inside the .md file) | Produces |
|---|---|---|
| **Wikilink** | `[[Note]]` | directed edge → target |
| **Heading / block link** | `[[Note#Heading]]`, `[[Note#^block]]` | edge to a section/paragraph |
| **Alias** | `[[Note\|display]]` | same edge, different label |
| **Embed** | `![[Note]]` | transclusion |
| **Unresolved link** | `[[Not yet written]]` | *ghost node* — placeholder that becomes real when the file is created |
| **Inline / nested tag** | `#meeting`, `#inbox/to-read` | hyperedge connecting all notes sharing the tag |
| **Frontmatter tag** | `tags: [recipe, cooking]` | same, declared in YAML properties |
| **Backlink** | (computed, never authored) | reverse of every wikilink — "what links here" |

**Four properties that make it spread:** (1) the file is the source of truth — delete it, edges vanish, no sync; (2) edges are written in prose, not config; (3) the graph is emergent and projectable; (4) ghost nodes let structure precede content.

An **index in Obsidian is just another markdown note** — a "Map of Content" hub that `[[links]]` a cluster of notes. **The link *is* the index.** This is the whole insight for us: we don't need a database for indexes, and we don't need a language keyword for them — an index is a file that links to other files.

---

## 2. Primitive vs. Pattern — the design lens

This is the lens that resolves everything. (Precedent: `blackboard` lives in the **Patterns** table in `spec/grammar.md:202`, *not* in the lexer or AST. It's a tag you add — `topology x : [pipeline, blackboard]` — that the binding knows how to honor. It is a *named arrangement of primitives*, not a keyword.)

- A **primitive** is irreducible — the language can't compose without it (a `store`; a reference between things; an `agent`).
- A **pattern** is a *named, reusable arrangement of primitives* that encodes good engineering and nudges the author toward it (`blackboard` = shared-state pattern).

Applying the lens to the brain:

| Thing | Primitive or pattern? | Status |
|---|---|---|
| Markdown folder as a store | **primitive** | ✅ exists (`domains`, store `path:`) |
| One store derived-from another ("indexes") | **primitive** — a typed reference; *also* just a markdown file that `[[links]]` others | ✅ exists in spirit (`dependsOn`, `memory:` refs). **No new keyword.** |
| An agent **owns the upkeep** of a store | **primitive** | ❌ **the one genuinely new thing: custody** |
| **brain** (layered linked markdown + custodians, Obsidian-portable) | **pattern** | ➕ add to the Patterns table, like `blackboard` |

**Net new language surface: one pattern + one primitive.** Everything else is composition of what you already built. We explicitly **drop the `indexes` keyword** and the `brain {}` / `layer {}` blocks proposed in earlier drafts — they were inventing primitives for things that are already references and already files.

---

## 3. The `brain` pattern

`brain` joins the Patterns table next to `blackboard`:

```at
topology company-knowledge : [brain, human-gate] {
```

That tag declares intent: *"this topology composes a company brain."* The binding honors it by wiring the markdown-folder + custodian behavior. What the pattern encodes (so a good engineer gets it for free, instead of hand-driving Obsidian):

- **L0 is the source of truth** — a folder of Obsidian-format markdown. Humans drop notes here.
- **Indexes are derived markdown** — hub notes (links only, à la Obsidian Maps of Content), written and maintained by custodians.
- **The graph is a projection** of the files (`[[wikilinks]]` + `#tags` + computed backlinks).
- **Format is Obsidian** — so it round-trips.

Crucially, the **layers are the author's design, not the language's.** L0/L1/L2 was scaffolding for *our* conversation; the language does **not** impose or number layers. Like classes in OOP, the engineer names their own layers and wires the references. A disciplined engineer builds a clean hierarchy of hub-notes; the language *permits* that, the `brain` pattern *nudges* toward it, but never forces a fixed schema. (This is the same reason we chose a DSL over YAML — YAML forces a schema; the language lets people express their own architecture.)

---

## 4. The one new primitive: custody

Today `memory: [store]` means an agent can **read** a store. There is no notion of an agent that **owns its upkeep**. Custody is that primitive — and it's what makes the brain "maintained by our harness, not hand-driven like Obsidian."

Two candidate spellings (decide later):

```at
# B1 — field on the agent (discoverable on the agent)
agent librarian {
  custodian-of: [company-brain]
  memory: [company-brain]
}

# B2 — declared inside the store (keeps memory semantics in the memory block)
store company-brain {
  type: brain
  path: "brain/"
  custodians: [librarian]
}
```

**What custody compiles to** (the field reality, via the existing binding chain — store → prompt section + optional connection): the custodian's generated prompt gets the brain-maintenance charter —

> "When a file appears/changes in `brain/`: read it; resolve mentions of existing notes into `[[wikilinks]]`; assign `#nested/tags` consistent with the hierarchy; let backlinks compute themselves; write/update the hub notes that index this cluster; flag ghost nodes and near-duplicates."

The **vocabulary** of what a custodian does (resolve, tag, backlink, heal, dedupe) can be named in the language; the **technique** (how to resolve entities well, how to detect dupes) stays MOAT in the skill repo. Language declares *that* a custodian exists and *which* store it owns; the skill owns *how* it does the job well.

---

## 5. How an agent connects to memory today (grounding — real code)

So "how does an agent connect to the brain" has a concrete answer: **the same way it connects to any store.** A brain is stores; connecting to a brain is listing them in `memory: [...]`. Verified against `src/bindings/claude-code.ts`:

1. **Declare a store** — a named unit in `memory {}`.
2. **Agent references it by name** — `memory: [store-id]` (AST `ast.ts:509` — just a list of strings). Validator V35 checks the name resolves.
3. **Binding turns the reference into two concrete things:**
   - **a prompt section** (`claude-code.ts:516-572`) — "You have access to the following memory stores… ### store-id, type, backend, path, access method."
   - **a real connection** (`STORE_MCP_COMMANDS`, `claude-code.ts:2062`) — backend → runnable MCP server in `.mcp.json` (`kuzu → npx kuzu-mcp-server`, etc.), **or** "Direct file access at `path/`" when there's no DB.

**The brain rides this exact chain — with the connection branch that is pure files.** A `type: brain` store has no backend, so it compiles to *"Direct file access at `brain/`"* — no MCP server, no `.mcp.json` entry. That's why a brain is plug-and-play: nothing to spin up.

---

## 6. Pure-markdown by default; DBs as optional power-up

Every layer of the brain is markdown by default. Indexes are markdown files that `[[link]]`. Retrieval is the agent running `grep`/`glob`. **No vector store, no embedding model on the critical path.** This is better, not a compromise: the indexes are portable, diffable, git-versioned, and human-readable — a vector store is an opaque blob.

The heavyweight stores you already built (`semantic`/lancedb, `graph`/kuzu, `entity`/falkordb) **stay in the language as an opt-in power-up.** A brain can mix in an optional vector layer for semantic recall over the same files — it degrades gracefully from "pure Obsidian" to "Obsidian + RAG" — but the *default* brain is pure files.

---

## 6.5 Obsidian compatibility

**The vault is 100% Obsidian-compatible. The agent layer is the part Obsidian doesn't have — and that's the point.**

```
   THE FILES  ─────────────────►  ✅ 100% compatible
   (what's inside brain/)

   THE MAINTENANCE  ────────────►  ⚙️ our harness (Obsidian can't do this)
   (who writes the links)
```

Obsidian has no proprietary format — a vault *is* just a folder of markdown with conventions:

```
  ✅ [[wikilinks]]        ← plain markdown text
  ✅ #nested/tags         ← plain markdown text
  ✅ YAML frontmatter     ← plain markdown text
  ✅ ![[embeds]]          ← plain markdown text
  ✅ backlinks            ← Obsidian COMPUTES these, doesn't store them
```

There's nothing to "integrate with" — if `brain/` uses these conventions, **it already is an Obsidian vault.** `format: obsidian` in the store is therefore not an integration; it's a **promise the librarian keeps**: only ever write these conventions, nothing custom. The door stays open both ways:

```
   👤 your Obsidian vault   ──────►  📁 becomes an agent-readable brain
                                       (zero migration — already markdown)

   🤖 agent-built brain     ──────►  👁️ opens in Obsidian, graph for free
                                       (it was always a vault)
```

**The one caveat (don't over-claim):** core Obsidian — links, tags, graph, backlinks, embeds — is 100%. Obsidian *plugins* (Dataview, exotic canvas plugins) use plugin-specific syntax: still valid markdown, but the behavior lives in the plugin, not the file. Our brain won't break them, but the agent won't natively understand exotic plugin syntax unless taught.

**Safe marketing line:** *"Your brain is a real Obsidian vault. Open it in Obsidian anytime — the graph just works. We add the one thing Obsidian can't: a team of agents that maintains it for you."*

---

## 6.6 Competitive landscape (web research, mid-2026)

Research confirms the design is **novel at the intersection, crowded on any single axis.** Four capabilities each exist alone; **no product combines all four:**

```
   declarative   +   multi-agent   +   Obsidian-portable   +   per-agent
   (arch-as-code)    (a TEAM)          (user-owned md)         memory layers
   ─────────────────────────────────────────────────────────────────────
        ▲                 ▲                   ▲                    ▲
        │                 │                   │                    │
   nobody lets       only enterprise     Obsidian crowd      enterprise has
   you DECLARE       "company brain"     has this, but        layers but in
   the team          backends, but       only SINGLE          proprietary
   architecture      proprietary         agents +             stores, not
                     stores              prompt-files         user-owned
```

**What's crowded (don't lead here):**
- "AI enriches my Obsidian vault" — saturated (Smart Connections, Copilot, Khoj — all passive RAG sidebars).
- "One autonomous agent maintains my vault from an instruction file" — recently **commoditized** by the Karpathy "LLM Wiki" pattern (`agents.md` + Claude Code/Codex). A *single* librarian is no longer differentiated.

**What's open (lead here):**
- **A declared TEAM** of specialized agents (librarian + ingesters + auditor), each owning a memory layer — effectively unoccupied at the user-owned tier. ← *this is the team-of-10 idea, and it's the wedge.*
- **Agentic multi-source ingestion → markdown** (Gmail/Slack/calendar/meetings into a portable vault) — the **single clearest whitespace**. Enterprise tools do this but dump into proprietary vector+graph stores, not Obsidian markdown.

**Strategic notes:**
- Moat = the **declarative topology** (architecture-as-code) + **portability** (just markdown the user owns), NOT "AI organizes notes."
- **Ingestion is the strongest land-grab.** A team where one agent owns Gmail→brain, another owns Slack→brain, etc. is exactly the underserved spot.
- **De-risk the librarian:** the market learned aggressive auto-relinking is dangerous (everyone went add-only/gated). Our **gate-enforcement architecture** (Option C positioned hooks) is a differentiator — make "safe, gated graph maintenance" explicit.
- Watch **Obsilo** (closest agent-native multi-tasking) and enterprise **company-brain** (Colrows/Krista) — converging from above with proprietary stores; our portability + declarativeness is the wedge against both.

*(Full sourced report from the research agent retained in conversation history; agentId `a0826aadcc1460b6f`.)*

---

## 6.7 The team-of-N vision (why the brain is a topology, not a tool)

The competitive gap points straight at the real product: **the brain isn't maintained by one librarian — it's maintained by a declared *team*, each agent owning a layer or a source.** This is what only AgentTopology can express, because the team *is* a topology.

```
                          📁 brain/  (Obsidian vault)
                               ▲
        ┌──────────┬───────────┼───────────┬──────────┐
        │          │           │           │          │
   📧 gmail-    💬 slack-   👤 librarian  📅 cal-    🔍 auditor
   ingester    ingester    (links/tags)  ingester   (heals graph,
   feeds md    feeds md                   feeds md   flags ghosts,
                                                      dedupes)
        │          │                       │
        └──────────┴───────────────────────┘
              each owns ONE source → writes raw notes
              the librarian wires them into the graph
              the auditor keeps the whole thing healthy
```

Every arrow above is an agent you **declare** in `.at` — `custodian-of` a layer, or an ingester wired to an MCP source (Gmail, Slack) writing into `brain/`. *"Engineer the brain"* = compose this team. This is the flagship topology once the primitives land.

---

## 7. Why this is good for the standard (and the moat)

- **Easiest possible on-ramp** — "point it at a folder of markdown" beats "configure a vector DB." Same reason Obsidian won.
- **Every binding can implement it** — filesystem + an agent loop. No binding needs a vector DB to support a brain. Good for write-once-deploy-anywhere.
- **Custody is a genuinely new primitive** — "agents that own a memory layer" isn't in any competing config language. The kind of thing that *defines* a standard rather than chasing one.
- **Obsidian portability is a marketing weapon** — the brain *is* a valid vault, so Obsidian becomes the free visualizer and the migration path runs both directions.
- **MOAT stays safe** — the language declares the `brain` pattern, the custody primitive, and the *vocabulary* of maintenance. The *coordination technique* (how to wire a brain well, resolve entities, keep it healthy) stays in the skill repo.

---

## 8. Open questions

1. **Custody spelling — B1 (agent field) or B2 (store field)?** B2 keeps memory semantics in the memory block; B1 is more discoverable on the agent. Possibly support both + cross-validate.
2. **Does custody name verbs?** Bare custody (agent figures it out from its prompt) vs. a named vocabulary (`does: [resolve, tag, heal]`). Leaning: optional verbs — bare works, annotate when you want the strategy visible in the code (like an optional type annotation).
3. **`type: brain` store** — confirm it's a distinct store type (no backend, Obsidian-format) vs. overloading an existing type. Leaning: distinct, because every other store assumes a backend and `brain` deliberately has none.
4. **Validation rules** — likely V87+: "custodian must reference a declared store," "brain store needs a folder path," "brain layer holds markdown, not a DB backend (unless power-up opt-in)."
5. **Does the visualizer render the brain's `[[link]]` graph**, or do we lean on Obsidian for that? (Payoff feature — later.)
6. **Naming** — `brain` (matches the user's mental model) vs. `vault` (matches Obsidian's term).

---

## 9. Suggested next slice

Pure language-design exercise, no bindings yet:

1. Add **`brain` to the Patterns table** (`spec/grammar.md`) — one row, like `blackboard`.
2. Add the **custody primitive** to the grammar + AST (`custodian-of` / `custodians`) with its validation rule.
3. Add a **`type: brain`** store (no backend, Obsidian-format, direct file access).
4. Write **one flagship example** — `company-brain.at`: a `librarian` custodian + a `researcher` that traverses the brain. See the syntax in a real file before committing to verbs/visualizer.

This keeps it in the `grammar-engineer` agent's wheelhouse and lets you read the syntax in a real `.at` before any binding work.
