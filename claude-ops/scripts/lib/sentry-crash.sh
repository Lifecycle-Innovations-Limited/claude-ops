#!/usr/bin/env bash
# scripts/lib/sentry-crash.sh — Sentry crash-free rate correlation
#
# Source-able library. Exports:
#   sentry_crash_rate <project>         — per-project crash-free rate JSON
#   sentry_crash_all_projects           — iterate all PREFS projects
#
# Requires: scripts/lib/ga4-resolve.sh (for resolve_cred)
# set -u only — no set -e in libs

[ -n "${_SENTRY_CRASH_LOADED:-}" ] && return 0
_SENTRY_CRASH_LOADED=1

set -u

# ---------------------------------------------------------------------------
# _sentry_token — resolve auth token from env or Doppler
# ---------------------------------------------------------------------------
_sentry_token() {
  local tok="${SENTRY_AUTH_TOKEN:-}"
  if [ -n "$tok" ]; then
    printf '%s' "$tok"
    return 0
  fi
  # Fallback: Doppler claude-ops/prd/SENTRY_AUTH_TOKEN
  doppler secrets get SENTRY_AUTH_TOKEN \
    --project claude-ops --config prd --plain 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# _sentry_api <path> — authenticated GET against sentry.io API
# ---------------------------------------------------------------------------
_sentry_api() {
  local path="${1:-}"
  local tok
  tok="$(_sentry_token)"
  [ -z "$tok" ] && return 0
  curl -sS --max-time 10 \
    -H "Authorization: Bearer ${tok}" \
    "https://sentry.io/api/0${path}" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# sentry_crash_rate <project>
# Heuristically maps project name to Sentry project slugs, computes crash-free.
# Echoes JSON or "null" on no match / error. Always returns 0.
# ---------------------------------------------------------------------------
sentry_crash_rate() {
  local project="${1:-}"
  local org="${SENTRY_ORG:-healify}"

  if [ -z "$project" ]; then
    echo "null"
    return 0
  fi

  # List all Sentry projects in the org
  local projects_json
  projects_json="$(_sentry_api "/organizations/${org}/projects/")"

  if [ -z "$projects_json" ] || ! echo "$projects_json" | jq -e 'type == "array"' >/dev/null 2>&1; then
    echo "null"
    return 0
  fi

  # Filter slugs matching the project name (substring, case-insensitive)
  local matched_slugs
  matched_slugs="$(echo "$projects_json" | jq -r \
    --arg stem "$project" \
    '[.[] | select(.slug | ascii_downcase | contains($stem | ascii_downcase)) | .slug] | .[]' \
    2>/dev/null || true)"

  if [ -z "$matched_slugs" ]; then
    echo "null"
    return 0
  fi

  local slugs_array
  slugs_array="$(echo "$matched_slugs" | jq -R . | jq -s . 2>/dev/null)"

  # Aggregate crash-free rates across all matching slugs
  local total_sessions_7d=0
  local total_crashes_7d=0
  local total_sessions_24h=0
  local total_crashes_24h=0
  local today_sessions=0
  local today_crashes=0
  local yesterday_sessions=0
  local yesterday_crashes=0

  while IFS= read -r slug; do
    [ -z "$slug" ] && continue

    # 7-day sessions
    local resp_7d
    resp_7d="$(_sentry_api "/projects/${org}/${slug}/stats_v2/?stat=sum%28session%29&category=session&statsPeriod=7d&interval=1d")"

    # 7-day errors (crashes = sessions with crashed status)
    local resp_crash_7d
    resp_crash_7d="$(_sentry_api "/projects/${org}/${slug}/stats_v2/?stat=sum%28session%29&category=session&statsPeriod=7d&interval=1d&query=session.status%3Acreashed")"

    # 24h sessions
    local resp_24h
    resp_24h="$(_sentry_api "/projects/${org}/${slug}/stats_v2/?stat=sum%28session%29&category=session&statsPeriod=24h&interval=1h")"

    local resp_crash_24h
    resp_crash_24h="$(_sentry_api "/projects/${org}/${slug}/stats_v2/?stat=sum%28session%29&category=session&statsPeriod=24h&interval=1h&query=session.status%3Acrashed")"

    # Sum totals from groups[0].totals."sum(session)"
    local s7d c7d s24h c24h
    s7d="$(echo "$resp_7d" | jq -r '.groups[0].totals["sum(session)"] // 0' 2>/dev/null || echo 0)"
    c7d="$(echo "$resp_crash_7d" | jq -r '.groups[0].totals["sum(session)"] // 0' 2>/dev/null || echo 0)"
    s24h="$(echo "$resp_24h" | jq -r '.groups[0].totals["sum(session)"] // 0' 2>/dev/null || echo 0)"
    c24h="$(echo "$resp_crash_24h" | jq -r '.groups[0].totals["sum(session)"] // 0' 2>/dev/null || echo 0)"

    # For DoD: split 7d intervals into today (last) and yesterday (second to last)
    # intervals are oldest-first; last = today, second-to-last = yesterday
    local today_s yesterday_s today_c yesterday_c
    today_s="$(echo "$resp_7d" | jq -r 'if (.groups[0].series["sum(session)"] | length) > 0 then .groups[0].series["sum(session)"][-1] else 0 end' 2>/dev/null || echo 0)"
    yesterday_s="$(echo "$resp_7d" | jq -r 'if (.groups[0].series["sum(session)"] | length) > 1 then .groups[0].series["sum(session)"][-2] else 0 end' 2>/dev/null || echo 0)"
    today_c="$(echo "$resp_crash_7d" | jq -r 'if (.groups[0].series["sum(session)"] | length) > 0 then .groups[0].series["sum(session)"][-1] else 0 end' 2>/dev/null || echo 0)"
    yesterday_c="$(echo "$resp_crash_7d" | jq -r 'if (.groups[0].series["sum(session)"] | length) > 1 then .groups[0].series["sum(session)"][-2] else 0 end' 2>/dev/null || echo 0)"

    total_sessions_7d="$(awk "BEGIN {print $total_sessions_7d + $s7d}")"
    total_crashes_7d="$(awk "BEGIN {print $total_crashes_7d + $c7d}")"
    total_sessions_24h="$(awk "BEGIN {print $total_sessions_24h + $s24h}")"
    total_crashes_24h="$(awk "BEGIN {print $total_crashes_24h + $c24h}")"
    today_sessions="$(awk "BEGIN {print $today_sessions + $today_s}")"
    today_crashes="$(awk "BEGIN {print $today_crashes + $today_c}")"
    yesterday_sessions="$(awk "BEGIN {print $yesterday_sessions + $yesterday_s}")"
    yesterday_crashes="$(awk "BEGIN {print $yesterday_crashes + $yesterday_c}")"

  done <<< "$matched_slugs"

  # Compute rates
  local cf_7d cf_24h cf_today cf_yesterday delta_dod at_risk ad_risk_msg
  cf_7d="$(awk "BEGIN {s=$total_sessions_7d+0; c=$total_crashes_7d+0; if(s>0) printf \"%.4f\", (s-c)/s; else printf \"1.0\"}")"
  cf_24h="$(awk "BEGIN {s=$total_sessions_24h+0; c=$total_crashes_24h+0; if(s>0) printf \"%.4f\", (s-c)/s; else printf \"1.0\"}")"
  cf_today="$(awk "BEGIN {s=$today_sessions+0; c=$today_crashes+0; if(s>0) printf \"%.4f\", (s-c)/s; else printf \"1.0\"}")"
  cf_yesterday="$(awk "BEGIN {s=$yesterday_sessions+0; c=$yesterday_crashes+0; if(s>0) printf \"%.4f\", (s-c)/s; else printf \"1.0\"}")"
  delta_dod="$(awk "BEGIN {printf \"%.4f\", $cf_today - $cf_yesterday}")"

  at_risk="false"
  ad_risk_msg=""
  local delta_check
  delta_check="$(awk "BEGIN {print ($delta_dod < -0.05) ? \"yes\" : \"no\"}")"
  if [ "$delta_check" = "yes" ]; then
    at_risk="true"
    local pct
    pct="$(awk "BEGIN {printf \"%.2f\", -$delta_dod * 100}")"
    ad_risk_msg="AD SPEND AT RISK — crash-free rate dropped ${pct}pp DoD"
  fi

  jq -n \
    --arg surface "sentry" \
    --arg proj "$project" \
    --argjson slugs "$slugs_array" \
    --argjson cf7 "$cf_7d" \
    --argjson cf24 "$cf_24h" \
    --argjson dod "$delta_dod" \
    --argjson risk "$at_risk" \
    --arg msg "$ad_risk_msg" \
    '{
      surface: $surface,
      project: $proj,
      sentry_projects: $slugs,
      crash_free_7d: $cf7,
      crash_free_24h: $cf24,
      delta_dod: $dod,
      at_risk: $risk,
      ad_spend_risk: (if $msg != "" then $msg else null end)
    }'

  return 0
}

# ---------------------------------------------------------------------------
# sentry_crash_all_projects
# Iterates PREFS marketing projects and calls sentry_crash_rate for each.
# Echoes a JSON array. Always returns 0.
# ---------------------------------------------------------------------------
sentry_crash_all_projects() {
  local prefs="${OPS_DATA_DIR:-}/preferences.json"
  local results="[]"

  if [ ! -f "$prefs" ]; then
    echo "[]"
    return 0
  fi

  local projects
  projects="$(jq -r '.marketing.projects | keys[]' "$prefs" 2>/dev/null || true)"

  if [ -z "$projects" ]; then
    echo "[]"
    return 0
  fi

  while IFS= read -r proj; do
    [ -z "$proj" ] && continue
    local entry
    entry="$(sentry_crash_rate "$proj")"
    if [ -n "$entry" ] && [ "$entry" != "null" ]; then
      results="$(echo "$results" | jq --argjson e "$entry" '. + [$e]' 2>/dev/null || echo "$results")"
    fi
  done <<< "$projects"

  echo "$results"
  return 0
}
