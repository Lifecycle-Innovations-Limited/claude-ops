#!/usr/bin/env bash
# email-cos-tg-process.sh — drain Telegram approval callbacks.
# Invoked by email-cos-tg-process.timer (oneshot, ~every 60s).
# Sources the email-cos config (for EMAIL_COS_TG_CHAT_ID etc.) then delegates
# to email-cos-tg-approve.py process.
set -euo pipefail

# Source config if available.
CONFIG="${EMAIL_COS_CONFIG:-$HOME/.config/email-cos/config.sh}"
if [[ -f "$CONFIG" ]]; then
  set -a; . "$CONFIG"; set +a
fi

# Also load secrets env if present (TELEGRAM_BOT_TOKEN lives here on most installs).
if [[ -f "$HOME/.mcp-secrets.env" ]]; then
  set -a; . "$HOME/.mcp-secrets.env"; set +a
fi

export POCKET_STATE_DIR="${POCKET_STATE_DIR:-/var/lib/pocket-pipeline}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "$SCRIPT_DIR/email-cos-tg-approve.py" process
