#!/usr/bin/env bash
# Hook: cache-web-fetch — fires on PostToolUse for WebFetch
# Caches fetched content into domains/api-docs/ so retry loops don't re-fetch.
set -euo pipefail

CACHE_DIR="domains/api-docs"
mkdir -p "$CACHE_DIR"

# Read hook payload from stdin
INPUT=$(cat)
URL=$(echo "$INPUT" | jq -r '.tool_input.url // empty' 2>/dev/null || echo "")
RESULT=$(echo "$INPUT" | jq -r '.tool_result // empty' 2>/dev/null || echo "")

if [ -z "$URL" ] || [ -z "$RESULT" ]; then
  exit 0
fi

# Create a filename from the URL (sanitize special chars)
FILENAME=$(echo "$URL" | sed 's|https\?://||; s|[^a-zA-Z0-9._-]|_|g' | cut -c1-100)
CACHE_FILE="$CACHE_DIR/${FILENAME}.md"

# Only cache if not already cached
if [ ! -f "$CACHE_FILE" ]; then
  echo "# Cached: $URL" > "$CACHE_FILE"
  echo "# Fetched: $(date -u +"%Y-%m-%dT%H:%M:%SZ")" >> "$CACHE_FILE"
  echo "" >> "$CACHE_FILE"
  echo "$RESULT" >> "$CACHE_FILE"
fi
