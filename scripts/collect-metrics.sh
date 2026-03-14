#!/usr/bin/env bash
# Metering: collect-metrics — Summarize pipeline run metrics
# Reads metrics/pipeline-events.jsonl (written by log-stage.sh hook)
# and outputs a summary line to metrics/runs.jsonl.
#
# Usage: collect-metrics.sh [run-id]
#   run-id defaults to a timestamp if not provided.

set -euo pipefail

METRICS_DIR="metrics"
EVENTS_FILE="$METRICS_DIR/pipeline-events.jsonl"
RUNS_FILE="$METRICS_DIR/runs.jsonl"
RUN_ID="${1:-$(date -u +"%Y%m%dT%H%M%SZ")}"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

mkdir -p "$METRICS_DIR"

# ---------------------------------------------------------------------------
# If no events file, note it and exit cleanly
# ---------------------------------------------------------------------------
if [ ! -f "$EVENTS_FILE" ]; then
  echo "No metrics data found at $EVENTS_FILE"
  exit 0
fi

if [ ! -s "$EVENTS_FILE" ]; then
  echo "Metrics file is empty: $EVENTS_FILE"
  exit 0
fi

# ---------------------------------------------------------------------------
# Calculate metrics from pipeline events
# ---------------------------------------------------------------------------

# Total stages = total lines in the events file
TOTAL_STAGES=$(wc -l < "$EVENTS_FILE" | tr -d ' ')

# Passed stages = events with "stage_complete"
PASSED_STAGES=$(grep -c '"stage_complete"' "$EVENTS_FILE" 2>/dev/null || echo "0")

# Failed stages = events with "stage_failed"
FAILED_STAGES=$(grep -c '"stage_failed"' "$EVENTS_FILE" 2>/dev/null || echo "0")

# Wall time: difference between first and last event timestamps
FIRST_TS=$(head -1 "$EVENTS_FILE" | jq -r '.timestamp // empty' 2>/dev/null || echo "")
LAST_TS=$(tail -1 "$EVENTS_FILE" | jq -r '.timestamp // empty' 2>/dev/null || echo "")

WALL_TIME=0
if [ -n "$FIRST_TS" ] && [ -n "$LAST_TS" ]; then
  # Convert ISO timestamps to epoch seconds
  # macOS date uses -j -f, Linux uses -d; try both
  if date -j -f "%Y-%m-%dT%H:%M:%SZ" "$FIRST_TS" +%s >/dev/null 2>&1; then
    # macOS
    FIRST_EPOCH=$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$FIRST_TS" +%s 2>/dev/null || echo "0")
    LAST_EPOCH=$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$LAST_TS" +%s 2>/dev/null || echo "0")
  else
    # Linux
    FIRST_EPOCH=$(date -d "$FIRST_TS" +%s 2>/dev/null || echo "0")
    LAST_EPOCH=$(date -d "$LAST_TS" +%s 2>/dev/null || echo "0")
  fi

  if [ "$FIRST_EPOCH" != "0" ] && [ "$LAST_EPOCH" != "0" ]; then
    WALL_TIME=$((LAST_EPOCH - FIRST_EPOCH))
    # Ensure non-negative
    if [ "$WALL_TIME" -lt 0 ]; then
      WALL_TIME=0
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Write summary line to runs.jsonl
# ---------------------------------------------------------------------------
SUMMARY="{\"run-id\":\"$RUN_ID\",\"timestamp\":\"$TIMESTAMP\",\"total-stages\":$TOTAL_STAGES,\"passed-stages\":$PASSED_STAGES,\"failed-stages\":$FAILED_STAGES,\"wall-time-seconds\":$WALL_TIME}"

echo "$SUMMARY" >> "$RUNS_FILE"

echo "Run $RUN_ID: $TOTAL_STAGES stages ($PASSED_STAGES passed, $FAILED_STAGES failed), ${WALL_TIME}s wall time"
echo "Written to $RUNS_FILE"
