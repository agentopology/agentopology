# AgentTopology — The Open Standard

The universal declarative language for multi-agent systems. Write once, deploy to any agentic framework.

## This Repo: The npm Package (`agentopology`)

Parser, validator, CLI, visualizer, and 5 bindings (Claude Code, Codex, Gemini CLI, Copilot CLI, OpenClaw).

- `src/parser/` — LL(2) parser, AST types, 22 validation rules
- `src/bindings/` — 5 platform targets
- `src/cli/` — validate, scaffold, sync, targets commands
- `src/visualizer/` — HTML topology viewer
- `spec/` — formal grammar (grammar.md), validation rules, reserved keywords
- `examples/` — 5 example .at files
- Tests: `npx vitest run` (120 tests)

## Ecosystem (sibling repos)

- **Skill repo** (`~/Projects/agent-topology/`) — The private MOAT. Design engine, 82 concepts, 9 templates, 10 operating modes. Never open-sourced.
- **Website** (`agentopology.com`) — Chat-powered topology builder. Next.js + Vercel.

## Rules

- This package is Apache-2.0 open source. Never commit proprietary patterns from the skill repo.
- Keep templates minimal — no clever memory wiring, no coordination patterns (those are MOAT).
- All bindings must maintain backward compatibility with extensions for features that are now first-class.
- Run `npx vitest run` before committing. Run `npx tsc --noEmit` to type-check.
