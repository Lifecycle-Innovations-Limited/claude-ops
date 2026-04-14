#!/usr/bin/env bash
# ops-fires-watcher.sh — Daemon loop that polls fire sources every 60s and
# pushes notifications for new CRITICAL/HIGH incidents.
#
# Sources polled each tick:
#   - bin/ops-infra       (ECS cluster health — 'down' / 'degraded' → HIGH/CRITICAL)
#   - Sentry API          (unresolved issues at level:error/fatal when
#                          $SENTRY_AUTH_TOKEN + sentry_org are configured)
#
# State file: ${DATA_DIR}/fires-watcher.state.json — keyed by incident
# fingerprint, tracks { severity, last_notified_at, first_seen_at }.
#
# Debounce policy:
#   - Don't re-notify for the same fingerprint within 30 minutes
#   - UNLESS the severity *rises* (e.g. degraded → down), in which case we
#     re-notify immediately and update the stored severity.
#
# Rule 5: read-only polling — this watcher never mutates infra.

set -euo pipefail

# ─── Paths ───────────────────────────────────────────────────────────────────
PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091
[ -r "$PLUGIN_ROOT/lib/os-detect.sh" ] && . "$PLUGIN_ROOT/lib/os-detect.sh"
# shellcheck disable=SC1091
[ -r "$PLUGIN_ROOT/lib/credential-store.sh" ] && . "$PLUGIN_ROOT/lib/credential-store.sh"

DATA_DIR="${OPS_DATA_DIR:-${CLAUDE_PLUGIN_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}}"
LOG_DIR="$DATA_DIR/logs"
LOG="$LOG_DIR/fires-watcher.log"
STATE_FILE="${FIRES_WATCHER_STATE:-$DATA_DIR/fires-watcher.state.json}"
HEALTH_FILE="${FIRES_WATCHER_HEALTH:-$DATA_DIR/fires-watcher.health}"
NOTIFY="$PLUGIN_ROOT/scripts/ops-notify.sh"
OPS_INFRA="$PLUGIN_ROOT/bin/ops-infra"
PREFS_PATH="${PREFS_PATH:-$DATA_DIR/preferences.json}"

POLL_INTERVAL="${FIRES_WATCHER_INTERVAL:-60}"
DEBOUNCE_SECS="${FIRES_WATCHER_DEBOUNCE:-1800}"  # 30 minutes

mkdir -p "$LOG_DIR"
mkdir -p "$(dirname "$STATE_FILE")"

# ─── Logging ────────────────────────────────────────────────────────────────
log() {
  printf '%s [fires-watcher] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >> "$LOG"
}

# ─── Severity rank (higher = worse) ─────────────────────────────────────────
sev_rank() {
  case "$1" in
    CRITICAL) echo 4 ;;
    HIGH)     echo 3 ;;
    MEDIUM)   echo 2 ;;
    LOW)      echo 1 ;;
    *)        echo 0 ;;
  esac
}

# ─── State I/O ──────────────────────────────────────────────────────────────
ensure_state() {
  if [ ! -f "$STATE_FILE" ]; then
    echo '{"incidents":{}}' > "$STATE_FILE"
  fi
}

# Decide if we should notify given a fingerprint + new severity.
# Echoes "notify" or "skip"; on notify, updates the state file.
should_notify() {
  local fp="$1" new_sev="$2" now_epoch
  now_epoch="$(date +%s)"
  ensure_state

  command -v jq >/dev/null 2>&1 || { echo "notify"; return 0; }

  local prev_sev prev_notified
  prev_sev="$(jq -r --arg fp "$fp" '.incidents[$fp].severity // empty' "$STATE_FILE")"
  prev_notified="$(jq -r --arg fp "$fp" '.incidents[$fp].last_notified_at // 0' "$STATE_FILE")"

  local decision="skip"
  if [ -z "$prev_sev" ]; then
    decision="notify"   # brand new incident
  elif [ "$(sev_rank "$new_sev")" -gt "$(sev_rank "$prev_sev")" ]; then
    decision="notify"   # severity escalated
  else
    local age=$(( now_epoch - prev_notified ))
    if [ "$age" -ge "$DEBOUNCE_SECS" ]; then
      decision="notify"   # debounce window elapsed
    fi
  fi

  if [ "$decision" = "notify" ]; then
    local tmp
    tmp="$(mktemp)"
    jq --arg fp "$fp" \
       --arg sev "$new_sev" \
       --argjson now "$now_epoch" \
       '.incidents[$fp] = {
          severity: $sev,
          last_notified_at: $now,
          first_seen_at: (.incidents[$fp].first_seen_at // $now)
        }' "$STATE_FILE" > "$tmp" && mv "$tmp" "$STATE_FILE"
  fi

  echo "$decision"
}

# ─── Notify wrapper ─────────────────────────────────────────────────────────
dispatch() {
  local severity="$1" title="$2" body="$3" link="${4:-}"
  if [ ! -x "$NOTIFY" ]; then
    log "WARN: $NOTIFY not executable — skipping dispatch"
    return 0
  fi
  if [ -n "$link" ]; then
    "$NOTIFY" "$severity" "$title" "$body" --link "$link" || \
      log "dispatch failed for title=$title"
  else
    "$NOTIFY" "$severity" "$title" "$body" || \
      log "dispatch failed for title=$title"
  fi
}

# ─── Source: ops-infra ──────────────────────────────────────────────────────
probe_infra() {
  [ -x "$OPS_INFRA" ] || return 0
  command -v jq >/dev/null 2>&1 || return 0

  local output
  output="$("$OPS_INFRA" 2>/dev/null || echo '{}')"
  [ -z "$output" ] && return 0

  # Emit lines: "SEV<TAB>fingerprint<TAB>title<TAB>body"
  echo "$output" | jq -r '
    (.clusters // [])[]
    | select(.status == "down" or .status == "degraded")
    | "\(if .status == "down" then "CRITICAL" else "HIGH" end)\t" +
      "infra:\(.cluster):\(.status)\t" +
      "ECS \(.cluster) \(.status)\t" +
      "Cluster \(.cluster) is \(.status). Services: \((.services // []) | map(select(.running != .desired)) | map("\(.name) \(.running)/\(.desired)") | join(", "))"
  ' 2>/dev/null || true
}

# ─── Source: Sentry ─────────────────────────────────────────────────────────
probe_sentry() {
  local token="${SENTRY_AUTH_TOKEN:-}"
  local org="${SENTRY_ORG:-}"
  if [ -z "$token" ] && [ -f "$PREFS_PATH" ] && command -v jq >/dev/null 2>&1; then
    token="$(jq -r '.sentry_auth_token // empty' "$PREFS_PATH" 2>/dev/null || true)"
  fi
  if [ -z "$org" ] && [ -f "$PREFS_PATH" ] && command -v jq >/dev/null 2>&1; then
    org="$(jq -r '.sentry_org // empty' "$PREFS_PATH" 2>/dev/null || true)"
  fi

  if [ -z "$token" ] || [ -z "$org" ]; then
    return 0
  fi
  command -v curl >/dev/null 2>&1 || return 0
  command -v jq   >/dev/null 2>&1 || return 0

  local response
  response="$(curl -s --max-time 15 \
    -H "Authorization: Bearer ${token}" \
    "https://sentry.io/api/0/organizations/${org}/issues/?query=is:unresolved+level:[error,fatal]&limit=25" \
    2>/dev/null || echo '[]')"

  # Defensively fall back if response is not valid JSON array
  if ! echo "$response" | jq -e 'type == "array"' >/dev/null 2>&1; then
    return 0
  fi

  echo "$response" | jq -r '
    .[]
    | select(.level == "error" or .level == "fatal")
    | "\(if .level == "fatal" then "CRITICAL" else "HIGH" end)\t" +
      "sentry:\(.id)\t" +
      "Sentry: \((.title // "issue") | .[0:80])\t" +
      "Project: \(.project.slug // "unknown"). Events: \(.count // "?"). Users: \(.userCount // "?"). URL: \(.permalink // "")"
  ' 2>/dev/null || true
}

# ─── Health writer ──────────────────────────────────────────────────────────
write_health() {
  local status="$1" msg="${2:-}"
  cat > "$HEALTH_FILE" <<EOF
{
  "status": "${status}",
  "message": "${msg}",
  "last_tick": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "poll_interval": ${POLL_INTERVAL},
  "state_file": "${STATE_FILE}"
}
EOF
}

# ─── Main tick ──────────────────────────────────────────────────────────────
tick() {
  local events new_count=0 seen_count=0
  events="$( (probe_infra; probe_sentry) 2>/dev/null || true )"
  if [ -z "$events" ]; then
    write_health "ok" "no events"
    return 0
  fi

  while IFS=$'\t' read -r sev fp title body; do
    [ -z "${fp:-}" ] && continue
    seen_count=$((seen_count + 1))
    local decision
    decision="$(should_notify "$fp" "$sev")"
    if [ "$decision" = "notify" ]; then
      local link=""
      # Prefer an explicit URL embedded in the body (e.g., Sentry permalink)
      link="$(printf '%s' "$body" | sed -n 's#.*URL: \(https\?://[^ ]*\).*#\1#p' | head -1)"
      if [ -n "$link" ]; then
        dispatch "$sev" "$title" "$body" "$link"
      else
        dispatch "$sev" "$title" "$body"
      fi
      new_count=$((new_count + 1))
      log "NEW $sev $fp :: $title"
    fi
  done <<< "$events"

  write_health "ok" "seen=${seen_count} notified=${new_count}"
}

# ─── Loop ───────────────────────────────────────────────────────────────────
log "START fires-watcher (interval=${POLL_INTERVAL}s, debounce=${DEBOUNCE_SECS}s)"
write_health "starting" "booting fires-watcher"

trap 'log "STOP SIGTERM"; write_health "stopped" "received SIGTERM"; exit 0' TERM
trap 'log "STOP SIGINT";  write_health "stopped" "received SIGINT";  exit 0' INT

while true; do
  tick || log "TICK ERROR (continuing)"
  sleep "$POLL_INTERVAL"
done
