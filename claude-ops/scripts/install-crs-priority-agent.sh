#!/usr/bin/env bash
# install-crs-priority-agent.sh — Install the CRS account-priority daemon as a
# launchd LaunchAgent (macOS) that ticks every 120s.
#
# Renders templates/com.claude-ops.crs-priority.plist with absolute paths to the
# wrapper + log dir, then bootstraps it under the current user's GUI session.
# Idempotent: re-running re-renders and reloads. Linux users: see the systemd
# hint printed below.
#
# Pre-req: the CRS admin password must be reachable by the daemon — either
#   export CRS_ADMIN_PASSWORD=…  (then it lives only in the plist env if you add it), or
#   bash "$PLUGIN_ROOT/lib/credential-store.sh" set CRS-Admin-<adminUser> "$USER" '<pw>'
# Config (base URL, adminUser, thresholds) lives in the rotator config.json "crs" block.

set -euo pipefail

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
[[ -d "$PLUGIN_ROOT" ]] || { echo "error: could not resolve CLAUDE_PLUGIN_ROOT" >&2; exit 1; }

WRAPPER="$PLUGIN_ROOT/scripts/account-rotation/crs-priority-daemon.sh"
DAEMON="$PLUGIN_ROOT/scripts/account-rotation/crs-priority-daemon.mjs"
PLIST_TEMPLATE="$PLUGIN_ROOT/templates/com.claude-ops.crs-priority.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/com.claude-ops.crs-priority.plist"
DATA_DIR="${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}"
LOG_DIR="$DATA_DIR/logs"

for f in "$WRAPPER" "$DAEMON" "$PLIST_TEMPLATE"; do
  [[ -f "$f" ]] || { echo "error: required file not found: $f" >&2; exit 1; }
done
chmod +x "$WRAPPER" "$DAEMON" 2>/dev/null || true

command -v node >/dev/null 2>&1 || { echo "error: node not found in PATH (need Node 20+)" >&2; exit 1; }

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "skip: launchd is macOS-only."
  echo "Linux: install a systemd user timer that runs every 120s:"
  echo "  ExecStart=/bin/bash $WRAPPER   (service, Type=oneshot)"
  echo "  OnBootSec=60s / OnUnitActiveSec=120s   (timer)"
  echo "Then: systemctl --user enable --now crs-priority.timer"
  exit 0
fi

mkdir -p "$LOG_DIR" "$(dirname "$PLIST_DEST")"

PLIST_TEMPLATE_PATH="$PLIST_TEMPLATE" \
WRAPPER_PATH="$WRAPPER" \
LOG_DIR_PATH="$LOG_DIR" \
CRS_HOME="$HOME" \
node -e \
  'const fs=require("fs");const e=(s)=>String(s??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");const t=fs.readFileSync(process.env.PLIST_TEMPLATE_PATH,"utf8");process.stdout.write(t.replace(/__WRAPPER_PATH__/g,e(process.env.WRAPPER_PATH)).replace(/__LOG_DIR__/g,e(process.env.LOG_DIR_PATH)).replace(/__HOME__/g,e(process.env.CRS_HOME)));' \
  > "$PLIST_DEST"

launchctl bootout "gui/$(id -u)/com.claude-ops.crs-priority" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_DEST"

echo "ok: crs-priority daemon installed"
echo "  plist:   $PLIST_DEST"
echo "  wrapper: $WRAPPER"
echo "  logs:    $LOG_DIR/crs-priority.log"
echo "  cadence: every 120s (RunAtLoad fires the first tick now)"
echo
echo "verify:   bash \"$WRAPPER\" --status   # prints current schedulable + utilization"
echo "uninstall: launchctl bootout \"gui/\$(id -u)/com.claude-ops.crs-priority\" && rm \"$PLIST_DEST\""
