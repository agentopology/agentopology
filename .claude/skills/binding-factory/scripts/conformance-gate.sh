#!/usr/bin/env bash
# Tool: conformance-gate — Scaffold all examples and verify output structure
# Called by gate-conformance-matrix.sh wrapper.
# Args: $1 = binding-name (e.g. "anthropic-sdk", "openai-sdk")

set -euo pipefail

BINDING_NAME="${1:-}"

if [ -z "$BINDING_NAME" ]; then
  echo "ERROR: binding-name argument required"
  echo "Usage: conformance-gate.sh <binding-name>"
  exit 1
fi

ERRORS=0
EXAMPLE_COUNT=0
EXAMPLE_PASS=0
TOTAL_FILES=0
ALL_PATHS=""

echo "=== Conformance Gate: $BINDING_NAME ==="

# ---------------------------------------------------------------------------
# Scaffold every example .at file
# ---------------------------------------------------------------------------
for atfile in examples/*.at; do
  [ ! -f "$atfile" ] && continue

  EXAMPLE_COUNT=$((EXAMPLE_COUNT + 1))
  BASENAME=$(basename "$atfile")

  OUTPUT=$(npx tsx src/cli/index.ts scaffold "$atfile" --target "$BINDING_NAME" --dry-run 2>&1) || true

  # Check if scaffold produced output and extract file count
  FILE_COUNT=$(echo "$OUTPUT" | grep -oE '[0-9]+ file' | grep -oE '[0-9]+' | head -1 || echo "0")

  if [ -z "$FILE_COUNT" ] || [ "$FILE_COUNT" = "0" ]; then
    echo "  FAIL: $BASENAME -> 0 files generated"
    ERRORS=$((ERRORS + 1))
    continue
  fi

  # Check for empty file entries
  EMPTY_COUNT=$(echo "$OUTPUT" | grep -c "(empty)" 2>/dev/null || echo "0")
  if [ "$EMPTY_COUNT" -gt 0 ]; then
    echo "  FAIL: $BASENAME -> $EMPTY_COUNT empty file(s)"
    ERRORS=$((ERRORS + 1))
    continue
  fi

  # Extract generated file paths (lines starting with + or spaces followed by +)
  PATHS=$(echo "$OUTPUT" | grep -E '^\s*\+' | sed 's/^\s*+ //' | sed 's/ (.*//' || true)

  if [ -n "$PATHS" ]; then
    ALL_PATHS="${ALL_PATHS}${PATHS}\n"
  fi

  TOTAL_FILES=$((TOTAL_FILES + FILE_COUNT))
  EXAMPLE_PASS=$((EXAMPLE_PASS + 1))
  echo "  PASS: $BASENAME -> $FILE_COUNT files"
done

if [ "$EXAMPLE_COUNT" -eq 0 ]; then
  echo "WARN: No example .at files found in examples/"
  exit 0
fi

# ---------------------------------------------------------------------------
# Check for path collisions across all examples
# ---------------------------------------------------------------------------
COLLISIONS=0

if [ -n "$ALL_PATHS" ]; then
  TOTAL_PATHS=$(printf "$ALL_PATHS" | grep -v '^$' | wc -l | tr -d ' ')
  UNIQUE_PATHS=$(printf "$ALL_PATHS" | grep -v '^$' | sort -u | wc -l | tr -d ' ')

  if [ "$TOTAL_PATHS" != "$UNIQUE_PATHS" ]; then
    COLLISIONS=$((TOTAL_PATHS - UNIQUE_PATHS))
    echo ""
    echo "  FAIL: $COLLISIONS path collision(s) detected ($TOTAL_PATHS total, $UNIQUE_PATHS unique)"
    ERRORS=$((ERRORS + 1))
  fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "Summary: ${EXAMPLE_PASS}/${EXAMPLE_COUNT} examples passed, ${TOTAL_FILES} total files, ${COLLISIONS} collisions"

if [ "$ERRORS" -gt 0 ]; then
  echo "RESULT: FAIL ($ERRORS issue(s))"
  exit 1
else
  echo "RESULT: PASS"
  exit 0
fi
