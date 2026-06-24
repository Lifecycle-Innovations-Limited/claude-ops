#!/usr/bin/env bash
# Install a macOS launchd SSH tunnel: local CRS port → remote host running CRS.
# Set CRS_TUNNEL_SSH_HOST (or legacy CRS_FRA_SSH_HOST) to your SSH target, e.g. user@relay.example.com

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "skip: CRS remote tunnel is macOS-only (launchd)" >&2
  exit 0
fi

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
LABEL="com.claude-ops.crs-fra-tunnel"
TPL="$PLUGIN_ROOT/templates/${LABEL}.plist"
DEST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/logs"
SSH_HOST="${CRS_TUNNEL_SSH_HOST:-${CRS_FRA_SSH_HOST:-}}"
LOCAL_PORT="${CRS_TUNNEL_LOCAL_PORT:-${CRS_FRA_LOCAL_PORT:-3005}}"
REMOTE_PORT="${CRS_TUNNEL_REMOTE_PORT:-${CRS_FRA_REMOTE_PORT:-3005}}"

if [[ -z "$SSH_HOST" ]]; then
  echo "error: set CRS_TUNNEL_SSH_HOST (SSH target for remote CRS, e.g. user@host)" >&2
  exit 1
fi

for f in "$TPL"; do
  [[ -f "$f" ]] || { echo "error: missing template $f" >&2; exit 1; }
done

mkdir -p "$(dirname "$DEST")" "$LOG_DIR"
sed \
  -e "s|__LOCAL_PORT__|$LOCAL_PORT|g" \
  -e "s|__REMOTE_PORT__|$REMOTE_PORT|g" \
  -e "s|__SSH_HOST__|$SSH_HOST|g" \
  -e "s|__LOG_DIR__|$LOG_DIR|g" \
  "$TPL" > "$DEST"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$DEST"

echo "✓ installed $LABEL → 127.0.0.1:$LOCAL_PORT via $SSH_HOST:$REMOTE_PORT"
