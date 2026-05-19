#!/usr/bin/env bash
# scripts/lib/ga4-data-api.sh — shared GA4 Data API helpers
#
# Source-able library used by both bin/ops-marketing-dash and
# bin/ops-marketing-autopilot. All network paths honour OPS_DRY_RUN — when set,
# requests are NOT issued and the helper returns an empty JSON envelope.
#
# Exports:
#   ga4_auth_token [sa_key_file]            — print a fresh GA4 access token
#   ga4_run_report <property_id> <body_json> — POST :runReport, print response JSON
#
# Requires: jq, openssl, curl, base64. ADC fallback uses gcloud if installed.

[ -n "${_GA4_DATA_API_LOADED:-}" ] && return 0
_GA4_DATA_API_LOADED=1

# ga4_auth_token [sa_key_file]
# Resolution order:
#   1) explicit arg
#   2) $GA4_SERVICE_ACCOUNT_KEY_FILE
#   3) first ~/.config/gcloud/keys/*ga*.json
#   4) gcloud ADC
ga4_auth_token() {
  local sa_key_file="${1:-${GA4_SERVICE_ACCOUNT_KEY_FILE:-}}"
  if [ -z "$sa_key_file" ]; then
    sa_key_file="$(ls "$HOME"/.config/gcloud/keys/*ga*.json 2>/dev/null | head -1 || true)"
  fi
  if [ -n "$sa_key_file" ] && [ -f "$sa_key_file" ]; then
    local now exp header payload sig jwt resp sa_token
    now=$(date +%s)
    exp=$((now + 3600))
    header=$(printf '{"alg":"RS256","typ":"JWT"}' | base64 | tr -d '=' | tr '+/' '-_' | tr -d '\n')
    payload=$(printf '{"iss":"%s","scope":"https://www.googleapis.com/auth/analytics.readonly","aud":"https://oauth2.googleapis.com/token","exp":%d,"iat":%d}' \
      "$(jq -r '.client_email' "$sa_key_file")" "$exp" "$now" \
      | base64 | tr -d '=' | tr '+/' '-_' | tr -d '\n')
    sig=$(printf '%s.%s' "$header" "$payload" \
      | openssl dgst -sha256 -sign <(jq -r '.private_key' "$sa_key_file") 2>/dev/null \
      | base64 | tr -d '=' | tr '+/' '-_' | tr -d '\n')
    jwt="${header}.${payload}.${sig}"
    resp=$(curl -sS --max-time 5 -X POST https://oauth2.googleapis.com/token \
      --data "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}" 2>/dev/null || echo '{}')
    sa_token="$(printf '%s' "$resp" | jq -r '.access_token // empty' 2>/dev/null || true)"
    if [ -n "$sa_token" ]; then
      printf '%s' "$sa_token"
      return 0
    fi
  fi
  if command -v gcloud >/dev/null 2>&1; then
    gcloud auth application-default print-access-token 2>/dev/null || true
  fi
}

# ga4_run_report <property_id> <body_json>
# Prints raw GA4 :runReport JSON or "{}" on failure / dry-run.
ga4_run_report() {
  local prop="${1:-}" body="${2:-}"
  if [ -z "$prop" ] || [ "$prop" = "0" ] || [ -z "$body" ]; then
    printf '%s' '{}'
    return 0
  fi
  if [ "${OPS_DRY_RUN:-0}" = "1" ]; then
    printf '%s' '{}'
    return 0
  fi
  local tok
  tok="$(ga4_auth_token)"
  if [ -z "$tok" ]; then
    printf '%s' '{}'
    return 0
  fi
  curl -gsS --max-time 12 -X POST \
    "https://analyticsdata.googleapis.com/v1beta/properties/${prop}:runReport" \
    -H "Authorization: Bearer ${tok}" \
    -H "Content-Type: application/json" \
    -d "$body" 2>/dev/null || printf '%s' '{}'
}
