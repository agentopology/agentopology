# Company Brain — Tutorial

> **A company brain is a folder of linked markdown that agents build and maintain — not you.**
> It's the [Obsidian](https://obsidian.md) graph model (notes connected by `[[wikilinks]]` and
> `#tags`), but agent-maintained instead of hand-curated. This is the how-to. For *why* it's
> designed this way, see [`company-brain-design.md`](company-brain-design.md).

## The whole flow in one picture

```
  1. BUILD .at          2. SCAFFOLD             3. RUN agents            4. VISUALIZE
  ────────────          ───────────             ─────────────            ──────────
  declare a brain  ───► agentopology      ───►  ingesters pull from ───► agentopology
  store + a             scaffold creates        sources, librarian       visualize-brain
  librarian             .claude/agents/ +       wires notes into         → Obsidian-style
  custodian             the brain vault         the graph                graph, no Obsidian
```

Everything below walks that flow on the shipped example, [`examples/company-brain.at`](../examples/company-brain.at).

---

## 1. Build — declare the brain

A brain is a **store** with `type: brain`. It is file-native: a folder of markdown, no
database, no embeddings. The graph emerges from inline `[[links]]` and `#tags`.

```at
memory {
  store brain {
    type: brain          # file-native — markdown is the truth, the graph is a projection
    path: "brain/"       # this folder is a valid Obsidian vault
    format: obsidian     # the promise: only [[wikilinks]], #tags, ![[embeds]], YAML frontmatter
    scope: org
  }
}
```

Then declare an agent that **owns its upkeep** — a custodian. This is the one new primitive:
`memory:` grants *read* access; `custodian-of:` makes the agent *responsible* for maintaining
the store.

```at
agent librarian {
  model: sonnet
  description: "Maintains the brain — wires new notes into the graph"
  tools: [Read, Write, Edit, Grep, Glob]

  custodian-of: [brain] {            # owns the brain's upkeep
    does: [link, tag, index, dedupe] # optional — the maintenance verbs, visible as architecture
  }
}
```

The `does:` verbs are optional. Omit them and the agent infers its duties from its prompt;
include them to make the maintenance strategy explicit in the code.

Validate before you scaffold:

```bash
agentopology validate examples/company-brain.at
# → All validation rules passed.
```

---

## 2. Scaffold — generate the project

```bash
agentopology scaffold examples/company-brain.at --target claude-code --output ./my-brain
```

This produces a real Claude Code project:

```
my-brain/
├── brain/
│   └── _brain.md                       # the vault, seeded with a root Map-of-Content note
├── .claude/
│   ├── agents/
│   │   ├── librarian/AGENT.md           # gets the generated custody charter
│   │   └── researcher/AGENT.md
│   ├── commands/{wire-in,query}.md
│   └── CLAUDE.md
```

The `librarian/AGENT.md` contains a **custody charter** generated from `custodian-of` + the
`does:` verbs — a standing instruction set: *"when a note is added, resolve mentions into
`[[wikilinks]]`, assign `#nested/tags`, update the hub note, flag duplicates."* The vault is
seeded at the real `path:` (here `brain/`), not buried in `.claude/`, so you can open the folder
directly in Obsidian.

> The brain store has no database backend, so it needs no MCP server — it compiles to
> *"Direct file access at `brain/`."* That's why it's plug-and-play: nothing to spin up.

---

## 3. Run — agents build the brain

A human drops a raw markdown note into `brain/` and runs `/wire-in <file>`. The librarian:

1. **Reads** the new note.
2. **Links** — finds mentions of existing notes, turns them into `[[wikilinks]]`.
3. **Tags** — assigns `#nested/tags` consistent with the existing hierarchy.
4. **Indexes** — updates the hub note so the new note is reachable.
5. Leaves **ghost links** (`[[things not yet written]]`) to mark gaps, and flags duplicates.

Humans drop; agents wire. Nobody hand-authors a single `[[link]]`.

### Scaling up: a team that feeds the brain

The flagship example, [`company-brain-team.at`](../examples/company-brain-team.at), adds
**ingester agents** — one per source — that feed the brain automatically:

```
  📧 gmail-ingester    ─┐  (scheduled; owns the Gmail MCP)
  💬 slack-ingester    ─┼─► brain/  ──► 👤 librarian ──► 🔍 auditor
  📅 calendar-ingester ─┘   raw notes    (link/tag/        (heal/dedupe,
     each owns ONE source                 index/dedupe)     nightly)
```

Each ingester writes raw notes (stamping `source: gmail` in the frontmatter) but does **no**
linking — that's the librarian's job. A second custodian, the **auditor**, keeps the whole graph
healthy. Two custodians of the same brain, different verbs: that's the "agents own a memory
layer" model.

---

## 4. Visualize — see the brain, no Obsidian required

```bash
agentopology visualize-brain my-brain/brain/
```

This renders the vault as an interactive force-directed graph in a **single self-contained HTML
file** — the Obsidian graph view, with none of the 500 MB app. Open it in any browser:

- **Nodes are colored by what they are** — person (blue), org (green), topic (gold), note
  (purple), hub (cyan). The category is inferred from tag namespaces (`person/`, `org/`, `topic/`).
- **Ghost nodes** (linked but not yet written) render hollow and dashed — a person who has no note
  yet is a hollow *person*, not a generic placeholder.
- **Click any node** to open its full note in a side panel, with clickable `[[links]]` and
  backlinks for navigation. Works offline — note bodies are inlined into the HTML.

### Color by provenance (where a note came from)

Declare a `sources` block on the brain store to color nodes by their integration source. This is
**presentation only** — it changes nothing functional; bindings ignore it entirely.

```at
store brain {
  type: brain
  path: "brain/"
  format: obsidian

  sources {
    gmail {
      color: "#EA4335"
      icon: "./logos/gmail.svg"   # the .at holds only a path; the CLI inlines it as a data: URI
    }
    slack {
      color: "#4A154B"
    }
  }
}
```

Because the ingester stamps `source: gmail` into each note, every note from Gmail now renders in
Gmail red with the Gmail logo. The language stores no image bytes — the visualizer reads the icon
file at generate-time and inlines it, so the output stays one portable file.

### Cross-linking

When you `visualize` a topology that owns brains, the topology graph and the brain graph(s) are
**cross-linked**: the topology header gets an "🧠 Open Brain →" button (or a dropdown if it owns
several brains), and each brain graph gets a "← Topology" back-link.

```bash
agentopology visualize examples/company-brain-team.at   # renders the topology AND its brain, linked
```

---

## Obsidian compatibility

The vault **is** an Obsidian vault — there's nothing to convert. Open `brain/` in Obsidian and the
graph view, backlinks, and tag panes all work. The relationship runs both ways:

- **AgentTopology → Obsidian:** agents build the brain; a human opens it in Obsidian for the graph.
- **Obsidian → AgentTopology:** an existing vault becomes an agent-readable brain with zero migration.

The one caveat: core Obsidian (links, tags, graph, backlinks, embeds) is 100% portable. Obsidian
*plugins* (e.g. Dataview) use plugin-specific syntax — still valid markdown, but the behavior lives
in the plugin.

---

## Reference

- **Design rationale:** [`company-brain-design.md`](company-brain-design.md) — primitive vs.
  pattern, the cache-hierarchy model, competitive landscape.
- **Grammar:** [`../spec/grammar.md`](../spec/grammar.md) — `brain` pattern, `type: brain` store,
  `custodian-of` primitive, `sources` presentation block.
- **Examples:** [`company-brain.at`](../examples/company-brain.at),
  [`company-brain-team.at`](../examples/company-brain-team.at).
