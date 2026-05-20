#!/usr/bin/env bash
# test-ad-spend-aggregator.sh — smoke tests for scripts/lib/ad-spend-aggregator.sh
#
# Hermetic by default: uses a project key known to NOT exist in prefs so no network calls fire.
# Asserts:
#   - lib sources without crashing
#   - every ad_spend_* function returns 0 + echoes `null` for an unknown project
#   - ad_spend_all returns a JSON object with empty surfaces array for an unknown project
#   - double-source guard works
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIB="$PLUGIN_ROOT/scripts/lib/ad-spend-aggregator.sh"

pass=0; fail=0
ok()  { echo "  PASS: $1"; pass=$((pass+1)); }
err() { echo "  FAIL: $1 — $2"; fail=$((fail+1)); }

echo "Testing $LIB"
echo ""

[ -f "$LIB" ] && ok "lib file exists" || { err "lib missing" "$LIB"; exit 1; }

# Use an isolated empty prefs file to guarantee no real config bleeds in.
TMP_PREFS="$(mktemp -t ad-spend-prefs.XXXXXX.json)"
echo '{"marketing":{"projects":{}}}' > "$TMP_PREFS"
trap 'rm -f "$TMP_PREFS"' EXIT

out="$(
  set +u
  export OPS_AUTOPILOT_PREFS="$TMP_PREFS"
  export OPS_DATA_DIR="$(dirname "$TMP_PREFS")"
  # shellcheck disable=SC1090
  . "$LIB"

  for fn in ad_spend_meta ad_spend_google ad_spend_tiktok ad_spend_linkedin ad_spend_reddit ad_spend_microsoft ad_spend_pinterest; do
    r="$($fn nonexistent-project 2>/dev/null)"
    rc=$?
    echo "${fn}_rc=${rc}"
    echo "${fn}_out=${r}"
  done

  r_all="$(ad_spend_all nonexistent-project 2>/dev/null)"
  rc=$?
  echo "all_rc=${rc}"
  echo "all_out=${r_all}"
)"

for fn in ad_spend_meta ad_spend_google ad_spend_tiktok ad_spend_linkedin ad_spend_reddit ad_spend_microsoft ad_spend_pinterest; do
  echo "$out" | grep -q "^${fn}_rc=0$" \
    && ok "${fn} returns rc=0 for unknown project" \
    || err "${fn} rc" "got: $(echo "$out" | grep "^${fn}_rc=")"
  echo "$out" | grep -q "^${fn}_out=null$" \
    && ok "${fn} echoes 'null' for unknown project" \
    || err "${fn} out" "got: $(echo "$out" | grep "^${fn}_out=")"
done

echo "$out" | grep -q "^all_rc=0$" \
  && ok "ad_spend_all returns rc=0" \
  || err "ad_spend_all rc" "got: $(echo "$out" | grep '^all_rc=')"

# ad_spend_all should emit a JSON object with surfaces:[] for unknown project.
all_json="$(echo "$out" | sed -n 's/^all_out=//p')"
if printf '%s' "$all_json" | jq -e '.surfaces | type == "array"' >/dev/null 2>&1; then
  ok "ad_spend_all emits JSON with .surfaces array"
else
  err "ad_spend_all shape" "got: $all_json"
fi

# Double-source guard
dbl="$(
  set +u
  export OPS_AUTOPILOT_PREFS="$TMP_PREFS"
  # shellcheck disable=SC1090
  . "$LIB"
  # shellcheck disable=SC1090
  . "$LIB"
  echo "ok"
)"
echo "$dbl" | grep -q '^ok$' \
  && ok "double-sourcing is idempotent" \
  || err "double-source" "guard failed"

# ── Optional live smoke test ──
if [ "${AD_SPEND_LIVE_SMOKE:-0}" = "1" ] && [ -n "${AD_SPEND_LIVE_PROJECT:-}" ]; then
  echo ""
  echo "  Running live smoke test for project: ${AD_SPEND_LIVE_PROJECT}"
  live="$(
    set +u
    # shellcheck disable=SC1090
    . "$LIB"
    ad_spend_all "$AD_SPEND_LIVE_PROJECT"
  )"
  if printf '%s' "$live" | jq -e '.total_spend_7d | test("^[0-9]+\\.[0-9]{2}$")' >/dev/null 2>&1; then
    ok "live ad_spend_all returns total_spend_7d as numeric string"
  else
    err "live smoke" "got: $live"
  fi
fi

echo ""
echo "---"
echo "Results: $pass passed, $fail failed"
(( fail == 0 )) || { echo "ACTION: fix failing tests above."; exit 1; }
exit 0
