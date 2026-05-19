#!/usr/bin/env bash
# cloudflare-dns.sh — Shared Cloudflare DNS helpers for claude-ops bins.
#
# Source this file (do not execute):
#   . "$PLUGIN_ROOT/scripts/lib/cloudflare-dns.sh"
#
# Public functions:
#   cf_auth_header              — echo Cloudflare auth header(s) for curl
#   cf_apex_for                 — derive apex/zone domain from any FQDN
#   cf_zone_id <apex>           — resolve zone ID via GET /zones?name=<apex>
#   cf_dns_records_json <zone> <type> <name>
#                               — raw JSON body of GET dns_records (full .result[])
#   cf_record_get <zone> <type> <name>
#                               — JSON of matching record (first hit) or empty
#   cf_record_upsert <zone> <type> <name> <content> [ttl]
#                               — GET-first idempotent upsert (POST or PUT).
#                                 For type=TXT: multiple RRs per name are
#                                 supported — exact match no-ops; otherwise POST
#                                 (append). Never PUT-replaces an unrelated TXT.
#   cf_record_delete <zone> <id>
#
# Honors OPS_DRY_RUN=1 — prints planned API calls without firing.
# Auth: CLOUDFLARE_API_TOKEN (Bearer) preferred, falls back to
#       CLOUDFLARE_API_KEY + CLOUDFLARE_EMAIL (Global key).

# Guard against double-sourcing.
# shellcheck disable=SC2317  # return is reachable when file is sourced
if [[ -n "${__OPS_CLOUDFLARE_DNS_SOURCED:-}" ]]; then
  return 0 2>/dev/null || exit 0
fi
__OPS_CLOUDFLARE_DNS_SOURCED=1

CF_API_BASE="${CF_API_BASE:-https://api.cloudflare.com/client/v4}"

# --- logging (cheap, library-safe) -------------------------------------------
_cf_log()    { printf '[cf-dns] %s\n' "$*" >&2; }
_cf_dryrun() { printf '[cf-dns][DRY-RUN] %s\n' "$*" >&2; }

# Returns 0 if dry-run is on.
cf_is_dry_run() {
  [[ "${OPS_DRY_RUN:-0}" = "1" ]]
}

# Emit curl auth headers as a single space-joined string suitable for
# `eval`-free callers that pass headers via an array. We return the headers
# via stdout in the form: -H "k: v" -H "k: v"
# Callers should use: read -r -a CF_HDR < <(cf_auth_header)
cf_auth_header() {
  local token="${CLOUDFLARE_API_TOKEN:-}"
  local key="${CLOUDFLARE_API_KEY:-}"
  local email="${CLOUDFLARE_EMAIL:-}"
  if [[ -n "$token" ]]; then
    printf -- '-H Authorization:\ Bearer\ %s' "$token"
    return 0
  fi
  if [[ -n "$key" && -n "$email" ]]; then
    printf -- '-H X-Auth-Key:\ %s -H X-Auth-Email:\ %s' "$key" "$email"
    return 0
  fi
  return 1
}

# Build a curl argv array into CF_CURL_ARGS for the auth method.
# Uses globals to avoid heredoc/eval; callers should declare:
#   local -a CF_CURL_ARGS=()
#   cf_curl_args_set
cf_curl_args_set() {
  CF_CURL_ARGS=()
  local token="${CLOUDFLARE_API_TOKEN:-}"
  local key="${CLOUDFLARE_API_KEY:-}"
  local email="${CLOUDFLARE_EMAIL:-}"
  if [[ -n "$token" ]]; then
    CF_CURL_ARGS+=( -H "Authorization: Bearer $token" )
    return 0
  fi
  if [[ -n "$key" && -n "$email" ]]; then
    CF_CURL_ARGS+=( -H "X-Auth-Key: $key" -H "X-Auth-Email: $email" )
    return 0
  fi
  _cf_log "ERROR: no Cloudflare credentials (set CLOUDFLARE_API_TOKEN or CLOUDFLARE_API_KEY+CLOUDFLARE_EMAIL)"
  return 1
}

# Robust apex resolver. Handles:
#   - 2-label TLDs (example.com)        -> example.com
#   - 3-label sub-of-2 (api.example.com) -> example.com
#   - co.uk-style 2nd-level TLDs (foo.co.uk) -> foo.co.uk
# Heuristic: if penultimate label is in a known multi-part TLD list, take 3 trailing labels.
cf_apex_for() {
  local fqdn="${1:-}"
  [[ -z "$fqdn" ]] && return 1
  # Strip trailing dot and any protocol/path/port.
  fqdn="${fqdn#http://}"
  fqdn="${fqdn#https://}"
  fqdn="${fqdn%%/*}"
  fqdn="${fqdn%%:*}"
  fqdn="${fqdn%.}"
  fqdn="$(printf '%s' "$fqdn" | tr '[:upper:]' '[:lower:]')"

  local -a labels=()
  IFS='.' read -r -a labels <<< "$fqdn"
  local n=${#labels[@]}
  (( n < 2 )) && { printf '%s\n' "$fqdn"; return 0; }

  # 2-label compound TLDs we want to keep intact.
  local penult="${labels[$((n-2))]}"
  local last="${labels[$((n-1))]}"
  local compound="${penult}.${last}"
  case "$compound" in
    co.uk|org.uk|ac.uk|gov.uk|co.jp|ne.jp|or.jp|co.kr|co.nz|com.au|net.au|org.au|com.br|co.za|com.mx|com.sg|co.in)
      if (( n >= 3 )); then
        printf '%s.%s.%s\n' "${labels[$((n-3))]}" "$penult" "$last"
        return 0
      fi
      printf '%s\n' "$fqdn"
      return 0
      ;;
  esac
  printf '%s.%s\n' "$penult" "$last"
}

# Resolve zone ID for an apex. Echoes id on stdout. Empty on miss.
cf_zone_id() {
  local apex="${1:-}"
  [[ -z "$apex" ]] && return 1
  if cf_is_dry_run; then
    _cf_dryrun "GET $CF_API_BASE/zones?name=$apex"
    printf 'dryrun-zone-id\n'
    return 0
  fi
  local -a CF_CURL_ARGS=()
  cf_curl_args_set || return 1
  local resp
  resp="$(curl -sS --max-time 10 "${CF_CURL_ARGS[@]}" \
    "$CF_API_BASE/zones?name=$apex" 2>/dev/null || printf '{}')"
  printf '%s' "$resp" | jq -r '.result[0].id // empty' 2>/dev/null
}

# Raw JSON from GET /zones/:zone/dns_records?type=&name= (includes full .result[]).
# Args: <zone_id> <type> <name>
cf_dns_records_json() {
  local zone="${1:-}" type="${2:-}" name="${3:-}"
  [[ -z "$zone" || -z "$type" || -z "$name" ]] && return 1
  if cf_is_dry_run; then
    _cf_dryrun "GET $CF_API_BASE/zones/$zone/dns_records?type=$type&name=$name"
    printf '{"result":[]}'
    return 0
  fi
  local -a CF_CURL_ARGS=()
  cf_curl_args_set || return 1
  curl -sS --max-time 10 "${CF_CURL_ARGS[@]}" \
    "$CF_API_BASE/zones/$zone/dns_records?type=$type&name=$name" 2>/dev/null || printf '{}'
}

# Fetch first record matching type+name. Echoes JSON object or empty.
# Args: <zone_id> <type> <name>
cf_record_get() {
  local zone="${1:-}" type="${2:-}" name="${3:-}"
  [[ -z "$zone" || -z "$type" || -z "$name" ]] && return 1
  local resp
  resp="$(cf_dns_records_json "$zone" "$type" "$name" || printf '{}')"
  printf '%s' "$resp" | jq -c '.result[0] // empty' 2>/dev/null
}

# Idempotent upsert. GET-first by name+type; PUT if found, POST if not.
# Args: <zone_id> <type> <name> <content> [ttl=120] [proxied=false]
# Echoes the record ID on success.
# TXT: multiple records per name are normal at the apex — we never PUT an
# unrelated existing TXT; we POST a new RR unless an exact content match exists.
cf_record_upsert() {
  local zone="${1:-}" type="${2:-}" name="${3:-}" content="${4:-}"
  local ttl="${5:-120}" proxied="${6:-false}"
  if [[ -z "$zone" || -z "$type" || -z "$name" || -z "$content" ]]; then
    _cf_log "ERROR: cf_record_upsert: zone/type/name/content all required"
    return 2
  fi

  # Build payload via jq for safe JSON escaping.
  local payload
  payload="$(jq -nc \
    --arg type "$type" \
    --arg name "$name" \
    --arg content "$content" \
    --argjson ttl "$ttl" \
    --argjson proxied "$proxied" \
    '{type:$type, name:$name, content:$content, ttl:$ttl, proxied:$proxied}')"

  if cf_is_dry_run; then
    local existing_id="dryrun-record-id"
    _cf_dryrun "GET $CF_API_BASE/zones/$zone/dns_records?type=$type&name=$name"
    _cf_dryrun "PUT|POST $CF_API_BASE/zones/$zone/dns_records  body=$payload"
    printf '%s\n' "$existing_id"
    return 0
  fi

  local -a CF_CURL_ARGS=()
  cf_curl_args_set || return 1
  CF_CURL_ARGS+=( -H "Content-Type: application/json" )

  local list_json existing_id
  list_json="$(cf_dns_records_json "$zone" "$type" "$name" || printf '{}')"
  existing_id="$(printf '%s' "$list_json" | jq -r --arg c "$content" \
    '.result[]? | select(.content == $c) | .id' 2>/dev/null | head -n 1)"
  if [[ -n "$existing_id" ]]; then
    _cf_log "no-op: $type $name already has desired content"
    printf '%s\n' "$existing_id"
    return 0
  fi

  local resp http
  if [[ "$type" = "TXT" ]]; then
    resp="$(curl -sS --max-time 10 -w '\n%{http_code}' -X POST \
      "${CF_CURL_ARGS[@]}" \
      --data "$payload" \
      "$CF_API_BASE/zones/$zone/dns_records" 2>/dev/null || printf '{}\n0')"
  else
    local existing existing_id2 existing_content
    existing="$(printf '%s' "$list_json" | jq -c '.result[0] // empty' 2>/dev/null)"
    existing_id2="$(printf '%s' "$existing" | jq -r '.id // empty' 2>/dev/null || true)"
    existing_content="$(printf '%s' "$existing" | jq -r '.content // empty' 2>/dev/null || true)"
    if [[ -n "$existing_id2" ]]; then
      if [[ "$existing_content" = "$content" ]]; then
        _cf_log "no-op: $type $name already has desired content"
        printf '%s\n' "$existing_id2"
        return 0
      fi
      resp="$(curl -sS --max-time 10 -w '\n%{http_code}' -X PUT \
        "${CF_CURL_ARGS[@]}" \
        --data "$payload" \
        "$CF_API_BASE/zones/$zone/dns_records/$existing_id2" 2>/dev/null || printf '{}\n0')"
    else
      resp="$(curl -sS --max-time 10 -w '\n%{http_code}' -X POST \
        "${CF_CURL_ARGS[@]}" \
        --data "$payload" \
        "$CF_API_BASE/zones/$zone/dns_records" 2>/dev/null || printf '{}\n0')"
    fi
  fi

  http="${resp##*$'\n'}"
  local body="${resp%$'\n'*}"
  if [[ "$http" != "200" && "$http" != "201" ]]; then
    _cf_log "ERROR: upsert failed (http=$http): $body"
    return 1
  fi
  printf '%s' "$body" | jq -r '.result.id // empty' 2>/dev/null
}

# Delete a record by ID.
cf_record_delete() {
  local zone="${1:-}" id="${2:-}"
  [[ -z "$zone" || -z "$id" ]] && return 1
  if cf_is_dry_run; then
    _cf_dryrun "DELETE $CF_API_BASE/zones/$zone/dns_records/$id"
    return 0
  fi
  local -a CF_CURL_ARGS=()
  cf_curl_args_set || return 1
  curl -sS --max-time 10 -X DELETE "${CF_CURL_ARGS[@]}" \
    "$CF_API_BASE/zones/$zone/dns_records/$id" >/dev/null
}

# Merge a value into an existing TXT record (apex SPF case).
# Behaviour: if no record exists, create with $new_content.
# If record exists and already contains $merge_marker substring, leave alone.
# Otherwise PUT the new content (caller is responsible for merge logic, this
# helper is the "never silently overwrite a foreign value" guard).
# Scans all TXT RRs at $name — never assumes .result[0] only.
# Args: <zone> <name> <new_content> <merge_marker>
cf_txt_upsert_safe() {
  local zone="${1:-}" name="${2:-}" new_content="${3:-}" marker="${4:-}"
  [[ -z "$zone" || -z "$name" || -z "$new_content" ]] && return 2

  if cf_is_dry_run; then
    _cf_dryrun "safe-TXT upsert at $name: marker=$marker  content=$new_content"
    cf_record_upsert "$zone" "TXT" "$name" "$new_content" 120
    return $?
  fi

  local list_json match_id match_content any_foreign
  list_json="$(cf_dns_records_json "$zone" "TXT" "$name" || printf '{}')"
  match_id="$(printf '%s' "$list_json" | jq -r --arg c "$new_content" \
    '.result[]? | select(.content == $c) | .id' 2>/dev/null | head -n 1)"
  if [[ -n "$match_id" ]]; then
    _cf_log "no-op: TXT $name already matches"
    printf '%s\n' "$match_id"
    return 0
  fi

  local n
  n="$(printf '%s' "$list_json" | jq '.result | length // 0' 2>/dev/null || echo 0)"
  if [[ "$n" -eq 0 ]]; then
    cf_record_upsert "$zone" "TXT" "$name" "$new_content" 120
    return $?
  fi

  if [[ -n "$marker" ]]; then
    match_id="$(printf '%s' "$list_json" | jq -r --arg m "$marker" \
      '.result[]? | select(.content | contains($m)) | .id' 2>/dev/null | head -n 1)"
    match_content="$(printf '%s' "$list_json" | jq -r --arg m "$marker" \
      '.result[]? | select(.content | contains($m)) | .content' 2>/dev/null | head -n 1)"
    if [[ -n "$match_id" ]]; then
      if [[ "$match_content" = "$new_content" ]]; then
        _cf_log "no-op: TXT $name (marker) already matches"
        printf '%s\n' "$match_id"
        return 0
      fi
      local payload
      payload="$(jq -nc \
        --arg name "$name" \
        --arg content "$new_content" \
        '{type:"TXT", name:$name, content:$content, ttl:120, proxied:false}')"
      local -a CF_CURL_ARGS=()
      cf_curl_args_set || return 1
      CF_CURL_ARGS+=( -H "Content-Type: application/json" )
      local resp http
      resp="$(curl -sS --max-time 10 -w '\n%{http_code}' -X PUT \
        "${CF_CURL_ARGS[@]}" \
        --data "$payload" \
        "$CF_API_BASE/zones/$zone/dns_records/$match_id" 2>/dev/null || printf '{}\n0')"
      http="${resp##*$'\n'}"
      local body="${resp%$'\n'*}"
      if [[ "$http" != "200" && "$http" != "201" ]]; then
        _cf_log "ERROR: safe TXT PUT failed (http=$http): $body"
        return 1
      fi
      printf '%s' "$body" | jq -r '.result.id // empty' 2>/dev/null
      return 0
    fi
    if [[ "$n" -gt 0 ]]; then
      _cf_log "WARN: TXT $name has foreign content (no marker '$marker'); refusing to overwrite."
      return 3
    fi
  fi

  cf_record_upsert "$zone" "TXT" "$name" "$new_content" 120
}
