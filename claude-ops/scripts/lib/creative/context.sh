#!/usr/bin/env bash
# creative/context.sh — Single source of truth for creative-autopilot consumers.
#
# Mirror of scripts/lib/competitor/context.sh structure.
# Source this lib then call:
#   creative_context [--project P] [--window-days N]
#
# Returns ONE JSON object:
#   {
#     "configured": true,
#     "projects": ["your-app", ...],
#     "by_project": {
#       "your-app": {
#         "ledger_rows": 12,
#         "last_gen": "2026-05-17T...",
#         "last_calibrated": "2026-05-17T...",
#         "calibrator_present": true,
#         "best": {"asset_path":"...","tier2":{"prior":88},"ts":"..."},
#         "worst": {"asset_path":"...","tier2":{"prior":32},"ts":"..."}
#       }
#     },
#     "window_days": 7
#   }
#
# When no autopilot_state dir:
#   {"configured":false,"reason":"no_state"}
#
# Cheap (jq-only, no network).
#
# Don't `set -e` — consumers source this; let them control failure semantics.

OPS_DATA_DIR="${OPS_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}"
_CREATIVE_STATE_BASE="${OPS_DATA_DIR}/autopilot_state"

# ── creative_context — main entrypoint ───────────────────────────────────────
creative_context() {
  local project_filter=""
  local window_days=7

  while [ $# -gt 0 ]; do
    case "$1" in
      --project)     project_filter="$2"; shift 2 ;;
      --window-days) window_days="$2";    shift 2 ;;
      *)             shift ;;
    esac
  done

  # Not configured: no state base dir
  if [ ! -d "$_CREATIVE_STATE_BASE" ]; then
    printf '{"configured":false,"reason":"no_state"}'
    return 0
  fi

  # Discover projects from subdirectory names
  local projects_list="[]"
  local by_project="{}"

  # Find immediate subdirs that have at least a creatives.jsonl
  local project_dirs=()
  while IFS= read -r d; do
    [ -d "$d" ] || continue
    local pname; pname="$(basename "$d")"
    [ -n "$project_filter" ] && [ "$pname" != "$project_filter" ] && continue
    project_dirs+=("$pname")
  done < <(find "$_CREATIVE_STATE_BASE" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | sort)

  if [ "${#project_dirs[@]}" -eq 0 ]; then
    printf '{"configured":false,"reason":"no_state"}'
    return 0
  fi

  # Compute window cutoff epoch
  local cutoff
  cutoff=$(date -u -v "-${window_days}d" +%s 2>/dev/null \
        || date -u -d "${window_days} days ago" +%s 2>/dev/null \
        || echo 0)

  local projects_json_arr="["
  local first_proj=1

  for pname in "${project_dirs[@]}"; do
    local pdir="$_CREATIVE_STATE_BASE/$pname"
    local creatives_file="$pdir/creatives.jsonl"
    local calibrator_file="$pdir/calibrator.json"

    [ "$first_proj" = "0" ] && projects_json_arr="${projects_json_arr},"
    projects_json_arr="${projects_json_arr}\"${pname}\""
    first_proj=0

    # Count ledger rows (all time)
    local ledger_rows=0
    [ -f "$creatives_file" ] && ledger_rows="$(wc -l < "$creatives_file" 2>/dev/null | tr -d ' ' || echo 0)"

    # Last gen timestamp (most recent ts in creatives.jsonl)
    local last_gen="null"
    if [ -f "$creatives_file" ] && [ "$ledger_rows" -gt 0 ]; then
      last_gen="$(jq -r '.ts // empty' "$creatives_file" 2>/dev/null | sort | tail -1 | jq -R . 2>/dev/null || echo 'null')"
      [ -z "$last_gen" ] && last_gen="null"
    fi

    # Calibrator present + last calibrated
    local calibrator_present=false last_calibrated="null"
    if [ -f "$calibrator_file" ]; then
      calibrator_present=true
      last_calibrated="$(jq -r '.fitted_at // empty' "$calibrator_file" 2>/dev/null | jq -R . 2>/dev/null || echo 'null')"
      [ -z "$last_calibrated" ] && last_calibrated="null"
    fi

    # Best and worst creative (by tier2.prior, within window)
    local best_json="null" worst_json="null"
    if [ -f "$creatives_file" ] && [ "$ledger_rows" -gt 0 ]; then
      # Filter to window and find best/worst by prior
      local windowed
      windowed="$(jq -c --argjson cutoff "$cutoff" '
        select(.ts != null) |
        select(
          (.ts | try fromdateiso8601 catch 0) >= $cutoff
        )
      ' "$creatives_file" 2>/dev/null | jq -s '.' 2>/dev/null || echo '[]')"

      best_json="$(printf '%s' "$windowed" | jq -c '
        map(select(.tier2.prior != null)) | sort_by(.tier2.prior) | last // null
      ' 2>/dev/null || echo 'null')"
      [ -z "$best_json" ] && best_json="null"

      worst_json="$(printf '%s' "$windowed" | jq -c '
        map(select(.tier2.prior != null)) | sort_by(.tier2.prior) | first // null
      ' 2>/dev/null || echo 'null')"
      [ -z "$worst_json" ] && worst_json="null"
    fi

    # Build project entry
    local proj_entry
    proj_entry="$(jq -n \
      --argjson rows "$ledger_rows" \
      --argjson last_gen "$last_gen" \
      --argjson last_calibrated "$last_calibrated" \
      --argjson calibrator_present "$calibrator_present" \
      --argjson best "$best_json" \
      --argjson worst "$worst_json" \
      '{
        ledger_rows: $rows,
        last_gen: $last_gen,
        last_calibrated: $last_calibrated,
        calibrator_present: $calibrator_present,
        best: $best,
        worst: $worst
      }' 2>/dev/null || echo '{}')"

    by_project="$(printf '%s' "$by_project" | jq --arg p "$pname" --argjson e "$proj_entry" '. + {($p): $e}' 2>/dev/null || echo '{}')"
  done

  projects_json_arr="${projects_json_arr}]"

  jq -n \
    --argjson projects "$projects_json_arr" \
    --argjson by_project "$by_project" \
    --argjson window "$window_days" \
    '{
      configured: true,
      projects: $projects,
      by_project: $by_project,
      window_days: $window
    }' 2>/dev/null \
  || printf '{"configured":false,"reason":"json_assembly_error"}'
}

# ── creative_briefing_line — compact /ops:go summary ─────────────────────────
creative_briefing_line() {
  local ctx; ctx="$(creative_context "$@")"
  if [ "$(printf '%s' "$ctx" | jq -r '.configured' 2>/dev/null)" != "true" ]; then
    printf '%s' "(creative autopilot not configured)"
    return 0
  fi
  printf '%s' "$ctx" | jq -r '
    (.projects | length) as $n |
    (.by_project | to_entries | map(.value.ledger_rows) | add // 0) as $total |
    (.by_project | to_entries | map(select(.value.calibrator_present)) | length) as $cal |
    ($n | tostring) + " project(s) · " +
    ($total | tostring) + " creatives · " +
    ($cal | tostring) + " calibrated · last gen " +
    (.by_project | to_entries | map(.value.last_gen) | map(select(. != null)) | sort | last // "never")
  ' 2>/dev/null || printf '(creative autopilot: state read error)'
}

# ── creative_priority_items — terse bullets for /ops:marketing ───────────────
creative_priority_items() {
  local n=5
  while [ $# -gt 0 ]; do
    case "$1" in
      --top) n="$2"; shift 2 ;;
      *)     shift ;;
    esac
  done

  local ctx; ctx="$(creative_context)"
  if [ "$(printf '%s' "$ctx" | jq -r '.configured' 2>/dev/null)" != "true" ]; then
    return 0
  fi

  printf '%s' "$ctx" | jq -r --argjson n "$n" '
    .by_project | to_entries | .[0:$n] | .[] |
    "- " + .key + ": " +
    (.value.ledger_rows | tostring) + " creatives" +
    (if .value.calibrator_present then " · calibrated" else " · NOT calibrated" end) +
    (if .value.best != null then
      " · best prior=" + (.value.best.tier2.prior // "?" | tostring)
    else "" end)
  ' 2>/dev/null || true
}
