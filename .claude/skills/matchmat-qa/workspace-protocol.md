# Workspace Protocol

## Directory Structure
- screenshots
- snapshots
- logs
- db-checks
- reports

## Read/Write Rules
### Qa Organizer
- Reads: domains/tournament-lifecycle.md, domains/registrations-and-roster.md, domains/weigh-in.md, domains/brackets-and-draw.md, domains/arena-and-scheduling.md, domains/match-execution.md
- Writes: workspace/reports/organizer-report.md, workspace/screenshots/, workspace/logs/organizer.jsonl

### Qa Admin
- Reads: domains/auth-and-rbac.md, domains/tournament-lifecycle.md
- Writes: workspace/reports/admin-report.md, workspace/screenshots/, workspace/logs/admin.jsonl

### Qa Coach
- Reads: domains/registrations-and-roster.md, domains/match-execution.md, domains/notifications-realtime-platform.md
- Writes: workspace/reports/coach-report.md, workspace/screenshots/, workspace/logs/coach.jsonl

### Qa Headref
- Reads: domains/referee-and-staff.md, domains/arena-and-scheduling.md, domains/match-execution.md
- Writes: workspace/reports/headref-report.md, workspace/screenshots/, workspace/logs/headref.jsonl

### Qa Referee
- Reads: domains/match-execution.md, domains/referee-and-staff.md
- Writes: workspace/reports/referee-report.md, workspace/screenshots/, workspace/logs/referee.jsonl

### Qa Competitor
- Reads: domains/auth-and-rbac.md, domains/notifications-realtime-platform.md
- Writes: workspace/reports/competitor-report.md, workspace/screenshots/, workspace/logs/competitor.jsonl

### Db Verifier
- Reads: domains/architecture.md
- Writes: workspace/db-checks/verification.md, workspace/logs/db-verifier.jsonl

### Issue Collector
- Writes: workspace/reports/issues.md, workspace/logs/issue-collector.jsonl

### Qa Analyst
- Reads: workspace/logs/, workspace/reports/, workspace/db-checks/, workspace/screenshots/
- Writes: workspace/reports/final-analysis.md

### Topology Reviewer
- Reads: workspace/logs/, workspace/reports/final-analysis.md, runs/qa-metrics/
- Writes: workspace/reports/topology-review.md, docs/qa/topology-improvements.md

