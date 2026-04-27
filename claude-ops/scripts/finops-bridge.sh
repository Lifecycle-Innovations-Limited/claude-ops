#!/usr/bin/env bash
# finops-bridge.sh — bidirectional bridge between claude-ops and finops-dashboard.
#
# READ helpers (used by ops-go / ops-revenue / ops-fires / yolo-cfo agent):
#   finops-bridge.sh snapshot              -> /api/ops/snapshot   (full canonical state)
#   finops-bridge.sh anomalies [severity]  -> /api/ops/anomalies
#   finops-bridge.sh revenue [by]          -> /api/ops/revenue (by=project|account|entity)
#
# PUSH helpers (used by ops-yolo / ops-merge / stripe-mapper / etc.):
#   finops-bridge.sh push-event <kind> <project> [amount_saved] [title] [payload_json]
#   finops-bridge.sh resolve-anomaly <id> [project] [amount_saved]
#
# Auth:
#   FINOPS_OPS_API_TOKEN — bearer token (from Doppler `finops-dashboard` prd config)
#   FINOPS_DASHBOARD_URL — base URL of your finops-dashboard install
#
# Both must be set in the user's shell or pulled from Doppler. There is no
# default — public repo, no real URLs hardcoded.
#
# All commands FAIL OPEN with empty JSON ({} for objects, [] for lists) on any
# error — so consumers can fall back gracefully to raw API queries.

set -euo pipefail

BASE="${FINOPS_DASHBOARD_URL:-}"
TOKEN="${FINOPS_OPS_API_TOKEN:-}"

if [[ -z "$BASE" || -z "$TOKEN" ]] && command -v doppler >/dev/null 2>&1; then
  [[ -z "$TOKEN" ]] && TOKEN="$(doppler secrets get FINOPS_OPS_API_TOKEN --plain --project finops-dashboard --config prd 2>/dev/null || true)"
  [[ -z "$BASE"  ]] && BASE="$(doppler secrets get FINOPS_DASHBOARD_URL --plain --project finops-dashboard --config prd 2>/dev/null || true)"
fi

if [[ -z "$BASE" ]]; then
  case "${1:-}" in
    snapshot|anomalies|revenue|push-event|resolve-anomaly)
      case "${1:-}" in
        anomalies)        echo "[]" ;;
        *)                echo "{}" ;;
      esac
      exit 0
      ;;
  esac
fi

CURL_OPTS=(--silent --show-error --fail --connect-timeout 5 --max-time 15)
[[ -n "$TOKEN" ]] && CURL_OPTS+=(-H "Authorization: Bearer ${TOKEN}")
CURL_OPTS+=(-H "Accept: application/json")

emit_empty() {
  case "$1" in
    list) echo "[]" ;;
    *)    echo "{}" ;;
  esac
}

cmd_snapshot() {
  curl "${CURL_OPTS[@]}" "${BASE}/api/ops/snapshot" 2>/dev/null || emit_empty obj
}

cmd_anomalies() {
  local sev="${1:-}"
  local url="${BASE}/api/ops/anomalies?status=open&limit=50"
  [[ -n "$sev" ]] && url="${url}&severity=${sev}"
  curl "${CURL_OPTS[@]}" "$url" 2>/dev/null || emit_empty list
}

cmd_revenue() {
  local by="${1:-project}"
  curl "${CURL_OPTS[@]}" "${BASE}/api/ops/revenue?by=${by}" 2>/dev/null || emit_empty obj
}

cmd_push_event() {
  local kind="${1:?kind required}"
  local project="${2:-}"
  local amount="${3:-}"
  local title="${4:-}"
  local payload_json="${5:-{}}"
  local idem="${6:-$(date +%s)-$$-${RANDOM}-${RANDOM}}"

  [[ -z "$TOKEN" ]] && {
    echo "{\"error\":\"FINOPS_OPS_API_TOKEN not set\"}" >&2
    return 1
  }

  # Validate payload_json before passing to --argjson (bad JSON aborts jq under set -e)
  local safe_payload
  safe_payload=$(printf '%s' "$payload_json" | jq -c . 2>/dev/null) || safe_payload='{}'
  local body
  body=$(jq -nc \
    --arg kind "$kind" --arg project "$project" --arg title "$title" \
    --arg idem "$idem" --argjson payload "$safe_payload" \
    --arg amount "$amount" \
    '{kind:$kind, project:($project|select(length>0)),
      amount_saved:($amount|select(length>0)|tonumber? // null),
      title:($title|select(length>0)), payload:$payload,
      source:"claude-ops", idempotency_key:$idem}' 2>/dev/null) \
    || { emit_empty obj; exit 0; }

  curl "${CURL_OPTS[@]}" -X POST "${BASE}/api/ops/events" \
    -H "Content-Type: application/json" -d "$body" 2>/dev/null || emit_empty obj
}

cmd_resolve_anomaly() {
  local id="${1:?anomaly id required}"
  local project="${2:-}"
  local amount="${3:-}"

  [[ -z "$TOKEN" ]] && return 1

  local body
  body=$(jq -nc --arg project "$project" --arg amount "$amount" \
    '{project:($project|select(length>0)),
      amount_saved:($amount|select(length>0)|tonumber? // null),
      source:"claude-ops"}' 2>/dev/null) \
    || { emit_empty obj; exit 0; }

  curl "${CURL_OPTS[@]}" -X POST "${BASE}/api/ops/anomalies/${id}/resolve" \
    -H "Content-Type: application/json" -d "$body" 2>/dev/null || emit_empty obj
}

case "${1:-}" in
  snapshot)         shift; cmd_snapshot "$@" ;;
  anomalies)        shift; cmd_anomalies "$@" ;;
  revenue)          shift; cmd_revenue "$@" ;;
  push-event)       shift; cmd_push_event "$@" ;;
  resolve-anomaly)  shift; cmd_resolve_anomaly "$@" ;;
  ""|-h|--help)
    sed -n '/^#/p' "$0" | sed 's/^# \{0,1\}//' | head -25
    exit 0
    ;;
  *)
    echo "unknown command: $1" >&2
    exit 64
    ;;
esac
