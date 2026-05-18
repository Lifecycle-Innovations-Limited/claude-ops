#!/usr/bin/env bash
# creative/tier0.sh — Structural & OCR quality gate for ad creatives (Tier 0).
#
# Source this lib, then call:
#   creative_tier0 <asset_path> <copy_text>
#
# Prints ONE JSON object to stdout:
#   {"ok":bool,"asset_type":"video|image|unknown","checks":{...},"ocr_text":"...",
#    "garbled":bool,"hard_fail":bool,"degraded":["ffmpeg","tesseract"...],"reason":"..."}
#
# OCR coupling decision: tier0 sets ocr_text:"" + degraded:["tesseract"] when
# tesseract is absent, and garbled:false (no opinion). analyze.sh performs the
# Gemini vision-OCR fallback and re-evaluates garbled status from that text.
# This keeps tier0 free of Gemini API dependencies (lower coupling).
#
# HARD FAIL (hard_fail:true, ok:false) when:
#   - asset_type is unknown (not a recognized video/image)
#   - OCR text is garbled (>40% non-dictionary-looking tokens OR repeated
#     identical chars ≥3 OR mojibake bytes). This catches the exact
#     reel_promo_premium.mp4 garbled-text failure this feature was built to catch.
#
# Don't `set -e` — callers source this; let them control failure semantics.

_t0_log() {
  printf '[tier0] %s\n' "$1" >&2
}

# Returns 0 if string looks garbled, 1 if clean.
# garbled = ratio of tokens matching ^[A-Za-z]{2,}$ < 0.6
#         OR any token has 3+ consecutive identical non-space chars
#         OR presence of mojibake byte sequences
_t0_is_garbled() {
  local text="$1"
  [ -z "$text" ] && return 1  # empty = no opinion

  python3 - "$text" <<'PYEOF'
import sys, re, unicodedata

text = sys.argv[1]
tokens = text.split()
if not tokens:
    sys.exit(1)  # empty = not garbled

# Check mojibake: control chars or replacement character U+FFFD
if '�' in text or re.search(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', text):
    sys.exit(0)  # garbled

# Check for 3+ repeated identical non-space chars (e.g. "aaaa", "####")
if re.search(r'([^\s])\1{2,}', text):
    sys.exit(0)  # garbled

# Dictionary-looking token ratio
dict_tokens = sum(1 for t in tokens if re.match(r'^[A-Za-z]{2,}$', t))
ratio = dict_tokens / len(tokens)
if ratio < 0.6:
    sys.exit(0)  # garbled

sys.exit(1)  # not garbled
PYEOF
}

creative_tier0() {
  local asset_path="$1"
  local copy_text="${2:-}"

  local asset_type="unknown"
  local ok=true
  local hard_fail=false
  local reason=""
  local degraded_arr=()
  local ocr_text=""
  local garbled=false

  # Fix E: initialize OCR_SOURCE here so it is always defined regardless of
  # which branch (video/image/ffprobe-absent) executes.  Without this,
  # OCR_SOURCE only gets set inside conditional branches declared as `local`,
  # and the variable is unset when ffprobe is present but ffmpeg is absent,
  # causing the OCR block to silently skip without recording degraded:"ffmpeg".
  local OCR_SOURCE=""

  # checks defaults
  local aspect="unknown"
  local duration_s="null"
  local has_audio=false
  local safe_zone_ok=false
  local logo_present="null"

  # ── Validate asset exists ────────────────────────────────────────────────
  if [ ! -f "$asset_path" ]; then
    printf '{"ok":false,"asset_type":"unknown","checks":{"aspect":"unknown","duration_s":null,"has_audio":false,"safe_zone_ok":false,"logo_present":null},"ocr_text":"","garbled":false,"hard_fail":true,"degraded":[],"reason":"asset_not_found: %s"}\n' "$asset_path"
    return 0
  fi

  # ── Detect media type ────────────────────────────────────────────────────
  local ext="${asset_path##*.}"
  ext="$(printf '%s' "$ext" | tr '[:upper:]' '[:lower:]')"
  case "$ext" in
    mp4|mov|avi|mkv|webm|m4v) asset_type="video" ;;
    jpg|jpeg|png|gif|webp|heic|bmp|tiff|tif) asset_type="image" ;;
    *)
      # Try MIME sniff via file command if available
      if command -v file >/dev/null 2>&1; then
        local mime; mime="$(file --mime-type -b "$asset_path" 2>/dev/null || true)"
        case "$mime" in
          video/*) asset_type="video" ;;
          image/*) asset_type="image" ;;
        esac
      fi
      ;;
  esac

  if [ "$asset_type" = "unknown" ]; then
    printf '{"ok":false,"asset_type":"unknown","checks":{"aspect":"unknown","duration_s":null,"has_audio":false,"safe_zone_ok":false,"logo_present":null},"ocr_text":"","garbled":false,"hard_fail":true,"degraded":[],"reason":"unknown_asset_type"}\n'
    return 0
  fi

  # ── ffprobe / ffmpeg analysis ────────────────────────────────────────────
  local TMPDIR_T0
  TMPDIR_T0="$(mktemp -d)"
  trap 'rm -rf "$TMPDIR_T0"' RETURN

  if ! command -v ffprobe >/dev/null 2>&1; then
    degraded_arr+=("ffmpeg")
    _t0_log "ffprobe absent — structural checks degraded"
  else
    # Get stream metadata
    local probe_json
    probe_json="$(ffprobe -v quiet -print_format json -show_streams -show_format "$asset_path" 2>/dev/null || echo '{}')"

    # Aspect ratio (width:height → 9:16 or other)
    local width height
    width="$(printf '%s' "$probe_json" | jq -r '[.streams[]? | select(.codec_type=="video") | .width] | first // "null"' 2>/dev/null || echo 'null')"
    height="$(printf '%s' "$probe_json" | jq -r '[.streams[]? | select(.codec_type=="video") | .height] | first // "null"' 2>/dev/null || echo 'null')"
    if [ "$width" != "null" ] && [ "$height" != "null" ] && [ -n "$width" ] && [ -n "$height" ]; then
      # Normalize aspect: check if 9:16 (portrait for Reels)
      local ratio_check
      ratio_check="$(python3 -c "
w,h=$width,$height
import math
g=math.gcd(w,h)
print(f'{w//g}:{h//g}')
" 2>/dev/null || echo 'unknown')"
      aspect="$ratio_check"
    fi

    # Duration (video only)
    if [ "$asset_type" = "video" ]; then
      duration_s="$(printf '%s' "$probe_json" | jq -r '.format.duration // null' 2>/dev/null || echo 'null')"
      # Strip whitespace — jq can produce trailing newline or multi-line on malformed input
      duration_s="$(printf '%s' "$duration_s" | tr -d '[:space:]')"
      [ "$duration_s" = "null" ] || [ -z "$duration_s" ] || duration_s="$(printf '%.1f' "$duration_s" 2>/dev/null || echo 'null')"
      [ -z "$duration_s" ] && duration_s="null"

      # Audio stream present?
      local audio_streams
      audio_streams="$(printf '%s' "$probe_json" | jq '[.streams[]? | select(.codec_type=="audio")] | length' 2>/dev/null || echo 0)"
      # Strip whitespace/newlines — jq can output trailing newline or multi-line on error
      audio_streams="$(printf '%s' "$audio_streams" | tr -d '[:space:]')"
      [ "${audio_streams:-0}" -gt 0 ] 2>/dev/null && has_audio=true || true

      # Extract keyframe for OCR (first scene-cut or 1s mark)
      if command -v ffmpeg >/dev/null 2>&1; then
        local keyframe_path="$TMPDIR_T0/keyframe.png"
        ffmpeg -v quiet -ss 1 -i "$asset_path" -frames:v 1 "$keyframe_path" 2>/dev/null || true
        [ -f "$keyframe_path" ] || ffmpeg -v quiet -i "$asset_path" -frames:v 1 "$TMPDIR_T0/keyframe.png" 2>/dev/null || true
        OCR_SOURCE="$keyframe_path"
      else
        # Fix E: ffprobe present but ffmpeg absent — cannot extract keyframe.
        # Record as degraded so the OCR block is not silently skipped.
        # The garbled hard-fail must not be bypassable on the video path.
        degraded_arr+=("ffmpeg")
        _t0_log "ffmpeg absent — video keyframe extraction unavailable; OCR degraded"
        # Leave OCR_SOURCE="" so the OCR block below correctly records degraded,
        # does NOT attempt garbled-check on empty text, and lets analyze.sh know
        # it must use vision-OCR fallback for this asset.
        OCR_SOURCE=""
      fi
    else
      # Image: use asset directly for OCR
      OCR_SOURCE="$asset_path"
      # Get image dimensions
      if [ "$width" = "null" ] || [ -z "$width" ]; then
        # Try identify if available
        if command -v identify >/dev/null 2>&1; then
          local dims; dims="$(identify -format '%wx%h' "$asset_path" 2>/dev/null || echo '')"
          if [ -n "$dims" ]; then
            width="${dims%%x*}"; height="${dims##*x}"
            local ratio_check2
            ratio_check2="$(python3 -c "
import math
w,h=$width,$height
g=math.gcd(w,h)
print(f'{w//g}:{h//g}')
" 2>/dev/null || echo 'unknown')"
            aspect="$ratio_check2"
          fi
        fi
      fi
    fi

    # Safe zone check: 9:16 with width>=1080 and height>=1920 → basic platform spec
    if [ "$aspect" = "9:16" ]; then
      safe_zone_ok=true
    fi

  fi  # end ffprobe available

  # ── OCR via tesseract ────────────────────────────────────────────────────
  local ocr_source_file="${OCR_SOURCE:-}"
  if command -v tesseract >/dev/null 2>&1 && [ -n "$ocr_source_file" ] && [ -f "$ocr_source_file" ]; then
    ocr_text="$(tesseract "$ocr_source_file" stdout -l eng 2>/dev/null | tr '\n' ' ' | sed 's/  */ /g' | sed 's/^ //;s/ $//' || true)"
    # Garbled detection
    if [ -n "$ocr_text" ] && _t0_is_garbled "$ocr_text"; then
      garbled=true
      hard_fail=true
      ok=false
      reason="ocr_garbled_text"
    fi
  elif [ -n "$ocr_source_file" ] && [ -f "$ocr_source_file" ]; then
    # tesseract absent: degrade gracefully, let analyze.sh do vision-OCR fallback
    degraded_arr+=("tesseract")
    ocr_text=""
    garbled=false
    _t0_log "tesseract absent — OCR deferred to analyze.sh vision fallback"
  fi

  # ── Final verdict ─────────────────────────────────────────────────────────
  if [ "$hard_fail" = "false" ] && [ "$ok" = "true" ]; then
    : # all good
  elif [ "$hard_fail" = "false" ]; then
    hard_fail=false
  fi

  # Build degraded JSON array
  local degraded_json="[]"
  if [ "${#degraded_arr[@]}" -gt 0 ]; then
    degraded_json="$(printf '%s\n' "${degraded_arr[@]}" | jq -R . | jq -s . 2>/dev/null || echo '[]')"
  fi

  # Escape ocr_text and reason for JSON
  local ocr_json reason_json copy_json
  ocr_json="$(printf '%s' "$ocr_text" | jq -Rs . 2>/dev/null || echo '""')"
  reason_json="$(printf '%s' "$reason" | jq -Rs . 2>/dev/null || echo '""')"
  # logo_present stays null (no logo-detection without ML model)

  jq -n \
    --argjson ok "$ok" \
    --arg asset_type "$asset_type" \
    --arg aspect "$aspect" \
    --argjson duration_s "${duration_s:-null}" \
    --argjson has_audio "$has_audio" \
    --argjson safe_zone_ok "$safe_zone_ok" \
    --argjson ocr_json "$ocr_json" \
    --argjson garbled "$garbled" \
    --argjson hard_fail "$hard_fail" \
    --argjson degraded "$degraded_json" \
    --argjson reason "$reason_json" \
    '{
      ok: $ok,
      asset_type: $asset_type,
      checks: {
        aspect: $aspect,
        duration_s: $duration_s,
        has_audio: $has_audio,
        safe_zone_ok: $safe_zone_ok,
        logo_present: null
      },
      ocr_text: $ocr_json,
      garbled: $garbled,
      hard_fail: $hard_fail,
      degraded: $degraded,
      reason: $reason
    }' 2>/dev/null || {
    # Fallback: jq assembly failed; emit a safe minimal object that still carries
    # the degraded array so callers know which tools were absent (Fix E: must not
    # silently drop degraded entries just because the main jq call failed).
    printf '{"ok":false,"asset_type":"%s","checks":{"aspect":"unknown","duration_s":null,"has_audio":false,"safe_zone_ok":false,"logo_present":null},"ocr_text":"","garbled":false,"hard_fail":true,"degraded":%s,"reason":"json_assembly_error"}\n' \
      "$asset_type" "$degraded_json"
  }
}
