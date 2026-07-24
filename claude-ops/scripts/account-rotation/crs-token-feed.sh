#!/usr/bin/env bash
# Single-flight wrapper for crs-token-feed.mjs (NEVER STACK rule).
# CRS client traffic uses the direct loopback relay.
# Managed by crs-client-route-sync.py; loaded plist drift is ignored.
set -euo pipefail
source "$HOME/.claude/scripts/lib/once.sh" 2>/dev/null || true
if command -v claude_once >/dev/null 2>&1; then
  claude_once crs-token-feed 60 || exit 0
fi
unset ANTHROPIC_BASE_URL
unset ANTHROPIC_API_BASE
unset ANTHROPIC_AUTH_TOKEN
unset CLAUDE_CODE_OAUTH_TOKEN
unset CRS_REFRESH_LOCK_LOCAL_ONLY

export CRS_CONTAINER="${CRS_CONTAINER:-crs-claude-relay-1}"
if [[ "$(uname -s)" == "Darwin" ]]; then
  DEFAULT_CRS_BASE="http://127.0.0.1:3005"
else
  DEFAULT_CRS_BASE="http://127.0.0.1:3005"
fi
export CRS_BASE="http://127.0.0.1:3005"
export CRS_CONFIG="${CRS_CONFIG:-$HOME/.claude/scripts/account-rotation/config.json}"

if [[ -z "${CRS_ADMIN_PASSWORD:-}" ]]; then
  INIT_JSON="${CRS_INIT_JSON:-$HOME/Projects/crs-sync/compose/mac/data/init.json}"
  if [[ -f "$INIT_JSON" ]]; then
    CRS_ADMIN_PASSWORD="$(/usr/bin/python3 -c "import json;print(json.load(open('$INIT_JSON'))['adminPassword'])" 2>/dev/null || true)"
    export CRS_ADMIN_PASSWORD
  fi
fi

export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:${PATH:-/usr/bin:/bin}"

if [[ -f "$HOME/.claude/scripts/account-rotation/gog-keyring-env.sh" ]]; then
  # shellcheck disable=SC1090
  source "$HOME/.claude/scripts/account-rotation/gog-keyring-env.sh" 2>/dev/null || true
fi
NODE="$(command -v node || echo /opt/homebrew/bin/node)"
"$NODE" "$HOME/.claude/scripts/account-rotation/crs-token-feed.mjs" "$@"
