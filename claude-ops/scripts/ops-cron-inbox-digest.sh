#!/usr/bin/env bash
# ops-cron-inbox-digest.sh — 4h Inbox Digest cron job
# Scans unread WhatsApp messages + email, sends digest to Telegram
set -euo pipefail

DATA_DIR="${OPS_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}"
LOG_DIR="$DATA_DIR/logs"
LOG="$LOG_DIR/inbox-digest.log"
BRIDGE_DB="${WHATSAPP_BRIDGE_DB:-$HOME/.local/share/whatsapp-mcp/whatsapp-bridge/store/messages.db}"

mkdir -p "$LOG_DIR"
log() { printf '%s [inbox-digest] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" | tee -a "$LOG"; }

# ── Resolve Telegram token ────────────────────────────────────────────────
TELEGRAM_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
TELEGRAM_CHAT="${TELEGRAM_CHAT_ID:-}"

if [[ -z "$TELEGRAM_TOKEN" ]]; then
  TELEGRAM_TOKEN=$(doppler secrets get TELEGRAM_BOT_TOKEN --plain 2>/dev/null || true)
fi

# ── Gather WhatsApp unread count ──────────────────────────────────────────
WA_SUMMARY="WhatsApp: unavailable"
if [[ -f "$BRIDGE_DB" ]]; then
  SINCE=$(date -u -v-4H "+%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -d "4 hours ago" "+%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u "+%Y-%m-%dT%H:%M:%SZ")
  WA_RAW=$(sqlite3 "$BRIDGE_DB" "SELECT json_group_array(json_object('chat_jid',chat_jid,'sender',sender,'content',content,'timestamp',timestamp,'is_from_me',is_from_me)) FROM messages WHERE timestamp >= '${SINCE}' ORDER BY timestamp DESC LIMIT 20;" 2>/dev/null || echo "[]")
  WA_COUNT=$(echo "$WA_RAW" | python3 -c "
import json, sys
msgs = json.load(sys.stdin)
# Filter out messages from owner (is_from_me=true)
unread = [m for m in msgs if not m.get('is_from_me', False)]
print(len(unread))
" 2>/dev/null || echo "0")

  if [[ "$WA_COUNT" == "0" ]]; then
    WA_SUMMARY="WhatsApp: geen nieuwe berichten"
  else
    WA_SENDERS=$(echo "$WA_RAW" | python3 -c "
import json, sys
msgs = json.load(sys.stdin)
unread = [m for m in msgs if not m.get('is_from_me', False)]
senders = list({m.get('contact_name', m.get('from', 'unknown')) for m in unread})[:5]
print(', '.join(senders))
" 2>/dev/null || echo "unknown")
    WA_SUMMARY="WhatsApp: $WA_COUNT unread from $WA_SENDERS"
  fi
fi

# ── Gather email unread count via gog ────────────────────────────────────
EMAIL_SUMMARY="Email: unavailable"
GOG_RAW=$(command -v gog &>/dev/null && gog gmail search "in:inbox after:$(date -u -v-4H +%Y/%m/%d 2>/dev/null || date -u -d '4 hours ago' +%Y/%m/%d 2>/dev/null || date -u +%Y/%m/%d)" --json 2>/dev/null || echo "[]")
EMAIL_COUNT=$(echo "$GOG_RAW" | python3 -c "
import json, sys
data = json.load(sys.stdin)
print(len(data) if isinstance(data, list) else 0)
" 2>/dev/null || echo "0")

if [[ "$EMAIL_COUNT" == "0" ]]; then
  EMAIL_SUMMARY="Email: geen nieuwe berichten"
else
  EMAIL_SUBJECTS=$(echo "$GOG_RAW" | python3 -c "
import json, sys
data = json.load(sys.stdin)
subjects = [m.get('subject', '')[:50] for m in (data if isinstance(data, list) else [])[:3]]
print('\n  - '.join(subjects))
" 2>/dev/null || echo "")
  EMAIL_SUMMARY="Email: $EMAIL_COUNT in inbox"
  [[ -n "$EMAIL_SUBJECTS" ]] && EMAIL_SUMMARY="$EMAIL_SUMMARY
  - $EMAIL_SUBJECTS"
fi

# ── Build digest ──────────────────────────────────────────────────────────
TIMESTAMP=$(TZ="Europe/Amsterdam" date "+%H:%M %Z")
DIGEST="*4h Inbox Digest* ($TIMESTAMP)

$WA_SUMMARY
$EMAIL_SUMMARY"

# ── Check if anything actionable ─────────────────────────────────────────
if [[ "$WA_SUMMARY" == *"geen nieuwe berichten"* ]] && [[ "$EMAIL_SUMMARY" == *"geen nieuwe berichten"* ]]; then
  log "No new messages — skipping Telegram notification (HEARTBEAT_OK)"
  exit 0
fi

log "Sending digest: WA=$WA_COUNT email=$EMAIL_COUNT"

# ── Send to Telegram ──────────────────────────────────────────────────────
if [[ -n "$TELEGRAM_TOKEN" ]]; then
  curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage" \
    -H "Content-Type: application/json" \
    -d "{\"chat_id\": \"$TELEGRAM_CHAT\", \"text\": $(echo "$DIGEST" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'), \"parse_mode\": \"Markdown\"}" \
    >> "$LOG" 2>&1
  log "Digest sent to Telegram chat=$TELEGRAM_CHAT"
else
  log "WARN: TELEGRAM_BOT_TOKEN not set — digest not sent"
  echo "$DIGEST"
fi

log "HEARTBEAT_OK"
