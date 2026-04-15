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
DATA_DIR="${OPS_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}"
LOG_DIR="${WACLI_LOG_DIR:-$DATA_DIR/logs}"
LOG="$LOG_DIR/wacli-keepalive.log"
HEALTH_FILE="$STORE/.health"
MEMORY_DIR="$DATA_DIR/memories"
MAX_LOG_SIZE=1048576  # 1MB
SYNC_PROBE_TIMEOUT=20
BACKFILL_INTERVAL="${BACKFILL_INTERVAL:-1800}"  # 30 min default
PAUSE_SIGNAL="$STORE/.pause_sync"
SYNC_PID_FILE="$STORE/.sync_pid"

mkdir -p "$LOG_DIR" "$STORE" "$MEMORY_DIR"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >> "$LOG"; }

# Rotate log if too large
if [[ -f "$LOG" ]] && [[ $(stat -f%z "$LOG" 2>/dev/null || stat -c%s "$LOG" 2>/dev/null || echo 0) -gt $MAX_LOG_SIZE ]]; then
  mv "$LOG" "$LOG.old"
fi

log "START: keepalive pid=$$ starting"

# ── Step 0: Race condition prevention ───────────────────────────────────
# Both com.claude-ops.daemon and com.claude-ops.wacli-keepalive start at boot.
# If both try wacli sync simultaneously, one crashes on the store lock.
# Wait briefly for any concurrent sync to claim the lock first.
if pgrep -f "wacli sync" >/dev/null 2>&1; then
  log "START: another wacli sync is running — waiting 15s for lock release"
  sleep 15
fi

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

# ── Missed message detection ───────────────────────────────────────────
# Compare chat metadata LastMessageTS against actual latest DB message.
# If gap > 1 hour, the chat has missing messages and needs backfill.
detect_missed_messages() {
  command -v "$WACLI" &>/dev/null || return 0
  local backfill_file="$STORE/.backfill_jids"

  "$WACLI" chats list --json 2>/dev/null | python3 -c "
import json, sys, subprocess, datetime

data = json.load(sys.stdin)
chats = data.get('data', []) or []
wacli = '${WACLI}'
cutoff = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=14)).isoformat()
gap_threshold = 3600  # 1 hour in seconds
missed = []

for c in chats:
    jid = c.get('JID', '')
    meta_ts = c.get('LastMessageTS', '')
    if not jid or not meta_ts or meta_ts < cutoff:
        continue
    try:
        result = subprocess.run(
            [wacli, 'messages', 'list', '--chat', jid, '--limit', '1', '--json'],
            capture_output=True, text=True, timeout=10
        )
        if result.returncode != 0:
            continue
        msg_data = json.loads(result.stdout)
        msgs = msg_data.get('data', {}).get('messages', []) or []
        if not msgs:
            missed.append(jid)
            continue
        db_ts = msgs[0].get('Timestamp', '')
        if not db_ts:
            continue
        # Parse both timestamps and compare
        from dateutil.parser import parse as dtparse
        meta_dt = dtparse(meta_ts)
        db_dt = dtparse(db_ts)
        gap = abs((meta_dt - db_dt).total_seconds())
        if gap > gap_threshold:
            missed.append(jid)
    except Exception:
        continue

if missed:
    # Append to existing backfill file (don't overwrite)
    existing = set()
    try:
        with open('${backfill_file}') as f:
            existing = set(l.strip() for l in f if l.strip())
    except: pass
    with open('${backfill_file}', 'w') as f:
        for jid in sorted(existing | set(missed)):
            f.write(jid + '\n')
    print(f'MISSED: {len(missed)} chats with message gaps detected')
" 2>/dev/null | while IFS= read -r line; do
    log "$line"
  done || true
}

auto_detect_empty_chats
detect_missed_messages
run_backfill

# ── Wacli data cache for daemon consumption ─────────────────────────────
# Write chat/message data to JSON cache so the daemon never calls wacli directly.
# This eliminates store-lock contention between daemon intelligence functions
# and the persistent sync.
WACLI_CACHE_DIR="$DATA_DIR/cache"
WACLI_CACHE_INTERVAL=300  # 5 min
LAST_WACLI_CACHE=0

refresh_wacli_cache() {
  local now
  now=$(date +%s)
  if (( now - LAST_WACLI_CACHE < WACLI_CACHE_INTERVAL )); then return 0; fi
  LAST_WACLI_CACHE=$now

  # Write chats cache
  "$WACLI" chats list --json > "$WACLI_CACHE_DIR/wacli_chats.json" 2>/dev/null || true

  # Write recent messages cache (search for urgent keywords)
  "$WACLI" messages search --query "urgent OR asap OR deadline OR emergency OR ASAP" --json \
    > "$WACLI_CACHE_DIR/wacli_urgent.json" 2>/dev/null || true

  log "CACHE: refreshed wacli data cache"
}

# Initial cache write before starting persistent sync
refresh_wacli_cache

write_health "connected" "persistent sync starting"

# ── Pause-signal handler ────────────────────────────────────────────────
# External processes (send, backfill) write $PAUSE_SIGNAL to request exclusive
# wacli access. We stop the persistent sync, wait for the signal to clear
# (or auto-expire after 60s), then restart.
check_pause_signal() {
  if [[ ! -f "$PAUSE_SIGNAL" ]]; then return 1; fi

  # Auto-expire stale pause signals (>60s old)
  local pause_age
  pause_age=$(( $(date +%s) - $(stat -f%m "$PAUSE_SIGNAL" 2>/dev/null || stat -c%Y "$PAUSE_SIGNAL" 2>/dev/null || echo 0) ))
  if [[ $pause_age -gt 60 ]]; then
    log "PAUSE: stale pause signal (${pause_age}s old) — removing"
    rm -f "$PAUSE_SIGNAL"
    return 1
  fi

  local requester_pid
  requester_pid=$(head -1 "$PAUSE_SIGNAL" 2>/dev/null | grep -o '[0-9]*' || true)
  if [[ -n "$requester_pid" ]] && ! kill -0 "$requester_pid" 2>/dev/null; then
    log "PAUSE: requester pid=$requester_pid is dead — removing signal"
    rm -f "$PAUSE_SIGNAL"
    return 1
  fi

  return 0
}

# ── Periodic backfill in background ─────────────────────────────────────
# Runs every BACKFILL_INTERVAL during persistent sync. Non-blocking.
LAST_BACKFILL_TIME=$(date +%s)

periodic_backfill() {
  local now
  now=$(date +%s)
  if (( now - LAST_BACKFILL_TIME < BACKFILL_INTERVAL )); then return 0; fi
  LAST_BACKFILL_TIME=$now

  log "PERIODIC-BACKFILL: checking for chats needing backfill"
  (
    auto_detect_empty_chats
    detect_missed_messages
    if [[ -f "$STORE/.backfill_jids" ]] && [[ -s "$STORE/.backfill_jids" ]]; then
      run_backfill
      write_backfill_memory
    fi
  ) &
}

# ── Write backfill summary to ops memory ────────────────────────────────
write_backfill_memory() {
  command -v "$WACLI" &>/dev/null || return 0

  "$WACLI" chats list --json 2>/dev/null | python3 -c "
import json, sys, subprocess, datetime, os

data = json.load(sys.stdin)
chats = data.get('data', []) or []
wacli = '${WACLI}'
memory_dir = '${MEMORY_DIR}'
now = datetime.datetime.now(datetime.timezone.utc)
summaries = []

for c in chats[:20]:
    jid = c.get('JID', '')
    name = c.get('Name', '') or c.get('PushName', '') or jid
    meta_ts = c.get('LastMessageTS', '')
    if not jid or not meta_ts:
        continue
    try:
        result = subprocess.run(
            [wacli, 'messages', 'list', '--chat', jid, '--limit', '3', '--json'],
            capture_output=True, text=True, timeout=10
        )
        if result.returncode != 0:
            continue
        msg_data = json.loads(result.stdout)
        msgs = msg_data.get('data', {}).get('messages', []) or []
        if not msgs:
            continue
        # Build summary
        texts = [m.get('Text', '')[:100] for m in msgs if m.get('Text')]
        if texts:
            summaries.append({
                'contact': name,
                'jid': jid,
                'last_message_ts': meta_ts,
                'recent_topics': texts[:3],
                'msg_count_local': len(msgs)
            })
    except:
        continue

if summaries:
    summary_file = os.path.join(memory_dir, 'whatsapp_backfill_summary.json')
    with open(summary_file, 'w') as f:
        json.dump({
            'updated': now.isoformat(),
            'backfilled_chats': summaries
        }, f, indent=2)
    print(f'MEMORY: wrote backfill summary for {len(summaries)} chats')
" 2>/dev/null | while IFS= read -r line; do
    log "$line"
  done || true
}

# ── Persistent sync with pause-signal + periodic backfill ──────────────
log "SYNC: starting persistent sync --follow"

while true; do
  # Check for pause signal before starting sync
  if check_pause_signal; then
    log "SYNC: pause signal detected — waiting for external command to finish"
    write_health "paused" "sync paused for external wacli command"
    while check_pause_signal; do sleep 2; done
    log "SYNC: pause cleared — resuming"
    write_health "connected" "sync resuming after pause"
  fi

  # Start persistent sync in background so we can monitor pause signals
  "$WACLI" sync --follow --refresh-contacts --refresh-groups 2>&1 &
  local_sync_pid=$!
  echo "$local_sync_pid" > "$SYNC_PID_FILE"

  # Monitor loop: check pause signals + trigger periodic backfill
  while kill -0 "$local_sync_pid" 2>/dev/null; do
    # If pause signal appears, stop sync gracefully
    if check_pause_signal; then
      log "SYNC: pause signal received — stopping sync pid=$local_sync_pid"
      kill -TERM "$local_sync_pid" 2>/dev/null || true
      wait "$local_sync_pid" 2>/dev/null || true
      rm -f "$SYNC_PID_FILE"
      break
    fi

    # Periodic backfill (non-blocking, runs in subshell) + cache refresh
    periodic_backfill
    refresh_wacli_cache

    sleep 5
  done

  # If sync exited on its own (not paused), break out of the restart loop
  if ! check_pause_signal; then
    break
  fi
done

rm -f "$SYNC_PID_FILE"
write_health "disconnected" "sync exited"
log "EXIT: sync process ended — launchd will restart"
exit 0
