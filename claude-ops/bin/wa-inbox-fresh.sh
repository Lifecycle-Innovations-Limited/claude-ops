#!/usr/bin/env bash
# wa-inbox-fresh.sh — guarantee the WhatsApp bridge store is current BEFORE any
# ops-inbox triage. Run this FIRST in every WhatsApp scan.
#
#   1. ensure the whatsmeow bridge is up + connected (restart if :8080 is dead)
#   2. force a history backfill (POST /api/backfill)
#   3. wait (bounded) for the store's newest message to settle
#   4. queue voice transcription (async; does not block on Whisper)
#   5. print a FRESHNESS report so the caller never classifies blind
#
# Exit 0 = store is as-fresh-as-this-bridge-can-be (report printed).
# Exit 2 = bridge unreachable or messages store unreadable (do NOT trust the store).
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

# 1. bridge up?  Liveness = a real TCP/HTTP connection to :8080.
# curl exit 7 = connection refused (not listening); exit 0 even on 404.
# Do NOT use `ss | grep :8080` — ss renders port 8080 as the service name
# "webcache" so the grep never matches and would bounce a healthy bridge.
#
# Restart gate: only restart when BOTH consecutive probes fail (1s apart).
# Previously the bridge was bounced 4× in 6 min because a single slow probe
# (bridge still starting up) triggered a restart loop. The fix: fail-fast
# probe × 2 with a 1s gap; only then restart; then wait up to 20s for it to
# come back up before declaring dead.
alive() { curl -s -o /dev/null -m 10 "$BRIDGE/" >/dev/null 2>&1; }
probe_dead() { ! alive && { sleep 1; ! alive; }; }   # two consecutive failures = truly dead

bridge_restarted=0
if probe_dead; then
  # Startup-grace gate: if the bridge (re)started <120s ago it is almost certainly
  # mid-reconnect (opening the SQLite store + WhatsApp websocket), and a probe that
  # fails here would re-trigger a restart → reconnect → probe-fail loop. Skip.
  started=$(systemctl --user show whatsapp-bridge.service -p ActiveEnterTimestampMonotonic --value 2>/dev/null)
  now=$(awk '{print int($1*1000000)}' /proc/uptime)
  if [ -n "$started" ] && [ "$started" -gt 0 ] && [ $(( now - started )) -lt 120000000 ]; then
    log "wa-fresh: bridge started <120s ago — skip restart (reconnect in progress)"
  else
    # Shared cross-caller restart floor: the SAME stamp every other restart caller
    # uses (wa-bridge-keepalive.sh, whatsapp-bridge-up.sh). One restart / 180s max,
    # no matter how many parallel agents invoke this script. claude_once is a one-shot
    # guard (not a recurring loop), allowed under the cost rule.
    do_restart=1
    if [ -r "$HOME/.claude/scripts/lib/once.sh" ]; then
      # shellcheck disable=SC1091
      . "$HOME/.claude/scripts/lib/once.sh"
      claude_once whatsapp-bridge-restart 180 || { log "wa-fresh: another caller restarted bridge <180s ago — skip"; do_restart=0; }
    fi
    if [ "$do_restart" = 1 ]; then
      bridge_restarted=1
      log "wa-fresh: bridge :8080 not responding (2 consecutive probes failed) — restarting…"
      systemctl --user restart whatsapp-bridge.service 2>/dev/null
    fi
  fi
  # Wait up to 20 s for the bridge to come back (it needs a few seconds to
  # open the SQLite store and establish the WhatsApp websocket).
  for i in $(seq 1 10); do sleep 2; alive && break; done
fi
if ! alive; then
  if [ "$bridge_restarted" = 1 ]; then
    log "wa-fresh: ERROR bridge still down after restart — store is STALE, do not trust it"
  else
    log "wa-fresh: ERROR bridge still down — store is STALE, do not trust it"
  fi
  exit 2
fi

# connection sanity from the journal (best-effort)
if journalctl --user -u whatsapp-bridge.service -n 40 --no-pager 2>/dev/null \
     | grep -q "Connected to WhatsApp"; then
  log "wa-fresh: bridge connected ✓"
fi

if [ ! -r "$DB" ]; then
  log "wa-fresh: ERROR messages store missing or unreadable at $DB — do not trust it"
  exit 2
fi

before=$(sqlite3 "$DB" "SELECT COALESCE(datetime(MAX(timestamp)),'1970-01-01') FROM messages;") || {
  log "wa-fresh: ERROR cannot read messages store at $DB — do not trust it"
  exit 2
}

# 2. force backfill
code=$(curl -fsS -m 20 -X POST -o /dev/null -w "%{http_code}" "$BRIDGE/api/backfill" 2>/dev/null || echo "ERR")
log "wa-fresh: backfill → HTTP ${code}"
case "$code" in
  2*) ;;
  *)
    log "wa-fresh: ERROR backfill failed (HTTP ${code}) — store may be stale, do not trust it"
    exit 2
    ;;
esac

# 3. bounded wait for the store to settle (after backfill, before transcription)
new=0
for i in $(seq 1 "$WAIT_TICKS"); do
  sleep 4
  cnt=$(sqlite3 "$DB" "SELECT COUNT(*) FROM messages WHERE datetime(timestamp) > datetime('$before');" 2>/dev/null || echo 0)
  [ "${cnt:-0}" -gt 0 ] && { new=$cnt; break; }
done

# 3b. app-state readiness wait (claude-ops bridge Fix Q). After a FRESH re-pair the
# regular_low app-state (archive/pin/mute) is not fully synced yet, so the first
# archive mutation ops-inbox issues would be built on an unsynced LTHash baseline —
# the bridge rejects it (HTTP 425 "app_state_not_ready") and a half-applied mutation
# corrupts the collection (needs a manual phone tap to heal). Poll the bridge's
# GET /api/app_state_status and wait up to ~30s for {"ready":true} before any
# archive runs. BEST-EFFORT: an old bridge without the endpoint (404 / curl failure)
# is treated as ready so ops-inbox never hard-fails on a stale bridge.
appstate_ready_wait() {
  local ticks="${WA_APPSTATE_WAIT_TICKS:-15}"   # ×2s ≈ 30s max
  local body http
  for _ in $(seq 1 "$ticks"); do
    # -w appends the HTTP code after the body so we can branch on both.
    body=$(curl -sS -m 5 -w '|%{http_code}' "$BRIDGE/api/app_state_status" 2>/dev/null) || body="|000"
    http="${body##*|}"
    case "$http" in
      404|000)
        # endpoint absent (old bridge) or unreachable → cannot gate; proceed.
        log "wa-fresh: app_state_status unavailable (HTTP ${http}) — old bridge, proceeding (best-effort)"
        return 0
        ;;
    esac
    case "${body%|*}" in
      *'"ready":true'*)
        log "wa-fresh: app-state ready ✓"
        return 0
        ;;
    esac
    sleep 2
  done
  log "wa-fresh: WARNING app-state not ready after wait — archive mutations may be deferred (HTTP 425); will heal via /api/resync_app_state"
  return 0
}
appstate_ready_wait

# 4. transcribe voice notes synced during backfill (async — gate stays bounded)
if systemctl --user start --no-block whatsapp-transcribe.service 2>/dev/null; then
  log "wa-fresh: voice transcription queued"
else
  log "wa-fresh: voice transcription not started"
fi

# 4b. enrich video/image/document media (async — vision+whisper; never silently dropped)
if systemctl --user start --no-block whatsapp-enrich.service 2>/dev/null; then
  log "wa-fresh: media enrichment queued"
else
  log "wa-fresh: media enrichment not started"
fi

# 5. freshness report
after=$(sqlite3 "$DB" "SELECT COALESCE(datetime(MAX(timestamp)),'?') FROM messages;") || {
  log "wa-fresh: ERROR cannot read messages store at $DB — do not trust it"
  exit 2
}
age_min=$(sqlite3 "$DB" "SELECT CAST((julianday('now')-julianday(MAX(timestamp)))*1440 AS INT) FROM messages;") || age_min=""
log "wa-fresh: newest message = ${after} (${age_min:-?} min old) | new rows this cycle = ${new}"
if [ "${age_min:-9999}" -gt 120 ]; then
  log "wa-fresh: WARNING newest message is >2h old — store may be lagging; treat 'last-sender' classification with caution"
  log "wa-fresh: store may be lagging — cross-check Mac ground truth: bin/wa-mac-latest.sh --recent"
fi
log "wa-fresh: NOTE phone-sent messages may be absent — confirm 'did I reply?' with the human, not this store"
exit 0
