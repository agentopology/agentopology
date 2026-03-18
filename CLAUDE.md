# AgenTopology — The Open Standard

The universal declarative language for multi-agent systems. Write once, deploy to any agentic framework.

## This Repo: The npm Package (`agentopology`)

Parser, validator, CLI, visualizer, and bindings for 8 platform targets.

- `src/parser/` — LL(2) parser, AST types (799 lines), 29 validation rules
- `src/bindings/` — 8 platform targets (6 CLI + 2 SDK)
- `src/cli/` — validate, scaffold, sync, visualize, targets commands
- `src/visualizer/` — HTML topology viewer
- `src/exporters/` — Markdown and Mermaid exporters
- `spec/` — formal grammar (grammar.md), validation rules, reserved keywords
- `examples/` — 5 example .at files
- Tests: `npx vitest run` (748 tests across 3 test files)

## Bindings

### Open Source (CLI — generate config files)
| Binding | Target | File |
|---------|--------|------|
| claude-code | Anthropic Claude Code CLI | `src/bindings/claude-code.ts` |
| codex | OpenAI Codex CLI | `src/bindings/codex.ts` |
| gemini-cli | Google Gemini CLI | `src/bindings/gemini-cli.ts` |
| copilot-cli | GitHub Copilot CLI | `src/bindings/copilot-cli.ts` |
| openclaw | OpenClaw framework | `src/bindings/openclaw.ts` |
| kiro | Anthropic Kiro | `src/bindings/kiro.ts` |

### Private (SDK — generate runnable code) — REMOVE BEFORE PUBLIC RELEASE
| Binding | Target | File |
|---------|--------|------|
| anthropic-sdk | Anthropic Messages API | `src/bindings/anthropic-sdk.ts` (2,722 lines) |
| vercel-ai | Vercel AI SDK | `src/bindings/vercel-ai.ts` |

## Ecosystem (sibling repos)

- **Skill repo** (`~/Projects/agent-topology/`) — The private MOAT. Design engine, 82 concepts, 9 templates, 10 operating modes. Never open-sourced.
- **Website** (`agentopology.com`) — Chat-powered topology builder. Next.js + Vercel.

## Key References

### Language Spec
- `spec/grammar.md` — Complete formal grammar (1,467 lines)
- `spec/reserved-keywords.md` — Reserved keywords for future features
- `src/parser/ast.ts` — AST type definitions (799 lines, 47 AgentNode fields, 6 node types)

### Anthropic API (for SDK binding development)
- Docs index: `https://docs.anthropic.com/llms.txt` (redirects to `platform.claude.com`)
- Full docs: `https://docs.anthropic.com/llms-full.txt`
- Key features wired: Messages API, tool use, extended thinking (`budget_tokens`), structured output (`output_config.format`), prompt caching (`cache_control`), MCP connector (beta), batches API (50% pricing)
- SDK: `@anthropic-ai/sdk` (TypeScript), `anthropic` (Python)
- Agent SDK: `@anthropic-ai/claude-agent-sdk` — wraps Messages API with built-in tools, subagents, sessions, hooks

### Architecture Decisions
- Gate enforcement: Option C — gates are positioned hooks, compile to strongest platform enforcement
- Open/private split: CLI bindings open (adoption), SDK bindings private (revenue)
- Binding factory: .at topology that generates bindings from API docs (private)

## Plans & Status

### Built (this session, 2026-03-14)
- Anthropic SDK binding: 2,722 lines, 20 generator functions, ~95% AST coverage
- 149 deep tests for SDK binding (18 categories, all free — no API calls)
- Vercel AI binding (via binding factory)
- Total: 748 tests passing, zero TypeScript errors

### Before Release
- See memory: `project_launch_checklist.md` for full checklist
- Critical: remove SDK bindings from public branch, email Amitai for IP confirmation, trademark filing
- See memory: `project_syntax_improvements.md` for language cleanup candidates

### Future Topologies (to be built)
- **Binding Factory** — generates bindings from API docs (designed, not yet .at file)
- **Repo Manager** — manages releases, changelogs, version bumps, test runs
- **Community Manager** — triages issues, labels PRs, welcomes contributors
- **Docs Generator** — generates API docs, tutorials, cheat sheets from source

## Rules

- This package is Apache-2.0 open source. Never commit proprietary patterns from the skill repo.
- Keep templates minimal — no clever memory wiring, no coordination patterns (those are MOAT).
- All CLI bindings must maintain backward compatibility with extensions for features that are now first-class.
- SDK bindings are private — NEVER push to main/public branch. Extract to separate repo before release.
- Run `npx vitest run` before committing. Run `npx tsc --noEmit` to type-check.
