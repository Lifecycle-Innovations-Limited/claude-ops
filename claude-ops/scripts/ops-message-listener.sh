#!/usr/bin/env bash
# ops-message-listener.sh — Poll-based message listener (replaces OpenClaw WebSocket gateway)
# Supervised by ops-daemon. Polls WhatsApp (Baileys bridge messages.db) + Telegram every 60s.
# New non-owner messages → written to inbox-queue.json for /ops:inbox to consume.
# Health status written to listener-health.txt for daemon monitoring.
set -euo pipefail

DATA_DIR="${OPS_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}"
LOG_DIR="$DATA_DIR/logs"
LOG="$LOG_DIR/message-listener.log"
QUEUE_FILE="$DATA_DIR/inbox-queue.json"
HEALTH_FILE="$DATA_DIR/listener-health.txt"
STATE_FILE="$DATA_DIR/tg-orchestrator-state.json"
BRIDGE_DB="${WHATSAPP_BRIDGE_DB:-$HOME/.local/share/whatsapp-mcp/whatsapp-bridge/store/messages.db}"
POLL_INTERVAL="${OPS_LISTENER_POLL_INTERVAL:-60}"
TG_TARGET_SESSION="${TELEGRAM_TARGET_SESSION:-ebfd4ba2}"

mkdir -p "$LOG_DIR" "$DATA_DIR"

log() { printf '%s [listener] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" | tee -a "$LOG"; }

write_health() {
  local status="$1" detail="${2:-}"
  printf 'status=%s\ntimestamp=%s\ndetail=%s\n' \
    "$status" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$detail" > "$HEALTH_FILE"
}

# ── Initialize queue file ─────────────────────────────────────────────────
if [[ ! -f "$QUEUE_FILE" ]]; then
  echo '{"messages": [], "last_updated": null}' > "$QUEUE_FILE"
fi

# ── Load last-seen state ──────────────────────────────────────────────────
load_state() {
  python3 -c "
import json, os
f = '$STATE_FILE'
if os.path.exists(f):
    try:
        data = json.load(open(f))
        offset = data.get('offset', 0)
        print(str(offset))
    except:
        print('0')
else:
    print('0')
" 2>/dev/null || echo '0'
}

save_state() {
  local tg_offset="$1"
  python3 -c "
import json
data = {'offset': int($tg_offset)}
json.dump(data, open('$STATE_FILE', 'w'))
" 2>/dev/null || true
}

# ── Append messages to queue ──────────────────────────────────────────────
# SECURITY: JSON payload piped via stdin (NEVER interpolated into source) to prevent
# Python code injection from untrusted Telegram/WhatsApp message content.
append_to_queue() {
  local new_msgs_json="$1"
  QUEUE_FILE="$QUEUE_FILE" printf '%s' "$new_msgs_json" | python3 -c "
import json, os, sys
from datetime import datetime, timezone

queue_file = os.environ['QUEUE_FILE']
try:
    with open(queue_file) as f:
        queue = json.load(f)
except Exception:
    queue = {'messages': [], 'last_updated': None}

try:
    new_msgs = json.load(sys.stdin)
except Exception:
    new_msgs = []

if not isinstance(new_msgs, list):
    new_msgs = []

existing_ids = {m.get('id') for m in queue['messages']}
added = 0
for msg in new_msgs:
    if not isinstance(msg, dict):
        continue
    if msg.get('id') not in existing_ids:
        queue['messages'].append(msg)
        existing_ids.add(msg.get('id'))
        added += 1

queue['messages'] = queue['messages'][-200:]
queue['last_updated'] = datetime.now(timezone.utc).isoformat()

with open(queue_file, 'w') as f:
    json.dump(queue, f, indent=2)
print(added)
" 2>/dev/null || echo 0
}

# ── Dispatch Telegram messages to target session ───────────────────────────
# SECURITY: JSON piped via stdin; output is NUL-delimited so newlines in message
# text cannot smuggle additional dispatch lines or arguments.
dispatch_telegram() {
  local new_msgs_json="$1"
  printf '%s' "$new_msgs_json" | python3 -c "
import json, sys, re
try:
    msgs = json.load(sys.stdin)
except Exception:
    sys.exit(0)
if not isinstance(msgs, list):
    sys.exit(0)
MAX_LEN = 4000
SAFE = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f]')
for msg in msgs:
    if not isinstance(msg, dict):
        continue
    from_user = str(msg.get('from', 'unknown'))[:64]
    text = str(msg.get('text', ''))[:MAX_LEN]
    from_user = SAFE.sub('', from_user).replace('\x00', '')
    text = SAFE.sub('', text).replace('\x00', '')
    sys.stdout.write(f'telegram:{from_user}:{text}\x00')
" 2>/dev/null | while IFS= read -r -d '' dispatch_line; do
    if [[ -n "$dispatch_line" && ${#dispatch_line} -lt 8192 ]]; then
      ops-bg send "$TG_TARGET_SESSION" "$dispatch_line" 2>/dev/null || log "dispatch failed (len=${#dispatch_line})"
    fi
  done
}

# ── Poll WhatsApp ─────────────────────────────────────────────────────────
poll_whatsapp() {
  local since="$1"
  if [[ ! -f "$BRIDGE_DB" ]]; then
    echo "[]"
    return
  fi

  local raw
  raw=$(sqlite3 "$BRIDGE_DB" "SELECT json_group_array(json_object('id',rowid,'chat_jid',chat_jid,'sender',sender,'content',content,'timestamp',timestamp,'is_from_me',is_from_me)) FROM (SELECT rowid, chat_jid, sender, content, timestamp, is_from_me FROM messages WHERE timestamp > '${since:-1970-01-01}' ORDER BY timestamp DESC LIMIT 20);" 2>/dev/null || echo "[]")

  # Filter: only non-owner (is_from_me=false) messages
  echo "$raw" | python3 -c "
import json, sys
msgs = json.load(sys.stdin)
def _from_me(m):
    v = m.get('is_from_me', False)
    return v is True or v == 1
filtered = []
for m in msgs:
    if not _from_me(m):
        filtered.append({
            'id': str(m.get('id', m.get('rowid', ''))),  # rowid from sqlite
            'channel': 'whatsapp',
            'from': m.get('sender') or m.get('contact_name') or m.get('from', ''),
            'text': m.get('content') or m.get('body') or m.get('text', ''),
            'timestamp': m.get('timestamp', ''),
            'raw': m
        })
print(json.dumps(filtered))
" 2>/dev/null || echo "[]"
}

# ── Poll Telegram ─────────────────────────────────────────────────────────
poll_telegram() {
  local since_update_id="${1:-0}"
  local tg_token="${TELEGRAM_BOT_TOKEN:-}"

  if [[ -z "$tg_token" ]]; then
    tg_token=$(doppler secrets get TELEGRAM_BOT_TOKEN --plain 2>/dev/null || true)
  fi
  [[ -z "$tg_token" ]] && echo "[]" && return

  local offset=$(( since_update_id + 1 ))
  local raw
  raw=$(curl -s "https://api.telegram.org/bot${tg_token}/getUpdates?offset=${offset}&limit=20&timeout=5" 2>/dev/null || echo '{"ok":false}')

  echo "$raw" | python3 -c "
import json, sys
data = json.load(sys.stdin)
if not data.get('ok'):
    print('[]')
    sys.exit(0)
filtered = []
for upd in data.get('result', []):
    msg = upd.get('message', {})
    sender = msg.get('from', {})
    # Skip owner's own messages (add TELEGRAM_OWNER_ID to env to filter by user_id)
    owner_id = '${TELEGRAM_OWNER_ID:-}'
    if owner_id and str(sender.get('id', '')) == owner_id:
        continue
    if msg:
        filtered.append({
            'id': str(upd.get('update_id', '')),
            'channel': 'telegram',
            'from': sender.get('username', sender.get('first_name', 'unknown')),
            'text': msg.get('text', ''),
            'timestamp': str(msg.get('date', '')),
            'update_id': upd.get('update_id', 0),
            'raw': msg
        })
print(json.dumps(filtered))
" 2>/dev/null || echo "[]"
}

# ── Trap for clean shutdown ───────────────────────────────────────────────
cleanup() {
  log "SHUTDOWN received — writing final health"
  write_health "stopped" "SIGTERM received"
  exit 0
}
trap cleanup SIGTERM SIGINT

# ── Main poll loop ────────────────────────────────────────────────────────
log "START: ops-message-listener polling every ${POLL_INTERVAL}s"
write_health "polling" "starting"

# Load initial state
TG_LAST_UPDATE_ID=$(load_state)
TG_LAST_UPDATE_ID="${TG_LAST_UPDATE_ID:-0}"

log "Loaded Telegram offset: $TG_LAST_UPDATE_ID"

# Bootstrap WA since: use 2 minutes ago on first run
WA_LAST_SEEN=$(date -u -d "2 minutes ago" "+%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u "+%Y-%m-%dT%H:%M:%SZ")

POLL_COUNT=0
while true; do
  POLL_COUNT=$(( POLL_COUNT + 1 ))
  POLL_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  # ── WhatsApp poll ──────────────────────────────────────────────────────
  WA_MSGS=$(poll_whatsapp "$WA_LAST_SEEN")
  WA_COUNT=$(echo "$WA_MSGS" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null || echo 0)

  if [[ "$WA_COUNT" -gt 0 ]]; then
    ADDED=$(append_to_queue "$WA_MSGS")
    log "WhatsApp: $WA_COUNT new messages (queued $ADDED)"
    # Update last seen to most recent timestamp
    WA_LAST_SEEN=$(echo "$WA_MSGS" | python3 -c "
import json, sys
msgs = json.load(sys.stdin)
ts = [m.get('timestamp','') for m in msgs if m.get('timestamp','')]
print(max(ts) if ts else '$WA_LAST_SEEN')
" 2>/dev/null || echo "$WA_LAST_SEEN")
  fi

  # ── Telegram poll ──────────────────────────────────────────────────────
  TG_MSGS=$(poll_telegram "$TG_LAST_UPDATE_ID")
  TG_COUNT=$(echo "$TG_MSGS" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null || echo 0)

  if [[ "$TG_COUNT" -gt 0 ]]; then
    ADDED=$(append_to_queue "$TG_MSGS")
    log "Telegram: $TG_COUNT new messages (queued $ADDED, dispatching to $TG_TARGET_SESSION)"
    dispatch_telegram "$TG_MSGS" || true
    TG_LAST_UPDATE_ID=$(echo "$TG_MSGS" | python3 -c "
import json, sys
msgs = json.load(sys.stdin)
ids = [m.get('update_id', 0) for m in msgs]
print(max(ids) if ids else $TG_LAST_UPDATE_ID)
" 2>/dev/null || echo "$TG_LAST_UPDATE_ID")
  fi

  # ── Save state ──────────────────────────────────────────────────────────
  save_state "$TG_LAST_UPDATE_ID"

  # ── Write health ──────────────────────────────────────────────────────
  write_health "polling" "poll=$POLL_COUNT wa_new=$WA_COUNT tg_new=$TG_COUNT ts=$POLL_TS"

  if [[ $(( POLL_COUNT % 10 )) -eq 0 ]]; then
    log "Heartbeat: poll #$POLL_COUNT — tg_offset=$TG_LAST_UPDATE_ID"
  fi

  sleep "$POLL_INTERVAL"
done
