---
name: parser-dev
description: "Parser development — grammar, bindings, tests, CLI, and docs"
version: "1.0.0"
topology: parser-dev
patterns:
  - pipeline
  - fan-out
entry: commands/grammar.md
---

# Parser Dev Topology Skill

Parser development — grammar, bindings, tests, CLI, and docs

Version: 1.0.0
Patterns: pipeline, fan-out

## Orchestrator

Model: opus
Handles: develop-grammar, develop-binding, develop-tests, develop-cli, develop-docs, validate-all
Generates: commands/parser-dev.md

## Flow

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

## Gates

### Type Check
After: grammar-engineer
Before: test-engineer
Run: npx tsc --noEmit
On fail: bounce-back

### Example Validation
After: test-engineer
Run: scripts/validate-examples.sh
On fail: halt

## Triggers

### /grammar
Pattern: `/parser grammar`

### /binding
Pattern: `/parser binding`

### /test
Pattern: `/parser test`

### /cli
Pattern: `/parser cli`

### /docs
Pattern: `/parser docs`

### /validate
Pattern: `/parser validate`
