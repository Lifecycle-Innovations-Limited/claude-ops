#!/bin/bash
# magic-link-autoloop.sh — single-flight wrapper for magic-link-autoloop.mjs.
# Invoked once-per-tick by launchd/systemd (recommended: every 600s — this
# reconciler dispatches a real unattended re-auth attempt per tick, so it
# should stay infrequent relative to magicLinkRetryCooldownMs).
set -uo pipefail

source "$HOME/.claude/scripts/lib/once.sh" 2>/dev/null || true
type claude_once >/dev/null 2>&1 && { claude_once magic-link-autoloop 60 || exit 0; }

DIR="$HOME/.claude/scripts/account-rotation"
LOG="$DIR/magic-link-autoloop.log"
NODE="$(command -v node || echo /opt/homebrew/bin/node)"

export CLAUDE_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/plugins/marketplaces/ops-marketplace/claude-ops}"

if [ -f "$LOG" ]; then
  LOGSIZE="$(stat -c%s "$LOG" 2>/dev/null || stat -f%z "$LOG" 2>/dev/null || echo 0)"
  [ "$LOGSIZE" -gt 2097152 ] && mv "$LOG" "$LOG.1"
fi

"$NODE" "$DIR/magic-link-autoloop.mjs" >> "$LOG" 2>&1
