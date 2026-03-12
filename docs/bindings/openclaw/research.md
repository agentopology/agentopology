# OpenClaw — Raw Research for Binding Development

> This is raw research dump. We'll use this to build the `openclaw.ts` binding.

---

## Architecture

OpenClaw uses a "Workspace-First" approach — a local directory is the single source of truth. The framework relies on a single long-lived Node.js process (the Gateway) that manages channel connections, tool execution, and the agent loop.

## Core Configuration Schema

Central config: `openclaw.json` in `~/.openclaw/` or project root.
Handles: provider API keys, model routing (primary + fallback chains), database connections, cron jobs, plugin settings.

No official JSON schema published — generate dynamically via:
```bash
openclaw config schema > openclaw.schema.json
```

## Agent Identity — Markdown Workspace Structure

Agents defined via markdown files, NOT JSON/code. Gateway reads these on session start to assemble system prompt + context.

```
project/
├── SOUL.md          # Core identity, personality, tone, ethical guardrails
├── AGENTS.md        # Specialized sub-agent instructions
├── TOOLS.md         # Available tools and when to use them
├── MEMORY.md        # Long-term user preferences, past interactions
├── BOOTSTRAP.md     # Initialization instructions on boot
└── openclaw.json    # System-level config
```

**Key behavior:** Sub-agents only inherit `AGENTS.md` and `TOOLS.md`. They do NOT get `SOUL.md` (saves context space).

## Tools and Skills

Skills = AgentSkills-compatible directories. Each skill folder needs:
- `SKILL.md` with YAML frontmatter (metadata, command args, env vars)
- JS/TS execution logic (file ops, shell commands, external APIs)

## Network / API

- JSON-over-WebSocket on port 18789 (client connections, node pairing, streaming events)
- OpenAI-compatible HTTP endpoints (`/v1/chat/completions`)
- Webhook system for external integrations
- Uses `llms.txt` for AI-discoverable API summaries
- Uses OpenAPI specs for machine-readable contracts

## Known Pain Points (our opportunity)

1. **Bootstrap problem** — agents prioritize answering user queries and skip their own identity setup permanently
2. **Chaotic multi-agent log management**
3. **Security vuln** — gateway runs with NO auth tokens by default
4. **No declarative way to describe the full topology** — it's all manual markdown files

## AT → OpenClaw Mapping (rough)

```
.at topology header     → project directory name
.at meta                → openclaw.json metadata
.at roles               → SOUL.md (personality, identity per role)
.at agent blocks        → AGENTS.md (sub-agent definitions)
.at tools block         → TOOLS.md + skill directories
.at memory              → MEMORY.md structure
.at settings            → openclaw.json (model routing, permissions)
.at mcp-servers         → openclaw.json (provider config, API keys)
.at hooks               → BOOTSTRAP.md (init instructions)
.at gates               → (no direct equivalent — we ADD this value)
.at flow                → AGENTS.md routing instructions
.at scale               → (no direct equivalent — we ADD this value)
.at metering            → (no direct equivalent — we ADD this value)
```

## Sources

- milvus.io/blog/openclaw-formerly-clawdbot-moltbot-explained
- docs.openclaw.ai/reference/templates/SOUL
- docs.openclaw.ai/tools/skills
- lobehub.com/ru/skills/oabdelmaksoud-openclaw-skills-openclaw-settings
- kenhuangus.substack.com/p/the-openclaw-design-patternspart
- velvetshark.com/openclaw-memory-masterclass
- linkedin.com (David Rostcheck investigation series)
- dev.to/alfredz0x/how-to-make-your-api-ai-discoverable-with-llmstxt-and-openapi-2026-guide

## TODO

- [ ] Get the actual `openclaw.json` schema (run `openclaw config schema`)
- [ ] Find/fetch llms.txt if it exists
- [ ] Map every .at language feature to OpenClaw equivalent
- [ ] Build `src/bindings/openclaw.ts`
- [ ] Write example: simple-assistant.at → full OpenClaw workspace
- [ ] Write example: multi-agent-support.at → OpenClaw with sub-agents
