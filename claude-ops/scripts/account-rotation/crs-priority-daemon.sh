#!/bin/bash
# crs-priority-daemon.sh — single-flight wrapper for crs-priority-daemon.mjs.
# Invoked once-per-tick by launchd/systemd (StartInterval/OnCalendar).
set -uo pipefail

if [ -f "$HOME/.claude/scripts/account-rotation/gog-keyring-env.sh" ]; then
  # shellcheck disable=SC1090
  source "$HOME/.claude/scripts/account-rotation/gog-keyring-env.sh" 2>/dev/null || true
fi

source "$HOME/.claude/scripts/lib/once.sh" 2>/dev/null || true
type claude_once >/dev/null 2>&1 && { claude_once crs-priority-daemon 60 || exit 0; }  # raised 30->60s throttle 2026-07-13 load-mit: reduce priority daemon tick pressure on dev-us (8CPU high load + CRS 429s) without losing floor logic

DIR="$HOME/.claude/scripts/account-rotation"
LOG="$DIR/crs-priority-daemon.log"
NODE="$(command -v node || echo /opt/homebrew/bin/node)"
CRS_CONTAINER="${CRS_CONTAINER:-crs-claude-relay-1}"
if [ "$(uname -s)" = "Darwin" ]; then
  DEFAULT_CRS_BASE="http://127.0.0.1:18091"
else
  DEFAULT_CRS_BASE="http://127.0.0.1:3005"
fi
export CRS_BASE="${CRS_BASE:-$DEFAULT_CRS_BASE}"

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
  # Dev-us / containerized Linux fallback: read from init.json (no env leak in some docker inspect paths)
  if [ -z "${CRS_ADMIN_PASSWORD:-}" ] && command -v docker >/dev/null 2>&1; then
    CRS_ADMIN_PASSWORD="$(docker exec "$CRS_CONTAINER" cat /app/data/init.json 2>/dev/null | python3 -c '
import sys,json
try:
  d=json.load(sys.stdin)
  pw=d.get("adminPassword") or d.get("admin_password") or ""
  print(pw)
except: pass
' 2>/dev/null || true)"
  fi
  export CRS_ADMIN_PASSWORD
fi

# GOG keyring password for non-TTY (systemd on dev-us, launchd background, gog gmail in magic-link path).
# Sources ~/.mcp-secrets.env (present on EC2 per doctrine) or explicit var. Matches Agents.md guidance.
# Prevents: "no TTY available for keyring file backend password prompt; set GOG_KEYRING_PASSWORD"
if [ -z "${GOG_KEYRING_PASSWORD:-}" ]; then
  if [ -r "$HOME/.config/profile.d/50-mcp-secrets.sh" ]; then
    # shellcheck disable=SC1090
    . "$HOME/.config/profile.d/50-mcp-secrets.sh" 2>/dev/null || true
  fi
  if [ -z "${GOG_KEYRING_PASSWORD:-}" ]; then
    GOG_KEYRING_PASSWORD="$(grep -E '^GOG_KEYRING_PASSWORD=' "$HOME/.mcp-secrets.env" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
  fi
  [ -n "${GOG_KEYRING_PASSWORD:-}" ] && export GOG_KEYRING_PASSWORD
  export GOG_KEYRING_BACKEND="${GOG_KEYRING_BACKEND:-file}"
fi

curl -sf -o /dev/null --max-time 5 "${CRS_BASE%/api}/health" || exit 0

HOLD="$HOME/.claude/state/crs-activate-all-hold"
if [ -f "$HOLD" ]; then
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) skip: activate-all hold active" >> "$LOG"
  exit 0
fi

if [ -f "$LOG" ]; then
  LOGSIZE="$(stat -c%s "$LOG" 2>/dev/null || stat -f%z "$LOG" 2>/dev/null || echo 0)"
  [ "$LOGSIZE" -gt 2097152 ] && mv "$LOG" "$LOG.1"
fi

"$NODE" "$DIR/crs-priority-daemon.mjs" "$@" >> "$LOG" 2>&1
