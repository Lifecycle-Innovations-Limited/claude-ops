#!/usr/bin/env bash
# Install the claude-ops background daemon as a launchd LaunchAgent.
#
# Invoked by the setup wizard's Step 2c. Generates the plist from template,
# writes the initial channel-independent services config, and bootstraps the
# agent. Idempotent — re-running re-bootstraps cleanly.
#
# Required env (any of the resolution paths below works):
#   CLAUDE_PLUGIN_ROOT       (set by Claude Code when invoking plugin code)
#   CLAUDE_PLUGIN_DATA_DIR   (optional; defaults to ~/.claude/plugins/data/ops-ops-marketplace)

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "skip: ops-daemon is macOS-only (launchd)" >&2
  echo "Linux users: see ops-daemon docs for a systemd unit example."
  exit 0
fi

# Resolve plugin root — never hardcode a version number.
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(ls -d "$HOME/.claude/plugins/cache/ops-marketplace/ops"/*/ 2>/dev/null | sort -V | tail -1)}"
if [[ -z "$PLUGIN_ROOT" || ! -d "$PLUGIN_ROOT" ]]; then
  echo "error: could not resolve CLAUDE_PLUGIN_ROOT" >&2
  exit 1
fi

DAEMON_SCRIPT="$PLUGIN_ROOT/scripts/ops-daemon.sh"
PLIST_TEMPLATE="$PLUGIN_ROOT/scripts/com.claude-ops.daemon.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/com.claude-ops.daemon.plist"
DATA_DIR="${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}"
LOG_DIR="$DATA_DIR/logs"
SERVICES_CONFIG="$DATA_DIR/daemon-services.json"

for f in "$DAEMON_SCRIPT" "$PLIST_TEMPLATE"; do
  [[ -f "$f" ]] || { echo "error: required plugin file not found: $f" >&2; exit 1; }
done

mkdir -p "$LOG_DIR"
chmod +x "$DAEMON_SCRIPT"

# Resolve bash 4+ (required for associative arrays in ops-daemon.sh).
# macOS ships bash 3; Homebrew installs bash 5 at /opt/homebrew/bin/bash.
BASH_PATH="/bin/bash"
if [[ -x /opt/homebrew/bin/bash ]]; then
  BASH_PATH="/opt/homebrew/bin/bash"
elif [[ -x /usr/local/bin/bash ]]; then
  BASH_PATH="/usr/local/bin/bash"
fi

# Generate plist from template.
sed -e "s|__DAEMON_SCRIPT_PATH__|$DAEMON_SCRIPT|g" \
    -e "s|__BASH_PATH__|$BASH_PATH|g" \
    -e "s|__PLUGIN_ROOT__|$PLUGIN_ROOT|g" \
    -e "s|__LOG_DIR__|$LOG_DIR|g" \
    -e "s|__HOME__|$HOME|g" \
    "$PLIST_TEMPLATE" > "$PLIST_DEST"

# Initial channel-independent services config.
# briefing-pre-warm pre-warms /ops:go cache every 2 min.
# memory-extractor idles until channels are configured.
# Heredoc is quoted so ${CLAUDE_PLUGIN_ROOT} is preserved literally for the
# daemon plist's env export to substitute at service-start time.
cat > "$SERVICES_CONFIG" <<'JSON'
{
  "services": {
    "briefing-pre-warm": {
      "enabled": true,
      "command": "${CLAUDE_PLUGIN_ROOT}/bin/ops-gather",
      "cron": "*/2 * * * *",
      "_note": "Pre-warms /ops:go cache. Runs every 2 minutes."
    },
    "memory-extractor": {
      "enabled": true,
      "command": "${CLAUDE_PLUGIN_ROOT}/scripts/ops-memory-extractor.sh",
      "cron": "*/30 * * * *",
      "health_file": "~/.claude/plugins/data/ops-ops-marketplace/memories/.health",
      "_note": "Idle until channels are configured; will extract profiles once whatsapp-bridge/gog are live."
    }
  }
}
JSON

# Remove legacy whatsapp-bridge keepalive if still present.
launchctl bootout "gui/$(id -u)/com.claude-ops.whatsapp-bridge-keepalive" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/com.claude-ops.whatsapp-bridge-keepalive.plist" 2>/dev/null || true

# Bootstrap the daemon.
launchctl bootout "gui/$(id -u)" "$PLIST_DEST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_DEST"

echo "✓ ops-daemon installed and bootstrapped"
echo "  plist:    $PLIST_DEST"
echo "  services: $SERVICES_CONFIG"
echo "  logs:     $LOG_DIR"
