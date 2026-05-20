#!/usr/bin/env bash
# scripts/lib/marketing-kpis.sh — Pure-bash KPI computation
#
# Source-able library. No external API calls. All functions:
#   kpi_roas <spend> <revenue>
#   kpi_cac <spend> <new_customers>
#   kpi_ltv <aov> <repeat_purchase_rate> <gross_margin>
#   kpi_payback_months <cac> <mrr>
#   kpi_cvr <conversions> <sessions>
#   kpi_ctr <clicks> <impressions>
#   kpi_health_score <project_json>
#   kpi_compute_all <project_data_json>
#
# set -u only — no set -e in libs

[ -n "${_MARKETING_KPIS_LOADED:-}" ] && return 0
_MARKETING_KPIS_LOADED=1

set -u

# ---------------------------------------------------------------------------
# kpi_roas <spend> <revenue>
# Returns ROAS as float (2dp). Empty string if both zero.
# ---------------------------------------------------------------------------
kpi_roas() {
  local spend="${1:-0}"
  local revenue="${2:-0}"
  local result
  result="$(awk "BEGIN {s=$spend+0; r=$revenue+0; if(s==0 && r==0) exit 1; if(s>0) printf \"%.2f\", r/s; else printf \"%.2f\", 0}")" || { printf ''; return 0; }
  printf '%s' "$result"
}

# ---------------------------------------------------------------------------
# kpi_cac <spend> <new_customers>
# Returns spend/customers (2dp). "—" if new_customers == 0.
# ---------------------------------------------------------------------------
kpi_cac() {
  local spend="${1:-0}"
  local customers="${2:-0}"
  local result
  result="$(awk "BEGIN {s=$spend+0; c=$customers+0; if(c==0) {print \"—\"; exit} printf \"%.2f\", s/c}")"
  printf '%s' "$result"
}

# ---------------------------------------------------------------------------
# kpi_ltv <aov> <repeat_purchase_rate> <gross_margin>
# Standard LTV = AOV × (1/(1-RPR)) × GM
# Returns "—" if any input is 0 or RPR >= 1.
# ---------------------------------------------------------------------------
kpi_ltv() {
  local aov="${1:-0}"
  local rpr="${2:-0}"
  local gm="${3:-0}"
  local result
  result="$(awk "BEGIN {
    a=$aov+0; r=$rpr+0; g=$gm+0;
    if(a==0 || r==0 || g==0 || r>=1) {print \"—\"; exit}
    printf \"%.2f\", a * (1/(1-r)) * g
  }")"
  printf '%s' "$result"
}

# ---------------------------------------------------------------------------
# kpi_payback_months <cac> <mrr>
# Returns cac/mrr (2dp). "—" if mrr == 0.
# ---------------------------------------------------------------------------
kpi_payback_months() {
  local cac="${1:-0}"
  local mrr="${2:-0}"
  local result
  result="$(awk "BEGIN {c=$cac+0; m=$mrr+0; if(m==0) {print \"—\"; exit} printf \"%.2f\", c/m}")"
  printf '%s' "$result"
}

# ---------------------------------------------------------------------------
# kpi_cvr <conversions> <sessions>
# Returns (conv/sessions)*100 (2dp). "—" if sessions == 0.
# ---------------------------------------------------------------------------
kpi_cvr() {
  local conversions="${1:-0}"
  local sessions="${2:-0}"
  local result
  result="$(awk "BEGIN {c=$conversions+0; s=$sessions+0; if(s==0) {print \"—\"; exit} printf \"%.2f\", (c/s)*100}")"
  printf '%s' "$result"
}

# ---------------------------------------------------------------------------
# kpi_ctr <clicks> <impressions>
# Returns (clicks/impressions)*100 (2dp). "—" if impressions == 0.
# ---------------------------------------------------------------------------
kpi_ctr() {
  local clicks="${1:-0}"
  local impressions="${2:-0}"
  local result
  result="$(awk "BEGIN {c=$clicks+0; i=$impressions+0; if(i==0) {print \"—\"; exit} printf \"%.2f\", (c/i)*100}")"
  printf '%s' "$result"
}

# ---------------------------------------------------------------------------
# kpi_health_score <project_json>
# Composite 0-100 score. Returns JSON: {"score":N,"label":"Healthy|Warning|Critical"}
# Scoring:
#   ROAS:   >=3 → +30, 1-3 → +15, else 0
#   CVR:    >=2% → +20, 1-2% → +10, else 0
#   Crash:  >=0.99 → +20, 0.95-0.99 → +10, <0.90 → -20, else 0
#   Profit: revenue > ad_spend → +20
#   Active: ad_spend > 0 → +10
# ---------------------------------------------------------------------------
kpi_health_score() {
  local data="${1:-{}}"

  local roas cvr crash_free ad_spend revenue
  roas="$(echo "$data" | jq -r '.roas // 0' 2>/dev/null | tr -d '\n' || echo 0)"
  cvr="$(echo "$data" | jq -r '.cvr // 0' 2>/dev/null | tr -d '\n' || echo 0)"
  crash_free="$(echo "$data" | jq -r '.crash_free_rate // 1' 2>/dev/null | tr -d '\n' || echo 1)"
  ad_spend="$(echo "$data" | jq -r '.ad_spend // 0' 2>/dev/null | tr -d '\n' || echo 0)"
  revenue="$(echo "$data" | jq -r '.revenue // 0' 2>/dev/null | tr -d '\n' || echo 0)"

  local score label
  score="$(awk "BEGIN {
    roas=$roas+0; cvr=$cvr+0; cf=$crash_free+0;
    spend=$ad_spend+0; rev=$revenue+0;
    s=0;
    # ROAS
    if (roas >= 3) s += 30;
    else if (roas >= 1) s += 15;
    # CVR
    if (cvr >= 2) s += 20;
    else if (cvr >= 1) s += 10;
    # Crash-free
    if (cf >= 0.99) s += 20;
    else if (cf >= 0.95) s += 10;
    else if (cf < 0.90) s -= 20;
    # Profitability
    if (rev > spend) s += 20;
    # Active campaigns
    if (spend > 0) s += 10;
    # Floor at 0
    if (s < 0) s = 0;
    print s
  }")"

  if [ "$score" -ge 70 ] 2>/dev/null; then
    label="Healthy"
  elif [ "$score" -ge 40 ] 2>/dev/null; then
    label="Warning"
  else
    label="Critical"
  fi

  jq -n --argjson score "$score" --arg label "$label" \
    '{"score": $score, "label": $label}'
}

# ---------------------------------------------------------------------------
# kpi_compute_all <project_data_json>
# Master function: enriches input JSON with all computed KPIs.
# ---------------------------------------------------------------------------
kpi_compute_all() {
  local data="${1:-{}}"

  local spend revenue impressions clicks conversions sessions
  local mrr new_customers crash_free aov rpr gm
  spend="$(echo "$data" | jq -r '.spend // 0' 2>/dev/null || echo 0)"
  revenue="$(echo "$data" | jq -r '.revenue // 0' 2>/dev/null || echo 0)"
  impressions="$(echo "$data" | jq -r '.impressions // 0' 2>/dev/null || echo 0)"
  clicks="$(echo "$data" | jq -r '.clicks // 0' 2>/dev/null || echo 0)"
  conversions="$(echo "$data" | jq -r '.conversions // 0' 2>/dev/null || echo 0)"
  sessions="$(echo "$data" | jq -r '.sessions // 0' 2>/dev/null || echo 0)"
  mrr="$(echo "$data" | jq -r '.mrr // 0' 2>/dev/null || echo 0)"
  new_customers="$(echo "$data" | jq -r '.new_customers // 0' 2>/dev/null || echo 0)"
  crash_free="$(echo "$data" | jq -r '.crash_free_rate // 1' 2>/dev/null || echo 1)"
  aov="$(echo "$data" | jq -r '.aov // 0' 2>/dev/null || echo 0)"
  rpr="$(echo "$data" | jq -r '.repeat_purchase_rate // 0' 2>/dev/null || echo 0)"
  gm="$(echo "$data" | jq -r '.gross_margin // 0' 2>/dev/null || echo 0)"

  local roas cac ltv payback cvr ctr
  roas="$(kpi_roas "$spend" "$revenue")"
  cac="$(kpi_cac "$spend" "$new_customers")"
  ltv="$(kpi_ltv "$aov" "$rpr" "$gm")"
  payback="$(kpi_payback_months "$cac" "$mrr")"
  cvr="$(kpi_cvr "$conversions" "$sessions")"
  ctr="$(kpi_ctr "$clicks" "$impressions")"

  # Build enriched data for health score (pass numeric roas/cvr)
  local health_input
  health_input="$(echo "$data" | jq \
    --arg roas "${roas:-0}" \
    --arg cvr "${cvr:-0}" \
    '. + {roas: ($roas | if . == "—" or . == "" then 0 else tonumber end),
           cvr:  ($cvr  | if . == "—" or . == "" then 0 else tonumber end)}' \
    2>/dev/null || echo "$data")"

  local health
  health="$(kpi_health_score "$health_input")"

  local health_score health_label
  health_score="$(echo "$health" | jq -r '.score' 2>/dev/null || echo 0)"
  health_label="$(echo "$health" | jq -r '.label' 2>/dev/null || echo 'Unknown')"

  echo "$data" | jq \
    --arg roas "${roas:-}" \
    --arg cac "${cac:-}" \
    --arg ltv "${ltv:-}" \
    --arg payback "${payback:-}" \
    --arg cvr "${cvr:-}" \
    --arg ctr "${ctr:-}" \
    --argjson health_score "$health_score" \
    --arg health_label "$health_label" \
    '. + {
      roas: $roas,
      cac: $cac,
      ltv: $ltv,
      payback_months: $payback,
      cvr_pct: $cvr,
      ctr_pct: $ctr,
      health_score: $health_score,
      health_label: $health_label
    }' 2>/dev/null
}
