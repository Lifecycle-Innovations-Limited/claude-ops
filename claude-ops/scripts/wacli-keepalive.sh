#!/usr/bin/env bash
# wacli-keepalive.sh — Persistent WhatsApp connection with auto-healing
# Installed by ops:setup → Step 3b.7. Runs via launchd as com.claude-ops.wacli-keepalive.
#
# Responsibilities:
#   1. Kill orphaned wacli processes and clear stale locks
#   2. Verify authentication — write health file for ops skills to read
#   3. Run `wacli sync --follow` for persistent message streaming
#   4. If auth fails or keys desync, write needs_reauth so ops:inbox can prompt QR
#
# LaunchD restarts this automatically on exit (KeepAlive=true, throttle 60s).
#
# When run as a child of ops-daemon (OPS_DAEMON_MANAGED=1 / OPS_DAEMON_PID set),
# launchd-specific self-management is skipped — the daemon handles restarts.
set -euo pipefail

# ── Daemon-managed mode detection ────────────────────────────────────────
# If ops-daemon is managing us, we skip registering our own launchd agent.
# The daemon reads our health file and handles restart/backoff logic.
export OPS_DAEMON_MANAGED="${OPS_DAEMON_MANAGED:-0}"
if [[ -n "${OPS_DAEMON_PID:-}" ]] && [[ "$OPS_DAEMON_MANAGED" == "1" ]]; then
  : # Running as ops-daemon child — launchd self-management skipped
fi

WACLI="${WACLI_BIN:-/usr/local/bin/wacli}"
STORE="${WACLI_STORE:-$HOME/.wacli}"
LOG_DIR="${WACLI_LOG_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace/logs}"
LOG="$LOG_DIR/wacli-keepalive.log"
HEALTH_FILE="$STORE/.health"
MAX_LOG_SIZE=1048576  # 1MB
SYNC_PROBE_TIMEOUT=20

mkdir -p "$LOG_DIR" "$STORE"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >> "$LOG"; }

# Rotate log if too large
if [[ -f "$LOG" ]] && [[ $(stat -f%z "$LOG" 2>/dev/null || stat -c%s "$LOG" 2>/dev/null || echo 0) -gt $MAX_LOG_SIZE ]]; then
  mv "$LOG" "$LOG.old"
fi

log "START: keepalive pid=$$ starting"

# ── Step 1: Kill orphaned wacli sync processes ──────────────────────────
cleanup_stale() {
  local stale_pids
  stale_pids=$(pgrep -f "wacli sync" 2>/dev/null || true)
  for pid in $stale_pids; do
    if [[ "$pid" != "$$" ]]; then
      kill "$pid" 2>/dev/null && log "DOCTOR: killed stale wacli sync pid=$pid" || true
    fi
  done

  # Check for stale lock
  local doctor_json
  doctor_json=$("$WACLI" doctor --json 2>/dev/null || echo '{}')
  local locked
  locked=$(echo "$doctor_json" | grep -o '"locked":true' || true)
  if [[ -n "$locked" ]]; then
    log "DOCTOR: store locked — waiting 5s for natural release"
    sleep 5
    doctor_json=$("$WACLI" doctor --json 2>/dev/null || echo '{}')
    locked=$(echo "$doctor_json" | grep -o '"locked":true' || true)
    if [[ -n "$locked" ]]; then
      pkill -f wacli 2>/dev/null || true
      sleep 2
      log "DOCTOR: force-cleared stale lock"
    fi
  fi
}

# ── Step 2: Check auth + connectivity, write health file ────────────────
write_health() {
  local status="$1" detail="${2:-}"
  cat > "$HEALTH_FILE" <<EOF
timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
status=$status
detail=$detail
pid=$$
EOF
  log "HEALTH: status=$status detail=$detail"
}

check_auth() {
  local doctor_out
  doctor_out=$("$WACLI" doctor 2>&1) || true
  local authenticated
  authenticated=$(echo "$doctor_out" | awk '/AUTHENTICATED/{print $2}')

  if [[ "$authenticated" != "true" ]]; then
    write_health "needs_auth" "not authenticated — QR scan required"
    return 1
  fi
  return 0
}

# ── Step 3: Probe sync for key desync ───────────────────────────────────
probe_sync() {
  local probe_log="/tmp/wacli-sync-probe-$$.log"
  timeout "$SYNC_PROBE_TIMEOUT" "$WACLI" sync --once --idle-exit=10s 2>&1 > "$probe_log" || true

  if grep -qE "didn't find app state key|failed to decode app state|Failed to do initial fetch" "$probe_log" 2>/dev/null; then
    write_health "needs_reauth" "app-state keys desynced — logout + re-pair required"
    rm -f "$probe_log"
    return 1
  fi

  rm -f "$probe_log"
  return 0
}

# ── Step 4: On-demand backfill (before going persistent) ────────────────
# If BACKFILL_JIDS file exists, backfill those chats then delete the file.
# This allows ops:setup or ops:inbox to request backfill by writing JIDs to this file
# and restarting the daemon.
run_backfill() {
  local backfill_file="$STORE/.backfill_jids"
  if [[ ! -f "$backfill_file" ]]; then return 0; fi

  log "BACKFILL: found backfill request"
  local jid
  while IFS= read -r jid; do
    [[ -z "$jid" ]] && continue
    log "BACKFILL: backfilling $jid"
    "$WACLI" history backfill --chat="$jid" --count=50 --requests=2 --wait=30s --idle-exit=5s 2>&1 | while IFS= read -r line; do
      log "BACKFILL: $line"
    done || true
  done < "$backfill_file"

  rm -f "$backfill_file"
  log "BACKFILL: complete"
}

# ── Main flow ───────────────────────────────────────────────────────────
cleanup_stale

if ! check_auth; then
  log "FATAL: not authenticated — exiting (launchd restarts in 60s)"
  exit 1
fi

if ! probe_sync; then
  log "FATAL: key desync detected — exiting (needs manual re-pair)"
  exit 1
fi

# Bootstrap: run a one-shot sync to populate DB with chat metadata + recent messages.
# Without this, @lid chats have 0 rows and backfill/messages list returns nothing.
# NOTE: Do NOT pipe through `while read` — the pipe kills the sync prematurely.
log "SYNC: running bootstrap sync (--once) to populate DB"
BOOTSTRAP_LOG="/tmp/wacli-bootstrap-$$.log"
"$WACLI" sync --once --idle-exit=20s --refresh-contacts --refresh-groups > "$BOOTSTRAP_LOG" 2>&1 || true
BOOTSTRAP_MSGS=$(grep -o "Messages stored: [0-9]*" "$BOOTSTRAP_LOG" | grep -o "[0-9]*" || echo "0")
log "SYNC: bootstrap complete — $BOOTSTRAP_MSGS messages stored"
# Log non-noise lines
grep -vE "app state key|Failed to sync app state|Failed to do initial fetch" "$BOOTSTRAP_LOG" >> "$LOG" 2>/dev/null || true
rm -f "$BOOTSTRAP_LOG"

# Now backfill — DB should have chat metadata from bootstrap.
# Also auto-detect @lid chats with 0 messages and queue them for backfill.
auto_detect_empty_chats() {
  local chats_json
  chats_json=$("$WACLI" chats list --json 2>/dev/null) || return 0
  local backfill_file="$STORE/.backfill_jids"

  echo "$chats_json" | python3 -c "
import sys, json, subprocess, datetime
data = json.load(sys.stdin)
chats = data.get('data', []) or []
cutoff = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=7)).isoformat()
jids = []
for c in chats:
    if not c.get('JID','').endswith('@lid'): continue
    if c.get('LastMessageTS','') < cutoff: continue
    jids.append(c['JID'])
if jids:
    print('\n'.join(jids))
" > "$backfill_file" 2>/dev/null || true

  if [[ -s "$backfill_file" ]]; then
    local count
    count=$(wc -l < "$backfill_file" | tr -d ' ')
    log "AUTO-BACKFILL: detected $count recent @lid chats to backfill"
  else
    rm -f "$backfill_file"
  fi
}

auto_detect_empty_chats
run_backfill

write_health "connected" "persistent sync starting"

# Persistent sync for real-time messages. If it exits, launchd restarts us.
log "SYNC: starting persistent sync --follow"
"$WACLI" sync --follow --refresh-contacts --refresh-groups 2>&1 | while IFS= read -r line; do
  # Filter noise
  case "$line" in
    *"app state key"*|*"Failed to sync app state"*|*"Failed to do initial fetch"*) ;;
    *"ERROR"*) log "SYNC-ERR: $line" ;;
    *"Synced"*|*"Connected"*|*"Stopping"*) log "SYNC: $line" ;;
  esac
done

write_health "disconnected" "sync exited"
log "EXIT: sync process ended — launchd will restart"
exit 0
