#!/usr/bin/env bash
# creative/judge.sh — Tier 2 LLM verdict gate for ad creatives.
#
# Source this lib (after analyze.sh — reuses extract_json), then call:
#   creative_judge <analyze_json> <live_context_json>
#
# analyze_json: output of creative_analyze (tier1)
# live_context_json: array of live creative objects for ranking
#   e.g. [{"ad_id":"x","tier2":{"prior":72}}, ...]
#
# Prints ONE JSON:
#   {"verdict":"PASS|BLOCK|REVISE","prior":0-100,"rank":N|null,
#    "hard_block":bool,"reasons":["..."]}
#
# HARD BLOCK (deterministic in shell, BEFORE LLM call) when:
#   - visual.hallucination == true  → hallucination in creative
#   - copy.compliance == "fail"     → ad-platform policy violation
# These gates are enforced deterministically; the LLM cannot override them.
#
# Depends on analyze.sh for extract_json and claude_invoke.
#
# Don't `set -e` — callers source this; let them control failure semantics.

_judge_log() {
  printf '[judge] %s\n' "$1" >&2
}

# Source analyze.sh for extract_json and resolve_cred (idempotent guard)
_JUDGE_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -z "${_CREATIVE_ANALYZE_LOADED:-}" ]; then
  # shellcheck disable=SC1090
  . "$_JUDGE_SCRIPT_DIR/analyze.sh" 2>/dev/null || true
  _CREATIVE_ANALYZE_LOADED=1
fi

# ── creative_judge — main entrypoint ─────────────────────────────────────────
creative_judge() {
  local analyze_json="${1:-{}}"
  local live_context_json="${2:-[]}"

  # ── Deterministic hard-block checks (BEFORE LLM, non-negotiable) ─────────
  local hallucination compliance
  hallucination="$(printf '%s' "$analyze_json" | jq -r '.visual.hallucination // false' 2>/dev/null || echo 'false')"
  compliance="$(printf '%s' "$analyze_json" | jq -r '.copy.compliance // "pass"' 2>/dev/null || echo 'pass')"

  if [ "$hallucination" = "true" ]; then
    _judge_log "HARD BLOCK: hallucination detected in visual analysis"
    printf '{"verdict":"BLOCK","prior":0,"rank":null,"hard_block":true,"reasons":["hallucination_detected_in_visual"]}\n'
    return 0
  fi

  if [ "$compliance" = "fail" ]; then
    _judge_log "HARD BLOCK: copy.compliance=fail (ad-platform policy violation)"
    printf '{"verdict":"BLOCK","prior":0,"rank":null,"hard_block":true,"reasons":["copy_compliance_fail_ad_policy_violation"]}\n'
    return 0
  fi

  # ── LLM verdict via claude_invoke Opus 4.7 ──────────────────────────────
  local live_count
  live_count="$(printf '%s' "$live_context_json" | jq 'length' 2>/dev/null || echo 0)"

  local prompt
  prompt="$(cat <<PROMPT
You are an expert ad creative quality judge for a health/wellness brand.
You have already passed the hard-block safety checks (no hallucination, no policy fail).

Analyze the following creative scoring data and live context, then return a quality verdict.

CREATIVE ANALYSIS:
${analyze_json}

LIVE CREATIVE CONTEXT (${live_count} live creatives for ranking):
${live_context_json}

Return ONLY a JSON object with these exact keys:
- verdict: "PASS" (ready to deploy), "REVISE" (needs improvement before deploy), or "BLOCK" (quality too low)
- prior: integer 0-100 quality prior score
    90-100: exceptional, deploy immediately
    70-89:  good, PASS
    50-69:  mediocre, REVISE
    0-49:   poor, BLOCK
- rank: integer rank vs live creatives (1=best), or null if no live context
- hard_block: always false (you cannot override shell hard-block; this field documents LLM-initiated blocks)
- reasons: array of 1-3 concise reason strings explaining the verdict

Scoring guidance:
- Weight visual.hook (30%), visual.scroll_stop (20%), copy.compliance (20%),
  visual.legibility (15%), copy.clarity (15%).
- A "risk" compliance adds -10 to prior.
- cpl_risk "high" adds -5 to prior.
- brand_safety < 7 forces verdict to BLOCK.

Return ONLY the JSON object, no other text.
PROMPT
)"

  local raw
  raw="$(claude_invoke -p "$prompt" --model "claude-opus-4-7" --no-session-persistence --output-format json 2>/dev/null || true)"

  _judge_retry_llm() {
    claude_invoke -p "$prompt" --model "claude-opus-4-7" --no-session-persistence --output-format json 2>/dev/null || true
  }

  local parsed
  parsed="$(extract_json "$raw" "_judge_retry_llm")"

  if [ -z "$parsed" ] || [ "$parsed" = "{}" ]; then
    _judge_log "LLM verdict failed — defaulting to REVISE"
    printf '{"verdict":"REVISE","prior":50,"rank":null,"hard_block":false,"reasons":["llm_verdict_unavailable"]}\n'
    return 0
  fi

  # Normalize output — ensure hard_block is always false here (hard blocks already returned above)
  printf '%s' "$parsed" | jq '{
    verdict: (.verdict // "REVISE"),
    prior: (.prior // 50),
    rank: (.rank // null),
    hard_block: false,
    reasons: (.reasons // ["no_reasons_provided"])
  }' 2>/dev/null \
  || printf '{"verdict":"REVISE","prior":50,"rank":null,"hard_block":false,"reasons":["json_normalize_error"]}\n'
}
