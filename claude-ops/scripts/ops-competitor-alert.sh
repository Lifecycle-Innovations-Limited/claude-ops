#!/usr/bin/env bash
# ops-competitor-alert.sh — Drain immediate.jsonl and dispatch high-severity alerts
#
# Runs every 10 minutes via daemon-services (competitor-alert entry).
# Telegram optional — always persists to disk as fallback.
#
set -euo pipefail

DATA_DIR="${OPS_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}"
LOG_DIR="$DATA_DIR/logs"
LOG="$LOG_DIR/competitor-alert.log"
QUEUE_DIR="$DATA_DIR/competitor_state/queue"
REPORT_DIR="$DATA_DIR/reports/competitor-intel"

mkdir -p "$LOG_DIR" "$QUEUE_DIR" "$REPORT_DIR"

log() { printf '%s [competitor-alert] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" | tee -a "$LOG"; }

# ── Credentials ───────────────────────────────────────────────────────────────
TELEGRAM_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
TELEGRAM_CHAT="${TELEGRAM_CHAT_ID:-}"

if [[ -z "$TELEGRAM_TOKEN" ]]; then
  TELEGRAM_TOKEN=$(doppler secrets get TELEGRAM_BOT_TOKEN --plain 2>/dev/null || true)
fi
if [[ -z "$TELEGRAM_CHAT" ]]; then
  TELEGRAM_CHAT=$(doppler secrets get TELEGRAM_CHAT_ID --plain 2>/dev/null || true)
fi

# ── Queue state ───────────────────────────────────────────────────────────────
IMMEDIATE_QUEUE="$QUEUE_DIR/immediate.jsonl"
PROCESSED_QUEUE="$QUEUE_DIR/immediate.processed.jsonl"

if [[ ! -f "$IMMEDIATE_QUEUE" ]] || [[ ! -s "$IMMEDIATE_QUEUE" ]]; then
  log "HEARTBEAT_OK"
  exit 0
fi

# ── Alert log (dated rotating — one file per day) ─────────────────────────────
ALERT_LOG="$REPORT_DIR/alerts.log"
TODAY=$(date -u +%Y-%m-%d)
DATED_ALERT_LOG="$REPORT_DIR/alerts-${TODAY}.log"

# ── Process queue ─────────────────────────────────────────────────────────────
PROCESSED=0
FAILED=0

while IFS= read -r event; do
  [[ -z "$event" ]] && continue

  # Extract fields with jq, fallback to "?" on missing
  brand=$(printf '%s' "$event" | jq -r '.brand // .competitor // "?"' 2>/dev/null || echo "?")
  competitor=$(printf '%s' "$event" | jq -r '.competitor // "?"' 2>/dev/null || echo "?")
  source=$(printf '%s' "$event" | jq -r '.source // "?"' 2>/dev/null || echo "?")
  snippet=$(printf '%s' "$event" | jq -r '.snippet // ""' 2>/dev/null || echo "")
  ts=$(printf '%s' "$event" | jq -r '.timestamp // ""' 2>/dev/null || echo "")

  # Terse alert line
  alert_text="🔥 [HIGH] ${competitor} (${source}): ${snippet:0:200}"

  # Always write to disk alert logs
  printf '[%s] %s\n' "${ts:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}" "$alert_text" | tee -a "$ALERT_LOG" >> "$DATED_ALERT_LOG"

  # Telegram push if creds present
  if [[ -n "$TELEGRAM_TOKEN" && -n "$TELEGRAM_CHAT" ]]; then
    TG_RESP=$(curl -s --max-time 10 -X POST \
      "https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage" \
      -H "Content-Type: application/json" \
      -d "$(jq -n --arg chat "$TELEGRAM_CHAT" --arg text "$alert_text" \
          '{chat_id: $chat, text: $text}')" 2>/dev/null || echo '{"ok":false}')
    if printf '%s' "$TG_RESP" | jq -e '.ok == true' >/dev/null 2>&1; then
      log "Telegram OK: $alert_text"
    else
      log "WARN: Telegram send failed — alert persisted to disk only"
    fi
  else
    log "INFO: Telegram not configured — alert saved to disk: $alert_text"
  fi

  # Append to processed archive
  printf '%s\n' "$event" >> "$PROCESSED_QUEUE"
  PROCESSED=$((PROCESSED + 1))

done < "$IMMEDIATE_QUEUE"

# Truncate the live queue after draining
: > "$IMMEDIATE_QUEUE"

log "Drained $PROCESSED event(s) from immediate queue"
log "HEARTBEAT_OK"
