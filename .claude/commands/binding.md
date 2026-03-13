---
description: "Parser development — grammar, bindings, tests, CLI, and docs"
---

# /binding

/parser binding

## Pipeline
- develop-grammar -> grammar-engineer
- grammar-engineer -> test-engineer [when grammar-engineer.status == needs-tests]
- grammar-engineer -> doc-writer [when grammar-engineer.status == done]
- develop-binding -> binding-engineer
- binding-engineer -> test-engineer [when binding-engineer.status == needs-tests]
- binding-engineer -> doc-writer [when binding-engineer.status == done]
- develop-tests -> test-engineer
- develop-cli -> cli-engineer
- cli-engineer -> test-engineer [when cli-engineer.status == needs-tests]
- cli-engineer -> doc-writer [when cli-engineer.status == done]
- develop-docs -> doc-writer
- validate-all -> test-engineer

## Agents
| Agent | Phase | Model | Role |
|-------|-------|-------|------|
| grammar-engineer | 1 | opus | Language engineer — evolves the .at grammar, AST types, parser, validator, and reserved keywords as a cohesive unit |
| binding-engineer | 1 | opus | Binding specialist — maintains all 5 platform bindings (Claude Code, Codex, Gemini CLI, Copilot CLI, OpenClaw) and ensures backward compatibility |
| test-engineer | 2 | sonnet | Test specialist — writes comprehensive parser tests, runs vitest, validates all example .at files |
| cli-engineer | 1 | sonnet | CLI and tooling specialist — develops the agentopology CLI commands and the interactive HTML visualizer |
| doc-writer | 3 | sonnet | Documentation specialist — maintains examples, README, and docs for the open-source package |

