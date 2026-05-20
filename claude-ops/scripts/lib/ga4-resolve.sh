#!/usr/bin/env bash
# scripts/lib/ga4-resolve.sh — shared resolver for GA4 + GSC channel config
#
# Source-able library. Exports functions:
#   ga4_resolve <project_key>        — sets GA4_PROPERTY_ID, GA4_MEASUREMENT_ID,
#                                      GA4_STREAM_ID, GA4_API_SECRET
#   gsc_resolve <project_key>        — sets GSC_SITE_URL, GSC_VERIFIED
#   marketing_channels_status <key>  — prints channel status lines (plain or --json)
#
# Sourcing convention:
#   PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
#   . "${PLUGIN_ROOT}/lib/registry-path.sh"
#   . "${PLUGIN_ROOT}/scripts/lib/ga4-resolve.sh"
#
# Requires: OPS_DATA_DIR already exported (source registry-path.sh first).

# Guard against double-sourcing
[ -n "${_GA4_RESOLVE_LOADED:-}" ] && return 0
_GA4_RESOLVE_LOADED=1

# ---------------------------------------------------------------------------
# resolve_cred — canonical implementation shared by all marketing scripts.
# Callers that previously defined this locally should remove their copy and
# source this lib instead.
#
# env:VAR_NAME                   -> $VAR_NAME from environment
# doppler:project/config/SECRET  -> doppler secrets get
# <anything else>                -> inline literal
# Empty input -> empty output. Never fails.
# ---------------------------------------------------------------------------
resolve_cred() {
  local ref="${1:-}"
  { [ -z "$ref" ] || [ "$ref" = "null" ]; } && return 0
  case "$ref" in
    env:*)
      local var="${ref#env:}"
      printf '%s' "${!var:-}"
      ;;
    doppler:*)
      local path="${ref#doppler:}"
      local proj="${path%%/*}"
      local rest="${path#*/}"
      local cfg="${rest%%/*}"
      local secret="${rest#*/}"
      { [ -z "$proj" ] || [ -z "$cfg" ] || [ -z "$secret" ]; } && return 0
      doppler secrets get "$secret" --project "$proj" --config "$cfg" --plain 2>/dev/null || true
      ;;
    *)
      printf '%s' "$ref"
      ;;
  esac
}

# ---------------------------------------------------------------------------
# resolve_cred_strict — like resolve_cred but distinguishes three states:
#   rc=0 + stdout value  — resolved and non-empty (healthy)
#   rc=1 + empty stdout  — ref is empty/null (not configured — expected)
#   rc=2 + empty stdout  — ref is declared but resolver returned empty (broken)
#
# Usage:
#   val="$(resolve_cred_strict "$ref")"; rc=$?
#   case $rc in
#     0) use "$val" ;;
#     1) skip ;; # not configured — expected
#     2) escalate "Doppler ref declared but empty: $ref" ;;
#   esac
# ---------------------------------------------------------------------------
resolve_cred_strict() {
  local ref="${1:-}"
  if [ -z "$ref" ] || [ "$ref" = "null" ]; then
    return 1
  fi
  local val
  val="$(resolve_cred "$ref")"
  if [ -n "$val" ]; then
    printf '%s' "$val"
    return 0
  fi
  # ref declared but resolver returned empty — broken configuration
  return 2
}

# ---------------------------------------------------------------------------
# _prefs_marketing — read a field from preferences.json marketing.projects.<p>.<c>.<f>
# $1=project $2=channel $3=field
# ---------------------------------------------------------------------------
_prefs_marketing() {
  local prefs="${OPS_DATA_DIR}/preferences.json"
  [ -f "$prefs" ] || return 0
  jq -r --arg p "$1" --arg c "$2" --arg f "$3" \
    '.marketing.projects[$p][$c][$f] // empty' "$prefs" 2>/dev/null
}

# ---------------------------------------------------------------------------
# ga4_resolve <project_key>
# Exports: GA4_PROPERTY_ID, GA4_MEASUREMENT_ID, GA4_STREAM_ID, GA4_API_SECRET
# ---------------------------------------------------------------------------
ga4_resolve() {
  local proj="${1:-}"
  GA4_PROPERTY_ID=""
  GA4_MEASUREMENT_ID=""
  GA4_STREAM_ID=""
  GA4_API_SECRET=""

  if [ -z "$proj" ]; then
    return 0
  fi

  GA4_PROPERTY_ID="$(resolve_cred "$(_prefs_marketing "$proj" "ga4" "property_id")")"
  GA4_MEASUREMENT_ID="$(resolve_cred "$(_prefs_marketing "$proj" "ga4" "measurement_id")")"
  GA4_STREAM_ID="$(resolve_cred "$(_prefs_marketing "$proj" "ga4" "stream_id")")"
  GA4_API_SECRET="$(resolve_cred "$(_prefs_marketing "$proj" "ga4" "api_secret")")"

  export GA4_PROPERTY_ID GA4_MEASUREMENT_ID GA4_STREAM_ID GA4_API_SECRET
}

# ---------------------------------------------------------------------------
# gsc_resolve <project_key>
# Exports: GSC_SITE_URL, GSC_VERIFIED
# ---------------------------------------------------------------------------
gsc_resolve() {
  local proj="${1:-}"
  GSC_SITE_URL=""
  GSC_VERIFIED="false"

  if [ -z "$proj" ]; then
    return 0
  fi

  GSC_SITE_URL="$(resolve_cred "$(_prefs_marketing "$proj" "gsc" "site_url")")"
  local raw_verified
  raw_verified="$(_prefs_marketing "$proj" "gsc" "verified")"
  [ "$raw_verified" = "true" ] && GSC_VERIFIED="true" || GSC_VERIFIED="false"

  export GSC_SITE_URL GSC_VERIFIED
}

# ---------------------------------------------------------------------------
# marketing_channels_status <project_key> [--json]
# Prints one line per channel: "ga4: configured|missing"
# With --json: prints a JSON object.
# ---------------------------------------------------------------------------
marketing_channels_status() {
  local proj="${1:-}"
  local json_mode=0
  [ "${2:-}" = "--json" ] && json_mode=1

  local prefs="${OPS_DATA_DIR}/preferences.json"

  # Helper: check if a field is non-empty and non-null in prefs
  _chan_set() {
    local val
    val="$(_prefs_marketing "$proj" "$1" "$2")"
    [ -n "$val" ] && [ "$val" != "null" ] && echo "true" || echo "false"
  }

  local ga4_ok gsc_ok meta_ok gads_ok klaviyo_ok ig_ok
  ga4_ok="$(_chan_set "ga4" "property_id")"
  gsc_ok="$(_chan_set "gsc" "site_url")"
  meta_ok="$(_chan_set "meta" "access_token")"
  gads_ok="$(_chan_set "google_ads" "developer_token")"
  klaviyo_ok="$(_chan_set "klaviyo" "private_key")"
  ig_ok="$(_chan_set "instagram" "account_id")"

  _label() { [ "$1" = "true" ] && echo "configured" || echo "missing"; }

  if [ "$json_mode" = "1" ]; then
    jq -n \
      --arg ga4 "$(_label "$ga4_ok")" \
      --arg gsc "$(_label "$gsc_ok")" \
      --arg meta "$(_label "$meta_ok")" \
      --arg google_ads "$(_label "$gads_ok")" \
      --arg klaviyo "$(_label "$klaviyo_ok")" \
      --arg instagram "$(_label "$ig_ok")" \
      '{ga4: $ga4, gsc: $gsc, meta: $meta, google_ads: $google_ads, klaviyo: $klaviyo, instagram: $instagram}'
  else
    echo "ga4: $(_label "$ga4_ok")"
    echo "gsc: $(_label "$gsc_ok")"
    echo "meta: $(_label "$meta_ok")"
    echo "google_ads: $(_label "$gads_ok")"
    echo "klaviyo: $(_label "$klaviyo_ok")"
    echo "instagram: $(_label "$ig_ok")"
  fi
}
