#!/usr/bin/env bash
# test-windsor-data-sanity.sh — smoke tests for scripts/windsor-data-sanity.sh
#
# Hermetic: runs entirely against local fixtures, no network.
# Asserts:
#   - all-zero fixture → "warn: windsor all-zero pattern (plan expired?)" + exit 1
#   - healthy fixture (incl. string-typed spend) → "ok" + exit 0
#   - stdin mode works
#   - custom jq paths work
#   - invalid JSON → exit 2
set -uo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$PLUGIN_ROOT/scripts/windsor-data-sanity.sh"
FIXTURES="$PLUGIN_ROOT/tests/fixtures"

pass=0; fail=0
ok()  { echo "  PASS: $1"; pass=$((pass+1)); }
err() { echo "  FAIL: $1 — $2"; fail=$((fail+1)); }

echo "Testing $SCRIPT"
echo ""

if [ -x "$SCRIPT" ]; then
  ok "script exists and is executable"
else
  err "script missing or not executable" "$SCRIPT"
fi

# 1) all-zero fixture → warn + exit 1
out="$(bash "$SCRIPT" "$FIXTURES/windsor-all-zero.json")"; rc=$?
if [ "$rc" -eq 1 ] && [ "$out" = "warn: windsor all-zero pattern (plan expired?)" ]; then
  ok "all-zero fixture warns with exit 1"
else
  err "all-zero fixture" "rc=$rc out=$out"
fi

# 2) healthy fixture → ok + exit 0
out="$(bash "$SCRIPT" "$FIXTURES/windsor-healthy.json")"; rc=$?
if [ "$rc" -eq 0 ] && [ "$out" = "ok" ]; then
  ok "healthy fixture passes with exit 0"
else
  err "healthy fixture" "rc=$rc out=$out"
fi

# 3) stdin mode
out="$(bash "$SCRIPT" < "$FIXTURES/windsor-healthy.json")"; rc=$?
if [ "$rc" -eq 0 ] && [ "$out" = "ok" ]; then
  ok "stdin mode works"
else
  err "stdin mode" "rc=$rc out=$out"
fi

# 4) custom jq paths
out="$(bash "$SCRIPT" "$FIXTURES/windsor-all-zero.json" '.data[].spend,.data[].impressions')"; rc=$?
if [ "$rc" -eq 1 ]; then
  ok "custom jq paths detect all-zero"
else
  err "custom jq paths" "rc=$rc out=$out"
fi

out="$(bash "$SCRIPT" "$FIXTURES/windsor-healthy.json" '.data[].spend')"; rc=$?
if [ "$rc" -eq 0 ] && [ "$out" = "ok" ]; then
  ok "custom jq paths pass on healthy data"
else
  err "custom jq paths healthy" "rc=$rc out=$out"
fi

# 5) invalid JSON → exit 2
out="$(printf 'not json' | bash "$SCRIPT" 2>/dev/null)"; rc=$?
if [ "$rc" -eq 2 ]; then
  ok "invalid JSON exits 2"
else
  err "invalid JSON" "rc=$rc out=$out"
fi

echo ""
echo "windsor-data-sanity: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
