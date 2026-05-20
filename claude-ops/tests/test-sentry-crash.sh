#!/usr/bin/env bash
# tests/test-sentry-crash.sh — Sentry crash correlation lib tests
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

pass=0
fail=0

ok()  { echo "  PASS: $1"; pass=$((pass+1)); }
err() { echo "  FAIL: $1"; fail=$((fail+1)); }

echo "test-sentry-crash.sh"
echo ""

# Skip if no token available
tok="${SENTRY_AUTH_TOKEN:-}"
if [ -z "$tok" ]; then
  tok="$(doppler secrets get SENTRY_AUTH_TOKEN --project claude-ops --config prd --plain 2>/dev/null || true)"
fi
if [ -z "$tok" ]; then
  echo "  SKIP: SENTRY_AUTH_TOKEN not available — skipping live tests"
  echo ""
  echo "Results: 0 passed, 0 failed (skipped)"
  exit 0
fi

# Source the library
. "${REPO_ROOT}/scripts/lib/ga4-resolve.sh"
. "${REPO_ROOT}/scripts/lib/sentry-crash.sh"

# ── Test 1: nonexistent project returns null ──────────────────────────────
result="$(sentry_crash_rate "xnonexistent-project-zz9999")"
if [ "$result" = "null" ]; then
  ok "nonexistent project returns null"
else
  err "nonexistent project: expected null, got: $result"
fi

# ── Test 2: empty project returns null ───────────────────────────────────
result2="$(sentry_crash_rate "")"
if [ "$result2" = "null" ]; then
  ok "empty project returns null"
else
  err "empty project: expected null, got: $result2"
fi

# ── Test 3: real project returns valid JSON structure ────────────────────
# Use the SENTRY_TEST_PROJECT env var or default to "my-project" (public-safe)
test_project="${SENTRY_TEST_PROJECT:-}"
if [ -n "$test_project" ]; then
  result3="$(sentry_crash_rate "$test_project")"
  if echo "$result3" | jq -e '.crash_free_7d | type == "number"' >/dev/null 2>&1; then
    ok "live project returns JSON with numeric crash_free_7d"
    # Validate all expected fields present
    for field in surface project sentry_projects crash_free_7d crash_free_24h delta_dod at_risk; do
      if echo "$result3" | jq -e "has(\"$field\")" >/dev/null 2>&1; then
        ok "field present: $field"
      else
        err "field missing: $field"
      fi
    done
    # at_risk is boolean
    at_risk_type="$(echo "$result3" | jq -r '.at_risk | type' 2>/dev/null || echo "unknown")"
    if [ "$at_risk_type" = "boolean" ]; then
      ok "at_risk is boolean"
    else
      err "at_risk type: expected boolean, got $at_risk_type"
    fi
  elif [ "$result3" = "null" ]; then
    ok "live project: no matching Sentry projects (null) — acceptable"
  else
    err "live project: unexpected result: $result3"
  fi
else
  echo "  SKIP: SENTRY_TEST_PROJECT not set — skipping live project test"
fi

# ── Test 4: sentry_crash_all_projects returns array ──────────────────────
# Only runs if OPS_DATA_DIR is set with a valid preferences.json
if [ -n "${OPS_DATA_DIR:-}" ] && [ -f "${OPS_DATA_DIR}/preferences.json" ]; then
  result4="$(sentry_crash_all_projects)"
  if echo "$result4" | jq -e 'type == "array"' >/dev/null 2>&1; then
    ok "sentry_crash_all_projects returns array"
  else
    err "sentry_crash_all_projects: expected array, got: $result4"
  fi
else
  echo "  SKIP: OPS_DATA_DIR/preferences.json not available — skipping all_projects test"
fi

echo ""
echo "---"
echo "Results: $pass passed, $fail failed"
echo ""

[ "$fail" -gt 0 ] && exit 1
exit 0
