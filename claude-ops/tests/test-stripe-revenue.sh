#!/usr/bin/env bash
# test-stripe-revenue.sh — smoke tests for scripts/lib/stripe-revenue.sh
#
# Hermetic by default: uses an isolated empty prefs file + a project key that is not configured.
# Asserts:
#   - lib sources without crashing
#   - stripe_revenue_7d returns `null` and rc=0 for an unknown project
#   - stripe_revenue_all_projects returns "[]" when no project has stripe config
#   - double-source guard works
# Live smoke (opt-in): set STRIPE_LIVE_SMOKE=1 and STRIPE_LIVE_PROJECT=<name>
# (with a corresponding STRIPE_<NAME>_SECRET_KEY or STRIPE_<NAME>_API_SECRET_KEY in env/Doppler).
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIB="$PLUGIN_ROOT/scripts/lib/stripe-revenue.sh"

pass=0; fail=0
ok()  { echo "  PASS: $1"; pass=$((pass+1)); }
err() { echo "  FAIL: $1 — $2"; fail=$((fail+1)); }

echo "Testing $LIB"
echo ""

[ -f "$LIB" ] && ok "lib file exists" || { err "lib missing" "$LIB"; exit 1; }

TMP_PREFS="$(mktemp -t stripe-rev-prefs.XXXXXX.json)"
echo '{"marketing":{"projects":{}}}' > "$TMP_PREFS"
trap 'rm -f "$TMP_PREFS"' EXIT

out="$(
  set +u
  export OPS_AUTOPILOT_PREFS="$TMP_PREFS"
  export OPS_DATA_DIR="$(dirname "$TMP_PREFS")"
  # Ensure no Doppler key picks up stray env vars for nonexistent-project.
  unset STRIPE_NONEXISTENT_PROJECT_SECRET_KEY
  unset STRIPE_NONEXISTENT_PROJECT_API_SECRET_KEY
  # shellcheck disable=SC1090
  . "$LIB"

  r="$(stripe_revenue_7d nonexistent-project 2>/dev/null)"
  rc=$?
  echo "rev_rc=${rc}"
  echo "rev_out=${r}"

  r_all="$(stripe_revenue_all_projects 2>/dev/null)"
  rc=$?
  echo "all_rc=${rc}"
  echo "all_out=${r_all}"
)"

echo "$out" | grep -q '^rev_rc=0$' \
  && ok "stripe_revenue_7d returns rc=0 for unknown project" \
  || err "rev rc" "got: $(echo "$out" | grep '^rev_rc=')"

echo "$out" | grep -q '^rev_out=null$' \
  && ok "stripe_revenue_7d echoes 'null' for unknown project" \
  || err "rev out" "got: $(echo "$out" | grep '^rev_out=')"

echo "$out" | grep -q '^all_rc=0$' \
  && ok "stripe_revenue_all_projects returns rc=0" \
  || err "all rc" "got: $(echo "$out" | grep '^all_rc=')"

all_json="$(echo "$out" | sed -n 's/^all_out=//p')"
if printf '%s' "$all_json" | jq -e 'type == "array"' >/dev/null 2>&1; then
  ok "stripe_revenue_all_projects emits a JSON array"
else
  err "all shape" "got: $all_json"
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
# Triggered if STRIPE_LIVE_SMOKE=1 + STRIPE_LIVE_PROJECT set, OR auto-detect a typical user-env var.
LIVE_PROJ="${STRIPE_LIVE_PROJECT:-}"
if [ -z "$LIVE_PROJ" ]; then
  # Try to autodetect from common env var patterns the user may have set.
  for v in $(env | awk -F= '/^STRIPE_[A-Z0-9_]+_(API_)?SECRET_KEY=/{print $1}' 2>/dev/null | head -1); do
    # STRIPE_HEALIFY_API_SECRET_KEY → HEALIFY_API → healify-api
    candidate="${v#STRIPE_}"
    candidate="${candidate%_SECRET_KEY}"
    candidate="${candidate%_API}"
    candidate="$(printf '%s' "$candidate" | tr '[:upper:]_' '[:lower:]-')"
    if [ -n "$candidate" ] && [ "${STRIPE_LIVE_SMOKE:-0}" = "1" ]; then
      LIVE_PROJ="$candidate"
      break
    fi
  done
fi

if [ "${STRIPE_LIVE_SMOKE:-0}" = "1" ] && [ -n "$LIVE_PROJ" ]; then
  echo ""
  echo "  Running live smoke test for project: ${LIVE_PROJ}"
  live="$(
    set +u
    # shellcheck disable=SC1090
    . "$LIB"
    stripe_revenue_7d "$LIVE_PROJ"
  )"
  if printf '%s' "$live" | jq -e '.revenue_7d | test("^[0-9]+\\.[0-9]{2}$")' >/dev/null 2>&1; then
    ok "live stripe_revenue_7d returns revenue_7d as numeric string"
  else
    err "live smoke" "got: $live"
  fi
fi

echo ""
echo "---"
echo "Results: $pass passed, $fail failed"
(( fail == 0 )) || { echo "ACTION: fix failing tests above."; exit 1; }
exit 0
