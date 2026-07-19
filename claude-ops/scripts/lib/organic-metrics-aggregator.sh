#!/usr/bin/env bash
# scripts/lib/organic-metrics-aggregator.sh — normalized organic + merchant pulls across free surfaces
#
# Public functions:
#   organic_meta <project>          — Facebook Page + Instagram Business via Graph API (fans, followers, IG reach 7d)
#   organic_youtube <project>       — YouTube Analytics API v2 (views, watch time, net subscribers, last 7d)
#   organic_searchconsole <project> — Search Console searchAnalytics/query (clicks, impressions, 7d)
#   merchant_status <project>       — Google Merchant Content API v2.1 accountstatuses (approved/disapproved counts)
#   organic_tiktok <project>        — stub (configured_but_not_implemented or null)
#   organic_all <project>           — fan out + aggregate to {"project","window_days","surfaces":[...]}
#
# Sourcing convention:
#   PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
#   . "${PLUGIN_ROOT}/lib/registry-path.sh"
#   . "${PLUGIN_ROOT}/scripts/lib/organic-metrics-aggregator.sh"
#
# Contract (same as ad-spend-aggregator.sh):
#   - All HTTP via `curl -sS --max-time 12 ...`, errors swallowed.
#   - Every function returns 0 (errexit-safe — libs may be sourced by callers).
#   - Missing cred -> echo `null`. Configured-but-stub -> echo {"status":"configured_but_not_implemented"}.
#   - Successful pull -> echo a JSON object with at least: surface, project, window_days.
#   - PUBLIC REPO: no hardcoded project names / tokens / account IDs.
#
# These surfaces are all free direct APIs — they exist as a fallback/alternative
# when a paid aggregator (e.g. Windsor.ai) is not connected or returns dead zeros.
#
# Requires: bash, jq, curl.

[ -n "${_ORGANIC_METRICS_AGGREGATOR_LOADED:-}" ] && return 0
_ORGANIC_METRICS_AGGREGATOR_LOADED=1

set -u

# Source resolve_cred + _prefs_marketing helpers from ga4-resolve.sh.
_ORGANIC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "${_ORGANIC_DIR}/ga4-resolve.sh"

# Source google-ads-oauth.sh if present (provides gads_refresh_access_token —
# the Google OAuth token endpoint is identical for YouTube / Merchant scopes).
if [ -f "${_ORGANIC_DIR}/google-ads-oauth.sh" ]; then
  # shellcheck disable=SC1091
  . "${_ORGANIC_DIR}/google-ads-oauth.sh"
fi

# ── PREFS resolution ──────────────────────────────────────────────────────────
_organic_prefs_path() {
  printf '%s' "${OPS_AUTOPILOT_PREFS:-${OPS_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/preferences.json}"
}

# ── Inline Google OAuth refresh fallback ──────────────────────────────────────
# Used only when google-ads-oauth.sh is not present in scripts/lib/.
# Arg order matches google-ads-oauth.sh: <refresh_token> <client_id> <client_secret>.
if ! declare -f gads_refresh_access_token >/dev/null 2>&1; then
  gads_refresh_access_token() {
    local refresh_token="${1:-}" client_id="${2:-}" client_secret="${3:-}"
    if [ -z "$refresh_token" ] || [ -z "$client_id" ] || [ -z "$client_secret" ]; then
      return 0
    fi
    local resp
    resp="$(curl -sS --max-time 12 -X POST https://oauth2.googleapis.com/token \
      --data-urlencode "client_id=${client_id}" \
      --data-urlencode "client_secret=${client_secret}" \
      --data-urlencode "refresh_token=${refresh_token}" \
      --data-urlencode "grant_type=refresh_token" 2>/dev/null || echo '{}')"
    printf '%s' "$resp" | jq -r '.access_token // empty' 2>/dev/null || true
  }
fi

# ── Date helpers (portable BSD/GNU) ───────────────────────────────────────────
_organic_date_days_ago() {
  local days="${1:-7}"
  date -v-"${days}"d +%F 2>/dev/null \
    || date --date="${days} days ago" +%F 2>/dev/null \
    || date +%F
}

# ── Google OAuth access token for a prefs channel ─────────────────────────────
# $1=project $2=channel — reads refresh_token/client_id/client_secret from that
# channel and mints an access token. Empty output when not configured.
_organic_google_token() {
  local proj="${1:-}" channel="${2:-}"
  local refresh_token client_id client_secret
  refresh_token="$(resolve_cred "$(_prefs_marketing "$proj" "$channel" "refresh_token")")"
  client_id="$(resolve_cred "$(_prefs_marketing "$proj" "$channel" "client_id")")"
  client_secret="$(resolve_cred "$(_prefs_marketing "$proj" "$channel" "client_secret")")"
  if [ -z "$refresh_token" ] || [ -z "$client_id" ] || [ -z "$client_secret" ]; then
    return 0
  fi
  gads_refresh_access_token "$refresh_token" "$client_id" "$client_secret" 2>/dev/null || true
}

# ── organic_meta ──────────────────────────────────────────────────────────────
# Facebook Page + Instagram Business metrics via Graph API.
# Prefs keys (marketing.projects.<p>.meta.*): access_token (or env
# META_ACCESS_TOKEN / FACEBOOK_ACCESS_TOKEN), page_id, instagram_business_id.
organic_meta() {
  local proj="${1:-}"
  if [ -z "$proj" ]; then printf 'null'; return 0; fi

  local prefs; prefs="$(_organic_prefs_path)"
  [ -f "$prefs" ] || { printf 'null'; return 0; }

  local tok page_id ig_id
  tok="$(resolve_cred "$(_prefs_marketing "$proj" "meta" "access_token")")"
  [ -z "$tok" ] && tok="${META_ACCESS_TOKEN:-${FACEBOOK_ACCESS_TOKEN:-}}"
  page_id="$(resolve_cred "$(_prefs_marketing "$proj" "meta" "page_id")")"
  ig_id="$(resolve_cred "$(_prefs_marketing "$proj" "meta" "instagram_business_id")")"

  if [ -z "$tok" ] || { [ -z "$page_id" ] && [ -z "$ig_id" ]; }; then
    printf 'null'
    return 0
  fi

  local page_fans="null" page_followers="null"
  if [ -n "$page_id" ]; then
    local page_resp
    page_resp="$(curl -gsS --max-time 12 \
      "https://graph.facebook.com/v18.0/${page_id}?fields=fan_count,followers_count&access_token=${tok}" \
      2>/dev/null || echo '{}')"
    if [ -z "$(printf '%s' "$page_resp" | jq -r '.error.code // empty' 2>/dev/null)" ]; then
      page_fans="$(printf '%s' "$page_resp" | jq '.fan_count // null' 2>/dev/null || echo null)"
      page_followers="$(printf '%s' "$page_resp" | jq '.followers_count // null' 2>/dev/null || echo null)"
    fi
  fi

  local ig_followers="null" ig_media="null" ig_reach="null"
  if [ -n "$ig_id" ]; then
    local ig_resp
    ig_resp="$(curl -gsS --max-time 12 \
      "https://graph.facebook.com/v18.0/${ig_id}?fields=followers_count,media_count&access_token=${tok}" \
      2>/dev/null || echo '{}')"
    if [ -z "$(printf '%s' "$ig_resp" | jq -r '.error.code // empty' 2>/dev/null)" ]; then
      ig_followers="$(printf '%s' "$ig_resp" | jq '.followers_count // null' 2>/dev/null || echo null)"
      ig_media="$(printf '%s' "$ig_resp" | jq '.media_count // null' 2>/dev/null || echo null)"
    fi
    local reach_resp
    reach_resp="$(curl -gsS --max-time 12 \
      "https://graph.facebook.com/v18.0/${ig_id}/insights?metric=reach&period=day&access_token=${tok}" \
      2>/dev/null || echo '{}')"
    ig_reach="$(printf '%s' "$reach_resp" \
      | jq '[.data[]? | select(.name == "reach") | .values[]?.value // 0] | if length == 0 then null else add end' \
      2>/dev/null || echo null)"
    [ -z "$ig_reach" ] && ig_reach="null"
  fi

  jq -nc \
    --arg p "$proj" \
    --argjson pf "${page_fans:-null}" \
    --argjson pfl "${page_followers:-null}" \
    --argjson igf "${ig_followers:-null}" \
    --argjson igm "${ig_media:-null}" \
    --argjson igr "${ig_reach:-null}" '
    {
      surface: "meta_organic",
      project: $p,
      page_fans: $pf,
      page_followers: $pfl,
      ig_followers: $igf,
      ig_media_count: $igm,
      ig_reach_7d: $igr,
      window_days: 7
    }
  ' 2>/dev/null || printf 'null'
}

# ── organic_youtube ───────────────────────────────────────────────────────────
# YouTube Analytics API v2, last 7 days. Requires an OAuth refresh token minted
# with scope https://www.googleapis.com/auth/yt-analytics.readonly (plus
# youtube.readonly for the subscriber count).
# Prefs keys (marketing.projects.<p>.youtube.*): refresh_token, client_id,
# client_secret, channel_id (optional — defaults to the authorized channel).
organic_youtube() {
  local proj="${1:-}"
  if [ -z "$proj" ]; then printf 'null'; return 0; fi

  local prefs; prefs="$(_organic_prefs_path)"
  [ -f "$prefs" ] || { printf 'null'; return 0; }

  local access_token
  access_token="$(_organic_google_token "$proj" "youtube")"
  if [ -z "$access_token" ]; then
    printf 'null'
    return 0
  fi

  local channel_id ids="channel%3D%3DMINE"
  channel_id="$(resolve_cred "$(_prefs_marketing "$proj" "youtube" "channel_id")")"
  [ -n "$channel_id" ] && ids="channel%3D%3D${channel_id}"

  local start_date end_date
  end_date="$(date +%F)"
  start_date="$(_organic_date_days_ago 7)"

  local resp
  resp="$(curl -gsS --max-time 12 \
    "https://youtubeanalytics.googleapis.com/v2/reports?ids=${ids}&startDate=${start_date}&endDate=${end_date}&metrics=views,estimatedMinutesWatched,subscribersGained,subscribersLost" \
    -H "Authorization: Bearer ${access_token}" 2>/dev/null || echo '{}')"

  if [ -n "$(printf '%s' "$resp" | jq -r '.error.code // empty' 2>/dev/null)" ]; then
    printf 'null'
    return 0
  fi

  local views minutes subs_gained subs_lost
  views="$(printf '%s' "$resp" | jq '[.rows[]?[0] // 0] | add // 0' 2>/dev/null || echo 0)"
  minutes="$(printf '%s' "$resp" | jq '[.rows[]?[1] // 0] | add // 0' 2>/dev/null || echo 0)"
  subs_gained="$(printf '%s' "$resp" | jq '[.rows[]?[2] // 0] | add // 0' 2>/dev/null || echo 0)"
  subs_lost="$(printf '%s' "$resp" | jq '[.rows[]?[3] // 0] | add // 0' 2>/dev/null || echo 0)"

  # Total subscriber count via Data API v3 (best effort — null if scope missing).
  local subs_total="null" chan_param="mine=true"
  [ -n "$channel_id" ] && chan_param="id=${channel_id}"
  local chan_resp
  chan_resp="$(curl -gsS --max-time 12 \
    "https://www.googleapis.com/youtube/v3/channels?part=statistics&${chan_param}" \
    -H "Authorization: Bearer ${access_token}" 2>/dev/null || echo '{}')"
  subs_total="$(printf '%s' "$chan_resp" \
    | jq '.items[0].statistics.subscriberCount // null | if . == null then null else tonumber end' \
    2>/dev/null || echo null)"
  [ -z "$subs_total" ] && subs_total="null"

  jq -nc \
    --arg p "$proj" \
    --argjson v "${views:-0}" \
    --argjson m "${minutes:-0}" \
    --argjson sg "${subs_gained:-0}" \
    --argjson sl "${subs_lost:-0}" \
    --argjson st "${subs_total:-null}" '
    {
      surface: "youtube",
      project: $p,
      views: $v,
      watch_minutes: $m,
      subscribers_gained: $sg,
      subscribers_lost: $sl,
      subscribers_net: ($sg - $sl),
      subscribers_total: $st,
      window_days: 7
    }
  ' 2>/dev/null || printf 'null'
}

# ── organic_searchconsole ─────────────────────────────────────────────────────
# Search Console searchAnalytics/query totals, last 7 days. Site URL comes from
# prefs (marketing.projects.<p>.gsc.site_url — same key gsc_resolve uses).
# Auth mirrors scripts/ops-cron-seo-blog-gen.sh: gcloud ADC first, then
# $GOOGLE_ACCESS_TOKEN.
organic_searchconsole() {
  local proj="${1:-}"
  if [ -z "$proj" ]; then printf 'null'; return 0; fi

  local prefs; prefs="$(_organic_prefs_path)"
  [ -f "$prefs" ] || { printf 'null'; return 0; }

  local site_url
  site_url="$(resolve_cred "$(_prefs_marketing "$proj" "gsc" "site_url")")"
  if [ -z "$site_url" ]; then
    printf 'null'
    return 0
  fi

  local access_token
  access_token="$(gcloud auth application-default print-access-token 2>/dev/null || true)"
  [ -z "$access_token" ] && access_token="${GOOGLE_ACCESS_TOKEN:-}"
  if [ -z "$access_token" ]; then
    printf 'null'
    return 0
  fi

  local site_enc
  site_enc="$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$site_url" 2>/dev/null \
    || printf '%s' "$site_url" | sed 's|:|%3A|g; s|/|%2F|g')"

  local start_date end_date
  end_date="$(date +%F)"
  start_date="$(_organic_date_days_ago 7)"

  local payload
  payload="$(jq -n --arg start "$start_date" --arg end "$end_date" \
    '{startDate: $start, endDate: $end, rowLimit: 1}')"

  local resp
  resp="$(curl -gsS --max-time 12 -X POST \
    "https://searchconsole.googleapis.com/webmasters/v3/sites/${site_enc}/searchAnalytics/query" \
    -H "Authorization: Bearer ${access_token}" \
    -H "Content-Type: application/json" \
    -d "$payload" 2>/dev/null || echo '{}')"

  if [ -n "$(printf '%s' "$resp" | jq -r '.error.code // empty' 2>/dev/null)" ]; then
    printf 'null'
    return 0
  fi

  printf '%s' "$resp" | jq -c --arg p "$proj" '
    (.rows[0] // {}) as $r |
    {
      surface: "search_console",
      project: $p,
      clicks: ($r.clicks // 0),
      impressions: ($r.impressions // 0),
      ctr: ((($r.ctr // 0) * 10000 | round) / 100),
      avg_position: ((($r.position // 0) * 100 | round) / 100),
      window_days: 7
    }
  ' 2>/dev/null || printf 'null'
}

# ── merchant_status ───────────────────────────────────────────────────────────
# Google Merchant Content API v2.1 accountstatuses — product approval counts.
# Prefs keys (marketing.projects.<p>.merchant_center.*): merchant_id, plus
# either OAuth refresh creds (refresh_token/client_id/client_secret with scope
# https://www.googleapis.com/auth/content) or gcloud ADC / $GOOGLE_ACCESS_TOKEN.
merchant_status() {
  local proj="${1:-}"
  if [ -z "$proj" ]; then printf 'null'; return 0; fi

  local prefs; prefs="$(_organic_prefs_path)"
  [ -f "$prefs" ] || { printf 'null'; return 0; }

  local merchant_id
  merchant_id="$(resolve_cred "$(_prefs_marketing "$proj" "merchant_center" "merchant_id")")"
  if [ -z "$merchant_id" ]; then
    printf 'null'
    return 0
  fi

  local access_token
  access_token="$(_organic_google_token "$proj" "merchant_center")"
  [ -z "$access_token" ] && access_token="$(gcloud auth application-default print-access-token 2>/dev/null || true)"
  [ -z "$access_token" ] && access_token="${GOOGLE_ACCESS_TOKEN:-}"
  if [ -z "$access_token" ]; then
    printf 'null'
    return 0
  fi

  local resp
  resp="$(curl -gsS --max-time 12 \
    "https://shoppingcontent.googleapis.com/content/v2.1/${merchant_id}/accountstatuses/${merchant_id}" \
    -H "Authorization: Bearer ${access_token}" 2>/dev/null || echo '{}')"

  if [ -n "$(printf '%s' "$resp" | jq -r '.error.code // empty' 2>/dev/null)" ]; then
    printf 'null'
    return 0
  fi

  printf '%s' "$resp" | jq -c --arg p "$proj" '
    ([.products[]?.statistics] | map({
      active: ((.active // 0) | tonumber),
      pending: ((.pending // 0) | tonumber),
      disapproved: ((.disapproved // 0) | tonumber),
      expiring: ((.expiring // 0) | tonumber)
    })) as $stats |
    {
      surface: "merchant_center",
      project: $p,
      approved: ([$stats[].active] | add // 0),
      pending: ([$stats[].pending] | add // 0),
      disapproved: ([$stats[].disapproved] | add // 0),
      expiring: ([$stats[].expiring] | add // 0),
      item_issues: ([.products[]?.itemLevelIssues[]?] | length)
    }
  ' 2>/dev/null || printf 'null'
}

# ── Stub: tiktok organic ──────────────────────────────────────────────────────
# TikTok organic metrics need an approved TikTok developer app — emit the
# configured_but_not_implemented sentinel when creds are declared.
_organic_stub_surface() {
  local surface="$1" proj="$2" field="$3"
  if [ -z "$proj" ]; then printf 'null'; return 0; fi
  local prefs; prefs="$(_organic_prefs_path)"
  [ -f "$prefs" ] || { printf 'null'; return 0; }

  local ref
  ref="$(_prefs_marketing "$proj" "$surface" "$field")"
  if [ -z "$ref" ] || [ "$ref" = "null" ]; then
    printf 'null'
    return 0
  fi
  jq -nc --arg s "$surface" --arg p "$proj" \
    '{surface:$s, project:$p, status:"configured_but_not_implemented"}' 2>/dev/null \
    || printf 'null'
}

organic_tiktok() { _organic_stub_surface "tiktok_organic" "${1:-}" "access_token"; }

# ── organic_all ───────────────────────────────────────────────────────────────
organic_all() {
  local proj="${1:-}"
  if [ -z "$proj" ]; then
    jq -nc '{project:"", window_days:7, surfaces:[]}'
    return 0
  fi

  local results=()
  local out
  for fn in organic_meta organic_youtube organic_searchconsole merchant_status organic_tiktok; do
    out="$("$fn" "$proj" 2>/dev/null || printf 'null')"
    [ -z "$out" ] && out="null"
    if [ "$out" != "null" ]; then
      results+=("$out")
    fi
  done

  local surfaces_json="[]"
  if [ ${#results[@]} -gt 0 ]; then
    surfaces_json="$(printf '%s\n' "${results[@]}" | jq -s '.' 2>/dev/null || echo '[]')"
  fi

  jq -nc \
    --arg p "$proj" \
    --argjson surfaces "$surfaces_json" '
    {
      project: $p,
      window_days: 7,
      surfaces: $surfaces
    }
  ' 2>/dev/null || jq -nc --arg p "$proj" '{project:$p, window_days:7, surfaces:[]}'
}
