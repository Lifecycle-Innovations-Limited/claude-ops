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

readonly _VEO3_MODEL="veo-3.1-fast-generate-preview"
readonly _GEMINI_IMAGE_MODEL="gemini-3.1-flash-image-preview"

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

# ── Critical-section helpers (process-global, N-concurrent correct) ──────────
# A single mutex protects BOTH the cap decision and the spend mutation so the
# read-validate-add is one indivisible operation (closes the TOCTOU money leak).
# flock is preferred; mkdir-mutex is the dependency-soft fallback. Neither
# relies on PID / NODE_APP_INSTANCE — both are correct under N OS processes.

# _gen_lock_acquire <acc_file> → opens fd 200 (flock) or spins on mkdir.
# _gen_lock_release <acc_file> → closes fd 200 / rmdir.
# These are intentionally NOT used as a pair across a network call — the lock
# is held only for the fast accumulator read+write, never across generation.

# _gen_reserve <acc_file> <unit_cost> <cap> <count_file> <max_gens>
#   Atomically inside ONE critical section: read spend AND count; refuse if
#   spend+unit > cap OR count >= max_gens; else write both (spend+unit, count+1)
#   and print the new spend total, return 0.
#
# Fix D: the count check+increment now happens inside the SAME lock as the
# spend reserve so N concurrent callers cannot all read stale count=0 and
# bypass the per-pass cap.  Previously count was read/written entirely outside
# the lock, making it a TOCTOU money-leak under concurrency.
#
# Output on success: new accumulated spend (float string)
# Output on failure: current accumulated spend (float string)
# Return: 0 = reserved, 1 = refused (cap or count exceeded)
_gen_reserve() {
  local acc_file="$1"
  local unit_cost="$2"
  local cap="$3"
  local count_file="$4"
  local max_gens="$5"
  local lock_dir="${acc_file}.lock"

  if command -v flock >/dev/null 2>&1; then
    (
      flock -x 200
      local current new over cnt
      current="$(_gen_spend_read "$acc_file")"
      over="$(python3 -c "print(1 if float('$current') + float('$unit_cost') > float('$cap') + 1e-9 else 0)" 2>/dev/null || echo 1)"
      if [ "$over" = "1" ]; then
        printf '%s' "$current"
        exit 1
      fi
      # Fix D: count check inside the same lock
      cnt="$(_gen_spend_read "$count_file" | tr -d '[:space:]')"
      cnt="${cnt:-0}"
      if [ "$cnt" -ge "$max_gens" ] 2>/dev/null; then
        printf '%s' "$current"
        exit 2
      fi
      new="$(python3 -c "print(round(float('$current') + float('$unit_cost'), 4))" 2>/dev/null || echo "")"
      [ -z "$new" ] && { printf '%s' "$current"; exit 1; }
      printf '%s' "$new" > "$acc_file"
      # Increment count atomically (same lock window)
      local new_cnt=$(( cnt + 1 ))
      printf '%s' "$new_cnt" > "$count_file"
      printf '%s' "$new"
      exit 0
    ) 200>"${acc_file}.flock"
    return $?
  fi

  # mkdir-mutex fallback: mkdir is atomic on POSIX (kernel guarantees it),
  # so exactly one of N concurrent processes wins the create each spin.
  local i=0
  while ! mkdir "$lock_dir" 2>/dev/null; do
    i=$((i+1))
    [ "$i" -gt 100 ] && break  # ~10s max wait (100 × 0.1s)
    python3 -c "import time; time.sleep(0.1)" 2>/dev/null || true
  done
  local current new over cnt
  current="$(_gen_spend_read "$acc_file")"
  over="$(python3 -c "print(1 if float('$current') + float('$unit_cost') > float('$cap') + 1e-9 else 0)" 2>/dev/null || echo 1)"
  if [ "$over" = "1" ]; then
    rmdir "$lock_dir" 2>/dev/null || true
    printf '%s' "$current"
    return 1
  fi
  # Fix D: count check inside the same lock
  cnt="$(_gen_spend_read "$count_file" | tr -d '[:space:]')"
  cnt="${cnt:-0}"
  if [ "$cnt" -ge "$max_gens" ] 2>/dev/null; then
    rmdir "$lock_dir" 2>/dev/null || true
    printf '%s' "$current"
    return 2
  fi
  new="$(python3 -c "print(round(float('$current') + float('$unit_cost'), 4))" 2>/dev/null || echo "")"
  if [ -z "$new" ]; then
    rmdir "$lock_dir" 2>/dev/null || true
    printf '%s' "$current"
    return 1
  fi
  printf '%s' "$new" > "$acc_file"
  # Increment count atomically (same lock window)
  local new_cnt=$(( cnt + 1 ))
  printf '%s' "$new_cnt" > "$count_file"
  rmdir "$lock_dir" 2>/dev/null || true
  printf '%s' "$new"
  return 0
}

# _gen_refund <acc_file> <unit_cost> <count_file>
#   Atomically subtract unit_cost from spend AND decrement count (used ONLY
#   when a reserved generation fails). Clamped at 0. Prints the new spend total.
#   Fix D: also refunds the count so a failed generation doesn't consume a slot.
#   Harden: verify the write succeeded via temp+rename; log if it fails so the
#   accumulator is never permanently inflated on write failure.
_gen_refund() {
  local acc_file="$1"
  local unit_cost="$2"
  local count_file="${3:-}"
  local lock_dir="${acc_file}.lock"

  _do_refund() {
    local current new cnt new_cnt
    current="$(_gen_spend_read "$acc_file")"
    new="$(python3 -c "v=round(float('$current') - float('$unit_cost'), 4); print(v if v > 0 else 0)" 2>/dev/null || echo "$current")"
    # Hardened write: write to temp then rename (atomic on POSIX)
    local tmp_acc; tmp_acc="${acc_file}.tmp.$$"
    if printf '%s' "$new" > "$tmp_acc" 2>/dev/null && mv "$tmp_acc" "$acc_file" 2>/dev/null; then
      : # spend refund succeeded
    else
      rm -f "$tmp_acc" 2>/dev/null || true
      printf '[generate] ERROR: _gen_refund failed to write acc_file %s — accumulator may be inflated\n' "$acc_file" >&2
    fi
    # Fix D: also decrement count file if provided
    if [ -n "$count_file" ] && [ -f "$count_file" ]; then
      cnt="$(_gen_spend_read "$count_file" | tr -d '[:space:]')"
      cnt="${cnt:-0}"
      new_cnt=$(( cnt > 0 ? cnt - 1 : 0 ))
      local tmp_cnt; tmp_cnt="${count_file}.tmp.$$"
      printf '%s' "$new_cnt" > "$tmp_cnt" 2>/dev/null && mv "$tmp_cnt" "$count_file" 2>/dev/null || \
        rm -f "$tmp_cnt" 2>/dev/null || true
    fi
    printf '%s' "$new"
  }

  if command -v flock >/dev/null 2>&1; then
    (
      flock -x 200
      _do_refund
    ) 200>"${acc_file}.flock"
    return $?
  fi

  local i=0
  while ! mkdir "$lock_dir" 2>/dev/null; do
    i=$((i+1))
    [ "$i" -gt 100 ] && break
    python3 -c "import time; time.sleep(0.1)" 2>/dev/null || true
  done
  _do_refund
  rmdir "$lock_dir" 2>/dev/null || true
  return 0
}

# ── _gen_veo3 — Veo 3 Fast video generation ──────────────────────────────────
_gen_veo3() {
  local prompt="$1"
  local api_key="$2"
  local out_dir="$3"

  # Veo 3 via Gemini API predict endpoint
  local payload
  payload="$(jq -n --arg prompt "$prompt" --arg model "$_VEO3_MODEL" '{
    instances: [{prompt: $prompt}],
    parameters: {
      aspectRatio: "9:16",
      durationSeconds: 8,
      includeAudio: true,
      model: $model
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

  # ── Combined spend+count reserve under a single lock ─────────────────────
  # Fix D: both the spend cap AND the per-pass count cap are enforced inside
  # ONE critical section (inside _gen_reserve).  No pre-lock count read is
  # performed — doing so would re-open the TOCTOU window under concurrency.
  # Generation (slow network call) runs OUTSIDE the lock, as before.
  local acc_file="$STATE_BASE/.gen-spend-$(date +%F)"
  local today_pass_count_file="$STATE_BASE/.gen-count-$(date +%F)"

  local new_spend reserve_rc
  new_spend="$(_gen_reserve "$acc_file" "$unit_cost" "$cap" "$today_pass_count_file" "$max_gens")"
  reserve_rc=$?

  if [ "$reserve_rc" = "2" ]; then
    # Count cap hit (return code 2 from _gen_reserve)
    local current_spend; current_spend="$(_gen_spend_read "$acc_file")"
    local pass_count; pass_count="$(_gen_spend_read "$today_pass_count_file" | tr -d '[:space:]')"
    _gen_log "per-pass count cap reached (${pass_count:-?}/${max_gens})"
    printf '{"generated":[],"spend_today":%s,"capped":true,"refused":true,"reason":"per_pass_count_cap_%s_of_%s"}\n' \
      "${current_spend:-0}" "${pass_count:-?}" "$max_gens"
    return 1
  fi

  if [ "$reserve_rc" -ne 0 ]; then
    _gen_log "daily gen spend cap reached (${new_spend} + ${unit_cost} > ${cap})"
    printf '{"generated":[],"spend_today":%s,"capped":true,"refused":true,"reason":"daily_gen_spend_cap_usd_%s_reached"}\n' \
      "${new_spend:-0}" "$cap"
    return 1
  fi
  # Spend AND count are now RESERVED inside the lock. Any early exit MUST refund both.

  # ── Generate (network call, OUTSIDE the lock) ─────────────────────────────
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
    # REFUND both spend and count — no API spend actually incurred on failure.
    # Fix D: _gen_refund now also decrements the count file atomically.
    local refunded_spend
    refunded_spend="$(_gen_refund "$acc_file" "$unit_cost" "$today_pass_count_file")"
    _gen_log "generation call failed — refunded \$${unit_cost} + count slot (spend now \$${refunded_spend})"
    printf '{"generated":[],"spend_today":%s,"capped":false,"refused":true,"reason":"generation_api_call_failed"}\n' \
      "${refunded_spend:-0}"
    return 1
  fi

  # Success: spend and count were already incremented inside _gen_reserve's lock.
  # No further count write needed here.

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
