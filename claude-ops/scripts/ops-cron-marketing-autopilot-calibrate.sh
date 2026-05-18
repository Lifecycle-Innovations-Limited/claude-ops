#!/usr/bin/env bash
# ops-cron-marketing-autopilot-calibrate.sh — Thin cron wrapper for Tier 3 calibration.
#
# Mirrors ops-cron-marketing-autopilot.sh. For each project with
# autopilot.enabled == true AND autopilot.weekly_synthesis == true, runs:
#   python3 calibrate.py --project <P> --data-dir <OPS_DATA_DIR>
#
# Exits 0 even if individual projects fail (logs + continues).
# Resolves PREFS via ${OPS_AUTOPILOT_PREFS:-${OPS_DATA_DIR}/preferences.json}.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$SCRIPT_DIR/..}"

CALIBRATE_PY="$PLUGIN_ROOT/scripts/lib/creative/calibrate.py"
if [ ! -f "$CALIBRATE_PY" ]; then
  echo "[calibrate-cron] calibrate.py not found at $CALIBRATE_PY — exiting" >&2
  exit 0
fi

OPS_DATA_DIR="${OPS_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}"
PREFS="${OPS_AUTOPILOT_PREFS:-${OPS_DATA_DIR}/preferences.json}"
LOG_DIR="${OPS_DATA_DIR}/logs"
mkdir -p "$LOG_DIR"
LOG="${LOG_DIR}/creative-calibrate.log"

log() { printf '%s [calibrate-cron] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" | tee -a "$LOG" >&2; }

if [ ! -f "$PREFS" ]; then
  log "no preferences.json at $PREFS — nothing to do"
  exit 0
fi

# Collect projects with autopilot.enabled=true AND weekly_synthesis=true
mapfile -t PROJECTS < <(jq -r '
  .marketing.projects // {} | to_entries[]
  | select(.value.autopilot.enabled == true)
  | select(.value.autopilot.weekly_synthesis == true)
  | .key
' "$PREFS" 2>/dev/null || true)

if [ "${#PROJECTS[@]}" -eq 0 ]; then
  log "no projects with autopilot.enabled + weekly_synthesis — nothing to calibrate"
  exit 0
fi

log "calibrating ${#PROJECTS[@]} project(s): ${PROJECTS[*]}"

for proj in "${PROJECTS[@]}"; do
  [ -z "$proj" ] && continue
  log "running calibrate for project=$proj"
  set +e
  python3 "$CALIBRATE_PY" --project "$proj" --data-dir "$OPS_DATA_DIR" 2>>"$LOG"
  rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    log "WARN: calibrate failed for project=$proj (rc=$rc) — continuing"
  else
    log "done: project=$proj"
  fi
done

log "calibration pass complete"
exit 0
