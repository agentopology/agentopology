---
name: matchmat-qa
description: "Modular E2E QA infrastructure for MatchMat tournament management. Composable scenarios, parallel role agents, DB verification gates, regression watchlist."
version: "2.0.0"
topology: matchmat-qa
patterns:
  - pipeline
  - fan-out
  - supervisor
entry: commands/e2e-tournament.md
---

# Matchmat Qa Topology Skill

Modular E2E QA infrastructure for MatchMat tournament management. Composable scenarios, parallel role agents, DB verification gates, regression watchlist.

Version: 2.0.0
Patterns: pipeline, fan-out, supervisor

Domain: tournament-management

## Orchestrator

Model: opus
Handles: intake, route-scenario, db-verify, generate-report
Generates: commands/e2e-tournament.md

### Outputs
- mode: full | single-role | stress | security | import

## Flow

- intake -> route-scenario
- route-scenario -> qa-organizer
- route-scenario -> qa-admin
- route-scenario -> qa-coach
- route-scenario -> qa-headref
- route-scenario -> qa-referee
- route-scenario -> qa-competitor
- qa-organizer -> db-verifier
- qa-admin -> db-verifier
- qa-coach -> db-verifier
- qa-headref -> db-verifier
- qa-referee -> db-verifier
- qa-competitor -> db-verifier
- db-verifier -> issue-collector
- issue-collector -> generate-report [when issue-collector.result == pass]
- issue-collector -> qa-organizer [when issue-collector.result == issues-found] [max 3]
- issue-collector -> generate-report [when issue-collector.result == blocked]
- generate-report -> qa-analyst
- qa-analyst -> topology-reviewer

## Triggers

### /e2e-tournament
Pattern: `/e2e-tournament`

### /e2e-role
Pattern: `/e2e-role <ROLE>`
Argument: ROLE

### /e2e-stress
Pattern: `/e2e-stress`

### /e2e-security
Pattern: `/e2e-security`

### /e2e-import
Pattern: `/e2e-import`
