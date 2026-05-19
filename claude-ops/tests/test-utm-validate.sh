#!/usr/bin/env bash
# test-utm-validate.sh — Golden-table tests for scripts/lib/utm-validate.sh
#
# Runs a matrix of valid and invalid utm tuples and asserts correct exit codes.
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIB="${PLUGIN_ROOT}/scripts/lib/utm-validate.sh"

pass=0; fail=0
ok()  { echo "  PASS: $1"; pass=$((pass+1)); }
err() { echo "  FAIL: $1 — $2"; fail=$((fail+1)); }

echo "Testing $LIB"
echo ""

# Source the library
# shellcheck disable=SC1090
. "$LIB"

# Helper: assert utm_validate returns expected exit code
# $1 expected (0=valid, 1=invalid), $2 description, $3 source, $4 medium, $5 campaign
assert_utm() {
  local expected="$1" desc="$2" src="$3" med="$4" cmp="$5"
  set +e
  utm_validate "$src" "$med" "$cmp" 2>/dev/null
  local rc=$?
  set -e
  if [ "$rc" -eq "$expected" ]; then
    ok "$desc"
  else
    err "$desc" "expected exit $expected got $rc (source='$src' medium='$med' campaign='$cmp')"
  fi
}

echo "--- VALID tuples (expect exit 0) ---"
assert_utm 0 "canonical example"          "meta"    "cpc"        "summer-sale_v1_20260601"
assert_utm 0 "google cpc"                 "google"  "cpc"        "brand-awareness_control_20260115"
assert_utm 0 "email newsletter"           "email"   "newsletter" "weekly-digest_promo_20260520"
assert_utm 0 "organic social"             "organic" "social"     "launch_a_20260301"
assert_utm 0 "underscores in name"        "meta"    "cpc"        "black_friday_control_20261129"
assert_utm 0 "dashes in name"             "google"  "display"    "spring-launch_v2_20260315"
assert_utm 0 "single-char variant"        "meta"    "cpc"        "sale_b_20260401"
assert_utm 0 "numeric in source"          "meta2"   "cpc"        "test_v1_20260101"
assert_utm 0 "digits only date boundary"  "meta"    "cpc"        "x_y_20260101"
assert_utm 0 "hyphen in source"           "meta-ig" "cpc"        "test_v1_20260101"

echo ""
echo "--- INVALID tuples (expect exit 1) ---"

# Missing fields
assert_utm 1 "empty source"               ""        "cpc"        "sale_v1_20260601"
assert_utm 1 "empty medium"               "meta"    ""           "sale_v1_20260601"
assert_utm 1 "empty campaign"             "meta"    "cpc"        ""

# Uppercase violations
assert_utm 1 "uppercase source"           "Meta"    "cpc"        "sale_v1_20260601"
assert_utm 1 "uppercase medium"           "meta"    "CPC"        "sale_v1_20260601"
assert_utm 1 "uppercase in campaign"      "meta"    "cpc"        "Sale_v1_20260601"

# Campaign format violations
assert_utm 1 "campaign with spaces"       "meta"    "cpc"        "summer sale_v1_20260601"
assert_utm 1 "campaign missing variant"   "meta"    "cpc"        "summersale_20260601"
assert_utm 1 "campaign one segment only"  "meta"    "cpc"        "sale"
assert_utm 1 "campaign date too short"    "meta"    "cpc"        "sale_v1_2026"
assert_utm 1 "campaign date 6 digits"     "meta"    "cpc"        "sale_v1_202601"
assert_utm 1 "campaign date 10 digits"    "meta"    "cpc"        "sale_v1_2026010101"
assert_utm 1 "campaign no date segment"   "meta"    "cpc"        "sale_v1"
assert_utm 1 "source starts with dash"    "-meta"   "cpc"        "sale_v1_20260601"
assert_utm 1 "source with space"          "meta ads" "cpc"       "sale_v1_20260601"
assert_utm 1 "medium with slash"          "meta"    "cpc/display" "sale_v1_20260601"

echo ""
echo "--- utm_validate writes diagnostics to stderr ---"
msg="$(utm_validate "" "cpc" "sale_v1_20260601" 2>&1 || true)"
echo "$msg" | grep -q "utm_source" \
  && ok "empty source produces utm_source diagnostic" \
  || err "utm_source diagnostic" "expected 'utm_source' in stderr: '$msg'"

msg="$(utm_validate "meta" "cpc" "badcampaign" 2>&1 || true)"
echo "$msg" | grep -q "utm_campaign" \
  && ok "bad campaign produces utm_campaign diagnostic" \
  || err "utm_campaign diagnostic" "expected 'utm_campaign' in stderr: '$msg'"

echo ""
echo "---"
echo "Results: $pass passed, $fail failed"
(( fail == 0 )) || { echo "ACTION: fix failing tests above."; exit 1; }
exit 0
