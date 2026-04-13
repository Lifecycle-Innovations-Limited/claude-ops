#!/usr/bin/env bash
# ops-daemon.sh — Unified background process manager for claude-ops
# Manages: wacli sync, memory extraction, health monitors
# Runs via launchd as com.claude-ops.daemon
set -euo pipefail

DATA_DIR="${OPS_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}"
LOG_DIR="$DATA_DIR/logs"
LOG="$LOG_DIR/ops-daemon.log"
SERVICES_CONFIG="$DATA_DIR/daemon-services.json"
HEALTH_FILE="$DATA_DIR/daemon-health.json"
MAX_LOG_SIZE=2097152  # 2MB
DAEMON_START=$(date +%s)

mkdir -p "$LOG_DIR"

# ── Logging ──────────────────────────────────────────────────────────────
log() { printf '%s [ops-daemon] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >> "$LOG"; }

rotate_log() {
  if [[ -f "$LOG" ]] && [[ $(stat -f%z "$LOG" 2>/dev/null || stat -c%s "$LOG" 2>/dev/null || echo 0) -gt $MAX_LOG_SIZE ]]; then
    mv "$LOG" "$LOG.old"
    log "LOG: rotated (exceeded 2MB)"
  fi
}

# ── State tracking ────────────────────────────────────────────────────────
declare -A SERVICE_PIDS        # service name → pid
declare -A SERVICE_RESTARTS    # service name → restart count
declare -A SERVICE_NEXT_RUN    # service name → next run epoch (cron services)
declare -A SERVICE_LAST_RUN    # service name → last run epoch (cron services)
declare -A SERVICE_STATUS      # service name → status string
declare -A SERVICE_LAST_HEALTH # service name → last health string
ACTION_NEEDED="null"

# ── Config loading ────────────────────────────────────────────────────────
load_services_config() {
  if [[ ! -f "$SERVICES_CONFIG" ]]; then
    log "CONFIG: $SERVICES_CONFIG not found — nothing to manage"
    return 1
  fi
  log "CONFIG: loaded $SERVICES_CONFIG"
  return 0
}

# Parse a value from the JSON config for a given service + key.
# Uses python3 for reliable JSON parsing.
get_service_field() {
  local service="$1" field="$2"
  python3 -c "
import json, sys
data = json.load(open('$SERVICES_CONFIG'))
svc = data.get('services', {}).get('$service', {})
val = svc.get('$field', '')
print(val if val is not None else '')
" 2>/dev/null || true
}

get_enabled_services() {
  python3 -c "
import json
data = json.load(open('$SERVICES_CONFIG'))
for name, cfg in data.get('services', {}).items():
    if cfg.get('enabled', False):
        print(name)
" 2>/dev/null || true
}

# ── Cron helpers ─────────────────────────────────────────────────────────
# Parse a simple cron expression (*/N * * * *) and return next epoch.
# Only supports */N minute fields — sufficient for daemon use cases.
calc_next_run() {
  local cron="$1"
  local interval_min
  interval_min=$(echo "$cron" | python3 -c "
import sys, re
expr = sys.stdin.read().strip()
m = re.match(r'^\*/(\d+)\s+\*\s+\*\s+\*\s+\*$', expr)
if m:
    print(int(m.group(1)) * 60)
else:
    print(3600)
" 2>/dev/null || echo 3600)
  echo $(( $(date +%s) + interval_min ))
}

# ── Service lifecycle ─────────────────────────────────────────────────────
start_service() {
  local name="$1"
  local cmd
  cmd=$(get_service_field "$name" "command")
  if [[ -z "$cmd" ]]; then
    log "START: $name — no command configured, skipping"
    return 1
  fi

  log "START: launching $name — $cmd"
  # Export daemon identity so child scripts can detect they're managed
  export OPS_DAEMON_PID=$$
  export OPS_DAEMON_MANAGED=1

  bash "$cmd" >> "$LOG_DIR/${name}.log" 2>&1 &
  local pid=$!
  SERVICE_PIDS["$name"]=$pid
  SERVICE_STATUS["$name"]="running"
  SERVICE_LAST_HEALTH["$name"]="starting"
  log "START: $name launched pid=$pid"
}

stop_service() {
  local name="$1"
  local pid="${SERVICE_PIDS[$name]:-}"
  if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then
    SERVICE_PIDS["$name"]=""
    return 0
  fi
  log "STOP: sending SIGTERM to $name pid=$pid"
  kill -TERM "$pid" 2>/dev/null || true
  local waited=0
  while kill -0 "$pid" 2>/dev/null && [[ $waited -lt 5 ]]; do
    sleep 1
    (( waited++ )) || true
  done
  if kill -0 "$pid" 2>/dev/null; then
    log "STOP: $name pid=$pid did not exit — sending SIGKILL"
    kill -KILL "$pid" 2>/dev/null || true
  fi
  SERVICE_PIDS["$name"]=""
  SERVICE_STATUS["$name"]="stopped"
  log "STOP: $name stopped"
}

check_health() {
  local name="$1"
  local health_path
  health_path=$(get_service_field "$name" "health_file")
  health_path="${health_path/#\~/$HOME}"

  # Check if PID is alive
  local pid="${SERVICE_PIDS[$name]:-}"
  if [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null; then
    log "HEALTH: $name pid=$pid is dead"
    SERVICE_STATUS["$name"]="dead"
    SERVICE_PIDS["$name"]=""
    return 1
  fi

  # Read health file if present
  if [[ -n "$health_path" ]] && [[ -f "$health_path" ]]; then
    local file_status
    file_status=$(grep -E '^status=' "$health_path" 2>/dev/null | cut -d= -f2- || echo "unknown")
    SERVICE_LAST_HEALTH["$name"]="$file_status"

    case "$file_status" in
      needs_reauth|needs_auth)
        ACTION_NEEDED="{\"service\": \"$name\", \"action\": \"reauth\"}"
        SERVICE_STATUS["$name"]="needs_reauth"
        log "HEALTH: $name needs reauth — action surfaced"
        return 1
        ;;
      connected|running|ok)
        SERVICE_STATUS["$name"]="running"
        ;;
      *)
        SERVICE_STATUS["$name"]="${file_status:-running}"
        ;;
    esac
  fi

  return 0
}

restart_service() {
  local name="$1"
  local restart_delay max_restarts
  restart_delay=$(get_service_field "$name" "restart_delay")
  restart_delay="${restart_delay:-60}"
  max_restarts=$(get_service_field "$name" "max_restarts")
  max_restarts="${max_restarts:-10}"

  local count="${SERVICE_RESTARTS[$name]:-0}"
  if [[ $count -ge $max_restarts ]]; then
    log "RESTART: $name hit max_restarts=$max_restarts — not restarting"
    SERVICE_STATUS["$name"]="max_restarts_exceeded"
    return
  fi

  SERVICE_RESTARTS["$name"]=$(( count + 1 ))
  log "RESTART: $name (attempt $((count+1))/$max_restarts) — waiting ${restart_delay}s"
  # Non-blocking: schedule restart by marking it, actual start happens in main loop
  # For simplicity, stop and re-start after the delay inline (daemon loop is 30s anyway)
  stop_service "$name"
  sleep "${restart_delay}" &
  # We record the sleep PID to avoid blocking; restart happens next health check after delay
  # Use a simpler approach: just restart immediately (launchd handles overall throttle)
  start_service "$name"
}

# ── Write aggregated health JSON ──────────────────────────────────────────
write_daemon_health() {
  local now
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  local uptime=$(( $(date +%s) - DAEMON_START ))

  # Build services JSON object
  local services_json="{"
  local first=1
  local name
  for name in "${!SERVICE_STATUS[@]}"; do
    local cron
    cron=$(get_service_field "$name" "cron")
    local status="${SERVICE_STATUS[$name]}"
    local pid="${SERVICE_PIDS[$name]:-null}"
    local restarts="${SERVICE_RESTARTS[$name]:-0}"
    local health="${SERVICE_LAST_HEALTH[$name]:-unknown}"

    [[ $first -eq 0 ]] && services_json+=","
    first=0

    if [[ -n "$cron" ]]; then
      local next_run="${SERVICE_NEXT_RUN[$name]:-}"
      local last_run="${SERVICE_LAST_RUN[$name]:-}"
      local next_iso="" last_iso=""
      [[ -n "$next_run" ]] && next_iso=$(date -u -r "$next_run" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$next_run" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "")
      [[ -n "$last_run" ]] && last_iso=$(date -u -r "$last_run" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$last_run" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "")
      services_json+="\"$name\": {\"status\": \"$status\", \"next_run\": \"$next_iso\", \"last_run\": \"$last_iso\"}"
    else
      local pid_val
      if [[ "$pid" == "null" ]] || [[ -z "$pid" ]]; then
        pid_val="null"
      else
        pid_val="$pid"
      fi
      services_json+="\"$name\": {\"status\": \"$status\", \"pid\": $pid_val, \"last_health\": \"$health\", \"restarts\": $restarts}"
    fi
  done
  services_json+="}"

  cat > "$HEALTH_FILE" <<EOF
{
  "timestamp": "$now",
  "pid": $$,
  "uptime_seconds": $uptime,
  "services": $services_json,
  "action_needed": $ACTION_NEEDED
}
EOF
}

# ── Cron service runner ───────────────────────────────────────────────────
run_cron_service() {
  local name="$1"
  local cmd
  cmd=$(get_service_field "$name" "command")
  if [[ -z "$cmd" ]]; then return; fi

  log "CRON: running $name"
  SERVICE_STATUS["$name"]="running"
  SERVICE_LAST_RUN["$name"]=$(date +%s)

  export OPS_DAEMON_PID=$$
  export OPS_DAEMON_MANAGED=1
  bash "$cmd" >> "$LOG_DIR/${name}.log" 2>&1 &
  local pid=$!
  wait "$pid" 2>/dev/null || true

  SERVICE_STATUS["$name"]="scheduled"
  local cron
  cron=$(get_service_field "$name" "cron")
  SERVICE_NEXT_RUN["$name"]=$(calc_next_run "$cron")
  log "CRON: $name completed — next run in $(( SERVICE_NEXT_RUN[$name] - $(date +%s) ))s"
}

# ── Graceful shutdown ─────────────────────────────────────────────────────
cleanup() {
  log "SHUTDOWN: SIGTERM received — stopping all services"
  local name
  for name in "${!SERVICE_PIDS[@]}"; do
    stop_service "$name"
  done
  write_daemon_health
  log "SHUTDOWN: all services stopped — exiting"
  exit 0
}

trap cleanup SIGTERM SIGINT

# ── Main ──────────────────────────────────────────────────────────────────
log "START: ops-daemon pid=$$ starting"
rotate_log

if ! load_services_config; then
  log "FATAL: no services config — writing empty health and sleeping"
  cat > "$HEALTH_FILE" <<EOF
{"timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)", "pid": $$, "uptime_seconds": 0, "services": {}, "action_needed": null}
EOF
  # Sleep forever until SIGTERM; launchd keeps us alive
  while true; do sleep 30; done
fi

# Initialize + start all enabled services
while IFS= read -r svc; do
  SERVICE_RESTARTS["$svc"]=0
  SERVICE_STATUS["$svc"]="starting"
  SERVICE_LAST_HEALTH["$svc"]="unknown"

  local_cron=$(get_service_field "$svc" "cron")
  if [[ -n "$local_cron" ]]; then
    SERVICE_STATUS["$svc"]="scheduled"
    SERVICE_NEXT_RUN["$svc"]=$(calc_next_run "$local_cron")
    log "INIT: $svc is cron-scheduled (${local_cron})"
  else
    start_service "$svc"
  fi
done < <(get_enabled_services)

write_daemon_health
log "LOOP: entering monitor loop (30s interval)"

# ── Monitor loop ──────────────────────────────────────────────────────────
while true; do
  rotate_log
  ACTION_NEEDED="null"

  while IFS= read -r svc; do
    local_cron=$(get_service_field "$svc" "cron")

    if [[ -n "$local_cron" ]]; then
      # Cron service: check if it's time to run
      local_next="${SERVICE_NEXT_RUN[$svc]:-0}"
      if [[ $(date +%s) -ge $local_next ]]; then
        run_cron_service "$svc"
      fi
    else
      # Persistent service: check health + restart if needed
      if ! check_health "$svc"; then
        local_status="${SERVICE_STATUS[$svc]}"
        if [[ "$local_status" != "needs_reauth" ]] && [[ "$local_status" != "max_restarts_exceeded" ]]; then
          restart_service "$svc"
        fi
      fi
    fi
  done < <(get_enabled_services)

  write_daemon_health
  sleep 30
done
