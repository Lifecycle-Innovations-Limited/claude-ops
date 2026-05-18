#!/usr/bin/env bash
# creative/generate.sh — Tier 0 metered media generation (Veo 3 / Gemini Flash Image).
#
# Source this lib, then call:
#   creative_generate <project> <brief_json> <out_dir>
#
# brief_json example:
#   '{"prompt":"Woman doing yoga at sunrise, 9:16, vibrant health","type":"video|image"}'
#
# Prints ONE JSON:
#   {"generated":[{"path":"...","type":"video|image","est_cost_usd":N}],
#    "spend_today":N,"capped":bool,"refused":bool,"reason":""}
#
# METERED-SPEND GUARD (NEVER LEAK MONEY):
#   - Reads daily_gen_spend_cap_usd from config (default $5)
#   - Per-day accumulator: $STATE/.gen-spend-YYYY-MM-DD (flock-guarded)
#   - Per-pass hard count cap: default max 3 gens/pass
#   - UNIT COSTS (_COST_NOTE): these are ESTIMATES used for pre-call accounting.
#     The cap is the real guard — actual Gemini billing may differ.
#   - If accumulated + unit_cost > cap → DO NOT call API, set capped:true
#   - flock used if available; mkdir-mutex fallback for systems without flock
#
# _COST_NOTE: Veo3 Fast ≈ $0.40/clip, Gemini Flash Image ≈ $0.04/image.
# Source: Gemini pricing page (estimates; verify against your billing dashboard).
#
# Don't `set -e` — callers source this; let them control failure semantics.

# Unit cost estimates (ESTIMATES — cap is the real guard)
# _COST_NOTE: update these when Gemini pricing changes; they drive pre-call accounting only.
readonly _VEO3_FAST_COST_USD="0.40"
readonly _GEMINI_FLASH_IMAGE_COST_USD="0.04"

readonly _VEO3_MODEL="veo-3.0-fast-generate-001"
readonly _GEMINI_IMAGE_MODEL="gemini-2.0-flash-preview-image-generation"

readonly _DEFAULT_GEN_SPEND_CAP=5
readonly _DEFAULT_MAX_GENS_PER_PASS=3

_gen_log() {
  printf '[generate] %s\n' "$1" >&2
}

# Only define resolve_cred if not already present
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

if ! declare -f ap_get >/dev/null 2>&1; then
  ap_get() {
    local proj="$1" path="$2"
    local PREFS="${OPS_AUTOPILOT_PREFS:-${OPS_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/preferences.json}"
    [ -f "$PREFS" ] || return 0
    jq -r --arg p "$proj" ".marketing.projects[\$p].autopilot${path} // empty" "$PREFS" 2>/dev/null
  }
fi

# ── Spend accumulator with flock/mkdir mutex ──────────────────────────────────
# _gen_spend_read <acc_file> → prints current accumulated spend as float
_gen_spend_read() {
  local f="$1"
  [ -f "$f" ] && cat "$f" 2>/dev/null || echo "0"
}

# _gen_spend_add <acc_file> <amount> → atomically adds amount, returns new total
# Uses flock if available, mkdir-mutex otherwise. Both are process-global and
# correct under N concurrent processes (NOT relying on NODE_APP_INSTANCE or PID).
_gen_spend_add() {
  local acc_file="$1"
  local amount="$2"
  local lock_dir="${acc_file}.lock"

  if command -v flock >/dev/null 2>&1; then
    # flock: open fd 200 on acc_file directory, exclusive lock
    local acc_dir
    acc_dir="$(dirname "$acc_file")"
    (
      flock -x 200
      local current
      current="$(_gen_spend_read "$acc_file")"
      local new
      new="$(python3 -c "print(round($current + $amount, 4))" 2>/dev/null || echo "$amount")"
      printf '%s' "$new" > "$acc_file"
      printf '%s' "$new"
    ) 200>"${acc_file}.flock" 2>/dev/null
  else
    # mkdir-mutex fallback: atomic on POSIX (kernel guarantees mkdir atomicity)
    local i=0
    while ! mkdir "$lock_dir" 2>/dev/null; do
      i=$((i+1))
      [ "$i" -gt 50 ] && break  # 5s max wait (50 × 0.1s)
      # Portable sleep without fractional seconds
      python3 -c "import time; time.sleep(0.1)" 2>/dev/null || true
    done
    local current new
    current="$(_gen_spend_read "$acc_file")"
    new="$(python3 -c "print(round($current + $amount, 4))" 2>/dev/null || echo "$amount")"
    printf '%s' "$new" > "$acc_file"
    rmdir "$lock_dir" 2>/dev/null || true
    printf '%s' "$new"
  fi
}

# ── _gen_check_cap — returns 0 if under cap, 1 if capped ────────────────────
# Prints spend_today to stdout
_gen_check_cap() {
  local acc_file="$1"
  local unit_cost="$2"
  local cap="$3"

  local current
  current="$(_gen_spend_read "$acc_file")"

  # Check: current + unit_cost > cap?
  local over
  over="$(python3 -c "print(1 if $current + $unit_cost > $cap else 0)" 2>/dev/null || echo 0)"

  printf '%s' "$current"  # caller reads this
  [ "$over" = "1" ] && return 1 || return 0
}

# ── _gen_veo3 — Veo 3 Fast video generation ──────────────────────────────────
_gen_veo3() {
  local prompt="$1"
  local api_key="$2"
  local out_dir="$3"

  # Veo 3 via Gemini API predict endpoint
  local payload
  payload="$(jq -n --arg prompt "$prompt" '{
    instances: [{prompt: $prompt}],
    parameters: {
      aspectRatio: "9:16",
      durationSeconds: 8,
      includeAudio: true,
      model: "veo-3.0-fast-generate-001"
    }
  }')"

  # Initiate generation (long-running operation)
  local init_resp
  init_resp="$(curl -gsS --max-time 30 \
    -X POST "https://generativelanguage.googleapis.com/v1beta/models/${_VEO3_MODEL}:predictLongRunning?key=${api_key}" \
    -H 'Content-Type: application/json' \
    -d "$payload" 2>/dev/null || echo '{}')"

  local op_name
  op_name="$(printf '%s' "$init_resp" | jq -r '.name // empty' 2>/dev/null || true)"

  if [ -z "$op_name" ]; then
    _gen_log "Veo3: failed to get operation name"
    return 1
  fi

  # Poll for completion (max 120s)
  local i=0 done_resp video_uri
  while [ "$i" -lt 24 ]; do
    python3 -c "import time; time.sleep(5)" 2>/dev/null || true
    done_resp="$(curl -gsS --max-time 15 \
      "https://generativelanguage.googleapis.com/v1beta/${op_name}?key=${api_key}" 2>/dev/null || echo '{}')"
    local done_flag
    done_flag="$(printf '%s' "$done_resp" | jq -r '.done // false' 2>/dev/null || echo 'false')"
    if [ "$done_flag" = "true" ]; then
      video_uri="$(printf '%s' "$done_resp" | jq -r '.response.predictions[0].videoUri // empty' 2>/dev/null || true)"
      break
    fi
    i=$((i+1))
  done

  if [ -z "$video_uri" ]; then
    _gen_log "Veo3: operation timed out or no videoUri"
    return 1
  fi

  # Download video
  local out_file="$out_dir/creative_$(date +%s).mp4"
  curl -gsS --max-time 60 -o "$out_file" "$video_uri" 2>/dev/null || { rm -f "$out_file"; return 1; }
  [ -f "$out_file" ] && [ -s "$out_file" ] || { rm -f "$out_file"; return 1; }

  printf '%s' "$out_file"
}

# ── _gen_gemini_image — Gemini Flash image generation ────────────────────────
_gen_gemini_image() {
  local prompt="$1"
  local api_key="$2"
  local out_dir="$3"

  local payload
  payload="$(jq -n --arg prompt "$prompt" '{
    contents: [{parts: [{text: $prompt}]}],
    generationConfig: {responseModalities: ["IMAGE"], responseMimeType: "image/png"}
  }')"

  local resp
  resp="$(curl -gsS --max-time 45 \
    -X POST "https://generativelanguage.googleapis.com/v1beta/models/${_GEMINI_IMAGE_MODEL}:generateContent?key=${api_key}" \
    -H 'Content-Type: application/json' \
    -d "$payload" 2>/dev/null || echo '{}')"

  local b64_data mime_type
  b64_data="$(printf '%s' "$resp" | jq -r '.candidates[0].content.parts[0].inlineData.data // empty' 2>/dev/null || true)"
  mime_type="$(printf '%s' "$resp" | jq -r '.candidates[0].content.parts[0].inlineData.mimeType // "image/png"' 2>/dev/null || true)"

  if [ -z "$b64_data" ]; then
    _gen_log "Gemini image: no image data in response"
    return 1
  fi

  local ext="png"
  [ "$mime_type" = "image/jpeg" ] && ext="jpg"
  local out_file="$out_dir/creative_$(date +%s).${ext}"

  printf '%s' "$b64_data" | base64 -d > "$out_file" 2>/dev/null || { rm -f "$out_file"; return 1; }
  [ -f "$out_file" ] && [ -s "$out_file" ] || { rm -f "$out_file"; return 1; }

  printf '%s' "$out_file"
}

# ── creative_generate — main entrypoint ──────────────────────────────────────
creative_generate() {
  local project="$1"
  local brief_json="${2:-{}}"
  local out_dir="${3:-/tmp/creative_gen_$$}"

  mkdir -p "$out_dir"

  # ── Config reads ──────────────────────────────────────────────────────────
  local PREFS="${OPS_AUTOPILOT_PREFS:-${OPS_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/preferences.json}"
  local STATE_BASE="${OPS_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/autopilot_state/${project}"
  mkdir -p "$STATE_BASE"

  local cap max_gens api_key_ref
  cap="$(ap_get "$project" '.creative_gen.daily_gen_spend_cap_usd' 2>/dev/null || echo '')"
  cap="${cap:-$_DEFAULT_GEN_SPEND_CAP}"
  max_gens="$(ap_get "$project" '.creative_gen.max_gens_per_pass' 2>/dev/null || echo '')"
  max_gens="${max_gens:-$_DEFAULT_MAX_GENS_PER_PASS}"
  api_key_ref="$(ap_get "$project" '.creative_gen.api_key' 2>/dev/null || echo 'env:GEMINI_API_KEY')"
  [ -z "$api_key_ref" ] || [ "$api_key_ref" = "null" ] && api_key_ref="env:GEMINI_API_KEY"

  local gemini_key
  gemini_key="$(resolve_cred "$api_key_ref")"

  if [ -z "$gemini_key" ]; then
    printf '{"generated":[],"spend_today":0,"capped":false,"refused":true,"reason":"no_gemini_api_key"}\n'
    return 1
  fi

  # ── Parse brief ───────────────────────────────────────────────────────────
  local gen_prompt gen_type
  gen_prompt="$(printf '%s' "$brief_json" | jq -r '.prompt // "Compelling health and wellness ad creative, 9:16 portrait"' 2>/dev/null)"
  gen_type="$(printf '%s' "$brief_json" | jq -r '.type // "video"' 2>/dev/null)"
  [ "$gen_type" != "video" ] && [ "$gen_type" != "image" ] && gen_type="video"

  # ── Determine unit cost ───────────────────────────────────────────────────
  local unit_cost
  [ "$gen_type" = "video" ] && unit_cost="$_VEO3_FAST_COST_USD" || unit_cost="$_GEMINI_FLASH_IMAGE_COST_USD"

  # ── Spend accumulator ─────────────────────────────────────────────────────
  local acc_file="$STATE_BASE/.gen-spend-$(date +%F)"
  local today_pass_count_file="$STATE_BASE/.gen-count-$(date +%F)"
  local pass_count
  pass_count="$(_gen_spend_read "$today_pass_count_file" | tr -d '[:space:]' || echo 0)"
  pass_count="${pass_count:-0}"

  # Per-pass hard count cap check (second floor)
  if [ "$pass_count" -ge "$max_gens" ] 2>/dev/null; then
    local current_spend
    current_spend="$(_gen_spend_read "$acc_file")"
    _gen_log "per-pass count cap reached (${pass_count}/${max_gens})"
    printf '{"generated":[],"spend_today":%s,"capped":true,"refused":true,"reason":"per_pass_count_cap_%s_of_%s"}\n' \
      "${current_spend:-0}" "$pass_count" "$max_gens"
    return 1
  fi

  # Spend cap check
  local current_spend
  current_spend="$(_gen_check_cap "$acc_file" "$unit_cost" "$cap")"
  local cap_rc=$?

  if [ "$cap_rc" -ne 0 ]; then
    _gen_log "daily gen spend cap reached (${current_spend} + ${unit_cost} > ${cap})"
    printf '{"generated":[],"spend_today":%s,"capped":true,"refused":true,"reason":"daily_gen_spend_cap_usd_%s_reached"}\n' \
      "${current_spend:-0}" "$cap"
    return 1
  fi

  # ── Generate ──────────────────────────────────────────────────────────────
  local out_file generated_path gen_ok=false
  if [ "$gen_type" = "video" ]; then
    if out_file="$(_gen_veo3 "$gen_prompt" "$gemini_key" "$out_dir" 2>/dev/null)"; then
      generated_path="$out_file"
      gen_ok=true
    fi
  else
    if out_file="$(_gen_gemini_image "$gen_prompt" "$gemini_key" "$out_dir" 2>/dev/null)"; then
      generated_path="$out_file"
      gen_ok=true
    fi
  fi

  if [ "$gen_ok" = "false" ]; then
    _gen_log "generation call failed"
    printf '{"generated":[],"spend_today":%s,"capped":false,"refused":true,"reason":"generation_api_call_failed"}\n' \
      "${current_spend:-0}"
    return 1
  fi

  # ── Atomically add spend on success ──────────────────────────────────────
  local new_spend
  new_spend="$(_gen_spend_add "$acc_file" "$unit_cost")"

  # Increment pass count
  local new_count=$(( pass_count + 1 ))
  printf '%s' "$new_count" > "$today_pass_count_file"

  jq -n \
    --arg path "$generated_path" \
    --arg type "$gen_type" \
    --argjson cost "$unit_cost" \
    --argjson spend "${new_spend:-0}" \
    '{
      generated: [{path: $path, type: $type, est_cost_usd: $cost}],
      spend_today: $spend,
      capped: false,
      refused: false,
      reason: ""
    }' 2>/dev/null \
  || printf '{"generated":[],"spend_today":0,"capped":false,"refused":true,"reason":"json_assembly_error"}\n'
}
