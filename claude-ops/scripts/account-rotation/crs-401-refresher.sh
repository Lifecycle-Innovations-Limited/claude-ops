#!/bin/bash
# crs-401-refresher.sh — single-flight wrapper for crs-401-refresher.mjs.
# Invoked once-per-tick by launchd/systemd (recommended: every 300s — this
# reconciler proactively refreshes tokens ahead of a 30-minute expiry window,
# so a 5-minute cadence has ample margin without hammering CRS).
set -uo pipefail

source "$HOME/.claude/scripts/lib/once.sh" 2>/dev/null || true
type claude_once >/dev/null 2>&1 && { claude_once crs-401-refresher 60 || exit 0; }

DIR="$HOME/.claude/scripts/account-rotation"
LOG="$DIR/crs-401-refresher.log"
NODE="$(command -v node || echo /opt/homebrew/bin/node)"

export CLAUDE_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/plugins/marketplaces/ops-marketplace/claude-ops}"

if [ -f "$LOG" ]; then
  LOGSIZE="$(stat -c%s "$LOG" 2>/dev/null || stat -f%z "$LOG" 2>/dev/null || echo 0)"
  [ "$LOGSIZE" -gt 2097152 ] && mv "$LOG" "$LOG.1"
fi

"$NODE" "$DIR/crs-401-refresher.mjs" >> "$LOG" 2>&1
