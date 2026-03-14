#!/usr/bin/env bash
# Hook: log-stage-complete — fires on AgentStop
# Logs stage completion to the metrics directory for observability.
set -euo pipefail

METRICS_DIR="metrics"
mkdir -p "$METRICS_DIR"

# Read hook payload from stdin
INPUT=$(cat)
AGENT_NAME=$(echo "$INPUT" | jq -r '.agent_name // "unknown"' 2>/dev/null || echo "unknown")
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Append stage completion event as JSONL
echo "{\"event\":\"stage_complete\",\"agent\":\"$AGENT_NAME\",\"timestamp\":\"$TIMESTAMP\"}" >> "$METRICS_DIR/pipeline-events.jsonl"
