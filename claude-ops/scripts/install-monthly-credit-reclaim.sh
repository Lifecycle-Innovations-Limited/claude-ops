#!/usr/bin/env bash
# install-monthly-credit-reclaim.sh — Install the monthly Anthropic credit
# reclaim cron as a launchd LaunchAgent.
#
# Renders templates/com.claude-ops.monthly-credit-reclaim.plist with the
# absolute paths to node + the wrapper script, then bootstraps it under the
# current user's GUI session. macOS-only.

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "skip: monthly-credit-reclaim cron is macOS-only (launchd)" >&2
  echo "Linux users: install equivalent systemd timer (OnCalendar=*-*-01 09:00:00)."
  exit 0
fi

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
if [[ -z "$PLUGIN_ROOT" || ! -d "$PLUGIN_ROOT" ]]; then
  echo "error: could not resolve CLAUDE_PLUGIN_ROOT" >&2
  exit 1
fi

SCRIPT_PATH="$PLUGIN_ROOT/scripts/account-rotation/monthly-credit-reclaim.mjs"
PLIST_TEMPLATE="$PLUGIN_ROOT/templates/com.claude-ops.monthly-credit-reclaim.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/com.claude-ops.monthly-credit-reclaim.plist"
DATA_DIR="${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}"
LOG_DIR="$DATA_DIR/logs"

for f in "$SCRIPT_PATH" "$PLIST_TEMPLATE"; do
  [[ -f "$f" ]] || { echo "error: required file not found: $f" >&2; exit 1; }
done

NODE_BIN="$(command -v node 2>/dev/null || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "error: node not found in PATH" >&2
  exit 1
fi

mkdir -p "$LOG_DIR" "$(dirname "$PLIST_DEST")"

sed -e "s|__SCRIPT_PATH__|$SCRIPT_PATH|g" \
    -e "s|__LOG_DIR__|$LOG_DIR|g" \
    -e "s|__HOME__|$HOME|g" \
    -e "s|__NODE_BIN__|$NODE_BIN|g" \
    "$PLIST_TEMPLATE" \
  | SLACK_WEBHOOK_URL="${SLACK_WEBHOOK_URL:-}" "$NODE_BIN" -e \
    'const fs=require("fs");const t=fs.readFileSync(0,"utf8");const e=s=>s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");process.stdout.write(t.replace("__SLACK_WEBHOOK_URL__",e(process.env.SLACK_WEBHOOK_URL||"")));' \
    > "$PLIST_DEST"

launchctl bootout "gui/$(id -u)/com.claude-ops.monthly-credit-reclaim" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_DEST"

echo "ok: monthly-credit-reclaim installed"
echo "  plist:  $PLIST_DEST"
echo "  script: $SCRIPT_PATH"
echo "  logs:   $LOG_DIR/monthly-credit-reclaim-*.log"
echo "  next run: day 1 of next month, 09:00 local time"
if [[ -z "${SLACK_WEBHOOK_URL:-}" ]]; then
  echo "  note: SLACK_WEBHOOK_URL was unset — Slack summary is skipped unless you export it and re-run this installer."
fi
