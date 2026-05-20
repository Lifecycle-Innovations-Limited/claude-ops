#!/usr/bin/env bash
# tests/test-marketing-kpis.sh — Hermetic KPI engine tests (no API calls)
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

pass=0
fail=0

ok()  { echo "  PASS: $1"; pass=$((pass+1)); }
err() { echo "  FAIL: $1"; fail=$((fail+1)); }

# Source libraries
. "${REPO_ROOT}/scripts/lib/ga4-resolve.sh"
. "${REPO_ROOT}/scripts/lib/marketing-kpis.sh"

echo "test-marketing-kpis.sh"
echo ""

# ---------------------------------------------------------------------------
# kpi_roas
# ---------------------------------------------------------------------------
echo "kpi_roas:"
r="$(kpi_roas 100 300)"
[ "$r" = "3.00" ] && ok "roas 300/100 = 3.00" || err "roas 300/100: expected 3.00, got $r"

r="$(kpi_roas 0 0)"
[ -z "$r" ] && ok "roas 0/0 = empty" || err "roas 0/0: expected empty, got '$r'"

r="$(kpi_roas 50 0)"
[ "$r" = "0.00" ] && ok "roas 0 revenue = 0.00" || err "roas 0 revenue: expected 0.00, got $r"

# ---------------------------------------------------------------------------
# kpi_cac
# ---------------------------------------------------------------------------
echo "kpi_cac:"
r="$(kpi_cac 300 3)"
[ "$r" = "100.00" ] && ok "cac 300/3 = 100.00" || err "cac 300/3: expected 100.00, got $r"

r="$(kpi_cac 300 0)"
[ "$r" = "—" ] && ok "cac div/0 = —" || err "cac div/0: expected —, got $r"

# ---------------------------------------------------------------------------
# kpi_ltv
# ---------------------------------------------------------------------------
echo "kpi_ltv:"
# AOV=50, RPR=0.3, GM=0.75 → 50 * (1/0.7) * 0.75 = 53.57
r="$(kpi_ltv 50 0.3 0.75)"
expected="53.57"
[ "$r" = "$expected" ] && ok "ltv 50/0.3/0.75 = $expected" || err "ltv: expected $expected, got $r"

r="$(kpi_ltv 0 0.3 0.75)"
[ "$r" = "—" ] && ok "ltv aov=0 = —" || err "ltv aov=0: expected —, got $r"

r="$(kpi_ltv 50 1 0.75)"
[ "$r" = "—" ] && ok "ltv rpr>=1 = —" || err "ltv rpr>=1: expected —, got $r"

r="$(kpi_ltv 50 0.3 0)"
[ "$r" = "—" ] && ok "ltv gm=0 = —" || err "ltv gm=0: expected —, got $r"

# ---------------------------------------------------------------------------
# kpi_payback_months
# ---------------------------------------------------------------------------
echo "kpi_payback_months:"
r="$(kpi_payback_months 100 25)"
[ "$r" = "4.00" ] && ok "payback 100/25 = 4.00" || err "payback 100/25: expected 4.00, got $r"

r="$(kpi_payback_months 100 0)"
[ "$r" = "—" ] && ok "payback div/0 = —" || err "payback div/0: expected —, got $r"

# ---------------------------------------------------------------------------
# kpi_cvr
# ---------------------------------------------------------------------------
echo "kpi_cvr:"
r="$(kpi_cvr 2 420)"
expected="0.48"
[ "$r" = "$expected" ] && ok "cvr 2/420 = $expected" || err "cvr 2/420: expected $expected, got $r"

r="$(kpi_cvr 10 500)"
[ "$r" = "2.00" ] && ok "cvr 10/500 = 2.00" || err "cvr 10/500: expected 2.00, got $r"

r="$(kpi_cvr 5 0)"
[ "$r" = "—" ] && ok "cvr div/0 = —" || err "cvr div/0: expected —, got $r"

# ---------------------------------------------------------------------------
# kpi_ctr
# ---------------------------------------------------------------------------
echo "kpi_ctr:"
r="$(kpi_ctr 110 2353)"
# 110/2353 * 100 = 4.674... → 4.67
expected="4.67"
[ "$r" = "$expected" ] && ok "ctr 110/2353 = $expected" || err "ctr 110/2353: expected $expected, got $r"

r="$(kpi_ctr 0 0)"
[ "$r" = "—" ] && ok "ctr div/0 = —" || err "ctr div/0: expected —, got $r"

# ---------------------------------------------------------------------------
# kpi_health_score
# ---------------------------------------------------------------------------
echo "kpi_health_score:"

# Healthy: ROAS>=3 (+30), CVR>=2% (+20), crash>=0.99 (+20), profitable (+20), active (+10) = 100
h="$(kpi_health_score '{"roas":4.0,"cvr":3.0,"crash_free_rate":0.995,"ad_spend":100,"revenue":500}')"
score="$(echo "$h" | jq -r '.score')"
label="$(echo "$h" | jq -r '.label')"
[ "$score" = "100" ] && ok "health Healthy score=100" || err "health Healthy: expected 100, got $score"
[ "$label" = "Healthy" ] && ok "health Healthy label" || err "health Healthy label: expected Healthy, got $label"

# Warning: ROAS=2 (+15), CVR=1.5 (+10), crash=0.97 (+10), not profitable (0), active (+10) = 45
h="$(kpi_health_score '{"roas":2.0,"cvr":1.5,"crash_free_rate":0.97,"ad_spend":100,"revenue":80}')"
score="$(echo "$h" | jq -r '.score')"
label="$(echo "$h" | jq -r '.label')"
[ "$score" -ge 40 ] && [ "$score" -lt 70 ] && ok "health Warning score in [40,70)" || err "health Warning: score $score not in [40,70)"
[ "$label" = "Warning" ] && ok "health Warning label" || err "health Warning label: expected Warning, got $label"

# Critical: ROAS=0 (0), CVR=0 (0), crash=0.88 (-20), not profitable (0), no spend (0) = 0 (floored)
h="$(kpi_health_score '{"roas":0,"cvr":0,"crash_free_rate":0.88,"ad_spend":0,"revenue":0}')"
score="$(echo "$h" | jq -r '.score')"
label="$(echo "$h" | jq -r '.label')"
[ "$score" -lt 40 ] && ok "health Critical score<40 ($score)" || err "health Critical: score $score not <40"
[ "$label" = "Critical" ] && ok "health Critical label" || err "health Critical label: expected Critical, got $label"

# Crash penalty only: ROAS=0 (0), CVR=0 (0), crash=0.89 (-20) → floored 0
h="$(kpi_health_score '{"roas":0,"cvr":0,"crash_free_rate":0.89,"ad_spend":0,"revenue":0}')"
score="$(echo "$h" | jq -r '.score')"
[ "$score" = "0" ] && ok "health crash penalty floored at 0" || err "health crash floor: expected 0, got $score"

# ---------------------------------------------------------------------------
# kpi_compute_all
# ---------------------------------------------------------------------------
echo "kpi_compute_all:"
sample='{"project":"my-project","spend":92.68,"revenue":150.50,"impressions":2353,"clicks":110,"conversions":2,"sessions":420,"mrr":2500,"new_customers":3,"crash_free_rate":0.99,"aov":50.17,"repeat_purchase_rate":0.30,"gross_margin":0.75}'

out="$(kpi_compute_all "$sample")"

# Check all KPI fields present
for field in roas cac ltv payback_months cvr_pct ctr_pct health_score health_label; do
  if echo "$out" | jq -e "has(\"$field\")" >/dev/null 2>&1; then
    ok "compute_all has field: $field"
  else
    err "compute_all missing field: $field"
  fi
done

# Check ROAS = 150.50 / 92.68 ≈ 1.62
roas_out="$(echo "$out" | jq -r '.roas')"
[ "$roas_out" = "1.62" ] && ok "compute_all roas=1.62" || err "compute_all roas: expected 1.62, got $roas_out"

# Check CAC = 92.68 / 3 ≈ 30.89
cac_out="$(echo "$out" | jq -r '.cac')"
[ "$cac_out" = "30.89" ] && ok "compute_all cac=30.89" || err "compute_all cac: expected 30.89, got $cac_out"

# Check CVR = (2/420)*100 ≈ 0.48
cvr_out="$(echo "$out" | jq -r '.cvr_pct')"
[ "$cvr_out" = "0.48" ] && ok "compute_all cvr=0.48" || err "compute_all cvr: expected 0.48, got $cvr_out"

# Check health_label is a string
hl="$(echo "$out" | jq -r '.health_label')"
[ -n "$hl" ] && [ "$hl" != "null" ] && ok "compute_all health_label present: $hl" || err "compute_all health_label missing"

# Check original fields preserved
proj="$(echo "$out" | jq -r '.project')"
[ "$proj" = "my-project" ] && ok "compute_all preserves original fields" || err "compute_all: project field lost, got $proj"

echo ""
echo "---"
echo "Results: $pass passed, $fail failed"
echo ""

[ "$fail" -gt 0 ] && exit 1
exit 0
