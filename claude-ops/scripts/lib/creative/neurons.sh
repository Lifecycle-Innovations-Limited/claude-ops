#!/usr/bin/env bash
# creative/neurons.sh — Optional Neurons.inc attention-score integration.
#
# Source this lib, then call:
#   creative_neurons <asset_path>
#
# When .marketing.partners.neurons is configured AND
# .autopilot.creative_gen.neurons.enabled == true:
#   Makes ONE ensemble call to the Neurons partner API using the dynamic-partner
#   cred pattern (api_base_url, auth_pattern, credentials, health_endpoint).
#   Returns: {"attention":0-100,"cognitive_demand":0-100,"focus":0-100,"engagement":0-100}
#
# When disabled or unconfigured:
#   Prints {} and makes ZERO network calls / ZERO cred reads. True no-op.
#   Tests may assert silence on this path.
#
# Don't `set -e` — callers source this; let them control failure semantics.

_neurons_log() {
  printf '[neurons] %s\n' "$1" >&2
}

# Only define resolve_cred if not already present (bin or analyze.sh may have loaded it)
if ! declare -f resolve_cred >/dev/null 2>&1; then
  resolve_cred() {
    local ref="${1:-}"
    { [ -z "$ref" ] || [ "$ref" = "null" ]; } && return 0
    case "$ref" in
      env:*)
        local var="${ref#env:}"; printf '%s' "${!var:-}" ;;
      doppler:*)
        local path="${ref#doppler:}" proj rest cfg secret
        proj="${path%%/*}"; rest="${path#*/}"; cfg="${rest%%/*}"; secret="${rest#*/}"
        { [ -z "$proj" ] || [ -z "$cfg" ] || [ -z "$secret" ]; } && return 0
        doppler secrets get "$secret" --project "$proj" --config "$cfg" --plain 2>/dev/null || true ;;
      *) printf '%s' "$ref" ;;
    esac
  }
fi

creative_neurons() {
  local asset_path="${1:-}"

  # Locate preferences.json for partner config reads
  local PREFS="${OPS_AUTOPILOT_PREFS:-${OPS_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/preferences.json}"

  # ── Early exit: no preferences or neurons not configured ─────────────────
  # TRUE NO-OP: if prefs missing or neurons not configured, make zero network
  # calls and zero cred reads. Tests assert on this.
  if [ ! -f "$PREFS" ]; then
    printf '{}'
    return 0
  fi

  local neurons_block
  neurons_block="$(jq -r '.marketing.partners.neurons // empty' "$PREFS" 2>/dev/null || true)"
  if [ -z "$neurons_block" ] || [ "$neurons_block" = "null" ]; then
    printf '{}'
    return 0
  fi

  # Check enabled flag — read from prefs if we have a project context,
  # but creative_neurons is called from analyze.sh which already checked this.
  # Double-check via partner block's own enabled flag.
  local enabled
  enabled="$(printf '%s' "$neurons_block" | jq -r '.enabled // false' 2>/dev/null || echo 'false')"
  if [ "$enabled" != "true" ]; then
    printf '{}'
    return 0
  fi

  # ── Config reads (only reached when enabled) ──────────────────────────────
  local api_base_url auth_pattern health_endpoint
  api_base_url="$(printf '%s' "$neurons_block" | jq -r '.api_base_url // empty' 2>/dev/null || true)"
  auth_pattern="$(printf '%s' "$neurons_block" | jq -r '.auth_pattern // "bearer"' 2>/dev/null || true)"
  health_endpoint="$(printf '%s' "$neurons_block" | jq -r '.health_endpoint // empty' 2>/dev/null || true)"

  if [ -z "$api_base_url" ]; then
    _neurons_log "neurons.api_base_url not configured — skipping"
    printf '{}'
    return 0
  fi

  # Resolve credentials via dynamic-partner cred pattern
  local cred_ref cred_value
  cred_ref="$(printf '%s' "$neurons_block" | jq -r '.credentials.api_key // "env:NEURONS_API_KEY"' 2>/dev/null || true)"
  cred_value="$(resolve_cred "$cred_ref")"

  if [ -z "$cred_value" ]; then
    _neurons_log "neurons credentials not resolved (ref=$cred_ref) — skipping"
    printf '{}'
    return 0
  fi

  # ── Build auth header based on auth_pattern ───────────────────────────────
  local auth_header
  case "$auth_pattern" in
    bearer) auth_header="Authorization: Bearer ${cred_value}" ;;
    x-api-key) auth_header="x-api-key: ${cred_value}" ;;
    *) auth_header="Authorization: Bearer ${cred_value}" ;;
  esac

  # ── Check asset exists ────────────────────────────────────────────────────
  if [ -z "$asset_path" ] || [ ! -f "$asset_path" ]; then
    _neurons_log "asset_path not provided or not found — skipping"
    printf '{}'
    return 0
  fi

  # ── Make ensemble call ────────────────────────────────────────────────────
  local resp
  resp="$(curl -gsS --max-time 30 \
    -X POST "${api_base_url}/analyze" \
    -H "$auth_header" \
    -H "Content-Type: multipart/form-data" \
    -F "file=@${asset_path}" \
    2>/dev/null || echo '{}')"

  # Parse and normalize Neurons response to expected schema
  local parsed
  parsed="$(printf '%s' "$resp" | jq '{
    attention: (.attention // .attention_score // 0 | if type == "number" then (. * (if . <= 1 then 100 else 1 end) | round) else 0 end),
    cognitive_demand: (.cognitive_demand // .cognitive_load // 0 | if type == "number" then (. * (if . <= 1 then 100 else 1 end) | round) else 0 end),
    focus: (.focus // .focus_score // 0 | if type == "number" then (. * (if . <= 1 then 100 else 1 end) | round) else 0 end),
    engagement: (.engagement // .engagement_score // 0 | if type == "number" then (. * (if . <= 1 then 100 else 1 end) | round) else 0 end)
  }' 2>/dev/null || echo '{}')"

  [ -z "$parsed" ] && parsed='{}'
  printf '%s' "$parsed"
}
