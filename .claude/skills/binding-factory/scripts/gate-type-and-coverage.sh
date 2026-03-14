#!/usr/bin/env bash
# Gate wrapper: type-and-coverage
# Enforces gate "type-and-coverage" on Task tool calls.
# Delegates to the binding-gate tool script.
set -euo pipefail

# Gate runs after: code-generator
# Gate runs before: binding-review
# On failure: bounce-back

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

GATE_RESULT=0
bash "$SCRIPT_DIR/binding-gate.sh" "$@" || GATE_RESULT=$?

if [ "$GATE_RESULT" -ne 0 ]; then
  echo ""
  echo "Gate 'type-and-coverage' FAILED (exit code $GATE_RESULT)"
  echo "Action: bounce-back to code-generator"
  exit 1
fi

echo ""
echo "Gate 'type-and-coverage' PASSED"
exit 0
