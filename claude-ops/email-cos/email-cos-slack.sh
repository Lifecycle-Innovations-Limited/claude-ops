#!/usr/bin/env bash
# email-cos-slack.sh post "<text>"  |  email-cos-slack.sh history
# Self-DM notify/read over Slack using browser-session tokens (xoxc + xoxd cookie).
# Silently exits when EMAIL_COS_SLACK_ENABLE != "true" or tokens are absent.
set -euo pipefail

_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$_SCRIPT_DIR/lib/config.sh"

[ "${EMAIL_COS_SLACK_ENABLE:-false}" = "true" ] || exit 0

TOK="${SLACK_MCP_XOXC_TOKEN:-${SLACK_MCP_XOXC:-}}"
COOK="${SLACK_MCP_XOXD_TOKEN:-${SLACK_MCP_XOXD:-}}"
[ -z "$TOK" ] || [ -z "$COOK" ] && exit 0

SD="$EMAIL_COS_STATE_DIR"
CHAN_F="$SD/slack-dm-channel"
UID_VAL="${EMAIL_COS_SLACK_UID:-}"
api="https://slack.com/api"

chan="${EMAIL_COS_SLACK_DM_CHANNEL:-$(cat "$CHAN_F" 2>/dev/null || echo "")}"
if [ -z "$chan" ] && [ -n "$UID_VAL" ]; then
  chan=$(curl -s -m 10 "$api/conversations.open" \
    -H "Authorization: Bearer $TOK" \
    -H "Cookie: d=$COOK" \
    --data-urlencode "users=$UID_VAL" \
    | python3 -c "import json,sys;print(json.load(sys.stdin).get('channel',{}).get('id',''))" 2>/dev/null || echo "")
  [ -n "$chan" ] && echo "$chan" > "$CHAN_F"
fi
[ -z "$chan" ] && exit 0

case "${1:-post}" in
  post)
    curl -s -m 12 -o /dev/null "$api/chat.postMessage" \
      -H "Authorization: Bearer $TOK" \
      -H "Cookie: d=$COOK" \
      --data-urlencode "channel=$chan" \
      --data-urlencode "text=${2:-}" ;;
  history)
    curl -s -m 12 "$api/conversations.history?channel=$chan&limit=15" \
      -H "Authorization: Bearer $TOK" \
      -H "Cookie: d=$COOK" ;;
esac
