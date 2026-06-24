#!/bin/bash
# crs-priority-daemon.sh — single-flight wrapper for crs-priority-daemon.mjs.
# Invoked once-per-tick by launchd/systemd (StartInterval/OnCalendar).
set -uo pipefail

source "$HOME/.claude/scripts/lib/once.sh" 2>/dev/null || true
type claude_once >/dev/null 2>&1 && { claude_once crs-priority-daemon 30 || exit 0; }

DIR="$HOME/.claude/scripts/account-rotation"
LOG="$DIR/crs-priority-daemon.log"
NODE="$(command -v node || echo /opt/homebrew/bin/node)"
CRS_CONTAINER="${CRS_CONTAINER:-crs-claude-relay-1}"

export CLAUDE_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/plugins/marketplaces/ops-marketplace/claude-ops}"
CRED_STORE="$CLAUDE_PLUGIN_ROOT/lib/credential-store.sh"
KEYCHAIN_ACCOUNT="${CLAUDE_ROTATOR_KEYCHAIN_ACCOUNT:-$USER}"

if [ -z "${CRS_ADMIN_PASSWORD:-}" ]; then
  if [ -f "$CRED_STORE" ]; then
    CRS_ADMIN_PASSWORD="$(bash "$CRED_STORE" get "CRS-Admin-cradmin" "$KEYCHAIN_ACCOUNT" 2>/dev/null || true)"
  fi
  if [ -z "${CRS_ADMIN_PASSWORD:-}" ] && command -v security >/dev/null 2>&1; then
    CRS_ADMIN_PASSWORD="$(security find-generic-password -a "$USER" -s CRS-Admin-cradmin -w 2>/dev/null || true)"
  fi
  if [ -z "${CRS_ADMIN_PASSWORD:-}" ] && command -v docker >/dev/null 2>&1; then
    CRS_ADMIN_PASSWORD="$(docker inspect "$CRS_CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | sed -n 's/^ADMIN_PASSWORD=//p' | head -1 || true)"
  fi
  export CRS_ADMIN_PASSWORD
fi

curl -sf -o /dev/null --max-time 5 http://127.0.0.1:3005/health || exit 0

if [ -f "$LOG" ]; then
  LOGSIZE="$(stat -c%s "$LOG" 2>/dev/null || stat -f%z "$LOG" 2>/dev/null || echo 0)"
  [ "$LOGSIZE" -gt 2097152 ] && mv "$LOG" "$LOG.1"
fi

"$NODE" "$DIR/crs-priority-daemon.mjs" >> "$LOG" 2>&1
