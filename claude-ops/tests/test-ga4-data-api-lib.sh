#!/usr/bin/env bash
# test-ga4-data-api-lib.sh — smoke tests for scripts/lib/ga4-data-api.sh
#
# Hermetic: OPS_DRY_RUN=1 throughout — zero network calls.
# Asserts:
#  - the lib sources without error
#  - ga4_auth_token returns empty without creds (no crash)
#  - ga4_run_report respects OPS_DRY_RUN (no curl)
#  - ga4_run_report returns "{}" on empty property
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIB="$PLUGIN_ROOT/scripts/lib/ga4-data-api.sh"

pass=0; fail=0
ok()  { echo "  PASS: $1"; pass=$((pass+1)); }
err() { echo "  FAIL: $1 — $2"; fail=$((fail+1)); }

echo "Testing $LIB"
echo ""

[ -f "$LIB" ] && ok "lib file exists" || { err "lib missing" "$LIB"; exit 1; }

# Source in a subshell so guard variable doesn't leak
out="$(
  set +u
  unset GA4_SERVICE_ACCOUNT_KEY_FILE
  export OPS_DRY_RUN=1
  # shellcheck disable=SC1090
  . "$LIB"
  # 1) no property → "{}"
  r1="$(ga4_run_report '' '{}')"
  echo "r1=${r1}"
  # 2) dry-run with property → "{}"
  r2="$(ga4_run_report '123456789' '{"dateRanges":[{"startDate":"7daysAgo","endDate":"today"}]}')"
  echo "r2=${r2}"
  # 3) ga4_auth_token with no creds → empty
  HOME=/tmp/no-such-home r3="$(HOME=/tmp/no-such-home GA4_SERVICE_ACCOUNT_KEY_FILE='' ga4_auth_token 2>/dev/null)"
  echo "r3=[${r3}]"
)"

echo "$out" | grep -q '^r1={}$' \
  && ok "empty property_id returns '{}'" || err "empty property_id" "got: $(echo "$out" | grep '^r1=')"

echo "$out" | grep -q '^r2={}$' \
  && ok "OPS_DRY_RUN=1 returns '{}' (no network)" || err "OPS_DRY_RUN=1" "got: $(echo "$out" | grep '^r2=')"

# r3 may be empty or fail; we only check no crash (output present)
echo "$out" | grep -q '^r3=\[' \
  && ok "ga4_auth_token does not crash without creds" || err "ga4_auth_token crash" "missing r3"

# 4) Double-source guard
out2="$(
  set +u
  export OPS_DRY_RUN=1
  # shellcheck disable=SC1090
  . "$LIB"
  # shellcheck disable=SC1090
  . "$LIB"
  echo "double-sourced ok"
)"
echo "$out2" | grep -q 'double-sourced ok' \
  && ok "double-sourcing is idempotent" || err "double-source" "guard failed"

echo ""
echo "---"
echo "Results: $pass passed, $fail failed"
(( fail == 0 )) || { echo "ACTION: fix failing tests above."; exit 1; }
exit 0
