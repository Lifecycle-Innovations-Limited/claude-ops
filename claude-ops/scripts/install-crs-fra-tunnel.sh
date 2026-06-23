#!/usr/bin/env bash
# Install the macOS launchd tunnel that forwards local CRS traffic to FRA.

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "skip: CRS FRA tunnel is macOS-only (launchd)" >&2
  exit 0
fi

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
LABEL="com.claude-ops.crs-fra-tunnel"
TPL="$PLUGIN_ROOT/templates/${LABEL}.plist"
DEST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/logs"
SSH_HOST="${CRS_FRA_SSH_HOST:-fra-direct}"
LOCAL_PORT="${CRS_FRA_LOCAL_PORT:-3000}"
REMOTE_PORT="${CRS_FRA_REMOTE_PORT:-3005}"

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

echo "✓ installed $LABEL"
