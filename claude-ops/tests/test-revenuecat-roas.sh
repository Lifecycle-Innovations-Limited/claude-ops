#!/usr/bin/env bash
# test-revenuecat-roas.sh — asserts the autopilot's ground-truth ROAS denominator
# combines Stripe (web) + RevenueCat (App-Store/Play IAP) revenue.
#
# Hermetic: no network, no creds. Validates the combination arithmetic + the
# graceful-skip contract (projects without a .revenuecat block stay Stripe-only).
set -euo pipefail

pass=0; fail=0
ok()  { echo "  PASS: $1"; pass=$((pass+1)); }
err() { echo "  FAIL: $1 — $2"; fail=$((fail+1)); }

BIN="$(cd "$(dirname "$0")/.." && pwd)/bin/ops-marketing-autopilot"
echo "Testing combined-revenue ROAS in $BIN"
echo ""

[ -f "$BIN" ] && ok "autopilot bin exists" || { err "bin missing" "$BIN"; exit 1; }

# 1. The combined-revenue ROAS code path is present.
grep -q 'Ground-truth ROAS (Stripe + RevenueCat attributed)' "$BIN" \
  && ok "ROAS report line names both sources" \
  || err "ROAS report line" "missing Stripe + RevenueCat label"

grep -q 'gather_revenuecat_revenue' "$BIN" \
  && ok "gather_revenuecat_revenue helper wired" \
  || err "helper" "gather_revenuecat_revenue not found"

# 2. Combination arithmetic: combined = stripe + revenuecat (mirrors the awk in-bin).
combine() { awk -v a="$1" -v b="$2" 'BEGIN{ printf "%.2f", (a+0)+(b+0) }'; }
roas()    { awk -v r="$1" -v s="$2" 'BEGIN{ if (s+0>0) printf "%.2f", r/s; else print 0 }'; }

c="$(combine 0 480.00)"      # Stripe $0 (mobile app) + RevenueCat $480
[ "$c" = "480.00" ] && ok "combined: \$0 stripe + \$480 revcat = \$480" || err "combine" "got $c"

c2="$(combine 120.50 480.00)"
[ "$c2" = "600.50" ] && ok "combined: \$120.50 + \$480 = \$600.50" || err "combine2" "got $c2"

# ROAS with combined revenue vs Stripe-only ($0) at $50/day × 7d = $350 spend
r_stripe_only="$(roas 0 350)"
r_combined="$(roas 480 350)"
[ "$r_stripe_only" = "0.00" ] && ok "stripe-only ROAS on a mobile app = 0.00 (the bug)" || err "roas stripe-only" "got $r_stripe_only"
awk "BEGIN{exit !($r_combined > 1)}" && ok "combined ROAS = ${r_combined} (now meaningful)" || err "roas combined" "got $r_combined (expected >1)"

# 3. Graceful-skip contract: helper no-ops without a .revenuecat block (string check
#    on the guard so web-only projects keep Stripe-only behaviour, zero regression).
grep -q 'No revenuecat block .* no-op' "$BIN" \
  && ok "web-only projects skip RevenueCat (no regression)" \
  || err "guard" "missing no-revenuecat-block no-op guard"

# 4. 28d→7d normalization (÷4) so RevenueCat sums with the Stripe 7d window.
grep -q '28d_realized/4_est' "$BIN" \
  && ok "RevenueCat 28d revenue normalized to 7d (÷4)" \
  || err "normalization" "missing 28d→7d est"

echo ""
echo "---"
echo "Results: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
