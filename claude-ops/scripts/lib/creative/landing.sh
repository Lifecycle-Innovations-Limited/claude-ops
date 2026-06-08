#!/usr/bin/env bash
# creative/landing.sh — Landing-page hero copy variant generator.
#
# Source this lib, then call:
#   generate_landing_variants <project>
#
# Required prefs fields (hard-refuse if any absent or empty):
#   marketing.projects.<key>.brand.voice
#   marketing.projects.<key>.brand.product
#   marketing.projects.<key>.brand.target_persona
#   marketing.projects.<key>.source.url
#
# Optional:
#   marketing.projects.<key>.brand.name
#
# Output:
#   Persists 3 hero copy variants to:
#     ${OPS_DATA_DIR}/content/landing/<project>-<YYYY-MM-DD>.md
#   Prints a JSON manifest to stdout:
#     {"project":"...","date":"...","variants_file":"...","variants":[
#       {"id":1,"headline":"...","subhead":"...","cta":"..."},
#       ...
#     ]}
#
# CLI entry: bin/ops-content-landing <project>
#
# NEVER auto-publishes. All output is draft/staged only.
# NEVER generates when brand.voice is absent — no defaults.
#
# Does NOT set -e — callers source this; let them control failure semantics.

_landing_log() {
  printf '[landing] %s\n' "$1" >&2
}

# Only define resolve_cred / ap_get if not already present (avoids re-source conflicts)
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
    jq -r --arg p "$proj" ".marketing.projects[\$p]${path} // empty" "$PREFS" 2>/dev/null
  }
fi

if ! declare -f claude_invoke >/dev/null 2>&1; then
  _landing_lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  # shellcheck source=scripts/lib/claude-invoke.sh
  source "${_landing_lib_dir}/../claude-invoke.sh" 2>/dev/null || true
fi

# ── _landing_scrape_url — fetch page context via curl ───────────────────────
# In interactive Claude sessions, mcp__tavily__tavily_extract is preferred.
# In daemon/headless context, curl strips HTML tags and returns first 3000 chars.
_landing_scrape_url() {
  local url="$1"
  local content=""

  content="$(curl -gsS --max-time 20 -A "Mozilla/5.0" \
    -H "Accept: text/html,application/xhtml+xml" \
    "$url" 2>/dev/null \
    | sed 's/<[^>]*>//g' \
    | tr -s ' \t\n' ' ' \
    | cut -c1-3000 || true)"

  printf '%s' "$content"
}

# ── generate_landing_variants — main entrypoint ──────────────────────────────
generate_landing_variants() {
  local project="${1:-}"

  if [ -z "$project" ]; then
    _landing_log "ERROR: project argument required"
    printf '{"error":"missing_project_argument","refused":true}\n'
    return 1
  fi

  local PREFS="${OPS_AUTOPILOT_PREFS:-${OPS_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}/preferences.json}"

  if [ ! -f "$PREFS" ]; then
    _landing_log "ERROR: preferences file not found: $PREFS"
    printf '{"error":"prefs_not_found","refused":true}\n'
    return 1
  fi

  # ── Read required fields — hard-refuse on any absent/empty ───────────────
  local brand_voice brand_product target_persona source_url brand_name

  brand_voice="$(ap_get "$project" '.brand.voice')"
  brand_product="$(ap_get "$project" '.brand.product')"
  target_persona="$(ap_get "$project" '.brand.target_persona')"
  source_url="$(ap_get "$project" '.source.url')"
  brand_name="$(ap_get "$project" '.brand.name')"

  # Validate each required field
  local missing_fields=""
  [ -z "$brand_voice" ]     && missing_fields="${missing_fields} brand.voice"
  [ -z "$brand_product" ]   && missing_fields="${missing_fields} brand.product"
  [ -z "$target_persona" ]  && missing_fields="${missing_fields} brand.target_persona"
  [ -z "$source_url" ]      && missing_fields="${missing_fields} source.url"

  if [ -n "$missing_fields" ]; then
    _landing_log "ERROR: refusing — required fields missing for project '${project}':${missing_fields}"
    local missing_json
    missing_json="$(python3 -c "
import json, sys
fields = sys.argv[1].split()
print(json.dumps(fields))
" "$missing_fields" 2>/dev/null || printf '[]')"
    printf '{"error":"missing_required_fields","refused":true,"missing":%s}\n' "$missing_json"
    return 1
  fi

  brand_name="${brand_name:-<your-project>}"

  # ── Scrape source URL for context ─────────────────────────────────────────
  _landing_log "scraping source URL: $source_url"
  local page_context
  page_context="$(_landing_scrape_url "$source_url" 2>/dev/null || true)"
  local page_snippet="${page_context:0:1500}"

  # ── Output path setup ─────────────────────────────────────────────────────
  local DATA_DIR="${OPS_DATA_DIR:-$HOME/.claude/plugins/data/ops-ops-marketplace}"
  local OUT_DIR="${DATA_DIR}/content/landing"
  mkdir -p "$OUT_DIR"
  local date_str; date_str="$(date +%F)"
  local out_file="${OUT_DIR}/${project}-${date_str}.md"

  # ── Build prompt ──────────────────────────────────────────────────────────
  local system_prompt
  system_prompt="$(cat <<'SYSTEM'
<role>
You are a conversion-focused copywriter specializing in landing page hero sections.
</role>
<task>
Generate exactly 3 distinct landing-page hero copy variants for the product described below.
Each variant must contain:
- headline: 6-10 words, punchy, benefit-led
- subhead: 1-2 sentences expanding the promise of the headline (max 25 words)
- cta: 2-5 word call-to-action button text
</task>
<constraints>
- Use brand voice EXACTLY as specified. Do not substitute defaults or invent tone.
- Never reference competitors by name.
- Never use generic filler phrases ("best-in-class", "game-changing", "innovative").
- Output ONLY valid JSON. No markdown, no preamble, no explanation.
- If brand voice is missing or empty, output {"error":"missing_brand_voice"} and stop.
</constraints>
<output_format>
{"variants":[
  {"id":1,"headline":"...","subhead":"...","cta":"..."},
  {"id":2,"headline":"...","subhead":"...","cta":"..."},
  {"id":3,"headline":"...","subhead":"...","cta":"..."}
]}
</output_format>
SYSTEM
)"

  local user_prompt
  user_prompt="$(printf '<context>\nBrand name: %s\nBrand voice: %s\nProduct: %s\nTarget persona: %s\nSource URL: %s\nPage context (first 1500 chars scraped from source URL):\n%s\n</context>\n<input>\nGenerate 3 hero copy variants per the output_format above.\n</input>' \
    "$brand_name" "$brand_voice" "$brand_product" "$target_persona" "$source_url" "$page_snippet")"

  # ── Invoke Claude ─────────────────────────────────────────────────────────
  _landing_log "invoking claude for landing variants (project: $project)"

  local raw_output
  raw_output="$(claude_invoke \
    --model claude-haiku-4-5 \
    --no-session-persistence \
    -p "${system_prompt}
${user_prompt}" 2>/dev/null || echo '')"

  if [ -z "$raw_output" ]; then
    _landing_log "ERROR: claude_invoke returned empty output"
    printf '{"error":"claude_invoke_empty","refused":true}\n'
    return 1
  fi

  # Extract and validate JSON block from output
  local variants_json
  variants_json="$(printf '%s' "$raw_output" \
    | python3 -c "
import sys, re, json
text = sys.stdin.read()
m = re.search(r'(\{[\s\S]*\})', text)
if m:
    try:
        j = json.loads(m.group(1))
        print(json.dumps(j))
    except Exception:
        pass
" 2>/dev/null || true)"

  if [ -z "$variants_json" ] || ! printf '%s' "$variants_json" | jq -e '.variants' >/dev/null 2>&1; then
    _landing_log "ERROR: failed to parse variants JSON from claude output"
    printf '{"error":"parse_failed","refused":true,"raw_snippet":"%s"}\n' \
      "$(printf '%s' "$raw_output" | head -c 200 | tr '"' "'")"
    return 1
  fi

  # ── Persist to markdown ───────────────────────────────────────────────────
  {
    printf '# Landing variants — %s — %s\n\n' "$project" "$date_str"
    printf '**Brand voice:** %s\n' "$brand_voice"
    printf '**Product:** %s\n' "$brand_product"
    printf '**Target persona:** %s\n\n' "$target_persona"
    printf '%s\n\n' '---'
    printf '%s' "$variants_json" | jq -r '.variants[] | "## Variant \(.id)\n\n**Headline:** \(.headline)\n\n**Subhead:** \(.subhead)\n\n**CTA:** \(.cta)\n\n---\n"' 2>/dev/null || true
  } > "$out_file"

  _landing_log "variants saved to $out_file"

  # ── Return JSON manifest ──────────────────────────────────────────────────
  jq -n \
    --arg project "$project" \
    --arg date "$date_str" \
    --arg file "$out_file" \
    --argjson variants "$(printf '%s' "$variants_json" | jq '.variants' 2>/dev/null || echo '[]')" \
    '{project: $project, date: $date, variants_file: $file, variants: $variants}' 2>/dev/null \
  || printf '{"project":"%s","date":"%s","variants_file":"%s","variants":[]}\n' \
       "$project" "$date_str" "$out_file"
}
