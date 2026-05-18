#!/usr/bin/env bash
# creative/analyze.sh — Tier 1 multimodal quality scoring for ad creatives.
#
# Source this lib, then call:
#   creative_analyze <asset_path> <copy_text> <models_json>
#
# models_json example:
#   '{"multimodal":"gemini-2.0-flash","judge":"claude-opus-4-7",
#     "image":"gemini-2.0-flash","api_key_ref":"env:GEMINI_API_KEY"}'
#
# Prints ONE JSON:
#   {"visual":{hook,pacing,legibility,hallucination,cta,brand_safety,scroll_stop},
#    "copy":{hook,clarity,compliance,cpl_risk},"neurons":null|{...}}
#
# Video → Gemini multimodal REST call (native video+audio).
# Image → Gemini vision call.
# Copy  → claude_invoke Opus 4.7, health-claim & ad-platform-policy compliance.
# Neurons → calls creative_neurons from neurons.sh if enabled in models_json.
#
# extract_json() helper exported here for reuse by judge.sh:
#   Greps last {...} JSON block from mixed stdout, validates with jq -e.
#   On parse failure retries via a passed retry closure ($1=retry_fn).
#   If retry also fails returns {}.
#
# CAVEAT: the .mjs claude wrapper sometimes emits non-JSON lines (ANSI, progress
# text) before the JSON result line. extract_json strips those via jq slurp.
#
# Don't `set -e` — callers source this; let them control failure semantics.

# Resolve registry-path so PLUGIN_ROOT is available when needed for claude-invoke.
OPS_DATA_DIR="${OPS_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}"
_ANALYZE_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_ANALYZE_PLUGIN_ROOT="${PLUGIN_ROOT:-$(cd "$_ANALYZE_SCRIPT_DIR/../../.." && pwd)}"

# Source claude-invoke once (idempotent guard)
if [ -z "${_CLAUDE_INVOKE_LOADED:-}" ]; then
  # shellcheck disable=SC1090
  . "$_ANALYZE_PLUGIN_ROOT/scripts/lib/claude-invoke.sh" 2>/dev/null || true
  _CLAUDE_INVOKE_LOADED=1
fi

# Source neurons lib (idempotent guard)
_CREATIVE_NEURONS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -z "${_CREATIVE_NEURONS_LOADED:-}" ]; then
  # shellcheck disable=SC1090
  . "$_CREATIVE_NEURONS_DIR/neurons.sh" 2>/dev/null || true
  _CREATIVE_NEURONS_LOADED=1
fi

_analyze_log() {
  printf '[analyze] %s\n' "$1" >&2
}

# ── resolve_cred (mirrored from bin/ops-marketing-autopilot) ─────────────────
# Only define if not already defined by the bin sourcing us.
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

# ── extract_json — shared helper (exported; judge.sh sources analyze.sh) ─────
# Usage: extract_json <raw_output> [retry_fn_name]
# retry_fn_name: name of a shell function to call (no args) that produces new raw output.
extract_json() {
  local raw="$1"
  local retry_fn="${2:-}"

  # Try to extract last JSON object from mixed output
  local parsed
  parsed="$(printf '%s' "$raw" | grep -o '{[^{}]*\({\([^{}]*\)*}[^{}]*\)*}' 2>/dev/null | tail -1 || true)"
  if [ -z "$parsed" ]; then
    # Fallback: try jq slurp on entire output to find any valid JSON object
    parsed="$(printf '%s' "$raw" | jq -Rs 'split("\n") | map(select(startswith("{")) | . as $l | try ($l | fromjson)) | last // empty' 2>/dev/null || true)"
  fi

  if printf '%s' "$parsed" | jq -e '.' >/dev/null 2>&1; then
    printf '%s' "$parsed"
    return 0
  fi

  # Retry once if a retry function is provided
  if [ -n "$retry_fn" ] && declare -f "$retry_fn" >/dev/null 2>&1; then
    _analyze_log "extract_json: parse failed, retrying via $retry_fn"
    local raw2
    raw2="$("$retry_fn")"
    parsed="$(printf '%s' "$raw2" | grep -o '{[^{}]*\({\([^{}]*\)*}[^{}]*\)*}' 2>/dev/null | tail -1 || true)"
    if printf '%s' "$parsed" | jq -e '.' >/dev/null 2>&1; then
      printf '%s' "$parsed"
      return 0
    fi
  fi

  printf '{}'
  return 1
}

# ── _gemini_vision_ocr — Gemini Flash vision OCR fallback ────────────────────
# Used when tesseract is absent (tier0 sets ocr_text:"", degraded:["tesseract"]).
# analyze.sh callers can invoke this to get OCR text for re-evaluation.
# Returns plain text on stdout.
_gemini_vision_ocr() {
  local image_path="$1"
  local api_key="${2:-}"

  [ -z "$api_key" ] && { _analyze_log "_gemini_vision_ocr: no api_key"; printf ''; return 1; }
  [ ! -f "$image_path" ] && { _analyze_log "_gemini_vision_ocr: file not found: $image_path"; printf ''; return 1; }

  # Base64-encode the image
  local b64 mime_type
  local ext="${image_path##*.}"
  ext="$(printf '%s' "$ext" | tr '[:upper:]' '[:lower:]')"
  case "$ext" in
    jpg|jpeg) mime_type="image/jpeg" ;;
    png)      mime_type="image/png" ;;
    webp)     mime_type="image/webp" ;;
    gif)      mime_type="image/gif" ;;
    *)        mime_type="image/jpeg" ;;
  esac

  b64="$(base64 < "$image_path" | tr -d '\n')"

  local payload
  payload="$(jq -n \
    --arg b64 "$b64" \
    --arg mime "$mime_type" \
    '{contents:[{parts:[
      {inline_data:{mime_type:$mime,data:$b64}},
      {text:"Extract all visible text from this image exactly as it appears. Return only the raw text, no commentary."}
    ]}]}')"

  local model="gemini-2.0-flash"
  local resp
  resp="$(curl -gsS --max-time 20 \
    -X POST "https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${api_key}" \
    -H 'Content-Type: application/json' \
    -d "$payload" 2>/dev/null || echo '{}')"

  printf '%s' "$resp" | jq -r '.candidates[0].content.parts[0].text // ""' 2>/dev/null || printf ''
}

# ── _gemini_multimodal_score — video or image scoring call ───────────────────
_gemini_multimodal_score() {
  local asset_path="$1"
  local asset_type="$2"
  local model="$3"
  local api_key="$4"

  local prompt='You are an expert social media ad creative analyst. Score this ad creative on these dimensions (each 0-10 integer, where 10 is best):
- hook: How compelling is the first 3 seconds / visual hook?
- pacing: Is pacing appropriate for the platform (Reels/Stories)?
- legibility: Is all on-screen text legible and well-positioned?
- hallucination: Are any claims, logos, text, or visuals inaccurate/fabricated? (true/false)
- cta: How clear and compelling is the call-to-action?
- brand_safety: Is the content brand-safe for mainstream ad platforms? (0-10)
- scroll_stop: How likely is this to stop a user mid-scroll? (0-10)

Return ONLY a JSON object with these exact keys. Example:
{"hook":7,"pacing":8,"legibility":9,"hallucination":false,"cta":6,"brand_safety":10,"scroll_stop":8}'

  local payload resp
  if [ "$asset_type" = "video" ]; then
    # Upload video via File API for multimodal (inline base64 too large for video)
    # For short clips use inline base64; large files need Files API.
    # We use inline for <20MB, Files API note in header for larger.
    local filesize
    filesize="$(wc -c < "$asset_path" 2>/dev/null || echo 0)"
    local MAX_INLINE=$((20 * 1024 * 1024))

    if [ "$filesize" -lt "$MAX_INLINE" ]; then
      local b64 mime_type="video/mp4"
      local vext="${asset_path##*.}"
      vext="$(printf '%s' "$vext" | tr '[:upper:]' '[:lower:]')"
      [ "$vext" = "mov" ] && mime_type="video/quicktime"
      b64="$(base64 < "$asset_path" | tr -d '\n')"
      payload="$(jq -n \
        --arg b64 "$b64" \
        --arg mime "$mime_type" \
        --arg prompt "$prompt" \
        '{contents:[{parts:[
          {inline_data:{mime_type:$mime,data:$b64}},
          {text:$prompt}
        ]}],
        generationConfig:{temperature:0.1,responseMimeType:"application/json"}}')"
    else
      # Too large for inline: degrade to text-only scoring with note
      _analyze_log "video too large for inline Gemini call (${filesize}B) — scoring degraded"
      payload="$(jq -n \
        --arg prompt "$prompt" \
        '{contents:[{parts:[{text:("VIDEO_TOO_LARGE_FOR_INLINE_ANALYSIS. " + $prompt)}]}],
        generationConfig:{temperature:0.1,responseMimeType:"application/json"}}')"
    fi
  else
    # Image: inline base64
    local b64 mime_type="image/jpeg"
    local iext="${asset_path##*.}"
    iext="$(printf '%s' "$iext" | tr '[:upper:]' '[:lower:]')"
    case "$iext" in png) mime_type="image/png";; webp) mime_type="image/webp";; esac
    b64="$(base64 < "$asset_path" | tr -d '\n')"
    payload="$(jq -n \
      --arg b64 "$b64" \
      --arg mime "$mime_type" \
      --arg prompt "$prompt" \
      '{contents:[{parts:[
        {inline_data:{mime_type:$mime,data:$b64}},
        {text:$prompt}
      ]}],
      generationConfig:{temperature:0.1,responseMimeType:"application/json"}}')"
  fi

  resp="$(curl -gsS --max-time 45 \
    -X POST "https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${api_key}" \
    -H 'Content-Type: application/json' \
    -d "$payload" 2>/dev/null || echo '{}')"

  local raw_text
  raw_text="$(printf '%s' "$resp" | jq -r '.candidates[0].content.parts[0].text // ""' 2>/dev/null || echo '')"
  printf '%s' "$raw_text"
}

# ── _claude_copy_score — Opus 4.7 copy analysis ──────────────────────────────
_claude_copy_score() {
  local copy_text="$1"
  local model="${2:-claude-opus-4-7}"

  local prompt
  prompt="$(cat <<PROMPT
You are an expert ad copy analyst specializing in health & wellness advertising compliance.
Analyze the following ad copy and return ONLY a JSON object with these exact keys:

copy_text: ${copy_text}

Score each dimension:
- hook (0-10): How compelling is the opening hook?
- clarity (0-10): How clear and understandable is the message?
- compliance ("pass"|"risk"|"fail"):
    "fail" = explicit health claims violating FTC/FDA/Meta health ad policies
             (e.g., "cures disease", "guaranteed weight loss", before/after claims),
             OR claims that would trigger ad platform rejection.
    "risk" = borderline claims needing review (e.g., "clinically inspired", "doctor-approved").
    "pass" = compliant copy with no red flags.
- cpl_risk ("low"|"med"|"high"):
    Predicted cost-per-lead risk based on copy quality and targeting signal clarity.
    "high" = vague, low-urgency, or non-specific copy likely to produce high CPL.
    "med"  = adequate but improvable.
    "low"  = sharp, targeted, clear CTA likely to produce efficient CPL.

Return ONLY this JSON, no other text:
{"hook":N,"clarity":N,"compliance":"pass|risk|fail","cpl_risk":"low|med|high"}
PROMPT
)"

  local raw
  raw="$(claude_invoke -p "$prompt" --model "$model" --no-session-persistence --output-format json 2>/dev/null || true)"
  printf '%s' "$raw"
}

# ── creative_analyze — main entrypoint ───────────────────────────────────────
creative_analyze() {
  local asset_path="$1"
  local copy_text="${2:-}"
  local models_json="${3:-{}}"

  # Parse models config
  local multimodal_model image_model judge_model api_key_ref
  multimodal_model="$(printf '%s' "$models_json" | jq -r '.multimodal // "gemini-2.0-flash"' 2>/dev/null)"
  image_model="$(printf '%s' "$models_json" | jq -r '.image // "gemini-2.0-flash"' 2>/dev/null)"
  judge_model="$(printf '%s' "$models_json" | jq -r '.judge // "claude-opus-4-7"' 2>/dev/null)"
  api_key_ref="$(printf '%s' "$models_json" | jq -r '.api_key_ref // "env:GEMINI_API_KEY"' 2>/dev/null)"

  local gemini_key
  gemini_key="$(resolve_cred "$api_key_ref")"

  # Determine asset type
  local asset_type="unknown"
  local ext="${asset_path##*.}"
  ext="$(printf '%s' "$ext" | tr '[:upper:]' '[:lower:]')"
  case "$ext" in
    mp4|mov|avi|mkv|webm|m4v) asset_type="video" ;;
    jpg|jpeg|png|gif|webp|heic|bmp|tiff|tif) asset_type="image" ;;
  esac

  # Select model based on asset type
  local gemini_model
  [ "$asset_type" = "video" ] && gemini_model="$multimodal_model" || gemini_model="$image_model"

  # ── Gemini visual score ──────────────────────────────────────────────────
  local visual_json='{"hook":5,"pacing":5,"legibility":5,"hallucination":false,"cta":5,"brand_safety":8,"scroll_stop":5}'
  if [ -n "$gemini_key" ] && [ -f "$asset_path" ]; then
    local _gemini_raw
    _gemini_raw="$(_gemini_multimodal_score "$asset_path" "$asset_type" "$gemini_model" "$gemini_key")"

    # Retry closure for extract_json
    _analyze_retry_visual() {
      _gemini_multimodal_score "$asset_path" "$asset_type" "$gemini_model" "$gemini_key"
    }

    local _visual_parsed
    _visual_parsed="$(extract_json "$_gemini_raw" "_analyze_retry_visual")"
    if [ -n "$_visual_parsed" ] && [ "$_visual_parsed" != "{}" ]; then
      visual_json="$_visual_parsed"
    fi
  else
    [ -z "$gemini_key" ] && _analyze_log "no Gemini API key — visual scoring skipped"
  fi

  # Normalize visual fields with defaults
  visual_json="$(printf '%s' "$visual_json" | jq '{
    hook: (.hook // 5),
    pacing: (.pacing // 5),
    legibility: (.legibility // 5),
    hallucination: (.hallucination // false),
    cta: (.cta // 5),
    brand_safety: (.brand_safety // 8),
    scroll_stop: (.scroll_stop // 5)
  }' 2>/dev/null || echo '{"hook":5,"pacing":5,"legibility":5,"hallucination":false,"cta":5,"brand_safety":8,"scroll_stop":5}')"

  # ── Claude copy score ─────────────────────────────────────────────────────
  local copy_json='{"hook":5,"clarity":5,"compliance":"pass","cpl_risk":"med"}'
  if [ -n "$copy_text" ]; then
    local _copy_raw
    _copy_raw="$(_claude_copy_score "$copy_text" "$judge_model")"

    _analyze_retry_copy() {
      _claude_copy_score "$copy_text" "$judge_model"
    }

    local _copy_parsed
    _copy_parsed="$(extract_json "$_copy_raw" "_analyze_retry_copy")"
    if [ -n "$_copy_parsed" ] && [ "$_copy_parsed" != "{}" ]; then
      copy_json="$_copy_parsed"
    fi
  fi

  # Normalize copy fields
  copy_json="$(printf '%s' "$copy_json" | jq '{
    hook: (.hook // 5),
    clarity: (.clarity // 5),
    compliance: (.compliance // "pass"),
    cpl_risk: (.cpl_risk // "med")
  }' 2>/dev/null || echo '{"hook":5,"clarity":5,"compliance":"pass","cpl_risk":"med"}')"

  # ── Neurons (optional) ────────────────────────────────────────────────────
  local neurons_json="null"
  local neurons_enabled
  neurons_enabled="$(printf '%s' "$models_json" | jq -r '.neurons.enabled // false' 2>/dev/null)"
  if [ "$neurons_enabled" = "true" ] && declare -f creative_neurons >/dev/null 2>&1; then
    local _n_raw
    _n_raw="$(creative_neurons "$asset_path" 2>/dev/null || echo '{}')"
    # Only embed if non-empty object
    if [ -n "$_n_raw" ] && [ "$_n_raw" != "{}" ] && printf '%s' "$_n_raw" | jq -e 'keys | length > 0' >/dev/null 2>&1; then
      neurons_json="$_n_raw"
    fi
  fi

  # ── Assemble output ───────────────────────────────────────────────────────
  jq -n \
    --argjson visual "$visual_json" \
    --argjson copy "$copy_json" \
    --argjson neurons "${neurons_json:-null}" \
    '{visual:$visual,copy:$copy,neurons:$neurons}' 2>/dev/null \
  || printf '{"visual":{"hook":5,"pacing":5,"legibility":5,"hallucination":false,"cta":5,"brand_safety":8,"scroll_stop":5},"copy":{"hook":5,"clarity":5,"compliance":"pass","cpl_risk":"med"},"neurons":null}\n'
}
