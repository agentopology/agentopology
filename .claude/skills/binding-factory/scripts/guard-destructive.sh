#!/usr/bin/env bash
# Hook: guard-destructive — fires on PreToolUse for Bash
# Blocks dangerous commands that could damage the repo or system.
set -euo pipefail

# The tool input is passed via stdin as JSON by Claude Code hooks.
# Read the command being executed.
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || echo "")

if [ -z "$COMMAND" ]; then
  exit 0
fi

# Block destructive patterns
BLOCKED_PATTERNS=(
  "rm -rf"
  "rm -fr"
  "git push --force"
  "git push -f"
  "git reset --hard"
  "git clean -f"
  "git checkout -- ."
  "npm publish"
  "DROP TABLE"
  "DROP DATABASE"
)

for pattern in "${BLOCKED_PATTERNS[@]}"; do
  if echo "$COMMAND" | grep -qi "$pattern"; then
    echo "BLOCKED: Command contains destructive pattern '$pattern'"
    echo "Command was: $COMMAND"
    exit 2
  fi
done

exit 0
