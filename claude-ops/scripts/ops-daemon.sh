#!/usr/bin/env bash
# ops-daemon.sh — Unified background process manager for claude-ops
# Manages: wacli sync, memory extraction, health monitors
# daemon registration: launchd on macOS, systemd on Linux, Task Scheduler on Windows
set -euo pipefail

# ── Bash version guard ───────────────────────────────────────────────────
# This script uses associative arrays (`declare -A`) which require bash 4+.
# macOS ships bash 3.2 at /bin/bash; callers must use a newer bash (e.g.
# `/opt/homebrew/bin/bash` on Apple Silicon, `/usr/local/bin/bash` on Intel).
# Fail loud with a clear message instead of the cryptic `declare -A` error.
if (( BASH_VERSINFO[0] < 4 )); then
  echo "ERROR: ops-daemon.sh requires bash 4 or newer (current: $BASH_VERSION)" >&2
  echo "       macOS ships /bin/bash 3.2 — install GNU bash via Homebrew:" >&2
  echo "         brew install bash" >&2
  echo "       then invoke with /opt/homebrew/bin/bash (or /usr/local/bin/bash)." >&2
  exit 78  # EX_CONFIG
fi

# ── OS detection (sourced) ────────────────────────────────────────────────
# Resolves to the claude-ops plugin root (parent of scripts/).
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091
[ -r "$SCRIPT_DIR/lib/os-detect.sh" ] && . "$SCRIPT_DIR/lib/os-detect.sh"

DATA_DIR="${OPS_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}"
LOG_DIR="$DATA_DIR/logs"
LOG="$LOG_DIR/ops-daemon.log"
SERVICES_CONFIG="$DATA_DIR/daemon-services.json"
HEALTH_FILE="$DATA_DIR/daemon-health.json"
MAX_LOG_SIZE=2097152  # 2MB
DAEMON_START=$(date +%s)

mkdir -p "$LOG_DIR"
mkdir -p "$DATA_DIR/cache"

# ── Portable shim helpers (GNU vs BSD) ───────────────────────────────────
# _file_size: echoes byte size of a file. GNU `stat -c%s` vs BSD `stat -f%z`.
_file_size() {
  if stat --version >/dev/null 2>&1; then
    stat -c%s "$1"  # GNU (Linux, Cygwin, busybox w/ coreutils)
  else
    stat -f%z "$1"  # BSD (macOS, *BSD)
  fi
}

# _date_days_ago: echoes a date N days before now in the given format.
#   $1 = days (positive integer)
#   $2 = date format string (default: +%Y-%m-%d)
_date_days_ago() {
  local days="$1"
  local fmt="${2:-+%Y-%m-%d}"
  if date -d "1 day ago" >/dev/null 2>&1; then
    date -d "$days days ago" "$fmt"         # GNU
  else
    date -v-"${days}"d "$fmt"                # BSD
  fi
}

# _date_from_epoch: echoes ISO-8601 UTC for an epoch timestamp.
#   $1 = epoch seconds
_date_from_epoch() {
  local epoch="$1"
  if date --version >/dev/null 2>&1; then
    date -u -d "@$epoch" +%Y-%m-%dT%H:%M:%SZ    # GNU
  else
    date -u -r "$epoch" +%Y-%m-%dT%H:%M:%SZ     # BSD
  fi
}

# ── Logging ──────────────────────────────────────────────────────────────
log() { printf '%s [ops-daemon] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >> "$LOG"; }

rotate_log() {
  if [[ -f "$LOG" ]] && [[ $(_file_size "$LOG" 2>/dev/null || echo 0) -gt $MAX_LOG_SIZE ]]; then
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

  # Expand env vars in command path (e.g. ${CLAUDE_PLUGIN_ROOT}/scripts/...)
  cmd=$(eval echo "$cmd")

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
      [[ -n "$next_run" ]] && next_iso=$(_date_from_epoch "$next_run" 2>/dev/null || echo "")
      [[ -n "$last_run" ]] && last_iso=$(_date_from_epoch "$last_run" 2>/dev/null || echo "")
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

  # Read brain cache metadata
  local brain_briefing_cached_at=""
  local brain_urgent_count=0
  local brain_last_memory_extraction=""

  if [[ -f "$DATA_DIR/cache/briefing.json" ]]; then
    brain_briefing_cached_at=$(python3 -c "
import json
try: print(json.load(open('$DATA_DIR/cache/briefing.json')).get('cached_at',''))
except: print('')
" 2>/dev/null || true)
  fi

  if [[ -f "$DATA_DIR/cache/urgent.json" ]]; then
    brain_urgent_count=$(python3 -c "
import json
try: print(json.load(open('$DATA_DIR/cache/urgent.json')).get('urgent_count',0))
except: print(0)
" 2>/dev/null || echo 0)
  fi

  if [[ -f "$DATA_DIR/memories/.health" ]]; then
    brain_last_memory_extraction=$(python3 -c "
import json
try: print(json.load(open('$DATA_DIR/memories/.health')).get('timestamp',''))
except: print('')
" 2>/dev/null || true)
  fi

  cat > "$HEALTH_FILE" <<EOF
{
  "timestamp": "$now",
  "pid": $$,
  "uptime_seconds": $uptime,
  "services": $services_json,
  "action_needed": $ACTION_NEEDED,
  "brain": {
    "briefing_cached_at": "$brain_briefing_cached_at",
    "urgent_count": $brain_urgent_count,
    "last_memory_extraction": "$brain_last_memory_extraction"
  }
}
EOF
}

# ── Cron service runner ───────────────────────────────────────────────────
run_cron_service() {
  local name="$1"
  local cmd
  cmd=$(get_service_field "$name" "command")
  if [[ -z "$cmd" ]]; then return; fi

  # Expand env vars in command path
  cmd=$(eval echo "$cmd")

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

# ── Intelligence functions (smart brain) ─────────────────────────────────

# Pre-compute morning briefing data so ops-go loads instantly.
prefetch_briefing_cache() {
  local CACHE_DIR="$DATA_DIR/cache"
  mkdir -p "$CACHE_DIR"
  local CACHE="$CACHE_DIR/briefing.json"
  local LAST_FETCH="$CACHE_DIR/.briefing_ts"

  # Throttle: only run every 5 min
  if [[ -f "$LAST_FETCH" ]]; then
    local last
    last=$(cat "$LAST_FETCH")
    local now
    now=$(date +%s)
    if (( now - last < 300 )); then return 0; fi
  fi

  log "BRAIN: refreshing briefing cache"

  local tmpdir
  tmpdir=$(mktemp -d)
  local -a _refresh_pids=()

  # Unread counts
  (command -v wacli &>/dev/null && wacli chats list --json 2>/dev/null | python3 -c "
import json,sys,datetime
data=json.load(sys.stdin).get('data',[]) or []
cutoff=(datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(days=7)).isoformat()
recent=[c for c in data if c.get('LastMessageTS','')>cutoff]
print(json.dumps({'total_chats':len(recent),'count':len(data)}))
" > "$tmpdir/wa.json" 2>/dev/null) &
  _refresh_pids+=($!)

  # Email count
  (command -v gog &>/dev/null && gog gmail search -j --results-only --no-input --max 10 "in:inbox" 2>/dev/null | python3 -c "
import json,sys
data=json.load(sys.stdin)
print(json.dumps({'unread_count':len(data)}))
" > "$tmpdir/email.json" 2>/dev/null) &
  _refresh_pids+=($!)

  # Open PRs
  (command -v gh &>/dev/null && gh pr list --json number,title,headRefName,createdAt --limit 20 2>/dev/null > "$tmpdir/prs.json") &
  _refresh_pids+=($!)

  # Projects placeholder with timestamp
  (python3 -c "
import json
print(json.dumps({'cached_at':'$(date -u +%Y-%m-%dT%H:%M:%SZ)'}))
" > "$tmpdir/projects.json" 2>/dev/null) &
  _refresh_pids+=($!)

  # Wait only on the 4 gather subshells above. Bare `wait` blocks on ALL
  # children — including long-lived services like message-listener — which
  # would freeze the monitor loop on the first refresh.
  wait "${_refresh_pids[@]}" 2>/dev/null || true

  # Merge all into briefing cache
  python3 -c "
import json, os, glob
result = {}
for f in glob.glob('$tmpdir/*.json'):
    try:
        with open(f) as fh:
            result[os.path.basename(f).replace('.json','')] = json.load(fh)
    except: pass
result['cached_at'] = '$(date -u +%Y-%m-%dT%H:%M:%SZ)'
with open('$CACHE', 'w') as fh:
    json.dump(result, fh, indent=2)
" 2>/dev/null || true

  rm -rf "$tmpdir"
  date +%s > "$LAST_FETCH"
  log "BRAIN: briefing cache updated"
}

# Check for messages that might need immediate attention.
detect_urgent_messages() {
  local URGENT_FILE="$DATA_DIR/cache/urgent.json"
  local LAST_CHECK="$DATA_DIR/cache/.urgent_ts"

  # Throttle: every 5 min
  if [[ -f "$LAST_CHECK" ]]; then
    local last
    last=$(cat "$LAST_CHECK")
    local now
    now=$(date +%s)
    if (( now - last < 300 )); then return 0; fi
  fi

  # Check WhatsApp for messages with urgent keywords (skip if wacli unavailable)
  if command -v wacli &>/dev/null; then
    wacli messages search --query "urgent OR asap OR deadline OR emergency OR ASAP" --json 2>/dev/null | python3 -c "
import json,sys,datetime
data=json.load(sys.stdin)
msgs=data.get('data',{}).get('messages',[]) or []
cutoff=(datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(hours=4)).isoformat()
urgent=[m for m in msgs if m.get('Timestamp','')>cutoff and not m.get('FromMe',True)]
if urgent:
    with open('$URGENT_FILE','w') as f:
        json.dump({'urgent_count':len(urgent),'messages':[{'from':m.get('ChatName',''),'text':m.get('Text','')[:100],'ts':m.get('Timestamp','')} for m in urgent[:5]]},f,indent=2)
" 2>/dev/null || true
  fi

  date +%s > "$LAST_CHECK"
}

# Trigger memory extraction early when new high-value messages arrive.
trigger_smart_memory_extraction() {
  local MEMORY_TRIGGER="$DATA_DIR/cache/.memory_trigger_ts"
  local MEM_SCRIPT="${CLAUDE_PLUGIN_ROOT:-$(dirname "$0")}/scripts/ops-memory-extractor.sh"

  # Only check every 10 min
  if [[ -f "$MEMORY_TRIGGER" ]]; then
    local last
    last=$(cat "$MEMORY_TRIGGER")
    local now
    now=$(date +%s)
    if (( now - last < 600 )); then return 0; fi
  fi

  # Check if new messages arrived since last extraction
  local last_extraction="$DATA_DIR/memories/.health"
  if [[ -f "$last_extraction" ]]; then
    local last_ts
    last_ts=$(python3 -c "
import json
try:
    d=json.load(open('$last_extraction'))
    print(d.get('timestamp',''))
except: print('')
" 2>/dev/null)

    if command -v wacli &>/dev/null; then
      local new_count
      new_count=$(wacli messages list --after="${last_ts:-$(_date_days_ago 1 +%Y-%m-%d 2>/dev/null || echo '')}" --limit=5 --json 2>/dev/null | python3 -c "
import json,sys
d=json.load(sys.stdin)
msgs=d.get('data',{}).get('messages',[]) or []
print(len(msgs))
" 2>/dev/null || echo 0)

      if [[ "$new_count" -gt 3 ]] && [[ -f "$MEM_SCRIPT" ]]; then
        log "BRAIN: $new_count new messages since last extraction — triggering memory update"
        bash "$MEM_SCRIPT" >> "$LOG_DIR/memory-extractor.log" 2>&1 &
      fi
    fi
  fi

  date +%s > "$MEMORY_TRIGGER"
}

# Cross-channel contact activity — track who's active across WA + email + Slack
build_contact_activity_index() {
  local CONTACT_INDEX="$DATA_DIR/cache/contacts_active.json"
  local LAST_BUILD="$DATA_DIR/cache/.contacts_ts"

  # Every 15 min
  if [[ -f "$LAST_BUILD" ]]; then
    local last; last=$(cat "$LAST_BUILD")
    if (( $(date +%s) - last < 900 )); then return 0; fi
  fi

  log "BRAIN: building cross-channel contact activity index"

  python3 - "$DATA_DIR" <<'PYEOF' 2>/dev/null || true
import json, subprocess, sys, datetime, os, collections

data_dir = sys.argv[1]
contacts = collections.defaultdict(lambda: {"channels": [], "last_seen": "", "msg_count": 0, "needs_reply": False})

# WhatsApp contacts
try:
    wa = json.loads(subprocess.check_output(["wacli", "chats", "list", "--json"], timeout=10, stderr=subprocess.DEVNULL))
    cutoff = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=7)).isoformat()
    for chat in (wa.get("data") or []):
        if chat.get("LastMessageTS", "") < cutoff: continue
        name = chat.get("Name", "Unknown")
        contacts[name]["channels"].append("whatsapp")
        contacts[name]["last_seen"] = max(contacts[name]["last_seen"], chat.get("LastMessageTS", ""))
        contacts[name]["jid"] = chat.get("JID", "")
except: pass

# Email contacts (recent senders)
try:
    em = json.loads(subprocess.check_output(
        ["gog", "gmail", "search", "-j", "--results-only", "--no-input", "--max", "20", "in:inbox newer_than:3d"],
        timeout=15, stderr=subprocess.DEVNULL
    ))
    for thread in (em or []):
        sender = thread.get("from", "")
        name = sender.split("<")[0].strip().strip('"')
        if name:
            contacts[name]["channels"].append("email")
            contacts[name]["email"] = sender
            contacts[name]["last_seen"] = max(contacts[name]["last_seen"], thread.get("date", ""))
except: pass

# Merge with existing memories
mem_dir = os.path.join(data_dir, "memories")
if os.path.isdir(mem_dir):
    for f in os.listdir(mem_dir):
        if f.startswith("contact_") and f.endswith(".md"):
            name = f.replace("contact_", "").replace(".md", "").replace("_", " ").title()
            if name in contacts:
                contacts[name]["has_memory"] = True

# Score: multi-channel contacts rank higher
scored = []
for name, info in contacts.items():
    info["name"] = name
    info["channels"] = list(set(info["channels"]))
    info["score"] = len(info["channels"]) * 2 + info["msg_count"]
    scored.append(info)

scored.sort(key=lambda x: (len(x["channels"]), x["last_seen"]), reverse=True)

with open(os.path.join(data_dir, "cache", "contacts_active.json"), "w") as f:
    json.dump({"updated": datetime.datetime.now(datetime.timezone.utc).isoformat(), "contacts": scored[:50]}, f, indent=2)
PYEOF

  date +%s > "$LAST_BUILD"
  log "BRAIN: contact activity index built"
}

# Calendar context — pre-fetch today's meetings so skills know what's coming
prefetch_calendar() {
  local CAL_CACHE="$DATA_DIR/cache/calendar_today.json"
  local LAST_FETCH="$DATA_DIR/cache/.calendar_ts"

  # Every 15 min
  if [[ -f "$LAST_FETCH" ]]; then
    local last; last=$(cat "$LAST_FETCH")
    if (( $(date +%s) - last < 900 )); then return 0; fi
  fi

  if command -v gog &>/dev/null; then
    log "BRAIN: refreshing calendar cache"
    gog calendar events primary --today --json > "$CAL_CACHE" 2>/dev/null || echo '[]' > "$CAL_CACHE"
    date +%s > "$LAST_FETCH"
  fi
}

# Project health snapshot — git status + CI for registered repos
prefetch_project_health() {
  local PROJ_CACHE="$DATA_DIR/cache/projects_health.json"
  local LAST_FETCH="$DATA_DIR/cache/.projects_ts"
  local REGISTRY="${CLAUDE_PLUGIN_ROOT:-$(dirname "$0")/../}/scripts/registry.json"

  # Every 10 min
  if [[ -f "$LAST_FETCH" ]]; then
    local last; last=$(cat "$LAST_FETCH")
    if (( $(date +%s) - last < 600 )); then return 0; fi
  fi

  if [[ ! -f "$REGISTRY" ]]; then return 0; fi

  log "BRAIN: refreshing project health cache"

  python3 - "$REGISTRY" "$PROJ_CACHE" <<'PYEOF' 2>/dev/null || true
import json, subprocess, sys, os

registry_path, output_path = sys.argv[1], sys.argv[2]
try:
    registry = json.load(open(registry_path))
except: registry = {"projects": []}

results = []
for proj in (registry.get("projects") or [])[:10]:
    path = os.path.expanduser(proj.get("path", ""))
    name = proj.get("alias", proj.get("name", "unknown"))
    if not os.path.isdir(path): continue

    info = {"name": name, "path": path}

    # Git status
    try:
        status = subprocess.check_output(["git", "-C", path, "status", "--porcelain"], timeout=5, stderr=subprocess.DEVNULL).decode()
        info["uncommitted"] = len([l for l in status.strip().split("\n") if l.strip()])
    except: info["uncommitted"] = -1

    # Branch
    try:
        info["branch"] = subprocess.check_output(["git", "-C", path, "branch", "--show-current"], timeout=5, stderr=subprocess.DEVNULL).decode().strip()
    except: info["branch"] = "unknown"

    # Commits ahead of remote
    try:
        ahead = subprocess.check_output(["git", "-C", path, "rev-list", "--count", "@{u}..HEAD"], timeout=5, stderr=subprocess.DEVNULL).decode().strip()
        info["commits_ahead"] = int(ahead)
    except: info["commits_ahead"] = 0

    results.append(info)

import datetime
with open(output_path, "w") as f:
    json.dump({"updated": datetime.datetime.now(datetime.timezone.utc).isoformat(), "projects": results}, f, indent=2)
PYEOF

  date +%s > "$LAST_FETCH"
  log "BRAIN: project health cache updated"
}

# ── Daemon registration (cross-OS) ────────────────────────────────────────
# On macOS we load a launchd agent; on Linux a systemd --user unit + timer;
# on Windows a Task Scheduler (schtasks) entry. Each path is best-effort and
# returns a non-zero exit if the host service manager isn't reachable — the
# caller (setup.sh / user) can decide how to surface the warning.

# Resolve plugin-root-relative paths for daemon scripts (so the unit files
# embed absolute paths that still work when invoked by another user context).
OPS_DAEMON_SCRIPT="$SCRIPT_DIR/scripts/ops-daemon.sh"
OPS_KEEPALIVE_SCRIPT="$SCRIPT_DIR/scripts/wacli-keepalive.sh"

install_daemon_launchd() {
  command -v launchctl >/dev/null 2>&1 || {
    echo "install_daemon_launchd: launchctl not found on PATH" >&2
    return 1
  }
  local agents_dir="$HOME/Library/LaunchAgents"
  mkdir -p "$agents_dir"

  local daemon_plist_src="$SCRIPT_DIR/scripts/com.claude-ops.daemon.plist"
  local keepalive_plist_src="$SCRIPT_DIR/scripts/com.claude-ops.wacli-keepalive.plist"
  local daemon_plist_dst="$agents_dir/com.claude-ops.daemon.plist"
  local keepalive_plist_dst="$agents_dir/com.claude-ops.wacli-keepalive.plist"

  local bash_path
  bash_path="$(command -v bash)"
  if [[ -z "$bash_path" ]]; then
    echo "install_daemon_launchd: bash not found on PATH" >&2
    return 1
  fi
  local plugin_root="$SCRIPT_DIR"
  if [[ -z "$plugin_root" ]] || [[ ! -d "$plugin_root/scripts" ]]; then
    echo "install_daemon_launchd: invalid plugin root: $plugin_root" >&2
    return 1
  fi

  # Substitute placeholders while copying.
  if [[ -f "$daemon_plist_src" ]]; then
    sed \
      -e "s|__BASH_PATH__|$bash_path|g" \
      -e "s|__PLUGIN_ROOT__|$plugin_root|g" \
      -e "s|__DAEMON_SCRIPT_PATH__|$OPS_DAEMON_SCRIPT|g" \
      -e "s|__LOG_DIR__|$LOG_DIR|g" \
      -e "s|__HOME__|$HOME|g" \
      "$daemon_plist_src" > "$daemon_plist_dst"
    launchctl unload -w "$daemon_plist_dst" 2>/dev/null || true
    launchctl load -w "$daemon_plist_dst"
    log "INSTALL(launchd): loaded $daemon_plist_dst"
  fi

  if [[ -f "$keepalive_plist_src" ]]; then
    sed \
      -e "s|__BASH_PATH__|$bash_path|g" \
      -e "s|__PLUGIN_ROOT__|$plugin_root|g" \
      -e "s|__KEEPALIVE_SCRIPT_PATH__|$OPS_KEEPALIVE_SCRIPT|g" \
      -e "s|__LOG_DIR__|$LOG_DIR|g" \
      -e "s|__HOME__|$HOME|g" \
      "$keepalive_plist_src" > "$keepalive_plist_dst"
    launchctl unload -w "$keepalive_plist_dst" 2>/dev/null || true
    launchctl load -w "$keepalive_plist_dst"
    log "INSTALL(launchd): loaded $keepalive_plist_dst"
  fi
}

uninstall_daemon_launchd() {
  command -v launchctl >/dev/null 2>&1 || {
    echo "uninstall_daemon_launchd: launchctl not found on PATH" >&2
    return 1
  }
  local agents_dir="$HOME/Library/LaunchAgents"
  local f
  for f in com.claude-ops.daemon.plist com.claude-ops.wacli-keepalive.plist; do
    if [[ -f "$agents_dir/$f" ]]; then
      launchctl unload -w "$agents_dir/$f" 2>/dev/null || true
      rm -f "$agents_dir/$f"
      log "UNINSTALL(launchd): removed $agents_dir/$f"
    fi
  done
}

install_daemon_systemd() {
  command -v systemctl >/dev/null 2>&1 || {
    echo "install_daemon_systemd: systemctl not found on PATH" >&2
    return 1
  }
  local unit_dir="$HOME/.config/systemd/user"
  mkdir -p "$unit_dir"

  # Main daemon: a oneshot service triggered by a 5-minute timer that runs
  # ops-daemon.sh in single-pass mode (--run-once). This mirrors the
  # ThrottleInterval/KeepAlive behavior of the launchd plist without holding
  # a persistent bash process in user-session memory between firings.
  cat > "$unit_dir/claude-ops.service" <<EOF
[Unit]
Description=claude-ops background brain (ops-daemon single pass)
After=default.target

[Service]
Type=oneshot
ExecStart=/usr/bin/env bash $OPS_DAEMON_SCRIPT --run-once
StandardOutput=append:$LOG_DIR/ops-daemon-stdout.log
StandardError=append:$LOG_DIR/ops-daemon-stderr.log
Environment=HOME=$HOME
EOF

  cat > "$unit_dir/claude-ops.timer" <<EOF
[Unit]
Description=Fire claude-ops ops-daemon every 5 minutes
After=default.target

[Timer]
OnBootSec=30s
OnUnitActiveSec=5min
AccuracySec=30s
Unit=claude-ops.service

[Install]
WantedBy=timers.target
EOF

  # wacli-keepalive: persistent service (Restart=always) — no timer needed.
  cat > "$unit_dir/claude-ops-wacli-keepalive.service" <<EOF
[Unit]
Description=claude-ops wacli keepalive
After=default.target

[Service]
Type=simple
ExecStart=/usr/bin/env bash $OPS_KEEPALIVE_SCRIPT
Restart=always
RestartSec=60
StandardOutput=append:$LOG_DIR/wacli-launchd-stdout.log
StandardError=append:$LOG_DIR/wacli-launchd-stderr.log
Environment=HOME=$HOME

[Install]
WantedBy=default.target
EOF

  systemctl --user daemon-reload
  systemctl --user enable --now claude-ops.timer
  systemctl --user enable --now claude-ops-wacli-keepalive.service || true
  log "INSTALL(systemd): enabled claude-ops.timer + claude-ops-wacli-keepalive.service"
}

uninstall_daemon_systemd() {
  command -v systemctl >/dev/null 2>&1 || {
    echo "uninstall_daemon_systemd: systemctl not found on PATH" >&2
    return 1
  }
  local unit_dir="$HOME/.config/systemd/user"
  systemctl --user disable --now claude-ops.timer 2>/dev/null || true
  systemctl --user disable --now claude-ops.service 2>/dev/null || true
  systemctl --user disable --now claude-ops-wacli-keepalive.service 2>/dev/null || true
  rm -f "$unit_dir/claude-ops.service" \
        "$unit_dir/claude-ops.timer" \
        "$unit_dir/claude-ops-wacli-keepalive.service"
  systemctl --user daemon-reload 2>/dev/null || true
  log "UNINSTALL(systemd): removed claude-ops units"
}

install_daemon_schtasks() {
  # Windows best-effort: prefer bash.exe (Git Bash / WSL bash) since the daemon
  # is a bash script. If unavailable, fall back to pwsh wrapper. Users on real
  # WSL should prefer install_daemon_systemd from inside the WSL shell — it
  # gives proper timer semantics instead of Task Scheduler's 5-minute floor.
  local schtasks_bin
  if command -v schtasks >/dev/null 2>&1; then
    schtasks_bin="schtasks"
  elif command -v schtasks.exe >/dev/null 2>&1; then
    schtasks_bin="schtasks.exe"
  else
    echo "install_daemon_schtasks: schtasks not found on PATH" >&2
    return 1
  fi

  local run_cmd
  if command -v bash.exe >/dev/null 2>&1 || command -v bash >/dev/null 2>&1; then
    run_cmd="bash.exe $OPS_DAEMON_SCRIPT --run-once"
  else
    # pwsh wrapper fallback — expects the user to have bash reachable inside
    # the invoked shell (WSL default, Git Bash, etc.).
    run_cmd="pwsh.exe -NoProfile -File $SCRIPT_DIR/scripts/ops-daemon-wrapper.ps1"
  fi

  "$schtasks_bin" /Create /F /SC MINUTE /MO 5 \
    /TN "ClaudeOpsDaemon" \
    /TR "$run_cmd" \
    || { echo "install_daemon_schtasks: schtasks /Create failed" >&2; return 1; }

  local keepalive_cmd="bash.exe $OPS_KEEPALIVE_SCRIPT"
  "$schtasks_bin" /Create /F /SC MINUTE /MO 1 \
    /TN "ClaudeOpsWacliKeepalive" \
    /TR "$keepalive_cmd" \
    || true
  log "INSTALL(schtasks): registered ClaudeOpsDaemon + ClaudeOpsWacliKeepalive"
}

uninstall_daemon_schtasks() {
  local schtasks_bin
  if command -v schtasks >/dev/null 2>&1; then
    schtasks_bin="schtasks"
  elif command -v schtasks.exe >/dev/null 2>&1; then
    schtasks_bin="schtasks.exe"
  else
    echo "uninstall_daemon_schtasks: schtasks not found on PATH" >&2
    return 1
  fi
  "$schtasks_bin" /Delete /F /TN "ClaudeOpsDaemon" 2>/dev/null || true
  "$schtasks_bin" /Delete /F /TN "ClaudeOpsWacliKeepalive" 2>/dev/null || true
  log "UNINSTALL(schtasks): removed ClaudeOpsDaemon + ClaudeOpsWacliKeepalive"
}

install_daemon() {
  local os
  os="$(ops_os 2>/dev/null || uname -s)"
  case "$os" in
    macos|Darwin*)                                        install_daemon_launchd ;;
    debian|fedora|arch|suse|alpine|linux|wsl|Linux*)      install_daemon_systemd ;;
    windows|MINGW*|MSYS*|CYGWIN*)                         install_daemon_schtasks ;;
    *) echo "install_daemon: unsupported OS '$os' for daemon registration" >&2; return 1 ;;
  esac
}

uninstall_daemon() {
  local os
  os="$(ops_os 2>/dev/null || uname -s)"
  case "$os" in
    macos|Darwin*)                                        uninstall_daemon_launchd ;;
    debian|fedora|arch|suse|alpine|linux|wsl|Linux*)      uninstall_daemon_systemd ;;
    windows|MINGW*|MSYS*|CYGWIN*)                         uninstall_daemon_schtasks ;;
    *) echo "uninstall_daemon: unsupported OS '$os' for daemon registration" >&2; return 1 ;;
  esac
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

# ── CLI dispatch ──────────────────────────────────────────────────────────
# Flags are positional and mutually exclusive-ish. When none are given we
# fall through to the classic "enter monitor loop" behavior so the existing
# launchd plist (which invokes `bash ops-daemon.sh` with no arguments) keeps
# working unchanged.
OPS_RUN_ONCE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --os)
      # Print the detected OS bucket (for setup scripts & debugging).
      ops_os 2>/dev/null || uname -s
      exit 0
      ;;
    --install)
      install_daemon
      exit $?
      ;;
    --uninstall)
      uninstall_daemon
      exit $?
      ;;
    --run-once)
      # Single-pass execution: for systemd timer / schtasks invocations that
      # fire the daemon periodically instead of keeping it resident.
      OPS_RUN_ONCE=1
      shift
      ;;
    -h|--help)
      cat <<EOF
Usage: $(basename "$0") [--os|--install|--uninstall|--run-once]
  (no args)    Start the resident daemon monitor loop (launchd-compatible).
  --os         Print the detected OS bucket and exit.
  --install    Register the daemon with the host service manager
               (launchd on macOS, systemd --user on Linux, schtasks on Windows).
  --uninstall  Remove the host service manager registration.
  --run-once   Run one intelligence + health pass and exit (for timer-based hosts).
EOF
      exit 0
      ;;
    *)
      echo "Unknown argument: $1 (try --help)" >&2
      exit 2
      ;;
  esac
done

# ── Main ──────────────────────────────────────────────────────────────────
log "START: ops-daemon pid=$$ starting (run_once=$OPS_RUN_ONCE)"
rotate_log

if ! load_services_config; then
  log "FATAL: no services config — writing empty health and sleeping"
  cat > "$HEALTH_FILE" <<EOF
{"timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)", "pid": $$, "uptime_seconds": 0, "services": {}, "action_needed": null}
EOF
  # In --run-once mode we exit after writing the health file; otherwise
  # sleep forever until SIGTERM (launchd/systemd simple-mode keeps us alive).
  if [[ $OPS_RUN_ONCE -eq 1 ]]; then exit 0; fi
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

  # ── Intelligence pass (smart brain) ──────────────────────────────────────
  # These run with their own internal throttles — safe to call every loop
  prefetch_briefing_cache          # Every 5 min: WA/email/PR counts for ops-go
  detect_urgent_messages           # Every 5 min: keyword scan for time-sensitive msgs
  trigger_smart_memory_extraction  # Every 10 min: haiku extraction if new msgs arrived
  build_contact_activity_index     # Every 15 min: cross-channel contact scoring
  prefetch_calendar                # Every 15 min: today's meetings for context
  prefetch_project_health          # Every 10 min: git/branch status per registered repo

  write_daemon_health

  # In --run-once mode we return after a single intelligence + health pass
  # so timer-driven hosts (systemd .timer, Task Scheduler) don't accumulate
  # overlapping long-lived daemon processes.
  if [[ $OPS_RUN_ONCE -eq 1 ]]; then
    log "RUN-ONCE: single pass complete — exiting"
    exit 0
  fi

  sleep 30
done
