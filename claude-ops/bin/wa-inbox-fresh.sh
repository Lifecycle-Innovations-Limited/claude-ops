#!/usr/bin/env bash
# wa-inbox-fresh.sh — guarantee the WhatsApp bridge store is current BEFORE any
# ops-inbox triage. Run this FIRST in every WhatsApp scan.
#
#   1. ensure the whatsmeow bridge is up + connected (restart if :8080 is dead)
#   2. force a history backfill (POST /api/backfill)
#   3. fill any new voice notes with transcripts (whatsapp-transcribe.service)
#   4. wait (bounded) for the store's newest message to settle
#   5. print a FRESHNESS report so the caller never classifies blind
#
# Exit 0 = store is as-fresh-as-this-bridge-can-be (report printed).
# Exit 2 = bridge unreachable and could not be recovered (do NOT trust the store).
#
# HARD LIMIT (state it, don't hide it): messages YOU send from your PHONE may not
# replicate to a companion bridge — WhatsApp's multi-device protocol does not
# guarantee it (WhatsApp Web has the same gap). So for "did I already reply?",
# the human's word is authoritative over this store.
set -u
DB="${WHATSAPP_BRIDGE_DB:-$HOME/.local/share/whatsapp-mcp/whatsapp-bridge/store/messages.db}"
BRIDGE="http://127.0.0.1:8080"
WAIT_TICKS="${WA_FRESH_WAIT_TICKS:-8}"   # ×4s ≈ 32s max wait

log() { printf '%s\n' "$*"; }

# 1. bridge up?  Liveness = a real TCP/HTTP connection to :8080 (curl exit 7 =
# connection refused). Do NOT use `ss | grep :8080` — ss resolves 8080 to the
# service name "webcache", so the grep never matches and we'd bounce a healthy
# bridge. Only restart when the connection probe genuinely fails twice.
alive() { curl -s -o /dev/null -m 4 "$BRIDGE/" >/dev/null 2>&1; }   # exit 0 even on 404; nonzero only if not listening
if ! { alive || { sleep 2; alive; }; }; then
  log "wa-fresh: bridge :8080 not responding — restarting…"
  systemctl --user restart whatsapp-bridge.service 2>/dev/null
  for i in $(seq 1 10); do sleep 2; alive && break; done
fi
if ! alive; then
  log "wa-fresh: ERROR bridge still down after restart — store is STALE, do not trust it"
  exit 2
fi

# connection sanity from the journal (best-effort)
if journalctl --user -u whatsapp-bridge.service -n 40 --no-pager 2>/dev/null \
     | grep -q "Connected to WhatsApp"; then
  log "wa-fresh: bridge connected ✓"
fi

before=$(sqlite3 "$DB" "SELECT COALESCE(datetime(MAX(timestamp)),'1970-01-01') FROM messages;" 2>/dev/null)

# 2. force backfill
code=$(curl -fsS -m 20 -X POST -o /dev/null -w "%{http_code}" "$BRIDGE/api/backfill" 2>/dev/null || echo "ERR")
log "wa-fresh: backfill → HTTP ${code}"

# 3. transcribe any freshly-synced voice notes (idempotent, lock-guarded)
systemctl --user start whatsapp-transcribe.service 2>/dev/null && log "wa-fresh: voice transcription triggered"

# 4. bounded wait for the store to settle
new=0
for i in $(seq 1 "$WAIT_TICKS"); do
  sleep 4
  cnt=$(sqlite3 "$DB" "SELECT COUNT(*) FROM messages WHERE datetime(timestamp) > datetime('$before');" 2>/dev/null || echo 0)
  [ "${cnt:-0}" -gt 0 ] && { new=$cnt; break; }
done

# 5. freshness report
after=$(sqlite3 "$DB" "SELECT COALESCE(datetime(MAX(timestamp)),'?') FROM messages;" 2>/dev/null)
age_min=$(sqlite3 "$DB" "SELECT CAST((julianday('now')-julianday(MAX(timestamp)))*1440 AS INT) FROM messages;" 2>/dev/null)
log "wa-fresh: newest message = ${after} (${age_min:-?} min old) | new rows this cycle = ${new}"
if [ "${age_min:-9999}" -gt 120 ]; then
  log "wa-fresh: WARNING newest message is >2h old — store may be lagging; treat 'last-sender' classification with caution"
fi
log "wa-fresh: NOTE phone-sent messages may be absent — confirm 'did I reply?' with the human, not this store"
exit 0
