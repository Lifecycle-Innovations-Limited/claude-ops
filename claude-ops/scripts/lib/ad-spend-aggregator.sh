#!/usr/bin/env bash
# scripts/lib/ad-spend-aggregator.sh — normalized ad-spend pulls across paid surfaces
#
# Public functions:
#   ad_spend_meta <project>        — Meta Marketing API (Graph v18.0) /insights, last_7d
#   ad_spend_google <project>      — Google Ads searchStream, LAST_7_DAYS
#   ad_spend_tiktok <project>      — stub (configured_but_not_implemented or null)
#   ad_spend_linkedin <project>    — stub
#   ad_spend_reddit <project>      — stub
#   ad_spend_microsoft <project>   — stub
#   ad_spend_pinterest <project>   — stub
#   ad_spend_all <project>         — fan out + aggregate to {"project","total_spend_7d","surfaces":[...]}
#
# Sourcing convention:
#   PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
#   . "${PLUGIN_ROOT}/lib/registry-path.sh"
#   . "${PLUGIN_ROOT}/scripts/lib/ad-spend-aggregator.sh"
#
# Contract:
#   - All HTTP via `curl -sS --max-time 12 ...`, errors swallowed.
#   - Every function returns 0 (errexit-safe — libs may be sourced by callers).
#   - Missing cred -> echo `null`. Configured-but-stub -> echo {"status":"configured_but_not_implemented"}.
#   - Successful pull -> echo a JSON object with at least: surface, project, spend, window_days.
#   - PUBLIC REPO: no hardcoded project names / tokens / customer IDs.
#
# Requires: bash, jq, curl, openssl.

[ -n "${_AD_SPEND_AGGREGATOR_LOADED:-}" ] && return 0
_AD_SPEND_AGGREGATOR_LOADED=1

set -u

# Source resolve_cred + _prefs_marketing helpers from ga4-resolve.sh.
_AD_SPEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "${_AD_SPEND_DIR}/ga4-resolve.sh"

# Source google-ads-oauth.sh if present (provides gads_refresh_access_token).
# Falls back to inline implementation when the lib has not been merged yet.
if [ -f "${_AD_SPEND_DIR}/google-ads-oauth.sh" ]; then
  # shellcheck disable=SC1091
  . "${_AD_SPEND_DIR}/google-ads-oauth.sh"
fi

# ── PREFS resolution ──────────────────────────────────────────────────────────
_ad_spend_prefs_path() {
  printf '%s' "${OPS_AUTOPILOT_PREFS:-${OPS_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/preferences.json}"
}

# ── Inline Google Ads OAuth fallback ──────────────────────────────────────────
# Used only when google-ads-oauth.sh is not present in scripts/lib/.
if ! declare -f gads_refresh_access_token >/dev/null 2>&1; then
  gads_refresh_access_token() {
    local client_id="${1:-}" client_secret="${2:-}" refresh_token="${3:-}"
    if [ -z "$client_id" ] || [ -z "$client_secret" ] || [ -z "$refresh_token" ]; then
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

# ── HMAC SHA256 helper (Meta appsecret_proof) ─────────────────────────────────
_ad_spend_hmac_sha256_hex() {
  local key="$1" data="$2"
  printf '%s' "$data" | openssl dgst -sha256 -hmac "$key" 2>/dev/null | awk '{print $NF}'
}

# ── Float-safe arithmetic (jq-based) ──────────────────────────────────────────
_ad_spend_num() {
  # Print 0 for empty/null/non-numeric, else the number as float string.
  local v="${1:-}"
  if [ -z "$v" ] || [ "$v" = "null" ]; then printf '0'; return; fi
  printf '%s' "$v" | jq -R 'tonumber? // 0' 2>/dev/null || printf '0'
}

_ad_spend_div2() {
  # $1 / $2 to 2 decimals, or 0.00 if denom is 0.
  local num denom
  num="$(_ad_spend_num "${1:-0}")"
  denom="$(_ad_spend_num "${2:-0}")"
  if [ "$(printf '%s' "$denom" | jq '. == 0')" = "true" ]; then
    printf '0.00'
    return
  fi
  jq -n --argjson n "$num" --argjson d "$denom" '($n / $d) | . * 100 | round / 100 | tostring' 2>/dev/null \
    | jq -r 'tonumber | . * 100 | round / 100 | tostring' 2>/dev/null \
    || printf '0.00'
}

# ── ad_spend_meta ─────────────────────────────────────────────────────────────
ad_spend_meta() {
  local proj="${1:-}"
  if [ -z "$proj" ]; then printf 'null'; return 0; fi

  local prefs; prefs="$(_ad_spend_prefs_path)"
  [ -f "$prefs" ] || { printf 'null'; return 0; }

  local tok_ref acct_ref sec_ref tok acct sec
  tok_ref="$(_prefs_marketing "$proj" "meta" "access_token")"
  acct_ref="$(_prefs_marketing "$proj" "meta" "ad_account_id")"
  sec_ref="$(_prefs_marketing "$proj" "meta" "app_secret")"

  tok="$(resolve_cred "$tok_ref")"
  acct="$(resolve_cred "$acct_ref")"
  sec="$(resolve_cred "$sec_ref")"

  if [ -z "$tok" ] || [ -z "$acct" ]; then
    printf 'null'
    return 0
  fi

  # Normalize ad_account_id — Meta expects "act_<id>" form.
  case "$acct" in
    act_*) : ;;
    *) acct="act_${acct}" ;;
  esac

  local proof=""
  if [ -n "$sec" ]; then
    proof="$(_ad_spend_hmac_sha256_hex "$sec" "$tok")"
  fi

  local url="https://graph.facebook.com/v18.0/${acct}/insights?fields=spend,impressions,clicks,actions,action_values&date_preset=last_7d&level=account&access_token=${tok}"
  [ -n "$proof" ] && url="${url}&appsecret_proof=${proof}"

  local resp
  resp="$(curl -gsS --max-time 12 "$url" 2>/dev/null || echo '{}')"

  # If error, return null.
  local err_code
  err_code="$(printf '%s' "$resp" | jq -r '.error.code // empty' 2>/dev/null || true)"
  if [ -n "$err_code" ]; then
    printf 'null'
    return 0
  fi

  # Extract first data entry (level=account → 1 row).
  local row
  row="$(printf '%s' "$resp" | jq -c '.data[0] // {}' 2>/dev/null || echo '{}')"
  if [ "$row" = "{}" ] || [ -z "$row" ]; then
    # No spend data — return zeroed object so the caller still sees the surface.
    printf '%s' "$(jq -nc --arg p "$proj" \
      '{surface:"meta", project:$p, spend:"0.00", impressions:"0", clicks:"0", purchases:"0", purchase_value:"0", roas:"0.00", window_days:7}')"
    return 0
  fi

  printf '%s' "$row" | jq -c --arg p "$proj" '
    def numstr(v): (v | tostring) // "0";
    def find_action(arr; t):
      (arr // []) | map(select(.action_type == t)) | (.[0].value // "0") | tostring;
    {
      surface: "meta",
      project: $p,
      spend: numstr(.spend // "0"),
      impressions: numstr(.impressions // "0"),
      clicks: numstr(.clicks // "0"),
      purchases: find_action(.actions; "purchase"),
      purchase_value: find_action(.action_values; "purchase"),
      window_days: 7
    }
    | .roas = (
        if ((.spend | tonumber? // 0) == 0) then "0.00"
        else (((.purchase_value | tonumber? // 0) / (.spend | tonumber? // 1)) * 100 | round / 100 | tostring)
        end
      )
  ' 2>/dev/null || printf 'null'
}

# ── ad_spend_google ───────────────────────────────────────────────────────────
ad_spend_google() {
  local proj="${1:-}"
  if [ -z "$proj" ]; then printf 'null'; return 0; fi

  local prefs; prefs="$(_ad_spend_prefs_path)"
  [ -f "$prefs" ] || { printf 'null'; return 0; }

  local refresh_token client_id client_secret developer_token customer_id login_customer_id
  refresh_token="$(resolve_cred "$(_prefs_marketing "$proj" "google_ads" "refresh_token")")"
  client_id="$(resolve_cred "$(_prefs_marketing "$proj" "google_ads" "client_id")")"
  client_secret="$(resolve_cred "$(_prefs_marketing "$proj" "google_ads" "client_secret")")"
  developer_token="$(resolve_cred "$(_prefs_marketing "$proj" "google_ads" "developer_token")")"
  customer_id="$(resolve_cred "$(_prefs_marketing "$proj" "google_ads" "customer_id")")"
  login_customer_id="$(resolve_cred "$(_prefs_marketing "$proj" "google_ads" "login_customer_id")")"

  if [ -z "$refresh_token" ] || [ -z "$client_id" ] || [ -z "$client_secret" ] \
     || [ -z "$developer_token" ] || [ -z "$customer_id" ]; then
    printf 'null'
    return 0
  fi

  local access_token
  access_token="$(gads_refresh_access_token "$client_id" "$client_secret" "$refresh_token" 2>/dev/null || true)"
  if [ -z "$access_token" ]; then
    printf 'null'
    return 0
  fi

  # Strip dashes from customer_id (Google Ads expects digits only).
  local cid="${customer_id//-/}"
  local login_cid="${login_customer_id//-/}"

  local query='SELECT metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value FROM customer WHERE segments.date DURING LAST_7_DAYS'
  local body
  body="$(jq -n --arg q "$query" '{query: $q}')"

  local hdr_login=()
  if [ -n "$login_cid" ]; then
    hdr_login=(-H "login-customer-id: ${login_cid}")
  fi

  local resp
  resp="$(curl -sS --max-time 12 -X POST \
    "https://googleads.googleapis.com/v17/customers/${cid}/googleAds:searchStream" \
    -H "Authorization: Bearer ${access_token}" \
    -H "developer-token: ${developer_token}" \
    -H "Content-Type: application/json" \
    "${hdr_login[@]}" \
    -d "$body" 2>/dev/null || echo '[]')"

  # Aggregate across all streamed result rows.
  local cost_micros impressions clicks conversions conv_value
  cost_micros="$(printf '%s' "$resp" | jq '[.[]?.results[]?.metrics.costMicros // 0 | tonumber? // 0] | add // 0' 2>/dev/null || echo 0)"
  impressions="$(printf '%s' "$resp" | jq '[.[]?.results[]?.metrics.impressions // 0 | tonumber? // 0] | add // 0' 2>/dev/null || echo 0)"
  clicks="$(printf '%s' "$resp" | jq '[.[]?.results[]?.metrics.clicks // 0 | tonumber? // 0] | add // 0' 2>/dev/null || echo 0)"
  conversions="$(printf '%s' "$resp" | jq '[.[]?.results[]?.metrics.conversions // 0 | tonumber? // 0] | add // 0' 2>/dev/null || echo 0)"
  conv_value="$(printf '%s' "$resp" | jq '[.[]?.results[]?.metrics.conversionsValue // 0 | tonumber? // 0] | add // 0' 2>/dev/null || echo 0)"

  jq -nc \
    --arg p "$proj" \
    --argjson cm "$cost_micros" \
    --argjson imp "$impressions" \
    --argjson clk "$clicks" \
    --argjson conv "$conversions" \
    --argjson cv "$conv_value" '
    {
      surface: "google_ads",
      project: $p,
      spend: (($cm / 1000000) * 100 | round / 100 | tostring),
      impressions: ($imp | tostring),
      clicks: ($clk | tostring),
      conversions: ($conv | tostring),
      conversions_value: ($cv | tostring),
      window_days: 7
    }
    | .roas = (
        if ($cm == 0) then "0.00"
        else (($cv / ($cm / 1000000)) * 100 | round / 100 | tostring)
        end
      )
  ' 2>/dev/null || printf 'null'
}

# ── Stubs: tiktok / linkedin / reddit / microsoft / pinterest ─────────────────
_ad_spend_stub_surface() {
  local surface="$1" proj="$2" field="$3"
  if [ -z "$proj" ]; then printf 'null'; return 0; fi
  local prefs; prefs="$(_ad_spend_prefs_path)"
  [ -f "$prefs" ] || { printf 'null'; return 0; }

  local ref
  ref="$(_prefs_marketing "$proj" "$surface" "$field")"
  if [ -z "$ref" ] || [ "$ref" = "null" ]; then
    printf 'null'
    return 0
  fi
  # Configured but not yet implemented — emit a sentinel.
  jq -nc --arg s "$surface" --arg p "$proj" \
    '{surface:$s, project:$p, status:"configured_but_not_implemented"}' 2>/dev/null \
    || printf 'null'
}

ad_spend_tiktok()    { _ad_spend_stub_surface "tiktok"    "${1:-}" "access_token"; }
ad_spend_linkedin()  { _ad_spend_stub_surface "linkedin"  "${1:-}" "access_token"; }
ad_spend_reddit()    { _ad_spend_stub_surface "reddit"    "${1:-}" "access_token"; }
ad_spend_microsoft() { _ad_spend_stub_surface "microsoft" "${1:-}" "access_token"; }
ad_spend_pinterest() { _ad_spend_stub_surface "pinterest" "${1:-}" "access_token"; }

# ── ad_spend_all ──────────────────────────────────────────────────────────────
ad_spend_all() {
  local proj="${1:-}"
  if [ -z "$proj" ]; then
    jq -nc '{project:"", total_spend_7d:"0.00", window_days:7, surfaces:[]}'
    return 0
  fi

  local results=()
  local out
  for fn in ad_spend_meta ad_spend_google ad_spend_tiktok ad_spend_linkedin ad_spend_reddit ad_spend_microsoft ad_spend_pinterest; do
    out="$("$fn" "$proj" 2>/dev/null || printf 'null')"
    [ -z "$out" ] && out="null"
    if [ "$out" != "null" ]; then
      results+=("$out")
    fi
  done

  # Build surfaces array via jq slurp.
  local surfaces_json="[]"
  if [ ${#results[@]} -gt 0 ]; then
    surfaces_json="$(printf '%s\n' "${results[@]}" | jq -s '.' 2>/dev/null || echo '[]')"
  fi

  # Sum .spend over surfaces (only those with a numeric .spend field).
  local total
  total="$(printf '%s' "$surfaces_json" | jq '[.[] | (.spend // "0") | tonumber? // 0] | add // 0 | . * 100 | round / 100' 2>/dev/null || echo 0)"

  jq -nc \
    --arg p "$proj" \
    --argjson surfaces "$surfaces_json" \
    --argjson total "$total" '
    {
      project: $p,
      total_spend_7d: ($total | tostring),
      window_days: 7,
      surfaces: $surfaces
    }
  ' 2>/dev/null || jq -nc --arg p "$proj" '{project:$p, total_spend_7d:"0.00", window_days:7, surfaces:[]}'
}
