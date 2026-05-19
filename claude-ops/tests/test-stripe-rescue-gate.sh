#!/usr/bin/env bash
# test-stripe-rescue-gate.sh — assert that an ad with stripe revenue ≥ spend
# is NOT paused by the autopilot's deterministic pause sweep.
#
# Strategy: spawn a sub-shell that sources the autopilot's helper region by
# extracting the should_pause_ad function definition. Drive it with a fake
# STATE_DIR/<proj>-stripe.json and verify decisions for both rescue + non-
# rescue cases. No network, no real autopilot binary execution.
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$PLUGIN_ROOT/bin/ops-marketing-autopilot"

pass=0; fail=0
ok()  { echo "  PASS: $1"; pass=$((pass+1)); }
err() { echo "  FAIL: $1 — $2"; fail=$((fail+1)); }

echo "Testing stripe-rescue gate in $BIN"
echo ""

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
STATE_DIR="$WORK/state"
mkdir -p "$STATE_DIR"

# Seed a stripe revenue file: ad_A earned $50 from Stripe charges
cat > "$STATE_DIR/proj-stripe.json" <<'JSON'
{
  "total_revenue_7d": 90,
  "by_smc": {},
  "by_ad_id": {
    "ad_A": {"revenue": 50, "charges": 5},
    "ad_B": {"revenue":  2, "charges": 1},
    "ad_C": {"revenue":  0, "charges": 0}
  }
}
JSON

# Extract + source just the helper region (stripe_revenue_for_ad + should_pause_ad)
HELPERS="$WORK/helpers.sh"
{
  echo '#!/usr/bin/env bash'
  echo 'set -uo pipefail'
  echo 'STATE_DIR="$1"; shift'
  echo 'log() { :; }'
  echo 'report() { :; }'
  # Pull the two helpers from the binary verbatim
  awk '
    /^stripe_revenue_for_ad\(\)/ {p=1}
    /^should_pause_ad\(\)/        {p=1}
    p {print}
    p && /^}/                     {p=0; print ""}
  ' "$BIN"
  cat <<'PY'
ad="$1"; spend="$2"; floor="${3:-1.0}"
OPS_PAUSE_ROAS_FLOOR="$floor" should_pause_ad proj "$ad" "$spend"
PY
} > "$HELPERS"
chmod +x "$HELPERS"

# Case 1: ad_A — revenue=50, spend=30 → revenue ≥ floor*spend (1.0 * 30 = 30) → KEEP
d1="$(bash "$HELPERS" "$STATE_DIR" ad_A 30 1.0)"
[ "$d1" = "no" ] \
  && ok "ad_A kept: revenue \$50 ≥ \$30 spend × floor 1.0" \
  || err "ad_A rescue" "expected 'no', got '$d1'"

# Case 2: ad_B — revenue=2, spend=30 → revenue < floor*spend → PAUSE
d2="$(bash "$HELPERS" "$STATE_DIR" ad_B 30 1.0)"
[ "$d2" = "yes" ] \
  && ok "ad_B paused: revenue \$2 < \$30" \
  || err "ad_B pause" "expected 'yes', got '$d2'"

# Case 3: ad_C — revenue=0, spend=30 → PAUSE
d3="$(bash "$HELPERS" "$STATE_DIR" ad_C 30 1.0)"
[ "$d3" = "yes" ] \
  && ok "ad_C paused: zero stripe revenue" \
  || err "ad_C pause" "expected 'yes', got '$d3'"

# Case 4: unknown ad → no stripe data → PAUSE (no rescue without data)
d4="$(bash "$HELPERS" "$STATE_DIR" ad_unknown 30 1.0)"
[ "$d4" = "yes" ] \
  && ok "unknown ad paused: no stripe rescue without revenue data" \
  || err "unknown ad" "expected 'yes', got '$d4'"

# Case 5: ad_A with high floor (3.0) → revenue 50 < 3.0×30=90 → PAUSE
d5="$(bash "$HELPERS" "$STATE_DIR" ad_A 30 3.0)"
[ "$d5" = "yes" ] \
  && ok "ad_A paused at floor 3.0: revenue \$50 < \$90 required" \
  || err "ad_A high floor" "expected 'yes', got '$d5'"

# Case 6: zero spend ad → PAUSE (rescue requires positive spend baseline)
d6="$(bash "$HELPERS" "$STATE_DIR" ad_A 0 1.0)"
[ "$d6" = "yes" ] \
  && ok "ad with zero spend → no rescue (no baseline)" \
  || err "zero spend" "expected 'yes', got '$d6'"

# Case 7: missing stripe file → PAUSE
rm -f "$STATE_DIR/proj-stripe.json"
d7="$(bash "$HELPERS" "$STATE_DIR" ad_A 30 1.0)"
[ "$d7" = "yes" ] \
  && ok "no stripe file → no rescue, ad paused" \
  || err "no stripe file" "expected 'yes', got '$d7'"

echo ""
echo "---"
echo "Results: $pass passed, $fail failed"
(( fail == 0 )) || { echo "ACTION: fix failing tests above."; exit 1; }
exit 0
