#!/bin/bash
# crs-429-cooldown.sh — single-flight wrapper for crs-429-cooldown.mjs.
# Invoked once-per-tick by launchd/systemd (recommended: every 60s — this
# reconciler is meant to react fast to a real rate-limit hit).
set -uo pipefail

source "$HOME/.claude/scripts/lib/once.sh" 2>/dev/null || true
type claude_once >/dev/null 2>&1 && { claude_once crs-429-cooldown 20 || exit 0; }

DIR="$HOME/.claude/scripts/account-rotation"
LOG="$DIR/crs-429-cooldown.log"
NODE="$(command -v node || echo /opt/homebrew/bin/node)"

export CLAUDE_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/plugins/marketplaces/ops-marketplace/claude-ops}"

if [ -f "$LOG" ]; then
  LOGSIZE="$(stat -c%s "$LOG" 2>/dev/null || stat -f%z "$LOG" 2>/dev/null || echo 0)"
  [ "$LOGSIZE" -gt 2097152 ] && mv "$LOG" "$LOG.1"
fi

"$NODE" "$DIR/crs-429-cooldown.mjs" >> "$LOG" 2>&1
