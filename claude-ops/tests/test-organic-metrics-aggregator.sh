#!/usr/bin/env bash
# test-organic-metrics-aggregator.sh — smoke tests for scripts/lib/organic-metrics-aggregator.sh
#
# Hermetic by default: uses a project key known to NOT exist in prefs so no network calls fire.
# Asserts:
#   - lib sources without crashing
#   - every organic_* / merchant_* function returns 0 + echoes `null` for an unknown project
#   - organic_all returns a JSON object with empty surfaces array for an unknown project
#   - stub surface emits configured_but_not_implemented when creds are declared
#   - double-source guard works
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIB="$PLUGIN_ROOT/scripts/lib/organic-metrics-aggregator.sh"

pass=0; fail=0
ok()  { echo "  PASS: $1"; pass=$((pass+1)); }
err() { echo "  FAIL: $1 — $2"; fail=$((fail+1)); }

echo "Testing $LIB"
echo ""

[ -f "$LIB" ] && ok "lib file exists" || { err "lib missing" "$LIB"; exit 1; }

# Use an isolated empty prefs file to guarantee no real config bleeds in.
TMP_PREFS="$(mktemp -t organic-prefs.XXXXXX.json)"
echo '{"marketing":{"projects":{}}}' > "$TMP_PREFS"
trap 'rm -f "$TMP_PREFS"' EXIT

FNS="organic_meta organic_youtube organic_searchconsole merchant_status organic_tiktok"

out="$(
  set +u
  export OPS_AUTOPILOT_PREFS="$TMP_PREFS"
  export OPS_DATA_DIR="$(dirname "$TMP_PREFS")"
  unset META_ACCESS_TOKEN FACEBOOK_ACCESS_TOKEN GOOGLE_ACCESS_TOKEN 2>/dev/null
  # shellcheck disable=SC1090
  . "$LIB"

  for fn in $FNS; do
    r="$($fn nonexistent-project 2>/dev/null)"
    rc=$?
    echo "${fn}_rc=${rc}"
    echo "${fn}_out=${r}"
  done

  r_all="$(organic_all nonexistent-project 2>/dev/null)"
  rc=$?
  echo "all_rc=${rc}"
  echo "all_out=${r_all}"
)"

for fn in $FNS; do
  echo "$out" | grep -q "^${fn}_rc=0$" \
    && ok "${fn} returns rc=0 for unknown project" \
    || err "${fn} rc" "got: $(echo "$out" | grep "^${fn}_rc=")"
  echo "$out" | grep -q "^${fn}_out=null$" \
    && ok "${fn} echoes 'null' for unknown project" \
    || err "${fn} out" "got: $(echo "$out" | grep "^${fn}_out=")"
done

echo "$out" | grep -q "^all_rc=0$" \
  && ok "organic_all returns rc=0" \
  || err "organic_all rc" "got: $(echo "$out" | grep '^all_rc=')"

# organic_all should emit a JSON object with surfaces:[] for unknown project.
all_json="$(echo "$out" | sed -n 's/^all_out=//p')"
if printf '%s' "$all_json" | jq -e '.surfaces | type == "array" and length == 0' >/dev/null 2>&1; then
  ok "organic_all emits JSON with empty .surfaces array"
else
  err "organic_all shape" "got: $all_json"
fi

# Stub sentinel: with tiktok_organic creds declared, organic_tiktok emits
# configured_but_not_implemented (no network needed for the stub).
# Note: _prefs_marketing reads ${OPS_DATA_DIR}/preferences.json, so the fixture
# must live at that exact path inside an isolated temp dir.
TMP_DIR2="$(mktemp -d -t organic-prefs2.XXXXXX)"
echo '{"marketing":{"projects":{"stub-project":{"tiktok_organic":{"access_token":"env:ORGANIC_TEST_UNSET_VAR"}}}}}' > "$TMP_DIR2/preferences.json"
stub_out="$(
  set +u
  export OPS_AUTOPILOT_PREFS="$TMP_DIR2/preferences.json"
  export OPS_DATA_DIR="$TMP_DIR2"
  # shellcheck disable=SC1090
  . "$LIB"
  organic_tiktok stub-project 2>/dev/null
)"
rm -rf "$TMP_DIR2"
if printf '%s' "$stub_out" | jq -e '.status == "configured_but_not_implemented" and .surface == "tiktok_organic"' >/dev/null 2>&1; then
  ok "organic_tiktok emits configured_but_not_implemented sentinel"
else
  err "organic_tiktok stub" "got: $stub_out"
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
  && ok "double-source guard works" \
  || err "double-source guard" "got: $dbl"

echo ""
echo "Results: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
