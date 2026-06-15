#!/usr/bin/env bash
# Single-flight wrapper for crs-token-feed.mjs (NEVER STACK rule).
set -euo pipefail
source "$HOME/.claude/scripts/lib/once.sh" 2>/dev/null || true
if command -v claude_once >/dev/null 2>&1; then
  claude_once crs-token-feed 60 || exit 0
fi
exec /usr/bin/node "$HOME/.claude/scripts/account-rotation/crs-token-feed.mjs" "$@"
