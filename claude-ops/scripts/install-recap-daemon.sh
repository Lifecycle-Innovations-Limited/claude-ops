#!/usr/bin/env bash
# Install the claude-ops recap daemon as a launchd LaunchAgent.
#
# Invoked by the setup wizard's Step 2d.2. Generates the plist from template
# and bootstraps the agent. macOS-only — Linux uses systemd via /ops:recap
# configure.

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "skip: recap daemon is macOS-only (launchd)" >&2
  echo "Linux users: see /ops:recap configure for systemd unit example."
  exit 0
fi

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(ls -d "$HOME/.claude/plugins/cache/ops-marketplace/ops"/*/ 2>/dev/null | sort -V | tail -1)}"
if [[ -z "$PLUGIN_ROOT" || ! -d "$PLUGIN_ROOT" ]]; then
  echo "error: could not resolve CLAUDE_PLUGIN_ROOT" >&2
  exit 1
fi

DAEMON_SCRIPT="$PLUGIN_ROOT/scripts/recap/daemon.sh"
PLIST_TEMPLATE="$PLUGIN_ROOT/templates/com.claude-ops.recap-daemon.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/com.claude-ops.recap-daemon.plist"
DATA_DIR="${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}"
LOG_DIR="$DATA_DIR/logs"

RECAP_FILES=(
  "$DAEMON_SCRIPT"
  "$PLIST_TEMPLATE"
  "$PLUGIN_ROOT/scripts/recap/digest.sh"
  "$PLUGIN_ROOT/scripts/recap/marquee.sh"
  "$PLUGIN_ROOT/hooks/recap-capture.sh"
  "$PLUGIN_ROOT/hooks/recap-tool-activity.sh"
)
for f in "${RECAP_FILES[@]}"; do
  [[ -f "$f" ]] || { echo "error: required plugin file not found: $f" >&2; exit 1; }
done

mkdir -p "$LOG_DIR"
chmod +x "$DAEMON_SCRIPT" \
         "$PLUGIN_ROOT/scripts/recap/digest.sh" \
         "$PLUGIN_ROOT/scripts/recap/marquee.sh" \
         "$PLUGIN_ROOT/hooks/recap-capture.sh" \
         "$PLUGIN_ROOT/hooks/recap-tool-activity.sh"

# Resolve claude CLI bin dir (handles nvm, homebrew, system npm).
CLAUDE_BIN_DIR=$(dirname "$(command -v claude 2>/dev/null || echo /usr/local/bin/claude)")

sed -e "s|__DAEMON_SCRIPT_PATH__|$DAEMON_SCRIPT|g" \
    -e "s|__LOG_DIR__|$LOG_DIR|g" \
    -e "s|__HOME__|$HOME|g" \
    -e "s|__CLAUDE_BIN_DIR__|$CLAUDE_BIN_DIR|g" \
    "$PLIST_TEMPLATE" > "$PLIST_DEST"

launchctl bootout "gui/$(id -u)/com.claude-ops.recap-daemon" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_DEST"

echo "✓ recap-daemon installed and bootstrapped"
echo "  plist: $PLIST_DEST"
echo "  logs:  $LOG_DIR"
