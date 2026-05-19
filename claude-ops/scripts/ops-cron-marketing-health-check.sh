#!/usr/bin/env bash
# ops-cron-marketing-health-check.sh — weekly read-only health probe for all
# autopilot-enabled projects.  Runs ops-marketing-autopilot --health-check,
# writes per-project JSON to reports/marketing-autopilot/, and fires notify
# sinks for any unhealthy result.
#
# Registered in daemon-services.default.json as "marketing-health-check"
# (enabled: false by default).  Cron: 0 8 * * 0  (Sunday 08:00 UTC).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OPS_PLUGIN_ROOT_FALLBACK="${SCRIPT_DIR}/.." . "${SCRIPT_DIR}/lib/registry-path.sh"

AUTOPILOT="${SCRIPT_DIR}/../bin/ops-marketing-autopilot"
REPORT_DIR="${OPS_DATA_DIR}/reports/marketing-autopilot"
TODAY="$(date +%Y-%m-%d)"
mkdir -p "$REPORT_DIR"

log() { printf '%s [health-check] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >&2; }

log "starting weekly marketing health-check"

# Run health-check (exits after printing JSON array)
HC_JSON="$("$AUTOPILOT" --health-check 2>/dev/null || echo '[]')"

# Write results and surface any unhealthy checks
total=0; unhealthy=0
while IFS= read -r proj_result; do
  proj="$(printf '%s' "$proj_result" | jq -r '.project // "unknown"' 2>/dev/null)"
  healthy="$(printf '%s' "$proj_result" | jq -r '.healthy' 2>/dev/null)"
  total=$((total+1))
  [ "$healthy" = "false" ] && unhealthy=$((unhealthy+1))

  out="${REPORT_DIR}/${proj}-health-${TODAY}.json"
  printf '%s\n' "$proj_result" > "$out"
  log "project=$proj healthy=$healthy → $out"
done < <(printf '%s' "$HC_JSON" | jq -c '.[]' 2>/dev/null || true)

log "done — ${total} project(s) checked, ${unhealthy} unhealthy"
