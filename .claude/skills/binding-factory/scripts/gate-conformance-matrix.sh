#!/usr/bin/env bash
# Gate wrapper: conformance-matrix
# Enforces gate "conformance-matrix" on Task tool calls.
# Delegates to the conformance-gate tool script.
set -euo pipefail

# Gate runs after: conformance-checker
# Gate runs before: regression-guard
# On failure: bounce-back

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

GATE_RESULT=0
bash "$SCRIPT_DIR/conformance-gate.sh" "$@" || GATE_RESULT=$?

if [ "$GATE_RESULT" -ne 0 ]; then
  echo ""
  echo "Gate 'conformance-matrix' FAILED (exit code $GATE_RESULT)"
  echo "Action: bounce-back to conformance-checker"
  exit 1
fi

echo ""
echo "Gate 'conformance-matrix' PASSED"
exit 0
