#!/usr/bin/env bash
# Tool: binding-gate — Type check + AST coverage verification for generated binding
# Called by gate-type-and-coverage.sh wrapper.
# Args: $1 = binding-name (e.g. "anthropic-sdk", "openai-sdk")

set -euo pipefail

BINDING_NAME="${1:-}"

if [ -z "$BINDING_NAME" ]; then
  echo "ERROR: binding-name argument required"
  echo "Usage: binding-gate.sh <binding-name>"
  exit 1
fi

BINDING_FILE="src/bindings/${BINDING_NAME}.ts"
AST_FILE="src/parser/ast.ts"

if [ ! -f "$BINDING_FILE" ]; then
  echo "ERROR: Binding file not found: $BINDING_FILE"
  exit 1
fi

if [ ! -f "$AST_FILE" ]; then
  echo "ERROR: AST file not found: $AST_FILE"
  exit 1
fi

ERRORS=0
TSC_STATUS="PASS"

# ---------------------------------------------------------------------------
# Check 1: TypeScript compilation
# ---------------------------------------------------------------------------
echo "[1/3] Running tsc --noEmit..."
if npx tsc --noEmit 2>&1; then
  echo "  tsc: PASS"
else
  echo "  tsc: FAIL"
  TSC_STATUS="FAIL"
  ERRORS=$((ERRORS + 1))
fi

# ---------------------------------------------------------------------------
# Check 2: AST coverage — every exported interface/type in ast.ts must appear
# ---------------------------------------------------------------------------
echo "[2/3] Checking AST type coverage..."

# Extract all exported interface and type names from ast.ts
AST_TYPES=$(grep -E '^export (interface|type) ' "$AST_FILE" \
  | sed -E 's/^export (interface|type) ([A-Za-z_][A-Za-z0-9_]*).*/\2/')

TOTAL=0
COVERED=0
MISSING_LIST=""

for typename in $AST_TYPES; do
  TOTAL=$((TOTAL + 1))
  if grep -q "$typename" "$BINDING_FILE"; then
    COVERED=$((COVERED + 1))
  else
    MISSING_LIST="${MISSING_LIST}  - ${typename}\n"
  fi
done

if [ -n "$MISSING_LIST" ]; then
  echo "  FAIL: Missing AST types in $BINDING_FILE:"
  printf "$MISSING_LIST"
  ERRORS=$((ERRORS + 1))
else
  echo "  PASS: All AST types referenced"
fi

# ---------------------------------------------------------------------------
# Check 3: Unused imports — imported types that appear only once (the import)
# ---------------------------------------------------------------------------
echo "[3/3] Checking for unused imports..."

# Extract imported type names from "import type { ... }" lines
IMPORTS=$(grep -oE 'import type \{[^}]+\}' "$BINDING_FILE" \
  | sed 's/import type {//;s/}//;s/,/\n/g' \
  | tr -d ' ' \
  | grep -v '^$' \
  | sort -u)

UNUSED_LIST=""

for imp in $IMPORTS; do
  [ -z "$imp" ] && continue
  # Count occurrences in the file (including the import line itself)
  COUNT=$(grep -c "$imp" "$BINDING_FILE" 2>/dev/null || echo "0")
  if [ "$COUNT" -le 1 ]; then
    UNUSED_LIST="${UNUSED_LIST}  - ${imp}\n"
  fi
done

if [ -n "$UNUSED_LIST" ]; then
  echo "  FAIL: Unused imports in $BINDING_FILE:"
  printf "$UNUSED_LIST"
  ERRORS=$((ERRORS + 1))
else
  echo "  PASS: All imports used"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "Summary: ${COVERED}/${TOTAL} AST types covered, tsc: ${TSC_STATUS}"

if [ "$ERRORS" -gt 0 ]; then
  echo "RESULT: FAIL ($ERRORS check(s) failed)"
  exit 1
else
  echo "RESULT: PASS"
  exit 0
fi
