---
description: "Modular E2E QA infrastructure for MatchMat tournament management. Composable scenarios, parallel role agents, DB verification gates, regression watchlist."
---

# /e2e-stress

/e2e-stress

## Pipeline
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

## Agents
| Agent | Phase | Model | Role |
|-------|-------|-------|------|
| qa-organizer | 1 | sonnet | Tournament organizer — creates, imports, weighs, brackets, schedules, executes, completes |
| qa-admin | 1 | sonnet | System admin — approves tournaments, manages users, impersonation, security boundaries |
| qa-coach | 1 | sonnet | Team coach — roster, athlete tracking, live queue, bracket observation, realtime verification |
| qa-headref | 1 | sonnet | Head referee — arena management, referee coordination, match oversight, workload balancing |
| qa-referee | 1 | sonnet | Mat referee — match scoring (TKD/Judo/Karate panels), state transitions, walkover |
| qa-competitor | 1 | sonnet | Competing athlete — schedule, waiting room, bracket updates, results, security boundaries |
| db-verifier | - | sonnet | - |
| issue-collector | - | sonnet | - |
| qa-analyst | 9 | opus | - |
| topology-reviewer | 10 | opus | - |

