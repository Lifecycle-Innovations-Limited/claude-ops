#!/usr/bin/env bash
# email-cos-notify.sh "<text>"
# Fans out a notification to every ENABLED channel (Telegram, Slack).
# WhatsApp confirmation is handled by email-cos-approve-agent.py directly.
# Each channel is silently skipped when not configured or token absent.
set -euo pipefail

_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$_SCRIPT_DIR/lib/config.sh"

MSG="${1:-}"
[ -z "$MSG" ] && exit 0

# ── Telegram ─────────────────────────────────────────────────────────────────
if [ "${EMAIL_COS_TG_ENABLE:-false}" = "true" ] \
    && [ -n "${TELEGRAM_BOT_TOKEN:-}" ] \
    && [ -n "${EMAIL_COS_TG_CHAT_ID:-}" ]; then
  curl -s -m 15 -o /dev/null \
    "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${EMAIL_COS_TG_CHAT_ID}" \
    --data-urlencode "disable_web_page_preview=true" \
    --data-urlencode "text=$MSG" || true
fi

# ── Slack ─────────────────────────────────────────────────────────────────────
if [ "${EMAIL_COS_SLACK_ENABLE:-false}" = "true" ]; then
  "$_SCRIPT_DIR/email-cos-slack.sh" post "$MSG" >/dev/null 2>&1 || true
fi
